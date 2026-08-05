import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Merge-gate SINGLE-FILE RETRY test (card 344ce950 — the single largest MEASURED waste in the merge
// pipeline: mgr #127's gate_history read, n=14, found 5 of the last 14 merge-gate runs REJECTED, all five
// followed by a PASS on the same branch, each costing a full ~12-18min second run of the whole suite).
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
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-gate-single-file-retry.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

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
