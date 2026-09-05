import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// BATCH GATE MULTI-FILE RETRY (Code Review, card 67030bb9 — the card's own PRIMARY gap: before this
// round, `identifyRetriableTestFiles` had exactly one call site (the solo `confirmWorkerMerge` path) and
// `mergeBatchTracked`'s own batch gate had ZERO test coverage of its new retry logic — confirmed by grep
// before this file existed: batch-merge-gate-history.mjs/merge-batch-completion-notice.mjs/
// pending-gate-ops.mjs never touch `retriedFile`/`retryPassed`/`retryDeclineReason`). HERMETIC, no daemon
// — combines batch-merge-gate-history.mjs's REAL git assembly (two real worker branches cherry-picked
// into a real batch worktree) with merge-gate-single-file-retry.mjs's INJECTED `runGate` seam (this
// daemon's own test suite is far too heavy to actually spawn here) — made possible by finding [4]'s own
// fix: `mergeBatchTracked` now resolves gate calls via `this.runGate ?? runGateSequential`, the SAME
// injectable seam every other merge-gate call site in sessions/service.ts already used.
//
// Proves (finding [4]'s own five-case DoD):
//   (i)/(ii) PASS AFTER RETRY — a genuine batch gate failure identifying ONE retriable file fires the
//       retry with the real `--only=<name>` re-invocation; a resulting pass lands the batch (BOTH
//       branches), stamps `retriedFile`/`retryPassed:true` on the durable `build_gate` gate_history row,
//       and `MergeBatchResult.retryWarning` carries the BATCH clause naming `landed.length` (not the
//       solo wording) — and `durationMs` on that same row is bounded to attempt 1's own run, NEVER
//       inflated by the retry's own (separately admitted, deliberately slower) run (finding [1]).
//   (iii) is NOT separately re-tested here: the `[loom:merge-batch-done]` async nudge (sessions/
//       service.ts) renders this SAME `MergeBatchResult.retryWarning` string verbatim (string-
//       concatenated, no separate computation) — proving (ii)'s `retryWarning` field is correct proves
//       the nudge's own text is correct too, since both read the identical field. Forcing the genuine
//       async-degrade path deterministically would need real host-timing contention (the codebase's own
//       docs on this path call whether it degrades "a coin flip on real host timing") — not a reliable
//       thing to assert on in CI, so this leans on the shared-field argument instead of a flaky repro.
//   (iv) FAIL AFTER RETRY — the retry ALSO fails: the whole batch rejects, `retryPassed:false` is
//       recorded (never silently dropped), and attempt 1's OWN diagnosis (`failingTest`) survives on the
//       rejected row — never overwritten by the retry's own (different) failure.
//   (v) THE RETRY'S OWN ADMISSION CANCELLED WHILE QUEUED — forces a real `GateCancelledError` through the
//       retry's own (second, separately-queued) admission, deterministically: a holder is queued for the
//       ONE gate slot WHILE attempt 1 still occupies it (synchronously, inside the fakeGate call itself —
//       see the JSDoc on `seizeSlotBehindAttempt1` below for why this beats the retry's own not-yet-issued
//       admission to the freed slot without any timing race). Proves finding [2]: the cancelled-while-
//       queued `build_gate` event now stamps `durationMs`/`gateSpawned:true` — `gate_history.gateRan`
//       (db.ts's `gateRanFromDetail`) must read `true`, not the pre-fix `false` (a well-formed POSITIVE
//       assertion that no gate ever ran, when attempt 1 genuinely ran a full batch gate and failed).
//   (vi) BONUS — a genuine batch gate failure whose failure does NOT name an identifiable file (a
//       Jest-style path, refused by the bare-identifier guard): `retryDeclineReason` (finding [3]) is
//       recorded on the SAME row as `"unparseable-name"`, mutually exclusive with `retriedFile` — the
//       ONE thing that used to make a decline permanently unexplainable from `gate_history` alone.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/batch-merge-gate-retry.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { waitUntil } from "./_wait.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-bmgr-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=bmgr@loom -c user.name=bmgr";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# bmgr\n");
  execSync(`git init -q && git config user.email bmgr@loom && git config user.name bmgr`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

async function cutBranch(repo, projId, label, file, content) {
  const taskId = `bmgr-task-${label}-${sfx}`;
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(worktreePath, file), content);
  commitAll(worktreePath, `${label}`, GIT_ID);
  return { taskId, branch, worktreePath };
}

