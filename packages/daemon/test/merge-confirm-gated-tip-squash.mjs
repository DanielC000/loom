import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card c59165b8 — a PASS must never squash a commit that landed on the branch AFTER the gate spawned.
// 975c774b deliberately does not flag a CLEAN head move (8b1fb28f's identity check owns the cache side), but
// mergeBranch resolves the branch tip LIVE at squash time (worktrees.ts, @decision 7efc2bff) and the gate-ran path passes
// no gated tip, so a commit landed mid-gate rode the PASS onto main without ever being gated.
// The gate stub simulates the worker committing extra work to the branch while the gate runs (worktree left CLEAN, so
// 975c774b's dirt stamp does not fire), then passes.
//   (A) gate passes while a new commit lands mid-gate: the ungated commit must NOT be on main.
//       Also: the refusal is flagged gateTipMoved, and a re-call RE-GATES the new tip (never served from cache) and merges it.
//   (D) RETRY-LINK LAUNDERING: attempt 1 (the whole gate) runs on T1 and fails genuinely, the worker commits T2 mid-attempt, the
//       single-file retry re-captures T2, runs ONE file and passes. The pass covers only that file on T2, so T2 must NOT land: the gated tip
//       is PINNED at the whole-gate link, and single-file/resumed links never overwrite it.
//   (B) control: the same flow with no mid-gate commit merges normally (a green control, so (A) is not vacuous).
//   (C) the IN-LOCK half, called directly on mergeBranch (the window between service.ts's pre-check and the lock cannot be hit
//       deterministically through the service): a stale expectedBranchTip refuses with zero side effects; the current tip and an
//       omitted param both merge exactly as before.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-gated-tip-squash.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { settleTracked } from "./_settle-tracked.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mcgt-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mcgt-nonexistent-codex");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, mergeBranch } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mcgt@loom -c user.name=mcgt";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mcgt\n");
  execSync(`git init -q && git config user.email mcgt@loom && git config user.name mcgt`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

async function setupWorkerProject(sfx, { plant } = {}) {
  const reposDir = path.join(os.tmpdir(), `loom-mcgt-${sfx}`);
  registerForCleanup(reposDir);
  const db = new Db(); openDbs.push(db);
  const mgrId = `mcgt-mgr-${sfx}`, projId = `mcgt-p-${sfx}`, taskId = `mcgt-t-${sfx}`, workerId = `mcgt-w-${sfx}`;
  const repo = path.join(reposDir, "repo");
  makeRepo(repo);
  db.insertProject({ id: projId, name: "MCGT", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: "pnpm gate" } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-mcgt-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mcgt-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-mcgt-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MCGT-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  // A second worker on the SAME repo (own task + worktree + distinct file) — used to prove the repo guard was released.
  const makeWorker = async (tag, file) => {
    const tId = `${taskId}-${tag}`, wId = `${workerId}-${tag}`;
    db.insertTask({ id: tId, projectId: projId, title: `MCGT-TASK-${tag}`, body: "", columnKey: "in_progress", position: 2, createdAt: now, updatedAt: now });
    const wt = await createWorktree(repo, projId, tId);
    fs.writeFileSync(path.join(wt.worktreePath, file), "work\n");
    if (plant) { // single-file-retry needs a real-looking test-daemon.mjs + the named test file inside the worktree
      fs.mkdirSync(path.join(wt.worktreePath, "packages", "daemon", "scripts"), { recursive: true });
      fs.writeFileSync(path.join(wt.worktreePath, "packages", "daemon", "scripts", "test-daemon.mjs"), "// stub\n");
      fs.mkdirSync(path.join(wt.worktreePath, "packages", "daemon", "test"), { recursive: true });
      fs.writeFileSync(path.join(wt.worktreePath, "packages", "daemon", "test", `${plant}.mjs`), "// stub\n");
    }
    commitAll(wt.worktreePath, file, GIT_ID);
    db.insertSession({ id: wId, projectId: projId, agentId: `agent-mcgt-w-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: tId, worktreePath: wt.worktreePath, branch: wt.branch });
    return { workerId: wId, worktreePath: wt.worktreePath, branch: wt.branch };
  };
  const { workerId: _w0, worktreePath, branch } = await makeWorker("main", "feature.txt");
  return { db, mgrId, workerId: _w0, repo, worktreePath, branch, makeWorker };
}

// Hermetic seam (also used by merge-gate-reuse-admission.mjs): the real process-table reap costs seconds per op on Windows and is not what this file tests.
const openDbs = []; // every Db this file opens, closed before exit (an open handle stalls LOOM_HOME cleanup with EBUSY retries)
const noReap = async () => ({ killedPids: [] });
const PASS = { passed: true, steps: [] };
const FAIL = { passed: false, failedStep: "test", failedStatus: 1, steps: [] };
const sfxOf = (tag) => `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const confirm = (sessions, mgrId, workerId) => settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirmWorkerMergeTracked" });


{
  const { db, mgrId, workerId, repo, makeWorker } = await setupWorkerProject(sfxOf("moved"));
  let gateCalls = 0, lateOnce = true;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
    runGate: async (_cmd, cwd) => {
      gateCalls++;
      if (lateOnce) { fs.writeFileSync(path.join(cwd, "late.txt"), "landed mid-gate\n"); commitAll(cwd, "late commit", GIT_ID); } // clean tree afterwards: only the branch tip moved
      return { ...PASS, outputTail: "tip-moved-marker" };
    },
  });
  const r1 = await confirm(sessions, mgrId, workerId);
  check("(A) op settled", r1.settled === true && r1.ok === true);
  check("(A) the ungated mid-gate commit is NOT on main", !fs.existsSync(path.join(repo, "late.txt")));
  check("(A) the outcome is not a silent merged:true of a tip the gate never saw", r1.ok && r1.value.merged === false);
  check("(A) the refusal is the distinct gateTipMoved shape naming both tips (pre-squash)", r1.ok && r1.value.gateTipMoved?.phase === "pre-squash" && !!r1.value.gateTipMoved.gated && !!r1.value.gateTipMoved.live && r1.value.gateTipMoved.gated !== r1.value.gateTipMoved.live);
  check("(A) the refusal is not a generic gate failure (no gateDetail)", r1.ok && r1.value.gateDetail === undefined);
  check("(A) the refusal carries the gate's own record (outputTail), like the dirty refusal", r1.ok && /tip-moved-marker/.test(r1.value.outputTail ?? ""));
  // The refusal must have released the repo guard: a same-repo sibling's merge gate is admitted and merges right after it.
  const sib = await makeWorker("sib", "sib.txt");
  lateOnce = false;
  const rs = await confirm(sessions, mgrId, sib.workerId);
  check("(A) guard released: a same-repo sibling confirm right after the refusal is admitted and merges", rs.settled === true && rs.ok && rs.value.merged === true && fs.existsSync(path.join(repo, "sib.txt")));
  gateCalls = 0;
  const r2 = await confirm(sessions, mgrId, workerId);
  check("(A) re-call re-gates the new tip (not served from cache) and merges it", r2.ok && gateCalls === 1 && r2.cacheHit === undefined && r2.value.merged === true && fs.existsSync(path.join(repo, "late.txt")));
}
{
  const { db, mgrId, workerId, repo, worktreePath, branch } = await setupWorkerProject(sfxOf("ctl"));
  void db, void mgrId, void workerId, void worktreePath;
  const git = (a) => execSync("git " + a, { cwd: repo, encoding: "utf8" }).trim();
  const oldTip = git("rev-parse " + branch);
  const r0 = await mergeBranch(repo, branch, "T", {}, undefined, undefined, undefined, "0".repeat(40));
  check("(C) stale expectedBranchTip refuses with branchTipMoved carrying the live tip", r0.ok === false && r0.branchTipMoved?.live === oldTip);
  check("(C) zero side effects: nothing landed, index clean", !fs.existsSync(path.join(repo, "feature.txt")) && git("status --porcelain --untracked-files=no") === "");
  const r1 = await mergeBranch(repo, branch, "T", {}, undefined, undefined, undefined, oldTip);
  check("(C) matching expectedBranchTip merges", r1.ok === true && fs.existsSync(path.join(repo, "feature.txt")));
}
{
  const { db, mgrId, workerId, repo, branch } = await setupWorkerProject(sfxOf("omit"));
  void db, void mgrId, void workerId;
  const r1 = await mergeBranch(repo, branch, "T");
  check("(C) omitted expectedBranchTip behaves as before (merges)", r1.ok === true && fs.existsSync(path.join(repo, "feature.txt")));
}
{
  const { db, mgrId, workerId, repo } = await setupWorkerProject(sfxOf("retry"), { plant: "flaky-one" });
  const genuineFail = { passed: false, failedStep: "pnpm gate", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "", failingTest: "FAIL  flaky-one", failingTestCount: 1, failTierTest: "FAIL  flaky-one", failTierTestCount: 1, failTierAll: ["FAIL  flaky-one"] };
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
    runGate: async (_cmd, cwd) => {
      gateCalls++;
      if (gateCalls === 1) { fs.writeFileSync(path.join(cwd, "t2.txt"), "T2 landed mid-attempt-1\n"); commitAll(cwd, "t2 commit", GIT_ID); return genuineFail; }
      return PASS; // the single-file retry: passes on the moved tip
    },
  });
  const r1 = await confirm(sessions, mgrId, workerId);
  check("(D) the single-file retry ran (2 gate calls) and its pass was refused", gateCalls === 2 && r1.settled === true && r1.ok && r1.value.merged === false && r1.value.retriedFile !== undefined);
  check("(D) refused as gateTipMoved (gated tip pinned at attempt 1, not the retry's re-capture)", r1.ok && r1.value.gateTipMoved?.gated !== r1.value.gateTipMoved?.live && !!r1.value.gateTipMoved);
  check("(D) T2 did NOT land on main", !fs.existsSync(path.join(repo, "t2.txt")) && !fs.existsSync(path.join(repo, "feature.txt")));
}
{
  const { db, mgrId, workerId, repo } = await setupWorkerProject(sfxOf("stable"));
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap, runGate: async () => PASS });
  const r1 = await confirm(sessions, mgrId, workerId);
  check("(B) control: no mid-gate commit merges normally", r1.ok && r1.value.merged === true && fs.existsSync(path.join(repo, "feature.txt")));
}
for (const db of openDbs) { try { db.close(); } catch { /* already closed */ } }
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
