import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// THE HOLD'S RELEASE AND EDGE CASES (card 42daa283, round 5) — split from batch-merge-retain-hold.mjs to keep each file well under the per-file gate ceiling.
// Builds the same real mixed batch [A,B,C] (A retained by a real merge_batch), then proves, in order:
//   (gone)     A's branch is hand-deleted (update-ref -d, since it is checked out): A is STILL held — a missing branch is not a release
//   (release)  NEGATIVE CONTROL, last because a released candidate may land: a REAL merge_done newer than D's retain DOES release D
//   (cas-skip) finalizeMerge must not CAS-delete a branch whose worktree was NOT removed (update-ref -d, unlike branch -D, would delete a
//              branch still checked out in a live worktree)
// Run: 1) pnpm build, 2) node packages/daemon/test/batch-merge-retain-hold-release.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-bmrh-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=bmrh@loom -c user.name=bmrh";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// NOTE: `refs/heads/<b>` (never `<b>^{commit}` — cmd.exe treats `^` as its escape char on Windows).
const refExists = (repo, ref) => { try { git(repo, `rev-parse --verify --quiet refs/heads/${ref}`); return true; } catch { return false; } };
const subjects = (repo, ref) => git(repo, `log ${ref} --format=%s`).split("\n");

const dbs = [];
function makeRepo(tag) {
  const repo = path.join(os.tmpdir(), `loom-bmrh-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# bmrh\n");
  execSync(`git init -q && git config user.email bmrh@loom && git config user.name bmrh`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  return repo;
}
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {}, purgeQueuedWorkerReportNudgesOnMerge() {}, purgeQueuedWorkerIdleNudges() {} };

try {
  // ── the real mixed batch ─────────────────────────────────────────────────────────────────────────────
  const repo = makeRepo("mix");
  const projId = `bmrh-proj-${sfx}`, agentId = `bmrh-agent-${sfx}`, mgrId = `bmrh-mgr-${sfx}`;
  const cut = async (label, file) => {
    const taskId = `bmrh-task-${label}-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    fs.writeFileSync(path.join(worktreePath, file), `work ${label}\n`);
    commitAll(worktreePath, label, GIT_ID);
    return { taskId, branch, worktreePath };
  };
  const a = await cut("a", "feature-a.txt");
  const b = await cut("b", "feature-b.txt");
  const c = await cut("c", "feature-a.txt"); // add/add conflict with A once A has landed ⇒ dropped, never finished
  const d = await cut("d", "feature-d.txt");  // synthetic held candidate for the (reason)/(release) cases; not in the first batch

  const script = path.join(os.tmpdir(), `loom-bmrh-gate-${sfx}.mjs`);
  registerForCleanup(script);
  fs.writeFileSync(script, [
    `import fs from "node:fs"; import path from "node:path"; import { execSync } from "node:child_process";`,
    `const wt = ${JSON.stringify(a.worktreePath)};`,
    `if (!fs.existsSync(path.join(wt, "late-commit.txt"))) {`,
    `  fs.writeFileSync(path.join(wt, "late-commit.txt"), "added during the gate\\n");`,
    `  execSync("git add late-commit.txt && git -c user.email=bmrh@loom -c user.name=bmrh commit -q -m late-commit", { cwd: wt, stdio: "ignore" });`,
    `}`,
    `process.exit(0);`,
  ].join("\n"));

  const db = new Db(); dbs.push(db);
  db.insertProject({ id: projId, name: "BMRH", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: `node "${script}"` } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const wA = `bmrh-wkr-a-${sfx}`, wB = `bmrh-wkr-b-${sfx}`, wC = `bmrh-wkr-c-${sfx}`, wD = `bmrh-wkr-d-${sfx}`;
  for (const [wId, w, label] of [[wA, a, "a"], [wB, b, "b"], [wC, c, "c"], [wD, d, "d"]]) {
    db.insertTask({ id: w.taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: wId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
  }
  // A budget pinned HIGH through the constructor seam so the outcome cannot depend on host speed.
  const mk = (extra = {}) => new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 600_000, ...extra });
  const svc1 = mk();

  const first = await svc1.mergeBatchTracked(mgrId, [wA, wB, wC]);
  const firstVal = first.settled && first.ok ? first.value : undefined;
  check("(setup) the batch took the sync path and landed A and B", first.settled === true && firstVal?.ok === true && !!firstVal.landed.find((l) => l.branch === a.branch) && !!firstVal.landed.find((l) => l.branch === b.branch));
  check("(setup) A was RETAINED (pre-stop) — its branch moved during the gate", firstVal?.landed.find((l) => l.branch === a.branch)?.branchAdvancedDuringGate?.phase === "pre-stop");
  check("(setup) C was dropped to fallback (so the batch is MIXED: C is never finished)", !!firstVal?.fallback.find((f) => f.workerSessionId === wC));
  try {
    await waitUntil(() => db.listEventsForWorker(wC).some((e) => e.kind === "merge_rejected" || e.kind === "merge_cancelled"), { timeoutMs: 90_000, label: "C's fallback confirm to settle (rejected)" });
  } catch { check("(setup) C's fallback confirm settled", false); }
  const mainAfterFirst = git(repo, "rev-parse HEAD");

  const untouched = (tag) => {
    check(`(${tag}) main did not move`, git(repo, "rev-parse HEAD") === mainAfterFirst);
    check(`(${tag}) NEITHER late commit is on main`, !fs.existsSync(path.join(repo, "late-commit.txt")) && !fs.existsSync(path.join(repo, "late-commit-2.txt")) &&
      !subjects(repo, "HEAD").some((s) => s.startsWith("late-commit")));
    check(`(${tag}) A's branch still carries the late commit(s) and its worktree survives`, refExists(repo, a.branch) && subjects(repo, a.branch).includes("late-commit") && fs.existsSync(path.join(a.worktreePath, "late-commit.txt")));
    check(`(${tag}) A's task is still in_progress with no merge_done (never solo-confirmed)`, db.getTask(a.taskId)?.columnKey === "in_progress" && !db.listEventsForWorker(wA).some((e) => e.kind === "merge_done" && e.detail?.reconciled !== true));
  };
  const heldEntry = (val, w) => val?.fallback.find((f) => f.workerSessionId === w && f.started === false && /held/.test(f.reason));
  const refire = async (svc, ids) => {
    let r = await svc.mergeBatchTracked(mgrId, ids);
    if (!r.settled) {
      await waitUntil(() => svc.gateStatus(r.op.opId).state === "settled", { timeoutMs: 90_000, label: "re-fire op to settle" });
      r = await svc.mergeBatchTracked(mgrId, ids);
    }
    return r.settled && r.ok ? r.value : undefined;
  };

  // (gone) A's branch is deleted by hand (update-ref -d, since it is checked out): A is STILL held — a missing branch is not a release.
  git(repo, `update-ref -d refs/heads/${a.branch}`);
  const goneVal = await refire(mk(), [wA, wB, wC]);
  check("(gone) a hand-deleted branch does NOT release A (still reported held)", !!heldEntry(goneVal, wA));
  check("(gone) main did not move and no late commit is on main", git(repo, "rev-parse HEAD") === mainAfterFirst && !subjects(repo, "HEAD").some((s) => s.startsWith("late-commit")));

  // (release) NEGATIVE CONTROL — last, since a released candidate may land.
  // D: a synthetic retain (ref-kept-after-finalize) on a branch with a real commit — the candidate the (release) control releases.
  db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: mgrId, kind: "batch_merge_branch_retained", workerSessionId: wD, taskId: d.taskId, detail: { opId: "synthetic", branch: d.branch, assembledTip: "0".repeat(40), liveTip: "1".repeat(40), phase: "ref-kept-after-finalize" } });
  check("(release) precondition: D is held before the release", !!heldEntry(await refire(mk(), [wD, wB]), wD));
  db.appendEvent({ id: randomUUID(), ts: new Date(Date.now() + 5).toISOString(), managerSessionId: mgrId, kind: "merge_done", workerSessionId: wD, taskId: d.taskId, detail: { branch: d.branch } });
  const releaseDVal = await refire(mk(), [wD, wB]);
  check("(release control) a merge_done NEWER than D's retain RELEASES D (no held entry)", !heldEntry(releaseDVal, wD));


  // ── (unit) finalizeMerge must not CAS-delete a branch whose worktree was NOT removed ──────────────────
  {
    const repo2 = makeRepo("fin");
    const proj2 = `bmrh-proj-fin-${sfx}`, agent2 = `bmrh-agent-fin-${sfx}`, mgr2 = `bmrh-mgr-fin-${sfx}`, w2 = `bmrh-wkr-fin-${sfx}`, task2 = `bmrh-task-fin-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo2, proj2, task2);
    registerForCleanup(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "f.txt"), "f\n");
    commitAll(worktreePath, "f", GIT_ID);
    const tip = git(worktreePath, "rev-parse HEAD");
    const db2 = new Db(); dbs.push(db2);
    db2.insertProject({ id: proj2, name: "BMRH-fin", repoPath: repo2, vaultPath: repo2, config: {}, createdAt: now, archivedAt: null });
    db2.insertAgent({ id: agent2, projectId: proj2, name: "dev", startupPrompt: "", position: 0 });
    db2.insertSession({ id: mgr2, projectId: proj2, agentId: agent2, engineSessionId: null, title: null, cwd: repo2, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
    db2.insertTask({ id: task2, projectId: proj2, title: "feat(test): fin", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db2.insertSession({ id: w2, projectId: proj2, agentId: agent2, engineSessionId: null, title: null, cwd: worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgr2, taskId: task2, worktreePath, branch });
    // The worktree is recorded as needing a human (a wedged removal that gave up) ⇒ gcWorktreeDir returns "needs-human-skip" and
    // the worktree stays on disk (gc outcome is not "removed").
    db2.recordWorktreeWedgeAttempt(worktreePath, repo2, "test: simulated wedged removal");
    db2.markWorktreeNeedsHuman(worktreePath);
    const stuck = new SessionService(db2, ptyStub, new OrchestrationControl());
    let retained = false;
    await stuck.finalizeMerge({ managerSessionId: mgr2, workerSessionId: w2, taskId: task2, worktreePath, branch, repoPath: repo2, projectId: proj2, mergedSha: tip, repoKey: null, expectedBranchTip: tip, onBranchRetained: () => { retained = true; } });
    check("(cas-skip) the worktree really was NOT removed (setup)", fs.existsSync(worktreePath));
    check("(cas-skip) the branch is NOT deleted while its worktree is still checked out on it (update-ref -d would have deleted it)", refExists(repo2, branch));
    check("(cas-skip) it is not misreported as a moved-tip retain, and the finalize bookkeeping still ran (task moved, merge_done filed)",
      retained === false && db2.getTask(task2)?.columnKey !== "in_progress" && db2.listEventsForWorker(w2).some((e) => e.kind === "merge_done"));

  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
}
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
