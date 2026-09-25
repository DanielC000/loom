import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 01777ceb — the MULTI-LINK compositions of the gate-FAIL/PASS "ran on the commit it names" rule (split off merge-confirm-fail-identity-void.mjs):
//   (C)  attempt-1 ABA (returned) + a later single-file link's HEAD-only no-return: the sticky round-trip predicate is false, yet the FAIL must re-gate.
//   (R)  reverse composition: attempt 1 detaches HEAD and commits T3 without returning; the single-file link then runs CLEAN on detached T3 (gatedTip = the branch ref T1).
//   (DP) a COMPOSED PASS whose EARLIER link started on a never-moving detached HEAD is refused (every contributing link must be clean).
//   (TR) positive control: a transient whole re-run on the re-attached branch MERGES (the re-pin reset is load-bearing).
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-fail-identity-void-links.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { settleTracked } from "./_settle-tracked.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mcfil-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);
process.env.LOOM_GATE_RETRY_SETTLE_MS = "1";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mcfil-nonexistent-codex");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, snapshotGateReflogs } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mcfil@loom -c user.name=mcfil";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
const openDbs = [];
const noReap = async () => ({ killedPids: [] });
const FAIL = { passed: false, failedStep: "test", failedStatus: 1, steps: [] };
const sfxOf = (tag) => `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const confirm = (sessions, mgrId, workerId) => settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirmWorkerMergeTracked" });
const headOf = (cwd) => execSync("git rev-parse HEAD", { cwd, encoding: "utf8" }).trim();

async function setup(sfx, { plant = false, gateCommand = "pnpm gate" } = {}) {
  const reposDir = path.join(os.tmpdir(), `loom-mcfil-${sfx}`);
  registerForCleanup(reposDir);
  const db = new Db(); openDbs.push(db);
  const mgrId = `mcfil-mgr-${sfx}`, projId = `mcfil-p-${sfx}`, taskId = `mcfil-t-${sfx}`, workerId = `mcfil-w-${sfx}`;
  const repo = path.join(reposDir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mcfil\n");
  execSync("git init -q && git config user.email mcfil@loom && git config user.name mcfil", { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  db.insertProject({ id: projId, name: "MCFIV", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-mcfil-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mcfil-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-mcfil-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MCFIV-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const wt = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(wt.worktreePath, "feature.txt"), "work\n");
  if (plant) { // single-file-retry needs a real-looking test-daemon.mjs + the named test file inside the worktree
    fs.mkdirSync(path.join(wt.worktreePath, "packages", "daemon", "scripts"), { recursive: true });
    fs.writeFileSync(path.join(wt.worktreePath, "packages", "daemon", "scripts", "test-daemon.mjs"), "// stub\n");
    fs.mkdirSync(path.join(wt.worktreePath, "packages", "daemon", "test"), { recursive: true });
    fs.writeFileSync(path.join(wt.worktreePath, "packages", "daemon", "test", "flaky-mid.mjs"), "// stub\n");
  }
  commitAll(wt.worktreePath, "feature", GIT_ID);
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mcfil-w-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: wt.worktreePath, branch: wt.branch });
  return { db, mgrId, workerId, repo, worktreePath: wt.worktreePath, branch: wt.branch, t1: headOf(wt.worktreePath) };
}
const svc = (db, runGate, extra = {}) => new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap, runGate, ...extra });

{
  // (C) composition: link 1 (attempt 1) is an ABA that comes BACK; the single-file link then leaves HEAD-only and never returns.
  const GATE_2STEP = "pnpm build && node packages/daemon/test/flaky-mid.mjs";
  const { db, mgrId, workerId, worktreePath, branch, t1 } = await setup(sfxOf("comp"), { plant: true, gateCommand: GATE_2STEP });
  let calls = 0;
  const genuine = { passed: false, failedStep: "node packages/daemon/test/flaky-mid.mjs", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "FAIL  flaky-mid", failingTest: "FAIL  flaky-mid", failingTestCount: 1, failTierTest: "FAIL  flaky-mid", failTierTestCount: 1, failTierAll: ["FAIL  flaky-mid"], steps: [{ step: "pnpm build", durationMs: 1, status: 0 }, { step: "node packages/daemon/test/flaky-mid.mjs", durationMs: 1, status: 1 }] };
  const sessions = svc(db, async (_c, cwd) => {
    const n = ++calls;
    if (n === 1) { fs.writeFileSync(path.join(cwd, "t2.txt"), "T2\n"); commitAll(cwd, "t2", GIT_ID); execSync(`git reset --hard ${t1}`, { cwd, stdio: "ignore" }); return genuine; }
    if (n === 2) { execSync("git checkout -q --detach", { cwd, stdio: "ignore" }); fs.writeFileSync(path.join(cwd, "t3.txt"), "T3\n"); commitAll(cwd, "t3", GIT_ID); }
    return { passed: false, failedStep: "node packages/daemon/scripts/test-daemon.mjs --only=flaky-mid", failedStatus: 1, failedSignal: null, failedTimedOut: false, steps: [] };
  });
  const r1 = await confirm(sessions, mgrId, workerId);
  check("(C) op 1 settled + rejected after exactly 2 gate calls (attempt 1 + the single-file link)", r1.settled === true && r1.ok && r1.value.merged === false && calls === 2);
  execSync(`git checkout -q ${branch}`, { cwd: worktreePath, stdio: "ignore" });
  const before = calls;
  const r2 = await confirm(sessions, mgrId, workerId);
  check("(C) the re-call RE-GATES (no cacheHit, a further gate call)", r2.settled === true && r2.cacheHit === undefined && calls > before);
}
{
  // (R) reverse composition: attempt 1 leaves HEAD-only (detached T3, never returns); the single-file link runs clean ON T3 while gatedTip is the branch ref T1.
  const GATE_2STEP = "pnpm build && node packages/daemon/test/flaky-mid.mjs";
  const { db, mgrId, workerId, worktreePath, branch } = await setup(sfxOf("rev"), { plant: true, gateCommand: GATE_2STEP });
  let calls = 0;
  const genuine = { passed: false, failedStep: "node packages/daemon/test/flaky-mid.mjs", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "FAIL  flaky-mid", failingTest: "FAIL  flaky-mid", failingTestCount: 1, failTierTest: "FAIL  flaky-mid", failTierTestCount: 1, failTierAll: ["FAIL  flaky-mid"], steps: [{ step: "pnpm build", durationMs: 1, status: 0 }, { step: "node packages/daemon/test/flaky-mid.mjs", durationMs: 1, status: 1 }] };
  const sessions = svc(db, async (_c, cwd) => {
    const n = ++calls;
    if (n === 1) { execSync("git checkout -q --detach", { cwd, stdio: "ignore" }); fs.writeFileSync(path.join(cwd, "t3.txt"), "T3\n"); commitAll(cwd, "t3", GIT_ID); return genuine; }
    return { passed: false, failedStep: "node packages/daemon/scripts/test-daemon.mjs --only=flaky-mid", failedStatus: 1, failedSignal: null, failedTimedOut: false, steps: [] };
  });
  const r1 = await confirm(sessions, mgrId, workerId);
  check("(R) op 1 settled + rejected after exactly 2 gate calls (attempt 1 + the single-file link)", r1.settled === true && r1.ok && r1.value.merged === false && calls === 2);
  check("(R) setup: the worktree HEAD is still detached off the branch ref", headOf(worktreePath) !== execSync(`git rev-parse ${branch}`, { cwd: worktreePath, encoding: "utf8" }).trim());
  execSync(`git checkout -q ${branch}`, { cwd: worktreePath, stdio: "ignore" });
  const before = calls;
  const r2 = await confirm(sessions, mgrId, workerId);
  check("(R) the re-call RE-GATES (no cacheHit, a further gate call)", r2.settled === true && r2.cacheHit === undefined && calls > before);
  check("(R) op 1 carries gateIdentityVoid", r1.ok && r1.value.gateIdentityVoid === true);
}
{
  // (DP) a COMPOSED PASS: an EARLIER link starts on a never-moving detached HEAD (T3), the worker re-attaches the branch BETWEEN links, and the final single-file link
  // starts clean and passes. The steps that passed on link 1 were earned on T3, not on the T1 the squash would land, so the PASS must be refused.
  const GATE_2STEP = "pnpm build && node packages/daemon/test/flaky-mid.mjs";
  const { db, mgrId, workerId, repo, worktreePath, branch } = await setup(sfxOf("dp"), { plant: true, gateCommand: GATE_2STEP });
  execSync("git checkout -q --detach", { cwd: worktreePath, stdio: "ignore" });
  fs.writeFileSync(path.join(worktreePath, "t3.txt"), "T3\n"); commitAll(worktreePath, "t3", GIT_ID);
  const t3 = headOf(worktreePath);
  let calls = 0, snaps = 0;
  const genuine = { passed: false, failedStep: "node packages/daemon/test/flaky-mid.mjs", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "FAIL  flaky-mid", failingTest: "FAIL  flaky-mid", failingTestCount: 1, failTierTest: "FAIL  flaky-mid", failTierTestCount: 1, failTierAll: ["FAIL  flaky-mid"], steps: [{ step: "pnpm build", durationMs: 1, status: 0 }, { step: "node packages/daemon/test/flaky-mid.mjs", durationMs: 1, status: 1 }] };
  const sessions = svc(db, async () => (++calls === 1 ? genuine : { passed: true, steps: [{ step: "node packages/daemon/scripts/test-daemon.mjs --only=flaky-mid", durationMs: 1, status: 0 }] }), {
    // snapshot #1 = link 1's capture, #2 = link 1's settle, #3 = link 2's capture: re-attach the branch (a worker acting BETWEEN links) just before #3.
    snapshotGateReflogs: async (...a) => { if (++snaps === 3) execSync(`git checkout -q ${branch}`, { cwd: worktreePath, stdio: "ignore" }); return snapshotGateReflogs(...a); },
  });
  const r1 = await confirm(sessions, mgrId, workerId);
  check("(DP) setup: both links ran (attempt 1 FAIL + the single-file link PASS)", r1.settled === true && r1.ok && calls === 2);
  check("(DP) the composed PASS is REFUSED as gateTipMoved (not merged)", r1.ok && r1.value.merged === false && !!r1.value.gateTipMoved);
  check("(DP) main did NOT receive the T1 content the first link never ran on", !fs.existsSync(path.join(repo, "feature.txt")));
  check("(DP) the worktree is retained and the T3 commit exists", fs.existsSync(worktreePath) && (() => { try { return execSync(`git cat-file -t ${t3}`, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "commit"; } catch { return false; } })());
}
{
  // (TR) positive control for the transient whole-gate re-pin reset: link 1 starts on a never-moving detached T3, the worker re-attaches the branch between
  // links, and a TRANSIENT whole re-run (link 1 was SIGKILLed) on the re-attached branch PASSES. A whole re-run is complete evidence for its own tip, so this MERGES;
  // without the sticky-state reset at the re-pin, link 1's detached start would refuse it.
  const { db, mgrId, workerId, repo, worktreePath, branch } = await setup(sfxOf("tr"));
  execSync("git checkout -q --detach", { cwd: worktreePath, stdio: "ignore" });
  fs.writeFileSync(path.join(worktreePath, "t3.txt"), "T3"); commitAll(worktreePath, "t3", GIT_ID);
  let calls = 0, snaps = 0;
  const killed = { passed: false, failedStep: "pnpm gate", failedStatus: null, failedSignal: "SIGKILL", failedTimedOut: false, steps: [] };
  const sessions = svc(db, async () => (++calls === 1 ? killed : { passed: true, steps: [] }), {
    snapshotGateReflogs: async (...a) => { if (++snaps === 3) execSync(`git checkout -q ${branch}`, { cwd: worktreePath, stdio: "ignore" }); return snapshotGateReflogs(...a); },
  });
  const r1 = await confirm(sessions, mgrId, workerId);
  check("(TR) the transient whole re-run on the re-attached branch PASSES and MERGES", r1.settled === true && r1.ok && calls === 2 && r1.value.merged === true && fs.existsSync(path.join(repo, "feature.txt")));
}
for (const db of openDbs) { try { db.close(); } catch { /* already closed */ } }
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
