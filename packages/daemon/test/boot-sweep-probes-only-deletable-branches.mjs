import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// BOOT BRANCH-REF SWEEP PROBES ONLY `merged ∩ retained` (card 4aee2e14): a retained branch the sweep could never delete (not --merged into the mainline, or from
// another repo) must trigger NO git probe; a retained branch that IS --merged (A) must still be probed and stay protected. Counted via heldProbeGitFactory.
//   (unrelated) no probe call names the unrelated retained branches   (positive) A's probe fires (calls>0 naming A) and A's ref survives
// Run: 1) pnpm build, 2) node packages/daemon/test/boot-sweep-probes-only-deletable-branches.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-bmcw-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, mergeBranch } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=bmcw@loom -c user.name=bmcw";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// NOTE: `refs/heads/<b>` (never `<b>^{commit}` — cmd.exe treats `^` as its escape char on Windows).
const refExists = (repo, ref) => { try { git(repo, `rev-parse --verify --quiet refs/heads/${ref}`); return true; } catch { return false; } };
const noReap = async () => ({ killedPids: [] });
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {}, purgeQueuedWorkerReportNudgesOnMerge() {}, purgeQueuedWorkerIdleNudges() {} };

const dbs = [];
/** A real merge_batch [A,B] retains A (a NON-empty late commit lands on A mid-gate), then the Green-path squash of A's live tip is
 *  simulated up to — and NOT including — finalize: the crash window. */
