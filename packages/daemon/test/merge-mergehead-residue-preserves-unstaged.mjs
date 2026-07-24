import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// P3 fast-follow (board card c78cbf5f, correcting a gap 9e77050f/06b5c47f left unguarded).
//
// THE BUG: mergeBranchLocked's very FIRST act is to clear any AFFIRMATIVE in-progress-merge residue (a
// stale MERGE_HEAD, or unmerged index entries with no MERGE_HEAD — the `--squash` case, which never sets
// it) so a leftover conflict state can't make the next `--squash` stage nothing. That clear ran BEFORE the
// dirty-tree entry checks 9e77050f/06b5c47f added (which only protect the SQUASH itself), and used a
// blanket `git reset --hard HEAD` — discarding BOTH the conflict state AND any unrelated unstaged edit to a
// DIFFERENT tracked file that happened to be sitting in the canonical checkout at the same time (a human
// mid-conflict-resolution who also has unrelated WIP). THE FIX narrows that clear to `git reset --merge
// HEAD` — the mechanism `git merge --abort` itself uses, generalized to run whether or not MERGE_HEAD is
// actually set. Verified empirically (see the scratch probes in the task session, not just from docs):
// because this always resets to the CURRENT HEAD (never a different commit), every unmerged/conflicted path
// is unconditionally resettable, while a file with only an unstaged edit outside the conflict is never part
// of the HEAD→HEAD delta and is left untouched.
//
// This test proves, for BOTH residue signals the block probes:
//   (A) MERGE_HEAD-positive (a genuine real, non-squash conflict) — an unrelated unstaged edit present in
//       the canonical checkout survives `mergeBranch`, MERGE_HEAD is cleared, and the loom branch's own
//       squash still lands normally afterward (the residue-clear's whole original purpose).
//   (B) bare-unmerged-without-MERGE_HEAD (a `--squash` conflict, which never sets MERGE_HEAD) — same
//       three properties.
//
// Toggle RESET_MODE=hard below (or run against a pre-fix build) to see this go RED: `git reset --hard`
// destroys the unrelated edit in both scenarios.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-mergehead-residue-preserves-unstaged.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const distUrl = pathToFileURL(path.join(process.cwd(), "dist", "git", "worktrees.js")).href;
const { mergeBranch } = await import(distUrl);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=mhr@loom -c user.name=mhr";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const gitAllowFail = (cwd, args) => { try { execSync(`git ${args}`, { cwd, stdio: "pipe" }); return 0; } catch (e) { return e.status ?? 1; } };
// Like `git()`, but returns "" instead of throwing on a non-zero exit — for probes (`rev-parse --verify
// MERGE_HEAD`) that are EXPECTED to fail-with-empty-output once the residue is cleared.
const gitMaybe = (cwd, args) => { try { return execSync(`git ${args}`, { cwd, stdio: "pipe" }).toString().trim(); } catch { return ""; } };

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const tmpDirs = [];

