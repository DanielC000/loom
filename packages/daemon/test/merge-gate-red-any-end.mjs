import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 90db13d8 — a SETTLED merge-gate red is recorded (and owes the next landing a gate under the interval cadence) WHATEVER ended the
// retry chain, not only a normal end. REAL git on temp repos + an INJECTED `runGate` seam. Extends card 593cedc8 (the red is recorded from
// the semaphore's `beforeRelease` hook, inside the admission + repo guard); decision record docs/decisions/593cedc8-*.md.
//
// ONE rule under test: the hook decides from its OWN last-settled `result` — red (isMergeGateRed) ⇒ record; a throw AFTER an INCOMPLETE
// pass (single-file retry passed while gate steps are still unresolved) ⇒ record too (fail-safe: over-gating costs one gated landing, an
// unrecorded red lets the next landing go ungated on top of a known red); a throw after a COMPLETE pass ⇒ record nothing.
//
//   (T1)  SOLO: attempt 1 is a transient SIGKILL red; the retry link's `reunionAtAdmission()` then throws AdmissionReunionFailedError
//         (main advanced with a conflicting commit while attempt 1 ran) ⇒ merge_rejected AND the red is recorded, gateOwed true, recorded
//         while the admission + repo guard are still held.
//   (T1c) POSITIVE CONTROL: the same setup but main NOT advanced ⇒ the retry runs, also fails ⇒ recorded once (the pre-existing normal end).
//   (T2)  SOLO: the single-file retry PASSES COMPLETELY (no unresolved steps), then its `next` throws ⇒ nothing recorded, gateOwed false.
//   (T2b) SOLO: the single-file retry passes but a step is still UNRESOLVED; the resume link then throws ⇒ recorded (fail-safe).
//   (T3)  BATCH: attempt 1 red (eligible single-file retry); the retry link throws ⇒ recorded once, candidates:2, gateOwed true.
//   (T3b) BATCH: single-file retry passed with a step unresolved, resume link throws ⇒ recorded.
//   (T3c) BATCH: single-file retry passes COMPLETELY, then its `next` throws ⇒ nothing recorded.
//   (T4)  NEGATIVE CONTROL: a throw with NO settled verdict (the FIRST gate call throws) records nothing.
// NOT COVERED: a real GateWorktreeDirtyError link throw (no deterministic seam — see the 593cedc8 record); the real-gate-runner spawn.
// Run: 1) build daemon (pnpm build), 2) LOOM_CODEX_BIN=<nonexistent> node test/merge-gate-red-any-end.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome } from "./_tmp-fixture.mjs";

process.env.LOOM_GATE_RETRY_SETTLE_MS = "20"; // keep the transient-retry settle wait tiny
useOwnLoomHome("loom-mgrae-home-"); // cleanup-by-construction: registered for the exit sweep (a self-assigned home would leak)

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mgrae@loom -c user.name=mgrae";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const GATE_3STEP = "pnpm build && node packages/daemon/test/flaky-mid.mjs && pnpm true-final";

