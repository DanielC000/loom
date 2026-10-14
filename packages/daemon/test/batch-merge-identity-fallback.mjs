import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 2267e8fa — batch-merge.ts's own cherry-pick-commit identity fallback (git/batch-merge.ts,
// `landBranchCommitsIndividually`'s `identityArgs`) had the SAME bug as the solo squash path
// (merge-solo-squash-identity-fallback.mjs's own header): a bare `git config user.name`/`user.email`
// read ignores GIT_AUTHOR_*/GIT_COMMITTER_*/EMAIL env entirely, so a host resolving its real identity
// through one of those was wrongly reported as "not configured" and silently re-authored as Loom. Fixed
// by routing through the ONE shared helper (resolveGitIdentityFallbackArgs, git/bounded.ts) — see
// docs/decisions/2267e8fa-identity-fallback-probes-git-var-not-config.md.
//
// NOTE ON WHAT THIS ACTUALLY EXERCISES: the landed commit's AUTHOR is always explicitly set via
// `--author "<name> <email>"` from the worker's ORIGINAL commit (landBranchCommitsIndividually preserves
// authorship explicitly — see that function's own doc) — so author identity is NEVER affected by this
// fallback, in any scenario. The COMMITTER of the fresh commit this function makes IS affected: that's
// what every check below actually proves is kept-or-falls-back correctly. Author is asserted too, in
// every scenario, as a "didn't regress" sanity check.
//
// FOUR real-git scenarios, mirroring merge-solo-squash-identity-fallback.mjs's own matrix, each calling
// `assembleBatchBranches` directly against a throwaway batch worktree (no createWorktree/LOOM_HOME
// needed — a plain `git worktree add` gives both the worker branch and the batch worktree somewhere to
// live, same shape as the solo test's own template):
//   (A) host has NO git identity configured anywhere — the cherry-pick commit must still land, under the
//       generic Loom fallback identity as COMMITTER (author stays the worker's own).
//   (B) CONTROL: host HAS a configured (repo-local) git identity — committer lands under THAT identity.
//   (C) name in config, email ONLY via the EMAIL env var — committer keeps the user's own identity, never
//       the fallback. The exact bug: a bare `git config user.email` read sees nothing and wrongly falls
//       back even though `git` itself resolves the email fine.
//   (D) identity resolvable ONLY via GIT_AUTHOR_*/GIT_COMMITTER_* env (no config, no EMAIL) — kept too.
//
// (C) is the ONLY scenario that actually DISCRIMINATES the fix (RED-proven on pre-fix sha 43a65f27, via
// negative-control): (A)/(B)/(D) all pass identically on the OLD config-read probe too, so a pass on any
// of them is a regression pin, never fix evidence — see CR 4eb77ad0 round 2 (card 2267e8fa).
//
// RED/GREEN proof: `pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/bounded.ts
// --file packages/daemon/src/git/worktrees.ts --file packages/daemon/src/git/batch-merge.ts
// --file packages/daemon/src/vault/versioner.ts --test packages/daemon/test/batch-merge-identity-fallback.mjs
// --ref 43a65f27` (all four touched source files, so the revert is a genuine behavioral RED rather than a
// build break from a half-reverted import) — RED on that pre-fix sha (scenario C's committer becomes the
// fallback), GREEN with this fix.
//
// Run: 1) build daemon (pnpm build), 2) node test/batch-merge-identity-fallback.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distUrl = pathToFileURL(path.join(__dirname, "..", "dist", "git", "batch-merge.js")).href;
const { assembleBatchBranches } = await import(distUrl);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const git = (cwd, args) => execFileSync("git", args, { cwd }).toString().trim();

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const tmpDirs = [];
let counter = 0;

