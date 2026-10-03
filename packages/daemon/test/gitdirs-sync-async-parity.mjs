// Card 25389c3c — `git/repo-lock.ts`'s `resolveGitDirsSync` is the SYNC TWIN of `git/worktrees.ts`'s
// async `resolveGitDirs` (decision 472f14d1): the async one stays on the merged-map/worker-diff cache hot
// path (event-loop discipline bans blocking I/O there), while the sync one serves callers that can't go
// async (skills/inject.ts, pty/codex-doctrine.ts). Both must resolve IDENTICALLY for every `.git` shape,
// or the two call sites silently diverge. This test runs the SAME fixture matrix through both and asserts
// byte-identical `{privateDir, commonDir} | null` results — a future edit to either function that is not
// mirrored in the other goes RED here.
//
// Fixture matrix:
//   (A) plain-directory `.git`.
//   (B) linked worktree, ABSOLUTE `gitdir:` pointer + `commondir` file.
//   (C) linked worktree, RELATIVE `gitdir:` pointer + RELATIVE `commondir` contents.
//   (D) submodule / `--separate-git-dir`: `gitdir:` pointer, NO `commondir` file.
//   (E) malformed gitfile: `.git` is a FILE but its content doesn't match `gitdir: <path>` at all.
//   (F) bad pointer target: `gitdir:` points at a directory with no `HEAD` file.
//   (G) no `.git` entry at all (not a repo).
//
// Hermetic — no real git binary, no claude. Run after build: node test/gitdirs-sync-async-parity.mjs
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const { resolveGitDirs } = await import("../dist/git/worktrees.js");
const { resolveGitDirsSync } = await import("../dist/git/repo-lock.js");

function writeFile(p, content) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function buildPlainDirFixture(root) {
  const repoPath = path.join(root, "plain-repo");
  writeFile(path.join(repoPath, ".git", "HEAD"), "ref: refs/heads/main\n");
  return repoPath;
}

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
  return repoPath;
}

function buildSeparateGitDirFixture(root) {
  const repoPath = path.join(root, "separate-gitdir-repo");
  const gitDir = path.join(root, "separate-gitdir-target");
  fs.mkdirSync(repoPath, { recursive: true });
  writeFile(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  writeFile(path.join(repoPath, ".git"), `gitdir: ${gitDir}\n`);
  return repoPath;
}

function buildMalformedGitfileFixture(root) {
  const repoPath = path.join(root, "malformed-gitfile-repo");
  fs.mkdirSync(repoPath, { recursive: true });
  writeFile(path.join(repoPath, ".git"), "not a gitdir pointer at all\n");
  return repoPath;
}

function buildBadPointerTargetFixture(root) {
  const repoPath = path.join(root, "bad-pointer-repo");
  const gitDir = path.join(root, "bad-pointer-target"); // deliberately never created
  fs.mkdirSync(repoPath, { recursive: true });
  writeFile(path.join(repoPath, ".git"), `gitdir: ${gitDir}\n`);
  return repoPath;
}

function buildNoGitFixture(root) {
  const repoPath = path.join(root, "no-git-repo");
  fs.mkdirSync(repoPath, { recursive: true });
  return repoPath;
}

async function checkParity(name, repoPath) {
  const asyncResult = await resolveGitDirs(repoPath);
  const syncResult = resolveGitDirsSync(repoPath);
  check(`${name}: both null, or both resolve`, (asyncResult === null) === (syncResult === null));
  if (asyncResult !== null && syncResult !== null) {
    check(`${name}: privateDir matches`, asyncResult.privateDir === syncResult.privateDir);
    check(`${name}: commonDir matches`, asyncResult.commonDir === syncResult.commonDir);
  }
}

const root = mkdtempManaged("loom-gitdirs-parity-");

await checkParity("(A) plain-directory .git", buildPlainDirFixture(root));
await checkParity("(B) linked worktree, absolute gitdir+commondir", buildWorktreeFixture(root, { relative: false }));
await checkParity("(C) linked worktree, relative gitdir+commondir", buildWorktreeFixture(root, { relative: true }));
await checkParity("(D) submodule / --separate-git-dir (no commondir)", buildSeparateGitDirFixture(root));
await checkParity("(E) malformed gitfile (no gitdir: pointer)", buildMalformedGitfileFixture(root));
await checkParity("(F) bad pointer target (no HEAD)", buildBadPointerTargetFixture(root));
await checkParity("(G) no .git at all", buildNoGitFixture(root));

console.log(failures === 0
  ? "\n✅ ALL PASS — resolveGitDirs (async, git/worktrees.ts) and resolveGitDirsSync (sync, git/repo-lock.ts) agree on every fixture shape."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