const mk = (label) => ({
  projId: `mgrae-${label}-proj-${sfx}`, agentId: `mgrae-${label}-agent-${sfx}`, mgrId: `mgrae-${label}-mgr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-mgrae-${label}-${sfx}`),
});
function plantTestFile(root) {
  fs.mkdirSync(path.join(root, "packages", "daemon", "scripts"), { recursive: true });
  fs.writeFileSync(path.join(root, "packages", "daemon", "scripts", "test-daemon.mjs"), "// stub\n");
  fs.mkdirSync(path.join(root, "packages", "daemon", "test"), { recursive: true });
  fs.writeFileSync(path.join(root, "packages", "daemon", "test", "flaky-mid.mjs"), "// stub\n");
}
function makeRepo(P) {
  fs.mkdirSync(P.repo, { recursive: true });
  registerForCleanup(P.repo);
  fs.writeFileSync(path.join(P.repo, "README.md"), "# mgrae\n");
  fs.mkdirSync(path.join(P.repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(P.repo, "src", "baseline.ts"), "export const BASELINE = true;\n");
  plantTestFile(P.repo); // committed to main so a batch/solo worktree cut from it carries the files `identifyRetriableTestFiles` checks
  execSync(`git init -q && git config user.email mgrae@loom && git config user.name mgrae`, { cwd: P.repo });
  commitAll(P.repo, "init", GIT_ID);
}
async function addWorker(db, P, n, files) {
  const taskId = `mgrae-${n}-task-${sfx}`; const workerId = `mgrae-${n}-wkr-${sfx}`;
  db.insertTask({ id: taskId, projectId: P.projId, title: `feat(x): change ${n}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const { worktreePath, branch } = await createWorktree(P.repo, P.projId, taskId);
  registerForCleanup(worktreePath);
  for (const [rel, body] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(worktreePath, rel)), { recursive: true }); fs.writeFileSync(path.join(worktreePath, rel), body); }
  commitAll(worktreePath, `feat(x): change ${n}`, GIT_ID);
  db.insertSession({ id: workerId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: P.mgrId, taskId, worktreePath, branch });
  return { taskId, workerId, worktreePath, branch };
}
function seedProject(db, P, orchestration) {
  db.insertProject({ id: P.projId, name: "MGRAE", repoPath: P.repo, vaultPath: P.repo, config: { orchestration: { gateCommand: "pnpm gate", ...orchestration } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: P.agentId, projectId: P.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: P.mgrId, projectId: P.projId, agentId: P.agentId, engineSessionId: null, title: null, cwd: P.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
}
/** A service with an injected gate (`script(n, gateCmd)` decides call n) and a spy on the ONE red recorder that also samples, AT RECORD TIME,
 *  whether the admission + per-repo guard are still held (the recorder must run before `runExclusive`'s `finally` releases them). */
function mkService(db, script) {
  const ctx = { calls: 0, gates: [], recorded: 0, heldAtRecord: [] };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000,
    runGate: async (gate, ...rest) => { ctx.calls++; ctx.gates.push(gate); return script(ctx.calls, gate, ...rest); },
    reapWorktreeProcesses: noReap,
  });
  const orig = sessions.recordMergeGateFailure.bind(sessions);
  sessions.recordMergeGateFailure = async (...a) => {
    ctx.recorded++;
    ctx.heldAtRecord.push({ active: sessions.gateSemaphore.snapshot().active, repoGuards: sessions.gateSemaphore.activeMergeRepos.size });
    return orig(...a);
  };
  ctx.sessions = sessions;
  return ctx;
}
const KILL = { passed: false, failedStep: "pnpm gate", failedStatus: null, failedSignal: "SIGKILL", failedTimedOut: false, outputTail: "" };
// A GENUINE failure of step 2 of the 3-step gate (step 3 never ran) whose FAIL tier names a retriable test file.
const GENUINE_MID = {
  passed: false, failedStep: "node packages/daemon/test/flaky-mid.mjs", failedStatus: 1, failedSignal: null, failedTimedOut: false,
  outputTail: "", failingTest: "FAIL  flaky-mid", failingTestCount: 1, failTierTest: "FAIL  flaky-mid", failTierTestCount: 1, failTierAll: ["FAIL  flaky-mid"],
  steps: [{ step: "pnpm build", durationMs: 10, status: 0 }, { step: "node packages/daemon/test/flaky-mid.mjs", durationMs: 20, status: 1 }],
};
// The same failure for a ONE-step gate: nothing is left unresolved once the single-file retry passes.
const GENUINE_ONLY = { ...GENUINE_MID, failedStep: "node packages/daemon/test/flaky-mid.mjs", steps: [{ step: "node packages/daemon/test/flaky-mid.mjs", durationMs: 20, status: 1 }] };
const PASS_ONE = { passed: true, steps: [{ step: "node packages/daemon/scripts/test-daemon.mjs --only=flaky-mid", durationMs: 5, status: 0 }] };
const owed = (db, P) => db.getMergeGateState(P.projId).gateOwed === true;
const failRows = (db, P) => db.getMergeGateState(P.projId).recent.filter((e) => e.result === "fail");
const settle = async (p) => { try { return { value: await p }; } catch (err) { return { thrown: err }; } };
const confirmSolo = async (sessions, P, w) => {
  const r = await settle(sessions.confirmWorkerMergeTracked(P.mgrId, w.workerId));
  if (!r.value) return r;
  // `confirmWorkerMergeTracked` folds a thrown chain error into a settled `ok:false` result (never a rejection).
  return r.value.settled && r.value.ok ? { value: r.value.value } : { thrown: r.value.settled ? r.value.error ?? r.value : r.value };
};
/** Make `db.appendEvent` throw ONCE for `kind` — used to end a chain by a throw INSIDE a link's `next`, after that link settled. */
function throwOnceOnEvent(db, kind) {
  const orig = db.appendEvent.bind(db); let fired = false;
  db.appendEvent = (e) => { if (!fired && e.kind === kind) { fired = true; throw new Error(`injected ${kind} failure`); } return orig(e); };
  return () => fired;
}

const dbs = [];
try {
  // ── (T1) attempt 1 red, the retry's admission reunion throws ─────────────────────────────────────────────
  {
    const P = mk("t1"); makeRepo(P);
    const db = new Db(); dbs.push(db);
    seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    db.putMergeGateState(P.projId, { ...db.getMergeGateState(P.projId), ungatedSinceLastPass: 2 }); // 2+1 > 2 ⇒ this solo is GATED (periodic)
    const w = await addWorker(db, P, "t1", { "src/t1.ts": "export const t1 = 'branch';\n" });
    const ctx = mkService(db, (n) => {
      if (n === 1) { // attempt 1: main advances with a commit that CONFLICTS with the branch, then the gate is transient-killed
        fs.writeFileSync(path.join(P.repo, "src", "t1.ts"), "export const t1 = 'main';\n");
        commitAll(P.repo, "feat(x): conflicting main advance", GIT_ID);
        return KILL;
      }
      return { passed: true };
    });
    const r = await confirmSolo(ctx.sessions, P, w);
    const v = r.value;
    check("(T1) the retry link's admission reunion failed ⇒ merge_rejected result (merged:false, union conflict), gate ran ONCE (retry never spawned)", v?.merged === false && /conflicts with current main/.test(v.reason ?? "") && ctx.calls === 1);
    check("(T1) THE FIX: attempt 1's settled red was recorded (once) and owes the next landing a gate", ctx.recorded === 1 && failRows(db, P).length === 1 && owed(db, P));
    check("(T1) it was recorded INSIDE the guard: the admission slot AND the repo guard were still held when the recorder ran", ctx.heldAtRecord[0]?.active >= 1 && ctx.heldAtRecord[0]?.repoGuards >= 1);
  }
  // ── (T1c) positive control: main not advanced ⇒ the retry runs and also fails ⇒ recorded once ─────────────
  {
    const P = mk("t1c"); makeRepo(P);
    const db = new Db(); dbs.push(db);
    seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    db.putMergeGateState(P.projId, { ...db.getMergeGateState(P.projId), ungatedSinceLastPass: 2 });
    const w = await addWorker(db, P, "t1c", { "src/t1c.ts": "export const t1c = 1;\n" });
    const ctx = mkService(db, () => KILL);
    const v = (await confirmSolo(ctx.sessions, P, w)).value;
    check("(T1c) control: no main advance ⇒ the retry ran (2 gate calls), merged:false, recorded ONCE, owed", v?.merged === false && ctx.calls === 2 && ctx.recorded === 1 && failRows(db, P).length === 1 && owed(db, P));
  }
  // ── (T2) complete single-file pass, then a throw in its `next` ⇒ NOT a red ───────────────────────────────
  {
    const P = mk("t2"); makeRepo(P);
    const db = new Db(); dbs.push(db);
    seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2, gateCommand: "node packages/daemon/test/flaky-mid.mjs" });
    db.putMergeGateState(P.projId, { ...db.getMergeGateState(P.projId), ungatedSinceLastPass: 2 });
    const w = await addWorker(db, P, "t2", { "src/t2.ts": "export const t2 = 1;\n" });
    const ctx = mkService(db, (n) => (n === 1 ? GENUINE_ONLY : PASS_ONE));
    const fired = throwOnceOnEvent(db, "build_gate_single_file_retry");
    const r = await confirmSolo(ctx.sessions, P, w);
    check("(T2) precondition: the chain really ended by the injected throw AFTER the retry passed (2 gate calls, injection fired, op errored)", fired() && ctx.calls === 2 && r.thrown !== undefined);
    check("(T2) a COMPLETE pass then a throw records NOTHING (no red, not owed) — attempt 1's red was superseded by the passing link", ctx.recorded === 0 && failRows(db, P).length === 0 && !owed(db, P));
  }
  // ── (T2b) incomplete single-file pass, then the resume link throws ⇒ recorded (fail-safe) ────────────────
  {
    const P = mk("t2b"); makeRepo(P);
    const db = new Db(); dbs.push(db);
    seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2, gateCommand: GATE_3STEP });
    db.putMergeGateState(P.projId, { ...db.getMergeGateState(P.projId), ungatedSinceLastPass: 2 });
    const w = await addWorker(db, P, "t2b", { "src/t2b.ts": "export const t2b = 1;\n" });
    const ctx = mkService(db, (n) => { if (n === 1) return GENUINE_MID; if (n === 2) return PASS_ONE; throw new Error("injected resume-link runner failure"); });
    const r = await confirmSolo(ctx.sessions, P, w);
    check("(T2b) precondition: 3 gate calls (attempt 1, single-file pass, the resume link that threw) and the op errored", ctx.calls === 3 && ctx.gates[2] === "pnpm true-final" && r.thrown !== undefined);
    check("(T2b) an INCOMPLETE pass then a throw records the red (fail-safe): recorded once, owed, inside the guard", ctx.recorded === 1 && failRows(db, P).length === 1 && owed(db, P) && ctx.heldAtRecord[0]?.repoGuards >= 1);
  }
  // ── (T3) BATCH: attempt 1 red, the retry link throws ─────────────────────────────────────────────────────
  {
    const P = mk("t3"); makeRepo(P);
    const db = new Db(); dbs.push(db);
    seedProject(db, P, { mergeGate: "off", mergeGateInterval: 1, gateCommand: "node packages/daemon/test/flaky-mid.mjs" });
    const a = await addWorker(db, P, "t3a", { "src/t3a.ts": "export const t3a = 1;\n" });
    const b = await addWorker(db, P, "t3b", { "src/t3b.ts": "export const t3b = 2;\n" });
    const ctx = mkService(db, (n) => { if (n === 1) return GENUINE_ONLY; throw new Error("injected retry-link runner failure"); });
    const r = await settle(ctx.sessions.mergeBatchTracked(P.mgrId, [a.workerId, b.workerId]));
    const s = db.getMergeGateState(P.projId);
    check("(T3) precondition: K=2 at N=1 is due, attempt 1 ran and its retry link threw (2 gate calls)", ctx.calls === 2 && (r.thrown !== undefined || r.value?.settled === true));
    check("(T3) THE FIX: the batch's attempt-1 red is recorded ONCE with candidates:2 and owes the next landing a gate", ctx.recorded === 1 && s.recent.filter((e) => e.result === "fail" && e.candidates === 2).length === 1 && s.gateOwed === true);
    check("(T3) recorded INSIDE the guard (admission slot + repo guard still held)", ctx.heldAtRecord[0]?.active >= 1 && ctx.heldAtRecord[0]?.repoGuards >= 1);
  }
  // ── (T3b) BATCH: incomplete single-file pass, then the resume link throws ⇒ recorded ─────────────────────
  {
    const P = mk("t3bb"); makeRepo(P);
    const db = new Db(); dbs.push(db);
    seedProject(db, P, { mergeGate: "off", mergeGateInterval: 1, gateCommand: GATE_3STEP });
    const a = await addWorker(db, P, "t3ba", { "src/t3ba.ts": "export const t3ba = 1;\n" });
    const b = await addWorker(db, P, "t3bb", { "src/t3bb.ts": "export const t3bb = 2;\n" });
    const ctx = mkService(db, (n) => { if (n === 1) return GENUINE_MID; if (n === 2) return PASS_ONE; throw new Error("injected resume-link runner failure"); });
    await settle(ctx.sessions.mergeBatchTracked(P.mgrId, [a.workerId, b.workerId]));
    check("(T3b) precondition: 3 gate calls (attempt 1, single-file pass, the resume link that threw)", ctx.calls === 3);
    check("(T3b) an INCOMPLETE pass then a throw records the batch red (fail-safe): once, candidates:2, owed", ctx.recorded === 1 && db.getMergeGateState(P.projId).recent.filter((e) => e.result === "fail" && e.candidates === 2).length === 1 && owed(db, P));
  }
  // ── (T3c) BATCH: complete single-file pass, then a throw in its `next` ⇒ NOT a red ───────────────────────
  {
    const P = mk("t3c"); makeRepo(P);
    const db = new Db(); dbs.push(db);
    seedProject(db, P, { mergeGate: "off", mergeGateInterval: 1, gateCommand: "node packages/daemon/test/flaky-mid.mjs" });
    const a = await addWorker(db, P, "t3ca", { "src/t3ca.ts": "export const t3ca = 1;\n" });
    const b = await addWorker(db, P, "t3cb", { "src/t3cb.ts": "export const t3cb = 2;\n" });
    const ctx = mkService(db, (n) => (n === 1 ? GENUINE_ONLY : PASS_ONE));
    const fired = throwOnceOnEvent(db, "build_gate_single_file_retry");
    await settle(ctx.sessions.mergeBatchTracked(P.mgrId, [a.workerId, b.workerId]));
    check("(T3c) precondition: the chain ended by the injected throw AFTER the retry passed completely (2 gate calls, injection fired)", fired() && ctx.calls === 2);
    check("(T3c) a COMPLETE pass then a throw records NOTHING (not owed, no ring row)", ctx.recorded === 0 && db.getMergeGateState(P.projId).recent.length === 0 && !owed(db, P));
  }
  // ── (T4) negative control: NO settled verdict (the first gate call throws) ⇒ nothing recorded ─────────────
  {
    const P = mk("t4"); makeRepo(P);
    const db = new Db(); dbs.push(db);
    seedProject(db, P, { mergeGate: "off", mergeGateInterval: 2 });
    db.putMergeGateState(P.projId, { ...db.getMergeGateState(P.projId), ungatedSinceLastPass: 2 });
    const w = await addWorker(db, P, "t4", { "src/t4.ts": "export const t4 = 1;\n" });
    const ctx = mkService(db, () => { throw new Error("injected first-attempt runner failure"); });
    const r = await confirmSolo(ctx.sessions, P, w);
    check("(T4) a throw with no settled verdict: the op errored, nothing recorded, not owed", ctx.calls === 1 && r.thrown !== undefined && ctx.recorded === 0 && !owed(db, P));
  }
} finally {
  for (const d of dbs) { try { d.close(); } catch { /* ignore */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a settled merge-gate red is recorded (inside the guard) whatever ended the chain; a complete pass then a throw is not a red; an incomplete pass then a throw records fail-safe."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
