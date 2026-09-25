import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// THE HOLD IS KEYED ON THE BRANCH AND ENFORCED IN ONE PLACE (card 42daa283, round 5). Companion to batch-merge-retain-hold.mjs, which proves the
// re-fire / mixed-batch / restart behaviour of the hold. THIS file proves the two paths that used to bypass it:
//   (recycle)  worker_recycle mints a NEW session id on the SAME branch/worktree, so a hold keyed on the worker id silently dropped. A' (a
//              recycle-shaped successor) must stay held; the batch re-fire must neither assemble nor solo-confirm it.
//   (already)  an ALREADY_MERGED-style finish (a manager confirm on a card that sits in the terminal column) must not delete a held branch
//              — nor hard-stop its worker — even though the batch commit's Loom-Worker-Branch trailer "proves" the branch landed.
//   (passA)    boot Pass A finalizes by BRANCH from that same trailer proof; its only other guard (the path-content check) is fooled by a late
//              commit that REVERTS part of the branch's own change (here: `git rm extra-a.txt`). Pass A must skip a held branch: branch,
//              worktree and the late commit intact, no merge_done filed.
//   (release)  the ONE deliberate release is a real new squash of the live tip (worker_merge_confirm's Green path): with the gate ON (E) and
//              with the merge gate OFF (F). Its merge_done releases the hold; nothing else does.
//   (empty squash) A's own late commit nets to nothing against main, so confirm cannot land it: it is REFUSED with guidance, never destroyed.
// Fixture: A commits two files; the (idempotent) gate command `git rm`s one of them on A's branch mid-gate ⇒ A retained by a real merge_batch.
// Run: 1) pnpm build, 2) node packages/daemon/test/batch-merge-hold-branch-keyed.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-bmhk-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=bmhk@loom -c user.name=bmhk";
const now = new Date().toISOString();
const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const git = (cwd, args) => execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
// NOTE: `refs/heads/<b>` (never `<b>^{commit}` — cmd.exe treats `^` as its escape char on Windows).
const refExists = (repo, ref) => { try { git(repo, `rev-parse --verify --quiet refs/heads/${ref}`); return true; } catch { return false; } };
const subjects = (repo, ref) => git(repo, `log ${ref} --format=%s`).split("\n");
const noReap = async () => ({ killedPids: [] });

