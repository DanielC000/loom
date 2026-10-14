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
// FOUR real-git scenarios (card 2267e8fa added (C)/(D) — the probe redesign's own matrix, see
// docs/decisions/2267e8fa-identity-fallback-probes-git-var-not-config.md), each calling `mergeBranch`
// directly (no createWorktree/LOOM_HOME needed — a plain `git worktree add -b` is enough to give the
// branch somewhere to be committed from, same shape as merge-staged-residue-refuses.mjs, this file's
// template):
//   (A) RED-equivalent documentation: a canonical repo with NO git identity configured anywhere (repo
//       config, global config, system config, or GIT_AUTHOR_*/GIT_COMMITTER_* env) — the squash commit
//       must still land, under the generic Loom fallback identity.
//   (B) CONTROL: a canonical repo WITH a persisted repo-local identity — the squash commit must land under
//       THAT identity, unchanged (never silently overridden by the fallback).
//   (C) name in config, email ONLY via the EMAIL env var — the squash commit must keep the user's own
//       identity (config name + EMAIL-env address), never the fallback. This is the exact bug the CR for
//       this card found: a bare `git config user.email` read sees nothing and wrongly triggers a fallback
//       that silently also overrides the configured NAME.
//   (D) identity resolvable ONLY via GIT_AUTHOR_*/GIT_COMMITTER_* env (no config, no EMAIL) — kept too.
//   (E) card 7b59e981's HYBRID case: author resolvable via EMAIL env, committer genuinely unresolvable —
//       the landed commit must come out SPLIT (author kept, committer gets the fallback), never the old
//       shared `-c user.*` pair's cross-role contamination (which also rewrote the author's real email).
//
// (C) is the scenario that discriminates THIS card's probe fix (RED-proven on pre-fix sha 43a65f27, via
// negative-control): (A)/(B)/(D) all pass identically on the OLD config-read probe too, so a pass on any
// of them is a regression pin, never fix evidence — see CR 4eb77ad0 round 2 (card 2267e8fa). (E)
// discriminates the SEPARATE per-role fix (card 7b59e981) the same way: it fails on the shared `-c`
// mechanism and passes only once the fallback is injected per-role.
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

// ── (C) name in config, email ONLY via the EMAIL env var — must be kept, not overridden. ─────────────────
// Card 2267e8fa's own root cause: `hasConfiguredGitIdentity`'s bare `git config user.email` read sees
// nothing (email isn't IN config) and wrongly falls back, even though `git` itself resolves the email
// fine via the EMAIL env var — overriding the real configured NAME too, as a side effect. The fix probes
// `git var GIT_AUTHOR_IDENT`/`GIT_COMMITTER_IDENT` instead, which already accounts for EMAIL.
{
  console.log("\n— (C) name in config, email ONLY via EMAIL env — must be kept, not overridden —");
  const isolatedHome = path.join(os.tmpdir(), `loom-mssif-home-c-${sfx}`);
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
  process.env.EMAIL = "env-c@loom";

  try {
    const repo = makeRepo("c");
    // Persist ONLY user.name in the canonical repo's own config — real repo-scoped config, not a scoped
    // `-c` override — so the squash commit itself resolves name from config and email from EMAIL env.
    execFileSync("git", ["config", "user.name", "configured-c"], { cwd: repo });
    const ID_ARGS = ["-c", "user.email=setup-c@loom", "-c", "user.name=setup-c"]; // scoped: persists nothing
    fs.writeFileSync(path.join(repo, "README.md"), "# c\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", [...ID_ARGS, "commit", "-q", "-m", "init", "--allow-empty"], { cwd: repo });

    check("precondition: canonical repo has user.name configured but no user.email", (() => {
      try { git(repo, ["config", "user.name"]); } catch { return false; }
      try { git(repo, ["config", "user.email"]); return false; } catch { return true; }
    })());

    const branch = "loom/mssif-c";
    makeWorktree(repo, branch, "feature-c.txt", `c-content-${sfx}\n`, ID_ARGS);

    const res = await mergeBranch(repo, branch, "test(git): verify squash identity kept (C)");

    check(`(C) mergeBranch succeeds (reason: ${res.ok ? "n/a" : res.reason})`, res.ok === true);
    if (res.ok) {
      const author = lastCommitAuthor(repo);
      check(`(C) the landed commit's author keeps the configured name + EMAIL-env address, NOT the fallback (got "${author}")`, author === "configured-c <env-c@loom>");
      const committer = lastCommitCommitter(repo);
      check(`(C) the landed commit's committer keeps the configured name + EMAIL-env address, NOT the fallback (got "${committer}")`, committer === "configured-c <env-c@loom>");
    }
  } finally {
    for (const k of Object.keys(savedEnv)) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }
}

