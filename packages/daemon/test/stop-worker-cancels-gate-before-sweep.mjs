import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Regression tests for card 289f2607 — stopWorker/killAllWorkers used to sweep a stopped worker's
// worktree for stray processes (sweepWorktreeStrays -> reapProcessesRootedInWorktree) UNCONDITIONALLY,
// with no awareness of a live gate (a solo merge confirm or the worker's own run_gate self-check) whose
// gate command is spawned cwd-rooted in that SAME worker's own worktree. An external OS-level kill of
// that process (what the unguarded sweep would do) is classified by gate-runner.ts as a genuine FAILURE,
// never `cancelled:true` — reported by isMergeGateRed as a real RED attributed to the branch, not a stop.
//
// This file is a daemon-level (SessionService + REAL GateSemaphore) regression test for the FIX: before
// sweeping, stopWorker now cancels any gate op whose live registry entry carries the stopped worker's own
// sessionId (GateSemaphore.cancelRunning/cancelQueuedForSession), bounded-waits for it to clear, and
// SKIPS the sweep entirely if it hasn't cleared by then. The actual OS-level kill mechanism this fix
// avoids (a real process rooted in a worktree, killed by the real unmodified reapProcessesRootedInWorktree
// with no exclusion for it) was separately proven hermetically against REAL OS processes scoped to a
// scratch worktree path, outside this repo's test corpus (session evidence, card 289f2607's own worker
// report) — this file covers the SessionService-level ordering/skip logic that mechanism depends on.
//
// (A) a RUNNING worker self-check that RESPONDS to cancellation: stopWorker must cancel it, the self-check
//     must settle `cancelled:true` (never a red), and the worktree sweep must happen ONLY once the gate has
//     actually cleared from the live registry — never while it's still live.
// (B) a RUNNING worker self-check that NEVER responds to cancellation within the bound: stopWorker must
//     still request the cancel, but the sweep must be SKIPPED entirely (never reap a worktree a gate might
//     still hold) — this is the literal "skip the sweep" half of the fix.
// (C) a QUEUED worker self-check (never admitted, serialized behind a same-worktree holder): stopWorker
//     cancels it via the zero-process-risk queued path, and the sweep proceeds once it clears.
// (D) NEGATIVE CONTROL / proves this test can fail: with no live gate for the stopped worker at all, the
//     sweep still fires exactly as before this card — the fix is additive, never a blanket sweep-skip.
//
// Round 2 (card 289f2607) — the stop path must NEVER touch a MERGE/DEPLOY gate entry, even one carrying
// the stopped worker's own sessionId (a solo merge confirm's descriptor does exactly that):
// (E) a RUNNING merge gate for the worker's own sessionId: stopWorker must leave it completely alone
//     (never abort its cancelSignal), skip the sweep IMMEDIATELY (no bounded wait), and leave the entry
//     still live in the registry afterward.
// (F) a QUEUED merge gate for the worker's own sessionId: stopWorker must leave it queued (never withdraw
//     it — that would silently drop the manager's own worker_merge_confirm) and skip the sweep.
// (G) killAllWorkers: `control.pause("global")` must be latched SYNCHRONOUSLY, before any await — proven
//     by observing isPaused true immediately after calling killAllWorkers (before its own promise
//     settles) and by a concurrent `maybeDrainCapQueue` call (simulating a hard-stop's own async exit
//     handler racing the kill) finding the cap queue already frozen, never drained.
// (H) killAllWorkers waits on multiple held workers' bounded cancel-waits IN PARALLEL (Promise.all), not
//     serially — two never-settling self-checks cost ~one bounded wait, not two.
//
// Round 3 (card 289f2607, hardening) — the non-self-check lookup must be re-checked AGAIN right before the
// sweep, not only once at the top of the method:
// (I) a MERGE gate enqueued for the worker's own sessionId DURING the bounded cancel wait (not present
//     when the method started, and the self-check genuinely clears before the sweep decision): the sweep
//     must still be SKIPPED, and the merge entry left completely untouched.
//
// RED-ON-MAIN proof (recorded in this card's worker_report, not re-run automatically by this file): before
// the production fix, (B)'s "sweep never called while the gate is still live" assertion is FALSE —
// stopWorker called sweepWorktreeStrays directly with no cancel/wait/skip logic at all, so the sweep fired
// immediately regardless of the still-running gate. Before the Round 2 fix, (E)/(F) are FALSE — the old
// `cancelWorkerGateThenSweep` filtered live entries by sessionId alone (no gateType check), so it would
// cancelRunning/cancelQueuedForSession the worker's own MERGE entry exactly like a self-check. Before the
// Round 2 fix, (G) is FALSE — `killAllWorkers` called `control.pause("global")` only AFTER its
// `Promise.all`, so `isPaused` reads false immediately after the call and a concurrent
// `maybeDrainCapQueue` call drains the cap-queued entry instead of finding it frozen. Before the Round 3
// fix, (I) is FALSE — the non-self-check lookup ran only once, before the bounded wait, so a merge entry
// enqueued mid-wait was invisible to it and the sweep fired once the self-check cleared.
//
// Run: 1) build daemon (pnpm build), 2) node test/stop-worker-cancels-gate-before-sweep.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-swgc-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=swgc@loom -c user.name=swgc";
const now = new Date().toISOString();

