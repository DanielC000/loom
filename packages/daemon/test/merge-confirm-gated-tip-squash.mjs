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
//   (E) RESUMED-LINK LAUNDERING (card b32b6718): as (D) but the gate is a chain whose FIRST step fails, so after the single-file retry
//       passes the remaining steps RESUME as their own link, which also re-captures T2. The pin must survive that link too.
//   (F) TRANSIENT RE-RUN: a kill-class failure + a mid-attempt-1 commit, then a whole-gate transient pass. That link re-runs the WHOLE
//       gate on T2 and RE-PINS (captureGatedTip(true)), so T2 must MERGE; never refused as moved.
//   (G) UNVERIFIABLE PIN: resolveGitRef fails at the attempt-1 capture (the worker row names a branch that resolves to no commit), so
//       nothing is pinned and the PASS is refused with the "could not be verified" wording rather than squashed unchecked.
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
process.env.LOOM_GATE_RETRY_SETTLE_MS = "1"; // transient auto-retry settle wait: not what this file tests
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

async function setupWorkerProject(sfx, { plant, gateCommand = "pnpm gate", rowBranch } = {}) {
  const reposDir = path.join(os.tmpdir(), `loom-mcgt-${sfx}`);
  registerForCleanup(reposDir);
  const db = new Db(); openDbs.push(db);
  const mgrId = `mcgt-mgr-${sfx}`, projId = `mcgt-p-${sfx}`, taskId = `mcgt-t-${sfx}`, workerId = `mcgt-w-${sfx}`;
  const repo = path.join(reposDir, "repo");
  makeRepo(repo);
  db.insertProject({ id: projId, name: "MCGT", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand } }, createdAt: now, archivedAt: null });
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
    db.insertSession({ id: wId, projectId: projId, agentId: `agent-mcgt-w-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: tId, worktreePath: wt.worktreePath, branch: rowBranch ?? wt.branch });
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
  // (E) resumed-remaining-steps link: chain "step1 && step2"; step1 fails genuinely on T1 (T2 committed mid-attempt-1), the single-file
  // retry passes, then step2 resumes and passes. Each link but attempt 1 re-captures T2 UNPINNED, so only the pin keeps T2 off main.
  const { db, mgrId, workerId, repo } = await setupWorkerProject(sfxOf("resume"), { plant: "flaky-one", gateCommand: "pnpm stepone && pnpm steptwo" });
  const genuineFail = { passed: false, failedStep: "pnpm stepone", failedStatus: 1, failedSignal: null, failedTimedOut: false, outputTail: "", failingTest: "FAIL  flaky-one", failingTestCount: 1, failTierTest: "FAIL  flaky-one", failTierTestCount: 1, failTierAll: ["FAIL  flaky-one"], steps: [{ command: "pnpm stepone", passed: false }] };
  const cmds = [];
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
    runGate: async (cmd, cwd) => {
      cmds.push(cmd);
      if (cmds.length === 1) { fs.writeFileSync(path.join(cwd, "t2.txt"), "T2 landed mid-attempt-1\n"); commitAll(cwd, "t2 commit", GIT_ID); return genuineFail; }
      return { passed: true, steps: [{ command: cmd, passed: true }] };
    },
  });
  const r1 = await confirm(sessions, mgrId, workerId);
  check("(E) all three links ran (attempt 1, single-file retry, resumed steps)", cmds.length === 3 && /steptwo/.test(cmds[2]) && !/stepone/.test(cmds[2]));
  check("(E) the resumed pass was refused (merged:false)", r1.settled === true && r1.ok && r1.value.merged === false);
  check("(E) refused as gateTipMoved, gated tip still pinned at attempt 1", r1.ok && !!r1.value.gateTipMoved && !!r1.value.gateTipMoved.gated && r1.value.gateTipMoved.gated !== r1.value.gateTipMoved.live);
  check("(E) T2 did NOT land on main", !fs.existsSync(path.join(repo, "t2.txt")) && !fs.existsSync(path.join(repo, "feature.txt")));
}
{
  // (F) transient re-run: the kill-class failure is followed by a WHOLE-gate re-run on T2, which re-pins, so T2 merges.
  const { db, mgrId, workerId, repo } = await setupWorkerProject(sfxOf("transient"));
  const killed = { passed: false, failedStep: "pnpm gate", failedStatus: null, failedSignal: "SIGKILL", failedTimedOut: false, outputTail: "", steps: [] };
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
    runGate: async (_cmd, cwd) => {
      gateCalls++;
      if (gateCalls === 1) { fs.writeFileSync(path.join(cwd, "t2.txt"), "T2 landed mid-attempt-1\n"); commitAll(cwd, "t2 commit", GIT_ID); return killed; }
      return PASS;
    },
  });
  const r1 = await confirm(sessions, mgrId, workerId);
  check("(F) the transient whole-gate re-run happened (2 gate calls)", gateCalls === 2);
  check("(F) the re-run's pass MERGES the new tip (re-pinned at the transient link)", r1.settled === true && r1.ok && r1.value.merged === true && r1.value.gateTipMoved === undefined);
  check("(F) T2 (the mid-attempt-1 commit) landed on main, along with the original work", fs.existsSync(path.join(repo, "t2.txt")) && fs.existsSync(path.join(repo, "feature.txt")));
}
{
  // (G) the row's branch resolves to no commit, so `resolveGitRef` returns null at the attempt-1 capture: nothing pinned.
  const { db, mgrId, workerId, repo } = await setupWorkerProject(sfxOf("unpinned"), { rowBranch: "loom/does-not-exist" });
  let gateCalls = 0;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap, runGate: async () => { gateCalls++; return PASS; } });
  const r1 = await confirm(sessions, mgrId, workerId);
  check("(G) the gate ran (so the refusal is the post-gate tip check, not an earlier one)", gateCalls === 1 && r1.ok && r1.value.gateRan === true);
  check("(G) refused, nothing landed", r1.settled === true && r1.ok && r1.value.merged === false && !fs.existsSync(path.join(repo, "feature.txt")));
  check('(G) refusal carries the "could not be verified" wording and an unreadable gated tip', r1.ok && /could not be verified/.test(r1.value.reason ?? "") && r1.value.gateTipMoved?.gated === null);
}
{
  const { db, mgrId, workerId, repo } = await setupWorkerProject(sfxOf("stable"));
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap, runGate: async () => PASS });
  const r1 = await confirm(sessions, mgrId, workerId);
  check("(B) control: no mid-gate commit merges normally", r1.ok && r1.value.merged === true && fs.existsSync(path.join(repo, "feature.txt")));
}
{
  // (H) ABA (card d099087f): the tip moves T1→T2 and BACK to T1 inside the gate. The settle head equals the pre-spawn head and the live tip
  // equals the pinned one, so neither a head compare nor c59165b8's pinned-tip check can see it; the PASS ran on mixed T1/T2 content.
  const { db, mgrId, workerId, repo, worktreePath, branch } = await setupWorkerProject(sfxOf("aba"));
  const t1 = execSync("git rev-parse HEAD", { cwd: worktreePath, encoding: "utf8" }).trim();
  let gateCalls = 0, mode = "aba";
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
    runGate: async (_cmd, cwd) => {
      gateCalls++;
      if (mode === "aba") { fs.writeFileSync(path.join(cwd, "t2.txt"), "T2\n"); commitAll(cwd, "t2 commit", GIT_ID); execSync(`git reset --hard ${t1}`, { cwd, stdio: "ignore" }); }
      if (mode === "noop") execSync("git reset --hard HEAD", { cwd, stdio: "ignore" }); // reflog entry, but the tip never left T1
      return { ...PASS, outputTail: "aba-marker" };
    },
  });
  const revOf = (ref) => { try { return execSync(`git rev-parse ${ref}`, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); } catch { return null; } }; // null, not a throw, if the branch is gone: a RED must print its FAILs
  check("(H) precondition: the worktree ref is on T1 before the gate", revOf(branch) === t1);
  const r1 = await confirm(sessions, mgrId, workerId);
  check("(H) op settled, the PASS is refused (nothing squashed)", r1.settled === true && r1.ok && r1.value.merged === false && !fs.existsSync(path.join(repo, "feature.txt")));
  check("(H) the tip really is back on T1 (live == pinned: the ABA shape, not a plain move)", revOf(branch) === t1);
  check("(H) refused as gateTipMoved flagged movedAndBack, gated == live", r1.ok && r1.value.gateTipMoved?.movedAndBack === true && r1.value.gateTipMoved.gated === r1.value.gateTipMoved.live && r1.value.gateTipMoved.gated === t1);
  check("(H) the refusal carries the gate's own record and no gateDetail", r1.ok && /aba-marker/.test(r1.value.outputTail ?? "") && r1.value.gateDetail === undefined);
  check("(H) a merge_rejected gate_tip_moved event names movedAndBack", db.listEvents(mgrId).some((e) => e.kind === "merge_rejected" && e.detail?.reason === "gate_tip_moved" && e.detail?.movedAndBack === true));
  mode = "none"; gateCalls = 0;
  const r2 = await confirm(sessions, mgrId, workerId);
  check("(H) never cached: a re-call re-gates for real and merges T1", r2.ok && gateCalls === 1 && r2.cacheHit === undefined && r2.value.merged === true && fs.existsSync(path.join(repo, "feature.txt")) && !fs.existsSync(path.join(repo, "t2.txt")));
}
{
  // (I) control: a reflog-only event that never moves the tip (`git reset --hard HEAD`) must NOT trip the ABA refusal.
  const { db, mgrId, workerId, repo, worktreePath } = await setupWorkerProject(sfxOf("noop"));
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
    runGate: async (_cmd, cwd) => { execSync("git reset --hard HEAD", { cwd, stdio: "ignore" }); return PASS; },
  });
  void worktreePath;
  const r1 = await confirm(sessions, mgrId, workerId);
  check("(I) control: a no-op reset inside the gate does not refuse the pass", r1.ok && r1.value.merged === true && fs.existsSync(path.join(repo, "feature.txt")));
}
{
  // (J) HEAD-ONLY ABA: detach → commit → checkout the branch back. Writes NO refs/heads/<branch> reflog entry (asserted below), so only the
  // worktree's own HEAD reflog can see it. Same shape as (H) otherwise: settle head == pre-spawn head, live tip == pinned tip.
  const { db, mgrId, workerId, repo, worktreePath, branch } = await setupWorkerProject(sfxOf("headaba"));
  const branchReflog = () => { try { return execSync(`git reflog show --format=%H refs/heads/${branch}`, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }); } catch { return null; } };
  let reflogBefore = null, reflogAfter = null;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
    runGate: async (_cmd, cwd) => {
      reflogBefore = branchReflog();
      execSync("git checkout -q --detach", { cwd, stdio: "ignore" });
      fs.writeFileSync(path.join(cwd, "t2.txt"), "T2\n"); commitAll(cwd, "t2 detached commit", GIT_ID);
      execSync(`git checkout -q ${branch}`, { cwd, stdio: "ignore" });
      reflogAfter = branchReflog();
      return { ...PASS, outputTail: "head-aba-marker" };
    },
  });
  const r1 = await confirm(sessions, mgrId, workerId);
  check("(J) instrument check: the branch reflog did NOT change (a branch-reflog-only detector is blind to this shape)", reflogBefore !== null && reflogBefore === reflogAfter);
  check("(J) the HEAD-only round trip is refused as gateTipMoved movedAndBack, nothing squashed", r1.settled === true && r1.ok && r1.value.merged === false && r1.value.gateTipMoved?.movedAndBack === true && !fs.existsSync(path.join(repo, "feature.txt")));
  check("(J) T2 (the detached commit) is not on main", !fs.existsSync(path.join(repo, "t2.txt")));
  void worktreePath;
}
{
  // (K) REUSE PATH: a `run_gate` self-check whose own gate saw a tip round trip must NOT be reusable. Head stamps at start/admit/settle all
  // agree (same head), so before this fix headCurrent was true and the merge reused the green without re-gating.
  const { db, mgrId, workerId, repo, branch: wbranch } = await setupWorkerProject(sfxOf("reuse-aba"));
  let gateCalls = 0, doAba = true;
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
    runGate: async (_cmd, cwd) => {
      gateCalls++;
      if (doAba) { execSync("git checkout -q --detach", { cwd, stdio: "ignore" }); fs.writeFileSync(path.join(cwd, "t2.txt"), "T2\n"); commitAll(cwd, "t2", GIT_ID); execSync(`git checkout -q ${wbranch}`, { cwd, stdio: "ignore" }); }
      return PASS;
    },
  });
  const sc = await sessions.runWorkerGate(workerId);
  check("(K) precondition: the self-check settled green", sc.settled === true && sc.ok === true && sc.value.passed === true && gateCalls === 1);
  check("(K) the self-check result is headCurrent:false with a warning naming the round trip", sc.ok && sc.value.headCurrent === false && /came back/.test(sc.value.headWarning ?? ""));
  doAba = false;
  const cm = await confirm(sessions, mgrId, workerId);
  check("(K) the merge did NOT reuse the self-check: it re-gated (2 gate calls, no reusedOpId)", gateCalls === 2 && cm.ok && cm.value.reusedOpId === undefined && cm.value.merged === true && fs.existsSync(path.join(repo, "feature.txt")));
}
for (const db of openDbs) { try { db.close(); } catch { /* already closed */ } }
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
