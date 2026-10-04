import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Regression test for card 164f7915 — a queued worker self-check must never be superseded by a
// `worker_merge_confirm` call that is itself ultimately REFUSED for ownership.
//
// THE BUG (found by worker db5baa70, card e256166a, fixed here): after card 656e326f hoisted a LINEAGE
// ownership pre-check into `confirmWorkerMergeTracked` (compares by lineage ROOT, before any side effect),
// `confirmWorkerMerge`'s own, STRICTER exact-id ownership check (`worker.parentSessionId !==
// managerSessionId`) still lived deep inside its body, reached only once `pendingOps.attach()` actually
// re-invokes it — well AFTER `supersedeQueuedSelfCheck` already fired as a side effect.
//
// `reparentLiveWorkers` (db.ts) only repairs a worker row whose `process_state = 'live'` at recycle time.
// A NON-live worker keeps a stale `parent_session_id` pointing at its now-recycled-away (dead) predecessor
// manager. The predecessor and its successor share a lineage ROOT, so: the successor's confirm passed the
// lineage pre-check, fired `supersedeQueuedSelfCheck` (cancelling the worker's queued `run_gate`
// self-check), and was THEN refused by the deeper exact-id check — a self-check cancelled by a confirm
// that never ran.
//
// THE FIX, ROUND 2 (docs/decisions/164f7915-*.md — round 1's own early pre-check regressed decision
// 656e326f and was removed; see that record's "Round 2" section): the `supersedeQueuedSelfCheck` call
// itself is now gated on the SAME shared `isExactWorkerOwner` predicate `confirmWorkerMerge`'s own deep
// guard calls — so a lineage-matching-but-stale-exact-id caller never fires that side effect. The confirm
// call itself still reaches `pendingOps.attach()` (the lineage pre-check alone gates that path, per
// 656e326f) and genuinely MINTS a fresh op (nothing attachable here), which `confirmWorkerMerge`'s own
// deep exact-id guard then refuses — same error, never cached (`NEVER_CACHED_OUTCOMES` excludes
// "not-your-worker"), but WITH a real mint this time (unlike round 1's early short-circuit).
//
// Three scenarios:
//  (1) THE FIXTURE ITSELF — a recycled manager + a non-live worker + a queued self-check. Pre-fix this
//      cancels the self-check via a confirm that's then refused; post-fix the confirm is refused cleanly
//      with NO side effect, and the self-check runs for real once admitted. PROVEN RED ON MAIN (see this
//      file's own revert-and-rerun note in the worker_report that shipped this card).
//  (2) NOT CACHED: after scenario (1)'s refusal, relink the worker to its real caller (mirrors
//      `selfHealWorkerLink`'s own repair) and re-confirm at the SAME branch tip — it must proceed for
//      real, never replay a cached "not your worker" (mirrors merge-confirm-ownership-refusal-not-cached.mjs).
//  (3) THE LEGITIMATE PATH IS UNCHANGED: a worker whose parent already exactly matches the caller still has
//      its queued self-check superseded exactly as before (card 8d585277's own behavior, untouched).
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-stale-exact-parent-not-cancelled.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mcsep-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mcsep@loom -c user.name=mcsep";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
const GENEROUS_SYNC_BUDGET_MS = 600_000; // DI seam only — never the production constant (mirrors gate-cancel.mjs)

