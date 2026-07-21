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
// Run: 1) build daemon (pnpm build), 2) node test/merge-gate-retry.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mgr-home-${Date.now()}`);
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
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a transient-kill classification (an OOM/SIGKILL, or the daemon's own gate timeout) is auto-retried ONCE and absorbed silently on a pass, reported with distinct classification wording on a still-failing retry, a genuine non-zero exit is NEVER retried and keeps the flat back-compat string, and a real gate step's ANSI/bracketed-paste-terminator output never reaches the manager's pty with a raw ESC byte."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
