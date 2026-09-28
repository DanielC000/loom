import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// A HELD (retained) BATCH BRANCH IS REVIEWED AND LANDED BY ITS LATE-COMMIT RANGE (card 13fc5227; builds on card 42daa283).
// A batch that retains a candidate cherry-picked it up to `assembledTip`; the late commits are exactly `assembledTip..liveTip`. The manual
// worker_merge (review) + worker_merge_confirm (land) used to work against the branch's ORIGINAL fork point, so a late commit that REVERTS part of
// the branch's own change netted to an EMPTY squash and main kept the reverted content (confirm was refused with cherry-pick guidance).
// Fixture: A commits two files (feature-a.txt, extra-a.txt); the (idempotent) gate command `git rm`s extra-a.txt on A's branch mid-gate ⇒ A is
// retained by a REAL merge_batch (B is the unmoved control). Scenarios, each on its own repo:
//   (land)      review shows the late range DISTINCTLY (the ordinary fork-point diff is unchanged), then confirm lands EXACTLY that range: main ends up
//               WITHOUT extra-a.txt, WITH feature-a.txt, the landing commit touches only extra-a.txt, the hold is released and the branch finalized.
//   (rewritten) A's branch is rewritten so `assembledTip` is no longer an ancestor of its tip: review warns, confirm REFUSES with guidance, main untouched.
//   (unreadable) the retain's `assembledTip` cannot be read as a commit: same fail-closed refusal.
//   (moved)     the worker commits AGAIN after the review: the reviewed-tip rule (card bbccf470) still refuses the confirm, nothing lands.
// Run: 1) pnpm build, 2) node packages/daemon/test/batch-merge-late-range-landing.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-bmlr-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=bmlr@loom -c user.name=bmlr";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// NOTE: `refs/heads/<b>` (never `<b>^{commit}` — cmd.exe treats `^` as its escape char on Windows).
const refExists = (repo, ref) => { try { git(repo, `rev-parse --verify --quiet refs/heads/${ref}`); return true; } catch { return false; } };
const noReap = async () => ({ killedPids: [] });
const dbs = [];

// Builds a repo + project + manager + workers A (feature-a.txt, extra-a.txt) and B, and runs a REAL merge_batch whose gate reverts extra-a.txt on
// A's branch mid-gate, so A is retained. Returns the pieces a scenario needs.
async function setup(tag) {
  const repo = path.join(os.tmpdir(), `loom-bmlr-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# bmlr\n");
  execSync(`git init -q && git config user.email bmlr@loom && git config user.name bmlr`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  const projId = `bmlr-proj-${tag}-${sfx}`, agentId = `bmlr-agent-${tag}-${sfx}`, mgrId = `bmlr-mgr-${tag}-${sfx}`;
  const cut = async (label, files) => {
    const taskId = `bmlr-task-${tag}-${label}-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    for (const f of files) fs.writeFileSync(path.join(worktreePath, f), `work ${label} ${f}\n`);
    commitAll(worktreePath, label, GIT_ID);
    return { taskId, branch, worktreePath };
  };
  const a = await cut("a", ["feature-a.txt", "extra-a.txt"]);
  const b = await cut("b", ["feature-b.txt"]);
  const script = path.join(os.tmpdir(), `loom-bmlr-gate-${tag}-${sfx}.mjs`);
  registerForCleanup(script);
  fs.writeFileSync(script, [
    `import fs from "node:fs"; import path from "node:path"; import { execSync } from "node:child_process";`,
    `const wt = ${JSON.stringify(a.worktreePath)};`,
    `if (fs.existsSync(path.join(wt, "extra-a.txt"))) {`,
    `  execSync("git rm -q extra-a.txt && git -c user.email=bmlr@loom -c user.name=bmlr commit -q -m late-revert", { cwd: wt, stdio: "ignore" });`,
    `}`,
    `process.exit(0);`,
  ].join("\n"));
  const db = new Db(); dbs.push(db);
  db.insertProject({ id: projId, name: `BMLR-${tag}`, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: `node "${script}"` } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const wA = `bmlr-wkr-a-${tag}-${sfx}`, wB = `bmlr-wkr-b-${tag}-${sfx}`;
  for (const [wId, w, label] of [[wA, a, "a"], [wB, b, "b"]]) {
    db.insertTask({ id: w.taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: wId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
  }
  const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {}, purgeQueuedWorkerReportNudgesOnMerge() {}, purgeQueuedWorkerIdleNudges() {} };
  const mk = (extra = {}) => new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 600_000, reapWorktreeProcesses: noReap, ...extra });
  const first = await mk().mergeBatchTracked(mgrId, [wA, wB]);
  const val = first.settled && first.ok ? first.value : undefined;
  const landedA = val?.landed.find((l) => l.branch === a.branch);
  check(`(${tag} setup) the batch landed A and B, and A was RETAINED (its branch moved during the gate)`, val?.ok === true && !!landedA?.branchAdvancedDuringGate && !!val.landed.find((l) => l.branch === b.branch));
  check(`(${tag} setup) main still carries A's batch-landed extra-a.txt (the late revert is NOT on main)`, fs.existsSync(path.join(repo, "extra-a.txt")) && fs.existsSync(path.join(repo, "feature-a.txt")));
  const retain = db.listEventsForWorker(wA).find((e) => e.kind === "batch_merge_branch_retained");
  return { repo, projId, mgrId, wA, a, db, mk, assembledTip: retain?.detail?.assembledTip, liveTip: retain?.detail?.liveTip };
}

