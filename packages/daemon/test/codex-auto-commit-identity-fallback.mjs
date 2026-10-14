import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 27ac3c2d (discovered from fdc991be, sequenced after the shared-helper card 2267e8fa):
// `attemptCodexAutoCommit` (git/worktrees.ts) committed a codex-harness worker's own dirty worktree
// changes with NO identity fallback. On a host with no git identity configured at all (a fresh end-user
// machine), the commit call failed with "Author identity unknown" — so the codex worker's work could
// never be committed, and its `done` report was refused by the ordinary uncommitted-files precheck.
// `mergeMainIntoWorktree` and `mergeBranchLocked`'s own solo squash commit already fell back this way
// (`resolveGitIdentityFallbackArgs`, git/bounded.ts, card 2267e8fa); the codex auto-commit was the one
// commit-creating path that didn't.
//
// TWO real-git scenarios, each calling `attemptCodexAutoCommit` directly (the lower-level seam
// `codex-worker-auto-commit.mjs` already uses for its own S1-S4/K7/K8/K11-K13 cases), mirroring
// `merge-solo-squash-identity-fallback.mjs`'s (A)/(B) recipe:
//   (A) RED-equivalent: a worktree whose canonical repo has NO git identity configured anywhere (repo
//       config, global config, system config, or GIT_AUTHOR_*/GIT_COMMITTER_* env, with EMAIL unset
//       too) — the auto-commit must still land, under the generic Loom fallback identity, asserting
//       BOTH author AND committer (the card's own DoD).
//   (B) CONTROL: a worktree whose canonical repo HAS a persisted repo-local identity — the auto-commit
//       must land under THAT identity, unchanged (never silently overridden by the fallback).
//
// (A) isolates HOME/XDG_CONFIG_HOME/GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM so this self-hosting machine's
// own real global git identity can never leak in and mask the bug (same isolation recipe as
// `merge-solo-squash-identity-fallback.mjs`'s scenario A and CLAUDE.md's own identity-less repro
// recipe) — lesson from card 2267e8fa's own review: a test asserting a fallback identity must not
// depend on the ambient host identity. `createWorktree` itself makes no commit (just `git worktree
// add` against the existing HEAD), so neither scenario's setup needs an identity at all.
//
// RED/GREEN proof: `pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/worktrees.ts
// --test packages/daemon/test/codex-auto-commit-identity-fallback.mjs --ref 3abe1c42e12e70a261985f5a9d32e2ba9d25a289`
// — RED on that pre-fix sha (scenario A's auto-commit fails with "Author identity unknown", so
// `committed` never reaches true), GREEN with this fix.
//
// Run: 1) build daemon (pnpm build), 2) node test/codex-auto-commit-identity-fallback.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";

