import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card fdc991be — mergeBranchLocked's own solo squash commit (worktrees.ts, the `git commit -m message`
// call right after the `expectAlreadyLanded` check) used to land with ONLY the repo/global git identity
// and no FALLBACK_GIT_IDENTITY. On a host with no git identity configured at all (a fresh end-user
// machine, or a CI runner), that commit failed with "Author identity unknown" AFTER the gate had already
// run. `mergeMainIntoWorktree` and batch-merge.ts's own cherry-pick commit already fell back this way
// (`hasConfiguredGitIdentity` + `FALLBACK_GIT_IDENTITY`); the solo squash was the one commit-creating path
// that didn't. See docs/decisions/2e73af30-prelanded-content-fixtures-never-persisted-canonical-identity.md
// for the root-cause investigation this card grew out of.
//
// TWO real-git scenarios, each calling `mergeBranch` directly (no createWorktree/LOOM_HOME needed — a
// plain `git worktree add -b` is enough to give the branch somewhere to be committed from, same shape as
// merge-staged-residue-refuses.mjs, this file's template):
//   (A) RED-equivalent documentation: a canonical repo with NO git identity configured anywhere (repo
//       config, global config, system config, or GIT_AUTHOR_*/GIT_COMMITTER_* env) — the squash commit
//       must still land, under the generic Loom fallback identity.
//   (B) CONTROL: a canonical repo WITH a persisted repo-local identity — the squash commit must land under
//       THAT identity, unchanged (never silently overridden by the fallback).
//
// (A) isolates HOME/XDG_CONFIG_HOME/GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM so the REAL host's own global git
// identity (this self-hosting Windows machine has one configured) can never leak in and mask the bug —
// mirrors exactly how docs/decisions/2e73af30-...md's own investigation reproduced the CI failure locally.
// Every REPO-SETUP commit in (A) still uses a scoped `-c user.email=/-c user.name=` prefix (process-local
// to that one invocation, never persisted — see 2e73af30's own "Do not" #1) so setup can proceed while the
// canonical repo itself ends up with NO identity for the actual commit under test to see.
//
// RED/GREEN proof: `pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/worktrees.ts
// --test packages/daemon/test/merge-solo-squash-identity-fallback.mjs --ref 775d47009adbb893aea91e3a88d1da18ba19c595`
// — RED on that pre-fix sha (scenario A's squash commit fails with "Author identity unknown"), GREEN with
// this fix.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-solo-squash-identity-fallback.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distUrl = pathToFileURL(path.join(__dirname, "..", "dist", "git", "worktrees.js")).href;
const { mergeBranch } = await import(distUrl);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const git = (cwd, args) => execFileSync("git", args, { cwd }).toString().trim();

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const tmpDirs = [];

function makeRepo(prefix) {
  const repo = path.join(os.tmpdir(), `loom-mssif-${prefix}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  execSync("git init -q", { cwd: repo });
  return repo;
}

function makeWorktree(repo, branch, file, content, idArgs) {
  const wt = path.join(os.tmpdir(), `loom-mssif-wt-${branch.replace(/\//g, "-")}-${sfx}`);
  tmpDirs.push(wt);
  execFileSync("git", ["worktree", "add", "-q", "-b", branch, wt, "HEAD"], { cwd: repo });
  fs.writeFileSync(path.join(wt, file), content);
  execFileSync("git", ["add", "."], { cwd: wt });
  execFileSync("git", [...idArgs, "commit", "-q", "-m", `${branch} work`], { cwd: wt });
  return wt;
}

function lastCommitAuthor(repo) {
  return git(repo, ["log", "-1", "--format=%an <%ae>"]);
}
function lastCommitCommitter(repo) {
  return git(repo, ["log", "-1", "--format=%cn <%ce>"]);
}

// ── (A) NO identity configured anywhere — must still land, under the Loom fallback. ──────────────────────
{
  console.log("\n— (A) host has NO git identity configured anywhere —");

  // Isolate HOME/XDG_CONFIG_HOME/GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM so the real host's own global git
  // identity can never leak in, and drop every GIT_AUTHOR_*/GIT_COMMITTER_* env override too.
  const isolatedHome = path.join(os.tmpdir(), `loom-mssif-home-${sfx}`);
  fs.mkdirSync(isolatedHome, { recursive: true });
  tmpDirs.push(isolatedHome);
  const emptyGlobalConfig = path.join(isolatedHome, "empty-gitconfig");
  fs.writeFileSync(emptyGlobalConfig, "");
  const savedEnv = {};
  for (const k of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"]) {
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

  try {
    const repo = makeRepo("a");
    const ID_ARGS = ["-c", "user.email=setup-a@loom", "-c", "user.name=setup-a"]; // scoped: persists nothing
    fs.writeFileSync(path.join(repo, "README.md"), "# a\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", [...ID_ARGS, "commit", "-q", "-m", "init", "--allow-empty"], { cwd: repo });

    check("precondition: canonical repo has no configured identity (repo scope)", (() => {
      try { git(repo, ["config", "user.name"]); return false; } catch { return true; }
    })());
    check("precondition: canonical repo has no configured identity (global scope, isolated)", (() => {
      try { git(repo, ["config", "--global", "user.name"]); return false; } catch { return true; }
    })());

    const branch = "loom/mssif-a";
    makeWorktree(repo, branch, "feature-a.txt", `a-content-${sfx}\n`, ID_ARGS);

    const res = await mergeBranch(repo, branch, "test(git): verify squash fallback identity (A)");

    check(`(A) mergeBranch succeeds despite no configured identity anywhere (reason: ${res.ok ? "n/a" : res.reason})`, res.ok === true);
    if (res.ok) {
      const author = lastCommitAuthor(repo);
      check(`(A) the landed commit's author is the Loom fallback identity (got "${author}")`, author === "Loom <loom@localhost>");
      const committer = lastCommitCommitter(repo);
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
  execFileSync("git", ["commit", "-q", "-m", "init", "--allow-empty"], { cwd: repo });

  check("precondition: canonical repo HAS a configured identity", (() => {
    try { git(repo, ["config", "user.name"]); return true; } catch { return false; }
  })());

  const branch = "loom/mssif-b";
  makeWorktree(repo, branch, "feature-b.txt", `b-content-${sfx}\n`, []);

  const res = await mergeBranch(repo, branch, "test(git): verify squash fallback identity (B)");

  check(`(B) mergeBranch succeeds with a configured identity (reason: ${res.ok ? "n/a" : res.reason})`, res.ok === true);
  if (res.ok) {
    const author = lastCommitAuthor(repo);
    check(`(B) the landed commit's author is the CONFIGURED identity, not the fallback (got "${author}")`, author === "configured-b <configured-b@loom>");
    const committer = lastCommitCommitter(repo);
    check(`(B) the landed commit's committer is the CONFIGURED identity, not the fallback (got "${committer}")`, committer === "configured-b <configured-b@loom>");
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the solo squash commit lands under a generic fallback identity when the host has none configured, and under the host's own configured identity, unchanged, when it does."
  : `\n❌ ${failures} FAILURE(S).`);

for (const d of tmpDirs) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
}

process.exit(failures === 0 ? 0 : 1);
