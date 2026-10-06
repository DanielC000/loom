import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Regression test for card 5f7d7a01 (Round 4 of docs/decisions/164f7915-*.md).
//
// Card 86c3286a (Round 3) moved confirmWorkerMergeTracked's self-check supersede decision to the SAME
// synchronous step as pendingOps.attach(), AFTER its two identity-resolving awaits (resolveGitRef/
// readMainlineHead) — closing the exact->stale check-to-mint window. Round 3's own record named a
// SEPARATE residual it deliberately left open ("A secondary finding..."): a slot that frees DURING those
// two awaits can let the worker's QUEUED `run_gate` self-check win GateSemaphore ADMISSION before the
// (now later) supersede decision ever runs. `supersedeQueuedSelfCheck` only ever cancels a still-QUEUED
// op (card 8d585277 — admission is not reversible that way), so the self-check keeps running for real,
// and `confirmWorkerMerge`'s own gate step then queues behind it (per-worktree exclusivity) and mints a
// SECOND, genuinely redundant real gate invocation once the self-check releases.
//
// THE FIX (card 5f7d7a01): `confirmWorkerMerge`'s existing e50600d2 reuse block now checks, immediately
// before reading `lastWorkerGateCheck`, whether the self-check is CURRENTLY in flight for this exact
// worker (`pendingOps.peek('gate:'+workerSessionId)?.state === "running"`) — and if so, waits (bounded by
// this project's own gateCommandTimeoutMs, via `pendingOps.waitBriefly`) for it to settle before falling
// into the EXISTING, UNCHANGED reuse-eligibility checks (branch match / passed / headCurrent / fresh
// stamp / freshBehindMain / onBranch). This never touches the Round 3 decision or GateSemaphore at all —
// see the decision record's Round 4 for the full lock audit and cancellation analysis.
//
// THE SEAM (Code Review round 2, replacing a timing-based 3-second fake gate that was proven to be able
// to pass VACUOUSLY under host load — a loaded gate host can let the merge's reuse read arrive AFTER the
// self-check has already settled even with no fix at all, making the old test pass on BOTH sides of the
// fix): the self-check's own fake gate call now blocks on a controllable hold, released ONLY by one of
// two OBSERVABLE events, never a clock —
//   (a) `sessions.pendingOps.waitBriefly` is called with the self-check's exact key — i.e. this card's own
//       fix actually ran and is genuinely parked waiting on it (the POST-fix path); or
//   (b) the merge's own gate call appears QUEUED behind the still-admitted self-check in
//       `gateQueueForManager` — i.e. there is NO wait at all and the merge instead minted and queued its
//       OWN gate for real (the PRE-fix path — this is what keeps a manual revert-and-rerun RED proof from
//       deadlocking instead of racing a clock to avoid it).
// Exactly one of (a)/(b) fires in any given run of the CURRENT code; a shipped scenario asserts (a) fired
// and (b) did not, so a reader can tell apart "the fix genuinely ran" from "the test got lucky".
//
// Two scenarios, both forcing the SAME admission race (a held slot is released from INSIDE the
// `confirmMergeMainlineHeadReader` override's first call — i.e. DURING the two identity-resolving
// awaits, before the Round 3 decision ever runs — and the override does not return until the self-check
// is observed ADMITTED, so THAT race is deterministic too, never a fixed wait):
//
//   (1) the self-check PASSES cleanly (no mid-run move) -> the merge must WAIT for it (via (a) above) and
//       REUSE its verdict: exactly ONE real gate invocation total. RED on main at 86c3286a (gateCalls===2
//       via path (b) instead, the exact shape that record's own Round 3 measured directly) — GREEN after
//       this round (path (a), gateCalls===1).
//   (2) the self-check PASSES but a commit lands on the worktree WHILE the merge is genuinely PARKED on
//       path (a)'s own `waitBriefly` call (the commit fires from inside the seam's release hook, between
//       the self-check's admission stamp and its settle stamp) -> it settles headCurrent:false. The merge
//       must NOT reuse it (the existing checkHeadCurrent condition, unchanged) and must run its OWN fresh
//       gate: exactly TWO real gate invocations. This is the behavioural control proving the fix defers to
//       the existing checks rather than treating "the self-check merely finished" as license to skip the
//       merge's own gate — and, by sitting on the SAME paused seam as (1), it actually exercises the NEW
//       code path (unlike an earlier draft of this scenario, which never entered the new wait at all).
//
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-self-check-admission-race.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mcsar-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const dbs = []; // closed at the very end (mirrors merge-confirm-supersede-mint-window.mjs) — an unclosed
// better-sqlite3 handle holds the file open, so the temp LOOM_HOME cleanup at process exit hits EBUSY on
// Windows instead of removing it cleanly.
const GIT_ID = "-c user.email=mcsar@loom -c user.name=mcsar";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
const GENEROUS_SYNC_BUDGET_MS = 600_000; // DI seam only — never the production constant

