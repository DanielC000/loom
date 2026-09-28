import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// A BATCH/SOLO RETAIN HOLD IS SCOPED TO ITS REPO (card a5be590f, from the round-6 review of card 42daa283). The branch name is `loom/` + sha256(taskId)[:12]:
// unique per task but with NO repo axis, so a task retargeted to a second repo (a `repoKey` change) and re-spawned gets the SAME branch name there.
//   (inherit)  repo 2 must not INHERIT repo 1's hold: the branch is not held when asked about repo 2.
//   (release)  repo 2's confirm `merge_done` must not RELEASE repo 1's still-held branch (the worse half: repo 1's late commit would then be exposed to
//              boot Pass A's content-fooled finalize, which deletes the branch and force-removes the worktree).
//   (scope)    the in-scope releases still work: a newer non-reconciled `merge_done` for the SAME repo releases; an event filed with no repoKey at all
//              (legacy rows) keeps matching by branch only — both as a retain and as a merge_done.
// Fixture: A (repo 1) commits two files; the (idempotent) gate command `git rm`s one of them on A's branch mid-gate ⇒ A retained by a real merge_batch.
// The same task is then cut in repo 2 (key "r2") on the same-named branch and confirmed there.
// Run: 1) pnpm build, 2) node packages/daemon/test/batch-merge-hold-repo-scoped.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-bmhrs-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=bmhrs@loom -c user.name=bmhrs";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// NOTE: `refs/heads/<b>` (never `<b>^{commit}` — cmd.exe treats `^` as its escape char on Windows).
const refExists = (repo, ref) => { try { git(repo, `rev-parse --verify --quiet refs/heads/${ref}`); return true; } catch { return false; } };
const subjects = (repo, ref) => git(repo, `log ${ref} --format=%s`).split("\n");
const noReap = async () => ({ killedPids: [] });
const initRepo = (label) => {
  const r = path.join(os.tmpdir(), `loom-bmhrs-${label}-${sfx}`);
  fs.mkdirSync(r, { recursive: true });
  registerForCleanup(r);
  fs.writeFileSync(path.join(r, "README.md"), `# bmhrs ${label}\n`);
  execSync(`git init -q && git config user.email bmhrs@loom && git config user.name bmhrs`, { cwd: r });
  commitAll(r, "init", GIT_ID);
  return r;
};

