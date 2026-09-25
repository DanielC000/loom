import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 01777ceb — a gate FAIL earned while the branch tip / worktree HEAD LEFT the gated commit must never be replayed from the
// verdict cache at an identity it was not earned on. Follow-up to 94c28d2a (which closed only the RETURNING round trip):
//   (P1) a plain branch move (T1→T2 on the branch, main NOT advanced), then the worker resets to T1 after settle: the re-call must re-gate.
//   (P2) a HEAD-only move that never returns (detached at T3, branch ref still T1), then the worktree is put back: the re-call must re-gate.
//   (U)  an UNREADABLE reflog snapshot on a FAIL is "could not verify", never "moved": no gateRoundTripFail, gateTipUnverified set, not cached.
//   (D)  a worktree detached BEFORE the gate starts: a PASS is refused (the gate ran on T3; squashing the branch ref would land never-gated T1 content).
//   (UP) / (UPre) / (UP2) unreadable-reflog and unreadable-branch-read PASS/FAIL: "could not be verified", never movedAndBack, never cached.
//   (X)  controls: a clean FAIL is still a cache hit; a plain move that STAYS at T2 keeps announcing identity-mismatch on the re-call.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-fail-identity-void.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { settleTracked } from "./_settle-tracked.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mcfiv-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);
process.env.LOOM_GATE_RETRY_SETTLE_MS = "1";
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mcfiv-nonexistent-codex");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, snapshotGateReflogs } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mcfiv@loom -c user.name=mcfiv";
const now = new Date().toISOString();
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() { return { delivered: true }; }, getPid() { return undefined; } };
const openDbs = [];
const noReap = async () => ({ killedPids: [] });
const FAIL = { passed: false, failedStep: "test", failedStatus: 1, steps: [] };
const sfxOf = (tag) => `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const confirm = (sessions, mgrId, workerId) => settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirmWorkerMergeTracked" });
const headOf = (cwd) => execSync("git rev-parse HEAD", { cwd, encoding: "utf8" }).trim();

async function setup(sfx, { plant = false, gateCommand = "pnpm gate" } = {}) {
  const reposDir = path.join(os.tmpdir(), `loom-mcfiv-${sfx}`);
  registerForCleanup(reposDir);
  const db = new Db(); openDbs.push(db);
  const mgrId = `mcfiv-mgr-${sfx}`, projId = `mcfiv-p-${sfx}`, taskId = `mcfiv-t-${sfx}`, workerId = `mcfiv-w-${sfx}`;
  const repo = path.join(reposDir, "repo");
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mcfiv\n");
  execSync("git init -q && git config user.email mcfiv@loom && git config user.name mcfiv", { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  db.insertProject({ id: projId, name: "MCFIV", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-mcfiv-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mcfiv-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-mcfiv-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
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
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mcfiv-w-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: wt.worktreePath, branch: wt.branch });
  return { db, mgrId, workerId, repo, worktreePath: wt.worktreePath, branch: wt.branch, t1: headOf(wt.worktreePath) };
}
const svc = (db, runGate, extra = {}) => new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 60_000, reapWorktreeProcesses: noReap, runGate, ...extra });

{
  // (P1) plain branch move, main not advanced: the red was earned on T1/T2 content; a reset to T1 after settle must not resurrect a cacheHit at T1.
  const { db, mgrId, workerId, worktreePath, t1 } = await setup(sfxOf("p1"));
  let calls = 0;
  const sessions = svc(db, async (_c, cwd) => { if (++calls === 1) { fs.writeFileSync(path.join(cwd, "t2.txt"), "T2\n"); commitAll(cwd, "t2", GIT_ID); } return FAIL; });
  const r1 = await confirm(sessions, mgrId, workerId);
  check("(P1) op 1 settled + rejected after one gate call", r1.settled === true && r1.ok && r1.value.merged === false && calls === 1);
  execSync(`git reset --hard ${t1}`, { cwd: worktreePath, stdio: "ignore" });
  check("(P1) setup: the tip is back on T1 and main never advanced", headOf(worktreePath) === t1);
  const r2 = await confirm(sessions, mgrId, workerId);
  check("(P1) the re-call RE-GATES (2 gate calls, no cacheHit)", r2.settled === true && calls === 2 && r2.cacheHit === undefined);
  check("(P1) op 1 carries gateIdentityVoid (the flag itself, not only its effect)", r1.ok && r1.value.gateIdentityVoid === true && r1.value.gatedIdentity === undefined);
}
{
  // (P2) HEAD-only move that never returns: detached at T3, branch ref still T1 (confirmGatedIdentity compares the branch ref only).
  const { db, mgrId, workerId, worktreePath, branch, t1 } = await setup(sfxOf("p2"));
  let calls = 0;
  const sessions = svc(db, async (_c, cwd) => {
    if (++calls === 1) { execSync("git checkout -q --detach", { cwd, stdio: "ignore" }); fs.writeFileSync(path.join(cwd, "t3.txt"), "T3\n"); commitAll(cwd, "t3", GIT_ID); }
    return FAIL;
  });
  const r1 = await confirm(sessions, mgrId, workerId);
  check("(P2) op 1 settled + rejected", r1.settled === true && r1.ok && r1.value.merged === false && calls === 1);
  execSync(`git checkout -q ${branch}`, { cwd: worktreePath, stdio: "ignore" });
  check("(P2) setup: the branch ref is still T1 (the ref-only identity check cannot see the T3 run)", headOf(worktreePath) === t1);
  const r2 = await confirm(sessions, mgrId, workerId);
  check("(P2) the re-call RE-GATES (2 gate calls, no cacheHit)", r2.settled === true && calls === 2 && r2.cacheHit === undefined);
}
{
  // (U) unreadable reflog snapshot AT SETTLE (the seam returns null components): "could not verify", not "moved and back".
  const { db, mgrId, workerId } = await setup(sfxOf("unread"));
  let calls = 0, snaps = 0;
  const sessions = svc(db, async () => { calls++; return FAIL; }, {
    snapshotGateReflogs: async (...a) => (++snaps === 1 ? snapshotGateReflogs(...a) : { branch: null, head: null }), // 1st = pre-spawn (readable), later = at settle (unreadable)
  });
  const r1 = await confirm(sessions, mgrId, workerId);
  check("(U) op 1 settled + rejected", r1.settled === true && r1.ok && r1.value.merged === false && calls === 1);
  check("(U) NOT mislabelled as a round trip (no gateRoundTripFail)", r1.ok && r1.value.gateRoundTripFail === undefined);
  check("(U) flagged gateTipUnverified", r1.ok && r1.value.gateTipUnverified === true);
  const r2 = await confirm(sessions, mgrId, workerId);
  check("(U) never cached: the re-call re-gates", r2.settled === true && calls === 2 && r2.cacheHit === undefined);
}
{
  // (D) worktree detached BEFORE the gate: gate PASSES on T3 (detached) while the branch ref is T1. Squashing the ref would land never-gated T1 content.
  const { db, mgrId, workerId, repo, worktreePath, branch } = await setup(sfxOf("predetach"));
  execSync("git checkout -q --detach", { cwd: worktreePath, stdio: "ignore" });
  fs.writeFileSync(path.join(worktreePath, "t3.txt"), "T3\n"); commitAll(worktreePath, "t3", GIT_ID);
  const t3 = headOf(worktreePath);
  let calls = 0;
  const sessions = svc(db, async () => { calls++; return { passed: true, steps: [] }; });
  const r1 = await confirm(sessions, mgrId, workerId);
  check("(D) the gate ran once and its PASS was REFUSED (not merged)", r1.settled === true && r1.ok && calls === 1 && r1.value.merged === false);
  check("(D) refused as gateTipMoved headOffBranch: `live` stays the branch tip, the worktree head is its own field", r1.ok && r1.value.gateTipMoved?.headOffBranch === true && r1.value.gateTipMoved.worktreeHead === t3 && r1.value.gateTipMoved.live === r1.value.gateTipMoved.gated && r1.value.gateTipMoved.live !== t3);
  check("(D) main did NOT receive the never-gated T1 content", !fs.existsSync(path.join(repo, "feature.txt")));
  check("(D) the T3 commit still exists and the worktree is retained", fs.existsSync(worktreePath) && (() => { try { return execSync(`git cat-file -t ${t3}`, { cwd: repo, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() === "commit"; } catch { return false; } })());
  if (fs.existsSync(worktreePath)) execSync(`git checkout -q ${branch}`, { cwd: worktreePath, stdio: "ignore" });
  const r2 = await confirm(sessions, mgrId, workerId);
  check("(D) control: once re-attached to the branch, a re-call re-gates and merges", r2.ok && calls === 2 && r2.cacheHit === undefined && r2.value.merged === true && fs.existsSync(path.join(repo, "feature.txt")));
}
{
  // (UP) an unreadable reflog snapshot at settle on a PASS: refused (fail closed) as "could not be verified", NOT labelled movedAndBack.
  const { db, mgrId, workerId, repo } = await setup(sfxOf("upass"));
  let calls = 0, snaps = 0;
  const sessions = svc(db, async () => { calls++; return { passed: true, steps: [] }; }, {
    snapshotGateReflogs: async (...a) => (++snaps === 1 ? snapshotGateReflogs(...a) : { branch: null, head: null }),
  });
  const r1 = await confirm(sessions, mgrId, workerId);
  check("(UP) the PASS is refused, nothing squashed", r1.settled === true && r1.ok && r1.value.merged === false && !fs.existsSync(path.join(repo, "feature.txt")));
  check("(UP) NOT labelled movedAndBack, and worded as could-not-be-verified", r1.ok && !!r1.value.gateTipMoved && r1.value.gateTipMoved.movedAndBack === undefined && /could not be verified/.test(r1.value.reason ?? ""));
}
{
  // (UPre) the pre-spawn branch read fails (gatedTip undefined): "could not verify" on both sides. The worktree is detached at T1 (== the ref, so ON the branch),
  // and the seam renames the branch just before captureGatedTip resolves it.
  for (const side of ["FAIL", "PASS"]) {
    const { db, mgrId, workerId, repo, worktreePath, branch } = await setup(sfxOf(`upre-${side}`));
    execSync("git checkout -q --detach", { cwd: worktreePath, stdio: "ignore" });
    let snaps = 0;
    const sessions = svc(db, async () => (side === "PASS" ? { passed: true, steps: [] } : FAIL), {
      snapshotGateReflogs: async (...a) => { if (++snaps === 1) execSync(`git branch -m ${branch} ${branch}-gone`, { cwd: repo, stdio: "ignore" }); return snapshotGateReflogs(...a); },
    });
    const r1 = await confirm(sessions, mgrId, workerId);
    if (side === "FAIL") check("(UPre) FAIL: flagged gateTipUnverified AND void-identity (never cached at the fallback sha)", r1.settled === true && r1.ok && r1.value.merged === false && r1.value.gateTipUnverified === true && r1.value.gateIdentityVoid === true);
    else check("(UPre) PASS: refused as could-not-be-verified, nothing squashed", r1.settled === true && r1.ok && r1.value.merged === false && !!r1.value.gateTipMoved && /could not be verified/.test(r1.value.reason ?? "") && !fs.existsSync(path.join(repo, "feature.txt")));
  }
}
{
  // (UP2) the PASS-side unreadable-reflog refusal is never cached: once the reflog is readable again the re-call re-gates and merges.
  const { db, mgrId, workerId, repo } = await setup(sfxOf("up2"));
  let calls = 0, snaps = 0, unreadable = true;
  const sessions = svc(db, async () => { calls++; return { passed: true, steps: [] }; }, {
    snapshotGateReflogs: async (...a) => (unreadable && ++snaps > 1 ? { branch: null, head: null } : snapshotGateReflogs(...a)),
  });
  const r1 = await confirm(sessions, mgrId, workerId);
  check("(UP2) op 1: the unreadable-reflog PASS is refused", r1.settled === true && r1.ok && r1.value.merged === false && calls === 1);
  unreadable = false;
  const r2 = await confirm(sessions, mgrId, workerId);
  check("(UP2) the re-call RE-GATES (2 gate calls, no cacheHit) and merges", r2.ok && calls === 2 && r2.cacheHit === undefined && r2.value.merged === true && fs.existsSync(path.join(repo, "feature.txt")));
}
{
  // (X1) control: a clean FAIL (no movement, readable reflogs) is still a cache hit — the fix must not disable caching wholesale.
  const { db, mgrId, workerId } = await setup(sfxOf("clean"));
  let calls = 0;
  const sessions = svc(db, async () => { calls++; return FAIL; });
  await confirm(sessions, mgrId, workerId);
  const r2 = await confirm(sessions, mgrId, workerId);
  check("(X1) control: a clean FAIL re-call is a cache hit with no further gate call", r2.settled === true && calls === 1 && r2.cacheHit !== undefined);
  check("(X1) control: a clean FAIL carries no gateIdentityVoid / gateTipUnverified", r2.ok && r2.value.gateIdentityVoid === undefined && r2.value.gateTipUnverified === undefined);
}
{
  // (X2) control: a plain move that STAYS at T2 still announces identity-mismatch on the re-call (the announcement the older verdict-cache tests rely on).
  const { db, mgrId, workerId } = await setup(sfxOf("stay"));
  let calls = 0;
  const sessions = svc(db, async (_c, cwd) => { if (++calls === 1) { fs.writeFileSync(path.join(cwd, "t2.txt"), "T2\n"); commitAll(cwd, "t2", GIT_ID); } return FAIL; });
  await confirm(sessions, mgrId, workerId);
  const r2 = await confirm(sessions, mgrId, workerId);
  check("(X2) control: the re-call re-gates and announces identity-mismatch", r2.settled === true && calls === 2 && r2.freshMint?.reason === "identity-mismatch");
}
for (const db of openDbs) { try { db.close(); } catch { /* already closed */ } }
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