async function crashWindow(tag, { squash = true } = {}) {
  const repo = path.join(os.tmpdir(), `loom-bmcw-${tag}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# bmcw\n");
  execSync(`git init -q && git config user.email bmcw@loom && git config user.name bmcw`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  const projId = `bmcw-proj-${tag}-${sfx}`, agentId = `bmcw-agent-${tag}-${sfx}`, mgrId = `bmcw-mgr-${tag}-${sfx}`;
  const cut = async (label, file) => {
    const taskId = `bmcw-task-${tag}-${label}-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    fs.writeFileSync(path.join(worktreePath, file), `work ${label}\n`);
    commitAll(worktreePath, label, GIT_ID);
    return { taskId, branch, worktreePath };
  };
  const a = await cut("a", "feature-a.txt");
  const b = await cut("b", "feature-b.txt");
  const script = path.join(os.tmpdir(), `loom-bmcw-gate-${tag}-${sfx}.mjs`);
  registerForCleanup(script);
  fs.writeFileSync(script, [
    `import fs from "node:fs"; import path from "node:path"; import { execSync } from "node:child_process";`,
    `const wt = ${JSON.stringify(a.worktreePath)};`,
    `if (!fs.existsSync(path.join(wt, "late.txt"))) {`,
    `  fs.writeFileSync(path.join(wt, "late.txt"), "added during the gate\\n");`,
    `  execSync("git add late.txt && git -c user.email=bmcw@loom -c user.name=bmcw commit -q -m late-commit", { cwd: wt, stdio: "ignore" });`,
    `}`,
    `process.exit(0);`,
  ].join("\n"));
  const db = new Db(); dbs.push(db);
  db.insertProject({ id: projId, name: `BMCW-${tag}`, repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: `node "${script}"` } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const wA = `bmcw-wkr-a-${tag}-${sfx}`, wB = `bmcw-wkr-b-${tag}-${sfx}`;
  for (const [wId, w, label] of [[wA, a, "a"], [wB, b, "b"]]) {
    db.insertTask({ id: w.taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession({ id: wId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch });
  }
  const mk = (extra = {}) => new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 600_000, reapWorktreeProcesses: noReap, ...extra });

  const first = await mk().mergeBatchTracked(mgrId, [wA, wB]);
  const val = first.settled && first.ok ? first.value : undefined;
  check(`(${tag} setup) the batch landed A and B and RETAINED A`, val?.ok === true && !!val.landed.find((l) => l.branch === a.branch)?.branchAdvancedDuringGate && !!val.landed.find((l) => l.branch === b.branch));
  const retain = db.listEventsForBranch(a.branch, "batch_merge_branch_retained")[0];
  check(`(${tag} setup) the retain event records the batch's own landed sha (landedSha)`, typeof retain?.detail?.landedSha === "string" && /^[0-9a-f]{40}$/.test(retain.detail.landedSha));
  check(`(${tag} setup) main does not carry the late commit yet`, !fs.existsSync(path.join(repo, "late.txt")));

  if (!squash) return { repo, db, mk, mgrId, wA, a, sq: undefined };
  // The Green-path squash of A's LIVE tip — then the "crash": no pty.stop, no gc, no task move, no merge_done.
  const sq = await mergeBranch(repo, a.branch, "feat(test): a", { timeoutMs: 60_000 });
  check(`(${tag} crash) the squash of A's live tip landed on main (late.txt present) with a real sha`, sq.ok === true && !!sq.sha && fs.existsSync(path.join(repo, "late.txt")));
  check(`(${tag} crash) the squash commit carries A's Loom-Worker-Branch trailer`, git(repo, `log -1 --format=%B ${sq.sha}`).includes(`Loom-Worker-Branch: ${a.branch}`));
  check(`(${tag} crash) NO merge_done exists for A's branch (the daemon died before finalize) and A's branch/worktree/task are untouched`,
    db.listEventsForBranch(a.branch, "merge_done").length === 0 && refExists(repo, a.branch) && fs.existsSync(a.worktreePath) && db.getTask(a.taskId)?.columnKey === "in_progress");
  return { repo, db, mk, mgrId, wA, a, sq };
}

try {
  const c = await crashWindow("sweepprobe");
  git(c.a.worktreePath, "checkout -q --detach");
  const mainName = git(c.repo, "rev-parse --abbrev-ref HEAD");
  git(c.repo, `update-ref refs/remotes/origin/${mainName} HEAD`);
  git(c.repo, `symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/${mainName}`);
  git(c.repo, `-c user.email=bmcw@loom -c user.name=bmcw merge -q -s ours --no-edit ${c.a.branch}`);
  const landedSha = git(c.repo, "rev-parse HEAD");
  // Unrelated retained branches: one unknown to this repo (as if from another repo), one that exists here but is NOT merged into mainline.
  git(c.repo, `checkout -q -b loom/unmerged-tmp-${sfx}`);
  fs.writeFileSync(path.join(c.repo, "unmerged.txt"), "x\n");
  commitAll(c.repo, "unmerged work", GIT_ID);
  git(c.repo, `checkout -q ${mainName}`);
  const others = [`loom/other-repo-${sfx}`, `loom/unmerged-tmp-${sfx}`];
  for (const br of others) {
    c.db.appendEvent({ id: randomUUID(), ts: new Date(Date.now() + 5).toISOString(), managerSessionId: c.mgrId, kind: "batch_merge_branch_retained", workerSessionId: c.wA, taskId: c.a.taskId,
      detail: { opId: "x", branch: br, assembledTip: "0".repeat(40), liveTip: "1".repeat(40), phase: "pre-stop", landedSha } });
  }
  check("(unrelated setup) the unrelated branches ARE in listRetainedBranches (so a pre-fix sweep would probe them)", others.every((o) => c.db.listRetainedBranches().includes(o)));
  check("(unrelated setup) the unmerged branch is NOT --merged into mainline", !git(c.repo, `branch --merged ${mainName}`).includes(`loom/unmerged-tmp-${sfx}`));
  const calls = [];
  const counting = () => ({ raw: async (args) => { calls.push(args.join(" ")); throw new Error("simulated transient git failure"); } });
  await c.mk({ heldProbeGitFactory: counting }).reconcileOrchestrationOnBoot();
  check(`(positive) A (--merged + retained) WAS probed (git probe calls made: ${calls.length})`, calls.length > 0 && calls.some((x) => x.includes(c.a.branch) || x.includes(landedSha) || x.includes("merge-base")));
  check("(positive) A's ref is still protected (probe error fails toward NOT deleting)", refExists(c.repo, c.a.branch));
  check(`(unrelated) probe count is A's alone (≤2 probe-git calls incl. Pass A; pre-fix 4 with the 2 unrelated branches) — count-based, args carry no branch name: ${calls.length}`, calls.length <= 2);
  check("(unrelated) the unmerged branch's ref is untouched", refExists(c.repo, `loom/unmerged-tmp-${sfx}`));
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
}
console.log(failures === 0 ? "All checks passed." : `${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