const dbs = [];
try {
  const repo1 = initRepo("r1");
  const repo2 = initRepo("r2");

  const projId = `bmhrs-proj-${sfx}`, agentId = `bmhrs-agent-${sfx}`, mgrId = `bmhrs-mgr-${sfx}`;
  const cut = async (label, files, repoPath = repo1, repoKey = null) => {
    const taskId = `bmhrs-task-${label}-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repoPath, projId, taskId, {}, repoKey);
    registerForCleanup(worktreePath);
    for (const f of files) fs.writeFileSync(path.join(worktreePath, f), `work ${label} ${f}\n`);
    commitAll(worktreePath, label, GIT_ID);
    return { taskId, branch, worktreePath };
  };
  const a = await cut("a", ["feature-a.txt", "extra-a.txt"]);
  const b = await cut("b", ["feature-b.txt"]);

  // IDEMPOTENT gate command: while A still carries extra-a.txt, `git rm` it and commit (a late commit that REVERTS part of A's own change).
  const script = path.join(os.tmpdir(), `loom-bmhrs-gate-${sfx}.mjs`);
  registerForCleanup(script);
  fs.writeFileSync(script, [
    `import fs from "node:fs"; import path from "node:path"; import { execSync } from "node:child_process";`,
    `const wt = ${JSON.stringify(a.worktreePath)};`,
    `if (fs.existsSync(path.join(wt, "extra-a.txt"))) {`,
    `  execSync("git rm -q extra-a.txt && git -c user.email=bmhrs@loom -c user.name=bmhrs commit -q -m late-revert", { cwd: wt, stdio: "ignore" });`,
    `}`,
    `process.exit(0);`,
  ].join("\n"));

  const db = new Db(); dbs.push(db);
  db.insertProject({ id: projId, name: "BMHRS", repoPath: repo1, vaultPath: repo1, config: { orchestration: { gateCommand: `node "${script}"` } }, createdAt: now, archivedAt: null });
  db.updateProject(projId, { repos: [{ key: "r2", path: repo2, gateCommand: "node -e 0" }] });
  db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo1, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const wA = `bmhrs-wkr-a-${sfx}`, wB = `bmhrs-wkr-b-${sfx}`, wA2 = `bmhrs-wkr-a-r2-${sfx}`;
  const workerRow = (id, w, extra = {}) => ({ id, projectId: projId, agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch, ...extra });
  for (const [wId, w, label] of [[wA, a, "a"], [wB, b, "b"]]) {
    db.insertTask({ id: w.taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession(workerRow(wId, w));
  }
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {}, purgeQueuedWorkerReportNudgesOnMerge() {}, purgeQueuedWorkerIdleNudges() {} };
  const mk = (extra = {}) => new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 600_000, reapWorktreeProcesses: noReap, ...extra });

  // ── setup: a REAL merge_batch in repo 1 retains A ─────────────────────────────────────────────────
  const first = await mk().mergeBatchTracked(mgrId, [wA, wB]);
  const firstVal = first.settled && first.ok ? first.value : undefined;
  check("(setup) the batch landed A and B and RETAINED A (its branch moved during the gate)", firstVal?.ok === true && !!firstVal.landed.find((l) => l.branch === a.branch)?.branchAdvancedDuringGate);
  const svc = mk({ runGate: async () => ({ passed: true }) });
  check("(setup) A is held in repo 1 (primary)", !!(await svc.isBranchHeld(a.branch, repo1, null)));
  const retain = db.listEventsForBranch(a.branch, "batch_merge_branch_retained").at(-1);
  check("(setup) the batch's retain event carries repoKey:null (the primary repo), not an absent key", !!retain && Object.prototype.hasOwnProperty.call(retain.detail ?? {}, "repoKey") && retain.detail.repoKey === null);
  const lateRevertTip = git(repo1, `rev-parse ${a.branch}`);

  // ── retarget: the SAME task is cut in repo 2 (key "r2") on the SAME-named branch, and a worker there is confirmed ───────────────────
  const a2 = await cut("a", ["feature-r2.txt"], repo2, "r2"); // same label ⇒ same taskId ⇒ same branch name
  check("(setup) the retargeted cut lands on the SAME branch name in repo 2", a2.branch === a.branch && a2.worktreePath !== a.worktreePath);
  db.insertSession(workerRow(wA2, a2, { repoKey: "r2" }));

  check("(inherit) repo 2 does NOT inherit repo 1's hold", (await svc.isBranchHeld(a.branch, repo2, "r2")) === undefined);
  const r2Res = await svc.confirmWorkerMerge(mgrId, wA2);
  check("(inherit) confirming the retargeted worker in repo 2 lands it (merged:true, feature-r2.txt on repo 2's main)", r2Res.merged === true && fs.existsSync(path.join(repo2, "feature-r2.txt")));
  const r2Done = db.listEventsForBranch(a.branch, "merge_done").filter((e) => e.detail?.reconciled !== true).at(-1);
  check("(release) repo 2's merge_done carries its repoKey", r2Done?.detail?.repoKey === "r2");

  check("(release) repo 2's merge_done did NOT release repo 1's hold", !!(await svc.isBranchHeld(a.branch, repo1, null)));
  const boot = await mk().reconcileOrchestrationOnBoot();
  check("(release) the reconcile RESULT reports the Pass A held-branch skip (mergesHeld, not only a console.warn)", boot.mergesHeld === 1);
  check("(release) boot Pass A finished no merge for repo 1's held branch, and repo 1's branch, late-revert commit and worktree are intact",
    typeof boot.mergesFinished === "number" && refExists(repo1, a.branch) && git(repo1, `rev-parse ${a.branch}`) === lateRevertTip && subjects(repo1, a.branch).includes("late-revert") && fs.existsSync(a.worktreePath));

  // ── (scope) the in-scope release still works, and legacy rows (no repoKey) keep matching by branch only ─────────────────────────────
  // Events are ordered by ts (a merge_done releases only a retain OLDER than it): give each synthetic event its own strictly increasing, future ts — no waiting.
  let tick = Date.now() + 60_000;
  const mkEvent = (kind, workerSessionId, taskId, detail) => db.appendEvent({ id: randomUUID(), ts: new Date(tick += 1000).toISOString(), managerSessionId: mgrId, kind, workerSessionId, taskId, detail });
  mkEvent("merge_done", wA, a.taskId, { branch: a.branch, repoKey: null });
  check("(scope) a newer non-reconciled merge_done for the SAME repo (repoKey null) releases the hold", (await svc.isBranchHeld(a.branch, repo1, null)) === undefined);

  // legacy retain (no repoKey key at all) on a fresh branch: held from EITHER repo's point of view, by branch only
  const c = await cut("c", ["feature-c.txt"]);
  mkEvent("batch_merge_branch_retained", "bmhrs-wkr-c", c.taskId, { opId: "synthetic", branch: c.branch, assembledTip: git(repo1, `rev-parse ${c.branch}~1`), liveTip: git(repo1, `rev-parse ${c.branch}`), phase: "pre-stop" });
  check("(scope) a LEGACY retain (no repoKey) holds by branch only — from repo 1's point of view", !!(await svc.isBranchHeld(c.branch, repo1, null)));
  check("(scope) a LEGACY retain (no repoKey) holds by branch only — from repo 2's point of view", !!(await svc.isBranchHeld(c.branch, repo1, "r2")));
  mkEvent("merge_done", "bmhrs-wkr-c", c.taskId, { branch: c.branch, repoKey: "r2" });
  check("(scope) a merge_done stamped r2 does not release the hold seen from repo 1 (repoKey null)", !!(await svc.isBranchHeld(c.branch, repo1, null)));
  check("(scope) ...but it does release the (legacy, branch-only) hold seen from r2 — both events match that scope", (await svc.isBranchHeld(c.branch, repo1, "r2")) === undefined);

  const d = await cut("d", ["feature-d.txt"]);
  mkEvent("merge_branch_retained", "bmhrs-wkr-d", d.taskId, { opId: "synthetic", branch: d.branch, landedTip: git(repo1, `rev-parse ${d.branch}~1`), liveTip: git(repo1, `rev-parse ${d.branch}`), phase: "at-finalize", repoKey: null, source: "solo" });
  mkEvent("merge_done", "bmhrs-wkr-d", d.taskId, { branch: d.branch });
  check("(scope) a LEGACY merge_done (no repoKey) releases a stamped retain by branch only", (await svc.isBranchHeld(d.branch, repo1, null)) === undefined);
  const e = await cut("e", ["feature-e.txt"]);
  mkEvent("merge_branch_retained", "bmhrs-wkr-e", e.taskId, { opId: "synthetic", branch: e.branch, landedTip: git(repo1, `rev-parse ${e.branch}~1`), liveTip: git(repo1, `rev-parse ${e.branch}`), phase: "at-finalize", repoKey: null, source: "solo" });
  mkEvent("merge_done", "bmhrs-wkr-e", e.taskId, { branch: e.branch, repoKey: "r2" });
  check("(scope) a merge_done stamped for ANOTHER repo does not release a stamped solo retain", !!(await svc.isBranchHeld(e.branch, repo1, null)));
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
}
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
