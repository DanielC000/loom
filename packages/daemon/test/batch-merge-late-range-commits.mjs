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
//   (equivalence check) proves seedHeldBranch's seeded `batch_merge_branch_retained` event is a row the real writer (service.ts ~23311-23315) could produce: a real mergeBatchTracked retain vs the
//               seeded one, compared field-for-field on the persisted row, then both driven through reviewWorkerMerge/confirmWorkerMerge to show isBranchHeld/resolveOwedRange treat them identically.
// In every landing case review == landing: the review's commit subjects and file list equal what the landed commit actually changed.
// Card 114e96e0: setup() no longer runs a real mergeBatchTracked to produce the HELD state for branch A. isBranchHeld (service.ts:21854) reads ONLY the durable event log — never anything
// mergeBatchTracked computes in-memory — so seedHeldBranch (below) writes that SAME event directly via db.appendEvent, through the real writer's own chokepoint (service.ts:23311-23315), with the
// same detail keys/value shapes. The branch-advanced-during-gate DETECTION this scaffolding used to re-exercise in every scenario is independently pinned by
// batch-merge-branch-advanced-during-gate.mjs (scenarios sync/async/stop/mixed) and batch-merge-finalize-guard-edges.mjs (scenarios U/u/N1/N2) — this file's own claim (13fc5227) is about what
// happens GIVEN a held branch, never about how the hold was produced. Precedent: docs/decisions/6cf10d10-ledger-cutover-gate-seeding-equivalence.md. Candidate B (never referenced by any
// assertion in this file — grepped) is dropped entirely; the ONE (equivalence check) scenario above is the sole real-mergeBatchTracked anchor left in the file.
// Run: 1) pnpm build, 2) node packages/daemon/test/batch-merge-late-range-commits.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
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

/**
 * Seeds the HELD state a real `mergeBatchTracked` run would produce for a retained candidate — writing
 * through the SAME chokepoint the real writer uses (service.ts ~23311-23315: `this.db.appendEvent({...,
 * kind: "batch_merge_branch_retained", workerSessionId, taskId, detail: {opId, branch, assembledTip,
 * liveTip, phase, landedSha, repoKey}})`), with the SAME detail keys and value shapes — including
 * `landedSha` (a real sha, never omitted/null: the real writer always supplies `lb.sha`, the candidate's
 * own just-landed commit). isBranchHeld (service.ts:21854) reads ONLY this durable event log, never
 * anything mergeBatchTracked computes in-memory, so a caller that also builds the matching git history (a
 * real worktree at `assembledTip`/`liveTip`, a real commit at `landedSha` on main) gets a hold
 * indistinguishable from a real retain — proved field-for-field, and via isBranchHeld/heldRecordedTip/
 * resolveOwedRange's observable effect through the public reviewWorkerMerge/confirmWorkerMerge surface
 * (all three are private methods), by the (equivalence check) scenario below.
 * `landedSha` deliberately does NOT need its own `Loom-Worker-Branch` trailer: isBranchHeld's git-fact
 * release arm (`findLaterBranchSquash`) only greps commits STRICTLY AFTER `landedSha` for that trailer,
 * never `landedSha`'s own message — so a plain commit standing in for "the batch's own squash of this
 * candidate" is inert here, confirmed by the equivalence scenario reaching the SAME held verdict.
 */
function seedHeldBranch(db, { managerSessionId, workerSessionId, taskId, branch, assembledTip, liveTip, landedSha, phase = "pre-stop" }) {
  db.appendEvent({
    id: randomUUID(), ts: new Date().toISOString(), managerSessionId, kind: "batch_merge_branch_retained",
    workerSessionId, taskId,
    detail: { opId: randomUUID(), branch, assembledTip, liveTip, phase, landedSha, repoKey: null },
  });
}

