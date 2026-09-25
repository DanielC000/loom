import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 01777ceb — the run_gate self-check / REUSE side of the "did the gate run on the commit its verdict names?" rule (split off merge-confirm-fail-identity-void.mjs):
//   (DR)   a self-check that PASSED on a detached worktree is headCurrent:false and is never reused; the merge re-gates and refuses that PASS.
//   (RP)   the REUSE squash is pinned to the tip the reuse proof saw: a commit landing after the decision but before mergeBranch's lock is refused in-lock.
//   (BELT) the reuse proof's own head-off-branch condition, isolated from the settle-time check (+ BELT-U: head-off-branch-unknown).
//   (RU)   card c3e1bfc3 — an unreadable reflog on the run_gate self-check is "could not verify", never "moved and came back".
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-reuse-head-rule.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { settleTracked } from "./_settle-tracked.mjs";
import { waitUntil } from "./_wait.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mcrhr-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);
process.env.LOOM_GATE_RETRY_SETTLE_MS = "1";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mcrhr-nonexistent-codex");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, snapshotGateReflogs } = await import("../dist/git/worktrees.js");
const { withCanonicalIndexLock } = await import("../dist/git/repo-lock.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mcrhr@loom -c user.name=mcrhr";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
const openDbs = [];
const noReap = async () => ({ killedPids: [] });
const FAIL = { passed: false, failedStep: "test", failedStatus: 1, steps: [] };
const sfxOf = (tag) => `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const confirm = (sessions, mgrId, workerId) => settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirmWorkerMergeTracked" });
const headOf = (cwd) => execSync("git rev-parse HEAD", { cwd, encoding: "utf8" }).trim();

async function setup(sfx, { plant = false, gateCommand = "pnpm gate" } = {}) {
  const reposDir = path.join(os.tmpdir(), `loom-mcrhr-${sfx}`);
  registerForCleanup(reposDir);
  const db = new Db(); openDbs.push(db);
  const mgrId = `mcrhr-mgr-${sfx}`, projId = `mcrhr-p-${sfx}`, taskId = `mcrhr-t-${sfx}`, workerId = `mcrhr-w-${sfx}`;
  const repo = path.join(reposDir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mcrhr\n");
  execSync("git init -q && git config user.email mcrhr@loom && git config user.name mcrhr", { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  db.insertProject({ id: projId, name: "MCFIV", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-mcrhr-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mcrhr-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-mcrhr-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
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
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mcrhr-w-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: wt.worktreePath, branch: wt.branch });
  return { db, mgrId, workerId, repo, worktreePath: wt.worktreePath, branch: wt.branch, t1: headOf(wt.worktreePath) };
}
const svc = (db, runGate, extra = {}) => new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap, runGate, ...extra });

{
  // (DR) the run_gate REUSE path: a self-check that PASSED on a detached worktree (T3, branch ref still T1) must not be reused by the merge.
  const { db, mgrId, workerId, repo, worktreePath } = await setup(sfxOf("dr"));
  execSync("git checkout -q --detach", { cwd: worktreePath, stdio: "ignore" });
  fs.writeFileSync(path.join(worktreePath, "t3.txt"), "T3"); commitAll(worktreePath, "t3", GIT_ID);
  const t3 = headOf(worktreePath);
  let calls = 0;
  const sessions = svc(db, async () => { calls++; return { passed: true, steps: [] }; });
  const sc = await sessions.runWorkerGate(workerId);
  check("(DR) the detached self-check settled green", sc.settled === true && sc.ok === true && sc.value.passed === true && calls === 1);
  check("(DR) run_gate's own result says so: headCurrent:false with a warning naming the branch", sc.ok && sc.value.headCurrent === false && /differed at read time/.test(sc.value.headWarning ?? ""));
  const cm = await confirm(sessions, mgrId, workerId);
  check("(DR) the merge did NOT reuse it and did NOT merge T1", cm.ok && cm.value.reusedOpId === undefined && cm.value.merged === false && !fs.existsSync(path.join(repo, "feature.txt")));
  check("(DR) the merge re-gated for real and refused that PASS as headOffBranch (branch tip stays the live tip, T3 in worktreeHead)", cm.ok && calls === 2 && cm.value.gateTipMoved?.headOffBranch === true && cm.value.gateTipMoved.worktreeHead === t3 && cm.value.gateTipMoved.live !== t3);
  check("(DR) the T3 commit still exists and the worktree is retained", fs.existsSync(worktreePath) && (() => { try { return execSync(`git cat-file -t ${t3}`, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "commit"; } catch { return false; } })());
}
{
  // (RP) the REUSE squash is pinned (975c774b's pin, on the reuse sibling): a worker commit landing AFTER the reuse decision but BEFORE mergeBranch's lock must be refused in-lock,
  // not squashed as an unverified `reused:true`. The canonical index lock is held from the test so the commit lands exactly in that window.
  const { db, mgrId, workerId, repo, worktreePath } = await setup(sfxOf("rp"));
  let calls = 0;
  const sessions = svc(db, async () => { calls++; return { passed: true, steps: [] }; });
  const sc = await sessions.runWorkerGate(workerId);
  check("(RP) precondition: the attached self-check settled green and current (reusable)", sc.settled === true && sc.ok === true && sc.value.passed === true && sc.value.headCurrent === true && calls === 1);
  let release;
  const held = withCanonicalIndexLock(repo, () => new Promise((r) => { release = r; }));
  const confirming = confirm(sessions, mgrId, workerId);
  await waitUntil(() => db.listEvents(mgrId).some((e) => e.kind === "build_gate" && e.detail?.reused === true), { timeoutMs: 60000, label: "the reuse decision was recorded" });
  fs.writeFileSync(path.join(worktreePath, "late.txt"), "late"); commitAll(worktreePath, "late worker commit", GIT_ID);
  release(); await held;
  const r1 = await confirming;
  check("(RP) the reused merge was REFUSED in-lock as gateTipMoved (not squashed)", r1.settled === true && r1.ok && r1.value.merged === false && r1.value.gateTipMoved?.phase === "in-lock" && !fs.existsSync(path.join(repo, "feature.txt")) && !fs.existsSync(path.join(repo, "late.txt")));
  check("(RP) it reports gateRan:false + the reused opId (nothing ran) and no gate call was made", r1.ok && r1.value.gateRan === false && !!r1.value.reusedOpId && calls === 1);
  check("(RP) the refusal wording names the reused self-check, not a gate spawn (card 35cfcbe0 nit)", r1.ok && /reused self-check/.test(r1.value.reason ?? "") && !/gate spawned/.test(r1.value.reason ?? ""));
  const rpRej = db.listEvents(mgrId).find((e) => e.kind === "merge_rejected" && e.detail?.reason === "gate_tip_moved");
  check("(RP) the merge_rejected event carries reused + reusedOpId (card 35cfcbe0 nit)", rpRej?.detail?.reused === true && typeof rpRej.detail.reusedOpId === "string" && rpRej.detail.reusedOpId === r1.value.reusedOpId);
  const r2 = await confirm(sessions, mgrId, workerId);
  check("(RP) never cached: the re-call re-gates the new tip for real and merges it", r2.ok && calls === 2 && r2.cacheHit === undefined && r2.value.merged === true && fs.existsSync(path.join(repo, "late.txt")));
}
{
  // (BELT) the reuse proof's OWN head-off-branch condition, isolated from the settle-time headCurrent check: the self-check ran ATTACHED at T1 (headCurrent:true), then the worktree is
  // detached (HEAD stays T1, stamp unchanged) and the branch ref is moved to T2. Only the reuse proof's freshOnBranch can refuse this.
  const { db, mgrId, workerId, repo, worktreePath, branch, t1 } = await setup(sfxOf("belt"));
  let calls = 0;
  const sessions = svc(db, async () => { calls++; return { passed: true, steps: [] }; });
  const sc = await sessions.runWorkerGate(workerId);
  check("(BELT) precondition: the self-check settled green and current", sc.settled === true && sc.ok === true && sc.value.headCurrent === true);
  execSync("git checkout -q --detach", { cwd: worktreePath, stdio: "ignore" });
  const tree = execSync(`git rev-parse ${t1}:`, { cwd: repo, encoding: "utf8" }).trim();
  const t2 = execSync(`git ${GIT_ID} commit-tree ${tree} -p ${t1} -m never-gated`, { cwd: repo, encoding: "utf8" }).trim();
  execSync(`git branch -f ${branch} ${t2}`, { cwd: repo, stdio: "ignore" });
  check("(BELT) setup: the worktree HEAD is still T1 while the branch ref is T2", headOf(worktreePath) === t1 && execSync(`git rev-parse ${branch}`, { cwd: repo, encoding: "utf8" }).trim() === t2);
  const cm = await confirm(sessions, mgrId, workerId);
  const bg = db.listEvents(mgrId).find((e) => e.kind === "build_gate");
  check("(BELT) the merge did NOT reuse the self-check", cm.ok && cm.value.reusedOpId === undefined && calls === 2);
  check("(BELT) reuseRefusalReasons names head-off-branch", Array.isArray(bg?.detail?.reuseRefusalReasons) && bg.detail.reuseRefusalReasons.includes("head-off-branch"));
  check("(BELT) nothing was squashed", cm.ok && cm.value.merged === false && !fs.existsSync(path.join(repo, "feature.txt")));
}
{
  // (BELT-U) the unverified twin: the branch ref cannot be read at confirm time (renamed away) while the worktree is detached at T1 ⇒ head-off-branch-unknown.
  const { db, mgrId, workerId, repo, worktreePath, branch } = await setup(sfxOf("beltu"));
  const sessions = svc(db, async () => ({ passed: true, steps: [] }));
  const sc = await sessions.runWorkerGate(workerId);
  check("(BELT-U) precondition: the self-check settled green and current", sc.settled === true && sc.ok === true && sc.value.headCurrent === true);
  execSync("git checkout -q --detach", { cwd: worktreePath, stdio: "ignore" });
  execSync(`git branch -m ${branch} ${branch}-gone`, { cwd: repo, stdio: "ignore" });
  await confirm(sessions, mgrId, workerId).catch(() => undefined);
  const bg = db.listEvents(mgrId).find((e) => e.kind === "build_gate");
  check("(BELT-U) reuseRefusalReasons names head-off-branch-unknown (and not head-off-branch)", Array.isArray(bg?.detail?.reuseRefusalReasons) && bg.detail.reuseRefusalReasons.includes("head-off-branch-unknown") && !bg.detail.reuseRefusalReasons.includes("head-off-branch"));
}
{
  // (RU) card c3e1bfc3 — run_gate's own currency: an UNREADABLE reflog at settle is "could not verify", never "moved and came back".
  const { db, workerId } = await setup(sfxOf("ru"));
  let snaps = 0;
  const sessions = svc(db, async () => ({ passed: true, steps: [] }), {
    snapshotGateReflogs: async (...a) => (++snaps === 1 ? snapshotGateReflogs(...a) : { branch: null, head: null }),
  });
  const sc = await sessions.runWorkerGate(workerId);
  check("(RU) the self-check settled green but headCurrent:false", sc.settled === true && sc.ok === true && sc.value.passed === true && sc.value.headCurrent === false);
  check("(RU) the warning says could-not-verify, NOT round trip", sc.ok && /could not read the branch\/worktree reflog/.test(sc.value.headWarning ?? "") && !/came back/.test(sc.value.headWarning ?? ""));
}
for (const db of openDbs) { try { db.close(); } catch { /* already closed */ } }
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
