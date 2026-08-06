import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Merge-gate SINGLE-FILE RETRY test (card 344ce950 — a measured source of waste in the merge pipeline: a
// failure narrowed to one identifiable, re-runnable test file that then passes in isolation costs a full
// second run of the whole suite when the manager just re-fires worker_merge_confirm by hand instead).
// HERMETIC, no daemon — mirrors merge-gate-retry.mjs's in-process style: REAL git + an INJECTED `runGate`
// seam (this daemon's own test suite is far too heavy to actually spawn here), with dummy
// `packages/daemon/scripts/test-daemon.mjs` + `packages/daemon/test/<name>.mjs` files planted in the
// worktree so `identifyRetriableTestFile`'s real `fs.existsSync` checks resolve exactly as they would
// against this daemon's own real tree.
//
// Proves (DoD-3, MANDATORY, both directions):
//   (A) FAILS ONCE THEN PASSES — the gate continues (merged:true) and the row is FLAGGED: `retriedFile`/
//       `retryPassed:true` on both the return value and the durable `build_gate` gate_history event.
//   (B) FAILS TWICE — rejects EXACTLY as today (same `reason`/gateDetail as a genuine failure with no
//       retry mechanism at all), retried EXACTLY ONCE (never looped), with `retriedFile`/`retryPassed:false`
//       recorded additively (observability only — the rejection wording is unchanged).
//   (C) REGRESSION GUARD — NO failure at all: byte-identical to before this card. Exactly ONE gate call,
//       no `retriedFile` anywhere, no `build_gate_single_file_retry` event.
//   (D) NO IDENTIFIABLE FILE — a genuine failure whose `failingTest` doesn't match this daemon's own bare
//       `FAIL <name>` convention (a generic AssertionError line): no retry fires, rejects exactly as today.
//   (E) `identifyRetriableTestFile` unit coverage — undefined input, a candidate whose files don't exist on
//       disk (fail-closed), a real match, an unsafe/path-shaped name (Jest-style `FAIL src/foo.test.js`)
//       correctly refused by the bare-identifier guard.
//   (G) THE GUARD IS HELD THROUGH THE RETRY (Code Review CRITICAL, card b9e07a4a): the single-file retry
//       now re-admits through runExclusive and holds the per-repo merge-admission guard on a pass — before
//       that fix, the FIRST attempt's own failure had already freed the guard, leaving this retry's own
//       window unguarded. A same-repo sibling fired while the retry is genuinely running must wait for it.
//   (H) CANCELLING THE RETRY'S OWN QUEUED ADMISSION (Code Review, card b9e07a4a — a NEW throw path this
//       card introduced, previously unexercised by any test): since the retry now mints its OWN separate
//       `runExclusive` admission (see (G) above), it is independently reachable via `gate_cancel` while
//       QUEUED, exactly like any other merge-gate admission — `GateCancelledError` must be caught and
//       settle `confirmWorkerMerge` as a clean `cancelled:true`, never a thrown/misreported crash.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-gate-single-file-retry.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { assertNeverWithControl, observeOnce } from "./_timing-guard.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Poll instead of a blind fixed sleep — mirrors gate-cancel.mjs's own `waitUntil` verbatim (same
// reasoning: a blind sleep is the wall-clock-coincidence flake this suite's own DoD rejects). Bounded
// generously (8s) so a real bug still fails fast rather than hanging.
async function waitUntil(predicate, { intervalMs = 15, timeoutMs = 8000 } = {}) {
  const start = Date.now();
  for (;;) {
    const v = predicate();
    if (v) return v;
    if (Date.now() - start > timeoutMs) return predicate(); // one last try, then give up honestly
    await sleep(intervalMs);
  }
}

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-sfr-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { identifyRetriableTestFile } = await import("../dist/orchestration/gate-runner.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=sfr@loom -c user.name=sfr";
const now = new Date().toISOString();

const eventsOfKind = (db, mgrId, kind) => db.listEvents(mgrId).filter((e) => e.kind === kind);

function seed(db, p, gateCommand) {
  db.insertProject({ id: p.projId, name: "SFR", repoPath: p.repo, vaultPath: p.repo, config: { orchestration: { gateCommand } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "SFR-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

function makeRepo(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  fs.writeFileSync(path.join(p.repo, "README.md"), "# sfr\n");
  execSync(`git init -q && git config user.email sfr@loom && git config user.name sfr && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
}

// Plants the two files `identifyRetriableTestFile` looks for, relative to the worktree root — the real
// production shape (`packages/daemon/scripts/test-daemon.mjs` + `packages/daemon/test/<name>.mjs`).
// Content is irrelevant: the injected `runGate` below intercepts everything, nothing here is ever spawned.
function plantTestFile(worktreePath, name) {
  fs.mkdirSync(path.join(worktreePath, "packages", "daemon", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "scripts", "test-daemon.mjs"), "// stub\n");
  fs.mkdirSync(path.join(worktreePath, "packages", "daemon", "test"), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", `${name}.mjs`), "// stub\n");
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (label, file) => ({
  projId: `sfr-${label}-proj-${sfx}`, agentId: `sfr-${label}-agent-${sfx}`, taskId: `sfr-${label}-task-${sfx}`,
  mgrId: `sfr-${label}-mgr-${sfx}`, workerId: `sfr-${label}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-sfr-${label}-${sfx}`), file,
});

const dbs = [];
const worktrees = [];
try {
  // ── (A) FAILS ONCE THEN PASSES — gate continues AND the row is flagged ─────────────────────────────────
  {
    const A = mk("a", "feature-a.txt");
    makeRepo(A);
    const db = new Db(); dbs.push(db);
    const enqueued = [];
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin(...args) { enqueued.push(args); } };
    let calls = 0;
    const seenGates = [];
    const fakeGate = async (gate) => {
      calls++; seenGates.push(gate);
      if (calls === 1) return { passed: false, failedStep: "pnpm gate", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "", failingTest: "FAIL  flaky-one", failingTestCount: 1 };
      return { passed: true };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(A.repo, A.projId, A.taskId);
    A.worktreePath = worktreePath; A.branch = branch; worktrees.push(worktreePath);
    plantTestFile(worktreePath, "flaky-one");
    fs.writeFileSync(path.join(worktreePath, A.file), "work for A\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${A.file}"`, { cwd: worktreePath });
    seed(db, A, "pnpm gate");

    const confirm = await sessions.confirmWorkerMerge(A.mgrId, A.workerId);
    check("(A) exactly 2 gate calls (first genuine failure, one single-file retry)", calls === 2);
    check("(A) the retry call names the single-file re-invocation, not the original gate", seenGates[1] === "node packages/daemon/scripts/test-daemon.mjs --only=flaky-one");
    check("(A) retry passed -> merged:true", confirm.merged === true);
    check("(A) retriedFile is the identified name", confirm.retriedFile === "flaky-one");
    check("(A) retryPassed is true — the WEAKER-pass flag", confirm.retryPassed === true);
    check("(A) build_gate_single_file_retry fired once, retryPassed:true", (() => {
      const evs = eventsOfKind(db, A.mgrId, "build_gate_single_file_retry");
      return evs.length === 1 && evs[0].detail?.retriedFile === "flaky-one" && evs[0].detail?.retryPassed === true
        && evs[0].detail?.priorFailingTest === "FAIL  flaky-one";
    })());
    check("(A) the SAME build_gate row (not a second row) carries retriedFile/retryPassed:true, passed:true", (() => {
      const evs = eventsOfKind(db, A.mgrId, "build_gate");
      return evs.length === 1 && evs[0].detail?.passed === true && evs[0].detail?.retriedFile === "flaky-one" && evs[0].detail?.retryPassed === true;
    })());
    check("(A) the real gate_history read (listGateEvents/toGateHistoryRow) surfaces retriedFile/retryPassed", (() => {
      const page = db.listGateEvents({ projectId: A.projId, limit: 100, offset: 0 });
      const row = page.items.find((r) => r.gateType === "merge");
      return row?.retriedFile === "flaky-one" && row?.retryPassed === true && row?.outcome === "pass";
    })());
    check("(A) NO merge_rejected event — the manager was never told a rejection happened", eventsOfKind(db, A.mgrId, "merge_rejected").length === 0);
    check("(A) task moved to done", db.getTask(A.taskId).columnKey === "done");
  }

  // ── (G) THE GUARD IS HELD THROUGH THE RETRY — see this file's own header for the summary. Two real
  //        workers sharing one repo: worker1 fails once then retries a single file; worker2 (a real,
  //        non-inert change) fires ITS OWN confirm while worker1's retry is genuinely running and must
  //        wait for it, exactly as it would for worker1's ORIGINAL gate run. ───────────────────────────────
  {
    const G = mk("g", "feature-g1.txt");
    makeRepo(G);
    const db = new Db(); dbs.push(db);
    // DISCRIMINATE THE REPO GUARD FROM THE CAP (Code Review, card b9e07a4a): `maxConcurrentGates`
    // defaults to 1 and is daemon-global — at the default, worker2 (a REAL merge, admitted through the
    // ordinary CAP-gated `runExclusive`, unlike (H) in merge-gate-inert-diff.mjs, whose inert-skip sibling
    // goes through `acquireRepoGuardOnly` and never touches the cap at all) would queue behind BOTH the
    // cap AND the per-repo guard while worker1's single-file retry holds a slot — so a red here would go
    // red for either reason, and this test's whole point (the RETRY specifically holds the repo guard) is
    // exactly what a cap-1 default cannot distinguish from "the cap only allows 1 concurrent gate anyway".
    // Raising the cap to 2 removes cap contention as a candidate explanation (worker1's retry + worker2
    // both fit under cap 2), leaving the repo guard as the ONLY thing that can still make worker2 wait.
    db.setPlatformConfig({ maxConcurrentGates: 2 });
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };

    let calls = 0;
    let retryAdmittedResolve;
    const retryAdmitted = new Promise((res) => { retryAdmittedResolve = res; });
    let releaseRetry;
    const fakeGate = async () => {
      calls++;
      if (calls === 1) return { passed: false, failedStep: "pnpm gate", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "", failingTest: "FAIL  flaky-g", failingTestCount: 1 };
      if (calls === 2) {
        // THE single-file retry's own runGateSeq call — held open so we can prove the per-repo guard is
        // held (a same-repo sibling stays queued) while this is still running.
        retryAdmittedResolve();
        await new Promise((res) => { releaseRetry = res; });
        return { passed: true };
      }
      // calls >= 3: worker2's own (real, non-inert) gate — must NOT pause, this is the sibling whose
      // admission timing is exactly what this test is proving.
      return { passed: true };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });

    db.insertProject({ id: G.projId, name: "SFR-G", repoPath: G.repo, vaultPath: G.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: G.agentId, projectId: G.projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: G.mgrId, projectId: G.projId, agentId: G.agentId, engineSessionId: null, title: null, cwd: G.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });

    const task1Id = `${G.taskId}-1`, task2Id = `${G.taskId}-2`;
    const worker1Id = `${G.workerId}-1`, worker2Id = `${G.workerId}-2`;
    db.insertTask({ id: task1Id, projectId: G.projId, title: "SFR-G-RETRY", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertTask({ id: task2Id, projectId: G.projId, title: "SFR-G-SIBLING", body: "", columnKey: "in_progress", position: 2, createdAt: now, updatedAt: now });

    const wt1 = await createWorktree(G.repo, G.projId, task1Id);
    worktrees.push(wt1.worktreePath);
    plantTestFile(wt1.worktreePath, "flaky-g");
    fs.writeFileSync(path.join(wt1.worktreePath, G.file), "work for g1\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${G.file}"`, { cwd: wt1.worktreePath });
    db.insertSession({ id: worker1Id, projectId: G.projId, agentId: G.agentId, engineSessionId: null, title: null, cwd: wt1.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: G.mgrId, taskId: task1Id, worktreePath: wt1.worktreePath, branch: wt1.branch });

    const wt2 = await createWorktree(G.repo, G.projId, task2Id);
    worktrees.push(wt2.worktreePath);
    fs.writeFileSync(path.join(wt2.worktreePath, "feature-g2.txt"), "work for g2\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "feature-g2.txt"`, { cwd: wt2.worktreePath });
    db.insertSession({ id: worker2Id, projectId: G.projId, agentId: G.agentId, engineSessionId: null, title: null, cwd: wt2.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: G.mgrId, taskId: task2Id, worktreePath: wt2.worktreePath, branch: wt2.branch });

    const p1 = sessions.confirmWorkerMerge(G.mgrId, worker1Id);
    await retryAdmitted; // worker1's single-file retry has genuinely admitted and is mid-run

    let worker2Settled = false;
    const p2 = sessions.confirmWorkerMerge(G.mgrId, worker2Id).then((r) => { worker2Settled = true; return r; });

    const WINDOW_MS = 150;
    const neverSettled = await assertNeverWithControl({
      label: "(G) worker2 does NOT settle while worker1's single-file retry is still running",
      check: () => worker2Settled,
      windowMs: WINDOW_MS,
      positiveControl: async () => {
        let controlSettled = false;
        const pControl = sleep(1).then(() => { controlSettled = true; });
        const observed = await observeOnce({ check: () => controlSettled, windowMs: WINDOW_MS });
        await pControl;
        return observed;
      },
    });
    check("(G) worker2 PROVABLY waited — the single-file retry's own admission holds the per-repo guard", neverSettled);

    releaseRetry("go");
    const confirm1 = await p1;
    const confirm2 = await p2;

    check("(G) worker1's retry passed and merged", confirm1.merged === true && confirm1.retryPassed === true);
    // DETERMINISTIC, not racy (Code Review, card b9e07a4a): worker2 is blocked on the per-repo guard the
    // entire time worker1's retry is admitted+running — nothing else is ever concurrently admitted against
    // this repo that could invalidate worker1's own base, so `confirm1.reason` can never observe
    // `gate_base_invalidated` regardless of timing. Unlike (H) in merge-gate-inert-diff.mjs (where the
    // SECOND worker's own base is what's at risk), here worker1 is the one holding the guard throughout —
    // there is no window in which anything else could move main out from under IT.
    check("(G) worker1 was not force-invalidated by worker2 racing ahead", confirm1.reason !== "gate_base_invalidated");
    // DETERMINISTIC ASSERTION COVERING THE RETRY-SETTLE -> mergeBranch WINDOW (Code Review, card
    // b9e07a4a — contrast (H):377-380 in merge-gate-inert-diff.mjs, which names the SAME kind of guarantee
    // for the inert-skip case): worker2 is a REAL, non-inert merge, so once it is finally admitted (after
    // worker1's retry has released the guard by landing its own squash), worker2's FIRST attempt runs its
    // own `reunionAtAdmission()` (unlike worker1's single-file retry, which deliberately skips that call —
    // see this card's own service.ts doc) BEFORE its own gate ever runs. That re-union observes main has
    // moved (worker1 landed while worker2 waited), re-bases worker2's worktree onto the new head, and
    // advances worker2's own `gateBaseMainHead` — all before worker2's mocked gate (call #3, `passed:true`)
    // even runs. So worker2 is GUARANTEED to merge cleanly here, never `gate_base_invalidated`: unlike (H)'s
    // inert skip (which captures its base once and never re-unions, so a moved main deterministically fails
    // its later re-check), a REAL merge's own first-attempt admission is exactly where that staleness gap
    // is closed.
    check("(G) worker2 eventually settled once worker1's retry released the guard", worker2Settled === true && confirm2 != null);
    check("(G) worker2's own re-union at admission absorbed worker1's landed squash — merged cleanly, never invalidated",
      confirm2.merged === true && confirm2.reason !== "gate_base_invalidated");
  }

  // ── (H) CANCELLING THE RETRY'S OWN QUEUED ADMISSION — see this file's own header for the summary. The
  //        retry's `runExclusive` call is a BRAND NEW admission cycle (Item 1/(G) above), so it can queue
  //        behind an unrelated cap-1 contender exactly like any other merge gate, and `gate_cancel` must be
  //        able to withdraw it there. Mirrors gate-cancel.mjs's B2-2 block (the ORDINARY first-attempt
  //        case) for the RETRY's own admission specifically.
  //
  //        ORDERING IS DETERMINISTIC, NOT RACY: worker H's own first attempt is held open (blocking on
  //        `releaseCall1`) until AFTER the holder has been fired and is confirmed QUEUED (step order below)
  //        — so the holder is a genuinely PRE-QUEUED waiter by the time worker H's first attempt is finally
  //        released to fail. `GateSemaphore.release()` (called from worker H's OWN settling `runExclusive`)
  //        grants the freed cap-1 slot to that pre-queued waiter SYNCHRONOUSLY, inside `grantNext()`,
  //        BEFORE control ever returns to `confirmWorkerMerge`'s own continuation (which is what would go
  //        on to attempt the retry's fresh `acquire()`) — a plain consequence of `release()`/`grantNext()`
  //        being synchronous, non-async functions: the holder's `admit()` call happens-before
  //        `confirmWorkerMerge`'s microtask ever resumes, so the retry's own `acquire()` call always finds
  //        `active === cap` and queues. There is no window in which the retry could instead win the race. ──
  {
    const H = mk("h", "feature-h1.txt");
    makeRepo(H);
    const db = new Db(); dbs.push(db);
    db.setPlatformConfig({ maxConcurrentGates: 1 });

    let call1AdmittedResolve;
    const call1Admitted = new Promise((res) => { call1AdmittedResolve = res; });
    let releaseCall1;
    let holderAdmittedResolve;
    const holderAdmitted = new Promise((res) => { holderAdmittedResolve = res; });
    let releaseHolder;
    // Counts calls scoped to worker H's OWN worktree only — the proof that the retry's gate command never
    // spawns a SECOND time once its admission is cancelled. Deliberately NOT a shared/global counter: the
    // holder's own gate call (a different cwd, asserted separately below) must never inflate this.
    let callsForH = 0;
    const sharedGate = async (_gate, cwd) => {
      if (cwd === H.worktreePath) {
        callsForH++;
        call1AdmittedResolve();
        await new Promise((res) => { releaseCall1 = res; });
        // The genuine, identifiable failure that would normally trigger the single-file retry — but the
        // retry's OWN admission gets cancelled below before this function is ever called a second time.
        return { passed: false, failedStep: "pnpm gate", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "", failingTest: "FAIL  flaky-h", failingTestCount: 1 };
      }
      // The holder's own gate — held open once admitted (mirrors worker H's own call1 above) so it keeps
      // occupying the cap-1 slot long enough for the retry's own admission to genuinely queue behind it and
      // be observed/cancelled, instead of racing to finish and free the slot again before either happens.
      holderAdmittedResolve();
      await new Promise((res) => { releaseHolder = res; });
      return { passed: true };
    };
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: sharedGate });

    db.insertProject({ id: H.projId, name: "SFR-H", repoPath: H.repo, vaultPath: H.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: H.agentId, projectId: H.projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: H.taskId, projectId: H.projId, title: "SFR-H-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: H.mgrId, projectId: H.projId, agentId: H.agentId, engineSessionId: null, title: null, cwd: H.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const { worktreePath, branch } = await createWorktree(H.repo, H.projId, H.taskId);
    H.worktreePath = worktreePath; H.branch = branch; worktrees.push(worktreePath);
    plantTestFile(worktreePath, "flaky-h");
    fs.writeFileSync(path.join(worktreePath, H.file), "work for h\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${H.file}"`, { cwd: worktreePath });
    db.insertSession({ id: H.workerId, projectId: H.projId, agentId: H.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: H.mgrId, taskId: H.taskId, worktreePath, branch });

    // A SEPARATE, unrelated project/worker to occupy the cap-1 slot once it frees — mirrors gate-cancel.mjs
    // B2-2's own holder setup exactly.
    const holderRepo = path.join(os.tmpdir(), `loom-sfr-h-holder-${sfx}`);
    const holderProjId = `sfr-h-holder-proj-${sfx}`, holderAgentId = `sfr-h-holder-agent-${sfx}`;
    const holderTaskId = `sfr-h-holder-task-${sfx}`, holderWorkerId = `sfr-h-holder-wkr-${sfx}`;
    makeRepo({ repo: holderRepo });
    db.insertProject({ id: holderProjId, name: "SFR-H-HOLDER", repoPath: holderRepo, vaultPath: holderRepo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: holderAgentId, projectId: holderProjId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: holderTaskId, projectId: holderProjId, title: "SFR-H-HOLDER-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const wtHolder = await createWorktree(holderRepo, holderProjId, holderTaskId);
    worktrees.push(wtHolder.worktreePath);
    fs.writeFileSync(path.join(wtHolder.worktreePath, "holder.txt"), "holder\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "holder.txt"`, { cwd: wtHolder.worktreePath });
    const holderMgrId = `${holderWorkerId}-mgr`;
    db.insertSession({ id: holderMgrId, projectId: holderProjId, agentId: holderAgentId, engineSessionId: null, title: null, cwd: holderRepo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: holderWorkerId, projectId: holderProjId, agentId: holderAgentId, engineSessionId: null, title: null, cwd: wtHolder.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: holderMgrId, taskId: holderTaskId, worktreePath: wtHolder.worktreePath, branch: wtHolder.branch });

    // 1) Worker H's first attempt admits (cap 1, nothing else contending yet) and blocks mid-run.
    const p1 = sessions.confirmWorkerMerge(H.mgrId, H.workerId);
    await call1Admitted;

    // 2) The holder fires NOW, while worker H's first attempt still occupies the cap-1 slot — it QUEUES.
    const pHolder = sessions.confirmWorkerMerge(holderMgrId, holderWorkerId);
    const holderQueued = await waitUntil(() => sessions.gateQueueForManager(holderProjId).queued.find((e) => e.gateType === "merge"));
    check("(H) the holder is genuinely QUEUED behind worker H's first attempt (setup sanity)", !!holderQueued);

    // 3) Release worker H's first attempt to fail for real — its slot frees, and (per this block's own
    //    ordering doc above) the ALREADY-QUEUED holder deterministically wins it, forcing the single-file
    //    retry's own fresh admission to queue instead of running immediately. The holder is held open
    //    (never resolves on its own) so it keeps occupying the slot until explicitly released below —
    //    otherwise it would finish and free the slot again before the retry's own admission (and this
    //    test's own observation of it) ever happens.
    releaseCall1("go");
    await holderAdmitted;
    const retryEntry = await waitUntil(() => sessions.gateQueueForManager(H.projId).queued.find((e) => e.gateType === "merge"));
    check("(H) the single-file retry's OWN admission is genuinely QUEUED (setup sanity)", !!retryEntry);

    if (retryEntry) {
      const cancelResult = await sessions.cancelGateOp(H.mgrId, retryEntry.opId);
      check("(H) cancelling the retry's QUEUED admission SUCCEEDS", cancelResult.outcome === "cancelled" && cancelResult.phase === "queued" && cancelResult.gateType === "merge");

      const confirmH = await p1;
      check("(H) confirmWorkerMerge settles cleanly with cancelled:true, never a thrown/misreported crash", confirmH.merged === false && confirmH.cancelled === true);
      check("(H) the cancel is tagged 'manual' (gate_cancel, not an automatic supersede)", confirmH.cancelKind === "manual");
      check("(H) it is NEVER misreported as a crash-shaped 'gate cancelled' error string", !/errored:.*gate cancelled/i.test(String(confirmH.reason ?? "")));
      const mergeCancelledEvts = eventsOfKind(db, H.mgrId, "merge_cancelled");
      check("(H) a merge_cancelled event was recorded (never a merge_rejected/merge-failed shape)", mergeCancelledEvts.length === 1 && mergeCancelledEvts[0].detail?.cancelKind === "manual");

      // Let the holder's own gate proceed and settle — cleanup hygiene, not itself asserted on.
      releaseHolder("go");
      const holderResult = await pHolder;
      check("(H) the holder itself merged normally once it won the freed slot", holderResult.merged === true);
      check("(H) the retry's OWN gate command never actually spawned — cancelled while queued, before admission (fn is never invoked for a withdrawn admission)", callsForH === 1);
    } else {
      // SETUP SANITY FAILED (Code Review #4, card b9e07a4a): release the holder and let both confirms
      // settle BEFORE moving on, instead of leaving `p1`/`pHolder` dangling — without this, a genuine
      // regression in the exact property this test exists to catch (the retry's admission never showing up
      // QUEUED) would leave worker H's `confirmWorkerMerge` parked forever behind a holder nobody ever
      // releases, hanging this whole run instead of producing a named red. `allSettled` (not `all`): the
      // point here is cleanup, not a second round of assertions — a red is already recorded above.
      console.log("SKIP  (H) cancel/settle assertions — setup sanity check above already failed");
      releaseHolder("go");
      await Promise.allSettled([p1, pHolder]);
    }
  }

  // ── (F) MULTI-FAILURE — manager review (#128): createFailingTestTracker keeps only the LAST matching ────
  // line per pattern tier (proven directly against the REAL tracker just below) — a run where TWO files
  // (alpha, beta) genuinely fail collapses to a single `failingTest` string naming only the LAST one. This
  // fakeGate hands confirmWorkerMerge EXACTLY that collapsed shape — indistinguishable, from confirmWorkerMerge's
  // own vantage point, from a real 2-failure run. `beta` passes in isolation; `alpha` is NEVER re-examined.
  {
    const { createFailingTestTracker } = await import("../dist/orchestration/gate-runner.js");
    const proofTracker = createFailingTestTracker();
    proofTracker.feed(Buffer.from("FAIL  alpha  (exit 1)\nFAIL  beta  (exit 1)\n"));
    check("(F proof) the REAL tracker collapses 2 distinct failing files to the LAST one only — root cause confirmed", proofTracker.result() === "FAIL  beta  (exit 1)");
    check("(F proof, THE FIX) matchCount() correctly reports 2 for the SAME collapsed line — this is what lets identifyRetriableTestFile refuse it", proofTracker.matchCount() === 2);

    const F = mk("f", "feature-f.txt");
    makeRepo(F);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { } };
    let calls = 0;
    const seenGates = [];
    const fakeGate = async (gate) => {
      calls++; seenGates.push(gate);
      // Mirrors the REAL (fixed) tracker's own collapsed output above verbatim — `failingTest` names only
      // `beta`, but `failingTestCount:2` (the same number `proofTracker.matchCount()` just proved) tells
      // the retry gate this is NOT a complete account of the failure. `alpha`'s failure is real and
      // genuinely invisible through `failingTest` alone; `failingTestCount` is what keeps it visible.
      if (calls === 1) return { passed: false, failedStep: "pnpm gate", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "FAIL  alpha  (exit 1)\nFAIL  beta  (exit 1)", failingTest: "FAIL  beta  (exit 1)", failingTestCount: 2 };
      return { passed: true }; // beta passes in isolation — alpha was never re-run
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(F.repo, F.projId, F.taskId);
    F.worktreePath = worktreePath; F.branch = branch; worktrees.push(worktreePath);
    plantTestFile(worktreePath, "beta");
    fs.writeFileSync(path.join(worktreePath, F.file), "work for F\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${F.file}"`, { cwd: worktreePath });
    seed(db, F, "pnpm gate");

    const confirm = await sessions.confirmWorkerMerge(F.mgrId, F.workerId);
    check(
      "(F) SAFE OUTCOME REQUIRED: a collapsed multi-failure signal must NOT retry+merge — alpha's failure was never re-examined",
      confirm.merged === false && calls === 1,
    );
  }

  // ── (B) FAILS TWICE — rejects EXACTLY as today, retried EXACTLY ONCE ────────────────────────────────────
  {
    const B = mk("b", "feature-b.txt");
    makeRepo(B);
    const db = new Db(); dbs.push(db);
    const enqueued = [];
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin(...args) { enqueued.push(args); } };
    let calls = 0;
    const fakeGate = async () => {
      calls++;
      return { passed: false, failedStep: "pnpm gate", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "AssertionError: expected 1 to equal 2", failingTest: "FAIL  flaky-two", failingTestCount: 1 };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(B.repo, B.projId, B.taskId);
    B.worktreePath = worktreePath; B.branch = branch; worktrees.push(worktreePath);
    plantTestFile(worktreePath, "flaky-two");
    fs.writeFileSync(path.join(worktreePath, B.file), "work for B\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${B.file}"`, { cwd: worktreePath });
    seed(db, B, "pnpm gate");

    const confirm = await sessions.confirmWorkerMerge(B.mgrId, B.workerId);
    check("(B) exactly 2 gate calls (first fail, one single-file retry, NEVER looped)", calls === 2);
    check("(B) merged:false", confirm.merged === false);
    check("(B) reason is the flat back-compat string — UNCHANGED by the retry mechanism", confirm.reason === "build gate failed");
    check("(B) gateDetail.failingTest is the ORIGINAL failure's, unaffected by the retry", confirm.gateDetail?.failingTest === "FAIL  flaky-two");
    check("(B) retriedFile/retryPassed:false recorded additively, without changing the verdict", confirm.retriedFile === "flaky-two" && confirm.retryPassed === false);
    check("(B) the gate_history row shows the failed retry too (outcome:'reject')", (() => {
      const page = db.listGateEvents({ projectId: B.projId, limit: 100, offset: 0 });
      const row = page.items.find((r) => r.gateType === "merge");
      return row?.retriedFile === "flaky-two" && row?.retryPassed === false && row?.outcome === "reject";
    })());
    const rejectMsgs = enqueued.filter((args) => args[0] === B.mgrId && typeof args[1] === "string" && args[1].includes("[loom:merge-rejected]"));
    check("(B) exactly ONE [loom:merge-rejected] signal, wording unchanged", rejectMsgs.length === 1 && rejectMsgs[0][1].includes("build gate failed"));
    check("(B) worktree RETAINED (fail-closed)", fs.existsSync(B.worktreePath));
    check("(B) task NOT moved to done", db.getTask(B.taskId).columnKey !== "done");
  }

  // ── (C) REGRESSION GUARD — NO failure at all: byte-identical to before this card ────────────────────────
  {
    const C = mk("c", "feature-c.txt");
    makeRepo(C);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { } };
    let calls = 0;
    const fakeGate = async () => { calls++; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(C.repo, C.projId, C.taskId);
    C.worktreePath = worktreePath; C.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, C.file), "work for C\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${C.file}"`, { cwd: worktreePath });
    seed(db, C, "pnpm gate");

    const confirm = await sessions.confirmWorkerMerge(C.mgrId, C.workerId);
    check("(C) exactly ONE gate call — no retry mechanism touches a clean pass", calls === 1);
    check("(C) merged:true", confirm.merged === true);
    check("(C) retriedFile is undefined — no extra spawn, no retry", confirm.retriedFile === undefined);
    check("(C) retryPassed is undefined", confirm.retryPassed === undefined);
    check("(C) NO build_gate_single_file_retry event fired", eventsOfKind(db, C.mgrId, "build_gate_single_file_retry").length === 0);
    check("(C) the build_gate event carries no retriedFile key at all (byte-identical shape)", (() => {
      const evs = eventsOfKind(db, C.mgrId, "build_gate");
      return evs.length === 1 && !("retriedFile" in (evs[0].detail ?? {}));
    })());
    check("(C) the gate_history row reads retriedFile:null, retryPassed:null (never-fired shape)", (() => {
      const page = db.listGateEvents({ projectId: C.projId, limit: 100, offset: 0 });
      const row = page.items.find((r) => r.gateType === "merge");
      return row?.retriedFile === null && row?.retryPassed === null;
    })());
  }

  // ── (D) NO IDENTIFIABLE FILE — a genuine failure that doesn't name a real file ──────────────────────────
  {
    const D = mk("d", "feature-d.txt");
    makeRepo(D);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { } };
    let calls = 0;
    const fakeGate = async () => {
      calls++;
      return { passed: false, failedStep: "pnpm gate", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "AssertionError: expected 1 to equal 2", failingTest: "AssertionError: expected 1 to equal 2" };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(D.repo, D.projId, D.taskId);
    D.worktreePath = worktreePath; D.branch = branch; worktrees.push(worktreePath);
    // Deliberately NO plantTestFile() call — and even if there were, "AssertionError: ..." never matches
    // the bare `FAIL <name>` shape identifyRetriableTestFile looks for.
    fs.writeFileSync(path.join(worktreePath, D.file), "work for D\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${D.file}"`, { cwd: worktreePath });
    seed(db, D, "pnpm gate");

    const confirm = await sessions.confirmWorkerMerge(D.mgrId, D.workerId);
    check("(D) exactly ONE gate call — no identifiable file means no retry attempt", calls === 1);
    check("(D) reason is the flat back-compat string, unchanged", confirm.reason === "build gate failed");
    check("(D) retriedFile is undefined", confirm.retriedFile === undefined);
    check("(D) NO build_gate_single_file_retry event fired", eventsOfKind(db, D.mgrId, "build_gate_single_file_retry").length === 0);
  }

  // ── (E) identifyRetriableTestFile unit coverage ─────────────────────────────────────────────────────────
  {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "loom-sfr-unit-"));
    try {
      check("(E) undefined failingTest -> undefined", identifyRetriableTestFile(undefined, scratch, 1) === undefined);
      check("(E) a non-FAIL line -> undefined", identifyRetriableTestFile("AssertionError: expected 1 to equal 2", scratch, 1) === undefined);
      check("(E) FAIL <name> but the files don't exist on disk -> undefined (fail-closed)", identifyRetriableTestFile("FAIL  ghost-test", scratch, 1) === undefined);
      plantTestFile(scratch, "real-one");
      const hit = identifyRetriableTestFile("FAIL  real-one  (exit 1)", scratch, 1);
      check("(E) FAIL <name> with real files on disk AND count:1 -> identified", hit?.name === "real-one");
      check("(E) the constructed command is the --only= single-file re-invocation", hit?.command === "node packages/daemon/scripts/test-daemon.mjs --only=real-one");
      check("(E) a Jest-style path-shaped FAIL line is refused by the bare-identifier guard", identifyRetriableTestFile("FAIL src/foo.test.js", scratch, 1) === undefined);
      check("(E) manager review — count:2 on an otherwise-identical real match is refused (>1 match, not a single failure)", identifyRetriableTestFile("FAIL  real-one  (exit 1)", scratch, 2) === undefined);
      check("(E) manager review — count:undefined on an otherwise-identical real match is refused (unknown count fails closed)", identifyRetriableTestFile("FAIL  real-one  (exit 1)", scratch, undefined) === undefined);
      check("(E) manager review — count:0 on an otherwise-identical real match is refused", identifyRetriableTestFile("FAIL  real-one  (exit 1)", scratch, 0) === undefined);
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a genuine test-step failure naming one identifiable file is retried in isolation exactly once (never looped): a pass-after-retry continues the gate and flags retriedFile/retryPassed on both the return value and the durable gate_history row; a fail-twice rejects with the SAME wording as today; a clean pass or an unidentifiable failure never spawns the extra retry at all."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
