import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// finalizeMerge worktree-removal resilience test. REAL git on a temp repo, NO claude and NO live
// daemon — drives SessionService.confirmWorkerMerge() directly against an isolated LOOM_HOME (mirrors
// boot-reconcile.mjs's in-process style). Regression for the Windows handle-release bug: a worker's
// worktree dir can stay busy right after a hard-stop, so worktree removal FAILS even though the
// `git merge` already committed. removeWorktree is the FIRST step of finalizeMerge, so an unguarded
// failure there used to abort the rest — branch not deleted, task left in_progress, no merge_done —
// and worker_merge_confirm returned an ERROR for an already-landed merge.
// (removeWorktree itself now SWALLOWS+warns a failed removal — the boot-hang hardening in
// git/worktrees.ts — leaving the dir for boot-reconcile Pass B instead of throwing; finalizeMerge's
// own try/catch stays as a belt-and-suspenders second guard. Either way the merge must still finalize.)
//
// The busy-handle race is now simulated via SessionService's `removeDir` test seam (task dea6728e):
// the killable removal backstop runs in a SEPARATE OS PROCESS, not `fs.promises.rm`, so monkeypatching
// a Node fs API can no longer fake a "busy" dir into it — the seam replaces the whole backstop for one
// target path instead, deterministically and hermetically (see worktrees.mjs for the mechanism's OWN
// direct proof, incl. the real hang/kill case).
//
// Proves:
//   (1) HAPPY path  — normal removal works: merged:true, worktree gone, branch deleted, task done,
//                     merge_done recorded, and NO worktree-GC warning at all (negative control — task
//                     035fb673).
//   (2) BUSY-DIR path — when worktree removal FAILS with a CLEAN reject (the seam returns
//                     removed:false, killed:false for X's worktree only), confirmWorkerMerge STILL
//                     returns merged:true, the branch is deleted, the task moves to done, a merge_done
//                     event is recorded, and a "left on disk" warning is emitted BOTH to console.warn
//                     AND (task 035fb673) on worker_merge_confirm's own return value.
//   (3) WEDGED path — same shape, but the seam returns removed:false, killed:true for W's worktree (a
//                     GENUINELY wedged removal, not a clean reject) — task 035fb673's own reason for
//                     existing: this used to be console.warn-ONLY (invisible to a manager who only polls
//                     worker_merge_confirm/worker_list), never reaching the merging manager at all. Now
//                     it's ALSO on the return value, worded distinctly ("WEDGED") from the busy-dir case
//                     above, and says what to do.
// Run: 1) build daemon (pnpm build), 2) node test/merge-finalize-resilient.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-mfr-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { createWorktree, removeWorktree, killableRemoveDir } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mfr@loom -c user.name=mfr";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const now = new Date().toISOString();

const db = new Db();
// confirmWorkerMerge only calls pty.stop / pty.isAlive / pty.enqueueStdin on this path. A no-pty
// worker row (processState 'exited') means isAlive is false anyway; a stub keeps it hermetic.
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
// removeDir seam: a CLEAN reject (settled, not removed, not killed) for X's worktree, a genuinely KILLED
// reject (wedged) for W's — everything else (H's happy path) goes through the real killable removal
// unchanged. `X.worktreePath`/`W.worktreePath` are read lazily at call time (assigned later by
// setupBusyWorker), so declaring the closure before they exist is fine.
const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {
  removeDir: async (target, ms) => {
    if (target === X.worktreePath) return { removed: false, killed: false };
    if (target === W.worktreePath) return { removed: false, killed: true };
    return killableRemoveDir(target, ms);
  },
});

const mergeDoneCount = (mgrId) => db.listEvents(mgrId).filter((e) => e.kind === "merge_done").length;

