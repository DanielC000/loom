import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card cc9bce38 — a SOLO worker_merge_confirm's finalize must not delete a branch that moved after the squash landed.
// The worker is still alive between mergeBranch releasing its lock and finalize's hard stop, so a commit it makes in that window used to be
// destroyed (`git branch -D` + worktree force-remove) under merged:true. finalizeMerge now gets the tip the squash actually ran on and the
// SAME compare-and-swap the batch path uses (card 42daa283). The stub pty's stop() is the window: it commits to the worker's branch.
//   (A) Green + gate: a commit lands in the stop window => branch/worktree/commit kept, no merge_done, merged:true + warning,
//       a merge_branch_retained event (source:"solo"), and the branch is HELD through the batch's ONE definition (isBranchHeld). A re-confirm whose squash is
//       non-empty lands the late commit through the held path (Green real squash releases the hold).
//   (B) ALREADY_MERGED (in-confirm noop path): same window, same outcome; a re-confirm lands the late commit.
//   (C) control: no late commit => branch deleted, merge_done filed, no retained event (so (A)/(B) are not vacuous).
//   (D) commit lands AFTER finalize's tip check but before the CAS delete (in the worktree GC reap step) => FINALIZED, only the ref kept.
//   (E) UNPINNED landing (no gateCommand, so no landing pin): the tip comes from mergeBranchLocked's landedTip; a stop-window commit is still kept.
//   (F) landedTip is returned by mergeBranch on both the squash and the ALREADY_MERGED noop.
//   (G) PARTIAL REVERT (Code Review Major 1): the stop-window commit reverts part of the branch's own change, so a fork-point squash of a re-confirm would be EMPTY.
//       Since card 13fc5227 the re-confirm lands the LATE RANGE (landedTip..liveTip) instead: main loses the reverted file and the hold is released.
//   (H) the retention is visible on the async path: the [loom:already-merged] push (sent AFTER finalize) says RETAINED, never "finishing the worktree cleanup".
//   (J) STATE-BASED HOLD (Code Review round 2): a retention with NOTHING unlanded releases itself: the hold lasts only while the branch tip differs from the landed tip
//       (solo landedTip, batch assembledTip, or — when the retention recorded none — the landed squash's Loom-Landed-Tip trailer). The next confirm FINISHES.
//   (K) the ref-kept guidance never promises a confirm that would loop.
//   (L) a late WHOLE-FILE REVERT on the early-finish recovery path: pinned to the squash's Loom-Landed-Tip TRAILER, so the branch is KEPT (a stable-tip read + content check would bless it).
//   (N) the IN-CONFIRM ALREADY_MERGED finish (Code Review round 3): a late WHOLE-FILE revert made after the trailer squash landed, NO retention yet: the finish must pin to the squash's
//       Loom-Landed-Tip trailer (the ONE resolver), never to the tip mergeBranch froze and found empty, so the branch is KEPT. (N2) the same for a PARTIAL revert.
//   (O) the trailer is read ONLY from the final trailer block: a body that merely quotes the text is not a trailer.
//   (P) a DELETED branch does NOT release a hold (42daa283: a missing branch is not a release; batch-merge-retain-hold-release pins the same).
//   (M) control: a squash with NO trailer (pre-cc9bce38) and nothing late still finishes and deletes via the stable-tip fallback.
//   (I) finalize skips the CAS ref delete while git still has the branch checked out in ANOTHER worktree, even though the worktree it was handed was removed.
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/merge-confirm-solo-finalize-tip-cas.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { registerForCleanup } from "./_tmp-fixture.mjs";
import { commitAll } from "./_git-commit.mjs";
import { settleTracked } from "./_settle-tracked.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mcsf-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });
registerForCleanup(process.env.LOOM_HOME);
process.env.LOOM_CODEX_BIN = path.join(os.tmpdir(), "loom-mcsf-nonexistent-codex");

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, mergeBranch, readLandedTipTrailer } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mcsf@loom -c user.name=mcsf";
const now = new Date().toISOString();
const openDbs = [];
const PASS = { passed: true, steps: [] };
const sfxOf = (tag) => `${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const confirm = (sessions, mgrId, workerId) => settleTracked(() => sessions.confirmWorkerMergeTracked(mgrId, workerId), { label: "confirmWorkerMergeTracked" });

function makeRepo(repo) {
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# mcsf\n");
  execSync(`git init -q && git config user.email mcsf@loom && git config user.name mcsf`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
}

// `hooks.onStop` runs inside the stub pty's stop() (the window after the squash lock released); `hooks.onReap` inside the worktree-GC reap step.
async function setup(sfx, { gateCommand = "pnpm gate" } = {}) {
  const reposDir = path.join(os.tmpdir(), `loom-mcsf-${sfx}`);
  registerForCleanup(reposDir);
  const db = new Db(); openDbs.push(db);
  const mgrId = `mcsf-mgr-${sfx}`, projId = `mcsf-p-${sfx}`, taskId = `mcsf-t-${sfx}`, workerId = `mcsf-w-${sfx}`;
  const repo = path.join(reposDir, "repo");
  makeRepo(repo);
  db.insertProject({ id: projId, name: "MCSF", repoPath: repo, vaultPath: repo, config: { orchestration: gateCommand ? { gateCommand } : {} }, createdAt: now, archivedAt: null });
  db.insertAgent({ id: `agent-mcsf-m-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({ id: mgrId, projectId: projId, agentId: `agent-mcsf-m-${sfx}`, engineSessionId: null, title: null, cwd: repo, processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertAgent({ id: `agent-mcsf-w-${sfx}`, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: taskId, projectId: projId, title: "MCSF-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  const wt = await createWorktree(repo, projId, taskId);
  fs.writeFileSync(path.join(wt.worktreePath, "feature.txt"), "work\n");
  commitAll(wt.worktreePath, "feature", GIT_ID);
  db.insertSession({ id: workerId, projectId: projId, agentId: `agent-mcsf-w-${sfx}`, engineSessionId: null, title: null, cwd: wt.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: mgrId, taskId, worktreePath: wt.worktreePath, branch: wt.branch });
  const hooks = { onStop: null, onReap: null };
  const pushes = []; // every message the stub pty was asked to deliver (the manager-facing nudges)
  const ptyStub = { stop() { const f = hooks.onStop; hooks.onStop = null; if (f) f(); }, isAlive() { return false; }, enqueueStdin(_id, text) { pushes.push(String(text)); return { delivered: true }; }, getPid() { return undefined; } };
  const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
    syncAttachBudgetMs: 60_000,
    reapWorktreeProcesses: async () => { const f = hooks.onReap; hooks.onReap = null; if (f) f(); return { killedPids: [] }; },
    runGate: async () => PASS,
  });
  const git = (a) => execSync("git " + a, { cwd: repo, encoding: "utf8" }).trim();
  const lateCommit = (file) => { fs.writeFileSync(path.join(wt.worktreePath, file), "late\n"); commitAll(wt.worktreePath, file, GIT_ID); };
  // A commit made straight on the ref (the worktree may already be gone): parent = current tip, same tree (`tip:` = its tree; a `^` would be eaten by cmd.exe).
  const lateRefCommit = () => {
    const tip = git(`rev-parse ${wt.branch}`);
    const c = git(`${GIT_ID} commit-tree ${tip}: -p ${tip} -m late-ref`);
    git(`update-ref refs/heads/${wt.branch} ${c}`);
    return c;
  };
  const safe = (f, dflt) => { try { return f(); } catch { return dflt; } }; // a deleted branch must read as a failed CHECK, not a crash
  const subjects = () => safe(() => git(`log --format=%s ${wt.branch}`).split(String.fromCharCode(10)).map((x) => x.trim()), []);
  const liveTip = () => safe(() => git(`rev-parse ${wt.branch}`), null);
  const branchExists = () => { try { git(`rev-parse --verify --quiet refs/heads/${wt.branch}`); return true; } catch { return false; } };
  const mergeDone = () => db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_done").length;
  const retained = () => db.listEventsForWorker(workerId).filter((e) => e.kind === "merge_branch_retained");
  return { db, mgrId, workerId, repo, wt, hooks, pushes, sessions, git, lateCommit, lateRefCommit, subjects, liveTip, branchExists, mergeDone, retained };
}

{
  const t = await setup(sfxOf("green"));
  t.hooks.onStop = () => t.lateCommit("late.txt");
  const r = await confirm(t.sessions, t.mgrId, t.workerId);
  const late = t.liveTip();
  check("(A) settled merged:true (the gated tip landed)", r.settled === true && r.ok && r.value.merged === true && fs.existsSync(path.join(t.repo, "feature.txt")));
  check("(A) the late commit is NOT on main (it was never gated)", !fs.existsSync(path.join(t.repo, "late.txt")));
  check("(A) the branch is NOT deleted", t.branchExists());
  check("(A) the late commit is still reachable from the branch", t.subjects().includes("late.txt"));
  check("(A) the worktree is retained", fs.existsSync(t.wt.worktreePath));
  check("(A) not finalized: no merge_done", t.mergeDone() === 0);
  check("(A) the result warns that the branch advanced and was retained", r.ok && /advanced after this merge landed/.test(r.value.warning ?? "") && /NOT finalized/.test(r.value.warning ?? ""));
  const ev = t.retained();
  check("(A) one merge_branch_retained event: source solo, phase at-finalize, landedTip != liveTip", ev.length === 1 && ev[0].detail.source === "solo" && ev[0].detail.phase === "at-finalize" && ev[0].detail.liveTip === late && !!ev[0].detail.landedTip && ev[0].detail.landedTip !== late && ev[0].detail.branch === t.wt.branch);
  check("(A) HELD through the ONE definition (isBranchHeld) while the event kind stays distinct from the batch's", t.db.listEventsForBranch(t.wt.branch, "batch_merge_branch_retained").length === 0 && !!(await t.sessions.isBranchHeld(t.wt.branch, t.repo)));
  check("(A) the result carries the dedicated branchRetainedWarning field (echoed on the async nudge)", r.ok && /advanced after this merge landed/.test(r.value.branchRetainedWarning ?? ""));
  const r2 = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(A) re-confirm (non-empty squash) goes Green through the held path and lands the late commit, releasing the hold", r2.settled === true && r2.ok && r2.value.merged === true && r2.value.emptyKind === undefined && fs.existsSync(path.join(t.repo, "late.txt")));
}
{
  // (B) reach the in-confirm ALREADY_MERGED path: worktree present, task not terminal, and the branch's work already on main via a prior trailer squash.
  const t = await setup(sfxOf("am"));
  const pre = await mergeBranch(t.repo, t.wt.branch, "MCSF-TASK");
  check("(B) setup: the branch's work is already squashed onto main", pre.ok === true && fs.existsSync(path.join(t.repo, "feature.txt")));
  t.hooks.onStop = () => t.lateCommit("late.txt");
  const r = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(B) settled as ALREADY_MERGED", r.settled === true && r.ok && r.value.merged === true && r.value.emptyKind === "ALREADY_MERGED");
  check("(B) the branch is NOT deleted and the late commit is reachable", t.branchExists() && t.subjects().includes("late.txt"));
  check("(B) the worktree is retained and no merge_done was filed", fs.existsSync(t.wt.worktreePath) && t.mergeDone() === 0);
  check("(B) warns + files a solo merge_branch_retained event; the branch is HELD", /advanced after this merge landed/.test(r.ok ? r.value.warning ?? "" : "") && t.retained().length === 1 && t.retained()[0].detail.source === "solo" && !!(await t.sessions.isBranchHeld(t.wt.branch, t.repo)));
  const am = t.pushes.filter((m) => m.includes("[loom:already-merged]"));
  check("(H) exactly one [loom:already-merged] push, sent after finalize, saying RETAINED and NOT 'finishing the worktree cleanup'", am.length === 1 && /RETAINED, NOT cleaned up/.test(am[0]) && !/finishing the worktree cleanup/.test(am[0]));
  check("(H) the ALREADY_MERGED result carries branchRetainedWarning", r.ok && /advanced after this merge landed/.test(r.value.branchRetainedWarning ?? ""));
  const r2 = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(B) re-confirm goes Green (not ALREADY_MERGED) and lands the late commit", r2.settled === true && r2.ok && r2.value.merged === true && r2.value.emptyKind === undefined && fs.existsSync(path.join(t.repo, "late.txt")));
}
{
  const t = await setup(sfxOf("ctl"));
  const r = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(C) control: merged", r.settled === true && r.ok && r.value.merged === true && fs.existsSync(path.join(t.repo, "feature.txt")));
  check("(C) control: branch deleted, merge_done filed, no retained event, no retained warning", !t.branchExists() && t.mergeDone() === 1 && t.retained().length === 0 && !/advanced after/.test(r.ok ? r.value.warning ?? "" : ""));
}
{
  const t = await setup(sfxOf("ref"));
  let lateSha = null;
  // Armed from stop(): earlier reaps (pre-gate) must not consume it. The next reap is the worktree GC inside finalize, i.e. after its tip check, before the CAS delete.
  t.hooks.onStop = () => { t.hooks.onReap = () => { lateSha = t.lateRefCommit(); }; };
  const r = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(D) the commit landed in the reap window (hook fired)", !!lateSha);
  check("(D) FINALIZED (merge_done filed, worktree gone) with only the ref kept", r.settled === true && r.ok && r.value.merged === true && t.mergeDone() === 1 && !fs.existsSync(t.wt.worktreePath) && t.branchExists());
  check("(D) the ref still points at the late commit", !!lateSha && t.liveTip() === lateSha);
  const ev = t.retained();
  check("(D) event phase is ref-kept-after-finalize", ev.length === 1 && ev[0].detail.phase === "ref-kept-after-finalize" && ev[0].detail.source === "solo");
  check("(K) the ref-kept warning does not tell the manager to 'land it with worker_merge_confirm' (that can loop on an empty squash)", r.ok && !/land it with worker_merge_confirm/.test(r.value.warning ?? "") && /cherry-pick its late commit/.test(r.value.warning ?? ""));
}
{
  const t = await setup(sfxOf("unpinned"), { gateCommand: null });
  t.hooks.onStop = () => t.lateCommit("late.txt");
  const r = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(E) unpinned (no gateCommand) landing merged", r.settled === true && r.ok && r.value.merged === true && r.value.gateRan !== true && fs.existsSync(path.join(t.repo, "feature.txt")));
  check("(E) the stop-window commit is kept: branch exists, late commit reachable, no merge_done", t.branchExists() && t.subjects().includes("late.txt") && t.mergeDone() === 0 && t.retained().length === 1);
}
{
  const t = await setup(sfxOf("tip"));
  const tip = t.git(`rev-parse ${t.wt.branch}`);
  const m = await mergeBranch(t.repo, t.wt.branch, "T");
  check("(F) mergeBranch's squash result carries landedTip = the branch tip it squashed", m.ok === true && m.landedTip === tip);
  const m2 = await mergeBranch(t.repo, t.wt.branch, "T");
  check("(F) the ALREADY_MERGED noop carries landedTip too", m2.noop === true && m2.emptyKind === "ALREADY_MERGED" && m2.landedTip === tip);
}
{
  // (G) the stop-window commit reverts the branch's own change (feature.txt), so a re-confirm's squash stages nothing (ALREADY_MERGED).
  const t = await setup(sfxOf("revert"));
  t.hooks.onStop = () => { fs.rmSync(path.join(t.wt.worktreePath, "feature.txt")); commitAll(t.wt.worktreePath, "revert-feature", GIT_ID); };
  const r1 = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(G) first confirm: merged, retained (not finalized), HELD", r1.settled === true && r1.ok && r1.value.merged === true && t.branchExists() && t.mergeDone() === 0 && !!(await t.sessions.isBranchHeld(t.wt.branch, t.repo)));
  const r2 = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(G) re-confirm of the held branch lands its late range (merged:true), not a refusal", r2.settled === true && r2.ok && r2.value.merged === true);
  check("(G) main lost the reverted feature.txt and the branch was finalized (merge_done filed, hold released)", !fs.existsSync(path.join(t.repo, "feature.txt")) && !t.branchExists() && t.mergeDone() === 1 && (await t.sessions.isBranchHeld(t.wt.branch, t.repo)) === undefined);
}
{
  // (I) the branch is checked out in ANOTHER worktree: the worktree finalize is handed (a decoy) is removed, but the CAS delete must still be skipped.
  const t = await setup(sfxOf("decoy"));
  const tip = t.liveTip();
  const decoy = path.join(path.dirname(t.wt.worktreePath), "decoy-worktree"); // sibling of the real worktree, so under the worktrees root (e21cfd5f path guard)
  fs.mkdirSync(decoy, { recursive: true });
  const sess = t.db.getSession(t.workerId);
  await t.sessions.finalizeMerge({ managerSessionId: t.mgrId, workerSessionId: t.workerId, taskId: sess.taskId, worktreePath: decoy, branch: t.wt.branch, repoPath: t.repo, projectId: sess.projectId, expectedBranchTip: tip, mergedSha: null, repoKey: null, releaseHold: true });
  check("(I) finalize completed (merge_done filed, the handed worktree removed)", t.mergeDone() === 1 && !fs.existsSync(decoy));
  check("(I) the branch was NOT deleted: git still has it checked out in the real worktree", t.branchExists() && fs.existsSync(t.wt.worktreePath));
}
const evt = (t, kind, detail) => t.db.appendEvent({ id: `mcsf-ev-${Math.random().toString(36).slice(2)}`, ts: new Date().toISOString(), managerSessionId: t.mgrId, kind, workerSessionId: t.workerId, taskId: t.db.getSession(t.workerId).taskId, detail });
for (const variant of ["landedTip recorded", "landedTip null (sentinel)"]) {
  // (J1/J2) the branch was landed by a real squash, a solo retention was recorded with NOTHING late on the branch: it must not hold, and the confirm finishes.
  const t = await setup(sfxOf("rel"));
  const pre = await mergeBranch(t.repo, t.wt.branch, "MCSF-TASK");
  const tip = t.liveTip();
  evt(t, "merge_branch_retained", { opId: "x", branch: t.wt.branch, landedTip: variant === "landedTip recorded" ? tip : null, liveTip: null, phase: "at-finalize", landedSha: pre.sha, source: "solo" });
  check(`(J) [${variant}] a retention whose branch sits at the landed tip does NOT hold`, !(await t.sessions.isBranchHeld(t.wt.branch, t.repo)));
  const r = await confirm(t.sessions, t.mgrId, t.workerId);
  check(`(J) [${variant}] the next confirm FINISHES (ALREADY_MERGED, not HELD): branch deleted, merge_done filed`, r.settled === true && r.ok && r.value.merged === true && r.value.emptyKind === "ALREADY_MERGED" && !t.branchExists() && t.mergeDone() === 1);
}
{
  // (J3) the SAME rule for a batch retention (assembledTip), and the control that a different tip still holds.
  const t = await setup(sfxOf("brel"));
  const pre = await mergeBranch(t.repo, t.wt.branch, "MCSF-TASK");
  const tip = t.liveTip();
  evt(t, "batch_merge_branch_retained", { opId: "x", branch: t.wt.branch, assembledTip: tip, liveTip: null, phase: "at-finalize", landedSha: pre.sha });
  check("(J) a BATCH retention whose branch sits at its assembled tip does NOT hold", !(await t.sessions.isBranchHeld(t.wt.branch, t.repo)));
  t.lateCommit("late.txt");
  check("(J) control: the same batch retention DOES hold once the branch moves past the assembled tip", !!(await t.sessions.isBranchHeld(t.wt.branch, t.repo)));
}
{
  // (L) early-finish recovery (task already terminal): the branch got a late WHOLE-FILE revert after the squash landed.
  const t = await setup(sfxOf("wfr"));
  const pre = await mergeBranch(t.repo, t.wt.branch, "MCSF-TASK");
  fs.rmSync(path.join(t.wt.worktreePath, "feature.txt")); commitAll(t.wt.worktreePath, "revert-whole-file", GIT_ID);
  t.db.updateTask(t.db.getSession(t.workerId).taskId, { columnKey: "done" });
  const r = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(L) the early-finish path ran (ALREADY_MERGED)", r.settled === true && r.ok && r.value.emptyKind === "ALREADY_MERGED");
  check("(L) the squash carries a Loom-Landed-Tip trailer (the pin's source)", /Loom-Landed-Tip: [0-9a-f]{40}/.test(t.git(`log -1 --format=%B ${pre.sha}`)));
  check("(L) the branch is KEPT and the late whole-file revert is still reachable", t.branchExists() && t.subjects().includes("revert-whole-file") && t.mergeDone() === 0);
  check("(L) retained is reported (event + warning)", t.retained().length === 1 && /advanced after this merge landed/.test(r.ok ? r.value.warning ?? "" : ""));
}
{
  // (M) control: squash WITHOUT the trailer and nothing late: the stable-tip fallback finishes and deletes as before.
  const t = await setup(sfxOf("notrailer"));
  const pre = await mergeBranch(t.repo, t.wt.branch, "MCSF-TASK");
  const msg = t.git(`log -1 --format=%B ${pre.sha}`).split(String.fromCharCode(10)).filter((l) => !l.startsWith("Loom-Landed-Tip:")).join(String.fromCharCode(10));
  fs.writeFileSync(path.join(path.dirname(t.repo), "msg.txt"), msg);
  t.git(`${GIT_ID} commit --amend -q -F "${path.join(path.dirname(t.repo), "msg.txt").split(String.fromCharCode(92)).join("/")}"`);
  check("(M) setup: the amended squash has no Loom-Landed-Tip trailer but keeps Loom-Worker-Branch", !/Loom-Landed-Tip/.test(t.git("log -1 --format=%B")) && /Loom-Worker-Branch/.test(t.git("log -1 --format=%B")));
  t.db.updateTask(t.db.getSession(t.workerId).taskId, { columnKey: "done" });
  const r = await confirm(t.sessions, t.mgrId, t.workerId);
  check("(M) finishes via the stable-tip fallback: merged, branch deleted, merge_done filed, nothing retained", r.settled === true && r.ok && r.value.merged === true && !t.branchExists() && t.mergeDone() === 1 && t.retained().length === 0);
}
for (const variant of ["whole-file revert (N)", "partial revert (N2)"]) {
  const t = await setup(sfxOf("inconfirm"));
  const partial = variant.startsWith("partial");
  if (partial) { fs.writeFileSync(path.join(t.wt.worktreePath, "b.txt"), "b\n"); commitAll(t.wt.worktreePath, "add-b", GIT_ID); }
  const pre = await mergeBranch(t.repo, t.wt.branch, "MCSF-TASK");
  const victim = partial ? "b.txt" : "feature.txt";
  fs.rmSync(path.join(t.wt.worktreePath, victim)); commitAll(t.wt.worktreePath, "late-revert", GIT_ID);
  const r = await confirm(t.sessions, t.mgrId, t.workerId);
  check(`(N) [${variant}] the confirm reads ALREADY_MERGED (the revert squashes empty)`, r.settled === true && r.ok && r.value.merged === true && r.value.emptyKind === "ALREADY_MERGED");
  check(`(N) [${variant}] the squash carries Loom-Landed-Tip`, /Loom-Landed-Tip: [0-9a-f]{40}/.test(t.git(`log -1 --format=%B ${pre.sha}`)));
  check(`(N) [${variant}] the branch is KEPT, the late revert is reachable, no merge_done, retention recorded`, t.branchExists() && t.subjects().includes("late-revert") && t.mergeDone() === 0 && t.retained().length === 1);
}
{
  const t = await setup(sfxOf("trailerblock"));
  const a = "a".repeat(40), b = "b".repeat(40);
  const commitMsg = (name, msg) => { const f = path.join(path.dirname(t.repo), name); fs.writeFileSync(f, msg); t.git(`${GIT_ID} commit --allow-empty -q -F "${f.split(String.fromCharCode(92)).join("/")}"`); return t.git("rev-parse HEAD"); };
  const quoted = commitMsg("q.txt", `subj\n\nworker body quoting a trailer:\nLoom-Landed-Tip: ${a}\n\nLoom-Worker-Branch: q\nLoom-Worker-Base: ${b}\n`);
  const solo = commitMsg("s.txt", `subj2\n\nLoom-Worker-Branch: q\nLoom-Landed-Tip: ${b}\nLoom-Worker-Base: ${a}\n`);
  check("(O) a quoted Loom-Landed-Tip in the body (before the final trailer block) is NOT read as a trailer", (await readLandedTipTrailer(t.repo, quoted)) === null);
  check("(O) the solo layout (right after Loom-Worker-Branch) IS read", (await readLandedTipTrailer(t.repo, solo)) === b);
}
{
  const t = await setup(sfxOf("deleted"));
  const pre = await mergeBranch(t.repo, t.wt.branch, "MCSF-TASK");
  evt(t, "merge_branch_retained", { opId: "x", branch: t.wt.branch, landedTip: "f".repeat(40), liveTip: null, phase: "at-finalize", landedSha: pre.sha, source: "solo" });
  check("(P) control: a retention whose recorded tip differs from the live tip holds", !!(await t.sessions.isBranchHeld(t.wt.branch, t.repo)));
  t.git(`worktree remove -f -f "${t.wt.worktreePath.split(String.fromCharCode(92)).join("/")}"`);
  t.git(`branch -D ${t.wt.branch}`);
  check("(P) once the branch is DELETED the hold is NOT released (42daa283)", !t.branchExists() && !!(await t.sessions.isBranchHeld(t.wt.branch, t.repo)));
}
for (const db of openDbs) { try { db.close(); } catch { /* already closed */ } }
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
