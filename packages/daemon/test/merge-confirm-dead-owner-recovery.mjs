import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// DEAD-OWNER MERGE-OP RECOVERY test (board card 27ea069e, provenance: platform escalation 64799e1a).
//
// THE BUG: a worker_merge_confirm was in-flight (PendingOpRegistry entry keyed `merge:${workerSessionId}`,
// state:"running") when the daemon restarted. The owning manager session from BEFORE the restart is gone
// (exited), but nothing ever reconciled/expired that op — a fresh worker_merge_confirm call kept
// dedup-attaching to the SAME zombie op forever ({status:"pending"} on every retry, no gate actually
// running, branch never merged). The only workaround was worker_recycle (a fresh sessionId → a fresh
// registry key), which is heavyweight and non-obvious.
//
// THE FIX: (1) confirmWorkerMergeTracked defensively detects an EXISTING running op whose owning manager
// session is dead (exited/archived/missing) and evicts it BEFORE attach(), so the call starts a
// genuinely fresh confirm instead of dedup-attaching to something that can never settle for a live
// caller. (2) reconcileDeadOwnerMergeOps() is a boot-callable sweep that does the same across every
// outstanding merge op, for any orphaned-owner shape a per-call check alone wouldn't catch.
//
// HERMETIC: a stub pty (mirrors merge-confirm-idempotent.mjs) + REAL git on a temp repo, NO live daemon —
// drives SessionService directly, seeding a "zombie" PendingOpRegistry entry the same shape a
// daemon-restart-mid-merge leaves behind (a never-settling run() owned by a now-dead manager session).
//
// Proves:
//   (1) precondition: worker_list's pendingMerge view shows the zombie op with the DEAD manager's id
//       (mirrors the reported symptom exactly).
//   (2) confirmWorkerMergeTracked, called by a LIVE manager, evicts the dead-owner zombie and completes a
//       REAL merge on the SAME call (not stuck "pending" forever) — the branch's commit lands on main.
//   (3) reconcileDeadOwnerMergeOps() (the boot-reconcile sweep) clears a dead-owner op directly.
//   (4) SURGICAL: a RUNNING op owned by a LIVE manager is left completely untouched by both paths — the
//       healthy case is byte-identical to before this card.
//   (5) card 257d534d's fix: a RUNNING op whose owning manager has genuinely EXITED but has a LIVE
//       SUCCESSOR (a recycle mid-op — recycleManager hard-stops the predecessor's pty and never rewrites
//       the op's managerSessionId) is NOT evicted by either recovery path, matching (4)'s live-owner
//       result rather than (2)/(3)'s genuinely-dead-owner result — the two polarities together (a
//       recycled-but-alive lineage survives, a truly ownerless one is still evicted) prove the fix
//       adopted LINEAGE semantics rather than merely disabling eviction.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-dead-owner-recovery.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { waitUntil } from "./_wait.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mdo-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mdo@loom -c user.name=mdo";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();

const db = new Db();
// confirmWorkerMerge only touches pty.stop / pty.isAlive / pty.enqueueStdin; a no-pty worker row
// (processState 'exited') is !isAlive anyway, so a stub keeps this hermetic (mirrors merge-confirm-idempotent.mjs).
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
// GENEROUS syncAttachBudgetMs (card e082bf4d): every merge here is a REAL git worktree merge racing the
// production SYNC_ATTACH_BUDGET_MS (12s) wall-clock — under host contention that real op can legitimately
// exceed 12s even though nothing is wrong (measured: the same defect fired under an ORDINARY merge gate,
// no artificial load). This file has no scenario that depends on exceeding the budget — every "(recovery)"
// assertion below wants the SYNCHRONOUS-settle shape, not a host-speed race — so widen it here, test-only;
// production's own SYNC_ATTACH_BUDGET_MS is untouched (this constant is not the banned "raise the budget").
const GENEROUS_SYNC_BUDGET_MS = 60_000;
const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: GENEROUS_SYNC_BUDGET_MS });

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const projId = `mdo-proj-${sfx}`, agentId = `mdo-agent-${sfx}`, taskId = `mdo-task-${sfx}`;
const deadMgrId = `mdo-deadmgr-${sfx}`, liveMgrId = `mdo-livemgr-${sfx}`, workerId = `mdo-wkr-${sfx}`;
const repo = path.join(os.tmpdir(), `loom-mdo-repo-${sfx}`);