function makeRepo(label) {
  const repo = path.join(os.tmpdir(), `loom-mhr-repo-${label}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  execSync(`git init -q && git config user.email mhr@loom && git config user.name mhr && git config protocol.file.allow always`, { cwd: repo });
  return repo;
}

function makeWorktree(repo, branch, fromRef, file, content) {
  const wt = path.join(os.tmpdir(), `loom-mhr-wt-${branch.replace(/\//g, "-")}-${sfx}`);
  tmpDirs.push(wt);
  execSync(`git worktree add -q -b ${branch} "${wt}" ${fromRef}`, { cwd: repo });
  fs.writeFileSync(path.join(wt, file), content);
  execSync(`git add -A && git ${GIT_ID} commit -q -m "${branch} work"`, { cwd: wt });
  return wt;
}

try {
  // ── (A) Genuine MERGE_HEAD-positive conflict, produced by a REAL (non-squash) merge directly in the
  //        canonical checkout — exactly the "human mid-conflict-resolution" state the card describes. ──
  {
    const repo = makeRepo("mergehead");
    fs.writeFileSync(path.join(repo, "conflict.txt"), "base\n");
    fs.writeFileSync(path.join(repo, "unrelated.txt"), "unrelated-base\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m base`, { cwd: repo });
    const baseRef = git(repo, "rev-parse HEAD");

    // A side branch that conflicts with a later main-branch edit to the same file.
    execSync(`git ${GIT_ID} checkout -qb side-conflict`, { cwd: repo });
    fs.writeFileSync(path.join(repo, "conflict.txt"), "side-change\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m side`, { cwd: repo });
    execSync(`git checkout -q -`, { cwd: repo }); // back to the default branch
    fs.writeFileSync(path.join(repo, "conflict.txt"), "main-change\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m main-conflicting`, { cwd: repo });

    // A real merge attempt, run directly (not through Loom), that genuinely conflicts and leaves MERGE_HEAD.
    const mergeExit = gitAllowFail(repo, `${GIT_ID} merge side-conflict --no-edit`);
    check("setup: the direct merge attempt conflicted", mergeExit !== 0);
    check("setup: MERGE_HEAD is set", gitMaybe(repo, "rev-parse -q --verify MERGE_HEAD") !== "");
    check("setup: unmerged entries exist", git(repo, "ls-files --unmerged") !== "");

    // An unrelated unstaged edit to a DIFFERENT tracked file, present in the checkout at the same time.
    // (conflict.txt itself also shows up in `diff --name-only` here — its unmerged working-tree content
    // differs from the "ours" stage — so check unrelated.txt is INCLUDED rather than the only entry.)
    fs.writeFileSync(path.join(repo, "unrelated.txt"), "MY-UNSAVED-WORK\n");
    check("setup: unrelated.txt is unstaged-dirty, not staged (conflict.txt itself legitimately shows in both lists too, being unmerged)", !git(repo, "diff --cached --name-only").split("\n").includes("unrelated.txt") && git(repo, "diff --name-only").split("\n").includes("unrelated.txt"));

    // A normal loom branch to merge — its own squash should still land after the residue-clear runs.
    makeWorktree(repo, "loom/branch-mh", baseRef, "file-mh.txt", `mh-content-${sfx}\n`);

    const res = await mergeBranch(repo, "loom/branch-mh", "Card MH title");
    check("(A) the loom branch's squash still lands normally after the residue-clear (ok:true)", res.ok === true && !!res.sha);
    check("(A) MERGE_HEAD is cleared by the residue-clear", gitMaybe(repo, "rev-parse -q --verify MERGE_HEAD") === "");
    check("(A) no unmerged entries remain", git(repo, "ls-files --unmerged") === "");

    const unrelated = fs.readFileSync(path.join(repo, "unrelated.txt"), "utf8");
    check("(A) the unrelated unstaged edit survives the residue-clear COMPLETELY UNTOUCHED", unrelated === "MY-UNSAVED-WORK\n");
  }

  // ── (B) bare-unmerged-without-MERGE_HEAD, produced by a `git merge --squash` conflict directly in the
  //        canonical checkout — `--squash` never sets MERGE_HEAD, so this is the OTHER signal the same
  //        residue-clear block probes (`ls-files --unmerged` true, `rev-parse --verify MERGE_HEAD` false). ──
  {
    const repo = makeRepo("bareunmerged");
    fs.writeFileSync(path.join(repo, "conflict.txt"), "base\n");
    fs.writeFileSync(path.join(repo, "unrelated.txt"), "unrelated-base\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m base`, { cwd: repo });
    const baseRef = git(repo, "rev-parse HEAD");

    execSync(`git ${GIT_ID} checkout -qb side-conflict-2`, { cwd: repo });
    fs.writeFileSync(path.join(repo, "conflict.txt"), "side-change\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m side`, { cwd: repo });
    execSync(`git checkout -q -`, { cwd: repo });
    fs.writeFileSync(path.join(repo, "conflict.txt"), "main-change\n");
    execSync(`git add -A && git ${GIT_ID} commit -q -m main-conflicting`, { cwd: repo });

    const squashExit = gitAllowFail(repo, `merge --squash side-conflict-2`);
    check("setup: the direct squash-merge attempt conflicted", squashExit !== 0);
    check("setup: MERGE_HEAD is NOT set (--squash never sets it)", gitMaybe(repo, "rev-parse -q --verify MERGE_HEAD") === "");
    check("setup: unmerged entries exist", git(repo, "ls-files --unmerged") !== "");

    fs.writeFileSync(path.join(repo, "unrelated.txt"), "MY-OTHER-UNSAVED-WORK\n");
    check("setup: unrelated.txt is unstaged-dirty, not staged (conflict.txt itself legitimately shows in both lists too, being unmerged)", !git(repo, "diff --cached --name-only").split("\n").includes("unrelated.txt") && git(repo, "diff --name-only").split("\n").includes("unrelated.txt"));

    makeWorktree(repo, "loom/branch-bu", baseRef, "file-bu.txt", `bu-content-${sfx}\n`);

    const res = await mergeBranch(repo, "loom/branch-bu", "Card BU title");
    check("(B) the loom branch's squash still lands normally after the residue-clear (ok:true)", res.ok === true && !!res.sha);
    check("(B) no unmerged entries remain", git(repo, "ls-files --unmerged") === "");

    const unrelated = fs.readFileSync(path.join(repo, "unrelated.txt"), "utf8");
    check("(B) the unrelated unstaged edit survives the residue-clear COMPLETELY UNTOUCHED", unrelated === "MY-OTHER-UNSAVED-WORK\n");
  }
} finally {
  for (const d of tmpDirs) {
    try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the upstream MERGE_HEAD/unmerged residue-clear no longer discards unrelated unstaged work, for both the MERGE_HEAD-positive and bare-unmerged signals, and still clears the residue it exists to clear."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
