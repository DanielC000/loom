import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 2ec00f6a — attempt 1 of a merge gate whose single/multi-file retry re-queues must leave a DURABLE
// trace BEFORE the retry settles. Live specimens: batch `36c08174` (attempt 1 ran ~29.5 min, then an 87 min
// re-queue with no build_gate row/event) and solo `ff93dce4` (attempt 1 ran 253 s, re-queued as attempt 2).
// HERMETIC, no daemon: REAL git + an INJECTED `runGate` seam whose SECOND call (the retry) is held open, so
// every assertion below reads state while the retry is genuinely queued/running — the exact window in which
// the pre-fix code had recorded nothing.
//   (A) SOLO: while the retry runs, a `build_gate_single_file_retry_attempt` event exists with attempt:1,
//       passed:false, durationMs, failingTest, retriedFile, opId; gate_status(live) echoes it as
//       `priorAttemptVerdict`. After settle, exactly one `build_gate` row still exists (no second history row).
//   (B) BATCH: same, through mergeBatchTracked.
//   (C) CROSS-PROJECT read of the live op keeps attempt/passed/durationMs but DROPS retriedFile/failingTest.
//   (D) CONTROL: a first-attempt PASS emits NO such event and no priorAttemptVerdict (the check can be false).
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-gate-attempt1-trace.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-a1t-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=a1t@loom -c user.name=a1t";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const EVT = "build_gate_single_file_retry_attempt";
const eventsOfKind = (db, mgrId, kind) => db.listEvents(mgrId).filter((e) => e.kind === kind);
const FAIL1 = (name) => ({ passed: false, failedStep: "pnpm gate", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "", failingTest: `FAIL  ${name}`, failingTestCount: 1, failTierTest: `FAIL  ${name}`, failTierTestCount: 1, failTierAll: [`FAIL  ${name}`] });

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# a1t\n");
  execSync(`git init -q && git config user.email a1t@loom && git config user.name a1t`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}
