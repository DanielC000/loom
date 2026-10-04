import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Regression test for card 86c3286a (Round 3 of docs/decisions/164f7915-*.md).
//
// Card 164f7915 gated `supersedeQueuedSelfCheck` on `isExactWorkerOwner`, but evaluated that check
// SYNCHRONOUSLY, before `confirmWorkerMergeTracked`'s own two identity-resolving awaits
// (resolveGitRef/readMainlineHead). Those awaits leave a real window in which the worker's
// `parentSessionId` can change before the actual mint — card 86c3286a's own body names the two directions:
//
//   (a) stale at the check, exact at the mint  -> a real merge with NO supersede (a missed optimization
//       only — the queued self-check keeps running; GateSemaphore still serializes it behind the merge's
//       own gate on the same worktree, so nothing races).
//   (b) exact at the check, stale at the mint  -> the supersede WRONGLY fires, cancelling the self-check,
//       and the confirm is then refused by confirmWorkerMerge's own deep guard — the original 164f7915 bug,
//       narrowed to this await window.
//
// Plus a THIRD, independently-discovered gap (164f7915's own "Round 2" residual note): a lineage-matching-
// but-NOT-exact caller merely ATTACHING to an already-RUNNING merge op (never minting) skips the supersede
// entirely under the old gate (isExactWorkerOwner alone), re-opening the serialization card 8d585277 was
// filed to remove — safe to close per that card's own "QUEUED is zero-risk for any gate type" finding,
// since all that's cancelled is the WORKER'S OWN queued self-check, never the running op itself.
//
// THE FIX: the supersede decision now lives in the SAME synchronous step as `pendingOps.attach()`, AFTER
// both awaits, re-reading the worker row and `key`'s own pending-op state fresh — and fires for the exact
// owner OR for a caller about to attach to an already-RUNNING op under `key`.
//
// Two test seams close the window deterministically (no fixed waits, per the fixed-wait-witness guard):
// `confirmMergeBranchTipReader`/`confirmMergeMainlineHeadReader` wrap the real resolveGitRef/readMainlineHead
// so a scenario can mutate state exactly inside the await window, right before the real read returns.
//
// Scenarios (1) and (2) are RED-proved against pre-86c3286a code by temporarily reverting ONLY the
// decision's call-site location in service.ts (see this file's own worker_report for the revert/rebuild/
// restore cycle) while leaving the two seams in place — see the comment ahead of each `check()` block for
// what pre-fix code does instead. Scenario (3) is RED-proved the same way, and needs no seam at all: the
// OLD gate (`isExactWorkerOwner` alone, wherever it is evaluated) never fires for a lineage-only attacher to
// a running op, regardless of timing.
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-supersede-mint-window.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mcsmw-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const dbs = []; // every scenario's own Db instance, closed at the very end (mirrors gate-cancel.mjs) — an
// unclosed better-sqlite3 handle holds the file open, so the temp LOOM_HOME cleanup at process exit hits
// EBUSY on Windows instead of removing it cleanly.
const GIT_ID = "-c user.email=mcsmw@loom -c user.name=mcsmw";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
const GENEROUS_SYNC_BUDGET_MS = 600_000; // DI seam only — never the production constant (mirrors gate-cancel.mjs)