try {
  // ── (land) ─────────────────────────────────────────────────────────────────────────────────────────────────
  {
    const s = await setup("land");
    const { repo, mgrId, wA, a, db, mk } = s;
    check("(land) the retain event records both tips, and the branch tip is the recorded liveTip", !!s.assembledTip && !!s.liveTip && git(repo, `rev-parse ${a.branch}`) === s.liveTip);
    const rev = await mk().reviewWorkerMerge(mgrId, wA);
    // The ordinary review output for a normal branch is unchanged: fork-point diff (net feature-a.txt only) + its usual fields.
    check("(land) the ordinary review fields are unchanged (fork-point diffstat, note)", rev.filesChanged === 1 && rev.files.some((f) => f.file === "feature-a.txt") && typeof rev.note === "string");
    // The late range is shown DISTINCTLY: exactly the revert of extra-a.txt.
    const lr = rev.lateRange;
    check("(land) worker_merge shows the late range distinctly: assembledTip..liveTip, one file (extra-a.txt), 1 deletion",
      !!lr && lr.assembledTip === s.assembledTip && lr.liveTip === s.liveTip && lr.filesChanged === 1 && lr.files[0]?.file === "extra-a.txt" && lr.deletions === 1 && lr.insertions === 0);
    check("(land) the late range lists the late commit's subject", !!lr && Array.isArray(lr.commitSubjects) && lr.commitSubjects.includes("late-revert"));
    const mainBefore = git(repo, "rev-parse HEAD");
    const res = await mk({ runGate: async () => ({ passed: true }) }).confirmWorkerMerge(mgrId, wA);
    check("(land) worker_merge_confirm lands the late range: merged:true", res.merged === true);
    check("(land) OUTCOME: main ends up WITHOUT the reverted extra-a.txt (and still WITH feature-a.txt)", !fs.existsSync(path.join(repo, "extra-a.txt")) && fs.existsSync(path.join(repo, "feature-a.txt")));
    const landed = git(repo, "rev-parse HEAD");
    check("(land) exactly ONE new commit on main, and it touches ONLY extra-a.txt (the range, not the fork-point squash)",
      landed !== mainBefore && git(repo, `rev-list --count ${mainBefore}..${landed}`) === "1" && git(repo, `diff --name-only ${mainBefore} ${landed}`) === "extra-a.txt");
    check("(land) the landing commit carries the branch trailer", git(repo, "log -1 --format=%B").includes(`Loom-Worker-Branch: ${a.branch}`));
    check("(land) the hold is released (merge_done filed), the task is finalized and the branch deleted", (await mk().isBranchHeld(a.branch, repo)) === undefined && !refExists(repo, a.branch) && db.getTask(a.taskId)?.columnKey !== "in_progress");
  }

  // ── (rewritten) assembledTip is no longer an ancestor of the branch tip ────────────────────────────────────────
  {
    const s = await setup("rewritten");
    const { repo, mgrId, wA, a, mk } = s;
    // Rewrite A's branch: reset to the fork point and re-commit a different feature-a.txt, so the batch's assembledTip is NOT an ancestor.
    const wt = a.worktreePath;
    git(wt, `reset -q --hard ${git(repo, "rev-list --max-parents=0 HEAD")}`);
    fs.writeFileSync(path.join(wt, "feature-a.txt"), "rewritten\n");
    commitAll(wt, "rewritten", GIT_ID);
    let ancestor = true;
    try { git(repo, `merge-base --is-ancestor ${s.assembledTip} ${a.branch}`); } catch { ancestor = false; }
    check("(rewritten setup) assembledTip is NOT an ancestor of the rewritten branch", ancestor === false);
    const rev = await mk().reviewWorkerMerge(mgrId, wA);
    check("(rewritten) worker_merge does not present a late range and WARNS that the held branch was rewritten", rev.lateRange === undefined && /rewritten|ancestor/i.test(rev.warning ?? ""));
    const mainBefore = git(repo, "rev-parse HEAD");
    const res = await mk({ runGate: async () => ({ passed: true }) }).confirmWorkerMerge(mgrId, wA);
    check("(rewritten) confirm REFUSES with guidance (merged:false, names the rewrite)", res.merged === false && /HELD/.test(res.reason ?? "") && /rewritten|ancestor/i.test(res.reason ?? ""));
    check("(rewritten) main did not move; branch and worktree intact", git(repo, "rev-parse HEAD") === mainBefore && refExists(repo, a.branch) && fs.existsSync(a.worktreePath));
  }

  // ── (unreadable) the recorded assembledTip cannot be read as a commit ─────────────────────────────────────────
  {
    const s = await setup("unreadable");
    const { repo, mgrId, wA, a, db, mk } = s;
    // Forge the retain's assembledTip to an object that does not exist (the latest retain event wins).
    const ev = db.listEventsForWorker(wA).find((e) => e.kind === "batch_merge_branch_retained");
    db.appendEvent({ ...ev, id: `bmlr-forged-${sfx}`, ts: new Date(Date.parse(ev.ts) + 1000).toISOString(), detail: { ...ev.detail, assembledTip: "0".repeat(40) } });
    const rev = await mk().reviewWorkerMerge(mgrId, wA);
    check("(unreadable) worker_merge presents no late range and warns", rev.lateRange === undefined && /assembledTip|could not/i.test(rev.warning ?? ""));
    const mainBefore = git(repo, "rev-parse HEAD");
    const res = await mk({ runGate: async () => ({ passed: true }) }).confirmWorkerMerge(mgrId, wA);
    check("(unreadable) confirm REFUSES (merged:false) NAMING the unreadable assembledTip (the pre-13fc5227 refusal did not), main untouched, branch intact", res.merged === false && /HELD/.test(res.reason ?? "") && /assembledTip/.test(res.reason ?? "") && git(repo, "rev-parse HEAD") === mainBefore && refExists(repo, a.branch));
  }

  // ── (moved) a worker commit AFTER the review still trips the reviewed-tip rule ─────────────────────────────────
  {
    const s = await setup("moved");
    const { repo, mgrId, wA, a, mk } = s;
    await mk().reviewWorkerMerge(mgrId, wA);
    fs.writeFileSync(path.join(a.worktreePath, "after-review.txt"), "unreviewed\n");
    commitAll(a.worktreePath, "after-review", GIT_ID);
    const mainBefore = git(repo, "rev-parse HEAD");
    const res = await mk({ runGate: async () => ({ passed: true }) }).confirmWorkerMerge(mgrId, wA);
    check("(moved, regression guard: also passes on pre-13fc5227 code) confirm is REFUSED by the reviewed-tip rule (nothing merged)", res.merged === false && /worker_merge review|reviewed/i.test(res.reason ?? ""));
    check("(moved, regression guard) main did not move; the after-review commit is not on main", git(repo, "rev-parse HEAD") === mainBefore && !fs.existsSync(path.join(repo, "after-review.txt")));
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
}
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