const dbs = [];
try {
  const repo = path.join(os.tmpdir(), `loom-bmhk-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  registerForCleanup(repo);
  fs.writeFileSync(path.join(repo, "README.md"), "# bmhk\n");
  execSync(`git init -q && git config user.email bmhk@loom && git config user.name bmhk`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);

  const projId = `bmhk-proj-${sfx}`, agentId = `bmhk-agent-${sfx}`, mgrId = `bmhk-mgr-${sfx}`;
  const cut = async (label, files) => {
    const taskId = `bmhk-task-${label}-${sfx}`;
    const { worktreePath, branch } = await createWorktree(repo, projId, taskId);
    registerForCleanup(worktreePath);
    for (const f of files) fs.writeFileSync(path.join(worktreePath, f), `work ${label} ${f}\n`);
    commitAll(worktreePath, label, GIT_ID);
    return { taskId, branch, worktreePath };
  };
  const a = await cut("a", ["feature-a.txt", "extra-a.txt"]);
  const b = await cut("b", ["feature-b.txt"]);
  const e = await cut("e", ["feature-e.txt"]); // a SECOND held branch (synthetic retain) for the gate-ON release case
  const f = await cut("f", ["feature-f.txt"]); // a THIRD held branch (synthetic retain) for the gate-OFF release case

  // IDEMPOTENT gate command: while A still carries extra-a.txt, `git rm` it and commit (a late commit that REVERTS part of A's own change).
  const script = path.join(os.tmpdir(), `loom-bmhk-gate-${sfx}.mjs`);
  registerForCleanup(script);
  fs.writeFileSync(script, [
    `import fs from "node:fs"; import path from "node:path"; import { execSync } from "node:child_process";`,
    `const wt = ${JSON.stringify(a.worktreePath)};`,
    `if (fs.existsSync(path.join(wt, "extra-a.txt"))) {`,
    `  execSync("git rm -q extra-a.txt && git -c user.email=bmhk@loom -c user.name=bmhk commit -q -m late-revert", { cwd: wt, stdio: "ignore" });`,
    `}`,
    `process.exit(0);`,
  ].join("\n"));

  const db = new Db(); dbs.push(db);
  db.insertProject({ id: projId, name: "BMHK", repoPath: repo, vaultPath: repo, config: { orchestration: { gateCommand: `node "${script}"` } }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "dev", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId, engineSessionId: null, title: null, cwd: repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  const wA = `bmhk-wkr-a-${sfx}`, wB = `bmhk-wkr-b-${sfx}`, wA2 = `bmhk-wkr-a2-${sfx}`, wE = `bmhk-wkr-e-${sfx}`, wF = `bmhk-wkr-f-${sfx}`;
  const workerRow = (id, w, extra = {}) => ({ id, projectId: projId, agentId, engineSessionId: null, title: null, cwd: w.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId: w.taskId, worktreePath: w.worktreePath, branch: w.branch, ...extra });
  for (const [wId, w, label] of [[wA, a, "a"], [wB, b, "b"], [wE, e, "e"], [wF, f, "f"]]) {
    db.insertTask({ id: w.taskId, projectId: projId, title: `feat(test): ${label}`, body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
    db.insertSession(workerRow(wId, w));
  }
  const stopped = [];
  const ptyStub = { stop(id) { stopped.push(id); }, isAlive() { return false; }, enqueueStdin() {}, purgeQueuedWorkerReportNudgesOnMerge() {}, purgeQueuedWorkerIdleNudges() {} };
  const mk = (extra = {}) => new SessionService(db, ptyStub, new OrchestrationControl(), { syncAttachBudgetMs: 600_000, reapWorktreeProcesses: noReap, ...extra });

  // ── setup: a REAL merge_batch retains A (the gate reverts extra-a.txt on A's branch mid-gate) ─────────
  const first = await mk().mergeBatchTracked(mgrId, [wA, wB]);
  const firstVal = first.settled && first.ok ? first.value : undefined;
  check("(setup) the batch landed A and B", firstVal?.ok === true && !!firstVal.landed.find((l) => l.branch === a.branch) && !!firstVal.landed.find((l) => l.branch === b.branch));
  check("(setup) A was RETAINED (its branch moved during the gate)", !!firstVal?.landed.find((l) => l.branch === a.branch)?.branchAdvancedDuringGate);
  check("(setup) main carries A's batch-landed extra-a.txt (the late revert is NOT on main)", fs.existsSync(path.join(repo, "extra-a.txt")) && fs.existsSync(path.join(repo, "feature-a.txt")));
  check("(setup) A's branch carries the late-revert commit and no extra-a.txt", subjects(repo, a.branch).includes("late-revert") && !fs.existsSync(path.join(a.worktreePath, "extra-a.txt")));
  let mainAfterFirst = git(repo, "rev-parse HEAD");
  // E: a synthetic retain on a branch with a real, un-landed commit.
  for (const [w, x] of [[wE, e], [wF, f]]) db.appendEvent({ id: randomUUID(), ts: new Date().toISOString(), managerSessionId: mgrId, kind: "batch_merge_branch_retained", workerSessionId: w, taskId: x.taskId, detail: { opId: "synthetic", branch: x.branch, assembledTip: "0".repeat(40), liveTip: "1".repeat(40), phase: "pre-stop" } });

  const nothingLanded = (tag) => {
    check(`(${tag}) main did not move and the late revert is not on main (extra-a.txt still there)`, git(repo, "rev-parse HEAD") === mainAfterFirst && fs.existsSync(path.join(repo, "extra-a.txt")));
    check(`(${tag}) A's branch, its late-revert commit and its worktree are intact`, refExists(repo, a.branch) && subjects(repo, a.branch).includes("late-revert") && fs.existsSync(a.worktreePath) && !fs.existsSync(path.join(a.worktreePath, "extra-a.txt")));
    check(`(${tag}) no non-reconciled merge_done was filed for A's branch`, !db.listEventsForBranch(a.branch, "merge_done").some((ev) => ev.detail?.reconciled !== true));
  };

  // ── (recycle) a recycle-shaped SUCCESSOR: new session id, same branch/worktree, recycledFrom = the predecessor ────
  db.insertSession(workerRow(wA2, a, { recycledFrom: wA, gen: 2 }));
  const recycleVal = await (async () => { const r = await mk().mergeBatchTracked(mgrId, [wA2, wB]); return r.settled && r.ok ? r.value : undefined; })();
  const heldA2 = recycleVal?.fallback.find((f) => f.workerSessionId === wA2);
  check("(recycle) the recycle SUCCESSOR of A is reported held (started:false, \"held\") — the hold followed the branch, not the worker id", !!heldA2 && heldA2.started === false && /held/.test(heldA2.reason));
  nothingLanded("recycle");

  // ── (already) a manager confirm on a card sitting in the terminal column: the ALREADY_MERGED finish must refuse a held branch ─────────
  const terminalKey = mk().columnKeyForProjectRole(projId, "terminal");
  db.updateTask(a.taskId, { columnKey: terminalKey });
  const stopsBefore = stopped.length;
  const already = await mk().confirmWorkerMerge(mgrId, wA);
  check("(already) the confirm is REFUSED for the held branch (merged:false, reason names HELD)", already.merged === false && /HELD/.test(already.reason ?? ""));
  check("(already) the worker was NOT hard-stopped by the refused finish", stopped.length === stopsBefore);
  nothingLanded("already");
  db.updateTask(a.taskId, { columnKey: "in_progress" });

  // ── (passA) boot reconcile: the trailer proof says A landed, and the path-content guard is blind to the self-revert ─────────────────
  const boot = await mk().reconcileOrchestrationOnBoot();
  check("(passA) boot Pass A finished NO merge for the held branch", typeof boot.mergesFinished === "number" && boot.mergesFinished === 0);
  nothingLanded("passA");
  check("(passA) A's task was not moved to the terminal lane", db.getTask(a.taskId)?.columnKey === "in_progress");

  // ── (release, gate ON) E: a real new squash of the live tip — the one deliberate release ────────────────────────
  const gateOn = mk({ runGate: async () => ({ passed: true }) });
  const eRes = await gateOn.confirmWorkerMerge(mgrId, wE);
  check("(release, gate on) confirming held E lands it: merged:true, feature-e.txt on main", eRes.merged === true && fs.existsSync(path.join(repo, "feature-e.txt")));
  check("(release, gate on) E's hold is released (a real merge_done newer than the retain) and its branch was finalized", (await gateOn.isBranchHeld(e.branch, repo)) === undefined && !refExists(repo, e.branch));

  // ── (release, gate OFF) F: the human-only merge-gate switch is off; the manual confirm still lands and releases ────────────────
  const cfg = db.getProject(projId).config;
  db.setProjectConfig(projId, { ...cfg, orchestration: { ...(cfg.orchestration ?? {}), mergeGate: "off" } });
  const offSvc = mk({ runGate: async () => { throw new Error("the gate must NOT run while the switch is off"); } });
  check("(release, gate off) precondition: F is held", !!(await offSvc.isBranchHeld(f.branch, repo)));
  const fRes = await offSvc.confirmWorkerMerge(mgrId, wF);
  check("(release, gate off) the manual confirm lands F (merged:true, gate skipped, feature-f.txt on main)", fRes.merged === true && fRes.skipped === true && fs.existsSync(path.join(repo, "feature-f.txt")));
  check("(release, gate off) F is released and its branch finalized", (await offSvc.isBranchHeld(f.branch, repo)) === undefined && !refExists(repo, f.branch));

  // ── (empty squash) A's late commit only REVERTS part of A's own change, so a squash of its live tip nets to nothing against main: confirm
  // ── cannot land it. It must be REFUSED (held, intact, with guidance) — never finalized-and-deleted (the reviewer's data-loss repro). ─────
  mainAfterFirst = git(repo, "rev-parse HEAD"); // E and F legitimately landed since; A's refused confirm must not move main any further
  const aRes = await offSvc.confirmWorkerMerge(mgrId, wA);
  check("(empty squash) confirming A is refused (merged:false) with the cherry-pick guidance", aRes.merged === false && /HELD/.test(aRes.reason ?? "") && /cherry-pick/.test(aRes.reason ?? ""));
  nothingLanded("empty squash");
  check("(empty squash) A is STILL held", !!(await offSvc.isBranchHeld(a.branch, repo)));

} finally {
  for (const db of dbs) try { db.close(); } catch { /* ignore */ }
}
console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