const dbs = [];
const worktrees = [];

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# swgc\n");
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "baseline.ts"), "export const BASELINE = true;\n");
  execSync(`git init -q && git config user.email swgc@loom && git config user.name swgc`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

// isAlive:true — these fixtures model a genuinely LIVE worker (the real-world shape of this bug: a
// manager stopping a worker whose pty is still live while its own gate is running), so stopWorker's
// {stopped:true} path is exercised rather than its "no live pty" branch.
const ptyStub = { stop() {}, isAlive() { return true; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };

// A fake gate that RESPONDS to cancellation (mirrors gate-cancel.mjs's own `respondingGate`) — resolves
// with a real GateSequentialResult `{cancelled:true}` shape the instant the abort signal fires.
function makeRespondingGate() {
  let aborted = false;
  const fn = (_gate, _cwd, _timeoutMs, _runStep, _envOverride, _allowExtend, cancelSignal) => new Promise((resolve) => {
    const onAbort = () => { aborted = true; resolve({ cancelled: true, steps: [] }); };
    if (!cancelSignal) return;
    if (cancelSignal.aborted) { onAbort(); return; }
    cancelSignal.addEventListener("abort", onAbort);
  });
  return { fn, wasAborted: () => aborted };
}

// A fake gate that responds to cancellation only after `delayMs` — gives a test a reliable WINDOW, after
// the abort has been requested but before the self-check has actually cleared the live registry, to
// inject something else into that same session's gate entries (card 289f2607 Round 3, block (I)).
function makeDelayedRespondingGate(delayMs) {
  let aborted = false;
  const fn = (_gate, _cwd, _timeoutMs, _runStep, _envOverride, _allowExtend, cancelSignal) => new Promise((resolve) => {
    const onAbort = () => { aborted = true; setTimeout(() => resolve({ cancelled: true, steps: [] }), delayMs); };
    if (!cancelSignal) return;
    if (cancelSignal.aborted) { onAbort(); return; }
    cancelSignal.addEventListener("abort", onAbort);
  });
  return { fn, wasAborted: () => aborted };
}

// A fake gate that NEVER settles, even once cancellation is requested — simulates a kill whose
// verification never lands within the bound (mirrors gate-cancel.mjs's own "never-settling" block).
// `wasCalled` (Round 3, card 289f2607) flags the instant `fn` itself is actually invoked and has
// registered its abort listener — `runWorkerGate` does real git work (snapshotReflogs,
// computeWorktreeGateStamp) between admission (phase becomes "running") and the point it calls this `fn`,
// so a caller that proceeds straight from "entry is running" to requesting a stop can race ahead of that
// registration and see `wasAborted()` read false even though the cancel truly was requested — not because
// the fix is wrong, but because the abort fired before anything was listening for it. Callers that need a
// deterministic "the fn is now genuinely waiting on cancellation" checkpoint should `waitUntil(gate.wasCalled)`
// before triggering the stop.
function makeNeverSettlingGate() {
  let aborted = false;
  let called = false;
  const fn = (_gate, _cwd, _timeoutMs, _runStep, _envOverride, _allowExtend, cancelSignal) => new Promise(() => {
    called = true;
    if (!cancelSignal) return;
    if (cancelSignal.aborted) { aborted = true; return; }
    cancelSignal.addEventListener("abort", () => { aborted = true; });
  });
  return { fn, wasAborted: () => aborted, wasCalled: () => called };
}

async function setupProjectAndWorker(sfx, reposDir) {
  const db = new Db();
  dbs.push(db);
  const projId = `swgc-p-${sfx}`, mgrId = `swgc-mgr-${sfx}`, agentId = `swgc-agent-${sfx}`;
  const repo = path.join(reposDir, "worker");
  makeRepo(repo);
  db.insertProject({ id: projId, name: "SWGC", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const taskId = `swgc-t-${sfx}`;
  db.insertTask({ id: taskId, projectId: projId, title: "SWGC-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const wt = await createWorktree(repo, projId, taskId);
  worktrees.push(wt.worktreePath);
  const workerId = `swgc-w-${sfx}`;
  db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: wt.worktreePath, branch: wt.branch });
  return { db, projId, mgrId, workerId, worktreePath: wt.worktreePath };
}

try {
  // ── (A) RUNNING + RESPONDS: cancelled, never a red, sweep only AFTER the gate has cleared ────────────
  {
    const sfx = `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-swgc-a-${sfx}`);
    registerForCleanup(reposDir);
    const { mgrId, workerId, worktreePath } = await setupProjectAndWorker(sfx, reposDir);
    const gate = makeRespondingGate();
    const sweepCalls = [];
    const sessions = new SessionService(dbs[dbs.length - 1], ptyStub, new OrchestrationControl(), {
      runGate: gate.fn,
      reapWorktreeProcesses: async (wtPath, opts) => {
        sweepCalls.push({
          worktreePath: wtPath,
          excludePids: opts?.excludePids ?? [],
          gateStillLiveAtSweepTime: sessions.gateSemaphore.snapshot().entries.some((e) => e.sessionId === workerId),
        });
        return { killedPids: [] };
      },
    });

    const pRun = sessions.runWorkerGate(workerId);
    const liveEntry = await waitUntil(() => sessions.gateSemaphore.snapshot().entries.find((e) => e.sessionId === workerId && e.phase === "running"));
    check("(A pre) the self-check is genuinely RUNNING before stop", !!liveEntry);

    const stopResult = await sessions.stopWorker(mgrId, workerId, "hard");
    check("(A) stopWorker itself still reports success", stopResult.stopped === true);
    check("(A) the gate's cancelSignal was aborted (cancelRunning was actually requested)", gate.wasAborted());

    const settled = await pRun;
    check("(A) the self-check settles cancelled:true — never a pass/fail that isMergeGateRed could call a red",
      settled.settled === true && settled.ok === true && settled.value?.cancelled === true);

    await waitUntil(() => sweepCalls.some((c) => c.worktreePath === worktreePath), { label: "(A) sweep eventually fires once the gate has cleared" });
    check("(A) the worktree sweep DID fire (a genuinely cleared gate must not permanently block the sweep)",
      sweepCalls.some((c) => c.worktreePath === worktreePath));
    check("(A) by the time the sweep ran, the gate was NO LONGER live for this session (never reaped while still held)",
      sweepCalls.find((c) => c.worktreePath === worktreePath)?.gateStillLiveAtSweepTime === false);

    // Reconcile this worker's DB row to 'exited' — the stub pty's stop() is a no-op (never fires a real
    // onExit), so `stopWorker` above leaves it 'live' forever otherwise, and every `new Db()` in this file
    // resolves the SAME underlying sqlite file (Db() reads LOOM_HOME once, at first import) — a later
    // block's killAllWorkers() global live-worker scan (G, H) would otherwise still see this one too.
    dbs[dbs.length - 1].setProcessState(workerId, "exited");
  }

  // ── (B) RUNNING + NEVER RESPONDS: cancel requested, but the sweep is SKIPPED entirely ─────────────────
  {
    const sfx = `b-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-swgc-b-${sfx}`);
    registerForCleanup(reposDir);
    const { mgrId, workerId, worktreePath } = await setupProjectAndWorker(sfx, reposDir);
    const gate = makeNeverSettlingGate();
    const sweepCalls = [];
    const sessions = new SessionService(dbs[dbs.length - 1], ptyStub, new OrchestrationControl(), {
      runGate: gate.fn,
      // Small bound so this test doesn't wait out the real production default — see
      // cancelWorkerGateThenSweep's own stopGateCancelPollMs doc.
      gateCancelVerifyMs: 300, stopGateCancelPollMs: 20,
      reapWorktreeProcesses: async (wtPath) => { sweepCalls.push(wtPath); return { killedPids: [] }; },
    });

    const pRun = sessions.runWorkerGate(workerId).catch(() => {}); // never settles in this test's lifetime
    const liveEntry = await waitUntil(() => sessions.gateSemaphore.snapshot().entries.find((e) => e.sessionId === workerId && e.phase === "running"));
    check("(B pre) the self-check is genuinely RUNNING before stop", !!liveEntry);
    // phase==="running" is set at ADMISSION, but runWorkerGate still does real git work (snapshotReflogs,
    // computeWorktreeGateStamp) BEFORE it ever calls the fake gate's `fn` — so a stop fired the instant the
    // entry reads "running" can race ahead of `fn`'s own abort-listener registration (card 289f2607 Round
    // 3, the flaky 1-in-7 (B)). Wait for `fn` to have actually been invoked first, so the cancel this test
    // fires below is guaranteed to land on an `fn` that is already listening for it.
    await waitUntil(() => gate.wasCalled(), { label: "(B pre) the fake gate's fn has actually been invoked" });

    // stopWorker's own bounded wait (gateCancelVerifyMs=300ms above) has FULLY elapsed by the time this
    // await returns — the assertions below observe its OWN completed decision, not a guess about timing.
    const stopResult = await sessions.stopWorker(mgrId, workerId, "hard");
    check("(B) stopWorker itself still reports success", stopResult.stopped === true);
    check("(B) the gate's cancelSignal was aborted (cancelRunning was still requested even though it never verifies)", gate.wasAborted());
    check("(B) the worktree sweep was SKIPPED — never reap a worktree a gate might still hold",
      sweepCalls.length === 0);
    check("(B) the gate op is STILL live in the registry (never silently forgotten, just not swept over)",
      sessions.gateSemaphore.snapshot().entries.some((e) => e.sessionId === workerId));

    void pRun;
    // See (A)'s own comment — reconcile this worker's DB row so a later killAllWorkers() scan (G, H)
    // doesn't still see it as live.
    dbs[dbs.length - 1].setProcessState(workerId, "exited");
  }

  // ── (C) QUEUED (never admitted — serialized behind a same-worktree holder): zero-risk cancel, sweep proceeds ─
  {
    const sfx = `c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-swgc-c-${sfx}`);
    registerForCleanup(reposDir);
    const { db, projId, mgrId, workerId: holderId, worktreePath } = await setupProjectAndWorker(sfx, reposDir);
    // A SECOND worker sharing the SAME worktree path — GateSemaphore's per-worktree exclusivity guard
    // (card 8d585277) forces its self-check to QUEUE behind the holder's, never co-run.
    const agentId2 = `swgc-agent2-${sfx}`;
    const workerId2 = `swgc-w2-${sfx}`;
    db.insertAgent({ id: agentId2, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: workerId2, projectId: projId, agentId: agentId2, engineSessionId: null, title: null, cwd: worktreePath, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: null, worktreePath, branch: "loom/swgc-c2" });

    const holderGate = makeNeverSettlingGate();
    const sweepCalls = [];
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      runGate: holderGate.fn,
      reapWorktreeProcesses: async (wtPath) => { sweepCalls.push(wtPath); return { killedPids: [] }; },
    });

    const pHolderRun = sessions.runWorkerGate(holderId).catch(() => {}); // occupies the worktree, never settles
    await waitUntil(() => sessions.gateSemaphore.snapshot().entries.find((e) => e.sessionId === holderId && e.phase === "running"));
    const pSelfCheck2 = sessions.runWorkerGate(workerId2);
    const queuedEntry = await waitUntil(() => sessions.gateSemaphore.snapshot().entries.find((e) => e.sessionId === workerId2 && e.phase === "queued"));
    check("(C pre) the second worker's self-check is genuinely QUEUED (per-worktree exclusivity), never running", !!queuedEntry);

    const stopResult = await sessions.stopWorker(mgrId, workerId2, "hard");
    check("(C) stopWorker itself still reports success", stopResult.stopped === true);

    const settled2 = await pSelfCheck2;
    check("(C) the QUEUED self-check settles cancelled — zero process risk, never a red", settled2.settled === true && settled2.ok === true && settled2.value?.cancelled === true);
    await waitUntil(() => sweepCalls.includes(worktreePath), { label: "(C) sweep fires once the queued op clears" });
    check("(C) the worktree sweep fired for the second worker once its queued op cleared", sweepCalls.includes(worktreePath));
    check("(C) the HOLDER's own gate is untouched by worker2's stop (still live, never cancelled)",
      sessions.gateSemaphore.snapshot().entries.some((e) => e.sessionId === holderId && e.phase === "running"));

    void pHolderRun;
    // See (A)'s own comment — both workers in this block are reconciled so a later killAllWorkers() scan
    // (G, H) doesn't still count them as live (the holder was never stopped at all in this block).
    db.setProcessState(holderId, "exited");
    db.setProcessState(workerId2, "exited");
  }

  // ── (D) NEGATIVE CONTROL: no live gate for the stopped worker at all — the sweep still fires exactly as before this card ──
  {
    const sfx = `d-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-swgc-d-${sfx}`);
    registerForCleanup(reposDir);
    const { mgrId, workerId, worktreePath } = await setupProjectAndWorker(sfx, reposDir);
    const sweepCalls = [];
    const sessions = new SessionService(dbs[dbs.length - 1], ptyStub, new OrchestrationControl(), {
      reapWorktreeProcesses: async (wtPath) => { sweepCalls.push(wtPath); return { killedPids: [] }; },
    });

    const stopResult = await sessions.stopWorker(mgrId, workerId, "hard");
    check("(D) stopWorker itself still reports success", stopResult.stopped === true);
    await waitUntil(() => sweepCalls.includes(worktreePath), { label: "(D) sweep fires with no gate in play (fix is additive, not a blanket skip)" });
    check("(D) NEGATIVE CONTROL: with no live gate at all, the sweep still fires normally — this card's fix never suppresses an ordinary stray sweep",
      sweepCalls.includes(worktreePath));

    // See (A)'s own comment — reconcile this worker's DB row so a later killAllWorkers() scan (G, H)
    // doesn't still see it as live.
    dbs[dbs.length - 1].setProcessState(workerId, "exited");
  }

  // ── (E) RUNNING MERGE gate for the worker's OWN sessionId: must be left COMPLETELY untouched ──────────
  {
    const sfx = `e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-swgc-e-${sfx}`);
    registerForCleanup(reposDir);
    const { db, projId, mgrId, workerId, worktreePath } = await setupProjectAndWorker(sfx, reposDir);
    const sweepCalls = [];
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      // Large on purpose: if this entry were (wrongly) treated as the worker's own gate op to cancel,
      // stopWorker would wait out this FULL bound before giving up — the elapsed-time check below
      // catches that regression even if the "never aborted" assertion somehow didn't.
      gateCancelVerifyMs: 2000, stopGateCancelPollMs: 20,
      reapWorktreeProcesses: async (wtPath) => { sweepCalls.push(wtPath); return { killedPids: [] }; },
    });

    let mergeAborted = false;
    const mergeDescriptor = { gateType: "merge", projectId: projId, sessionId: workerId, taskId: null, branch: "loom/e", opId: `merge-${sfx}` };
    const pMerge = sessions.gateSemaphore.runExclusive(5, mergeDescriptor, (_startedAt, cancelSignal) => new Promise(() => {
      if (cancelSignal.aborted) { mergeAborted = true; return; }
      cancelSignal.addEventListener("abort", () => { mergeAborted = true; });
    })).catch(() => {});
    const mergeRunning = await waitUntil(() => sessions.gateSemaphore.snapshot().entries.find((e) => e.sessionId === workerId && e.gateType === "merge" && e.phase === "running"),
      { label: "(E pre) the merge gate admits and starts running" });
    check("(E pre) a MERGE gate is genuinely RUNNING for the worker's own sessionId before stop", !!mergeRunning);

    const t0 = Date.now();
    const stopResult = await sessions.stopWorker(mgrId, workerId, "hard");
    const elapsedMs = Date.now() - t0;
    check("(E) stopWorker itself still reports success", stopResult.stopped === true);
    check("(E) the MERGE gate's cancelSignal was NEVER aborted — a stop must never touch a merge/deploy entry", mergeAborted === false);
    check("(E) the worktree sweep was SKIPPED (a live merge gate for this worktree must never be reaped around)", sweepCalls.length === 0);
    check(`(E) the skip was IMMEDIATE (${elapsedMs}ms) — stopWorker never waits out the bounded cancel-verify window for an entry it must never try to cancel`,
      elapsedMs < 1000);
    check("(E) the merge gate entry is STILL live in the registry afterward — completely untouched by the stop",
      sessions.gateSemaphore.snapshot().entries.some((e) => e.sessionId === workerId && e.gateType === "merge" && e.phase === "running"));

    void pMerge;
    // See (A)'s own comment — reconcile this worker's DB row so a later killAllWorkers() scan (G, H)
    // doesn't still see it as live (the merge gate above is left genuinely live by design in this block,
    // but that lives only in the in-memory GateSemaphore, never the DB row).
    db.setProcessState(workerId, "exited");
  }

  // ── (F) QUEUED MERGE gate for the worker's OWN sessionId: must be left queued, never withdrawn ─────────
  {
    const sfx = `f-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-swgc-f-${sfx}`);
    registerForCleanup(reposDir);
    const { db, projId, mgrId, workerId, worktreePath } = await setupProjectAndWorker(sfx, reposDir);
    const sweepCalls = [];
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      reapWorktreeProcesses: async (wtPath) => { sweepCalls.push(wtPath); return { killedPids: [] }; },
    });

    // Occupy the ONLY cap slot with an unrelated holder so the worker's own merge op below is forced to
    // QUEUE rather than admit immediately.
    const holderSessionId = `swgc-holder-${sfx}`;
    const holderDescriptor = { gateType: "worker", projectId: projId, sessionId: holderSessionId, taskId: null, branch: null, opId: `holder-${sfx}` };
    const pHolder = sessions.gateSemaphore.runExclusive(1, holderDescriptor, () => new Promise(() => {})).catch(() => {});
    await waitUntil(() => sessions.gateSemaphore.snapshot().entries.find((e) => e.sessionId === holderSessionId && e.phase === "running"),
      { label: "(F pre) the holder admits and starts running" });

    const mergeDescriptor = { gateType: "merge", projectId: projId, sessionId: workerId, taskId: null, branch: "loom/f", opId: `merge-${sfx}` };
    const pMerge = sessions.gateSemaphore.runExclusive(1, mergeDescriptor, () => new Promise(() => {})).catch(() => {});
    const mergeQueued = await waitUntil(() => sessions.gateSemaphore.snapshot().entries.find((e) => e.sessionId === workerId && e.gateType === "merge" && e.phase === "queued"),
      { label: "(F pre) the merge op is genuinely queued behind the holder" });
    check("(F pre) a MERGE gate is genuinely QUEUED for the worker's own sessionId before stop (cap exhausted by the holder)", !!mergeQueued);

    const stopResult = await sessions.stopWorker(mgrId, workerId, "hard");
    check("(F) stopWorker itself still reports success", stopResult.stopped === true);
    check("(F) the worktree sweep was SKIPPED (a queued merge gate for this session must never be reaped around)", sweepCalls.length === 0);
    check("(F) the QUEUED merge gate entry is STILL queued afterward — never withdrawn by a stop (that would silently drop the manager's own worker_merge_confirm)",
      sessions.gateSemaphore.snapshot().entries.some((e) => e.sessionId === workerId && e.gateType === "merge" && e.phase === "queued"));
    check("(F) the HOLDER's own gate is untouched (still running) — this stop never affected the unrelated holder either",
      sessions.gateSemaphore.snapshot().entries.some((e) => e.sessionId === holderSessionId && e.phase === "running"));

    void pHolder; void pMerge;
    // See (A)'s own comment — reconcile this worker's DB row so a later killAllWorkers() scan (G, H)
    // doesn't still see it as live. `holderSessionId` above is a synthetic gate-only id, never a DB row.
    db.setProcessState(workerId, "exited");
  }

  // ── (G) killAllWorkers: the global pause must latch SYNCHRONOUSLY, before any await ─────────────────────
  {
    const sfx = `g-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-swgc-g-${sfx}`);
    registerForCleanup(reposDir);
    const { db, mgrId, workerId, worktreePath } = await setupProjectAndWorker(sfx, reposDir);
    const gate = makeNeverSettlingGate();
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      runGate: gate.fn,
      gateCancelVerifyMs: 300, stopGateCancelPollMs: 20,
      reapWorktreeProcesses: async () => ({ killedPids: [] }),
    });

    // A cap-queued spawn, present BEFORE killAllWorkers is ever called — models a manager with a slot-
    // starved spawn already waiting. If the pause isn't latched until AFTER the per-worker cancel-wait, a
    // concurrent maybeDrainCapQueue (the real shape of a hard pty.stop's own async exit handler) can drain
    // it and fire a brand-new spawn mid-kill.
    sessions.capQueue.record(mgrId, "g-agent", null, "G-test kickoff");
    check("(G pre) the cap-queued entry is present before killAllWorkers runs", sessions.capQueue.listByManager(mgrId).length === 1);

    const pRun = sessions.runWorkerGate(workerId).catch(() => {}); // never settles in this test's lifetime
    await waitUntil(() => sessions.gateSemaphore.snapshot().entries.find((e) => e.sessionId === workerId && e.phase === "running"),
      { label: "(G pre) the held self-check admits and starts running" });

    const p = sessions.killAllWorkers(); // deliberately NOT awaited yet
    check("(G) isPaused reads TRUE synchronously, immediately after calling killAllWorkers — before its own promise has settled",
      sessions.control.isPaused(mgrId) === true);

    // Simulate the real race this closes: a hard pty.stop's own async exit handler calling
    // maybeDrainCapQueue WHILE killAllWorkers's own bounded cancel-wait is still genuinely in flight (the
    // never-settling gate above guarantees `p` has not resolved yet at this point).
    await sessions.maybeDrainCapQueue(mgrId);
    check("(G) the cap-queued entry SURVIVES a concurrent maybeDrainCapQueue call made while killAllWorkers is still in flight — the kill switch's pause was already latched",
      sessions.capQueue.listByManager(mgrId).length === 1);

    const n = await p;
    check("(G) killAllWorkers reports the correct live-worker count", n === 1);
    check("(G) the cap-queued entry is STILL queued after killAllWorkers fully settles (paused throughout, never drained)",
      sessions.capQueue.listByManager(mgrId).length === 1);

    void pRun;
    // See (A)'s own comment — killAllWorkers never reconciles the DB row itself (that's a real onExit
    // event, not simulated by this hermetic stub pty) — reconcile here so (H)'s own count isn't inflated.
    db.setProcessState(workerId, "exited");
  }

  // ── (H) killAllWorkers waits on MULTIPLE held workers' bounded cancel-waits IN PARALLEL, not serially ───
  {
    const sfx = `h-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-swgc-h-${sfx}`);
    registerForCleanup(reposDir);
    const { db, projId, mgrId, workerId: workerId1, worktreePath: wt1 } = await setupProjectAndWorker(sfx, reposDir);
    // A second worker, same project/manager — reuses worker1's own worktree path (irrelevant here:
    // reapWorktreeProcesses is stubbed below and never reached before this test's own assertions run).
    const agentId2 = `swgc-agent-h2-${sfx}`;
    const workerId2 = `swgc-w2-${sfx}`;
    const now2 = new Date().toISOString();
    db.insertAgent({ id: agentId2, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: workerId2, projectId: projId, agentId: agentId2, engineSessionId: null, title: null, cwd: wt1, processState: "live", resumability: "unknown", busy: false, createdAt: now2, lastActivity: now2, lastError: null, role: "worker", parentSessionId: mgrId, taskId: null, worktreePath: wt1, branch: "loom/swgc-h2" });

    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      gateCancelVerifyMs: 1000, stopGateCancelPollMs: 20,
      reapWorktreeProcesses: async () => ({ killedPids: [] }),
    });

    // Admit both as genuinely RUNNING "worker"-gateType entries directly through the real GateSemaphore
    // (bypassing runWorkerGate's own config-resolved cap, which is daemon-GLOBAL and defaults to 1 —
    // irrelevant to what THIS block is proving, so a literal cap is passed here instead).
    let aborted1 = false, aborted2 = false;
    const mark = (flag) => (_s, cancelSignal) => new Promise(() => {
      if (cancelSignal.aborted) { flag.v = true; return; }
      cancelSignal.addEventListener("abort", () => { flag.v = true; });
    });
    const f1 = { v: false }, f2 = { v: false };
    const descriptor1 = { gateType: "worker", projectId: projId, sessionId: workerId1, taskId: null, branch: null, opId: `h1-${sfx}` };
    const descriptor2 = { gateType: "worker", projectId: projId, sessionId: workerId2, taskId: null, branch: null, opId: `h2-${sfx}` };
    const pRun1 = sessions.gateSemaphore.runExclusive(5, descriptor1, mark(f1)).catch(() => {});
    const pRun2 = sessions.gateSemaphore.runExclusive(5, descriptor2, mark(f2)).catch(() => {});
    await waitUntil(() => sessions.gateSemaphore.snapshot().entries.filter((e) => e.phase === "running").length === 2,
      { label: "(H pre) both self-checks are genuinely RUNNING before kill" });

    const t0 = Date.now();
    const n = await sessions.killAllWorkers();
    const elapsedMs = Date.now() - t0;
    check("(H) killAllWorkers reports both live workers stopped", n === 2);
    check("(H) BOTH gates were asked to abort", f1.v === true && f2.v === true);
    check(`(H) elapsed ${elapsedMs}ms stays near ONE bounded wait (~1000ms) — the two per-worker cancel-waits ran in PARALLEL via Promise.all, not serially (which would cost ~2000ms+)`,
      elapsedMs < 1800);

    void pRun1; void pRun2;
  }

  // ── (I) a MERGE gate enqueued for this session DURING the bounded cancel wait must still skip the sweep ─
  // (Round 3, card 289f2607): the top-of-method non-self-check check only sees a snapshot taken BEFORE the
  // bounded wait starts. This proves the method re-checks AGAIN, right before the sweep, so a merge/deploy
  // entry that shows up mid-wait (not present when the method started) still blocks it.
  {
    const sfx = `i-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-swgc-i-${sfx}`);
    registerForCleanup(reposDir);
    const { db, projId, mgrId, workerId, worktreePath } = await setupProjectAndWorker(sfx, reposDir);
    // Settles cancelled 80ms after the abort fires — long enough to reliably inject the merge entry below
    // WHILE the self-check is still live, short enough that it clears well inside the 500ms bound (so this
    // block exercises the self-check genuinely CLEARING and falling through to the NEW re-check — never
    // the already-covered "still live after the wait" skip path from blocks (B)/(E)/(F)).
    const gate = makeDelayedRespondingGate(80);
    const sweepCalls = [];
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
      runGate: gate.fn,
      gateCancelVerifyMs: 500, stopGateCancelPollMs: 20,
      reapWorktreeProcesses: async (wtPath) => { sweepCalls.push(wtPath); return { killedPids: [] }; },
    });

    const pRun = sessions.runWorkerGate(workerId);
    const liveEntry = await waitUntil(() => sessions.gateSemaphore.snapshot().entries.find((e) => e.sessionId === workerId && e.gateType === "worker" && e.phase === "running"));
    check("(I pre) the self-check is genuinely RUNNING before stop", !!liveEntry);

    const stopPromise = sessions.stopWorker(mgrId, workerId, "hard");
    // Inject a MERGE gate for the SAME session once the cancel has genuinely been requested, but before
    // the self-check's own 80ms delay has had a chance to clear it — i.e. squarely inside the bounded wait.
    await waitUntil(() => gate.wasAborted(), { label: "(I) the self-check's cancel was requested" });
    const mergeDescriptor = { gateType: "merge", projectId: projId, sessionId: workerId, taskId: null, branch: "loom/i", opId: `merge-${sfx}` };
    const pMerge = sessions.gateSemaphore.runExclusive(5, mergeDescriptor, () => new Promise(() => {})).catch(() => {});
    await waitUntil(() => sessions.gateSemaphore.snapshot().entries.some((e) => e.sessionId === workerId && e.gateType === "merge"),
      { label: "(I) the merge entry was enqueued for this session" });

    const stopResult = await stopPromise;
    check("(I) stopWorker itself still reports success", stopResult.stopped === true);
    check("(I) the self-check genuinely CLEARED from the registry (this block exercises the re-check, not the still-live skip)",
      !sessions.gateSemaphore.snapshot().entries.some((e) => e.sessionId === workerId && e.gateType === "worker"));
    check("(I) the worktree sweep was SKIPPED — a merge entry enqueued mid-wait must still block it",
      sweepCalls.length === 0);
    check("(I) the merge gate entry is still present afterward — completely untouched by the stop",
      sessions.gateSemaphore.snapshot().entries.some((e) => e.sessionId === workerId && e.gateType === "merge"));

    void pRun; void pMerge;
    db.setProcessState(workerId, "exited");
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — stopWorker/killAllWorkers now cancel (and bounded-wait on) any WORKER-gateType gate op live for the stopped worker's own sessionId BEFORE sweeping its worktree for strays: a RUNNING self-check that responds settles cancelled:true and the sweep fires only once it has genuinely cleared; one that never verifies within the bound leaves the sweep SKIPPED entirely rather than reaping a worktree a gate might still hold; a QUEUED self-check cancels at zero process risk and the sweep proceeds; and with no live gate at all the sweep still fires exactly as before this card. A MERGE/DEPLOY gate entry for that same sessionId is NEVER touched (running or queued) — the sweep skips immediately instead, and that non-self-check check is re-run again right before the sweep too, so an entry enqueued only DURING the bounded wait still blocks it. killAllWorkers latches its global pause synchronously, before any await, so a concurrent cap-queue drain never races it — and waits on multiple held workers' cancel-waits in parallel, not serially."
  : `\n❌ ${failures} FAILURE(S).`);

process.exit(failures === 0 ? 0 : 1);