// createworktree-loom-home-guard: this file calls the real createWorktree( below, so a temp LOOM_HOME
// must be in force BEFORE the dist import (WORKTREES_DIR is a sibling of LOOM_HOME).
process.env.LOOM_HOME = path.join(os.tmpdir(), `loom-caif-home-${Date.now()}-${process.pid}`);
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { createWorktree, attemptCodexAutoCommit } = await import("../dist/git/worktrees.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const git = (cwd, args) => execFileSync("git", args, { cwd }).toString().trim();

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const tmpDirs = [process.env.LOOM_HOME];

function makeRepo(prefix) {
  const repo = path.join(os.tmpdir(), `loom-caif-${prefix}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  execSync("git init -q", { cwd: repo });
  return repo;
}

function lastCommitAuthor(repo) {
  return git(repo, ["log", "-1", "--format=%an <%ae>"]);
}
function lastCommitCommitter(repo) {
  return git(repo, ["log", "-1", "--format=%cn <%ce>"]);
}

// ── (A) NO identity configured anywhere — the auto-commit must still land, under the Loom fallback. ──────
{
  console.log("\n— (A) host has NO git identity configured anywhere —");

  const isolatedHome = path.join(os.tmpdir(), `loom-caif-home-a-${sfx}`);
  fs.mkdirSync(isolatedHome, { recursive: true });
  tmpDirs.push(isolatedHome);
  const emptyGlobalConfig = path.join(isolatedHome, "empty-gitconfig");
  fs.writeFileSync(emptyGlobalConfig, "");
  const savedEnv = {};
  for (const k of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) {
    savedEnv[k] = process.env[k];
  }
  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;
  process.env.XDG_CONFIG_HOME = isolatedHome;
  process.env.GIT_CONFIG_GLOBAL = emptyGlobalConfig;
  process.env.GIT_CONFIG_SYSTEM = emptyGlobalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  delete process.env.GIT_AUTHOR_NAME;
  delete process.env.GIT_AUTHOR_EMAIL;
  delete process.env.GIT_COMMITTER_NAME;
  delete process.env.GIT_COMMITTER_EMAIL;
  delete process.env.EMAIL;

  try {
    const repo = makeRepo("a");
    const ID_ARGS = ["-c", "user.email=setup-a@loom", "-c", "user.name=setup-a"]; // scoped: persists nothing
    fs.writeFileSync(path.join(repo, "README.md"), "# a\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", [...ID_ARGS, "commit", "-q", "-m", "init"], { cwd: repo });

    check("precondition: canonical repo has no configured identity (repo scope)", (() => {
      try { git(repo, ["config", "user.name"]); return false; } catch { return true; }
    })());
    check("precondition: canonical repo has no configured identity (global scope, isolated)", (() => {
      try { git(repo, ["config", "--global", "user.name"]); return false; } catch { return true; }
    })());

    const { worktreePath, branch } = await createWorktree(repo, `caif-a-proj-${sfx}`, `caif-a-task-${sfx}`);
    tmpDirs.push(worktreePath);
    fs.writeFileSync(path.join(worktreePath, "feature-a.txt"), `a-content-${sfx}\n`);

    const ac = await attemptCodexAutoCommit(worktreePath, branch, { summary: "verify auto-commit fallback identity (A)" });

    check(`(A) attemptCodexAutoCommit succeeds despite no configured identity anywhere (error: ${ac.error ?? "n/a"})`, ac.committed === true);
    if (ac.committed) {
      const author = lastCommitAuthor(worktreePath);
      check(`(A) the landed commit's author is the Loom fallback identity (got "${author}")`, author === "Loom <loom@localhost>");
      const committer = lastCommitCommitter(worktreePath);
      check(`(A) the landed commit's committer is the Loom fallback identity (got "${committer}")`, committer === "Loom <loom@localhost>");
    }
  } finally {
    for (const k of Object.keys(savedEnv)) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }
}

// ── (B) CONTROL: a host WITH a configured identity — must land under THAT identity, unchanged. ───────────
{
  console.log("\n— (B) CONTROL: host HAS a configured (repo-local) git identity —");
  const repo = makeRepo("b");
  execFileSync("git", ["config", "user.email", "configured-b@loom"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "configured-b"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "# b\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });

  check("precondition: canonical repo HAS a configured identity", (() => {
    try { git(repo, ["config", "user.name"]); return true; } catch { return false; }
  })());

  const { worktreePath, branch } = await createWorktree(repo, `caif-b-proj-${sfx}`, `caif-b-task-${sfx}`);
  tmpDirs.push(worktreePath);
  fs.writeFileSync(path.join(worktreePath, "feature-b.txt"), `b-content-${sfx}\n`);

  const ac = await attemptCodexAutoCommit(worktreePath, branch, { summary: "verify configured identity kept (B)" });

  check(`(B) attemptCodexAutoCommit succeeds with a configured identity (error: ${ac.error ?? "n/a"})`, ac.committed === true);
  if (ac.committed) {
    const author = lastCommitAuthor(worktreePath);
    check(`(B) the landed commit's author is the CONFIGURED identity, not the fallback (got "${author}")`, author === "configured-b <configured-b@loom>");
    const committer = lastCommitCommitter(worktreePath);
    check(`(B) the landed commit's committer is the CONFIGURED identity, not the fallback (got "${committer}")`, committer === "configured-b <configured-b@loom>");
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the codex auto-commit lands under a generic fallback identity when the host has none configured, and under the host's own configured identity, unchanged, when it does."
  : `\n❌ ${failures} FAILURE(S).`);

for (const d of tmpDirs) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
}

process.exit(failures === 0 ? 0 : 1);