// gateCommand left EMPTY so confirmWorkerMerge skips the build gate (no claude / cwd dependence) and
// goes straight to the merge + finalizeMerge bookkeeping we're exercising.
function seed(p) {
  db.insertProject({ id: p.projId, name: "MFR", repoPath: p.repo, vaultPath: p.repo, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: p.agentId, projectId: p.projId, name: "t", startupPrompt: "", position: 0 });
  db.insertTask({ id: p.taskId, projectId: p.projId, title: "MFR-TASK", body: "", columnKey: "in_progress", position: 1, createdAt: now, updatedAt: now });
  db.insertSession({ id: p.mgrId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.repo, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  db.insertSession({ id: p.workerId, projectId: p.projId, agentId: p.agentId, engineSessionId: null, title: null, cwd: p.worktreePath, processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker", parentSessionId: p.mgrId, taskId: p.taskId, worktreePath: p.worktreePath, branch: p.branch });
}

// HAPPY worker: a real worktree with a committed file on its branch (a clean, mergeable change),
// seeded as a row. confirmWorkerMerge will remove this worktree normally.
async function setupWorker(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  fs.writeFileSync(path.join(p.repo, "README.md"), "# mfr\n");
  // Configure a git identity so the daemon's PLAIN squash `git commit` (no `-c` overrides) has an author.
  execSync(`git init -q && git config user.email mfr@loom && git config user.name mfr`, { cwd: p.repo });
  commitAll(p.repo, "init", GIT_ID);
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  fs.writeFileSync(path.join(worktreePath, p.file), "worker change\n");
  commitAll(worktreePath, `${p.file} part 1`, GIT_ID);
  fs.writeFileSync(path.join(worktreePath, `${p.file}.2`), "worker change 2\n"); // 2nd commit → must collapse to ONE
  commitAll(worktreePath, `${p.file} part 2`, GIT_ID);
  p.worktreePath = worktreePath; p.branch = branch;
  seed(p);
}

// BUSY worker: the merge-able branch is committed but its worktree is DETACHED (removed) so the branch
// is freely deletable — this mirrors the real Windows symptom where `git worktree remove` de-registers
// the admin record but the dir lingers on disk. The worker row then points at a standalone LEFTOVER
// dir; forcing fs.promises.rm to reject (below) makes removeWorktree throw on it, exactly as a busy
// handle would. Keeping the leftover dir SEPARATE from any registered worktree lets us prove both that
// the branch is still deleted AND that the un-removable dir is left on disk for Pass B.
async function setupBusyWorker(p) {
  fs.mkdirSync(p.repo, { recursive: true });
  fs.writeFileSync(path.join(p.repo, "README.md"), "# mfr\n");
  execSync(`git init -q && git config user.email mfr@loom && git config user.name mfr`, { cwd: p.repo });
  commitAll(p.repo, "init", GIT_ID);
  const { worktreePath, branch } = await createWorktree(p.repo, p.projId, p.taskId);
  fs.writeFileSync(path.join(worktreePath, p.file), "worker change\n");
  commitAll(worktreePath, `${p.file}`, GIT_ID);
  await removeWorktree(p.repo, worktreePath); // detach the branch from its worktree (branch retained)
  // The leftover dir the busy handle "couldn't release": a plain dir that fs.rm will be forced to fail on.
  // Tagged with p.tag (not just sfx) so two busy workers in the same run get DISTINCT leftover dirs.
  p.busyDir = path.join(os.tmpdir(), `loom-mfr-busydir-${p.tag}-${sfx}`);
  fs.mkdirSync(p.busyDir, { recursive: true });
  fs.writeFileSync(path.join(p.busyDir, "leftover.txt"), "still busy\n");
  p.worktreePath = p.busyDir; p.branch = branch;
  seed(p);
}

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const H = { projId: `mfr-h-proj-${sfx}`, agentId: `mfr-h-top-${sfx}`, taskId: `mfr-h-task-${sfx}`, mgrId: `mfr-h-mgr-${sfx}`, workerId: `mfr-h-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mfr-happy-${sfx}`), file: "happy.txt" };
const X = { projId: `mfr-x-proj-${sfx}`, agentId: `mfr-x-top-${sfx}`, taskId: `mfr-x-task-${sfx}`, mgrId: `mfr-x-mgr-${sfx}`, workerId: `mfr-x-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mfr-busy-${sfx}`), file: "busy.txt", tag: "x" };
// W: task 035fb673 — genuinely WEDGED (killed:true, not just a clean reject) worktree removal, to prove
// worker_merge_confirm's return now SURFACES the wedge (not just a console.warn nobody polling it sees).
const W = { projId: `mfr-w-proj-${sfx}`, agentId: `mfr-w-top-${sfx}`, taskId: `mfr-w-task-${sfx}`, mgrId: `mfr-w-mgr-${sfx}`, workerId: `mfr-w-wkr-${sfx}`, repo: path.join(os.tmpdir(), `loom-mfr-wedge-${sfx}`), file: "wedge.txt", tag: "w" };

try {
  await setupWorker(H);
  await setupBusyWorker(X);
  await setupBusyWorker(W);

  // --- (1) HAPPY path: removal works normally. ---
  const headHBefore = git(H.repo, "rev-parse HEAD"); // canonical HEAD before the squash merge
  const confirmH = await sessions.confirmWorkerMerge(H.mgrId, H.workerId);
  check("(happy) confirmWorkerMerge → merged:true", confirmH.merged === true);
  check("(happy) file landed on canonical repo", fs.existsSync(path.join(H.repo, H.file)));
  check("(happy) BOTH worker commits' content landed (collapsed into the squash)",
    fs.existsSync(path.join(H.repo, `${H.file}.2`)));
  // ONE-COMMIT-PER-TASK: the worker's 2 commits collapse into exactly ONE non-merge commit on main,
  // with the clean task-title subject + trailer, and NO `Merge branch` noise commit.
  check("(happy) exactly ONE new commit on main (squash collapsed 2 worker commits)",
    git(H.repo, `rev-list --count ${headHBefore}..HEAD`) === "1");
  check("(happy) the landed commit is NOT a merge commit (single parent)",
    git(H.repo, "rev-list --parents -n 1 HEAD").trim().split(/\s+/).length === 2);
  check("(happy) NO `Merge branch` commit was created",
    git(H.repo, `log --format=%s ${headHBefore}..HEAD`).includes("Merge branch") === false);
  // The merge safety-net coerces a bare-prose title into Conventional Commits form (no type → "chore: ").
  check("(happy) squash subject is the task title coerced to Conventional Commits form",
    git(H.repo, "log -1 --format=%s") === "chore: MFR-TASK");
  check("(happy) squash body carries the Loom-Worker-Branch trailer",
    git(H.repo, "log -1 --format=%b").includes(`Loom-Worker-Branch: ${H.branch}`));
  check("(happy) NO Co-Authored-By trailer", git(H.repo, "log -1 --format=%b").includes("Co-Authored-By") === false);
  check("(happy) worktree removed", !fs.existsSync(H.worktreePath));
  check("(happy) branch deleted", git(H.repo, `branch --list ${H.branch}`) === "");
  check("(happy) task moved to done", db.getTask(H.taskId).columnKey === "done");
  check("(happy) merge_done event recorded (exactly 1)", mergeDoneCount(H.mgrId) === 1);
  // NEGATIVE CONTROL (task 035fb673): a clean removal must NOT grow any worktree-GC wording in `warning`
  // — byte-identical to before the wedge-surfacing change existed. (`warning` itself is NOT expected to
  // be undefined here: this test's project is deliberately gateless — see the `seed`/`sessions` setup
  // above — so the PRE-EXISTING, unrelated "unverified: no gateCommand is configured" warning still
  // fires; asserting full undefined would be a false negative on an unrelated field, not a real control.)
  // If this control ever fails, the busy/wedged positive checks below are meaningless (they'd just be
  // observing wording that's always present).
  check("(happy) NEGATIVE CONTROL: a clean removal carries NO worktree-GC wording in `warning`",
    !confirmH.warning || !/WEDGED|left on disk|needsHuman|worktree.*not removed|worker_reap/i.test(confirmH.warning));

  // --- (2) BUSY-DIR path: force worktree removal to fail, prove the merge still finalizes. ---
  // removeWorktree tries `git worktree remove` (swallowed), then falls back to the killable removal —
  // the removeDir seam returns a CLEAN reject for X's worktree only (see the SessionService construction
  // above), simulating the busy-handle race. removeWorktree SWALLOWS that (after its bounded clean-reject
  // retries) and warns `[worktree] could not remove dir … left on disk for a later GC`, so finalizeMerge
  // runs to completion; its own try/catch is the second guard. The merge bookkeeping must finish AND a
  // warning about the un-removed dir must fire. Scoped to this one call, then restored.
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...a) => { warnings.push(a.join(" ")); };
  let confirmX;
  try {
    confirmX = await sessions.confirmWorkerMerge(X.mgrId, X.workerId);
  } finally {
    console.warn = realWarn;
  }

  check("(busy) confirmWorkerMerge STILL returns merged:true despite removal failure", confirmX.merged === true);
  check("(busy) file landed on canonical repo (merge committed)", fs.existsSync(path.join(X.repo, X.file)));
  check("(busy) branch STILL deleted (bookkeeping continued past the throw)", git(X.repo, `branch --list ${X.branch}`) === "");
  check("(busy) task STILL moved to done", db.getTask(X.taskId).columnKey === "done");
  check("(busy) merge_done event STILL recorded (exactly 1)", mergeDoneCount(X.mgrId) === 1);
  check("(busy) worktree dir LEFT on disk for boot-reconcile Pass B to GC", fs.existsSync(X.worktreePath));
  check("(busy) a warning about the un-removed worktree (left on disk for GC) was emitted",
    warnings.some((w) => w.includes(X.worktreePath) && /left on disk|boot-reconcile|Pass B|GC/i.test(w)));
  // POSITIVE CONTROL (task 035fb673, DoD-2): the wedge is no longer console.warn-only — it's now on the
  // RETURN VALUE of worker_merge_confirm itself (confirmWorkerMerge here is that same code path), the
  // surface a manager actually polls. Names the path AND says what to do (DoD-3).
  check("(busy) worker_merge_confirm's RETURN now carries a warning (not just console.warn)",
    typeof confirmX.warning === "string" && confirmX.warning.includes(X.worktreePath));
  check("(busy) the warning says what the manager should DO",
    /worker_reap|delete .* yourself|boot-reconcile/i.test(confirmX.warning));

  // --- (3) WEDGED path: worktree removal comes back genuinely KILLED (not just a clean reject). ---
  // Same shape as (2), but the seam returns { removed:false, killed:true } for W — proving the OTHER
  // gcWorktreeDir outcome (task 035fb673's own title: "surface a WEDGED worktree-removal") also reaches
  // the return value, worded distinctly from the clean-reject case above.
  let confirmW;
  const warningsW = [];
  console.warn = (...a) => { warningsW.push(a.join(" ")); };
  try {
    confirmW = await sessions.confirmWorkerMerge(W.mgrId, W.workerId);
  } finally {
    console.warn = realWarn;
  }
  check("(wedged) confirmWorkerMerge STILL returns merged:true despite the wedge", confirmW.merged === true);
  check("(wedged) branch STILL deleted (bookkeeping continued past the wedge)", git(W.repo, `branch --list ${W.branch}`) === "");
  check("(wedged) task STILL moved to done", db.getTask(W.taskId).columnKey === "done");
  check("(wedged) merge_done event STILL recorded (exactly 1)", mergeDoneCount(W.mgrId) === 1);
  check("(wedged) worktree dir LEFT on disk (genuinely wedged, never removed)", fs.existsSync(W.worktreePath));
  // The pre-existing console.warn is UNCHANGED (task 035fb673 DoD-4: purely additive, keep it — tests may
  // count on it).
  check("(wedged) the pre-existing console.warn still fires (unchanged, purely additive)",
    warningsW.some((w) => w.includes(W.worktreePath)));
  check("(wedged) worker_merge_confirm's RETURN carries a warning naming the path",
    typeof confirmW.warning === "string" && confirmW.warning.includes(W.worktreePath));
  check("(wedged) the warning is worded as WEDGED, distinct from the busy/clean-reject case above",
    /WEDGED/.test(confirmW.warning) && confirmW.warning !== confirmX.warning);
  check("(wedged) the warning says what the manager should DO",
    /no action needed|needsHuman|background sweep/i.test(confirmW.warning));
} finally {
  db.close();
  for (const p of [H, X, W]) {
    try { if (p.worktreePath) fs.rmSync(p.worktreePath, { recursive: true, force: true }); } catch { /* ignore */ }
    try { if (p.busyDir) fs.rmSync(p.busyDir, { recursive: true, force: true }); } catch { /* ignore */ }
    fs.rmSync(p.repo, { recursive: true, force: true });
  }
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — finalizeMerge finishes the merge bookkeeping (branch deleted, task done, merge_done) and reports merged:true EVEN WHEN worktree removal fails; the busy dir is left for boot-reconcile Pass B. A wedged/left-on-disk removal is now ALSO surfaced on worker_merge_confirm's own return value (not just console.warn), worded distinctly per outcome and naming what the manager should do; a clean removal carries no such warning at all."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