try {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mdo\n");
  execSync(`git init -q && git config user.email mdo@loom && git config user.name mdo`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);

  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, "feat.txt"), "work\n");
  commitAll(worktreePath, "feat", GIT_ID);

  db.insertProject({ id: projId, name: "MDO", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MDO-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  // The DEAD predecessor manager — exited, exactly as it would be after a daemon restart it didn't
  // survive (or was otherwise stopped/archived while its merge confirm was still in flight).
  db.insertSession({ id: deadMgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  // The LIVE manager that now owns the worker (re-parented, or simply the one re-driving the merge).
  db.insertSession({ id: liveMgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: liveMgrId, taskId, worktreePath, branch });

  // ── seed the ZOMBIE: a "running" merge op owned by the DEAD manager, whose run() never settles ──────
  // (the exact shape a daemon-restart-mid-merge leaves behind: an entry the process no longer has any
  // live continuation for, but the map still shows "running" until something reconciles it away).
  const key = `merge:${workerId}`;
  void sessions.pendingOps.attach(key, "merge", deadMgrId, 10, () => new Promise(() => {}));
  // POLLED, not a fixed wait (card 5f42aab2): wait for the zombie to actually be OBSERVABLE via peek()
  // instead of sleeping a guessed duration and assuming attach()'s own internal 10ms degrade-to-"pending"
  // race has completed by then. attach() registers the entry synchronously (before its own first await),
  // so this resolves on its very first poll — but it asserts the real condition rather than a timing guess,
  // so it can never under-wait no matter how starved the host's event loop gets.
  await waitUntil(
    () => { const v = sessions.pendingOps.peek(key); return v?.state === "running" && v?.managerSessionId === deadMgrId; },
    { label: "zombie merge op observable as running under the dead manager" },
  );

  // ── (1) precondition: worker_list's pendingMerge view shows the zombie with the DEAD manager's id ───
  const pre = sessions.peekPendingMerge(workerId);
  check("(precondition) pendingMerge shows the zombie op as still 'running'", pre?.state === "running");
  check("(precondition) pendingMerge's managerSessionId is the DEAD predecessor manager", pre?.managerSessionId === deadMgrId);

  // DURABLE-MARKER LEAK GUARD (CR follow-up, card edc1ec12, restated by e3e40167): mirror what a REAL
  // confirmWorkerMergeTracked call's onOpMinted+onSurfacedPending would have written for this zombie
  // BEFORE its owning manager died — a pending_gate_ops row keyed by this op's opId, surfaced pending. If
  // the dead-owner eviction below doesn't ALSO mark this row terminal, it would leak until the next boot
  // and fire a FALSE [loom:merge-failed] at the (now-live) manager.
  db.insertPendingGateOp({ opId: pre.opId, kind: "merge", key, ownerSessionId: deadMgrId, projectId: projId, taskId, branch: null, startedAt: now, state: "pending", surfacedPending: true });
  check("(precondition) the durable pending_gate_ops row for the zombie exists", db.listPendingGateOps().some((r) => r.opId === pre.opId));

  // ── (2) a LIVE manager's confirm evicts the dead-owner zombie and completes a REAL merge ────────────
  const headBefore = git(repo, "rev-parse HEAD");
  const result = await sessions.confirmWorkerMergeTracked(liveMgrId, workerId);
  check("(recovery) the confirm settles — NOT stuck 'pending' forever on the zombie", result.settled === true);
  check("(recovery) the confirm actually merged", result.ok === true && result.value.merged === true);
  check("(recovery) the branch's file actually landed on main", fs.existsSync(path.join(repo, "feat.txt")));
  check("(recovery) exactly ONE new commit landed (a real squash-merge ran, not a phantom result)", git(repo, `rev-list --count ${headBefore}..HEAD`) === "1");
  check("(recovery) task moved to done", db.getTask(taskId).columnKey === "done");
  // confirmWorkerMergeTracked RETAINS a settled merge op briefly (card d1aee5f1 follow-up — the Board's
  // merge-gate fill needs a real window to render before pendingMerge reverts to null), so this no longer
  // evicts to `undefined` INSTANTLY — it settles to a terminal RETAINED view instead. The invariant that
  // matters (not stuck "running" forever on the zombie) still holds; assert the terminal shape directly.
  const afterRecovery = sessions.peekPendingMerge(workerId);
  check("(recovery) pendingMerge is a RETAINED terminal 'merged' view post-settle — not stuck 'running'", afterRecovery?.state === "done" && afterRecovery?.outcome === "merged");
  // Card e3e40167: pending_gate_ops is now a PERMANENT tombstone — eviction marks the row terminal
  // ('evicted-dead-owner') rather than deleting it, so a later boot's reconcileOrphanedGateOps (which
  // selects only surfaced_pending+state='pending' rows) correctly skips it — no false [loom:merge-failed],
  // without needing the row to vanish.
  const zombieRowAfter = db.listPendingGateOps().find((r) => r.opId === pre.opId);
  check("(recovery) the ZOMBIE's durable row still exists but is marked 'evicted-dead-owner' — never deleted, never left leakable as 'pending'", zombieRowAfter !== undefined && zombieRowAfter.state === "evicted-dead-owner");

  // ── (3) reconcileDeadOwnerMergeOps() (the boot-reconcile sweep) clears a dead-owner op directly ─────
  const key2 = `merge:${workerId}-b`;
  void sessions.pendingOps.attach(key2, "merge", deadMgrId, 10, () => new Promise(() => {}));
  await waitUntil(() => sessions.pendingOps.peek(key2)?.state === "running", { label: "second zombie op observable as running" });
  const zombie2 = sessions.pendingOps.peek(key2);
  check("(boot-sweep precondition) a second zombie op is tracked as running", zombie2?.state === "running");
  db.insertPendingGateOp({ opId: zombie2.opId, kind: "merge", key: key2, ownerSessionId: deadMgrId, projectId: projId, taskId, branch: null, startedAt: now, state: "pending", surfacedPending: true });
  check("(boot-sweep precondition) its durable pending_gate_ops row exists too", db.listPendingGateOps().some((r) => r.opId === zombie2.opId));
  const cleared = sessions.reconcileDeadOwnerMergeOps();
  check("(boot-sweep) reports exactly the one dead-owner op it cleared", cleared === 1);
  check("(boot-sweep) the zombie is gone from the registry", sessions.pendingOps.peek(key2) === undefined);
  const zombie2RowAfter = db.listPendingGateOps().find((r) => r.opId === zombie2.opId);
  check("(boot-sweep) its durable row still exists but is marked 'evicted-dead-owner' — never deleted", zombie2RowAfter !== undefined && zombie2RowAfter.state === "evicted-dead-owner");

  // ── (4) SURGICAL: a running op owned by a LIVE manager is untouched by either recovery path ────────
  const key3 = `merge:${workerId}-c`;
  void sessions.pendingOps.attach(key3, "merge", liveMgrId, 10, () => new Promise(() => {}));
  await waitUntil(() => sessions.pendingOps.peek(key3)?.state === "running", { label: "live-owner op observable as running" });
  check("(healthy-path precondition) a live-owner op is tracked as running", sessions.pendingOps.peek(key3)?.state === "running");
  const clearedHealthy = sessions.reconcileDeadOwnerMergeOps();
  check("(healthy path) the boot-sweep clears NOTHING for a live-owner op", clearedHealthy === 0);
  check("(healthy path) the live-owner op is STILL tracked as running (untouched)", sessions.pendingOps.peek(key3)?.state === "running");

  // ── (5) THE FIX (card 257d534d, Code Reviewer 213fe600 finding F1 on card d5e67146) — a manager that
  // has GENUINELY EXITED but has a LIVE SUCCESSOR recycled from it (recycleManager hard-stops the
  // predecessor's pty and never rewrites a pending op's managerSessionId — carryPendingToSuccessor moves
  // queued/durable messages only) must NOT be treated as a dead owner by EITHER recovery path: every
  // settle nudge for this same op already routes through resolveSettleNudgeTarget/liveLineageSuccessor to
  // the live successor, so evicting here would strand work whose lineage is, in fact, still listening.
  // A dedicated SMALL-BUDGET SessionService (its OWN fresh, empty PendingOpRegistry — syncAttachBudgetMs
  // is instance-level) lets the confirmWorkerMergeTracked assertion below degrade to `settled:false` in
  // ~100ms instead of this file's GENEROUS_SYNC_BUDGET_MS (60s) while dedupe-attached to a zombie run()
  // that never resolves.
  // Code review (card 257d534d): each call site under test below gets its OWN key/worker (key4/workerId2
  // for the boot-sweep, key5/workerId2b for the per-call check) rather than sharing one zombie — sharing
  // meant the boot-sweep's own assertion (run first) already evicted-or-not the SAME entry the per-call
  // check then observed, so a PARTIAL revert (only one of the two call sites fixed) could still pass both
  // blocks: whichever call ran second was silently no-op'd by the first one's outcome rather than by its
  // OWN predicate. Separate keys make each block independently falsifiable under a single full revert.
  const recycledPredecessorId = `mdo-recycled-pred-${sfx}`, recycledSuccessorId = `mdo-recycled-succ-${sfx}`, workerId2 = `mdo-wkr2-${sfx}`, workerId2b = `mdo-wkr2b-${sfx}`;
  db.insertSession({ id: recycledPredecessorId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: recycledSuccessorId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", recycledFrom: recycledPredecessorId });
  db.insertSession({ id: workerId2, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: recycledSuccessorId });
  db.insertSession({ id: workerId2b, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: recycledSuccessorId });

  const sessionsFast = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 100 });
  const key4 = `merge:${workerId2}`;
  void sessionsFast.pendingOps.attach(key4, "merge", recycledPredecessorId, 10, () => new Promise(() => {}));
  await waitUntil(() => sessionsFast.pendingOps.peek(key4)?.state === "running", { label: "recycled-owner op (boot-sweep key) observable as running" });
  const recycledZombie = sessionsFast.pendingOps.peek(key4);
  check("(recycled-owner precondition) op is tracked running, owned by the now-EXITED predecessor", recycledZombie?.state === "running" && recycledZombie?.managerSessionId === recycledPredecessorId);

  const clearedRecycled = sessionsFast.reconcileDeadOwnerMergeOps();
  check("(recycled-owner) THE FIX — the boot-sweep does NOT evict an op whose owner recycled but has a LIVE successor", clearedRecycled === 0);
  check("(recycled-owner) the op is STILL tracked as running post-sweep — untouched, same as a genuinely live owner (4)", sessionsFast.pendingOps.peek(key4)?.state === "running");

  // Same fix, the OTHER call site — its OWN key/worker (workerId2b/key5), so this block's own predicate is
  // what's under test, not whatever the boot-sweep block above already decided for a shared entry.
  // confirmWorkerMergeTracked's per-call defensive check must agree: it dedupe-attaches to the still-
  // running zombie (never evicts+re-mints it), so this degrades to settled:false once its small
  // syncAttachBudgetMs elapses, and logs NO "had a dead owner" eviction.
  const key5 = `merge:${workerId2b}`;
  void sessionsFast.pendingOps.attach(key5, "merge", recycledPredecessorId, 10, () => new Promise(() => {}));
  await waitUntil(() => sessionsFast.pendingOps.peek(key5)?.state === "running", { label: "recycled-owner op (per-call-check key) observable as running" });
  const recycledZombie2 = sessionsFast.pendingOps.peek(key5);
  check("(recycled-owner, per-call key) precondition: op is tracked running, owned by the now-EXITED predecessor", recycledZombie2?.state === "running" && recycledZombie2?.managerSessionId === recycledPredecessorId);

  let deadOwnerWarnings = 0;
  const origWarn2 = console.warn;
  console.warn = (...args) => { if (String(args[0]).includes("had a dead owner")) deadOwnerWarnings++; origWarn2(...args); };
  const fastResult = await sessionsFast.confirmWorkerMergeTracked(recycledPredecessorId, workerId2b);
  console.warn = origWarn2;
  check("(recycled-owner) confirmWorkerMergeTracked's OWN per-call check agrees — degrades to settled:false, dedupe-attached to the still-running zombie", fastResult.settled === false);
  check("(recycled-owner) it never logged a 'had a dead owner' eviction — the lineage check found the live successor", deadOwnerWarnings === 0);
  check("(recycled-owner) the op is STILL the SAME opId after this call — dedupe-attach happened, never evict-and-remint", sessionsFast.pendingOps.peek(key5)?.opId === recycledZombie2.opId);
} finally {
  db.close();
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a merge op orphaned by a dead owning manager (the daemon-restart-mid-merge shape) is evicted rather than dedup-attached-to forever: confirmWorkerMergeTracked recovers it inline on the next confirm, reconcileDeadOwnerMergeOps() (the boot-reconcile sweep) clears it directly, a live-owner op is left completely untouched by both paths, (card edc1ec12 CR follow-up, restated by e3e40167) an evicted dead-owner op's durable pending_gate_ops row is marked 'evicted-dead-owner' right along with its registry eviction — NEVER deleted (the table is a permanent tombstone), but correctly excluded from reconcileOrphanedGateOps' boot sweep, so it never leaks a false [loom:merge-failed] at the now-live manager — and (card 257d534d) a manager that RECYCLED mid-op, leaving a LIVE successor behind, is never mistaken for a dead owner by either recovery path, matching a genuinely live owner's untouched result rather than a genuinely dead owner's eviction."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