async function waitUntil(predicate, { intervalMs = 15, timeoutMs = 16000, label } = {}) {
  try {
    return await sharedWaitUntil(predicate, { timeoutMs, intervalMs, label: label ?? "mcsar: condition" });
  } catch {
    return predicate(); // one last try, then give up honestly
  }
}

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mcsar\n");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "baseline.ts"), "export const BASELINE = true;\n");
  execSync(`git init -q && git config user.email mcsar@loom && git config user.name mcsar`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

function sfxOf() { return `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`; }

// Builds one isolated (db, sessions, project, worker, holder) rig — mirrors merge-confirm-supersede-
// mint-window.mjs's buildRig exactly (same cap-1-saturation-via-a-genuinely-blocking-holder shape).
async function buildRig(sfx, { gateFor }) {
  const reposDir = path.join(os.tmpdir(), `loom-mcsar-repos-${sfx}`);
  registerForCleanup(reposDir);
  const db = new Db();
  dbs.push(db);
  db.setPlatformConfig({ maxConcurrentGates: 1 }); // saturate with the holder so the worker's own self-check genuinely queues

  const projId = `mcsar-p-${sfx}`;
  const repo = path.join(reposDir, "worker");
  makeRepo(repo);
  db.insertProject({ id: projId, name: "MCSAR", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });

  const taskId = `mcsar-task-${sfx}`;
  const wt = await createWorktree(repo, projId, taskId);
  registerForCleanup(wt.worktreePath);
  db.insertTask({ id: taskId, projectId: projId, title: "MCSAR-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  fs.writeFileSync(path.join(wt.worktreePath, "feature.txt"), "work\n");
  commitAll(wt.worktreePath, "feature", GIT_ID);

  const workerHolder = `mcsar-hwkr-${sfx}`, taskHolder = `mcsar-htask-${sfx}`;
  const repoHolder = path.join(reposDir, "holder");
  makeRepo(repoHolder);
  db.insertAgent({ id: `agent-h-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskHolder, projectId: projId, title: "MCSAR-HTASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const wtHolder = await createWorktree(repoHolder, projId, taskHolder);
  registerForCleanup(wtHolder.worktreePath);
  db.insertSession({ id: workerHolder, projectId: projId, agentId: `agent-h-${sfx}`, engineSessionId: null, title: null, cwd: wtHolder.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: null, taskId: taskHolder, worktreePath: wtHolder.worktreePath, branch: wtHolder.branch });

  let releaseHolder;
  const holderHold = new Promise((res) => { releaseHolder = res; });
  const sharedGate = async (_gate, cwd) => {
    if (cwd === wtHolder.worktreePath) { await holderHold; return { passed: true }; }
    return gateFor(cwd);
  };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: sharedGate, syncAttachBudgetMs: GENEROUS_SYNC_BUDGET_MS, gateOpRetainMs: 0 });

  return { db, sessions, projId, taskId, repo, wt, workerHolder, wtHolder, releaseHolder };
}

// Wires the shared admission-race seam: releases the held slot FROM INSIDE confirmMergeMainlineHeadReader's
// first call (the SECOND identity-resolving await in confirmWorkerMergeTracked) and does not let that
// override return until the worker's own self-check is observed ADMITTED — so by the time
// confirmWorkerMergeTracked resumes and reaches its Round-3 supersede decision, admission has ALREADY
// happened, deterministically, with no fixed wait anywhere.
function armAdmissionRace(sessions, projId, releaseHolder) {
  let mutated = false;
  const realHeadReader = sessions.confirmMergeMainlineHeadReader;
  sessions.confirmMergeMainlineHeadReader = async (...args) => {
    const result = await realHeadReader(...args);
    if (!mutated) {
      mutated = true;
      releaseHolder("go");
      await waitUntil(() => sessions.gateQueueForManager(projId).activeCount === 1, { label: "self-check admitted mid-window" });
    }
    return result;
  };
  return { restore: () => { sessions.confirmMergeMainlineHeadReader = realHeadReader; }, didFire: () => mutated };
}

// THE PAUSED SEAM (Code Review round 2): holds the self-check's own fake gate call open until ONE of two
// OBSERVABLE events fires — see this file's header for the full (a)/(b) rationale. `onRelease` (optional)
// runs BEFORE the hold is actually released, so a caller can do something (e.g. a mid-run commit) that
// must land while the merge is genuinely parked on path (a)'s own wait.
function armPausedSelfCheckSeam(sessions, projId, workerId, { onRelease } = {}) {
  let released = false, aFired = false, bFired = false;
  let releaseHold;
  const hold = new Promise((res) => { releaseHold = res; });
  const selfCheckKey = `gate:${workerId}`;
  const realWaitBriefly = sessions.pendingOps.waitBriefly.bind(sessions.pendingOps);
  const fire = async (which) => {
    if (released) return;
    released = true;
    if (which === "a") aFired = true; else bFired = true;
    if (onRelease) await onRelease();
    releaseHold();
  };
  sessions.pendingOps.waitBriefly = async (key, ms) => {
    if (key === selfCheckKey) await fire("a"); // (a): this card's own fix is genuinely parked here
    return realWaitBriefly(key, ms);
  };
  // Precisely "is THIS self-check's own GateSemaphore entry admitted" — via the low-level, non-redacted
  // `gateSemaphore.snapshot()` (sessionId/gateType/phase per entry), never the activeCount/queued VIEW
  // `gateQueueForManager` exposes: activeCount can ALREADY read 1 before the self-check is admitted at
  // all (the unrelated cap-saturating holder's own slot), which would fire this stage on the self-check's
  // OWN initial queued state instead of waiting for real admission — the exact bug this re-derivation fixes.
  const selfCheckAdmitted = () => sessions.gateSemaphore.snapshot().entries.some((e) => e.sessionId === workerId && e.gateType === "worker" && e.phase === "running");
  const pollerDone = (async () => {
    // Don't even look for "the merge's own gate is queued" until the self-check itself is admitted.
    await waitUntil(() => released || selfCheckAdmitted(), { timeoutMs: 20000, label: "paused-seam: self-check admitted" });
    if (released) return;
    await waitUntil(() => released || sessions.gateQueueForManager(projId).queued.length === 1, { timeoutMs: 20000, label: "paused-seam: merge's own gate queued (pre-fix path)" });
    if (!released && sessions.gateQueueForManager(projId).queued.length === 1) await fire("b"); // (b): no wait exists; the merge minted and queued its OWN gate instead
  })();
  return {
    hold,
    restore: () => { sessions.pendingOps.waitBriefly = realWaitBriefly; },
    aFired: () => aFired,
    bFired: () => bFired,
    settle: async () => { await pollerDone.catch(() => {}); },
  };
}

// ── (1) ADMISSION RACE, CLEAN SELF-CHECK — the self-check wins admission mid-window and runs for real;
//     the merge must WAIT for it (seam path (a)) and REUSE its verdict rather than mint a second gate.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const sfx = `clean-${sfxOf()}`;
  let gateCalls = 0;
  let seam; // assigned below, after buildRig — gateFor only ever reads it once actually CALLED (the
  // self-check is still queued, not yet admitted, at the point buildRig itself runs), so this ordering is safe.
  const { db, sessions, projId, taskId, workerHolder, wt, releaseHolder } = await buildRig(sfx, {
    gateFor: async () => { gateCalls++; if (gateCalls === 1) await seam.hold; return { passed: true }; },
  });

  const mgrId = `mcsar-c-mgr-${sfx}`, workerId = `mcsar-c-wkr-${sfx}`;
  db.insertAgent({ id: `agent-mgr-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mgr-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-wkr-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-wkr-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: wt.worktreePath, branch: wt.branch });

  const pHolderRun = sessions.runWorkerGate(workerHolder);
  await waitUntil(() => sessions.gateQueueForManager(projId).activeCount === 1);
  const pSelfCheck = sessions.runWorkerGate(workerId);
  await waitUntil(() => sessions.gateQueueForManager(projId).queued.length === 1);
  check("(1) the worker's own self-check is queued (setup sanity)", sessions.gateQueueForManager(projId).queued.length === 1);

  seam = armPausedSelfCheckSeam(sessions, projId, workerId);
  const race = armAdmissionRace(sessions, projId, releaseHolder);
  const pConfirm = sessions.confirmWorkerMergeTracked(mgrId, workerId);
  const confirmResult = await pConfirm;
  const selfCheckSettled = await pSelfCheck;
  await pHolderRun.catch(() => {});
  await seam.settle();
  race.restore();
  seam.restore();

  check("(1) precondition: the admission race actually fired (the slot was released mid-window)", race.didFire() === true);
  check("(1) precondition: the self-check was NOT superseded — it won admission before the decision ran",
    selfCheckSettled.ok === true && selfCheckSettled.value?.cancelled !== true);
  check("(1) precondition: the self-check ran for real and passed",
    selfCheckSettled.ok === true && selfCheckSettled.value?.passed === true);
  check("(1) [SEAM] released via path (a) — the FIX's own wait genuinely ran, never a timing guess", seam.aFired() === true);
  check("(1) [SEAM] path (b) (the pre-fix fallback) did NOT fire", seam.bFired() === false);
  check("(1) the confirm's own merge succeeded", confirmResult.settled === true && confirmResult.ok === true && confirmResult.value?.merged === true);
  check("(1) [FIX] the merge REUSED the self-check's verdict (reusedOpId matches, gateRan is false — never a fresh mint)",
    confirmResult.value?.gateRan === false && confirmResult.value?.reusedOpId === selfCheckSettled.value?.opId);
  check("(1) [FIX] exactly ONE real gate invocation total (the merge never minted its own)", gateCalls === 1);
}

// ── (2) ADMISSION RACE, HEAD MOVED WHILE PARKED ON PATH (a) — same race and the SAME paused seam, but the
//     mid-run commit fires from the seam's own release hook (i.e. genuinely while the merge is parked on
//     the fix's own waitBriefly call). The self-check settles PASS with headCurrent:false. The merge must
//     NOT reuse it and must run its OWN fresh gate — the behavioural control for "reuse requires the
//     existing checks", now actually exercising the new wait rather than bypassing it.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────
{
  const sfx = `moved-${sfxOf()}`;
  let gateCalls = 0;
  let seam;
  const { db, sessions, projId, taskId, workerHolder, wt, releaseHolder } = await buildRig(sfx, {
    gateFor: async (cwd) => {
      gateCalls++;
      // Only on the FIRST call (the self-check's own) — the merge's own (second) fresh gate, if it fires,
      // must see a CLEAN run so the merge itself doesn't ALSO refuse on a tip that moved during ITS OWN
      // gate. The commit itself is made by the seam's `onRelease` hook below, not here — see that call.
      if (gateCalls === 1) await seam.hold;
      return { passed: true };
    },
  });

  const mgrId = `mcsar-m-mgr-${sfx}`, workerId = `mcsar-m-wkr-${sfx}`;
  db.insertAgent({ id: `agent-mgr-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mgr-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-wkr-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-wkr-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: wt.worktreePath, branch: wt.branch });

  const pHolderRun = sessions.runWorkerGate(workerHolder);
  await waitUntil(() => sessions.gateQueueForManager(projId).activeCount === 1);
  const pSelfCheck = sessions.runWorkerGate(workerId);
  await waitUntil(() => sessions.gateQueueForManager(projId).queued.length === 1);
  check("(2) the worker's own self-check is queued (setup sanity)", sessions.gateQueueForManager(projId).queued.length === 1);

  // admitStamp (taken before gateFor's first call) and settleStamp (taken right after it resolves) then
  // disagree, which is exactly what describeGateHeadCurrency's admit-vs-settle check reads as "moved
  // WHILE this gate was actively running" — this fires from inside armPausedSelfCheckSeam's `onRelease`,
  // i.e. strictly BEFORE the hold is released, so it lands while the merge is genuinely parked.
  seam = armPausedSelfCheckSeam(sessions, projId, workerId, {
    onRelease: async () => {
      fs.writeFileSync(path.join(wt.worktreePath, "mid-run.txt"), "1\n");
      commitAll(wt.worktreePath, "mid-run commit", GIT_ID);
    },
  });
  const race = armAdmissionRace(sessions, projId, releaseHolder);
  const pConfirm = sessions.confirmWorkerMergeTracked(mgrId, workerId);
  const confirmResult = await pConfirm;
  const selfCheckSettled = await pSelfCheck;
  await pHolderRun.catch(() => {});
  await seam.settle();
  race.restore();
  seam.restore();

  check("(2) precondition: the admission race actually fired (the slot was released mid-window)", race.didFire() === true);
  check("(2) [SEAM] released via path (a) — the mid-run commit landed while genuinely parked on the fix's own wait", seam.aFired() === true);
  check("(2) [SEAM] path (b) (the pre-fix fallback) did NOT fire", seam.bFired() === false);
  check("(2) precondition: the self-check ran for real, passed, but is NOT head-current",
    selfCheckSettled.ok === true && selfCheckSettled.value?.cancelled !== true && selfCheckSettled.value?.passed === true && selfCheckSettled.value?.headCurrent === false);
  check("(2) the confirm's own merge still succeeded (the mid-run commit is real, later work)",
    confirmResult.settled === true && confirmResult.ok === true && confirmResult.value?.merged === true);
  check("(2) [CONTROL] the merge did NOT reuse the self-check's verdict — it ran its own fresh gate",
    confirmResult.value?.reused !== true && confirmResult.value?.gateRan === true);
  check("(2) [CONTROL] exactly TWO real gate invocations (self-check + the merge's own, by design)", gateCalls === 2);
}

for (const db of dbs) try { db.close(); } catch { /* ignore */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — confirmWorkerMerge (card 5f7d7a01, Round 4 of 164f7915) waits for a self-check that won GateSemaphore admission mid-window and reuses its verdict when the existing eligibility checks allow it, and still runs its own fresh gate when they don't (a moved HEAD) — both proven via an observable paused seam, never a timing guess."
  : `\n❌ ${failures} FAILURE(S).`);

process.exit(failures === 0 ? 0 : 1);
