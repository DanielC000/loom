import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// A HELD BRANCH OWES MAIN ITS COMMITS, NOT A MERGE BASE (card 13fc5227, Code Review round 2). worker_merge_confirm lands the NON-MERGE commits of assembledTip..liveTip that main does not
// reach, cherry-picked onto current main; worker_merge shows exactly that commit list and the diffstat of that result, from the same computation (review == landing).
// Fixture as in batch-merge-late-range-landing.mjs: A adds feature-a.txt + extra-a.txt; a real merge_batch retains it after the gate adds a late commit `late-revert` (removes extra-a.txt).
//   (m0)        main gets pre.txt (M0) BEFORE the batch; the worker then runs `git merge --no-ff M0` on A and commits late-z.txt. A merge of an OLDER main commit must not make the late revert
//               vanish: main ends WITHOUT extra-a.txt, WITH late-z.txt and pre.txt. (The reviewer's reproduction; wrong on 89e67375.)
//   (worker-merge) the worker merges CURRENT main (which re-adds extra-a.txt in the merge commit) and then commits late-z.txt: the late revert must still land. (Wrong on 19d20dd4 and 89e67375.)
//   (conflict)  main edits extra-a.txt after the batch, so the late `git rm extra-a.txt` cannot apply: the review names the commit, the confirm REFUSES (nothing changed), never auto-resolves.
//   (content-merge) the worker merges main with content of its OWN in the merge commit (an added file): that merge cannot be skipped without losing the file, so the review names it and the confirm REFUSES (batch's own rule, shared).
//   (side-merge) the worker merges a NON-main branch (the reviewer's clock-skew history: L1 adds z Jan 10, side X1 Jan 8, L2 `git rm z` Jan 5, then merge x): REFUSED; the old replay landed a tree that still had z.
//   (own-union)  a late commit edits a file main ALSO edited (two unchanged lines apart: a clean merge, yet one `diff-tree --cc` hunk that mixes both); a red gate leaves Loom's own union on the branch, main moves, the re-confirm lands: that union carries combined content but is Loom's own and must NOT be refused.
//   (empty)     main itself removes extra-a.txt after the batch, so the late commit is a no-op on main: review flags it emptyOnMain and shows no diff; the confirm lands nothing.
// In every landing case review == landing: the review's commit subjects and file list equal what the landed commit actually changed.
// Run: 1) pnpm build, 2) node packages/daemon/test/batch-merge-late-range-commits.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-bmlc-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=bmlc@loom -c user.name=bmlc";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const noReap = async () => ({ killedPids: [] });
const dbs = [];

// Card 8b5e002d: every scenario but (ou) starts from the IDENTICAL baseline (just README.md) — a real
// `git init` is ~300-450ms of real subprocess spawn on Windows (measured); a plain recursive filesystem
// copy of an already-built template needs none (measured ~6x faster for this fixture shape). Built once,
// reused via fs.cpSync for every no-extra-files scenario; (ou)'s own extra initFiles keep the original
// real-git-init path unchanged, since its baseline content genuinely differs.
const TEMPLATE_REPO = path.join(os.tmpdir(), `loom-bmlc-tmpl-${sfx}`);
registerForCleanup(TEMPLATE_REPO);
fs.mkdirSync(TEMPLATE_REPO, { recursive: true });
fs.writeFileSync(path.join(TEMPLATE_REPO, "README.md"), "# bmlc\n");
execSync(`git init -q && git config user.email bmlc@loom && git config user.name bmlc`, { cwd: TEMPLATE_REPO });
commitAll(TEMPLATE_REPO, "init", GIT_ID);