// preMain: a commit landed on main AFTER the branch is cut and BEFORE its (seeded) assembled landing (M0 in the (m0) scenario).
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
  const taskId = `bmlc-task-${tag}-a-${sfx}`;
  const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
  registerForCleanup(worktreePath);
  fs.writeFileSync(path.join(worktreePath, "feature-a.txt"), "work a feature-a.txt\n");
  fs.writeFileSync(path.join(worktreePath, "extra-a.txt"), "work a extra-a.txt\n");
  commitAll(worktreePath, "a", GIT_ID);
  const a = { taskId, branch, worktreePath };
  const assembledTip = git(a.worktreePath, "rev-parse HEAD");
  let m0;
  if (preMain) { fs.writeFileSync(path.join(repo, "pre.txt"), "pre\n"); commitAll(repo, "main-pre", GIT_ID); m0 = git(repo, "rev-parse HEAD"); }
  // Stands in for "the batch landed A's assembled commits onto main" (same final tree as assembledTip) —
  // a plain commit instead of a real squash. Its sha becomes `landedSha`; see seedHeldBranch's own doc
  // above for why the absent Loom-Worker-Branch trailer is inert here. DELIBERATELY a DIFFERENT commit
  // message than the branch's own "a" commit (not just same tree/parent/identity) — two commits built
  // from identical tree+parent+author+committer+message can collide to the SAME sha when git's
  // one-second timestamp granularity lands both in the same second, which would make main an unintended
  // ancestor of the branch and silently default every (wm)/(cm)-style "merge main into the worktree"
  // scenario below to a no-op merge instead of a real one (caught as an intermittent flake, card 114e96e0).
  fs.writeFileSync(path.join(repo, "feature-a.txt"), "work a feature-a.txt\n");
  fs.writeFileSync(path.join(repo, "extra-a.txt"), "work a extra-a.txt\n");
  commitAll(repo, "a-landed", GIT_ID);
  const landedSha = git(repo, "rev-parse HEAD");
  // The late commit a worker adds WHILE a real batch gate would run (card 42daa283) — applied directly
  // instead of via a spawned gate-command child process; see the file header for why that detection
  // mechanism is independently covered elsewhere and does not need re-exercising in every scenario here.
  git(a.worktreePath, "rm -q extra-a.txt");
  commitAll(a.worktreePath, "late-revert", GIT_ID);
  const liveTip = git(a.worktreePath, "rev-parse HEAD");
  const db = new Db(); dbs.push(db);
  db.insertProject({ id: projId, name: `BMLC-${tag}`, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: `node -e "process.exit(0)"` } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const wA = `bmlc-wkr-a-${tag}-${sfx}`;
  db.insertTask({ id: a.taskId, projectId: projId, title: "feat(test): a", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: wA, projectId: projId, agentId, engineSessionId: null, title: null, cwd: a.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: a.taskId, worktreePath: a.worktreePath, branch: a.branch });
  seedHeldBranch(db, { managerSessionId: mgrId, workerSessionId: wA, taskId: a.taskId, branch: a.branch, assembledTip, liveTip, landedSha });
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {}, purgeQueuedWorkerReportNudgesOnMerge() {}, purgeQueuedWorkerIdleNudges() {} };
  const mk = (extra = {}) => new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 600_000, reapWorktreeProcesses: noReap, ...extra });
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
  // ── (equivalence check) a real mergeBatchTracked retain vs seedHeldBranch: same event shape, same resolver verdict ──
  {
    const tag = "eq";
    const repo = path.join(os.tmpdir(), `loom-bmlc-${tag}-${sfx}`);
    registerForCleanup(repo);
    fs.cpSync(TEMPLATE_REPO, repo, { recursive: true });
    const projId = `bmlc-proj-${tag}-${sfx}`, agentId = `bmlc-agent-${tag}-${sfx}`, mgrId = `bmlc-mgr-${tag}-${sfx}`;
    const cutReal = async (label, files) => {
      const taskId = `bmlc-task-${tag}-${label}-${sfx}`;
      const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
      registerForCleanup(worktreePath);
      for (const f of files) fs.writeFileSync(path.join(worktreePath, f), `work ${label} ${f}\n`);
      commitAll(worktreePath, label, GIT_ID);
      return { taskId, branch, worktreePath };
    };
    const a = await cutReal("a", ["feature-a.txt", "extra-a.txt"]);
    const b = await cutReal("b", ["feature-b.txt"]);
    // Rebuilds the ORIGINAL (pre-card-114e96e0) gate script — a real child process, run by a real
    // mergeBatchTracked — so this one scenario still exercises the batch's OWN assembled-vs-live-tip
    // detection (the mechanism seedHeldBranch stands in for everywhere else in this file).
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
    const result = await mk().mergeBatchTracked(mgrId, [wA, wB]);
    const val = result.settled && result.ok ? result.value : undefined;
    check("(eq setup) the real batch landed A and B and RETAINED A", val?.ok === true && !!val.landed.find((l) => l.branch === a.branch)?.branchAdvancedDuringGate);

    const realEvents = db.listEventsForWorker(wA).filter((e) => e.kind === "batch_merge_branch_retained");
    check("(eq) exactly one REAL batch_merge_branch_retained event for A", realEvents.length === 1);
    const real = realEvents[0];
    // Db.appendEvent (db.ts ~7252) auto-stamps `projectId` onto ANY DURABLE_AUDIT_EVENT_KINDS detail that
    // doesn't already carry one (`batch_merge_branch_retained` is in that set) — so the PERSISTED shape is
    // the writer's own 7 keys PLUS this chokepoint-level addition, for both the real and the seeded event.
    const REAL_SHAPE_KEYS = ["opId", "branch", "assembledTip", "liveTip", "phase", "landedSha", "repoKey", "projectId"];
    check(`(eq) the REAL event's detail keys are exactly the writer's own shape ${JSON.stringify(REAL_SHAPE_KEYS)}`, sameSet(Object.keys(real.detail ?? {}), REAL_SHAPE_KEYS));

    // A second candidate (a2), built the SAME cheap way every other scenario in this file now uses:
    // seedHeldBranch instead of a real mergeBatchTracked retain. Distinct commit message on the main-side
    // commit (not just "a2") for the same sha-collision reason noted in setup() above.
    const a2 = await cutReal("a2", ["feature-a2.txt", "extra-a2.txt"]);
    const assembledTip2 = git(a2.worktreePath, "rev-parse HEAD");
    fs.writeFileSync(path.join(repo, "feature-a2.txt"), "work a2 feature-a2.txt\n");
    fs.writeFileSync(path.join(repo, "extra-a2.txt"), "work a2 extra-a2.txt\n");
    commitAll(repo, "a2-landed", GIT_ID);
    const landedSha2 = git(repo, "rev-parse HEAD");
    git(a2.worktreePath, "rm -q extra-a2.txt");
    commitAll(a2.worktreePath, "late-revert", GIT_ID);
    const liveTip2 = git(a2.worktreePath, "rev-parse HEAD");
    const wA2 = `bmlc-wkr-a2-${tag}-${sfx}`;
    db.insertTask({ id: a2.taskId, projectId: projId, title: "feat(test): a2", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: wA2, projectId: projId, agentId, engineSessionId: null, title: null, cwd: a2.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: a2.taskId, worktreePath: a2.worktreePath, branch: a2.branch });
    seedHeldBranch(db, { managerSessionId: mgrId, workerSessionId: wA2, taskId: a2.taskId, branch: a2.branch, assembledTip: assembledTip2, liveTip: liveTip2, landedSha: landedSha2 });

    const seededEvents = db.listEventsForWorker(wA2).filter((e) => e.kind === "batch_merge_branch_retained");
    check("(eq) exactly one SEEDED batch_merge_branch_retained event for a2", seededEvents.length === 1);
    const seeded = seededEvents[0];
    check(`(eq) the SEEDED event's detail keys are exactly the SAME shape as the real writer's ${JSON.stringify(REAL_SHAPE_KEYS)}`, sameSet(Object.keys(seeded.detail ?? {}), REAL_SHAPE_KEYS));
    check("(eq) FIELD-FOR-FIELD: kind is identical (batch_merge_branch_retained)", seeded.kind === real.kind && seeded.kind === "batch_merge_branch_retained");
    check("(eq) FIELD-FOR-FIELD: EQUAL fields — phase, repoKey", seeded.detail.phase === real.detail.phase && seeded.detail.repoKey === real.detail.repoKey);
    check("(eq) FIELD-FOR-FIELD: INHERENTLY DIFFERENT fields are each present and well-formed (branch/assembledTip/liveTip/landedSha/opId are distinct shas/ids by construction — never compared for equality)",
      seeded.detail.branch !== real.detail.branch && typeof seeded.detail.assembledTip === "string" && typeof real.detail.assembledTip === "string" &&
      typeof seeded.detail.liveTip === "string" && typeof real.detail.liveTip === "string" &&
      typeof seeded.detail.landedSha === "string" && typeof real.detail.landedSha === "string" && seeded.detail.opId !== real.detail.opId);

    // isBranchHeld/heldRecordedTip/resolveOwedRange are private — driven here through the SAME public
    // surface every other scenario in this file uses, for BOTH branches, to prove the resolver treats the
    // seeded event exactly like the real one.
    const revReal = await mk().reviewWorkerMerge(mgrId, wA);
    const revSeeded = await mk().reviewWorkerMerge(mgrId, wA2);
    check("(eq) the REAL-event branch resolves to a late range with exactly [late-revert]", !!revReal.lateRange && sameSet(revReal.lateRange.commitSubjects, ["late-revert"]));
    check("(eq) the SEEDED-event branch resolves to a late range with exactly [late-revert] — the SAME shape", !!revSeeded.lateRange && sameSet(revSeeded.lateRange.commitSubjects, ["late-revert"]));
    check("(eq) both late ranges report their own single file removed, proving resolveOwedRange treated both holds identically",
      revReal.lateRange.files.length === 1 && revSeeded.lateRange.files.length === 1 &&
      revReal.lateRange.files[0].file === "extra-a.txt" && revSeeded.lateRange.files[0].file === "extra-a2.txt");

    const resReal = await mk({ runGate: async () => gateOk }).confirmWorkerMerge(mgrId, wA);
    const resSeeded = await mk({ runGate: async () => gateOk }).confirmWorkerMerge(mgrId, wA2);
    check("(eq) the REAL-event branch lands (merged:true)", resReal.merged === true);
    check("(eq) the SEEDED-event branch ALSO lands (merged:true) — isBranchHeld genuinely read the seeded event, not a fixed/cached verdict", resSeeded.merged === true);
    check("(eq) OUTCOME: main lost BOTH extra-a.txt and extra-a2.txt (both late reverts landed) and kept both feature files",
      !has(repo, "extra-a.txt") && !has(repo, "extra-a2.txt") && has(repo, "feature-a.txt") && has(repo, "feature-a2.txt"));
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
}
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