// Plants the two files `identifyRetriableTestFiles` looks for, relative to the BATCH worktree root (the
// worktree the injected gate actually receives as its own second arg) — mirrors merge-gate-single-file-
// retry.mjs's `plantTestFile`, applied lazily inside the fakeGate itself since the batch worktree doesn't
// exist yet when the test starts (mergeBatchTracked cuts it internally).
function plantTestFile(worktreePath, name) {
  fs.mkdirSync(path.join(worktreePath, "packages", "daemon", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "scripts", "test-daemon.mjs"), "// stub\n");
  fs.mkdirSync(path.join(worktreePath, "packages", "daemon", "test"), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", `${name}.mjs`), "// stub\n");
}

function setupBatchProject(label, gateCommand) {
  const projId = `bmgr-${label}-proj-${sfx}`, agentId = `bmgr-${label}-agent-${sfx}`, mgrId = `bmgr-${label}-mgr-${sfx}`;
  const repo = path.join(os.tmpdir(), `loom-bmgr-${label}-${sfx}`);
  return { projId, agentId, mgrId, repo, gateCommand };
}

async function seedTwoWorkers(db, P) {
  makeRepo(P.repo);
  db.insertProject({ id: P.projId, name: `BMGR-${P.projId}`, repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: P.gateCommand } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: P.agentId, projectId: P.projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const a = await cutBranch(P.repo, P.projId, `${P.projId}-a`, "feature-a.txt", "work a\n");
  const b = await cutBranch(P.repo, P.projId, `${P.projId}-b`, "feature-b.txt", "work b\n");
  const wA = `${P.projId}-wkr-a`, wB = `${P.projId}-wkr-b`;
  for (const [wId, w] of [[wA, a], [wB, b]]) {
    db.insertTask({ id: w.taskId, projectId: P.projId, title: `feat(test): ${w.taskId}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: wId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
  }
  return { wA, wB, worktrees: [a.worktreePath, b.worktreePath] };
}

// Resolve a settled MergeBatchResult, tolerating the documented sync-vs-async-degrade split
// (mergeBatchTracked -> PendingOpRegistry.attach) the same way batch-merge-gate-history.mjs already does.
async function resolveBatch(sessions, batchPromise) {
  const r = await batchPromise;
  if (!r.settled) {
    await waitUntil(() => sessions.gateStatus(r.op.opId).state === "settled",
      { timeoutMs: 60_000, label: "batch op to settle asynchronously (missed the sync-wait budget)" });
    return { settled: true, ok: undefined, value: undefined, opId: r.op.opId };
  }
  return { settled: true, ok: r.ok, value: r.ok ? r.value : undefined, opId: r.op?.opId };
}

const dbs = [];
const worktrees = [];
try {
  // ── (i)/(ii) PASS AFTER RETRY ──────────────────────────────────────────────────────────────────────────
  {
    const P = setupBatchProject("pass", "pnpm gate");
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const seenGates = [];
    const fakeGate = async (gate, worktreePath) => {
      calls++; seenGates.push(gate);
      if (calls === 1) {
        plantTestFile(worktreePath, "flaky-batch-pass");
        return { passed: false, failedStep: "pnpm gate", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "", failingTest: "FAIL  flaky-batch-pass", failingTestCount: 1, failTierTest: "FAIL  flaky-batch-pass", failTierTestCount: 1, failTierAll: ["FAIL  flaky-batch-pass"] };
      }
      // Deliberate delay on ONLY the retry's own run — the discriminating instrument for finding [1]:
      // pre-fix, `build_gate.durationMs` was computed AFTER this delay (`Date.now() - gateStartedAt` at
      // the settle point), so it would have absorbed this sleep into attempt 1's own reported duration.
      await sleep(300);
      return { passed: true };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { wA, wB, worktrees: wts } = await seedTwoWorkers(db, P);
    worktrees.push(...wts);

    const outcome = await resolveBatch(sessions, sessions.mergeBatchTracked(P.mgrId, [wA, wB]));
    check("(i) exactly 2 gate calls (attempt 1 genuine failure, one multi-file retry, never looped)", calls === 2);
    check("(i) the retry call is the real --only= single-file re-invocation", seenGates[1] === "node packages/daemon/scripts/test-daemon.mjs --only=flaky-batch-pass");
    if (outcome.value) {
      check("(ii) ok:true, both branches landed", outcome.value.ok === true && outcome.value.landed.length === 2);
      check("(ii) retriedFile/retryPassed:true on the returned MergeBatchResult", outcome.value.retriedFile === "flaky-batch-pass" && outcome.value.retryPassed === true);
      check("(ii) retryWarning carries the BATCH clause naming landed.length (2), not just the solo wording", typeof outcome.value.retryWarning === "string" && outcome.value.retryWarning.includes("BATCH of 2 branch(es)"));
    } else {
      console.log("(i)/(ii) NOTE: settled via the async degrade path — MergeBatchResult is not recoverable that way; skipping the 3 return-value assertions above. Every DB-derived check below is unconditional and still runs.");
    }

    const page = db.listGateEvents({ projectId: P.projId, limit: 50, offset: 0 });
    const row = page.items.find((r) => r.branch === null);
    check("(i) a build_gate row exists for the batch op (branch:null, filed under the manager)", !!row);
    check("(i) the row passed, batched:true, branchCount:2", row?.passed === true && row?.batched === true && row?.branchCount === 2);
    check("(i) the row carries retriedFile/retryPassed:true", row?.retriedFile === "flaky-batch-pass" && row?.retryPassed === true);
    check("(i) retryDeclineReason is null on an IDENTIFIED (not declined) retry — mutually exclusive with retriedFile", row?.retryDeclineReason === null);
    // THE DISCRIMINATING ASSERTION for finding [1]: gate_status's totalDurationMs (mint -> settle, covers
    // the retry's own 300ms sleep) must be MEASURABLY larger than durationMs (attempt-1-bounded) — proving
    // the retry's own slower run never got folded into durationMs. A margin of 150ms is comfortably below
    // the real 300ms sleep and comfortably above ordinary git/assembly overhead on a healthy host.
    const st = row?.opId ? sessions.gateStatus(row.opId) : undefined;
    check("(i) finding [1]: durationMs is a real, non-null number", typeof row?.durationMs === "number");
    check("(i) finding [1]: gate_status carries a real totalDurationMs for the same op", typeof st?.totalDurationMs === "number");
    check("(i) finding [1] THE FIX, PROVEN: totalDurationMs exceeds durationMs by at least 150ms — the retry's OWN 300ms delay is captured in the broader total span but NOT folded into the attempt-1-bounded durationMs (pre-fix this gap would have been near zero, since durationMs used to be computed AFTER the retry too)",
      typeof st?.totalDurationMs === "number" && typeof row?.durationMs === "number" && (st.totalDurationMs - row.durationMs) >= 150);
    check("(ii) gate_status's own retryWarning ALSO carries the batch clause (finding [5]: batchBranchCount now persists on the verdict payload, not just the live nudge)", typeof st?.retryWarning === "string" && st.retryWarning.includes("BATCH of 2 branch(es)"));
    check("(ii) gate_status surfaces batchBranchCount:2 directly", st?.batchBranchCount === 2);
  }

  // ── (iv) FAIL AFTER RETRY — the retry ALSO fails ───────────────────────────────────────────────────────
  {
    const P = setupBatchProject("fail", "pnpm gate");
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const seenGates = [];
    const fakeGate = async (gate, worktreePath) => {
      calls++; seenGates.push(gate);
      if (calls === 1) {
        plantTestFile(worktreePath, "flaky-batch-fail");
        return { passed: false, failedStep: "pnpm gate", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "", failingTest: "FAIL  flaky-batch-fail", failingTestCount: 1, failTierTest: "FAIL  flaky-batch-fail", failTierTestCount: 1, failTierAll: ["FAIL  flaky-batch-fail"] };
      }
      if (calls === 2) return { passed: false, failedStep: "pnpm gate", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "retry also failed", failingTest: "FAIL  flaky-batch-fail", failingTestCount: 1, failTierTest: "FAIL  flaky-batch-fail", failTierTestCount: 1, failTierAll: ["FAIL  flaky-batch-fail"] };
      // Calls 3+ are the red batch's own per-candidate fallback (confirmWorkerMergeTracked re-gating each
      // worker SOLO) — no failTierAll, so identifyRetriableTestFiles declines (no-fail-tier-match) and
      // each solo confirm just rejects cleanly, exactly like a project with no retry mechanism at all.
      return { passed: false, failedStep: "pnpm gate", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "fallback also failed", failingTest: "boom" };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { wA, wB, worktrees: wts } = await seedTwoWorkers(db, P);
    worktrees.push(...wts);

    const outcome = await resolveBatch(sessions, sessions.mergeBatchTracked(P.mgrId, [wA, wB]));
    check("(iv) exactly 2 gate calls to the BATCH gate itself (attempt 1 + the one multi-file retry) before any fallback call", seenGates[0] === "pnpm gate" && seenGates[1] === "node packages/daemon/scripts/test-daemon.mjs --only=flaky-batch-fail");
    if (outcome.value) {
      check("(iv) ok:false — the whole batch falls back on a retry that ALSO failed", outcome.value.ok === false);
      check("(iv) retriedFile/retryPassed:false surfaced on the returned MergeBatchResult — a retry that also failed is still recorded, never silently dropped", outcome.value.retriedFile === "flaky-batch-fail" && outcome.value.retryPassed === false);
    } else {
      console.log("(iv) NOTE: settled via the async degrade path — MergeBatchResult is not recoverable that way; skipping the 2 return-value assertions above.");
    }

    const page = db.listGateEvents({ projectId: P.projId, limit: 50, offset: 0 });
    const row = page.items.find((r) => r.branch === null);
    check("(iv) a build_gate row exists for the batch op", !!row);
    check("(iv) the row failed", row?.passed === false);
    check("(iv) retriedFile/retryPassed:false recorded on the rejected row", row?.retriedFile === "flaky-batch-fail" && row?.retryPassed === false);
    check("(iv) attempt 1's OWN diagnosis (failingTest) survives the rejection — never overwritten by the retry's own (differently-worded) failure", typeof row?.failingTest === "string" && row.failingTest.includes("flaky-batch-fail"));
  }

  // ── (v) THE RETRY'S OWN ADMISSION CANCELLED WHILE QUEUED ───────────────────────────────────────────────
  {
    const P = setupBatchProject("cancel", "pnpm gate");
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    let sessions; // referenced by fakeGate below (assigned right after construction, before any call fires)
    let releaseHolder;
    const holderPromise = new Promise((resolve) => { releaseHolder = resolve; });
    const fakeGate = async (gate, worktreePath) => {
      calls++;
      if (calls === 1) {
        plantTestFile(worktreePath, "flaky-batch-cancel");
        // Card 67030bb9 review, finding [2]'s own test rig: seize the ONE gate slot for a holder RIGHT
        // NOW, while attempt 1's own admission still occupies it (we are executing INSIDE attempt 1's own
        // runExclusive callback). `GateSemaphore.acquire` pushes a non-immediately-admittable waiter onto
        // its priority queue SYNCHRONOUSLY, before this call's own returned promise ever resolves (see
        // gate-semaphore.ts's `acquire`: the `new Promise((resolve) => { ...; queue.push(waiter); })`
        // executor body runs synchronously at construction time) — so by the time this function returns,
        // the holder is ALREADY queued, strictly BEFORE the retry below has even been considered, let
        // alone issued its own (later) admission request. When attempt 1 releases moments from now,
        // `release()` calls `grantNext()` synchronously and hands the freed slot to this already-queued
        // holder — deterministically, by FIFO/priority-tier ordering, never a race against the retry's
        // own not-yet-issued `runExclusive` call.
        sessions.gateSemaphore.runExclusive(1, { gateType: "merge", projectId: `${P.projId}-holder`, sessionId: "cancel-holder-sess" }, () => holderPromise, "high").catch(() => {});
        return { passed: false, failedStep: "pnpm gate", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "", failingTest: "FAIL  flaky-batch-cancel", failingTestCount: 1, failTierTest: "FAIL  flaky-batch-cancel", failTierTestCount: 1, failTierAll: ["FAIL  flaky-batch-cancel"] };
      }
      // Never actually reached for the retry — its own admission is cancelled while still queued, below.
      return { passed: true };
    };
    sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { wA, wB, worktrees: wts } = await seedTwoWorkers(db, P);
    worktrees.push(...wts);

    const batchPromise = sessions.mergeBatchTracked(P.mgrId, [wA, wB]);

    // Poll until the RETRY's own gate admission is genuinely queued behind the holder (deterministic per
    // the comment above — this loop is just how the test OBSERVES that already-deterministic outcome, not
    // how it produces it). Bounded so a real regression fails fast rather than hanging the suite.
    const queueDeadline = Date.now() + 20_000;
    let queuedEntry;
    while (Date.now() <= queueDeadline) {
      queuedEntry = sessions.gateSemaphore.snapshot().entries.find((e) => e.phase === "queued" && e.projectId === P.projId);
      if (queuedEntry) break;
      await sleep(5);
    }
    check("(v) precondition: the retry's own gate admission is genuinely queued behind the holder", !!queuedEntry);

    if (!queuedEntry) {
      releaseHolder();
      await batchPromise.catch(() => {});
    } else {
      const cancelOk = sessions.gateSemaphore.cancelQueued(queuedEntry.id, "manual", "test cancel of the batch retry's own queued admission");
      check("(v) cancelQueued accepts the queued retry admission", cancelOk === true);
      releaseHolder();

      const outcome = await resolveBatch(sessions, batchPromise);
      if (outcome.value) check("(v) ok:false — a cancelled retry can't land the batch", outcome.value.ok === false);

      const page = db.listGateEvents({ projectId: P.projId, limit: 50, offset: 0 });
      const row = page.items.find((r) => r.branch === null);
      check("(v) a build_gate row exists for the cancelled-retry op", !!row);
      check("(v) the row reads outcome:\"cancelled\"", row?.outcome === "cancelled");
      check("(v) retriedFile records that a retry WAS identified and attempted, even though it never ran to a verdict", row?.retriedFile === "flaky-batch-cancel");
      // THE DISCRIMINATING ASSERTION for finding [2]: pre-fix, this event carried neither `durationMs` nor
      // `gateSpawned`, so `gateRanFromDetail` (db.ts) resolved `gateRan:false` — a well-formed POSITIVE
      // assertion that no gate ever ran, when attempt 1 genuinely ran a full batch gate and failed.
      check("(v) finding [2] THE FIX, PROVEN: gate_history.gateRan reads true (attempt 1 genuinely ran a full batch gate) — pre-fix this read false", row?.gateRan === true);
      check("(v) finding [2]: durationMs is a real, non-null number (attempt 1's own real measured run time) — pre-fix this was null", typeof row?.durationMs === "number");
    }
  }

  // ── (vi) BONUS — a genuine failure that is NOT identifiable: retryDeclineReason recorded (finding [3]) ──
  {
    const P = setupBatchProject("decline", "pnpm gate");
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let calls = 0;
    const seenGates = [];
    const fakeGate = async (gate, worktreePath) => {
      calls++; seenGates.push(gate);
      if (calls === 1) {
        plantTestFile(worktreePath, "flaky-batch-decline"); // never referenced — the FAIL line below is unparseable
        // A Jest-style path-shaped FAIL line — refused by identifyRetriableTestFiles' own bare-identifier
        // guard (declineReason "unparseable-name"), the SAME fixture shape merge-gate-single-file-retry.mjs's
        // own (E) unit block already proves the function returns for, exercised here through the real
        // batch call site instead of calling the function directly.
        return { passed: false, failedStep: "pnpm gate", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "", failingTest: "FAIL src/foo.test.js", failingTestCount: 1, failTierTest: "FAIL src/foo.test.js", failTierTestCount: 1, failTierAll: ["FAIL src/foo.test.js"] };
      }
      // The red batch's own per-candidate fallback — no failTierAll, declines the same way, harmless.
      return { passed: false, failedStep: "pnpm gate", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "fallback also failed", failingTest: "boom" };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const { wA, wB, worktrees: wts } = await seedTwoWorkers(db, P);
    worktrees.push(...wts);

    await resolveBatch(sessions, sessions.mergeBatchTracked(P.mgrId, [wA, wB]));
    // Code Review round 2, minor #1: the PREVIOUS form of this check (`calls >= 1`) could never fail —
    // by the time it ran, `calls` was already 3 (the fallback's own per-candidate re-gates), so it proved
    // nothing about "never fires the retry". THIS asserts the actual claim: the very first call is the
    // plain batch gate command (never a `--only=` retry re-invocation), and NO recorded call — including
    // every fallback re-gate — is ever a `--only=` retry command, since the unidentifiable failure never
    // makes identifyRetriableTestFiles eligible on either call site.
    check("(vi) the first gate call is the plain batch command, never a --only= retry re-invocation", seenGates[0] === "pnpm gate");
    check("(vi) no --only= retry invocation EVER fired, across all calls (batch + fallback) — an unidentifiable failure never fires the retry", seenGates.every((g) => !g.includes("--only=")));

    const page = db.listGateEvents({ projectId: P.projId, limit: 50, offset: 0 });
    const row = page.items.find((r) => r.branch === null);
    check("(vi) a build_gate row exists for the batch op", !!row);
    check("(vi) retriedFile is null — the retry mechanism never engaged", row?.retriedFile === null);
    check("(vi) finding [3] THE FIX, PROVEN: retryDeclineReason records WHY (\"unparseable-name\") — pre-fix this was never persisted anywhere, on either call site", row?.retryDeclineReason === "unparseable-name");
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — mergeBatchTracked's own bounded multi-file retry (card 67030bb9) fires on a genuine identifiable batch gate failure, lands the WHOLE batch on a retry-assisted pass with the batch-specific weaker-pass wording (both on the sync return and on gate_status, and durationMs stays bounded to attempt 1's own run), records retryPassed:false without erasing attempt 1's own diagnosis when the retry ALSO fails, correctly reports gateRan:true/a real durationMs when the retry's own admission is cancelled while queued, and records WHY when the retry mechanism was never eligible to begin with."
  : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