function plantTestFile(worktreePath, name) {
  fs.mkdirSync(path.join(worktreePath, "packages", "daemon", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "scripts", "test-daemon.mjs"), "// stub\n");
  fs.mkdirSync(path.join(worktreePath, "packages", "daemon", "test"), { recursive: true });
  fs.writeFileSync(path.join(worktreePath, "packages", "daemon", "test", `${name}.mjs`), "// stub\n");
}
async function seedProject(db, label) {
  const P = { projId: `a1t-${label}-proj-${sfx}`, agentId: `a1t-${label}-agent-${sfx}`, mgrId: `a1t-${label}-mgr-${sfx}`, repo: path.join(os.tmpdir(), `loom-a1t-${label}-${sfx}`) };
  makeRepo(P.repo);
  db.insertProject({ id: P.projId, name: `A1T-${label}`, repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  return P;
}
async function seedWorker(db, P, tag, testName) {
  const taskId = `a1t-${tag}-task-${sfx}`, workerId = `a1t-${tag}-wkr-${sfx}`;
  const { worktreePath, branch } = await createWorktree(P.repo, P.projId, taskId);
  if (testName) plantTestFile(worktreePath, testName);
  fs.writeFileSync(path.join(worktreePath, `${tag}.txt`), `work ${tag}\n`);
  commitAll(worktreePath, tag, GIT_ID);
  db.insertTask({ id: taskId, projectId: P.projId, title: `feat(test): ${tag}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId, worktreePath, branch });
  return { workerId, worktreePath };
}
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };

const dbs = [];
const worktrees = [];
try {
  // ── (A)+(C) SOLO ───────────────────────────────────────────────────────────────────────────────────────
  {
    const db = new Db(); dbs.push(db);
    const P = await seedProject(db, "solo");
    let calls = 0;
    let releaseRetry;
    const retryHeld = new Promise((res) => { releaseRetry = res; });
    const fakeGate = async () => {
      calls++;
      if (calls === 1) return FAIL1("flaky-solo");
      await retryHeld; // the retry is admitted and RUNNING until the test lets it go
      return { passed: true };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const w = await seedWorker(db, P, "solo", "flaky-solo"); worktrees.push(w.worktreePath);
    const p = sessions.confirmWorkerMerge(P.mgrId, w.workerId);
    const live = await waitUntil(() => sessions.gateQueueForManager(P.projId).running.find((e) => e.gateType === "merge" && e.attempt === 2), { timeoutMs: 20000, label: "solo retry admitted as attempt 2" });
    // Card 8b1fb28f: the retry link awaits `captureGatedTip` (a git rev-parse) AFTER it is admitted and BEFORE the
    // spawn, so "admitted as attempt 2" no longer implies the gate fn has been called — wait for the spawn itself.
    await waitUntil(() => calls === 2, { timeoutMs: 20000, label: "solo retry gate spawned" });
    check("(A) setup: the retry is live as attempt:2 (attempt 1 has already failed)", !!live && calls === 2);
    const evs = eventsOfKind(db, P.mgrId, EVT);
    check("(A) attempt-1 event exists WHILE the retry is still running (pre-fix: nothing until the retry settled)", evs.length === 1);
    const d = evs[0]?.detail ?? {};
    check("(A) event carries attempt:1, passed:false, real durationMs, failingTest, retriedFile, opId", d.attempt === 1 && d.passed === false && typeof d.durationMs === "number" && d.durationMs >= 0 && d.failingTest === "FAIL  flaky-solo" && d.retriedFile === "flaky-solo" && d.opId === live?.opId);
    check("(A) NO build_gate row yet (only the new marker event is durable at this point)", eventsOfKind(db, P.mgrId, "build_gate").length === 0);
    const st = sessions.gateStatus(live.opId);
    check("(A) gate_status(live) echoes priorAttemptVerdict {attempt:1, passed:false, durationMs, retriedFile, failingTest}", st.priorAttemptVerdict?.attempt === 1 && st.priorAttemptVerdict?.passed === false && st.priorAttemptVerdict?.retriedFile === "flaky-solo" && st.priorAttemptVerdict?.failingTest === "FAIL  flaky-solo" && typeof st.priorAttemptVerdict?.durationMs === "number");
    const foreign = sessions.gateStatus(live.opId, undefined, undefined, { callerProjectId: "some-other-project" });
    check("(C) cross-project live read KEEPS attempt/passed/durationMs", foreign.priorAttemptVerdict?.attempt === 1 && foreign.priorAttemptVerdict?.passed === false && typeof foreign.priorAttemptVerdict?.durationMs === "number");
    check("(C) cross-project live read DROPS retriedFile/failingTest (content-bearing)", foreign.priorAttemptVerdict !== undefined && !("retriedFile" in foreign.priorAttemptVerdict) && !("failingTest" in foreign.priorAttemptVerdict));
    const own = sessions.gateStatus(live.opId, undefined, undefined, { callerProjectId: P.projId });
    check("(C) same-project manager read keeps the content fields", own.priorAttemptVerdict?.retriedFile === "flaky-solo");
    releaseRetry("go");
    const res = await p;
    check("(A) retry passed -> merged:true, retriedFile flagged", res.merged === true && res.retriedFile === "flaky-solo");
    check("(A) still exactly ONE build_gate row after settle, and the marker event is not a gate_history row", eventsOfKind(db, P.mgrId, "build_gate").length === 1 && db.listGateEvents({ projectId: P.projId, limit: 50, offset: 0 }).items.length === 1);
  }

  // ── (B) BATCH ──────────────────────────────────────────────────────────────────────────────────────────
  {
    const db = new Db(); dbs.push(db);
    const P = await seedProject(db, "batch");
    let calls = 0;
    let releaseRetry;
    const retryHeld = new Promise((res) => { releaseRetry = res; });
    const fakeGate = async (_gate, worktreePath) => {
      calls++;
      if (calls === 1) { plantTestFile(worktreePath, "flaky-batch"); return FAIL1("flaky-batch"); }
      await retryHeld;
      return { passed: true };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const a = await seedWorker(db, P, "ba", null); const b = await seedWorker(db, P, "bb", null);
    worktrees.push(a.worktreePath, b.worktreePath);
    const batchP = sessions.mergeBatchTracked(P.mgrId, [a.workerId, b.workerId]);
    const live = await waitUntil(() => sessions.gateQueueForManager(P.projId).running.find((e) => e.gateType === "merge" && e.attempt === 2), { timeoutMs: 20000, label: "batch retry admitted as attempt 2" });
    check("(B) setup: the batch retry is live as attempt:2", !!live && calls === 2);
    const evs = eventsOfKind(db, P.mgrId, EVT);
    check("(B) attempt-1 event exists WHILE the batch retry is running", evs.length === 1);
    const d = evs[0]?.detail ?? {};
    check("(B) event carries attempt:1, passed:false, durationMs, failingTest, retriedFile, opId, batched:true, branchCount:2", d.attempt === 1 && d.passed === false && typeof d.durationMs === "number" && d.failingTest === "FAIL  flaky-batch" && d.retriedFile === "flaky-batch" && d.opId === live?.opId && d.batched === true && d.branchCount === 2);
    check("(B) NO build_gate row yet", eventsOfKind(db, P.mgrId, "build_gate").length === 0);
    const st = sessions.gateStatus(live.opId);
    check("(B) gate_status(live) echoes priorAttemptVerdict for the batch op", st.priorAttemptVerdict?.attempt === 1 && st.priorAttemptVerdict?.passed === false && st.priorAttemptVerdict?.retriedFile === "flaky-batch");
    releaseRetry("go");
    const r = await batchP;
    if (!r.settled) await waitUntil(() => sessions.gateStatus(r.op.opId).state === "settled", { timeoutMs: 60000, label: "batch settle" });
    check("(B) batch settled; still exactly ONE build_gate row", eventsOfKind(db, P.mgrId, "build_gate").length === 1);
  }

  // ── (D) CONTROL: first-attempt pass leaves no marker and no echo ───────────────────────────────────────
  {
    const db = new Db(); dbs.push(db);
    const P = await seedProject(db, "ctl");
    let hold; const held = new Promise((res) => { hold = res; });
    let seenOpId;
    const fakeGate = async () => { await held; return { passed: true }; };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const w = await seedWorker(db, P, "ctl", null); worktrees.push(w.worktreePath);
    const p = sessions.confirmWorkerMerge(P.mgrId, w.workerId);
    const live = await waitUntil(() => sessions.gateQueueForManager(P.projId).running.find((e) => e.gateType === "merge"), { timeoutMs: 20000, label: "control gate running" });
    seenOpId = live?.opId;
    check("(D) control: a first-attempt run has NO priorAttemptVerdict on gate_status", !!seenOpId && sessions.gateStatus(seenOpId).priorAttemptVerdict === undefined);
    hold("go");
    const res = await p;
    check("(D) control: merged with NO attempt-1 marker event", res.merged === true && eventsOfKind(db, P.mgrId, EVT).length === 0);
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0 ? "\n✅ ALL PASS — attempt 1 leaves a durable event + live gate_status echo before its retry settles (solo + batch), content fields redacted cross-project." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