async function waitUntil(predicate, { intervalMs = 15, timeoutMs = 16000 } = {}) {
  try {
    return await sharedWaitUntil(predicate, { timeoutMs, intervalMs, label: "mcsep: condition" });
  } catch {
    return predicate(); // one last try, then give up honestly (mirrors gate-cancel.mjs)
  }
}

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mcsep\n");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "baseline.ts"), "export const BASELINE = true;\n");
  execSync(`git init -q && git config user.email mcsep@loom && git config user.name mcsep`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const reposDir = path.join(os.tmpdir(), `loom-mcsep-repos-${sfx}`);
registerForCleanup(reposDir);

const db = new Db();
db.setPlatformConfig({ maxConcurrentGates: 1 });

const projId = `mcsep-p-${sfx}`;
const oldMgr = `mcsep-oldmgr-${sfx}`, freshMgr = `mcsep-freshmgr-${sfx}`;
const workerId = `mcsep-wkr-${sfx}`, taskId = `mcsep-task-${sfx}`;

const repo = path.join(reposDir, "worker");
makeRepo(repo);
db.insertProject({ id: projId, name: "MCSEP", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });

db.insertAgent({ id: `agent-old-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
db.insertSession({ id: oldMgr, projectId: projId, agentId: `agent-old-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

db.insertAgent({ id: `agent-fresh-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
// `recycledFrom: oldMgr` is the real `recycleManager` shape — freshMgr's lineage root walks back to oldMgr.
db.insertSession({ id: freshMgr, projectId: projId, agentId: `agent-fresh-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", recycledFrom: oldMgr });

db.insertAgent({ id: `agent-wkr-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
db.insertTask({ id: taskId, projectId: projId, title: "MCSEP-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
const wt = await createWorktree(repo, projId, taskId);
registerForCleanup(wt.worktreePath);
fs.writeFileSync(path.join(wt.worktreePath, "feature.txt"), "work\n");
commitAll(wt.worktreePath, "feature", GIT_ID);
// NON-LIVE at the moment oldMgr "recycles" (modeled by freshMgr's recycledFrom above) — the exact
// residual `reparentLiveWorkers` (process_state='live'-gated) leaves behind.
db.insertSession({ id: workerId, projectId: projId, agentId: `agent-wkr-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: oldMgr, taskId, worktreePath: wt.worktreePath, branch: wt.branch });

// A second, unrelated worker (same project) to saturate cap 1, so the worker-under-test's own self-check
// genuinely queues instead of running immediately (mirrors gate-cancel.mjs's holder pattern).
const workerHolder = `mcsep-hwkr-${sfx}`, taskHolder = `mcsep-htask-${sfx}`;
const repoHolder = path.join(reposDir, "holder");
makeRepo(repoHolder);
db.insertAgent({ id: `agent-h-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
db.insertTask({ id: taskHolder, projectId: projId, title: "MCSEP-HTASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
const wtHolder = await createWorktree(repoHolder, projId, taskHolder);
registerForCleanup(wtHolder.worktreePath);
db.insertSession({ id: workerHolder, projectId: projId, agentId: `agent-h-${sfx}`, engineSessionId: null, title: null, cwd: wtHolder.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: null, taskId: taskHolder, worktreePath: wtHolder.worktreePath, branch: wtHolder.branch });

let releaseHolder;
let holderHold = new Promise((res) => { releaseHolder = res; });
let gateCalls = 0;
const sharedGate = async (_gate, cwd) => {
  if (cwd === wtHolder.worktreePath) { await holderHold; return { passed: true }; }
  gateCalls++;
  return { passed: true };
};
// gateOpRetainMs:0 (test-only seam, service.ts) disables run_gate's own 5s settle-grace retention window —
// scenario (2) deliberately re-calls runWorkerGate(workerId) back-to-back and each call must trigger its
// OWN fresh invocation, never a retained cache hit from scenario (1)'s settled self-check.
const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: sharedGate, syncAttachBudgetMs: GENEROUS_SYNC_BUDGET_MS, gateOpRetainMs: 0 });

// Sanity: reparentLiveWorkers is exactly the residual this scenario exploits.
const reparented = db.reparentLiveWorkers(oldMgr, freshMgr);
check("(setup) reparentLiveWorkers reparented ZERO rows — the worker is non-live, this IS the residual", reparented === 0);
check("(setup) the worker's parentSessionId is STILL the old (dead) manager", db.getSession(workerId).parentSessionId === oldMgr);

// ── (1) THE FIXTURE — recycled manager + non-live worker + a queued self-check ──────────────────────────
{
  const pHolderRun = sessions.runWorkerGate(workerHolder);
  await waitUntil(() => sessions.gateQueueForManager(projId).activeCount === 1);

  const pSelfCheck = sessions.runWorkerGate(workerId);
  await waitUntil(() => sessions.gateQueueForManager(projId).queued.length === 1);
  check("(1) the worker's own self-check is queued (setup sanity)", sessions.gateQueueForManager(projId).queued.length === 1);

  const confirmResult = await sessions.confirmWorkerMergeTracked(freshMgr, workerId);
  check("(1) the successor's confirm is refused as NotYourWorkerError (exact-id check, reached via a real mint)",
    confirmResult.settled === true && confirmResult.ok === false && confirmResult.error?.message === "not your worker");
  check("(1) [ROUND 2] the refusal DOES carry a freshMint — it genuinely reached pendingOps.attach() and minted (656e326f forbids an early attach-reachable exact-id refusal; only the self-check supersede is gated)",
    confirmResult.freshMint !== undefined);
  // The real mint leaves a brief, DISPLAY-ONLY retained view (card d1aee5f1, MERGE_OP_RETAIN_MS) — this is
  // NOT the same thing as a re-servable cached ANSWER (that's `usableRetainedHit`/`attach()`'s own dedupe,
  // which DOES filter NEVER_CACHED_OUTCOMES); scenario (2) below proves a later re-call is never refused
  // from a cache. So this is expected to be non-undefined now, unlike round 1's early-return shape.
  check("(1) [ROUND 2] the real mint leaves a brief retained display view (not an early-return no-op)",
    sessions.peekPendingMerge(workerId) !== undefined);

  // THE CORE FIX ASSERTION: the self-check must still be queued, untouched by the refused confirm.
  check("(1) [FIX] the worker's queued self-check is STILL queued — the refused confirm cancelled NOTHING",
    sessions.gateQueueForManager(projId).queued.length === 1);

  // Let it actually run (proves it's a live, working self-check, not merely "never settled").
  releaseHolder("go");
  await pHolderRun.catch(() => {});
  const selfCheckSettled = await pSelfCheck;
  check("(1) [FIX] the self-check ran for REAL once admitted (never cancelled) and passed",
    selfCheckSettled.ok === true && selfCheckSettled.value?.cancelled !== true && selfCheckSettled.value?.passed === true);
}

// ── (2) NOT CACHED — relink the worker (mirrors selfHealWorkerLink's own repair), re-confirm at the
//     SAME branch tip: it must proceed for real, never replay a cached "not your worker" ────────────────
{
  db.relinkWorkerToManager(workerId, freshMgr);
  check("(2) [setup] the worker is now relinked to its real caller", db.getSession(workerId).parentSessionId === freshMgr);

  holderHold = new Promise((res) => { releaseHolder = res; });
  const pHolderRun = sessions.runWorkerGate(workerHolder);
  await waitUntil(() => sessions.gateQueueForManager(projId).activeCount === 1);

  const pSelfCheck = sessions.runWorkerGate(workerId);
  await waitUntil(() => sessions.gateQueueForManager(projId).queued.length === 1);
  check("(2) the worker's own self-check is queued again (setup sanity)", sessions.gateQueueForManager(projId).queued.length === 1);

  // Fire the confirm WITHOUT awaiting yet — `supersedeQueuedSelfCheck` fires synchronously as part of
  // STARTING this call (before it ever needs an admission slot), so the self-check settles immediately,
  // well before the holder is released. The confirm's OWN merge gate still needs the holder released to
  // actually run (mirrors gate-cancel.mjs's "wording" block, which drives this exact ordering the same way).
  const pConfirm = sessions.confirmWorkerMergeTracked(freshMgr, workerId);

  // THE LEGITIMATE-OWNER SUPERSEDE, still exactly as before (also closes requirement (3)).
  const selfCheckSettled = await pSelfCheck;
  check("(2)+(3) the legitimate owner's confirm STILL supersedes the queued self-check, exactly as before",
    selfCheckSettled.ok === true && selfCheckSettled.value?.cancelled === true && selfCheckSettled.value?.cancelKind === "superseded-by-merge");

  releaseHolder("go");
  await pHolderRun.catch(() => {});
  const confirmResult = await pConfirm;
  check("(2) the re-confirm is NOT refused as \"not your worker\" — never a replay of (1)'s cached rejection",
    !(confirmResult.settled && confirmResult.ok === false && confirmResult.error?.message === "not your worker"));
  // `gateRan` may legitimately be `false` with a `reusedOpId` here — confirmWorkerMerge's OWN
  // reuse-a-green-self-check optimization (unrelated to this card) can validly reuse scenario (1)'s
  // settled, identical-tree self-check instead of re-running the gate; that is a real feature, not a
  // cache of THIS call's ownership decision — `gateCalls` is deliberately not asserted here for that
  // reason. What matters for "not cached" is that this call was NEVER refused as "not your worker".
  check("(2) the re-confirm ran for real and landed the merge (reused-gate or fresh, either is fine)",
    confirmResult.settled === true && confirmResult.ok === true && confirmResult.value?.merged === true);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a queued worker self-check is never superseded by a worker_merge_confirm call that is itself refused for a stale-but-lineage-matching exact parent (card 164f7915); the refusal is never cached, and the legitimate owner's confirm still supersedes the self-check exactly as before."
  : `\n❌ ${failures} FAILURE(S).`);

process.exit(failures === 0 ? 0 : 1);
