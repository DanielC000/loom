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
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-dead-owner-recovery.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mdo-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GIT_ID = "-c user.email=mdo@loom -c user.name=mdo";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();

const db = new Db();
// confirmWorkerMerge only touches pty.stop / pty.isAlive / pty.enqueueStdin; a no-pty worker row
// (processState 'exited') is !isAlive anyway, so a stub keeps this hermetic (mirrors merge-confirm-idempotent.mjs).
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl());

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const projId = `mdo-proj-${sfx}`, agentId = `mdo-agent-${sfx}`, taskId = `mdo-task-${sfx}`;
const deadMgrId = `mdo-deadmgr-${sfx}`, liveMgrId = `mdo-livemgr-${sfx}`, workerId = `mdo-wkr-${sfx}`;
const repo = path.join(os.tmpdir(), `loom-mdo-repo-${sfx}`);

try {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mdo\n");
  execSync(`git init -q && git config user.email mdo@loom && git config user.name mdo && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });

  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, "feat.txt"), "work\n");
  execSync(`git add . && git ${GIT_ID} commit -q -m feat`, { cwd: worktreePath });

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
  await sleep(30); // let the attach() call above actually degrade to "pending" (its own 10ms wait budget)

  // ── (1) precondition: worker_list's pendingMerge view shows the zombie with the DEAD manager's id ───
  const pre = sessions.peekPendingMerge(workerId);
  check("(precondition) pendingMerge shows the zombie op as still 'running'", pre?.state === "running");
  check("(precondition) pendingMerge's managerSessionId is the DEAD predecessor manager", pre?.managerSessionId === deadMgrId);

  // DURABLE-MARKER LEAK GUARD (CR follow-up, card edc1ec12): mirror what a REAL confirmWorkerMergeTracked
  // call's onSurfacedPending would have written for this zombie BEFORE its owning manager died — a
  // pending_gate_ops row keyed by this op's opId. If the dead-owner eviction below doesn't ALSO clear this
  // row, it would leak until the next boot and fire a FALSE [loom:merge-failed] at the (now-live) manager.
  db.recordPendingGateOp({ opId: pre.opId, kind: "merge", key, ownerSessionId: deadMgrId, taskId, branch: null, startedAt: now });
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
  check("(recovery) the ZOMBIE's durable row was cleared on eviction — no leaked marker for a later boot to misfire on", !db.listPendingGateOps().some((r) => r.opId === pre.opId));

  // ── (3) reconcileDeadOwnerMergeOps() (the boot-reconcile sweep) clears a dead-owner op directly ─────
  const key2 = `merge:${workerId}-b`;
  void sessions.pendingOps.attach(key2, "merge", deadMgrId, 10, () => new Promise(() => {}));
  await sleep(30);
  const zombie2 = sessions.pendingOps.peek(key2);
  check("(boot-sweep precondition) a second zombie op is tracked as running", zombie2?.state === "running");
  db.recordPendingGateOp({ opId: zombie2.opId, kind: "merge", key: key2, ownerSessionId: deadMgrId, taskId, branch: null, startedAt: now });
  check("(boot-sweep precondition) its durable pending_gate_ops row exists too", db.listPendingGateOps().some((r) => r.opId === zombie2.opId));
  const cleared = sessions.reconcileDeadOwnerMergeOps();
  check("(boot-sweep) reports exactly the one dead-owner op it cleared", cleared === 1);
  check("(boot-sweep) the zombie is gone from the registry", sessions.pendingOps.peek(key2) === undefined);
  check("(boot-sweep) its durable row was ALSO cleared — no leak until the next boot", !db.listPendingGateOps().some((r) => r.opId === zombie2.opId));

  // ── (4) SURGICAL: a running op owned by a LIVE manager is untouched by either recovery path ────────
  const key3 = `merge:${workerId}-c`;
  void sessions.pendingOps.attach(key3, "merge", liveMgrId, 10, () => new Promise(() => {}));
  await sleep(30);
  check("(healthy-path precondition) a live-owner op is tracked as running", sessions.pendingOps.peek(key3)?.state === "running");
  const clearedHealthy = sessions.reconcileDeadOwnerMergeOps();
  check("(healthy path) the boot-sweep clears NOTHING for a live-owner op", clearedHealthy === 0);
  check("(healthy path) the live-owner op is STILL tracked as running (untouched)", sessions.pendingOps.peek(key3)?.state === "running");
} finally {
  db.close();
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a merge op orphaned by a dead owning manager (the daemon-restart-mid-merge shape) is evicted rather than dedup-attached-to forever: confirmWorkerMergeTracked recovers it inline on the next confirm, reconcileDeadOwnerMergeOps() (the boot-reconcile sweep) clears it directly, a live-owner op is left completely untouched by both paths, and (card edc1ec12 CR follow-up) an evicted dead-owner op's durable pending_gate_ops row is cleared right along with its registry entry — never left to leak until the next boot and fire a false [loom:merge-failed] at the now-live manager."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
