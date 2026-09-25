import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// A CRASH INSIDE THE RELEASE WINDOW MUST NOT DEADLOCK A HELD BRANCH (card 42daa283, round 6).
// A merge_batch retained A (a commit landed on its branch after the batch assembled it). The manager then confirms A: the Green path
// squashes A's live tip onto main (the deliberate, release-worthy landing) and only LATER — after pty.stop, gcWorktreeDir (minutes on
// Windows) and updateTask — does finalizeMerge append the `merge_done` that used to be the ONLY thing releasing the hold. If the daemon dies
// in between, the squash is on main with NO merge_done: boot Pass A saw the landed squash but skipped the branch as held, every re-confirm
// routed via ALREADY_MERGED into finishAlreadyMerged, which refused it as held, and nothing ever wrote the merge_done — a permanent deadlock
// (before the hold existed, Pass A recovered this crash). The fix anchors the release on the DURABLE GIT FACT too: the retain event records the
// batch's own landed sha (`landedSha`), and the branch is RELEASED once main carries a `Loom-Worker-Branch: <branch>` commit that descends from it.
// Simulated crash: mergeBranch (the real Green-path squash) runs, then NOTHING else — no pty.stop, no gc, no task move, no merge_done.
//   (passA)      boot reconcile finishes A: branch deleted, task moved, a REAL merge_done filed
//   (reconfirm)  a manager re-confirm finishes A the same way (ALREADY_MERGED after the empty squash)
//   (failclosed) a git read that ERRORS keeps A HELD, and the refusal says the release could not be VERIFIED (never "never landed")
//   (legacy)     a retain event WITHOUT landedSha (pre-fix rows) releases only by merge_done, exactly as before
// The boot-under-erroring-git, ancestor and grep-specificity edge cases live in batch-merge-hold-crash-window-edges.mjs (split to keep runtime down).
// Run: 1) pnpm build, 2) node packages/daemon/test/batch-merge-hold-crash-window.mjs
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
  // ── (passA) ──────────────────────────────────────────────────────────────────────────────────────────
  {
    const c = await crashWindow("passA");
    const boot = await c.mk().reconcileOrchestrationOnBoot();
    check("(passA) boot Pass A finished the crashed merge (mergesFinished >= 1)", boot.mergesFinished >= 1);
    check("(passA) A's branch was finalized (deleted) and a REAL (non-reconciled) merge_done was filed", !refExists(c.repo, c.a.branch) && c.db.listEventsForBranch(c.a.branch, "merge_done").some((e) => e.detail?.reconciled !== true));
    check("(passA) A's task moved out of in_progress", c.db.getTask(c.a.taskId)?.columnKey !== "in_progress");
  }

  // ── (reconfirm) ──────────────────────────────────────────────────────────────────────────────────────
  {
    const c = await crashWindow("reconfirm");
    const res = await c.mk({ runGate: async () => ({ passed: true }) }).confirmWorkerMerge(c.mgrId, c.wA);
    check("(reconfirm) a manager re-confirm finishes A (merged:true, not refused as held)", res.merged === true && !/HELD/.test(res.reason ?? ""));
    check("(reconfirm) A's branch was finalized and a REAL merge_done was filed", !refExists(c.repo, c.a.branch) && c.db.listEventsForBranch(c.a.branch, "merge_done").some((e) => e.detail?.reconciled !== true));
  }

  // ── (failclosed) a git read that ERRORS must keep the branch HELD — and say the release could not be VERIFIED ─────────────
  {
    const c = await crashWindow("failclosed");
    const failing = () => ({ raw: async () => { throw new Error("simulated transient git failure"); } });
    const svc = c.mk({ heldProbeGitFactory: failing });
    const held = await svc.isBranchHeld(c.a.branch, c.repo);
    check("(failclosed) with an erroring git read the branch is STILL held, flagged gitUnverified", !!held && held.gitUnverified === true);
    const res = await svc.confirmWorkerMerge(c.mgrId, c.wA);
    check("(failclosed) the confirm is refused, and the text says the release could NOT BE VERIFIED (not that the content was never landed)",
      res.merged === false && /could not be verified/i.test(res.reason ?? "") && !/never gated or landed/.test(res.reason ?? ""));
    check("(failclosed) nothing was deleted", refExists(c.repo, c.a.branch) && fs.existsSync(c.a.worktreePath));
    // …and the SAME state with a healthy git releases it (the control that shows the git arm — not merge_done — did the releasing).
    const healthy = await c.mk().isBranchHeld(c.a.branch, c.repo);
    check("(failclosed) control: with a healthy git read the same branch is RELEASED by the landed trailer squash", healthy === undefined);
  }

  // ── (legacy) a retain event WITHOUT landedSha releases only by merge_done, exactly as before ────────────────────────────
  {
    const c = await crashWindow("legacy");
    // Rewrite history to look like a pre-fix row: a retain event with no landedSha (a fresh synthetic one, newer than the real one).
    c.db.appendEvent({ id: randomUUID(), ts: new Date(Date.now() + 5).toISOString(), managerSessionId: c.mgrId, kind: "batch_merge_branch_retained", workerSessionId: c.wA, taskId: c.a.taskId,
      detail: { opId: "legacy", branch: c.a.branch, assembledTip: "0".repeat(40), liveTip: "1".repeat(40), phase: "pre-stop" } });
    const held = await c.mk().isBranchHeld(c.a.branch, c.repo);
    check("(legacy) a retain row without landedSha stays held even though a trailer squash is on main (merge_done arm only)", !!held);
    c.db.appendEvent({ id: randomUUID(), ts: new Date(Date.now() + 10).toISOString(), managerSessionId: c.mgrId, kind: "merge_done", workerSessionId: c.wA, taskId: c.a.taskId, detail: { branch: c.a.branch } });
    check("(legacy) a real merge_done newer than the retain releases it", (await c.mk().isBranchHeld(c.a.branch, c.repo)) === undefined);
  }
} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
}
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
