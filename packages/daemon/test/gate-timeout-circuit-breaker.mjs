import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Gate-timeout circuit breaker (card 3564fd1e — the fleet-wide gate-timeout death spiral). HERMETIC: no
// real spawn — drives SessionService through the injectable `runGate` seam, forcing a deterministic
// timedOut:true result on every call, so the streak/threshold logic is exercised precisely. Proves:
//   (A) runWorkerGate: after GATE_TIMEOUT_BREAKER_THRESHOLD consecutive timedOut results on the same
//       branch, the NEXT call short-circuits WITHOUT invoking the gate runner at all, reporting a distinct
//       circuitBroken:true failure — and it STAYS tripped on further calls, not a one-shot check.
//   (B) confirmWorkerMerge shares the SAME breaker, keyed per branch — a spiral can't form via either path
//       independently.
//   (C) the breaker CLEARS once the branch's worktree HEAD advances past the commit it tripped on (a new
//       commit is the plausible fix) — proven with REAL git commits in a REAL worktree, not a mock.
//   (D) a passing (or genuinely-failing, non-timeout) gate result resets the streak — a timeout blip
//       followed by a pass doesn't carry over toward the threshold.
// Run: 1) build daemon (pnpm build), 2) node test/gate-timeout-circuit-breaker.mjs
process.env.LOOM_GATE_RETRY_ENABLED = "0"; // isolate: one confirmWorkerMerge call = exactly one streak increment
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-gtb-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");
const { GATE_TIMEOUT_BREAKER_THRESHOLD } = await import("../dist/orchestration/gate-runner.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=gtb@loom -c user.name=gtb";
const now = new Date().toISOString();

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# gtb\n");
  execSync(`git init -q && git config user.email gtb@loom && git config user.name gtb && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });
}
const timeoutGate = async () => ({ passed: false, failedTimedOut: true, failedSignal: "SIGKILL" });
const ptyStub = () => ({ stop() {}, isAlive() { return false; }, enqueueStdin() {}, getPid: () => undefined });

const dbs = [];
const worktrees = [];

try {
  // ── (A) runWorkerGate: N consecutive timeouts trip the breaker; the (N+1)th call never invokes the gate ──
  {
    const sfx = `a-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-gtb-repos-a-${sfx}`);
    const db = new Db(); dbs.push(db);
    const projId = `gtb-a-proj-${sfx}`, agentId = `gtb-a-agent-${sfx}`, mgrId = `gtb-a-mgr-${sfx}`, workerId = `gtb-a-wkr-${sfx}`;
    const repo = path.join(reposDir, "repo");
    makeRepo(repo);
    db.insertProject({ id: projId, name: "GTB-A", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const gateWorktreePath = path.join(reposDir, "gate-worker-wt"); // no real git needed — the breaker's HEAD read fails-safe to null here
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: gateWorktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: null, worktreePath: gateWorktreePath, branch: "loom/gtb-a" });

    let calls = 0;
    const countingTimeoutGate = async () => { calls++; return timeoutGate(); };
    const sessions = new SessionService(db, ptyStub(), new OrchestrationControl(), { runGate: countingTimeoutGate });

    for (let i = 0; i < GATE_TIMEOUT_BREAKER_THRESHOLD; i++) {
      const r = await sessions.runWorkerGate(workerId);
      check(`(A) call ${i + 1}/${GATE_TIMEOUT_BREAKER_THRESHOLD} actually ran the gate and timed out`,
        r.ok === true && r.value.gateDetail?.timedOut === true && !r.value.gateDetail?.circuitBroken);
    }
    check(`(A) exactly ${GATE_TIMEOUT_BREAKER_THRESHOLD} real gate calls were made so far`, calls === GATE_TIMEOUT_BREAKER_THRESHOLD);

    const tripped = await sessions.runWorkerGate(workerId);
    check("(A) the NEXT call is short-circuited: distinct circuitBroken failure",
      tripped.ok === true && tripped.value.passed === false && tripped.value.gateDetail?.circuitBroken === true && tripped.value.gateDetail?.timedOut === true);
    check("(A) the short-circuited call did NOT invoke the gate runner again", calls === GATE_TIMEOUT_BREAKER_THRESHOLD);

    const trippedAgain = await sessions.runWorkerGate(workerId);
    check("(A) the breaker STAYS tripped on a subsequent call too (not a one-shot check)", trippedAgain.value.gateDetail?.circuitBroken === true);
    check("(A) still no new gate call", calls === GATE_TIMEOUT_BREAKER_THRESHOLD);
  }

  // ── (B) confirmWorkerMerge shares the SAME breaker (per branch) ──────────────────────────────────────
  {
    const sfx = `b-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-gtb-repos-b-${sfx}`);
    const db = new Db(); dbs.push(db);
    const projId = `gtb-b-proj-${sfx}`, agentId = `gtb-b-agent-${sfx}`, taskId = `gtb-b-task-${sfx}`, mgrId = `gtb-b-mgr-${sfx}`, workerId = `gtb-b-wkr-${sfx}`;
    const repo = path.join(reposDir, "repo");
    makeRepo(repo);
    db.insertProject({ id: projId, name: "GTB-B", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: taskId, projectId: projId, title: "GTB-B-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "feature.txt"`, { cwd: worktreePath });
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

    let calls = 0;
    const countingTimeoutGate = async () => { calls++; return timeoutGate(); };
    const sessions = new SessionService(db, ptyStub(), new OrchestrationControl(), { runGate: countingTimeoutGate });

    for (let i = 0; i < GATE_TIMEOUT_BREAKER_THRESHOLD; i++) {
      const r = await sessions.confirmWorkerMerge(mgrId, workerId);
      check(`(B) confirm ${i + 1}/${GATE_TIMEOUT_BREAKER_THRESHOLD} actually ran the gate and timed out`,
        r.merged === false && r.gateDetail?.timedOut === true && !r.gateDetail?.circuitBroken);
    }
    check(`(B) exactly ${GATE_TIMEOUT_BREAKER_THRESHOLD} real gate calls were made`, calls === GATE_TIMEOUT_BREAKER_THRESHOLD);

    const tripped = await sessions.confirmWorkerMerge(mgrId, workerId);
    check("(B) confirmWorkerMerge's NEXT call is short-circuited too — SAME breaker as run_gate",
      tripped.merged === false && tripped.gateDetail?.circuitBroken === true);
    check("(B) still no new gate call", calls === GATE_TIMEOUT_BREAKER_THRESHOLD);
    check("(B) the worktree is retained (never merged/removed) throughout", fs.existsSync(worktreePath));
  }

  // ── (C) the breaker CLEARS once the branch's worktree HEAD advances (a new commit is the fix) ────────
  {
    const sfx = `c-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-gtb-repos-c-${sfx}`);
    const db = new Db(); dbs.push(db);
    const projId = `gtb-c-proj-${sfx}`, agentId = `gtb-c-agent-${sfx}`, taskId = `gtb-c-task-${sfx}`, mgrId = `gtb-c-mgr-${sfx}`, workerId = `gtb-c-wkr-${sfx}`;
    const repo = path.join(reposDir, "repo");
    makeRepo(repo);
    db.insertProject({ id: projId, name: "GTB-C", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: taskId, projectId: projId, title: "GTB-C-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work v1\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "feature.txt v1"`, { cwd: worktreePath });
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

    let calls = 0;
    const countingTimeoutGate = async () => { calls++; return timeoutGate(); };
    const sessions = new SessionService(db, ptyStub(), new OrchestrationControl(), { runGate: countingTimeoutGate });

    for (let i = 0; i < GATE_TIMEOUT_BREAKER_THRESHOLD; i++) await sessions.confirmWorkerMerge(mgrId, workerId);
    const tripped = await sessions.confirmWorkerMerge(mgrId, workerId);
    check("(C) breaker is tripped at the ORIGINAL commit", tripped.gateDetail?.circuitBroken === true);
    check("(C) no gate call for the tripped attempt", calls === GATE_TIMEOUT_BREAKER_THRESHOLD);

    // Push a NEW commit onto the SAME branch/worktree — the plausible fix.
    fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work v2 (fixed the hang)\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "feature.txt v2"`, { cwd: worktreePath });

    const afterFix = await sessions.confirmWorkerMerge(mgrId, workerId);
    check("(C) a NEW commit re-enables gating — the gate runner is invoked again (not short-circuited)", calls === GATE_TIMEOUT_BREAKER_THRESHOLD + 1);
    check("(C) that fresh attempt reports an ordinary timeout, NOT circuitBroken (clean slate)",
      afterFix.gateDetail?.timedOut === true && !afterFix.gateDetail?.circuitBroken);
  }

  // ── (D) a passing gate resets the streak — a timeout blip doesn't carry over toward the threshold
  //        (uses run_gate, which has no merge side effects on a pass, to isolate the counter itself) ────
  {
    const sfx = `d-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-gtb-repos-d-${sfx}`);
    const db = new Db(); dbs.push(db);
    const projId = `gtb-d-proj-${sfx}`, agentId = `gtb-d-agent-${sfx}`, mgrId = `gtb-d-mgr-${sfx}`, workerId = `gtb-d-wkr-${sfx}`;
    const repo = path.join(reposDir, "repo");
    makeRepo(repo);
    db.insertProject({ id: projId, name: "GTB-D", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const gateWorktreePath = path.join(reposDir, "gate-worker-wt");
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: gateWorktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: null, worktreePath: gateWorktreePath, branch: "loom/gtb-d" });

    let calls = 0;
    // timeout×(N-1), PASS, timeout×(N-1) — if the streak truly resets on the pass, NONE of these steps
    // trip the breaker (only N-1 timeouts follow the reset, one short of the threshold). If reset were
    // broken, the un-reset counter would already sit at N-1 before the pass and the trailing timeouts
    // would push it past N, tripping before the sequence finishes.
    const sequence = [
      ...Array(GATE_TIMEOUT_BREAKER_THRESHOLD - 1).fill("timeout"),
      "pass",
      ...Array(GATE_TIMEOUT_BREAKER_THRESHOLD - 1).fill("timeout"),
    ];
    const scripted = async () => {
      const outcome = sequence[calls]; calls++;
      return outcome === "pass" ? { passed: true } : { passed: false, failedTimedOut: true, failedSignal: "SIGKILL" };
    };
    const sessions = new SessionService(db, ptyStub(), new OrchestrationControl(), { runGate: scripted });

    for (let i = 0; i < sequence.length; i++) {
      const r = await sessions.runWorkerGate(workerId);
      check(`(D) step ${i + 1} (${sequence[i]}) never reports circuitBroken (reset holds)`, !r.value.gateDetail?.circuitBroken);
    }
    check("(D) every scripted step actually invoked the gate runner — the reset kept the breaker from ever tripping", calls === sequence.length);
  }

  // (E)/(F): the merge-path defeat (CR finding on card 3564fd1e). confirmWorkerMerge runs a REAL
  // union-merge of main's current tip into the worktree BEFORE the breaker check, so on the OLD code —
  // which read the raw worktree HEAD — every confirm attempt where main had advanced produced a
  // brand-new merge-commit sha, indistinguishable from the worker having pushed a fix. That reset the
  // streak on every single call and the breaker could never trip. Here main gets a genuine new commit
  // between EVERY confirm attempt (the worker itself never commits again), so this proves the fix: the
  // breaker must still trip after N consecutive timeouts even though the raw worktree HEAD sha changes
  // on every call. (F) then proves a REAL worker fix commit on the same branch still clears it post-trip.
  {
    const sfx = `e-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-gtb-repos-e-${sfx}`);
    const db = new Db(); dbs.push(db);
    const projId = `gtb-e-proj-${sfx}`, agentId = `gtb-e-agent-${sfx}`, taskId = `gtb-e-task-${sfx}`, mgrId = `gtb-e-mgr-${sfx}`, workerId = `gtb-e-wkr-${sfx}`;
    const repo = path.join(reposDir, "repo");
    makeRepo(repo);
    db.insertProject({ id: projId, name: "GTB-E", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: taskId, projectId: projId, title: "GTB-E-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    worktrees.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "feature.txt"`, { cwd: worktreePath });
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

    let calls = 0;
    const countingTimeoutGate = async () => { calls++; return timeoutGate(); };
    const sessions = new SessionService(db, ptyStub(), new OrchestrationControl(), { runGate: countingTimeoutGate });

    for (let i = 0; i < GATE_TIMEOUT_BREAKER_THRESHOLD; i++) {
      // Advance MAIN (never the worker's own branch) between every confirm attempt — this is what the
      // union-merge, run inside confirmWorkerMerge right before the breaker check, folds into the
      // worktree's raw HEAD on every single call.
      fs.writeFileSync(path.join(repo, `main-progress-${i}.txt`), `progress ${i}\n`);
      execSync(`git add . && git ${GIT_ID} commit -q -m "main progress ${i}"`, { cwd: repo });
      const r = await sessions.confirmWorkerMerge(mgrId, workerId);
      check(`(E) confirm ${i + 1}/${GATE_TIMEOUT_BREAKER_THRESHOLD} timed out, not yet circuitBroken (main kept advancing)`,
        r.merged === false && r.gateDetail?.timedOut === true && !r.gateDetail?.circuitBroken);
    }
    check(`(E) exactly ${GATE_TIMEOUT_BREAKER_THRESHOLD} real gate calls were made so far`, calls === GATE_TIMEOUT_BREAKER_THRESHOLD);

    // One more main advance, then confirm again — the worker STILL made no real fix, so this must trip.
    fs.writeFileSync(path.join(repo, "main-progress-final.txt"), "progress final\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "main progress final"`, { cwd: repo });
    const tripped = await sessions.confirmWorkerMerge(mgrId, workerId);
    check("(E) the breaker STILL TRIPS after N consecutive timeouts even though main advanced before every attempt (Finding 1 fix)",
      tripped.merged === false && tripped.gateDetail?.circuitBroken === true);
    check("(E) the tripped call did NOT invoke the gate runner again", calls === GATE_TIMEOUT_BREAKER_THRESHOLD);

    // (F) …but a REAL worker fix commit on the same branch DOES clear it, even post-trip.
    fs.writeFileSync(path.join(worktreePath, "feature.txt"), "work v2 (fixed the hang)\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "feature.txt v2 - actual fix"`, { cwd: worktreePath });
    const afterFix = await sessions.confirmWorkerMerge(mgrId, workerId);
    check("(F) a real worker commit re-enables gating — the gate runner is invoked again (not short-circuited)",
      calls === GATE_TIMEOUT_BREAKER_THRESHOLD + 1);
    check("(F) that fresh attempt reports an ordinary timeout, NOT circuitBroken (clean slate)",
      afterFix.gateDetail?.timedOut === true && !afterFix.gateDetail?.circuitBroken);
  }

  // (G) null-sha self-heal (Minor CR finding): a streak recorded while the worktree's sha was UNREADABLE
  // (entry.sha stuck null) must not lock the branch out forever once the worktree becomes readable again —
  // one more tripped check adopts the now-readable sha as the new baseline, so the VERY NEXT genuine
  // advance is detectable.
  {
    const sfx = `g-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-gtb-repos-g-${sfx}`);
    const db = new Db(); dbs.push(db);
    const projId = `gtb-g-proj-${sfx}`, agentId = `gtb-g-agent-${sfx}`, mgrId = `gtb-g-mgr-${sfx}`, workerId = `gtb-g-wkr-${sfx}`;
    const repo = path.join(reposDir, "repo");
    makeRepo(repo);
    db.insertProject({ id: projId, name: "GTB-G", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    // Doesn't exist yet — every sha read fails (null), matching the "unreadable HEAD" case that used to
    // leave entry.sha permanently null.
    const gateWorktreePath = path.join(reposDir, "gate-worker-wt-g");
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: gateWorktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: null, worktreePath: gateWorktreePath, branch: "loom/gtb-g" });

    let calls = 0;
    const countingTimeoutGate = async () => { calls++; return timeoutGate(); };
    const sessions = new SessionService(db, ptyStub(), new OrchestrationControl(), { runGate: countingTimeoutGate });

    for (let i = 0; i < GATE_TIMEOUT_BREAKER_THRESHOLD; i++) await sessions.runWorkerGate(workerId);
    const tripped = await sessions.runWorkerGate(workerId);
    check("(G) tripped with an unreadable (null) sha baseline", tripped.value.gateDetail?.circuitBroken === true);
    check("(G) no gate call for the tripped attempt", calls === GATE_TIMEOUT_BREAKER_THRESHOLD);

    // The worktree now becomes real (the sha is readable) — one more tripped check should self-heal the
    // null baseline to this commit, WITHOUT itself clearing the trip (no fix has landed yet).
    worktrees.push(gateWorktreePath);
    makeRepo(gateWorktreePath);
    const healCheck = await sessions.runWorkerGate(workerId);
    check("(G) the first readable-sha check stays tripped (nothing has actually changed yet - no false clear)",
      healCheck.value.gateDetail?.circuitBroken === true);
    check("(G) still no new gate call", calls === GATE_TIMEOUT_BREAKER_THRESHOLD);

    // A genuinely new commit on that now-real worktree must clear it — proving the null baseline was
    // healed (on the OLD code, entry.sha stays null forever since the short-circuited path never calls
    // recordGateTimeoutOutcome, so this comparison could never succeed).
    fs.writeFileSync(path.join(gateWorktreePath, "fix.txt"), "a fix\n");
    execSync(`git add . && git ${GIT_ID} commit -q -m "a fix"`, { cwd: gateWorktreePath });
    const afterFix = await sessions.runWorkerGate(workerId);
    check("(G) a real new commit on the now-readable worktree clears the self-healed streak (self-heal proven)",
      calls === GATE_TIMEOUT_BREAKER_THRESHOLD + 1 && !afterFix.value.gateDetail?.circuitBroken);
  }

  // (H) unbounded map growth (Minor CR finding): a branch that tripped the breaker and was then ABANDONED
  // (its worktree removed without ever landing a fix) must not leak its streak entry forever — removal
  // purges it.
  {
    const sfx = `h-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const reposDir = path.join(os.tmpdir(), `loom-gtb-repos-h-${sfx}`);
    const db = new Db(); dbs.push(db);
    const projId = `gtb-h-proj-${sfx}`, agentId = `gtb-h-agent-${sfx}`, taskId = `gtb-h-task-${sfx}`, mgrId = `gtb-h-mgr-${sfx}`, workerId = `gtb-h-wkr-${sfx}`;
    const repo = path.join(reposDir, "repo");
    makeRepo(repo);
    db.insertProject({ id: projId, name: "GTB-H", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
    db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
    db.insertTask({ id: taskId, projectId: projId, title: "GTB-H-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    // A DISPOSABLE worktree — no commits ahead of main — so boot-reconcile's Pass B will actually remove it.
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    worktrees.push(worktreePath);
    db.insertSession({ id: workerId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "dead", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath, branch });

    // The streak map lives on the SessionService INSTANCE — the whole point of this test is proving that
    // instance's map entry gets purged, so every step below (trip, boot-reconcile, and the post-removal
    // fresh attempt) MUST run against this one `sessions` object, never a fresh instance (which would
    // trivially have an empty map regardless of whether the purge fix exists).
    let calls = 0;
    const countingTimeoutGate = async () => { calls++; return timeoutGate(); };
    const sessions = new SessionService(db, ptyStub(), new OrchestrationControl(), { runGate: countingTimeoutGate });

    // Trip the breaker (abandoning the branch immediately after, without ever pushing a fix).
    for (let i = 0; i < GATE_TIMEOUT_BREAKER_THRESHOLD; i++) await sessions.runWorkerGate(workerId);
    const tripped = await sessions.runWorkerGate(workerId);
    check("(H) breaker tripped for the branch about to be abandoned", tripped.value.gateDetail?.circuitBroken === true);
    check(`(H) exactly ${GATE_TIMEOUT_BREAKER_THRESHOLD} real gate calls were made before the trip`, calls === GATE_TIMEOUT_BREAKER_THRESHOLD);

    const result = await sessions.reconcileOrchestrationOnBoot();
    check("(H) boot-reconcile actually removed the disposable, abandoned worktree", result.worktreesPruned >= 1);
    check("(H) the worktree dir is gone from disk", !fs.existsSync(worktreePath));

    // Recreate a worktree on the SAME branch/repo and prove the streak did NOT survive the removal: a
    // fresh run_gate call against it (on the SAME `sessions` instance) must run the gate again, not
    // short-circuit as still-tripped. On the OLD code (no purge on removal) the leaked entry would still
    // be sitting in the map keyed by this exact branch name and would incorrectly short-circuit this
    // brand-new attempt.
    fs.mkdirSync(worktreePath, { recursive: true });
    execSync(`git worktree add -q -B ${branch} ${JSON.stringify(worktreePath)}`, { cwd: repo });
    worktrees.push(worktreePath);
    const workerId2 = `gtb-h-wkr2-${sfx}`;
    db.insertSession({ id: workerId2, projectId: projId, agentId, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: null, worktreePath, branch });
    const freshAttempt = await sessions.runWorkerGate(workerId2);
    check("(H) a fresh attempt on the SAME branch after removal is NOT short-circuited — the streak was purged",
      !freshAttempt.value.gateDetail?.circuitBroken && calls === GATE_TIMEOUT_BREAKER_THRESHOLD + 1);
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
  for (const wt of worktrees) try { fs.rmSync(wt, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true }); } catch { /* ignore */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — after N consecutive timedOut gates on the same branch/commit, both run_gate and the merge gate stop spawning the gate at all and report a distinct circuitBroken failure; a new commit on the same branch gives it a clean slate; a passing/genuine-failure result resets the streak."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
