import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 472f14d1 — readHeadSha/readRefSha/readBaseSha (git/worktrees.ts) assumed a canonical repo's `.git`
// is always a DIRECTORY. When it's a FILE (a linked worktree, a submodule, or a `--separate-git-dir`
// repo used as the canonical repoPath), readHeadSha threw (caught -> null), degrading readBaseSha's
// `base === "HEAD"` branch to the constant freshness key "-" — which the merged-commit-map cache then
// serves FOREVER, never re-validating against a new commit on such a repo. See
// docs/decisions/472f14d1-resolvegitdirs-commondir-equals-privatedir-fallback.md for the fix (a new
// fs-only resolveGitDirs() helper) and why a gitfile canonical repo is a real, reachable shape here (repo
// binding's own isGitRepo uses the real git binary, which resolves gitfile pointers natively; nothing
// rejects this shape at creation time).
//
// FAKE gitFactory (same injectable BoundedGitDeps seam as task-merged-state-concurrency.mjs) counts every
// "git log" invocation — proves cache invalidation STRUCTURALLY (by counting actual scans), not by
// asserting on the resolved sha value directly.
//
// Five hand-built (no real git binary) fixture shapes, each run through the SAME 3-call probe
// (cold -> 1 scan; unchanged -> still 1; after a simulated new commit -> 2 scans):
//   (A) plain-directory `.git` — CONTROL, byte-identical to the pre-card code path.
//   (B) linked worktree, ABSOLUTE `gitdir:` pointer + `commondir` file (loose ref in the common dir).
//   (C) linked worktree, RELATIVE `gitdir:` pointer + RELATIVE `commondir` contents.
//   (D) submodule / `--separate-git-dir` shape: a `gitdir:` pointer with NO `commondir` file at all —
//       HEAD and refs live directly in the pointed-to dir.
//   (E) linked worktree (absolute, like B) whose branch ref lives ONLY in `packed-refs` in the common
//       dir — never a loose ref file — proving resolution reads packed-refs through `commonDir` too.
//
// RED-FIRST: run this file against the PRE-FIX dist (git stash the worktrees.ts change, rebuild, run) —
// (A) passes throughout; (B)-(E) each pass their first two checks (cold scan, unchanged) but FAIL the
// third ("after simulated new commit -> 2 scans"), staying at 1: readHeadSha throws on the gitfile,
// readBaseSha degrades to the constant "-" key, and the cache never invalidates. Then restore + rebuild:
// all scenarios pass.
//
// Run: 1) build (turbo builds shared first), 2) node test/merged-map-gitfile-canonical-repo.mjs
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { getMergedCommitMapCached, __resetMergedCommitMapCacheForTest } = await import("../dist/git/worktrees.js");

const FAKE_SHA_A = "a".repeat(40);
const FAKE_SHA_B = "b".repeat(40);

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

/** A fake BoundedGitDeps.gitFactory that counts "git log" calls and returns an empty log — never touches
 *  the real simple-git/git binary. Mirrors task-merged-state-concurrency.mjs's own spy exactly. */
function makeSpyFactory() {
  let logCalls = 0;
  const gitFactory = () => ({
    raw: async (args) => {
      if (args[0] === "log") { logCalls++; return ""; } // empty log -> empty merged map, no further calls
      return "";
    },
  });
  return { gitFactory, count: () => logCalls };
}

// (A) CONTROL: plain-directory `.git`, symbolic HEAD -> a loose ref file.
function buildPlainDirFixture(root) {
  const repoPath = path.join(root, "plain-repo");
  writeFile(path.join(repoPath, ".git", "HEAD"), "ref: refs/heads/main\n");
  writeFile(path.join(repoPath, ".git", "refs", "heads", "main"), `${FAKE_SHA_A}\n`);
  return {
    repoPath,
    setSha(sha) { fs.writeFileSync(path.join(repoPath, ".git", "refs", "heads", "main"), `${sha}\n`); },
  };
}

