import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 720bb7ad DoD-3 — THE CONCURRENCY CONTROL. The card's own §ATTRIBUTION finding: two gate runs
// admitted close together at `maxConcurrentGates>=2` are GENUINELY overlapping in wall time, and the
// NDJSON run-summary row each of their `pnpm --filter @loom/daemon test:daemon` children writes carries
// NOTHING that ties it back to the op that spawned it — matching by timestamp alone is unsound (two real
// rows in this daemon's own live data started 13s apart and overlapped 15.4 minutes). The fix
// (`gateOpIdEnvOverride` in sessions/service.ts) stamps `LOOM_GATE_OP_ID` onto the gate child's env at
// every call site that spawns one. A SINGLE-RUN test structurally cannot detect a cross-op mixup (there's
// only one id in play, so a bug that always reused the SAME id, or swapped it with a hardcoded constant,
// would still look "correct") — this file's whole point is TWO co-live ops, each asserted to receive its
// OWN distinguishing opId, never the other's.
//
// Proves:
//   (A) CONCURRENCY — two DIFFERENT projects' merges held open SIMULTANEOUSLY (maxConcurrentGates raised
//       to 2 so both are genuinely admitted+running together, not merely both queued) each get their OWN
//       opId threaded onto their gate child's env — never the other's, never a shared/blank value.
//   (B) RETRIED MERGE, TRANSIENT-KILL (card bcba83a1's own retry, `allowExtend:false`) — the card's own
//       "easy half-miss": a retry re-spawns a SECOND real child process. Both the first attempt AND the
//       retry must carry the SAME opId as the op they're both part of — a retry that got a fresh/blank id
//       would silently produce an unattributable row for exactly the run a manager most wants forensics on.
//   (C) RETRIED MERGE, SINGLE-FILE (card 344ce950) — the OTHER retry site inside confirmWorkerMerge the
//       original card text never enumerated at all (verified by grep before this card's implementation;
//       see the card's own "VERIFY MY CLAIMS" instruction) — same same-opId-across-both-calls proof.
//   (D) runWorkerGate (the worker self-check) — the ONE site that already worked before this card
//       (WORKER_GATE_ENV_OVERRIDE) — proven here too so a regression in the merged env-merge order
//       (`gateOpIdEnvOverride(opId, WORKER_GATE_ENV_OVERRIDE)`) would be caught, not just the pre-existing
//       LOOM_GATE_TEST_CONCURRENCY pin.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-gate-opid-attribution.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { waitUntil } from "./_wait.mjs";
import { registerForCleanup } from "./_tmp-fixture.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-opid-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
// Mirrors merge-gate-retry.mjs — drives the transient-kill retry's settle delay near-zero so (B) doesn't
// burn a real multi-second wait.
process.env.LOOM_GATE_RETRY_SETTLE_MS = "20";

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=opid@loom -c user.name=opid";
const now = new Date().toISOString();

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# opid\n");
  execSync(`git init -q && git config user.email opid@loom && git config user.name opid && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}

function seed(db, p, gateCommand) {
  db.insertProject({ id: p.projId, name: "OPID", repoPath: p.repo, vaultPath: p.repo, config: { orchestration: { gateCommand } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "OPID-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const mk = (label) => ({
  projId: `opid-${label}-proj-${sfx}`, agentId: `opid-${label}-agent-${sfx}`, taskId: `opid-${label}-task-${sfx}`,
  mgrId: `opid-${label}-mgr-${sfx}`, workerId: `opid-${label}-wkr-${sfx}`,
  repo: path.join(os.tmpdir(), `loom-opid-${label}-${sfx}`),
});

const dbs = [];
const worktrees = [];
try {
  // ── (A) CONCURRENCY — two DIFFERENT ops, genuinely co-live, each attributed correctly ──────────────────
  {
    const A = mk("a");
    const B = mk("b");
    makeRepo(A.repo);
    makeRepo(B.repo);
    const db = new Db(); dbs.push(db);
    db.setPlatformConfig({ maxConcurrentGates: 2 }); // both admitted+running together, not serialized
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };

    const mkHold = () => { let release; const p = new Promise((r) => { release = r; }); return { p, release: (v) => release(v) }; };
    const holds = new Map();
    const calls = [];
    const fakeGate = async (gate, cwd, timeoutMs, _runStep, envOverride) => {
      calls.push({ cwd, opId: envOverride?.LOOM_GATE_OP_ID });
      await holds.get(cwd).p;
      return { passed: true, steps: [{ step: gate, durationMs: 10, status: 0 }], outputTail: "ok" };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });

    const wtA = await createWorktree(A.repo, A.projId, A.taskId);
    A.worktreePath = wtA.worktreePath; A.branch = wtA.branch; worktrees.push(wtA.worktreePath);
    fs.writeFileSync(path.join(wtA.worktreePath, "a.txt"), "a\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m a`, { cwd: wtA.worktreePath });
    seed(db, A, "pnpm gate");

    const wtB = await createWorktree(B.repo, B.projId, B.taskId);
    B.worktreePath = wtB.worktreePath; B.branch = wtB.branch; worktrees.push(wtB.worktreePath);
    fs.writeFileSync(path.join(wtB.worktreePath, "b.txt"), "b\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m b`, { cwd: wtB.worktreePath });
    seed(db, B, "pnpm gate");

    holds.set(A.worktreePath, mkHold());
    holds.set(B.worktreePath, mkHold());

    const pA = sessions.confirmWorkerMergeTracked(A.mgrId, A.workerId);
    const pB = sessions.confirmWorkerMergeTracked(B.mgrId, B.workerId);
    // Wait until BOTH gate children have genuinely started — the precondition that makes this a real
    // concurrency proof rather than an accidentally-serialized one.
    await waitUntil(() => (calls.length === 2 ? true : undefined), { timeoutMs: 10_000, label: "both A and B gate children to start" });
    check("(A precondition) both children are genuinely CO-LIVE at the same instant (cap raised to 2)", calls.length === 2);

    holds.get(A.worktreePath).release();
    holds.get(B.worktreePath).release();
    const [rA, rB] = await Promise.all([pA, pB]);
    const opIdA = rA.settled ? rA.value.opId : rA.op.opId;
    const opIdB = rB.settled ? rB.value.opId : rB.op.opId;

    check("(A) A and B settled with genuinely DIFFERENT opIds", typeof opIdA === "string" && typeof opIdB === "string" && opIdA !== opIdB);
    const callA = calls.find((c) => c.cwd === A.worktreePath);
    const callB = calls.find((c) => c.cwd === B.worktreePath);
    check("(A — THE FIX) A's gate child received A's OWN opId, never B's", callA?.opId === opIdA && callA?.opId !== opIdB);
    check("(A — THE FIX) B's gate child received B's OWN opId, never A's", callB?.opId === opIdB && callB?.opId !== opIdA);
  }

  // ── (B) RETRIED MERGE, TRANSIENT-KILL — first attempt AND the retry carry the SAME opId ─────────────────
  {
    const C = mk("c");
    makeRepo(C.repo);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const captured = [];
    let attempt = 0;
    const fakeGate = async (gate, cwd, timeoutMs, _runStep, envOverride) => {
      attempt++;
      captured.push(envOverride?.LOOM_GATE_OP_ID);
      if (attempt === 1) return { passed: false, failedStep: "pnpm gate", failedStatus: null, failedSignal: "SIGKILL", failedTimedOut: false, outputTail: "" };
      return { passed: true, steps: [{ step: gate, durationMs: 10, status: 0 }], outputTail: "ok" };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const wt = await createWorktree(C.repo, C.projId, C.taskId);
    C.worktreePath = wt.worktreePath; C.branch = wt.branch; worktrees.push(wt.worktreePath);
    fs.writeFileSync(path.join(wt.worktreePath, "c.txt"), "c\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m c`, { cwd: wt.worktreePath });
    seed(db, C, "pnpm gate");

    const confirm = await sessions.confirmWorkerMerge(C.mgrId, C.workerId);
    check("(B precondition) transient kill retried once then passed — merged:true", confirm.merged === true);
    check("(B precondition) exactly 2 gate calls (first attempt + one retry)", attempt === 2);
    check("(B — THE FIX) BOTH the first attempt AND the retry carried the SAME opId as this op's own", captured.length === 2 && typeof captured[0] === "string" && captured[0] === captured[1] && captured[0] === confirm.opId);
  }

  // ── (C) RETRIED MERGE, SINGLE-FILE (card 344ce950) — same same-opId-across-both-calls proof, the OTHER
  // retry site inside confirmWorkerMerge the original card text never enumerated. ─────────────────────────
  {
    const D = mk("d");
    makeRepo(D.repo);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    const captured = [];
    let attempt = 0;
    const fakeGate = async (gate, cwd, timeoutMs, _runStep, envOverride) => {
      attempt++;
      captured.push(envOverride?.LOOM_GATE_OP_ID);
      // Card 0e5b2045: identifyRetriableTestFile reads failTierTest/failTierTestCount, NOT
      // failingTest/failingTestCount (the two decoupled — an UNCAUGHT-idiom line can now outrank a bare
      // FAIL <name> summary in failingTest; the retry always targets failTierTest instead). Both are set
      // identically here since this fixture has no UNCAUGHT line at all.
      if (attempt === 1) return { passed: false, failedStep: "pnpm gate", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "", failingTest: "FAIL  flaky-one", failingTestCount: 1, failTierTest: "FAIL  flaky-one", failTierTestCount: 1 };
      return { passed: true };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const wt = await createWorktree(D.repo, D.projId, D.taskId);
    D.worktreePath = wt.worktreePath; D.branch = wt.branch; worktrees.push(wt.worktreePath);
    // Plants the two files identifyRetriableTestFile looks for (mirrors merge-gate-single-file-retry.mjs).
    fs.mkdirSync(path.join(wt.worktreePath, "packages", "daemon", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(wt.worktreePath, "packages", "daemon", "scripts", "test-daemon.mjs"), "// stub\n");
    fs.mkdirSync(path.join(wt.worktreePath, "packages", "daemon", "test"), { recursive: true });
    fs.writeFileSync(path.join(wt.worktreePath, "packages", "daemon", "test", "flaky-one.mjs"), "// stub\n");
    fs.writeFileSync(path.join(wt.worktreePath, "d.txt"), "d\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m d`, { cwd: wt.worktreePath });
    seed(db, D, "pnpm gate");

    const confirm = await sessions.confirmWorkerMerge(D.mgrId, D.workerId);
    check("(C precondition) single-file retry fired and passed — merged:true, retriedFile set", confirm.merged === true && confirm.retriedFile === "flaky-one");
    check("(C precondition) exactly 2 gate calls (first genuine failure + one single-file retry)", attempt === 2);
    check("(C — THE FIX) BOTH the first attempt AND the single-file retry carried the SAME opId as this op's own", captured.length === 2 && typeof captured[0] === "string" && captured[0] === captured[1] && captured[0] === confirm.opId);
  }

  // ── (D) runWorkerGate — the ONE site that already had SOME override before this card; proves the merge
  // with LOOM_GATE_OP_ID didn't regress it. ────────────────────────────────────────────────────────────────
  {
    const E = mk("e");
    makeRepo(E.repo);
    const db = new Db(); dbs.push(db);
    const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
    let capturedEnv;
    const fakeGate = async (gate, cwd, timeoutMs, _runStep, envOverride) => {
      capturedEnv = envOverride;
      return { passed: true, steps: [{ step: gate, durationMs: 10, status: 0 }], outputTail: "ok" };
    };
    const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { runGate: fakeGate });
    const wt = await createWorktree(E.repo, E.projId, E.taskId);
    E.worktreePath = wt.worktreePath; E.branch = wt.branch; worktrees.push(wt.worktreePath);
    seed(db, E, "pnpm gate");

    const result = await sessions.runWorkerGate(E.workerId);
    check("(D precondition) settles inline, passed:true", result.settled === true && result.ok === true && result.value.passed === true);
    check("(D — REGRESSION GUARD) LOOM_GATE_TEST_CONCURRENCY is still pinned (the pre-existing override)", capturedEnv?.LOOM_GATE_TEST_CONCURRENCY === "3");
    check("(D — THE FIX) LOOM_GATE_OP_ID is ALSO present now, matching this op's own opId", capturedEnv?.LOOM_GATE_OP_ID === result.value.opId);
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 720bb7ad DoD-3: gateOpIdEnvOverride stamps LOOM_GATE_OP_ID onto the gate child's env at every merge/worker-gate call site, and does so CORRECTLY under concurrency — two co-live merges (maxConcurrentGates=2) each receive their OWN opId, never the other's; a RETRIED merge (both the transient-kill whole-gate retry and the card 344ce950 single-file retry — the retry site the original card text never enumerated) carries the SAME opId across its first attempt and its retry, so a retry's own NDJSON run-summary row stays attributable to the op it belongs to; and the pre-existing worker-self-check override (LOOM_GATE_TEST_CONCURRENCY) is unaffected by the merge."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
