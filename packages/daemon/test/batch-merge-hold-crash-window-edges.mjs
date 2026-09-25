import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// THE HOLD'S GIT-FACT ARM: FAIL-CLOSED AND SPECIFIC (card 42daa283, round 7) — split from batch-merge-hold-crash-window.mjs to keep each file's runtime down.
// Same crash-window fixture (a real merge_batch retains A; A's live tip is squashed onto main WITHOUT finalize). Proves:
//   (errboot)    boot Pass A AND the branch-ref sweep under an ERRORING git read: A's ref, worktree and task untouched (fail-closed everywhere)
//   (ancestor)   a retain whose landedSha is NOT an ancestor of HEAD cannot prove "strictly after": still held (error), never released
//   (specific)   a later trailer for a DIFFERENT branch must NOT release (grep specificity); a later trailer for THIS branch does (positive control,
//                and the accepted bound: a human commit carrying the trailer would release too — see the decision record)
// Run: 1) pnpm build, 2) node packages/daemon/test/batch-merge-hold-crash-window-edges.mjs
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
  // ── (errboot) boot Pass A + the branch-ref sweep under an ERRORING git read: everything stays put ─────────────────────────────
  {
    const c = await crashWindow("errboot");
    // Make the sweep able to consider A's branch: detach A's worktree (a checked-out branch is filtered out anyway), point origin/HEAD at main
    // (the sweep's mainline) and record A's tip as MERGED into main with an `-s ours` merge (no content change) — so `git branch --merged main`
    // lists it, i.e. WITHOUT the hold the sweep WOULD delete A's ref.
    git(c.a.worktreePath, "checkout -q --detach");
    const mainName = git(c.repo, "rev-parse --abbrev-ref HEAD"); // the fixture repo's default branch (master or main, per git config)
    git(c.repo, `update-ref refs/remotes/origin/${mainName} HEAD`);
    git(c.repo, `symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/${mainName}`);
    git(c.repo, `-c user.email=bmcw@loom -c user.name=bmcw merge -q -s ours --no-edit ${c.a.branch}`);
    check("(errboot) setup: the sweep WOULD consider A's branch (it is --merged into the mainline and no longer checked out)", git(c.repo, `branch --merged ${mainName}`).split(String.fromCharCode(10)).map((x) => x.replace(/^[*+ ]+/, "")).includes(c.a.branch));
    const failing = () => ({ raw: async () => { throw new Error("simulated transient git failure"); } });
    const boot = await c.mk({ heldProbeGitFactory: failing }).reconcileOrchestrationOnBoot();
    // (mergesFinished is NOT asserted: B, already finalized by the batch, is legitimately re-finished by Pass A; A's own state is asserted below.)
    // (B's already-landed, still-present branch is legitimately reclaimed by the sweep, so the count is not asserted — A's own ref is, below.)
    check("(errboot) the sweep did NOT delete A's ref (though it is --merged), and A's branch, worktree and task are untouched with no merge_done filed", refExists(c.repo, c.a.branch) && fs.existsSync(c.a.worktreePath) && c.db.getTask(c.a.taskId)?.columnKey === "in_progress" && c.db.listEventsForBranch(c.a.branch, "merge_done").length === 0);
  }

  // ── (ancestor) landedSha not an ancestor of HEAD ⇒ "strictly after" cannot be proven ⇒ still held ─────────────────────────────
  {
    const c = await crashWindow("ancestor", { squash: false });
    const notOnMain = git(c.repo, `rev-parse ${c.a.branch}`); // A's live tip: reachable from A's branch only, NOT from main
    c.db.appendEvent({ id: randomUUID(), ts: new Date(Date.now() + 5).toISOString(), managerSessionId: c.mgrId, kind: "batch_merge_branch_retained", workerSessionId: c.wA, taskId: c.a.taskId,
      detail: { opId: "anc", branch: c.a.branch, assembledTip: "0".repeat(40), liveTip: "1".repeat(40), phase: "pre-stop", landedSha: notOnMain } });
    const held = await c.mk().isBranchHeld(c.a.branch, c.repo);
    check("(ancestor) a landedSha that is not an ancestor of HEAD keeps the branch HELD, flagged gitUnverified (never released)", !!held && held.gitUnverified === true);
  }

  // ── (specific) the grep is specific to THIS branch ─────────────────────────────────────────────────────────────────────────
  {
    const c = await crashWindow("specific", { squash: false });
    check("(specific) setup: A is held before any later trailer", !!(await c.mk().isBranchHeld(c.a.branch, c.repo)));
    git(c.repo, `-c user.email=bmcw@loom -c user.name=bmcw commit -q --allow-empty -m "unrelated" -m "Loom-Worker-Branch: loom/some-other-branch"`);
    const other = await c.mk().isBranchHeld(c.a.branch, c.repo);
    check("(specific) a later Loom-Worker-Branch trailer for a DIFFERENT branch does NOT release A (held, not unverified)", !!other && other.gitUnverified === false);
    git(c.repo, `-c user.email=bmcw@loom -c user.name=bmcw commit -q --allow-empty -m "later" -m "Loom-Worker-Branch: ${c.a.branch}"`);
    check("(specific) positive control: a later trailer for THIS branch releases it (also the accepted bound — a human commit with the trailer would too)", (await c.mk().isBranchHeld(c.a.branch, c.repo)) === undefined);
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
}
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
