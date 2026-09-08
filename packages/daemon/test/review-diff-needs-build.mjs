import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// runBuild-for-review decision test (board card 503cd822).
//
// THE BUG: `provisionWorktreeDeps`'s `runBuild` used to key OFF `noCommit` alone — a build-free/`noCommit`
// review rig (Code Reviewer, Docs & Vault, …) always skipped the monorepo BUILD phase, on the premise that
// it "never runs a build gate, so a build has zero benefit". False for a REVIEW spawn: a reviewer can still
// EXECUTE a test file under review, and a build-free worktree never populates `dist/` for it to import — a
// real Code Reviewer session couldn't run 2 of 5 changed files under review for exactly this reason.
//
// THE FIX: `reviewDiffNeedsBuild(repoPath, branch, base, deps)` (git/worktrees.ts) — given the REVIEWED
// branch's diff against `base`, decide whether it's worth building for: build only when the diff touches
// at least one test-shaped file (`looksLikeTestFile`), fail OPEN (build) on any diff error.
//
// This test asserts on the DECISION itself (real git, no pnpm/build/daemon involved) — never a build
// side-effect — per this card's own DoD.
//
// Proves:
//   (A) looksLikeTestFile: positive shapes (test/tests/__tests__/spec/e2e dir segments, *.test.*/*.spec.*
//       filenames, backslash-separated paths) and negative shapes, INCLUDING a negative control proving
//       this is a path-SEGMENT/filename-SUFFIX check, not a bare substring match.
//   (B) reviewDiffNeedsBuild: a reviewed branch that adds a test-shaped file -> true.
//   (C) reviewDiffNeedsBuild: a reviewed branch that only touches non-test source -> false.
//   (D) reviewDiffNeedsBuild: no changes between base and the reviewed branch (same ref) -> false.
//   (E) reviewDiffNeedsBuild: an undetectable diff (a branch ref that doesn't exist) -> true (fail open).
// Run: 1) pnpm build, 2) node packages/daemon/test/review-diff-needs-build.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";

process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-rdnb-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { looksLikeTestFile, reviewDiffNeedsBuild } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const GIT_ID = "-c user.email=rdnb@loom -c user.name=rdnb";

try {
  // --- (A) looksLikeTestFile: pure path-shape checks, no git needed ---
  check("(A) test/ dir segment", looksLikeTestFile("packages/daemon/test/foo.mjs") === true);
  check("(A) tests/ dir segment", looksLikeTestFile("tests/foo.py") === true);
  check("(A) __tests__/ dir segment", looksLikeTestFile("src/__tests__/foo.ts") === true);
  check("(A) spec/ dir segment", looksLikeTestFile("spec/foo.rb") === true);
  check("(A) e2e/ dir segment", looksLikeTestFile("packages/web/e2e/foo.spec.ts") === true);
  check("(A) *.test.* filename", looksLikeTestFile("src/foo.test.ts") === true);
  check("(A) *.spec.* filename", looksLikeTestFile("src/foo.spec.tsx") === true);
  check("(A) case-insensitive dir segment (TEST)", looksLikeTestFile("packages/daemon/TEST/foo.mjs") === true);
  check("(A) backslash path separators normalize the same as forward slashes",
    looksLikeTestFile("packages\\daemon\\test\\foo.mjs") === true);
  check("(A) negative: plain source file", looksLikeTestFile("src/foo.ts") === false);
  check("(A) negative: docs/vault file", looksLikeTestFile("Projects/Loom/Design/notes.md") === false);
  check("(A) NEGATIVE CONTROL: 'test' as a mere substring of a segment/filename does NOT match — proves " +
    "this is a path-segment/filename-suffix check, not a bare substring scan",
    looksLikeTestFile("src/testament.ts") === false && looksLikeTestFile("contest/foo.ts") === false
      && looksLikeTestFile("src/latest.ts") === false);
  // Positive control for the SAME corpus shape the negative control uses, proving the checker can return
  // true at all (an always-false checker would pass every negative control vacuously).
  check("(A) positive control (same corpus family as the negative control above, proving true is reachable)",
    looksLikeTestFile("test/testament.ts") === true);

  // --- git-backed reviewDiffNeedsBuild checks ---
  const repo = path.join(os.tmpdir(), `loom-rdnb-repo-${Date.now()}-${process.pid}-${Math.random().toString(36).slice(2, 7)}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.writeFileSync(path.join(repo, "README.md"), "# rdnb\n");
  execSync(`git init -q && git config user.email rdnb@loom && git config user.name rdnb`, { cwd: repo });
  commitAll(repo, "init", GIT_ID);
  const mainBranch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: repo }).toString().trim();

  // (B) reviewed branch adds a test-shaped file
  execSync(`git checkout -q -b review-touches-test`, { cwd: repo });
  fs.mkdirSync(path.join(repo, "packages", "daemon", "test"), { recursive: true });
  fs.writeFileSync(path.join(repo, "packages", "daemon", "test", "new-check.mjs"), "// fixture test\n");
  commitAll(repo, "add a test file", GIT_ID);
  execSync(`git checkout -q ${mainBranch}`, { cwd: repo });

  // (C) reviewed branch touches only non-test source
  execSync(`git checkout -q -b review-source-only`, { cwd: repo });
  fs.mkdirSync(path.join(repo, "src"), { recursive: true });
  fs.writeFileSync(path.join(repo, "src", "foo.ts"), "export const x = 1;\n");
  commitAll(repo, "add source only", GIT_ID);
  execSync(`git checkout -q ${mainBranch}`, { cwd: repo });

  const needsBuildForTest = await reviewDiffNeedsBuild(repo, "review-touches-test", "HEAD");
  check("(B) a reviewed branch that adds a test-shaped file -> build needed (true)", needsBuildForTest === true);

  const needsBuildForSource = await reviewDiffNeedsBuild(repo, "review-source-only", "HEAD");
  check("(C) a reviewed branch that only touches non-test source -> build NOT needed (false)", needsBuildForSource === false);

  const needsBuildNoChanges = await reviewDiffNeedsBuild(repo, mainBranch, "HEAD");
  check("(D) no changes between base and the reviewed branch (same ref) -> build NOT needed (false)", needsBuildNoChanges === false);

  const needsBuildBadRef = await reviewDiffNeedsBuild(repo, "this-branch-does-not-exist-xyz", "HEAD");
  check("(E) an undetectable diff (nonexistent branch ref) fails OPEN -> build needed (true)", needsBuildBadRef === true);

  fs.rmSync(repo, { recursive: true, force: true });
} finally {
  fs.rmSync(process.env.LOOM_HOME, { recursive: true, force: true });
}

console.log(failures === 0 ? `\nAll checks passed.` : `\n${failures} check(s) FAILED.`);
process.exit(failures === 0 ? 0 : 1);