async function waitUntil(predicate, { intervalMs = 15, timeoutMs = 16000 } = {}) {
  try {
    return await sharedWaitUntil(predicate, { timeoutMs, intervalMs, label: "mcsmw: condition" });
  } catch {
    return predicate(); // one last try, then give up honestly (mirrors gate-cancel.mjs)
  }
}

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mcsmw\n");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "baseline.ts"), "export const BASELINE = true;\n");
  execSync(`git init -q && git config user.email mcsmw@loom && git config user.name mcsmw`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

function sfxOf() { return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; }

// Builds one isolated (db, sessions, project, worker, holder) rig. The HOLDER's own gate call genuinely
// BLOCKS on a test-controlled promise (released via the returned `releaseHolder`) — never a fire-and-settle
// stub — so it actually occupies the cap-1 slot until the test says otherwise. `gateFor(cwd)` lets each
// scenario decide the REAL worker's own gate behavior (e.g. count real invocations, or hang for scenario
// (3)'s merge gate) — it is never consulted for the holder's own cwd.
async function buildRig(sfx, { gateFor }) {
  const reposDir = path.join(os.tmpdir(), `loom-mcsmw-repos-${sfx}`);
  registerForCleanup(reposDir);
  const db = new Db();
  dbs.push(db);
  db.setPlatformConfig({ maxConcurrentGates: 1 }); // saturate with the holder so the worker's own self-check genuinely queues

  const projId = `mcsmw-p-${sfx}`;
  const repo = path.join(reposDir, "worker");
  makeRepo(repo);
  db.insertProject({ id: projId, name: "MCSMW", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });

  const taskId = `mcsmw-task-${sfx}`;
  // No agent inserted here — createWorktree needs no agent, and each scenario inserts its OWN
  // `agent-wkr-${sfx}` for the worker session it creates (a duplicate here would collide on insert).
  db.insertTask({ id: taskId, projectId: projId, title: "MCSMW-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const wt = await createWorktree(repo, projId, taskId);
  registerForCleanup(wt.worktreePath);
  fs.writeFileSync(path.join(wt.worktreePath, "feature.txt"), "work\n");
  commitAll(wt.worktreePath, "feature", GIT_ID);

  // A second, unrelated worker (same project) to saturate cap 1, so the worker-under-test's own self-check
  // genuinely queues instead of running immediately (mirrors gate-cancel.mjs's / merge-confirm-stale-exact-
  // parent-not-cancelled.mjs's holder pattern).
  const workerHolder = `mcsmw-hwkr-${sfx}`, taskHolder = `mcsmw-htask-${sfx}`;
  const repoHolder = path.join(reposDir, "holder");
  makeRepo(repoHolder);
  db.insertAgent({ id: `agent-h-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskHolder, projectId: projId, title: "MCSMW-HTASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const wtHolder = await createWorktree(repoHolder, projId, taskHolder);
  registerForCleanup(wtHolder.worktreePath);
  db.insertSession({ id: workerHolder, projectId: projId, agentId: `agent-h-${sfx}`, engineSessionId: null, title: null, cwd: wtHolder.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: null, taskId: taskHolder, worktreePath: wtHolder.worktreePath, branch: wtHolder.branch });

  // THE HOLDER GENUINELY BLOCKS: its own fake gate call never resolves until `releaseHolder` is called —
  // this is what makes it actually OCCUPY the cap-1 slot (a fake gate that resolves instantly would admit
  // and release again almost immediately, never actually saturating the cap for the window a scenario needs
  // to control — exactly the bug an earlier draft of this fixture had).
  let releaseHolder;
  const holderHold = new Promise((res) => { releaseHolder = res; });
  const sharedGate = async (_gate, cwd) => {
    if (cwd === wtHolder.worktreePath) { await holderHold; return { passed: true }; }
    return gateFor(cwd);
  };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: sharedGate, syncAttachBudgetMs: GENEROUS_SYNC_BUDGET_MS, gateOpRetainMs: 0 });

  return { db, sessions, projId, taskId, repo, wt, workerHolder, wtHolder, releaseHolder };
}

async function admitHolder(sessions, workerHolder, projId) {
  const pHolderRun = sessions.runWorkerGate(workerHolder);
  await waitUntil(() => sessions.gateQueueForManager(projId).activeCount === 1);
  return { pHolderRun };
}

// ── (1) STALE AT THE CHECK, EXACT AT THE MINT — a missed-optimization window under pre-fix code, closed
//     by this card: the self-check must now be superseded, since the fresh recheck (right before attach())
//     sees the row AS IT ACTUALLY IS AT MINT TIME, not as it was before the identity-resolving awaits ran.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const sfx = `stale2exact-${sfxOf()}`;
  let gateCalls = 0;
  const { db, sessions, projId, taskId, workerHolder, wt, releaseHolder } = await buildRig(sfx, {
    gateFor: async () => { gateCalls++; return { passed: true }; },
  });

  const oldMgr = `mcsmw-s2e-old-${sfx}`, freshMgr = `mcsmw-s2e-fresh-${sfx}`, workerId = `mcsmw-s2e-wkr-${sfx}`;
  db.insertAgent({ id: `agent-old-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: oldMgr, projectId: projId, agentId: `agent-old-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-fresh-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: freshMgr, projectId: projId, agentId: `agent-fresh-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", recycledFrom: oldMgr });
  db.insertAgent({ id: `agent-wkr-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  // STALE at the moment the call is made: the worker still points at oldMgr (not freshMgr).
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-wkr-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: oldMgr, taskId, worktreePath: wt.worktreePath, branch: wt.branch });

  check("(1) setup: worker starts STALE (parent is the OLD manager, not freshMgr)", db.getSession(workerId).parentSessionId === oldMgr);

  const { pHolderRun } = await admitHolder(sessions, workerHolder, projId);
  const pSelfCheck = sessions.runWorkerGate(workerId);
  await waitUntil(() => sessions.gateQueueForManager(projId).queued.length === 1);
  check("(1) the worker's own self-check is queued (setup sanity)", sessions.gateQueueForManager(projId).queued.length === 1);

  // THE WINDOW: relink worker -> freshMgr INSIDE the second identity-resolving await, simulating a
  // concurrent relink (e.g. selfHealWorkerLink) landing between the old check point and the real mint.
  // Pre-fix (the check evaluated EARLY, before this await ever runs): this relink happens too LATE to be
  // seen — isExactWorkerOwner(freshMgr, <stale row>) was already false by the time this call was made, so
  // supersedeQueuedSelfCheck never fires, and the self-check runs for real instead of being superseded (a
  // missed optimization under the PRE-FIX counterfactual, not a correctness bug — GateSemaphore's own
  // per-worktree exclusivity still means it can never run CONCURRENTLY with the merge's own gate). Whether
  // `gateCalls` would then settle at 1 (confirmWorkerMerge reuses the self-check's just-settled green
  // result) or 2 (the self-check hadn't yet written `lastWorkerGateCheck` by the time the merge's own reuse
  // check ran — see card 86c3286a Round 2's CR finding, docs/decisions/164f7915-*.md) depends on timing this
  // comment does not control and is NOT what this scenario's own checks below exercise — under the real,
  // FIXED code this test runs against, the self-check IS superseded (never runs at all), so `gateCalls`
  // reliably settles at exactly 1 either way.
  let mutated = false;
  const realHeadReader = sessions.confirmMergeMainlineHeadReader;
  sessions.confirmMergeMainlineHeadReader = async (...args) => {
    const result = await realHeadReader(...args);
    if (!mutated) { mutated = true; db.relinkWorkerToManager(workerId, freshMgr); }
    return result;
  };

  const pConfirm = sessions.confirmWorkerMergeTracked(freshMgr, workerId);
  // Wait for the mutation to land (and, by construction, for confirmWorkerMergeTracked's OWN supersede
  // decision — which runs synchronously right after this same await resolves, with nothing else awaited in
  // between — to have ALREADY been made) before releasing the holder. Releasing it any earlier would let
  // the self-check win admission into the just-freed slot via a totally UNRELATED race (GateSemaphore
  // admission latency vs. this call's own git reads) that has nothing to do with the window this test
  // targets — see gate-cancel.mjs's "(e2e single-admission)" block for the same mechanism documented in
  // full.
  await waitUntil(() => mutated === true);
  releaseHolder("go");
  await pHolderRun.catch(() => {});
  const confirmResult = await pConfirm;
  const selfCheckSettled = await pSelfCheck;
  sessions.confirmMergeMainlineHeadReader = realHeadReader;

  check("(1) the mutation actually landed inside the await window (precondition)", mutated === true);
  check("(1) the worker is EXACT by mint time (relinked to freshMgr)", db.getSession(workerId).parentSessionId === freshMgr);
  check("(1) [FIX] the self-check WAS superseded — the fresh recheck saw the row as exact at mint time",
    selfCheckSettled.ok === true && selfCheckSettled.value?.cancelled === true && selfCheckSettled.value?.cancelKind === "superseded-by-merge");
  check("(1) the confirm itself succeeded (the deep guard also sees exact-at-mint)",
    confirmResult.settled === true && confirmResult.ok === true && confirmResult.value?.merged === true);
  check("(1) exactly ONE real gate invocation (the self-check was cancelled, never ran for real)", gateCalls === 1);
}

// ── (2) EXACT AT THE CHECK, STALE AT THE MINT — the original 164f7915 bug, narrowed to this award window:
//     pre-fix, the self-check gets WRONGLY cancelled for a confirm that is then refused. Post-fix, the fresh
//     recheck sees the row as it actually is at mint time and correctly withholds the supersede.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const sfx = `exact2stale-${sfxOf()}`;
  let gateCalls = 0;
  const { db, sessions, projId, taskId, workerHolder, wt, releaseHolder } = await buildRig(sfx, {
    gateFor: async () => { gateCalls++; return { passed: true }; },
  });

  const oldMgr = `mcsmw-e2s-old-${sfx}`, freshMgr = `mcsmw-e2s-fresh-${sfx}`, workerId = `mcsmw-e2s-wkr-${sfx}`;
  db.insertAgent({ id: `agent-old-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: oldMgr, projectId: projId, agentId: `agent-old-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-fresh-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  // freshMgr shares oldMgr's lineage ROOT (recycledFrom oldMgr), so relinking the worker BACK to oldMgr
  // mid-flight still passes the lineage pre-check (656e326f) — only exactness is lost.
  db.insertSession({ id: freshMgr, projectId: projId, agentId: `agent-fresh-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", recycledFrom: oldMgr });
  db.insertAgent({ id: `agent-wkr-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  // EXACT at the moment the call is made: the worker points at freshMgr, the caller.
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-wkr-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: freshMgr, taskId, worktreePath: wt.worktreePath, branch: wt.branch });

  check("(2) setup: worker starts EXACT (parent IS freshMgr, the caller)", db.getSession(workerId).parentSessionId === freshMgr);

  const { pHolderRun } = await admitHolder(sessions, workerHolder, projId);
  const pSelfCheck = sessions.runWorkerGate(workerId);
  await waitUntil(() => sessions.gateQueueForManager(projId).queued.length === 1);
  check("(2) the worker's own self-check is queued (setup sanity)", sessions.gateQueueForManager(projId).queued.length === 1);

  // THE WINDOW: relink worker AWAY from freshMgr (back onto oldMgr — same lineage root, so the hoisted
  // 656e326f lineage pre-check still passes) INSIDE the second identity-resolving await.
  // Pre-fix (the check evaluated EARLY): isExactWorkerOwner(freshMgr, <still-exact row>) was already TRUE
  // by the time this call was made, so supersedeQueuedSelfCheck WRONGLY fires before this relink ever
  // happens — the self-check is cancelled for a confirm that the deep guard then refuses once it re-reads
  // the (now stale) row at the real mint.
  let mutated = false;
  const realHeadReader = sessions.confirmMergeMainlineHeadReader;
  sessions.confirmMergeMainlineHeadReader = async (...args) => {
    const result = await realHeadReader(...args);
    if (!mutated) { mutated = true; db.relinkWorkerToManager(workerId, oldMgr); }
    return result;
  };

  const pConfirm = sessions.confirmWorkerMergeTracked(freshMgr, workerId);
  // Same ordering discipline as scenario (1): wait for the mutation (and, by construction, the supersede
  // DECISION itself — made synchronously right after, nothing else awaited in between) before releasing the
  // holder, so this scenario's "not superseded" result reflects a genuine fresh-state decision rather than
  // the self-check merely winning an unrelated admission race before the decision was ever reached.
  await waitUntil(() => mutated === true);
  releaseHolder("go");
  await pHolderRun.catch(() => {});
  const confirmResult = await pConfirm;
  sessions.confirmMergeMainlineHeadReader = realHeadReader;

  check("(2) the mutation actually landed inside the await window (precondition)", mutated === true);
  check("(2) the worker is STALE by mint time (relinked away from freshMgr)", db.getSession(workerId).parentSessionId === oldMgr);
  check("(2) the confirm is refused as NotYourWorkerError via a real mint (the deep guard re-reads fresh)",
    confirmResult.settled === true && confirmResult.ok === false && confirmResult.error?.message === "not your worker" && confirmResult.freshMint !== undefined);

  // Let the self-check actually run (proves it's a live, working op — never cancelled for nothing).
  const selfCheckSettled = await pSelfCheck;
  check("(2) [FIX] the self-check was NEVER superseded — the fresh recheck saw the row as stale at mint time",
    selfCheckSettled.ok === true && selfCheckSettled.value?.cancelled !== true);
  check("(2) the self-check ran for REAL and passed (a queued op surviving to admission, not a cancelled one)",
    selfCheckSettled.ok === true && selfCheckSettled.value?.passed === true);
  check("(2) exactly ONE real gate invocation (the self-check's own; the refused confirm never ran a gate)", gateCalls === 1);
}

// ── (3) LINEAGE-ONLY CALLER ATTACHING TO AN ALREADY-RUNNING OP — the independently-discovered gap: must
//     now ALSO supersede the worker's own queued self-check, per card 8d585277 ("QUEUED is zero-risk for
//     any gate type"). No await-pausing seam needed: the OLD gate (isExactWorkerOwner alone) never fires
//     here regardless of timing, since the attaching caller is never the exact owner.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const sfx = `attach-running-${sfxOf()}`;
  let gateCalls = 0;
  let releaseMergeGate;
  const mergeGateHold = new Promise((res) => { releaseMergeGate = res; });
  // gateFor is never actually expected to run in a correct pass (the self-check must be superseded while
  // still queued, never admitted) — kept trivial rather than hanging, so a regression here fails fast and
  // visibly instead of wedging the whole file.
  const { db, sessions, projId, taskId, workerHolder, wt, releaseHolder } = await buildRig(sfx, {
    gateFor: async () => { gateCalls++; return { passed: true }; },
  });

  const exactMgr = `mcsmw-arr-exact-${sfx}`, lineageMgr = `mcsmw-arr-lineage-${sfx}`, workerId = `mcsmw-arr-wkr-${sfx}`;
  db.insertAgent({ id: `agent-exact-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: exactMgr, projectId: projId, agentId: `agent-exact-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-lineage-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  // lineageMgr shares exactMgr's lineage root (recycledFrom exactMgr) but is NEVER the worker's exact parent.
  db.insertSession({ id: lineageMgr, projectId: projId, agentId: `agent-lineage-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager", recycledFrom: exactMgr });
  db.insertAgent({ id: `agent-wkr-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-wkr-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: exactMgr, taskId, worktreePath: wt.worktreePath, branch: wt.branch });

  const { pHolderRun } = await admitHolder(sessions, workerHolder, projId);
  const pSelfCheck = sessions.runWorkerGate(workerId);
  await waitUntil(() => sessions.gateQueueForManager(projId).queued.length === 1);
  check("(3) the worker's own self-check is queued (setup sanity)", sessions.gateQueueForManager(projId).queued.length === 1);

  // THE RUNNING OP IS SYNTHESIZED DIRECTLY via pendingOps.attach — NEVER via a real confirmWorkerMergeTracked
  // call from exactMgr. A real exact-owner confirm would ALSO fire its OWN supersede (the ordinary,
  // pre-existing Round 2 behavior: isExactWorkerOwner is true for exactMgr regardless of this card), which
  // would cancel the self-check before lineageMgr's call ever runs — masking the exact thing this scenario
  // exists to isolate (mirrors gate-cancel.mjs's own "(e)" block header, same reasoning, same technique).
  const fakeMergeResult = { merged: true, cancelled: false };
  const pExactConfirm = sessions.pendingOps.attach(`merge:${workerId}`, "merge", exactMgr, GENEROUS_SYNC_BUDGET_MS, async () => {
    gateCalls++;
    await mergeGateHold; // stays RUNNING until released below
    return fakeMergeResult;
  });
  await waitUntil(() => sessions.pendingOps.peek(`merge:${workerId}`)?.state === "running");
  check("(3) exactMgr's merge op is genuinely RUNNING under the worker's merge key (setup sanity)",
    sessions.pendingOps.peek(`merge:${workerId}`)?.state === "running");

  // lineageMgr (lineage-matching, NOT the exact owner) now calls its own REAL confirm — it must ATTACH to
  // the already-running op above (never mint a second one), and — per this card's fix — must ALSO supersede
  // the worker's own still-queued self-check as a side effect, since cancelling a QUEUED op is zero-risk
  // regardless of who the running op's own owner is (card 8d585277). This is the ONLY supersede-capable call
  // in this scenario — the running op's own owner (exactMgr) never called confirmWorkerMergeTracked at all.
  const pLineageConfirm = sessions.confirmWorkerMergeTracked(lineageMgr, workerId);
  // Bounded via the shared OBSERVABLE-state poller (never a bare sleep): under a regression that drops the
  // running-op supersede arm, nothing ever cancels the self-check and nothing ever admits it either (the
  // holder never releases) — it would hang forever. `waitUntil` turns that into a clear, labeled timeout
  // instead of wedging this file. A healthy pass observes `selfCheckDone` almost immediately.
  let selfCheckDone = false, selfCheckSettled;
  pSelfCheck.then((r) => { selfCheckDone = true; selfCheckSettled = r; });
  await waitUntil(() => selfCheckDone, { timeoutMs: 10000, label: "(3) self-check settle (superseded or hung under a regression)" });
  check("(3) precondition: the self-check actually settled (a regression here would hang, never cancel)", selfCheckDone === true);
  check("(3) [FIX] the self-check WAS superseded by the lineage-only attacher's confirm",
    selfCheckDone && selfCheckSettled.ok === true && selfCheckSettled.value?.cancelled === true && selfCheckSettled.value?.cancelKind === "superseded-by-merge");

  releaseMergeGate("go");
  const [exactResult, lineageResult] = await Promise.all([pExactConfirm, pLineageConfirm]);
  check("(3) the synthesized running op settled ok with the fake merged result", exactResult.settled === true && exactResult.ok === true && exactResult.value === fakeMergeResult);
  check("(3) lineageMgr's confirm ATTACHED to the same result — never a second mint/merge",
    lineageResult.settled === true && lineageResult.ok === true && lineageResult.value === fakeMergeResult);
  check("(3) exactly ONE real gate invocation total (lineageMgr's confirm never minted its own)", gateCalls === 1);

  releaseHolder("go"); // cleanup only — the self-check already settled via supersede, never reached admission
  await pHolderRun.catch(() => {});
}

for (const db of dbs) try { db.close(); } catch { /* ignore */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — confirmWorkerMergeTracked (card 86c3286a, Round 3 of 164f7915) decides the self-check supersede fresh, in the same synchronous step as pendingOps.attach(), after its two identity-resolving awaits: a worker that becomes exact mid-flight is superseded, one that becomes stale mid-flight is not, and a lineage-only caller attaching to an already-running op now also supersedes."
  : `\n❌ ${failures} FAILURE(S).`);

process.exit(failures === 0 ? 0 : 1);