// preMain: a commit landed on main AFTER the branches are cut and BEFORE the batch runs (M0 in the (m0) scenario).
async function setup(tag, preMain, initFiles = {}) {
  const repo = path.join(os.tmpdir(), `loom-bmlc-${tag}-${sfx}`);
  registerForCleanup(repo);
  if (Object.keys(initFiles).length === 0) {
    fs.cpSync(TEMPLATE_REPO, repo, { recursive: true });
  } else {
    fs.mkdirSync(repo, { recursive: true });
    fs.writeFileSync(path.join(repo, "README.md"), "# bmlc\n");
    for (const [f, c] of Object.entries(initFiles)) fs.writeFileSync(path.join(repo, f), c);
    execSync(`git init -q && git config user.email bmlc@loom && git config user.name bmlc`, { cwd: repo });
    commitAll(repo, "init", GIT_ID);
  }
  const projId = `bmlc-proj-${tag}-${sfx}`, agentId = `bmlc-agent-${tag}-${sfx}`, mgrId = `bmlc-mgr-${tag}-${sfx}`;
  const cut = async (label, files) => {
    const taskId = `bmlc-task-${tag}-${label}-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    for (const f of files) fs.writeFileSync(path.join(worktreePath, f), `work ${label} ${f}\n`);
    commitAll(worktreePath, label, GIT_ID);
    return { taskId, branch, worktreePath };
  };
  const a = await cut("a", ["feature-a.txt", "extra-a.txt"]);
  const b = await cut("b", ["feature-b.txt"]);
  let m0;
  if (preMain) { fs.writeFileSync(path.join(repo, "pre.txt"), "pre\n"); commitAll(repo, "main-pre", GIT_ID); m0 = git(repo, "rev-parse HEAD"); }
  const script = path.join(os.tmpdir(), `loom-bmlc-gate-${tag}-${sfx}.mjs`);
  registerForCleanup(script);
  fs.writeFileSync(script, [
    `import fs from "node:fs"; import path from "node:path"; import { execSync } from "node:child_process";`,
    `const wt = ${JSON.stringify(a.worktreePath)};`,
    `if (fs.existsSync(path.join(wt, "extra-a.txt"))) {`,
    `  execSync("git rm -q extra-a.txt && git -c user.email=bmlc@loom -c user.name=bmlc commit -q -m late-revert", { cwd: wt, stdio: "ignore" });`,
    `}`,
    `process.exit(0);`,
  ].join("\n"));
  const db = new Db(); dbs.push(db);
  db.insertProject({ id: projId, name: `BMLC-${tag}`, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: `node "${script}"` } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const wA = `bmlc-wkr-a-${tag}-${sfx}`, wB = `bmlc-wkr-b-${tag}-${sfx}`;
  for (const [wId, w, label] of [[wA, a, "a"], [wB, b, "b"]]) {
    db.insertTask({ id: w.taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: wId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
  }
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {}, purgeQueuedWorkerReportNudgesOnMerge() {}, purgeQueuedWorkerIdleNudges() {} };
  const mk = (extra = {}) => new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 600_000, reapWorktreeProcesses: noReap, ...extra });
  const first = await mk().mergeBatchTracked(mgrId, [wA, wB]);
  const val = first.settled && first.ok ? first.value : undefined;
  check(`(${tag} setup) the batch landed A and B and RETAINED A`, val?.ok === true && !!val.landed.find((l) => l.branch === a.branch)?.branchAdvancedDuringGate);
  const mainCommit = (file, content, subject) => { fs.writeFileSync(path.join(repo, file), content); commitAll(repo, subject, GIT_ID); };
  const workerCommit = (file, content, subject) => { fs.writeFileSync(path.join(a.worktreePath, file), content); commitAll(a.worktreePath, subject, GIT_ID); };
  const workerMerge = (sha) => git(a.worktreePath, `${GIT_ID} merge --no-ff -m worker-merge ${sha}`);
  return { repo, mgrId, wA, a, db, mk, mainCommit, workerCommit, workerMerge, m0 };
}
const gateOk = { passed: true };
const FAIL = { passed: false, failedStep: "test", failedStatus: 1, steps: [] };
const has = (repo, f) => fs.existsSync(path.join(repo, f));
const sameSet = (x, y) => JSON.stringify([...x].sort()) === JSON.stringify([...y].sort());

// Lands and checks review == landing: the review's subjects and files are exactly what the landed commit changed.
async function landAndCompare(tag, s, wantSubjects) {
  const rev = await s.mk().reviewWorkerMerge(s.mgrId, s.wA);
  const lr = rev.lateRange;
  check(`(${tag}) worker_merge lists exactly the owed commits ${JSON.stringify(wantSubjects)}`, !!lr && sameSet(lr.commitSubjects, wantSubjects) && (lr.commits ?? []).length === wantSubjects.length);
  const before = git(s.repo, "rev-parse HEAD");
  const res = await s.mk({ runGate: async () => gateOk }).confirmWorkerMerge(s.mgrId, s.wA);
  check(`(${tag}) worker_merge_confirm lands: merged:true`, res.merged === true);
  const after = git(s.repo, "rev-parse HEAD");
  const landedFiles = git(s.repo, `diff --name-only ${before} ${after}`).split("\n").filter(Boolean);
  check(`(${tag}) review == landing: the reviewed file list equals what the landing commit changed (${landedFiles.join(",")})`, !!lr && sameSet(lr.files.map((f) => f.file), landedFiles));
  return { res, before, after };
}

try {
  // ── (m0) a worker merge of an OLDER main commit ────────────────────────────────────────────────────────────────────────
  {
    const s = await setup("m0", true);
    s.workerMerge(s.m0);
    s.workerCommit("late-z.txt", "z\n", "late-z");
    await landAndCompare("m0", s, ["late-revert", "late-z"]);
    check("(m0) OUTCOME: main lost extra-a.txt (the late revert landed) and gained late-z.txt; pre.txt and feature-a.txt stay", !has(s.repo, "extra-a.txt") && has(s.repo, "late-z.txt") && has(s.repo, "pre.txt") && has(s.repo, "feature-a.txt"));
  }
  // ── (worker-merge) a worker merge of CURRENT main resurrects extra-a.txt in the merge commit; the late revert must still land ──
  {
    const s = await setup("wm");
    s.workerMerge(git(s.repo, "rev-parse HEAD"));
    check("(wm setup) the worker's own merge of current main brought extra-a.txt back on the branch", has(s.a.worktreePath, "extra-a.txt"));
    s.workerCommit("late-z.txt", "z\n", "late-z");
    await landAndCompare("wm", s, ["late-revert", "late-z"]);
    check("(wm) OUTCOME: main lost extra-a.txt and gained late-z.txt", !has(s.repo, "extra-a.txt") && has(s.repo, "late-z.txt") && has(s.repo, "feature-a.txt"));
  }
  // ── (conflict) main edits extra-a.txt, so the late deletion cannot apply ───────────────────────────────────────────────
  {
    const s = await setup("cf");
    s.mainCommit("extra-a.txt", "edited on main\n", "main-edits-extra-a");
    const rev = await s.mk().reviewWorkerMerge(s.mgrId, s.wA);
    check("(conflict) worker_merge shows no late range and its warning NAMES the commit that does not apply", rev.lateRange === undefined && /late-revert/.test(rev.warning ?? "") && /does not apply cleanly/.test(rev.warning ?? ""));
    const before = git(s.repo, "rev-parse HEAD");
    const tipBefore = git(s.repo, `rev-parse ${s.a.branch}`);
    const res = await s.mk({ runGate: async () => gateOk }).confirmWorkerMerge(s.mgrId, s.wA);
    check("(conflict) confirm REFUSES (merged:false) naming the commit; never auto-resolved", res.merged === false && /late-revert/.test(res.reason ?? "") && /does not apply cleanly/.test(res.reason ?? ""));
    check("(conflict) main untouched and the branch tip unchanged", git(s.repo, "rev-parse HEAD") === before && git(s.repo, `rev-parse ${s.a.branch}`) === tipBefore && fs.readFileSync(path.join(s.repo, "extra-a.txt"), "utf8").trim() === "edited on main");
  }
  // ── (content-merge) a worker merge of main that carries its own content ───────────────────────────────────────────────────
  {
    const s = await setup("cm");
    git(s.a.worktreePath, `${GIT_ID} merge --no-ff --no-commit ${git(s.repo, "rev-parse HEAD")}`);
    fs.writeFileSync(path.join(s.a.worktreePath, "h.txt"), "content carried by the merge itself\n");
    git(s.a.worktreePath, "add h.txt"); git(s.a.worktreePath, `${GIT_ID} commit -q -m worker-merge-with-h`);
    s.workerCommit("late-z.txt", "z\n", "late-z");
    const rev = await s.mk().reviewWorkerMerge(s.mgrId, s.wA);
    check("(content-merge) worker_merge shows no late range and its warning NAMES the merge and its own content", rev.lateRange === undefined && /worker-merge-with-h/.test(rev.warning ?? "") && /resolution content of its own/.test(rev.warning ?? ""));
    const before = git(s.repo, "rev-parse HEAD");
    const res = await s.mk({ runGate: async () => gateOk }).confirmWorkerMerge(s.mgrId, s.wA);
    check("(content-merge) confirm REFUSES naming the merge; main untouched (h.txt is not silently dropped)", res.merged === false && /worker-merge-with-h/.test(res.reason ?? "") && git(s.repo, "rev-parse HEAD") === before && !has(s.repo, "h.txt"));
  }
  // ── (side-merge) the reviewer's clock-skew history: a merge of a branch that is NOT on main ───────────────────────────────
  {
    const s = await setup("sm");
    const wt = s.a.worktreePath;
    const at = (date, cmd) => execSync(cmd, { cwd: wt, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date } });
    const forkPoint = git(s.repo, "rev-list --max-parents=0 HEAD");
    fs.writeFileSync(path.join(wt, "z.txt"), "z\n"); git(wt, "add z.txt"); at("2026-01-10T00:00:00Z", `git ${GIT_ID} commit -q -m L1-add-z`);
    git(wt, `checkout -q -b side-x ${forkPoint}`);
    fs.writeFileSync(path.join(wt, "x1.txt"), "x1\n"); git(wt, "add x1.txt"); at("2026-01-08T00:00:00Z", `git ${GIT_ID} commit -q -m X1`);
    git(wt, `checkout -q ${s.a.branch}`);
    git(wt, "rm -q z.txt"); at("2026-01-05T00:00:00Z", `git ${GIT_ID} commit -q -m L2-rm-z`);
    at("2026-01-11T00:00:00Z", `git ${GIT_ID} merge --no-ff -q -m merge-x side-x`);
    check("(side-merge setup) the branch tip has no z.txt and carries X1's file", !has(wt, "z.txt") && has(wt, "x1.txt"));
    const rev = await s.mk().reviewWorkerMerge(s.mgrId, s.wA);
    check("(side-merge) worker_merge shows no late range and its warning NAMES the merge of a branch not on main", rev.lateRange === undefined && /merge-x/.test(rev.warning ?? "") && /not reachable from main/.test(rev.warning ?? ""));
    const before = git(s.repo, "rev-parse HEAD");
    const res = await s.mk({ runGate: async () => gateOk }).confirmWorkerMerge(s.mgrId, s.wA);
    check("(side-merge) OUTCOME: confirm REFUSES; nothing lands (the old replay landed a tree that still had z.txt)", res.merged === false && git(s.repo, "rev-parse HEAD") === before && !has(s.repo, "z.txt"));
  }
  // ── (own-union) a late edit of a file main also edited; a red gate leaves Loom's own union; the re-confirm must still land ────
  {
    const s = await setup("ou", false, { "shared.txt": "l1\nl2\nl3\nl4\nl5\n" });
    s.workerCommit("shared.txt", "l1\nl2\nl3\nl4\nl5-late\n", "late-edit-l5");
    await s.mk().reviewWorkerMerge(s.mgrId, s.wA);
    s.mainCommit("shared.txt", "l1\nl2-main\nl3\nl4\nl5\n", "main-edit-l2");
    const red = await s.mk({ runGate: async () => FAIL }).confirmWorkerMerge(s.mgrId, s.wA);
    check("(own-union setup) confirm #1 was rejected by the red gate and left Loom's union on the branch", red.merged === false && git(s.a.worktreePath, "log --format=%s").includes("Merge main into branch (owed commits over"));
    s.mainCommit("other-main.txt", "m2\n", "main2");
    const res = await s.mk({ runGate: async () => gateOk }).confirmWorkerMerge(s.mgrId, s.wA);
    check("(own-union) the re-confirm lands (Loom's own union, though it carries combined content, is not refused)", res.merged === true);
    check("(own-union) OUTCOME: main has BOTH edits of shared.txt and lost extra-a.txt", fs.readFileSync(path.join(s.repo, "shared.txt"), "utf8").split("\r\n").join("\n") === "l1\nl2-main\nl3\nl4\nl5-late\n" && !has(s.repo, "extra-a.txt"));
  }
  // ── (empty) main itself removed extra-a.txt: the late commit is a no-op on main ────────────────────────────────────────
  {
    const s = await setup("em");
    git(s.repo, "rm -q extra-a.txt"); commitAll(s.repo, "main-removes-extra-a", GIT_ID);
    const rev = await s.mk().reviewWorkerMerge(s.mgrId, s.wA);
    const lr = rev.lateRange;
    check("(empty) worker_merge lists the late commit flagged emptyOnMain and shows no diff", !!lr && (lr.commits ?? []).length === 1 && lr.commits[0].emptyOnMain === true && lr.filesChanged === 0);
    const before = git(s.repo, "rev-parse HEAD");
    const res = await s.mk({ runGate: async () => gateOk }).confirmWorkerMerge(s.mgrId, s.wA);
    check("(empty) confirm lands NOTHING (refused/no-op), main did not move, the branch is intact", res.merged !== true && git(s.repo, "rev-parse HEAD") === before && !!git(s.repo, `rev-parse ${s.a.branch}`));
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
}
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
