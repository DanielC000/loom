import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 634edd2b — a real `project_task_get` returned `mergedVerification:"content"` (the persisted,
// at-merge-time field) alongside a nested `merged.verification:"pathset"` (the LIVE, read-time
// recomputation) for the SAME sha. THE EXPERIMENT THE CARD REQUIRED, RUN AS SPECIFIED: test with the
// branch ALIVE, not just the branch-deleted case (which cannot distinguish H1 from H2 — see the card body).
//
// H1 (the two computations genuinely disagree even while the branch is alive — a real bug to reconcile)
// vs H2 (they AGREE while alive; the persisted field is simply frozen at merge time and never re-derived,
// so it silently goes stale once the branch is later deleted and live re-verification degrades).
//
// THIS TEST MEASURES THE LIVE-BRANCH ARM DIRECTLY: a real `mergeBranch` squash (branch still alive
// afterward — `mergeBranch` itself never deletes it), the SAME persist finalizeMerge performs
// (`mergedVerification: merge.sha ? "content" : null`, sessions/service.ts's Green path), then an
// IMMEDIATE `getProjectTask` read while the branch is still alive, followed by a real `deleteBranch` and a
// second read.
//
// HERMETIC: a real temp git repo (execSync + the built mergeBranch/deleteBranch), a real Db, driving the
// built business logic directly (dist/mcp/tasks.js + dist/git/worktrees.js) — no daemon, no real claude.
//
// Proves:
//   (1) LIVE-BRANCH ARM (the mandatory experiment): immediately after a real squash-merge, with the branch
//       still alive, the persisted `mergedVerificationAtMerge` and the LIVE `merged.verification` AGREE
//       (both "content") — H1 is falsified for this mechanism; the two computations do not disagree while
//       the branch is alive.
//   (2) POST-DELETE DIVERGENCE (H2 confirmed): once the branch is deleted, the LIVE `merged.verification`
//       degrades to "pathset" (nothing left to byte-diff against) while `mergedVerificationAtMerge` stays
//       frozen at "content" — the exact shape of the real incident, and the exact confirmation the card
//       demanded (agree alive, diverge only once deleted).
//   (3) `listProjectTasks` shows the SAME divergence as `getProjectTask` (both response paths agree).
//   (4) the raw, ambiguous `mergedVerification` key is genuinely ABSENT from both response shapes — it was
//       RENAMED to `mergedVerificationAtMerge`, not merely duplicated alongside it.
//
// Run: 1) build (turbo builds shared first), 2) node test/merge-verification-at-merge-vs-live.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { Db } = await import("../dist/db.js");
const { getProjectTask, listProjectTasks } = await import("../dist/mcp/tasks.js");
const { mergeBranch, deleteBranch, taskKey, __resetMergedCommitMapCacheForTest } = await import("../dist/git/worktrees.js");

const GIT_ID = "-c user.email=mvl@loom -c user.name=mvl";
const tmpDirs = [];

function newRepo(name) {
  const repo = path.join(os.tmpdir(), `loom-mvl-${name}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  tmpDirs.push(repo);
  fs.mkdirSync(repo, { recursive: true });
  execSync("git init -q && git config user.email mvl@loom && git config user.name mvl && git commit -q -m init --allow-empty", { cwd: repo });
  return repo;
}

function makeWorktreeBranch(repo, branch, file, content) {
  const wt = path.join(os.tmpdir(), `loom-mvl-wt-${branch.replace(/\//g, "-")}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`);
  tmpDirs.push(wt);
  execSync(`git worktree add -q -b ${branch} "${wt}" HEAD`, { cwd: repo });
  fs.writeFileSync(path.join(wt, file), content);
  execSync(`git add -A && git ${GIT_ID} commit -q -m "${branch} work"`, { cwd: wt });
  return wt;
}

// `git branch -D` refuses a branch still checked out in a worktree — remove it first (mirrors production's
// removeWorktree-then-deleteBranch order), but deliberately BEFORE the squash-merge below, so the branch
// ref itself stays alive (only the worktree checkout is gone) for the live-branch read.
function removeWorktree(repo, wt) {
  try { execSync(`git worktree remove --force "${wt}"`, { cwd: repo }); } catch { /* best-effort */ }
}

const tmpHome = path.join(os.tmpdir(), `loom-mvl-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(tmpHome, { recursive: true });

try {
  const repo = newRepo("main");
  const now = new Date().toISOString();
  const dbFile = path.join(tmpHome, "d.db");
  const db = new Db(dbFile);
  db.insertProject({ id: "pMvl", name: "Merge Verification Project", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });

  const task = db.insertTask({
    id: "00000000-0000-4000-8000-000000000001", projectId: "pMvl", title: "feat(x): mergeVerification drift specimen",
    body: "", columnKey: "in_progress", position: 1, priority: "p2", repoKey: null, createdAt: now, updatedAt: now, version: 1,
  }) ?? db.getTask("00000000-0000-4000-8000-000000000001");

  const branch = `loom/${taskKey(task.id)}`;
  const wt = makeWorktreeBranch(repo, branch, "mvl.txt", "genuine live-branch content\n");
  removeWorktree(repo, wt); // frees the branch to be squash-merged into main; the REF itself stays alive

  // ===== The real squash-merge (mirrors mergeBranchLocked — the SAME function finalizeMerge calls) =====
  const merged = await mergeBranch(repo, branch, "feat(x): mergeVerification drift specimen");
  check("(setup) the real squash-merge succeeded", merged.ok === true && typeof merged.sha === "string");
  check("(setup) precondition: the branch ref is STILL ALIVE right after mergeBranch (it never deletes it)",
    execSync(`git branch --list ${branch}`, { cwd: repo }).toString().trim() !== "");

  // ===== The SAME persist step finalizeMerge performs on its Green path (sessions/service.ts:
  // `mergedVerification: merge.sha ? "content" : null`) — a fresh solo squash-confirm ALWAYS records
  // "content" unconditionally, since it just verified the branch content in this same call. =====
  db.setTaskMergedInfoNoTouch(task.id, {
    mergedSha: merged.sha.slice(0, 7), mergedRepoKey: null, mergedDate: new Date().toISOString(),
    mergedVerification: merged.sha ? "content" : null,
  });

  // ===== (1) THE MANDATORY LIVE-BRANCH ARM: read RIGHT NOW, branch still alive =====
  __resetMergedCommitMapCacheForTest();
  const liveRead = await getProjectTask(db, "pMvl", task.id);
  check("(1) live-branch precondition: the LIVE recomputation reads \"content\" while the branch is alive",
    liveRead.merged?.verification === "content");
  check("(1) H1 FALSIFIED — the persisted mergedVerificationAtMerge AGREES with the live merged.verification while the branch is alive",
    liveRead.mergedVerificationAtMerge === "content" && liveRead.mergedVerificationAtMerge === liveRead.merged?.verification);

  // ===== (2) delete the branch (mirrors finalizeMerge's own deleteBranch, which runs right after the
  // SAME persist step above in production) and read again =====
  await deleteBranch(repo, branch);
  check("(2) precondition: the branch is genuinely gone now",
    execSync(`git branch --list ${branch}`, { cwd: repo }).toString().trim() === "");
  __resetMergedCommitMapCacheForTest();
  const postDeleteRead = await getProjectTask(db, "pMvl", task.id);
  check("(2) H2 CONFIRMED — the LIVE merged.verification DEGRADES to \"pathset\" once the branch is gone",
    postDeleteRead.merged?.verification === "pathset");
  check("(2) H2 CONFIRMED — the persisted mergedVerificationAtMerge stays FROZEN at \"content\" (never re-derived)",
    postDeleteRead.mergedVerificationAtMerge === "content");
  check("(2) the two fields now genuinely DISAGREE for the same sha — reproducing the real incident's exact shape",
    postDeleteRead.mergedVerificationAtMerge !== postDeleteRead.merged?.verification);
  check("(2) both reads describe the SAME landed sha throughout (the disagreement is about verification MODE, not a different commit)",
    liveRead.merged?.sha === postDeleteRead.merged?.sha && postDeleteRead.merged?.sha === merged.sha.slice(0, 7));

  // ===== (3) listProjectTasks shows the identical divergence =====
  __resetMergedCommitMapCacheForTest();
  const listRead = (await listProjectTasks(db, "pMvl", { includeBody: true })).find((t) => t.id === task.id);
  check("(3) listProjectTasks agrees with getProjectTask on the post-delete divergence",
    listRead?.merged?.verification === "pathset" && listRead?.mergedVerificationAtMerge === "content");

  // ===== (4) the ambiguous raw `mergedVerification` key is genuinely RENAMED, not duplicated =====
  check("(4) getProjectTask's response has NO raw `mergedVerification` key (renamed to mergedVerificationAtMerge)",
    !("mergedVerification" in postDeleteRead));
  check("(4) listProjectTasks' response ALSO has no raw `mergedVerification` key",
    !("mergedVerification" in listRead));

  db.close();
} finally {
  cleanupPathSync(tmpHome);
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the mandatory live-branch experiment (card 634edd2b) is RUN, not merely reasoned about: immediately after a real squash-merge, with the branch still alive, the persisted mergedVerificationAtMerge and the live merged.verification AGREE (both \"content\") — H1 (the two computations genuinely disagree) is FALSIFIED. Only once the branch is later deleted does the live recomputation degrade to \"pathset\" while the frozen at-merge value stays put — H2 CONFIRMED, reproducing the real incident's exact divergence shape for the identical sha. listProjectTasks shows the same divergence as getProjectTask, and the raw ambiguous `mergedVerification` key is confirmed genuinely absent (renamed, not duplicated) from both response shapes."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