// ── (D) identity resolvable ONLY via GIT_AUTHOR_*/GIT_COMMITTER_* env — REGRESSION PIN, not fix evidence
// (CR 4eb77ad0 round 2): this case passes on BOTH the pre-fix and post-fix probe — a role-scoped env var
// outranks `-c user.name=`/`-c user.email=` in git's own precedence regardless of how "configured" is
// decided, so it was never capable of discriminating the bug. Kept here only to pin that this case
// doesn't regress; (C) above is the ONE case that actually proves the fix (RED-proven on 43a65f27). ────
{
  console.log("\n— (D) identity resolvable ONLY via GIT_AUTHOR_*/GIT_COMMITTER_* env — must be kept —");
  const isolatedHome = path.join(os.tmpdir(), `loom-mssif-home-d-${sfx}`);
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
  delete process.env.EMAIL;
  process.env.GIT_AUTHOR_NAME = "env-author-d";
  process.env.GIT_AUTHOR_EMAIL = "env-author-d@loom";
  process.env.GIT_COMMITTER_NAME = "env-committer-d";
  process.env.GIT_COMMITTER_EMAIL = "env-committer-d@loom";

  try {
    const repo = makeRepo("d");
    const ID_ARGS = ["-c", "user.email=setup-d@loom", "-c", "user.name=setup-d"]; // scoped: persists nothing
    fs.writeFileSync(path.join(repo, "README.md"), "# d\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", [...ID_ARGS, "commit", "-q", "-m", "init", "--allow-empty"], { cwd: repo });

    check("precondition: canonical repo has NO configured identity anywhere (env-only case)", (() => {
      try { git(repo, ["config", "user.name"]); return false; } catch { return true; }
    })());

    const branch = "loom/mssif-d";
    makeWorktree(repo, branch, "feature-d.txt", `d-content-${sfx}\n`, ID_ARGS);

    const res = await mergeBranch(repo, branch, "test(git): verify squash identity kept (D)");

    check(`(D) mergeBranch succeeds (reason: ${res.ok ? "n/a" : res.reason})`, res.ok === true);
    if (res.ok) {
      const author = lastCommitAuthor(repo);
      check(`(D) the landed commit's author is the GIT_AUTHOR_* env identity, NOT the fallback (got "${author}")`, author === "env-author-d <env-author-d@loom>");
      const committer = lastCommitCommitter(repo);
      check(`(D) the landed commit's committer is the GIT_COMMITTER_* env identity, NOT the fallback (got "${committer}")`, committer === "env-committer-d <env-committer-d@loom>");
    }
  } finally {
    for (const k of Object.keys(savedEnv)) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }
}

// ── (E) card 7b59e981 — the HYBRID case, end-to-end through the REAL solo squash: author resolvable via
// EMAIL env (a non-role-scoped layer), committer genuinely unresolvable. Proves the PER-ROLE fix lands a
// SPLIT identity — author kept exactly, committer gets the generic fallback — never the old shared `-c
// user.*` pair's cross-role contamination (which would have overwritten the author's real email too).
// GIT_COMMITTER_NAME="" (an explicit, empty role-scoped env var) forces a REAL, deterministic, host-
// independent "empty ident name" failure for the committer probe specifically — portable where relying on
// real auto-detect is not (this host's own NAME auto-detect succeeds unconditionally via a Windows API
// call no env var touches, and EMAIL backstops BOTH roles' email whenever neither sets its own role-scoped
// GIT_AUTHOR_EMAIL/GIT_COMMITTER_EMAIL, so neither can be made to fail portably on its own). ──────────────
{
  console.log("\n— (E) HYBRID end-to-end: author via EMAIL env (kept), committer genuinely unresolvable (gets the fallback) —");
  const isolatedHome = path.join(os.tmpdir(), `loom-mssif-home-e-${sfx}`);
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
  delete process.env.GIT_AUTHOR_EMAIL;
  delete process.env.GIT_COMMITTER_EMAIL;
  delete process.env.GIT_COMMITTER_NAME;
  process.env.GIT_AUTHOR_NAME = "Alice";
  process.env.EMAIL = "alice@real";

  try {
    // Setup (repo init + the worktree's own branch-work commit) runs BEFORE GIT_COMMITTER_NAME is forced
    // empty below — those scoped `-c` setup commits would otherwise fail too, since an explicit (even
    // empty) role-scoped env var outranks `-c` on git's own precedence.
    const repo = makeRepo("e");
    const ID_ARGS = ["-c", "user.email=setup-e@loom", "-c", "user.name=setup-e"]; // scoped: persists nothing
    fs.writeFileSync(path.join(repo, "README.md"), "# e\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", [...ID_ARGS, "commit", "-q", "-m", "init", "--allow-empty"], { cwd: repo });

    const branch = "loom/mssif-e";
    makeWorktree(repo, branch, "feature-e.txt", `e-content-${sfx}\n`, ID_ARGS);

    process.env.GIT_COMMITTER_NAME = ""; // explicit empty — a real, deterministic committer-ident failure
    const res = await mergeBranch(repo, branch, "test(git): verify squash hybrid fallback split (E)");

    check(`(E) mergeBranch succeeds (reason: ${res.ok ? "n/a" : res.reason})`, res.ok === true);
    if (res.ok) {
      const author = lastCommitAuthor(repo);
      check(`(E) [FIX TARGET] the landed commit's AUTHOR keeps the real EMAIL-env address, NOT the fallback (got "${author}")`, author === "Alice <alice@real>");
      const committer = lastCommitCommitter(repo);
      check(`(E) the landed commit's COMMITTER gets the generic Loom fallback (got "${committer}")`, committer === "Loom <loom@localhost>");
    }
  } finally {
    for (const k of Object.keys(savedEnv)) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the solo squash commit lands under a generic fallback identity when the host has none configured, under the host's own resolvable identity (config, config+EMAIL env, or env-only) unchanged when it does, and under a correctly SPLIT per-role identity when only one role is genuinely unresolvable."
  : `\n❌ ${failures} FAILURE(S).`);

for (const d of tmpDirs) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
}

process.exit(failures === 0 ? 0 : 1);
