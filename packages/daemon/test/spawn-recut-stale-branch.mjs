import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Stale-base re-cut test (board card d9e39eaf — the worker_spawn-reuses-an-EMPTY-branch-at-its-OLD-base
// bug that bit the lead twice on 2026-06-04). REAL git on temp repos under %TEMP%, NO claude and NO
// live daemon — drives createWorktree() directly against an isolated LOOM_HOME (so WORKTREES_DIR is
// hermetic; paths.ts reads LOOM_HOME at module load). Torn down in a finally.
//
// When worker_spawn runs on a task that already has a worktree branch from a PRIOR attempt,
// createWorktree re-attaches/reuses that branch. The fix (Option A): for the two REUSE paths only,
// re-cut a branch that is EMPTY (0 commits ahead of current main) onto current main, while leaving a
// branch that carries real unmerged work (RECOVERY) exactly as-is. This proves all three cases against
// createWorktree, across BOTH reuse shapes (dir-present reuse AND branch-present/dir-gone re-attach):
//   (a) reused EMPTY branch (0 ahead) → worktree comes up at current main's HEAD (re-cut);
//   (b) reused branch WITH an unmerged commit (>0 ahead) → that commit is PRESERVED (recovery untouched);
//   (c) fresh task (no prior branch) → new branch cut off current main, unchanged behavior.
//
// Card 5150fdc2 UPDATE: scenarios (b)/(b2)'s setup (a recovery branch whose OLD base has since fallen
// behind main) is now ALSO exactly what triggers the NEW stale-base auto-forward (createWorktree's
// `resolveStaleBase`) — since main's advance in (b)/(b2) is UNRELATED to the recovery commit's own file,
// the forward merges CLEAN. This is a DELIBERATE relaxation of this test's own invariant, so it's spelled
// out precisely for review:
//   - The invariant this file guards was ALWAYS "never DISCARD recovery work" — never "HEAD never moves".
//     A clean auto-forward moves HEAD (via a merge commit) but keeps the recovery commit as a real
//     ANCESTOR of the new HEAD — nothing is reset, rewritten, or lost, only forwarded. (b)/(b2) below now
//     PROVE that with `git merge-base --is-ancestor` (real ancestry, not a byte-equality proxy) PLUS the
//     recovery file's CONTENT (not just its existence) PLUS main's forwarded file's presence.
//   - The OTHER half of "never discard": when the forward WOULD conflict, it must abort cleanly and
//     leave the recovery branch untouched (byte-identical, this time — nothing to forward). NEW scenario
//     (b3) below proves exactly that, so both halves of the auto-forward's safety are visible in this one
//     file: recovery work survives a CLEAN forward (moved, not lost) and survives a CONFLICTING forward
//     attempt (not moved at all, aborted cleanly, staleBase surfaced instead of silently resolved).
// Run: 1) build daemon (pnpm build), 2) node packages/daemon/test/spawn-recut-stale-branch.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-recut-home-${Date.now()}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { createWorktree, mayRecutOntoMain } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// ============================================================================================
// (D) FAIL-SAFE gate for the DESTRUCTIVE re-cut (card fed15845): mayRecutOntoMain decides whether
// recutStaleReusedBranch may run `reset --hard`. Re-cut is allowed ONLY on a provably-empty branch
// (rev-list --count == "0"). A recovery branch (>0) OR a malformed/unparseable count (NaN) must NOT
// reset — the prior `parseInt(...) || 0` collapsed NaN→0 and would have DESTROYED recovery work.
check("(D) '0' (empty branch) → may re-cut (true)", mayRecutOntoMain("0") === true);
check("(D) '0\\n' (trailing newline from git.raw) → may re-cut (true)", mayRecutOntoMain("0\n") === true);
check("(D) '  0  ' (padded) → may re-cut (true)", mayRecutOntoMain("  0  ") === true);
check("(D) '1' (recovery, 1 ahead) → MUST NOT re-cut (false)", mayRecutOntoMain("1") === false);
check("(D) '42' (recovery) → MUST NOT re-cut (false)", mayRecutOntoMain("42") === false);
check("(D) '' (empty/no output) → NaN → FAIL SAFE, MUST NOT re-cut (false)", mayRecutOntoMain("") === false);
check("(D) 'garbage' (unparseable) → NaN → FAIL SAFE, MUST NOT re-cut (false)", mayRecutOntoMain("garbage") === false);
check("(D) 'fatal: bad revision' (git error text) → NaN → FAIL SAFE (false)", mayRecutOntoMain("fatal: bad revision") === false);
const GIT_ID = "-c user.email=recut@loom -c user.name=recut";
const git = (cwd, args) => execSync(`git ${args}`, { cwd }).toString().trim();
const head = (cwd) => git(cwd, "rev-parse HEAD");
// Commit a file into a checkout (the canonical repo to advance main, or a worktree to add prior work).
const commitInto = (dir, file, body, msg) => {
  fs.writeFileSync(path.join(dir, file), body);
  execSync(`git add . && git ${GIT_ID} commit -qm "${msg}"`, { cwd: dir });
};
// REAL ancestry proof (card 5150fdc2's (b)/(b2) relaxation) — `git merge-base --is-ancestor <a> <b>`
// exits 0 iff `a` is an ancestor of (or equal to) `b`; non-zero otherwise. Used instead of a merge-base-
// equality proxy so the "recovery work was never discarded" claim is checked the same way `git` itself
// would answer it, not inferred from a derived SHA comparison.
const isAncestor = (cwd, ancestorSha, ref) => {
  try { execSync(`git merge-base --is-ancestor ${ancestorSha} ${ref}`, { cwd }); return true; } catch { return false; }
};
// Line-ending normalized read — Windows git (core.autocrlf) can rewrite LF→CRLF on a checkout/merge-abort
// even when the content itself is untouched; irrelevant to what these checks prove.
const readNorm = (file) => fs.readFileSync(file, "utf8").replace(/\r\n/g, "\n");

const repo = path.join(os.tmpdir(), `loom-recut-repo-${Date.now()}`);
const PROJ = "projRecut";

try {
  // A real repo with one commit on the default branch (this is "old main", C1).
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# recut test\n");
  execSync(`git init -q && git add . && git ${GIT_ID} commit -q -m init`, { cwd: repo });

  // ============================================================================================
  // (a) DIR-PRESENT reuse, EMPTY branch → re-cut onto current main.
  // ============================================================================================
  const tA = "empty-dir-aaaa-1111";
  const A = await createWorktree(repo, PROJ, tA); // cut off C1
  check("(a setup) initial worktree HEAD == old main (C1)", head(A.worktreePath) === head(repo));
  // main advances to C2 while the branch sits at C1 (the stale-base condition).
  commitInto(repo, "main-advance-a.txt", "C2\n", "advance main to C2");
  const c2 = head(repo);
  check("(a setup) branch is now stale (0 commits ahead of C2)",
    git(repo, `rev-list --count ${c2}..${A.branch}`) === "0");
  // Re-spawn: dir present → reuse path. The empty branch must be re-cut onto C2.
  const Areuse = await createWorktree(repo, PROJ, tA);
  check("(a) reuse returns the same worktree path + branch", Areuse.worktreePath === A.worktreePath && Areuse.branch === A.branch);
  check("(a) DIR-PRESENT empty branch re-cut → worktree HEAD == current main (C2)", head(A.worktreePath) === c2);
  check("(a) branch pointer also moved to current main (C2)", git(repo, `rev-parse ${A.branch}`) === c2);
  check("(a) still on the loom/<key> branch after re-cut", git(A.worktreePath, "rev-parse --abbrev-ref HEAD") === A.branch);
  check("(a) the stale tree is gone (C1-only worktree did not carry forward a phantom file)",
    !fs.existsSync(path.join(A.worktreePath, "should-not-exist.txt")));
  // cleanup A
  execSync(`git worktree remove --force "${A.worktreePath}"`, { cwd: repo });

  // ============================================================================================
  // (b) DIR-PRESENT reuse, RECOVERY branch (real unmerged commit) → PRESERVED untouched.
  // ============================================================================================
  const tB = "recovery-dir-bbbb-2222";
  const B = await createWorktree(repo, PROJ, tB); // cut off current main (C2)
  commitInto(B.worktreePath, "recovery.txt", "real prior work\n", "recovery commit"); // 1 commit ahead
  const recoveryTip = head(B.worktreePath);
  // main advances again to C3 (so the branch is behind main AND ahead by its own commit — recovery shape).
  commitInto(repo, "main-advance-b.txt", "C3\n", "advance main to C3");
  const c3 = head(repo);
  check("(b setup) recovery branch is 1 commit ahead of current main", git(repo, `rev-list --count ${c3}..${B.branch}`) === "1");
  // Re-spawn: dir present → reuse path. A branch with unmerged work must never be RESET — but card
  // 5150fdc2's auto-forward now fires here too (the branch is stale relative to c3): main's advance is
  // unrelated to the recovery commit's file, so the forward merges CLEAN.
  const Breuse = await createWorktree(repo, PROJ, tB);
  check("(b) card 5150fdc2: clean auto-forward → staleBase ABSENT (resolved transparently)", Breuse.staleBase === undefined);
  check("(b) DIR-PRESENT recovery work PROVABLY NOT DISCARDED — the recovery tip is a real ancestor of the new HEAD",
    isAncestor(Breuse.worktreePath, recoveryTip, "HEAD"));
  check("(b) the recovery commit's file is present with its ORIGINAL content (not clobbered)",
    readNorm(path.join(Breuse.worktreePath, "recovery.txt")) === "real prior work\n");
  check("(b) the worktree was ALSO forwarded to include main's advance (clean auto-forward moved HEAD)",
    isAncestor(Breuse.worktreePath, c3, "HEAD") && readNorm(path.join(Breuse.worktreePath, "main-advance-b.txt")) === "C3\n");
  check("(b) recovery branch pointer was NOT reset to bare current main (still its own history, now forwarded)", git(repo, `rev-parse ${B.branch}`) !== c3);
  // cleanup B
  execSync(`git worktree remove --force "${B.worktreePath}"`, { cwd: repo });
  execSync(`git ${GIT_ID} branch -D ${B.branch}`, { cwd: repo });

  // ============================================================================================
  // (a2) BRANCH-PRESENT / DIR-GONE re-attach, EMPTY branch → re-cut onto current main.
  // ============================================================================================
  const tC = "empty-attach-cccc-3333";
  const C = await createWorktree(repo, PROJ, tC); // cut off current main (C3)
  const cBranch = C.branch, cWt = C.worktreePath;
  // Remove the worktree dir but KEEP the branch (the rejected-merge-then-GC shape).
  execSync(`git worktree remove --force "${cWt}"`, { cwd: repo });
  check("(a2 setup) branch survived the worktree removal", git(repo, `branch --list ${cBranch}`).includes(cBranch));
  // main advances to C4 while only the (empty) branch survives at C3.
  commitInto(repo, "main-advance-c.txt", "C4\n", "advance main to C4");
  const c4 = head(repo);
  check("(a2 setup) surviving branch is stale (0 commits ahead of C4)", git(repo, `rev-list --count ${c4}..${cBranch}`) === "0");
  // Re-spawn: branch present, dir gone → re-attach path. The empty branch must be re-cut onto C4.
  const Creattach = await createWorktree(repo, PROJ, tC);
  check("(a2) re-attach restored the worktree dir", fs.existsSync(Creattach.worktreePath));
  check("(a2) BRANCH-PRESENT empty branch re-cut → worktree HEAD == current main (C4)", head(Creattach.worktreePath) === c4);
  check("(a2) branch pointer also moved to current main (C4)", git(repo, `rev-parse ${cBranch}`) === c4);
  check("(a2) on the loom/<key> branch after re-attach + re-cut", git(Creattach.worktreePath, "rev-parse --abbrev-ref HEAD") === cBranch);
  execSync(`git worktree remove --force "${Creattach.worktreePath}"`, { cwd: repo });

  // ============================================================================================
  // (b2) BRANCH-PRESENT / DIR-GONE re-attach, RECOVERY branch → PRESERVED untouched.
  // ============================================================================================
  const tD = "recovery-attach-dddd-4444";
  const D = await createWorktree(repo, PROJ, tD); // cut off current main (C4)
  commitInto(D.worktreePath, "recovery2.txt", "real prior work 2\n", "recovery commit 2");
  const recovery2Tip = head(D.worktreePath);
  execSync(`git worktree remove --force "${D.worktreePath}"`, { cwd: repo }); // dir gone, branch (with work) survives
  commitInto(repo, "main-advance-d.txt", "C5\n", "advance main to C5");
  const c5 = head(repo);
  check("(b2 setup) surviving recovery branch is 1 commit ahead of current main", git(repo, `rev-list --count ${c5}..${D.branch}`) === "1");
  const Dreattach = await createWorktree(repo, PROJ, tD);
  check("(b2) card 5150fdc2: clean auto-forward → staleBase ABSENT (resolved transparently)", Dreattach.staleBase === undefined);
  check("(b2) BRANCH-PRESENT recovery work PROVABLY NOT DISCARDED — the recovery tip is a real ancestor of the new HEAD",
    isAncestor(Dreattach.worktreePath, recovery2Tip, "HEAD"));
  check("(b2) the recovery commit's file is present in the re-attached tree with its ORIGINAL content",
    readNorm(path.join(Dreattach.worktreePath, "recovery2.txt")) === "real prior work 2\n");
  check("(b2) the worktree was ALSO forwarded to include main's advance (clean auto-forward moved HEAD)",
    isAncestor(Dreattach.worktreePath, c5, "HEAD") && readNorm(path.join(Dreattach.worktreePath, "main-advance-d.txt")) === "C5\n");
  check("(b2) recovery branch pointer was NOT reset to bare current main (still its own history, now forwarded)", git(repo, `rev-parse ${D.branch}`) !== c5);
  execSync(`git worktree remove --force "${Dreattach.worktreePath}"`, { cwd: repo });
  execSync(`git ${GIT_ID} branch -D ${D.branch}`, { cwd: repo });

  // ============================================================================================
  // (b3) card 5150fdc2 — CONFLICTING advance: the recovery branch's own edit conflicts with main's own
  //      edit to the SAME file since the branch's fork. The auto-forward attempt must ABORT CLEANLY (no
  //      MERGE_HEAD, no partial index, branch tip BYTE-IDENTICAL to before the attempt — nothing to
  //      forward here, so nothing should move) and staleBase must be SURFACED rather than silently
  //      resolved. This is the other half of "never discard recovery work": (b)/(b2) proved a clean
  //      forward moves HEAD without losing anything; this proves a conflicting forward moves NOTHING.
  // ============================================================================================
  const tF = "recovery-conflict-ffff-6666";
  const baseShaF = head(repo); // the branch's true fork point, captured BEFORE it diverges from either side
  const F = await createWorktree(repo, PROJ, tF);
  commitInto(F.worktreePath, "README.md", "branch version F\n", "F recovery commit"); // 1 commit ahead
  const recoveryTipF = head(F.worktreePath);
  commitInto(repo, "README.md", "main version F\n", "advance main to C6 (conflicting)");
  const c6 = head(repo);
  check("(b3 setup) recovery branch is 1 commit ahead; main advanced by a CONFLICTING edit to the same file",
    git(repo, `rev-list --count ${c6}..${F.branch}`) === "1");
  const Freuse = await createWorktree(repo, PROJ, tF);
  check("(b3) conflicting forward → staleBase SURFACED (never silently resolved)", Freuse.staleBase !== undefined);
  check("(b3) staleBase.baseSha is the true fork point", Freuse.staleBase?.baseSha === baseShaF);
  check("(b3) staleBase.behindBy is 1 (main's one conflicting commit since the fork)", Freuse.staleBase?.behindBy === 1);
  let mergeHeadPresentF = true;
  try { execSync("git rev-parse -q --verify MERGE_HEAD", { cwd: Freuse.worktreePath }); } catch { mergeHeadPresentF = false; }
  check("(b3) the aborted attempt left NO leftover MERGE_HEAD", !mergeHeadPresentF);
  check("(b3) worktree is clean (merge --abort actually ran, no partial index)", git(Freuse.worktreePath, "status --porcelain") === "");
  check("(b3) branch tip is BYTE-IDENTICAL to before the aborted attempt — nothing moved", head(Freuse.worktreePath) === recoveryTipF);
  check("(b3) the recovery commit's content survived the aborted attempt, UNALTERED",
    readNorm(path.join(Freuse.worktreePath, "README.md")) === "branch version F\n");
  check("(b3) canonical main's own version is untouched (branch change did NOT land)",
    readNorm(path.join(repo, "README.md")) === "main version F\n");
  execSync(`git worktree remove --force "${Freuse.worktreePath}"`, { cwd: repo });
  execSync(`git ${GIT_ID} branch -D ${F.branch}`, { cwd: repo });

  // ============================================================================================
  // (c) FRESH task (no prior branch/dir) → new branch cut off current main — unchanged behavior.
  // ============================================================================================
  const tE = "fresh-eeee-5555";
  const before = head(repo); // current main (C5)
  const E = await createWorktree(repo, PROJ, tE);
  check("(c setup) fresh task got a brand-new branch (didn't exist before)", git(repo, `branch --list ${E.branch}`).includes(E.branch));
  check("(c) fresh worktree cut off current main → HEAD == current main (C5)", head(E.worktreePath) === before);
  check("(c) fresh branch on the loom/<key> branch", git(E.worktreePath, "rev-parse --abbrev-ref HEAD") === E.branch);
  execSync(`git worktree remove --force "${E.worktreePath}"`, { cwd: repo });
} finally {
  try { execSync("git worktree prune", { cwd: repo }); } catch { /* ignore */ }
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — createWorktree re-cuts an EMPTY/STALE reused branch (0 commits ahead) onto current main across BOTH reuse shapes (dir-present reuse AND branch-present/dir-gone re-attach), PRESERVES a recovery branch that carries real unmerged work — never reset, and per card 5150fdc2 either cleanly auto-forwarded (recovery tip PROVABLY an ancestor of the new HEAD, both files' content intact) or, on a real conflict, aborted with the recovery tip byte-identical and staleBase surfaced instead — and leaves the fresh-task path cutting off current main unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