function makeRepo(prefix) {
  const repo = path.join(os.tmpdir(), `loom-bmif-${prefix}-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  execSync("git init -q", { cwd: repo });
  return repo;
}

/** Cuts a fresh worker branch off `repo`'s current HEAD and lands ONE commit on it, under a FIXED,
 *  always-resolvable scoped identity — this represents "the worker's own authored identity," which
 *  `landBranchCommitsIndividually` preserves explicitly via `--author` regardless of the HOST identity
 *  scenario under test, so it must stay constant across every scenario below. */
function cutWorkerBranch(repo, branch, file, content) {
  const wt = path.join(os.tmpdir(), `loom-bmif-wt-${branch.replace(/\//g, "-")}-${sfx}`);
  tmpDirs.push(wt);
  execFileSync("git", ["worktree", "add", "-q", "-b", branch, wt, "HEAD"], { cwd: repo });
  fs.writeFileSync(path.join(wt, file), content);
  execFileSync("git", ["add", "."], { cwd: wt });
  execFileSync("git", ["-c", "user.email=worker@loom", "-c", "user.name=worker", "commit", "-q", "-m", `${branch} work`], { cwd: wt });
  return wt;
}

/** A throwaway batch worktree cut at `repo`'s current HEAD — what `assembleBatchBranches` cherry-picks
 *  each candidate's commits ONTO (mirrors a real `merge_batch`'s own scratch worktree). */
function makeBatchWorktree(repo) {
  counter += 1;
  const wt = path.join(os.tmpdir(), `loom-bmif-batch-${sfx}-${counter}`);
  tmpDirs.push(wt);
  execFileSync("git", ["worktree", "add", "-q", "-b", `loom/bmif-batch-${sfx}-${counter}`, wt, "HEAD"], { cwd: repo });
  return wt;
}

function lastCommitAuthor(cwd) { return git(cwd, ["log", "-1", "--format=%an <%ae>"]); }
function lastCommitCommitter(cwd) { return git(cwd, ["log", "-1", "--format=%cn <%ce>"]); }

async function runScenario(label, setupEnv, assertCommitter) {
  console.log(`\n— ${label} —`);
  const envKeys = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"];
  const savedEnv = {};
  for (const k of envKeys) savedEnv[k] = process.env[k];
  const isolatedHome = path.join(os.tmpdir(), `loom-bmif-home-${label.replace(/\W+/g, "")}-${sfx}`);
  fs.mkdirSync(isolatedHome, { recursive: true });
  tmpDirs.push(isolatedHome);
  const emptyGlobalConfig = path.join(isolatedHome, "empty-gitconfig");
  fs.writeFileSync(emptyGlobalConfig, "");
  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;
  process.env.XDG_CONFIG_HOME = isolatedHome;
  process.env.GIT_CONFIG_GLOBAL = emptyGlobalConfig;
  process.env.GIT_CONFIG_SYSTEM = emptyGlobalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) delete process.env[k];

  try {
    // Build the repo + worker branch + batch worktree BEFORE applying the scenario's own env — a
    // role-scoped GIT_AUTHOR_*/GIT_COMMITTER_* env (scenario D) outranks a scoped `-c user.name=`/`-c
    // user.email=` override, so cutting the worker branch under that env would stamp the SCENARIO's
    // identity onto the worker's own commit instead of the fixed "worker" identity every scenario here
    // is meant to hold constant. Only the SUBSEQUENT `assembleBatchBranches` call (the thing actually
    // under test) runs under the scenario's env.
    const repo = makeRepo(label.replace(/\W+/g, "").slice(0, 8));
    const ID_ARGS = ["-c", "user.email=setup@loom", "-c", "user.name=setup"]; // scoped: persists nothing
    fs.writeFileSync(path.join(repo, "README.md"), "# repo\n");
    execFileSync("git", ["add", "."], { cwd: repo });
    execFileSync("git", [...ID_ARGS, "commit", "-q", "-m", "init", "--allow-empty"], { cwd: repo });

    const branch = `loom/bmif-${label.replace(/\W+/g, "")}-${sfx}`;
    cutWorkerBranch(repo, branch, "feature.txt", `content-${sfx}\n`);
    const batchWt = makeBatchWorktree(repo);

    setupEnv();
    const candidate = { workerSessionId: "bmif-wkr", taskId: "bmif-task", branch, taskTitle: "feat(test): bmif" };
    const { landed, dropped } = await assembleBatchBranches(repo, batchWt, [candidate]);

    check(`${label}: exactly one candidate landed (dropped: ${JSON.stringify(dropped)})`, landed.length === 1 && dropped.length === 0);
    if (landed.length === 1) {
      const author = lastCommitAuthor(batchWt);
      check(`${label}: the landed commit's AUTHOR is always the worker's own identity, regardless of host identity (got "${author}")`, author === "worker <worker@loom>");
      const committer = lastCommitCommitter(batchWt);
      assertCommitter(committer);
    }
  } finally {
    for (const k of envKeys) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }
}

// ── (A) NO identity configured anywhere — committer must land under the Loom fallback. ───────────────────
await runScenario(
  "(A) host has NO git identity configured anywhere",
  () => {},
  (committer) => check(`(A) the landed commit's COMMITTER is the Loom fallback identity (got "${committer}")`, committer === "Loom <loom@localhost>"),
);

// ── (B) CONTROL: host HAS a configured global identity — committer must land under THAT identity. ────────
await runScenario(
  "(B) CONTROL: host HAS a configured git identity",
  () => {
    execFileSync("git", ["config", "--global", "user.email", "configured-b@loom"]);
    execFileSync("git", ["config", "--global", "user.name", "configured-b"]);
  },
  (committer) => check(`(B) the landed commit's COMMITTER is the CONFIGURED identity, not the fallback (got "${committer}")`, committer === "configured-b <configured-b@loom>"),
);

// ── (C) name in config, email ONLY via the EMAIL env var — must be kept, not overridden. ──────────────────
await runScenario(
  "(C) name in config, email ONLY via EMAIL env",
  () => {
    execFileSync("git", ["config", "--global", "user.name", "configured-c"]);
    process.env.EMAIL = "env-c@loom";
  },
  (committer) => check(`(C) the landed commit's COMMITTER keeps the configured name + EMAIL-env address, NOT the fallback (got "${committer}")`, committer === "configured-c <env-c@loom>"),
);

// ── (D) identity resolvable ONLY via GIT_COMMITTER_* env — REGRESSION PIN, not fix evidence (CR 4eb77ad0
// round 2): passes on BOTH the pre-fix and post-fix probe (role-scoped env outranks `-c user.*`
// regardless), so it was never capable of discriminating the bug; (C) above is the real proof. ─────────
await runScenario(
  "(D) identity resolvable ONLY via GIT_AUTHOR_COMMITTER env",
  () => {
    process.env.GIT_AUTHOR_NAME = "env-author-d";
    process.env.GIT_AUTHOR_EMAIL = "env-author-d@loom";
    process.env.GIT_COMMITTER_NAME = "env-committer-d";
    process.env.GIT_COMMITTER_EMAIL = "env-committer-d@loom";
  },
  (committer) => check(`(D) the landed commit's COMMITTER is the GIT_COMMITTER_* env identity, NOT the fallback (got "${committer}")`, committer === "env-committer-d <env-committer-d@loom>"),
);

console.log(failures === 0
  ? "\n✅ ALL PASS — the batch cherry-pick commit's COMMITTER lands under a generic fallback identity when the host has none configured, and under the host's own resolvable identity (config, config+EMAIL env, or env-only), unchanged, when it does. AUTHOR is always preserved from the worker's own commit."
  : `\n❌ ${failures} FAILURE(S).`);

for (const d of tmpDirs) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
}

process.exit(failures === 0 ? 0 : 1);