// (B)/(C) Linked worktree: `.git` FILE -> gitdir -> private dir (symbolic HEAD + commondir file) ->
// common dir (loose refs/heads/main). `relative: true` makes BOTH the gitdir pointer and the commondir
// file's own contents relative paths, exercising real git's own relative-path resolution rule (relative
// to the directory holding the file that names the path).
function buildWorktreeFixture(root, { relative }) {
  const tag = relative ? "rel" : "abs";
  const repoPath = path.join(root, `wt-repo-${tag}`);
  const commonGitDir = path.join(root, `wt-common-${tag}`, ".git");
  const privateDir = path.join(commonGitDir, "worktrees", "wt1");
  fs.mkdirSync(repoPath, { recursive: true });
  fs.mkdirSync(privateDir, { recursive: true });
  writeFile(path.join(privateDir, "HEAD"), "ref: refs/heads/main\n");
  const commondirContents = relative ? path.relative(privateDir, commonGitDir) : commonGitDir;
  writeFile(path.join(privateDir, "commondir"), `${commondirContents}\n`);
  const gitdirTarget = relative ? path.relative(repoPath, privateDir) : privateDir;
  writeFile(path.join(repoPath, ".git"), `gitdir: ${gitdirTarget}\n`);
  writeFile(path.join(commonGitDir, "refs", "heads", "main"), `${FAKE_SHA_A}\n`);
  return {
    repoPath,
    setSha(sha) { fs.writeFileSync(path.join(commonGitDir, "refs", "heads", "main"), `${sha}\n`); },
  };
}

// (D) Submodule / `--separate-git-dir`: `.git` FILE -> gitdir -> that SAME dir holds HEAD and refs/**
// directly, with NO `commondir` file anywhere — there is no indirection to follow.
function buildSeparateGitDirFixture(root) {
  const repoPath = path.join(root, "separate-gitdir-repo");
  const gitDir = path.join(root, "separate-gitdir-target");
  fs.mkdirSync(repoPath, { recursive: true });
  writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  writeFile(path.join(gitDir, "refs", "heads", "main"), `${FAKE_SHA_A}\n`);
  writeFile(path.join(repoPath, ".git"), `gitdir: ${gitDir}\n`);
  return {
    repoPath,
    setSha(sha) { fs.writeFileSync(path.join(gitDir, "refs", "heads", "main"), `${sha}\n`); },
  };
}

// (E) Linked worktree (absolute, like B) whose branch ref is resolvable ONLY via `packed-refs` in the
// common dir — no loose ref file at all.
function buildPackedRefsFixture(root) {
  const repoPath = path.join(root, "packed-repo");
  const commonGitDir = path.join(root, "packed-common", ".git");
  const privateDir = path.join(commonGitDir, "worktrees", "wt1");
  fs.mkdirSync(repoPath, { recursive: true });
  fs.mkdirSync(privateDir, { recursive: true });
  writeFile(path.join(privateDir, "HEAD"), "ref: refs/heads/main\n");
  writeFile(path.join(privateDir, "commondir"), `${commonGitDir}\n`);
  writeFile(path.join(repoPath, ".git"), `gitdir: ${privateDir}\n`);
  const packedRefs = (sha) => `# pack-refs with: peeled fully-peeled sorted\n${sha} refs/heads/main\n`;
  writeFile(path.join(commonGitDir, "packed-refs"), packedRefs(FAKE_SHA_A));
  return {
    repoPath,
    setSha(sha) { fs.writeFileSync(path.join(commonGitDir, "packed-refs"), packedRefs(sha)); },
  };
}

async function runScenario(name, fixture) {
  __resetMergedCommitMapCacheForTest();
  const spy = makeSpyFactory();
  await getMergedCommitMapCached(fixture.repoPath, "HEAD", { gitFactory: spy.gitFactory });
  check(`${name}: cold cache -> exactly 1 scan`, spy.count() === 1);
  await getMergedCommitMapCached(fixture.repoPath, "HEAD", { gitFactory: spy.gitFactory });
  check(`${name}: unchanged repo -> still 1 scan (real cache hit, not an accidental constant-key hit)`, spy.count() === 1);
  fixture.setSha(FAKE_SHA_B);
  await getMergedCommitMapCached(fixture.repoPath, "HEAD", { gitFactory: spy.gitFactory });
  check(`${name}: after a simulated new commit -> 2 scans (cache invalidated)`, spy.count() === 2);
}

const root = mkdtempManaged("loom-merged-map-gitfile-");

try {
  await runScenario("(A) plain-directory .git [control]", buildPlainDirFixture(root));
  await runScenario("(B) linked worktree, absolute gitdir+commondir", buildWorktreeFixture(root, { relative: false }));
  await runScenario("(C) linked worktree, relative gitdir+commondir", buildWorktreeFixture(root, { relative: true }));
  await runScenario("(D) submodule / --separate-git-dir (no commondir)", buildSeparateGitDirFixture(root));
  await runScenario("(E) linked worktree, branch resolved via packed-refs", buildPackedRefsFixture(root));
} finally {
  __resetMergedCommitMapCacheForTest();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the merged-commit-map cache correctly resolves HEAD/refs (and therefore invalidates on a new commit) for a canonical repo whose .git is a plain directory, a linked worktree (absolute or relative gitdir+commondir), a submodule/--separate-git-dir pointer with no commondir, and a worktree whose branch ref lives only in packed-refs."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
