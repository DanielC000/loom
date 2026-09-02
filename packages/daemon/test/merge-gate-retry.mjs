import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Merge-gate TRANSIENT-KILL AUTO-RETRY test (card bcba83a1 — the gate "lies" under memory pressure). REAL
// git + a REAL failing `node` gate step for the ANSI-strip proof, an INJECTED `runGate` seam for the
// signal/timedOut sequences a real cross-platform OOM/SIGKILL isn't reliably fakeable into (see
// gate-kill-classify.mjs's header for why a real external kill can't be produced portably) — drives
// SessionService.confirmWorkerMerge() directly against an isolated LOOM_HOME (mirrors
// merge-gate-diagnostic.mjs's in-process style).
//
// THE HOLE IT GUARDS: the merge gate used to surface an OOM/SIGKILL exactly like a genuine test/build
// failure — the flat "build gate failed" — so managers under load learned the gate "lies" and hand-rolled
// an unsafe `git merge --squash --no-verify`, defeating the review/merge safety rail entirely. THE FIX:
// classifyGateFailure buckets a failed step into kill/timeout/genuine; a retry-eligible bucket (kill or
// timeout) gets ONE auto-retry after a settle delay before anything is reported; a genuine non-zero exit
// is NEVER retried.
//
// Proves:
//   (A) TRANSIENT KILL, RETRY PASSES — absorbed silently: merged:true, no gateDetail, the manager is never
//       told a kill happened at all.
//   (B) TRANSIENT KILL, RETRY STILL FAILS — rejection wording is "gate killed by SIGKILL (possibly
//       OOM/resource) — retried once, still failed", not the flat "build gate failed"; exactly one retry
//       attempt. The signal is named explicitly (not asserted as OOM outright) so a deterministic crash
//       signal (e.g. SIGSEGV/SIGABRT) isn't mislabeled — the "(possibly OOM/resource)" hint is appended
//       only for SIGKILL, the signal an OOM-killer actually sends.
//   (C) OUR OWN GATE-TIMEOUT, RETRY STILL FAILS — distinct wording: "gate timed out (possibly
//       resource-starved under load) — retried once, still failed".
//   (D) GENUINE FAILURE NEVER RETRIES — a clean non-zero exit calls the gate runner exactly ONCE; `reason`
//       stays the flat back-compat "build gate failed" string.
//   (E) INJECTION HYGIENE END-TO-END — a REAL failing gate step whose output contains ANSI color codes and
//       a literal bracketed-paste terminator (`\x1b[201~`) never reaches the manager's pty with a raw ESC
//       byte in it, via the real (non-injected) runGateSequential/confirmWorkerMerge path.
//   (F) BUDGET-EXCEEDED SHORT-CIRCUIT (card 73a847f5) — a timeout that already consumed its ONE auto-extend
//       gets ZERO retry attempts (a hard-bounded `allowExtend:false` rerun of that exact run could not pass
//       either); `reason` reports the budget-exceeded skip by name, distinct from a generic gate failure,
//       and states plainly that a manager re-firing `worker_merge_confirm` is a separate, unaffected thing.
//   (G) CANCELLING THE TRANSIENT-KILL RETRY'S OWN QUEUED ADMISSION (card 518e7ff6 — the SIBLING gap card
//       318ac7b2 left open: this retry mints its OWN separate `runExclusive` admission, exactly like the
//       single-file retry, so it can independently queue behind an unrelated cap-1 contender and be
//       withdrawn there). UNLIKE 318ac7b2's fix: attempt 1's own `build_gate` row here is ALREADY written
//       (before this retry ever starts, not after), so the cancel-while-queued catch does NOT touch that
//       row — it stays a real, unmodified `outcome:"reject"` — and instead emits a SEPARATE
//       `build_gate_retry` row stamped `cancelled:true`/`gateSpawned:false`, recording that the retry
//       itself never reached a verdict. A reader now sees BOTH rows for the op, never a lone "reject".
// Run: 1) build daemon (pnpm build), 2) node test/merge-gate-retry.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup, cleanupPathSync } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Poll instead of a blind fixed sleep (a blind sleep is the wall-clock-coincidence flake this suite's own
// DoD rejects). Bounded generously (8s) so a real bug still fails fast rather than hanging.
// Card 43f5b242: this used to be a from-scratch poll loop (mirroring merge-gate-single-file-retry.mjs's
// own copy verbatim) — now delegates its actual polling to the shared `_wait.mjs` helper, keeping only
// the local "never throw — one last predicate() try, then give up honestly" contract on top, since real
// call sites below (`holderQueued`/`retryEntry`) depend on a timed-out call yielding a falsy/undefined
// value rather than throwing.
async function waitUntil(predicate, { intervalMs = 15, timeoutMs = 8000 } = {}) {
  try {
    return await sharedWaitUntil(predicate, { timeoutMs, intervalMs, label: "merge-gate-retry: condition" });
  } catch {
    return predicate(); // one last try, then give up honestly
  }
}

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mgr-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
// Drive the settle delay near-zero (env-overridable — sweep G3: read LIVE inside resolveConfig on every
// confirmWorkerMerge call, no longer at gate-runner.js's first import) so this test doesn't burn real
// multi-second waits across its 3 retry scenarios — also doubles as a live proof that
// LOOM_GATE_RETRY_SETTLE_MS actually takes effect (the disabled/default cases are covered by
// gate-kill-classify.mjs and merge-gate-retry-disabled.mjs).
process.env.LOOM_GATE_RETRY_SETTLE_MS = "20";
// Matches the env var set above — the resolved value SessionService actually uses for the retry settle
// delay (via resolveConfig's OrchestrationConfig.gateRetry.settleMs), asserted against directly below
// rather than importing a since-removed gate-runner.js module constant.
const GATE_RETRY_SETTLE_MS = 20;

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mgr@loom -c user.name=mgr";
const now = new Date().toISOString();

