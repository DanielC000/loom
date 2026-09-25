import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card d099087f — a gate PASS must be refused when the branch tip / worktree HEAD LEFT the gated commit during the gate and came back (ABA),
// which neither a head compare nor c59165b8's pinned-tip check can see. Split out of merge-confirm-gated-tip-squash.mjs (which hit the per-file ceiling).
//   (H) branch-ref ABA (commit T2, reset --hard T1) refused as gateTipMoved movedAndBack, never cached, a re-call re-gates and merges.
//   (I) control: a no-op `git reset --hard HEAD` inside the gate does not refuse.
//   (J) HEAD-only ABA (detach, commit, checkout back): writes no branch reflog entry, so only the worktree HEAD reflog sees it.
//   (L) a HEAD-only move that never returns is refused but NOT labelled movedAndBack.
//   (K) a run_gate self-check that saw a round trip is headCurrent:false and is not reused by the merge.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-gate-tip-round-trip.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { settleTracked } from "./_settle-tracked.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mcgtrt-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);
process.env.LOOM_GATE_RETRY_SETTLE_MS = "1"; // transient auto-retry settle wait: not what this file tests
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mcgtrt-nonexistent-codex");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mcgtrt@loom -c user.name=mcgtrt";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mcgt\n");
  execSync(`git init -q && git config user.email mcgtrt@loom && git config user.name mcgt`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

async function setupWorkerProject(sfx, { plant, gateCommand = "pnpm gate", rowBranch } = {}) {
  const reposDir = path.join(os.tmpdir(), `loom-mcgtrt-${sfx}`);
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
  const { db, mgrId, workerId, repo, branch } = await setupWorkerProject(sfxOf("headaba"));
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
}
{
  // (L) HEAD-only move that does NOT return: the worktree is left detached at T2, the branch ref still T1. Refused, but NOT labelled movedAndBack.
  const { db, mgrId, workerId, repo } = await setupWorkerProject(sfxOf("headleft"));
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap,
    runGate: async (_cmd, cwd) => {
      execSync("git checkout -q --detach", { cwd, stdio: "ignore" });
      fs.writeFileSync(path.join(cwd, "t2.txt"), "T2\n"); commitAll(cwd, "t2 detached commit", GIT_ID);
      return PASS;
    },
  });
  const r1 = await confirm(sessions, mgrId, workerId);
  check("(L) a HEAD-only move that never returns is refused as gateTipMoved", r1.settled === true && r1.ok && r1.value.merged === false && !!r1.value.gateTipMoved && !fs.existsSync(path.join(repo, "feature.txt")));
  check("(L) it is NOT labelled movedAndBack and names the worktree HEAD it was left on", r1.ok && r1.value.gateTipMoved?.movedAndBack === undefined && r1.value.gateTipMoved?.gated !== r1.value.gateTipMoved?.live && !!r1.value.gateTipMoved?.live);
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