const eventsOfKind = (db, mgrId, kind) => db.listEvents(mgrId).filter((e) => e.kind === kind);

function seed(db, p, gateCommand) {
  db.insertProject({ id: p.projId, name: "MGR", repoPath: p.repo, vaultPath: p.repo, config: { orchestration: { gateCommand } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "MGR-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

function makeRepo(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  registerForCleanup(p.repo); // bare origin repo — never cleaned by the worktrees[]/LOOM_HOME sweep below
  fs.writeFileSync(path.join(p.repo, "README.md"), "# mgr\n");
  execSync(`git init -q && git config user.email mgr@loom && git config user.name mgr && git add . && git ${GIT_ID} commit -q -m init`, { cwd: p.repo });
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (label, file) => ({
  projId: `mgr-${label}-proj-${sfx}`, agentId: `mgr-${label}-agent-${sfx}`, taskId: `mgr-${label}-task-${sfx}`,
  mgrId: `mgr-${label}-mgr-${sfx}`, workerId: `mgr-${label}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-mgr-${label}-${sfx}`), file,
});

const dbs = [];
const worktrees = [];
try {
  // ── (A) TRANSIENT KILL, RETRY PASSES — absorbed silently ────────────────────────────────────────────
  {
    const A = mk("a", "feature-a.txt");
    makeRepo(A);
    const db = new Db(); dbs.push(db);
    const enqueued = [];
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin(...args) { enqueued.push(args); } };
    let calls = 0;
    const fakeGate = async () => {
      calls++;
      if (calls === 1) return { passed: false, failedStep: "pnpm gate", failedStatus: null, failedSignal: "SIGKILL", failedTimedOut: false, outputTail: "" };
      return { passed: true };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(A.repo, A.projId, A.taskId);
    A.worktreePath = worktreePath; A.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, A.file), "work for A\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${A.file}"`, { cwd: worktreePath });
    seed(db, A, "pnpm gate");

    const confirm = await sessions.confirmWorkerMerge(A.mgrId, A.workerId);
    check("(A) exactly 2 gate calls (first kill, one retry)", calls === 2);
    check("(A) retry passed -> merged:true", confirm.merged === true);
    check("(A) no gateDetail on the ultimate success", confirm.gateDetail === undefined);
    // Card 39da2570: this used to be "absorbed silently" (see the scenario's own header comment above) —
    // NOTHING on the return told a caller a transient-kill retry produced this pass. `transientRetried`
    // closes that gap; `retriedFile` stays undefined because THIS is the transient-kill retry, not the
    // single-file one (card 344ce950) — the two are mutually exclusive per attempt.
    check("(A) transientRetried:true — the retry that produced this pass is no longer silent (card 39da2570)", confirm.transientRetried === true);
    check("(A) retriedFile stays undefined — this is the transient-kill retry, not the single-file one", confirm.retriedFile === undefined);
    check("(A) build_gate_retry_attempt fired once", eventsOfKind(db, A.mgrId, "build_gate_retry_attempt").length === 1);
    check("(A) build_gate_retry fired once, passed:true", eventsOfKind(db, A.mgrId, "build_gate_retry").length === 1 && eventsOfKind(db, A.mgrId, "build_gate_retry")[0].detail?.passed === true);
    check("(A) NO merge_rejected event — the manager was never told a kill happened", eventsOfKind(db, A.mgrId, "merge_rejected").length === 0);
    check("(A) exactly ONE merge_done event", eventsOfKind(db, A.mgrId, "merge_done").length === 1);
    check("(A) task moved to done", db.getTask(A.taskId).columnKey === "done");
  }

  // ── (B) TRANSIENT KILL, RETRY STILL FAILS ───────────────────────────────────────────────────────────
  {
    const B = mk("b", "feature-b.txt");
    makeRepo(B);
    const db = new Db(); dbs.push(db);
    const enqueued = [];
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin(...args) { enqueued.push(args); } };
    let calls = 0;
    const fakeGate = async () => { calls++; return { passed: false, failedStep: "pnpm gate", failedStatus: null, failedSignal: "SIGKILL", failedTimedOut: false, outputTail: "still under pressure" }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(B.repo, B.projId, B.taskId);
    B.worktreePath = worktreePath; B.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, B.file), "work for B\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${B.file}"`, { cwd: worktreePath });
    seed(db, B, "pnpm gate");

    const confirm = await sessions.confirmWorkerMerge(B.mgrId, B.workerId);
    check("(B) exactly 2 gate calls (first kill, one retry, no more)", calls === 2);
    check("(B) merged:false", confirm.merged === false);
    check("(B) reason names the actual signal + the OOM hint (SIGKILL only) + retry outcome, NOT the flat string",
      confirm.reason === "gate killed by SIGKILL (possibly OOM/resource) — retried once, still failed");
    check("(B) gateDetail.signal is SIGKILL", confirm.gateDetail?.signal === "SIGKILL");
    check("(B) gateDetail.timedOut is false (an external kill, not our own bound)", confirm.gateDetail?.timedOut === false);
    const rejectMsgs = enqueued.filter((args) => args[0] === B.mgrId && typeof args[1] === "string" && args[1].includes("[loom:merge-rejected]"));
    check("(B) exactly ONE [loom:merge-rejected] signal fired", rejectMsgs.length === 1);
    check("(B) signal text carries the same classification wording", rejectMsgs[0][1].includes("gate killed by SIGKILL (possibly OOM/resource) — retried once, still failed"));
    check("(B) signal text names the retry attempt in the detail bits", rejectMsgs[0][1].includes(`retried once (settled ${GATE_RETRY_SETTLE_MS}ms)`));
    check("(B) exactly ONE merge_rejected event, with killClass:'kill' + retried:true", (() => {
      const evs = eventsOfKind(db, B.mgrId, "merge_rejected");
      return evs.length === 1 && evs[0].detail?.killClass === "kill" && evs[0].detail?.retried === true;
    })());
    check("(B) worktree RETAINED (fail-closed)", fs.existsSync(B.worktreePath));
    check("(B) task NOT moved to done", db.getTask(B.taskId).columnKey !== "done");
  }

  // ── (B2) A NON-OOM SIGNAL NEVER GETS THE OOM HINT — CR follow-up on bcba83a1 ────────────────────────
  // A deterministic in-process crash (e.g. SIGSEGV/SIGABRT from a broken native addon) is retry-eligible
  // (it's still an external signal, not a clean exit) but must NOT be mislabeled "likely OOM" — that would
  // misdirect a manager diagnosing a real crash. The hint is SIGKILL-only.
  {
    const B2 = mk("b2", "feature-b2.txt");
    makeRepo(B2);
    const db = new Db(); dbs.push(db);
    const enqueued = [];
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin(...args) { enqueued.push(args); } };
    const fakeGate = async () => ({ passed: false, failedStep: "pnpm gate", failedStatus: null, failedSignal: "SIGSEGV", failedTimedOut: false, outputTail: "" });
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(B2.repo, B2.projId, B2.taskId);
    B2.worktreePath = worktreePath; B2.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, B2.file), "work for B2\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${B2.file}"`, { cwd: worktreePath });
    seed(db, B2, "pnpm gate");

    const confirm = await sessions.confirmWorkerMerge(B2.mgrId, B2.workerId);
    check("(B2) reason names the ACTUAL signal (SIGSEGV), still retry-eligible/classified 'kill'",
      confirm.reason === "gate killed by SIGSEGV — retried once, still failed");
    check("(B2) reason does NOT assert '(possibly OOM/resource)' for a non-SIGKILL signal", !confirm.reason.includes("OOM"));
  }

  // ── (C) OUR OWN GATE-TIMEOUT, RETRY STILL FAILS — distinct wording ──────────────────────────────────
  {
    const C = mk("c", "feature-c.txt");
    makeRepo(C);
    const db = new Db(); dbs.push(db);
    const enqueued = [];
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin(...args) { enqueued.push(args); } };
    let calls = 0;
    const fakeGate = async () => { calls++; return { passed: false, failedStep: "pnpm gate", failedStatus: null, failedSignal: "SIGKILL", failedTimedOut: true, outputTail: "" }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(C.repo, C.projId, C.taskId);
    C.worktreePath = worktreePath; C.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, C.file), "work for C\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${C.file}"`, { cwd: worktreePath });
    seed(db, C, "pnpm gate");

    const confirm = await sessions.confirmWorkerMerge(C.mgrId, C.workerId);
    check("(C) exactly 2 gate calls (our-timeout is retry-eligible too, bounded to one retry)", calls === 2);
    check("(C) reason names the daemon's-own-timeout classification distinctly from the OOM wording",
      confirm.reason === "gate timed out (possibly resource-starved under load) — retried once, still failed");
    check("(C) gateDetail.timedOut is true", confirm.gateDetail?.timedOut === true);
    check("(C) exactly ONE merge_rejected event, with killClass:'timeout'", (() => {
      const evs = eventsOfKind(db, C.mgrId, "merge_rejected");
      return evs.length === 1 && evs[0].detail?.killClass === "timeout";
    })());
  }

  // ── (D) GENUINE FAILURE NEVER RETRIES ───────────────────────────────────────────────────────────────
  {
    const D = mk("d", "feature-d.txt");
    makeRepo(D);
    const db = new Db(); dbs.push(db);
    const enqueued = [];
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin(...args) { enqueued.push(args); } };
    let calls = 0;
    const fakeGate = async () => { calls++; return { passed: false, failedStep: "pnpm gate", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "AssertionError: expected 1 to equal 2" }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(D.repo, D.projId, D.taskId);
    D.worktreePath = worktreePath; D.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, D.file), "work for D\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${D.file}"`, { cwd: worktreePath });
    seed(db, D, "pnpm gate");

    const confirm = await sessions.confirmWorkerMerge(D.mgrId, D.workerId);
    check("(D) exactly ONE gate call — a genuine clean non-zero exit is NEVER retried", calls === 1);
    check("(D) reason stays the flat back-compat string (unchanged for a real test/build failure)", confirm.reason === "build gate failed");
    check("(D) NO build_gate_retry_attempt event fired for a genuine failure", eventsOfKind(db, D.mgrId, "build_gate_retry_attempt").length === 0);
    check("(D) merge_rejected carries killClass:'genuine', retried:false", (() => {
      const evs = eventsOfKind(db, D.mgrId, "merge_rejected");
      return evs.length === 1 && evs[0].detail?.killClass === "genuine" && evs[0].detail?.retried === false;
    })());
  }

  // ── (F) BUDGET-EXCEEDED SHORT-CIRCUIT (card 73a847f5) — a timeout that already consumed its ONE ─────
  // auto-extend cannot pass a hard-bounded (`allowExtend:false`) rerun, so the retry is skipped entirely
  // instead of burning a second full gate run to reach a foregone conclusion. Distinguishes this from (C)
  // above (a timeout that never got to extend still DOES retry) and from (A)/(B) (a "kill" classification
  // is untouched regardless of `anyExtended`) — this is the third, load-bearing arm: without it, a change
  // that broke the retry outright (rather than just skipping the futile case) would look identical to this
  // test passing.
  {
    const F = mk("f", "feature-f.txt");
    makeRepo(F);
    const db = new Db(); dbs.push(db);
    const enqueued = [];
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin(...args) { enqueued.push(args); } };
    let calls = 0;
    const fakeGate = async (...args) => {
      calls++;
      const hooks = args[7];
      hooks?.onExtend?.(); // this (first and only) attempt already consumed its one auto-extend
      return { passed: false, failedStep: "pnpm gate", failedStatus: null, failedSignal: null, failedTimedOut: true, outputTail: "" };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { worktreePath, branch } = await createWorktree(F.repo, F.projId, F.taskId);
    F.worktreePath = worktreePath; F.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, F.file), "work for F\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${F.file}"`, { cwd: worktreePath });
    seed(db, F, "pnpm gate");

    const confirm = await sessions.confirmWorkerMerge(F.mgrId, F.workerId);
    check("(F) exactly ONE gate call — a timeout that already extended never gets a retry", calls === 1);
    check("(F) merged:false", confirm.merged === false);
    check("(F) reason reports budget-exceeded, not a generic 'gate timed out' / 'build gate failed'",
      confirm.reason.includes("gate exceeded its timeout budget"));
    check("(F) reason names WHICH retry (internal/automatic/post-timeout) rather than a bare 'the retry is futile'",
      confirm.reason.includes("internal post-timeout retry"));
    check("(F) reason states a manager re-fire of worker_merge_confirm is unaffected",
      confirm.reason.includes("worker_merge_confirm") && /unaffected/i.test(confirm.reason));
    check("(F) NO build_gate_retry_attempt event fired — the retry itself never ran", eventsOfKind(db, F.mgrId, "build_gate_retry_attempt").length === 0);
    check("(F) NO build_gate_retry event fired", eventsOfKind(db, F.mgrId, "build_gate_retry").length === 0);
    check("(F) merge_rejected carries killClass:'timeout', retried:false, retrySkippedFutile:true", (() => {
      const evs = eventsOfKind(db, F.mgrId, "merge_rejected");
      return evs.length === 1 && evs[0].detail?.killClass === "timeout" && evs[0].detail?.retried === false && evs[0].detail?.retrySkippedFutile === true;
    })());
    check("(F) worktree RETAINED (fail-closed)", fs.existsSync(F.worktreePath));
    check("(F) task NOT moved to done", db.getTask(F.taskId).columnKey !== "done");
  }

  // ── (G) CANCELLING THE TRANSIENT-KILL RETRY'S OWN QUEUED ADMISSION — see this file's own header for the
  //        summary. Mirrors merge-gate-single-file-retry.mjs's own (H) block for the SIBLING retry
  //        mechanism, incl. its ordering guarantee: worker G's own first attempt is held open until AFTER
  //        the holder has fired and is confirmed QUEUED, so `GateSemaphore.release()`'s synchronous
  //        `grantNext()` deterministically hands the freed cap-1 slot to the already-queued holder, forcing
  //        the retry's own fresh admission (after its settle delay) to queue instead of running
  //        immediately — no race. ──
  {
    const G = mk("g", "feature-g1.txt");
    makeRepo(G);
    const db = new Db(); dbs.push(db);
    db.setPlatformConfig({ maxConcurrentGates: 1 });

    let call1AdmittedResolve;
    const call1Admitted = new Promise((res) => { call1AdmittedResolve = res; });
    let releaseCall1;
    let holderAdmittedResolve;
    const holderAdmitted = new Promise((res) => { holderAdmittedResolve = res; });
    let releaseHolder;
    // Scoped to worker G's OWN worktree only (mirrors merge-gate-single-file-retry.mjs's `callsForH`) —
    // the proof that the retry's gate command never spawns a second time once its admission is cancelled.
    let callsForG = 0;
    const sharedGate = async (_gate, cwd) => {
      if (cwd === G.worktreePath) {
        callsForG++;
        call1AdmittedResolve();
        await new Promise((res) => { releaseCall1 = res; });
        // A KILL classification (retry-eligible, never "genuine") — the TRANSIENT-KILL retry, not the
        // single-file retry, is what fires next.
        return { passed: false, failedStep: "pnpm gate", failedStatus: null, failedSignal: "SIGKILL", failedTimedOut: false, outputTail: "" };
      }
      // The holder's own gate — held open once admitted so it keeps occupying the cap-1 slot long enough
      // for the retry's own admission to genuinely queue behind it and be observed/cancelled.
      holderAdmittedResolve();
      await new Promise((res) => { releaseHolder = res; });
      return { passed: true };
    };
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: sharedGate });

    db.insertProject({ id: G.projId, name: "MGR-G", repoPath: G.repo, vaultPath: G.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: G.agentId, projectId: G.projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: G.taskId, projectId: G.projId, title: "MGR-G-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: G.mgrId, projectId: G.projId, agentId: G.agentId, engineSessionId: null, title: null, cwd: G.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const { worktreePath, branch } = await createWorktree(G.repo, G.projId, G.taskId);
    G.worktreePath = worktreePath; G.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, G.file), "work for g\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${G.file}"`, { cwd: worktreePath });
    db.insertSession({ id: G.workerId, projectId: G.projId, agentId: G.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: G.mgrId, taskId: G.taskId, worktreePath, branch });

    // A SEPARATE, unrelated project/worker to occupy the cap-1 slot once it frees — mirrors gate-cancel.mjs
    // B2-2's own holder setup exactly.
    const holderRepo = path.join(os.tmpdir(), `loom-mgr-g-holder-${sfx}`);
    const holderProjId = `mgr-g-holder-proj-${sfx}`, holderAgentId = `mgr-g-holder-agent-${sfx}`;
    const holderTaskId = `mgr-g-holder-task-${sfx}`, holderWorkerId = `mgr-g-holder-wkr-${sfx}`;
    makeRepo({ repo: holderRepo });
    db.insertProject({ id: holderProjId, name: "MGR-G-HOLDER", repoPath: holderRepo, vaultPath: holderRepo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: holderAgentId, projectId: holderProjId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: holderTaskId, projectId: holderProjId, title: "MGR-G-HOLDER-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    const wtHolder = await createWorktree(holderRepo, holderProjId, holderTaskId);
    worktrees.push(wtHolder.worktreePath);
    fs.writeFileSync(path.join(wtHolder.worktreePath, "holder.txt"), "holder\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "holder.txt"`, { cwd: wtHolder.worktreePath });
    const holderMgrId = `${holderWorkerId}-mgr`;
    db.insertSession({ id: holderMgrId, projectId: holderProjId, agentId: holderAgentId, engineSessionId: null, title: null, cwd: holderRepo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db.insertSession({ id: holderWorkerId, projectId: holderProjId, agentId: holderAgentId, engineSessionId: null, title: null, cwd: wtHolder.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: holderMgrId, taskId: holderTaskId, worktreePath: wtHolder.worktreePath, branch: wtHolder.branch });

    // 1) Worker G's first attempt admits (cap 1, nothing else contending yet) and blocks mid-run.
    const p1 = sessions.confirmWorkerMerge(G.mgrId, G.workerId);
    await call1Admitted;

    // 2) The holder fires NOW, while worker G's first attempt still occupies the cap-1 slot — it QUEUES.
    const pHolder = sessions.confirmWorkerMerge(holderMgrId, holderWorkerId);
    const holderQueued = await waitUntil(() => sessions.gateQueueForManager(holderProjId).queued.find((e) => e.gateType === "merge"));
    check("(G) the holder is genuinely QUEUED behind worker G's first attempt (setup sanity)", !!holderQueued);

    // 3) Release worker G's first attempt to fail for real (a KILL classification) — its slot frees, and
    //    the ALREADY-QUEUED holder deterministically wins it, forcing the transient-kill retry's own fresh
    //    admission (after its settle delay) to queue instead of running immediately.
    releaseCall1("go");
    await holderAdmitted;
    const retryEntry = await waitUntil(() => sessions.gateQueueForManager(G.projId).queued.find((e) => e.gateType === "merge"));
    check("(G) the transient-kill retry's OWN admission is genuinely QUEUED (setup sanity)", !!retryEntry);

    if (retryEntry) {
      const cancelResult = await sessions.cancelGateOp(G.mgrId, retryEntry.opId);
      check("(G) cancelling the retry's QUEUED admission SUCCEEDS", cancelResult.outcome === "cancelled" && cancelResult.phase === "queued" && cancelResult.gateType === "merge");

      const confirmG = await p1;
      check("(G) confirmWorkerMerge settles cleanly with cancelled:true, never a thrown/misreported crash", confirmG.merged === false && confirmG.cancelled === true);
      check("(G) the cancel is tagged 'manual' (gate_cancel, not an automatic supersede)", confirmG.cancelKind === "manual");
      const mergeCancelledEvts = eventsOfKind(db, G.mgrId, "merge_cancelled");
      check("(G) a merge_cancelled event was recorded (never a merge_rejected/merge-failed shape)", mergeCancelledEvts.length === 1 && mergeCancelledEvts[0].detail?.cancelKind === "manual");

      // ── CARD 518e7ff6 — THE ASYMMETRY THIS CARD FIXES: attempt 1's OWN `build_gate` row was ALREADY
      //    written (unconditionally, BEFORE this retry block even starts) by the time the retry's own
      //    admission is cancelled — unlike the sibling single-file-retry path, there is nothing missing to
      //    fill in on THAT row: it stays a real, unmodified `outcome:"reject"`. ──
      const buildGateEvts = eventsOfKind(db, G.mgrId, "build_gate");
      check("(G) attempt 1's real (kill) failure is recorded, UNCHANGED, as its own build_gate row (passed:false, no cancelled stamp)",
        buildGateEvts.length === 1 && buildGateEvts[0].detail?.passed === false && buildGateEvts[0].detail?.cancelled === undefined);

      // ── POSITIVE CONTROL (DoD-4): the MISSING half — a build_gate_retry row recording that the retry
      //    itself never reached a verdict, stamped so it's distinguishable from a genuine rejection. Before
      //    this card, cancelling this retry left NO build_gate_retry row at all — only the merge_cancelled
      //    event above (excluded from GATE_HISTORY_KINDS) was recorded, and attempt 1's lone "reject" row
      //    was the only thing gate_history ever showed for this op. ──
      const buildGateRetryEvts = eventsOfKind(db, G.mgrId, "build_gate_retry");
      check("(G) the retry's own fate is now recorded as a build_gate_retry row instead of vanishing entirely", buildGateRetryEvts.length === 1);
      check("(G) that row is stamped cancelled:true — distinguishable from a genuine rejection", buildGateRetryEvts[0]?.detail?.cancelled === true);
      check("(G) it is stamped gateSpawned:false — this retry's own admission never ran a process", buildGateRetryEvts[0]?.detail?.gateSpawned === false);
      check("(G) it carries no fabricated passed verdict — the retry never ran to a verdict", !("passed" in (buildGateRetryEvts[0]?.detail ?? {})));
      check("(G) the real gate_history read (listGateEvents/toGateHistoryRow) surfaces BOTH rows for this op: attempt 1 as outcome:'reject' (gateRan:true), the retry as outcome:'cancelled' (gateRan:false) — never a lone reject", (() => {
        const page = db.listGateEvents({ projectId: G.projId, limit: 100, offset: 0 });
        const rows = page.items.filter((r) => r.gateType === "merge" && r.sessionId === G.workerId);
        const rejectRow = rows.find((r) => r.outcome === "reject");
        const cancelledRow = rows.find((r) => r.outcome === "cancelled");
        return rows.length === 2 && !!rejectRow && rejectRow.gateRan === true && !!cancelledRow && cancelledRow.gateRan === false;
      })());

      // Let the holder's own gate proceed and settle — cleanup hygiene, not itself asserted on.
      releaseHolder("go");
      const holderResult = await pHolder;
      check("(G) the holder itself merged normally once it won the freed slot", holderResult.merged === true);
      check("(G) the retry's OWN gate command never actually spawned — cancelled while queued, before admission (fn never invoked a second time for a withdrawn admission)", callsForG === 1);
    } else {
      // SETUP SANITY FAILED: release the holder and let both confirms settle BEFORE moving on, instead of
      // leaving `p1`/`pHolder` dangling (mirrors merge-gate-single-file-retry.mjs's own (H) fallback).
      console.log("SKIP  (G) cancel/settle assertions — setup sanity check above already failed");
      releaseHolder("go");
      await Promise.allSettled([p1, pHolder]);
    }
  }

  // ── (E) INJECTION HYGIENE END-TO-END — REAL gate step, real runGateSequential, no injected runGate ──
  {
    const E = mk("e", "feature-e.txt");
    // A real failing step whose stderr carries ANSI color + a literal bracketed-paste terminator, mirroring
    // a colorized test reporter's output — exercises the REAL (non-injected) production sanitization path.
    const RUN_TESTS_SCRIPT = [
      "console.log('running suite...');",
      "process.stderr.write('\\u001b[31mFAIL widget.spec.js > renders correctly\\u001b[0m\\n');",
      "process.stderr.write('AssertionError: expected 2 to equal 3\\u001b[201~echo pwned\\u001b[201~\\n');",
      "process.exit(1);",
    ].join("\n");
    fs.mkdirSync(E.repo, { recursive: true });
    registerForCleanup(E.repo); // bare origin repo — never cleaned by the worktrees[]/LOOM_HOME sweep below
    fs.writeFileSync(path.join(E.repo, "README.md"), "# mgr\n");
    fs.writeFileSync(path.join(E.repo, "run-tests.mjs"), RUN_TESTS_SCRIPT);
    execSync(`git init -q && git config user.email mgr@loom && git config user.name mgr && git add . && git ${GIT_ID} commit -q -m init`, { cwd: E.repo });
    const db = new Db(); dbs.push(db);
    const enqueued = [];
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin(...args) { enqueued.push(args); } };
    // NO runGate override here — this is the real production spawn path (real runGateSequential).
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl());
    const { worktreePath, branch } = await createWorktree(E.repo, E.projId, E.taskId);
    E.worktreePath = worktreePath; E.branch = branch; worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, E.file), "work for E\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "${E.file}"`, { cwd: worktreePath });
    seed(db, E, "node run-tests.mjs");

    const confirm = await sessions.confirmWorkerMerge(E.mgrId, E.workerId);
    check("(E) rejected (genuine failure, real exit 1)", confirm.merged === false && confirm.reason === "build gate failed");
    check("(E) sync gateDetail.stderrTail carries no raw ESC byte", !(confirm.gateDetail?.stderrTail ?? "").includes("\x1b"));
    check("(E) sync gateDetail.stderrTail still carries the real assertion text", (confirm.gateDetail?.stderrTail ?? "").includes("AssertionError: expected 2 to equal 3"));
    check("(E) sync gateDetail.stderrTail neutralizes the bracketed-paste terminator to inert text", (confirm.gateDetail?.stderrTail ?? "").includes("[201~echo pwned[201~"));
    const rejectMsgs = enqueued.filter((args) => args[0] === E.mgrId && typeof args[1] === "string" && args[1].includes("[loom:merge-rejected]"));
    check("(E) exactly ONE [loom:merge-rejected] signal fired", rejectMsgs.length === 1);
    check("(E) the pty text carries no raw ESC byte anywhere", !rejectMsgs[0][1].includes("\x1b"));
    check("(E) the pty text still names the failing test", rejectMsgs[0][1].includes("FAIL widget.spec.js"));
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) cleanupPathSync(wt);
  cleanupPathSync(process.env.LOOM_HOME);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a transient-kill classification (an OOM/SIGKILL, or the daemon's own gate timeout) is auto-retried ONCE and absorbed silently on a pass, reported with distinct classification wording on a still-failing retry, a genuine non-zero exit is NEVER retried and keeps the flat back-compat string, a timeout that already consumed its one auto-extend gets ZERO retry attempts and a distinct budget-exceeded report instead, and a real gate step's ANSI/bracketed-paste-terminator output never reaches the manager's pty with a raw ESC byte."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
