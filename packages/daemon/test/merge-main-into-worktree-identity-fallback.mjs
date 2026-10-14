import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 2267e8fa (CR 4eb77ad0 round 2) — `mergeMainIntoWorktree`'s own `git merge --no-edit` identity
// fallback was one of the sites named in the original card, but had NO discriminating test: the existing
// coverage (union-merge-kill-confirm.mjs, union-merge-transient-classification.mjs) mocks `git config` to
// simulate "no identity" without ever asserting the landed merge commit's actual author/committer.
//
// ONE discriminating case, mirroring merge-solo-squash-identity-fallback.mjs's own (C): name in GLOBAL
// config, email ONLY via the EMAIL env var. The OLD probe (`hasConfiguredGitIdentity`, a bare `git
// config user.name`/`user.email` read) saw no email IN CONFIG and wrongly fell back, silently overriding
// the configured NAME too. This is the ONE case that discriminates — "none configured" and "fully
// configured" both resolve identically on the old AND new probe, so neither would catch this bug (see
// merge-solo-squash-identity-fallback.mjs's own header for the same reasoning, confirmed here too via
// negative-control).
//
// A real merge commit (unlike a cherry-pick) has NO `--author` override, so BOTH author and committer
// are the identity this fix resolves — asserting both is asserting the SAME thing twice here, by design
// (the merge path has no author/committer split the way batch's cherry-pick does), not a weaker check.
//
// RED/GREEN proof: `pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/bounded.ts
// --file packages/daemon/src/git/worktrees.ts --file packages/daemon/src/git/batch-merge.ts
// --file packages/daemon/src/vault/versioner.ts --test packages/daemon/test/merge-main-into-worktree-identity-fallback.mjs
// --ref 43a65f27` — RED on that pre-fix sha, GREEN with this fix.
//
// Run: 1) build daemon (pnpm build), 2) node test/merge-main-into-worktree-identity-fallback.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distUrl = pathToFileURL(path.join(__dirname, "..", "dist", "git", "worktrees.js")).href;
const { mergeMainIntoWorktree } = await import(distUrl);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const git = (cwd, args) => execFileSync("git", args, { cwd }).toString().trim();

const sfx = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const tmpDirs = [];

function lastCommitAuthor(cwd) { return git(cwd, ["log", "-1", "--format=%an <%ae>"]); }
function lastCommitCommitter(cwd) { return git(cwd, ["log", "-1", "--format=%cn <%ce>"]); }

console.log("\n— (C) name in config, email ONLY via EMAIL env — must be kept, not overridden —");

const isolatedHome = path.join(os.tmpdir(), `loom-mmiw-home-${sfx}`);
fs.mkdirSync(isolatedHome, { recursive: true });
tmpDirs.push(isolatedHome);
const nameOnlyGlobalConfig = path.join(isolatedHome, "name-only-gitconfig");
fs.writeFileSync(nameOnlyGlobalConfig, "");
const savedEnv = {};
for (const k of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) {
  savedEnv[k] = process.env[k];
}
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.env.XDG_CONFIG_HOME = isolatedHome;
process.env.GIT_CONFIG_GLOBAL = nameOnlyGlobalConfig;
process.env.GIT_CONFIG_SYSTEM = path.join(isolatedHome, "nonexistent-system-gitconfig");
process.env.GIT_CONFIG_NOSYSTEM = "1";
delete process.env.GIT_AUTHOR_NAME;
delete process.env.GIT_AUTHOR_EMAIL;
delete process.env.GIT_COMMITTER_NAME;
delete process.env.GIT_COMMITTER_EMAIL;

try {
  // The GLOBAL config (isolated above) carries ONLY user.name — email resolves via the EMAIL env var set
  // right before the merge call, never in config.
  execFileSync("git", ["config", "--global", "user.name", "configured-mmiw"]);

  const repo = path.join(os.tmpdir(), `loom-mmiw-repo-${sfx}`);
  fs.mkdirSync(repo, { recursive: true });
  tmpDirs.push(repo);
  const ID_ARGS = ["-c", "user.email=setup-mmiw@loom", "-c", "user.name=setup-mmiw"]; // scoped: persists nothing
  execSync("git init -q", { cwd: repo });
  fs.writeFileSync(path.join(repo, "README.md"), "# mmiw\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", [...ID_ARGS, "commit", "-q", "-m", "init"], { cwd: repo });

  // Cut the worktree's branch off main's initial commit, give it its OWN commit — independent of main's
  // later advance below, so `mergeMainIntoWorktree`'s own "already caught up?" short-circuit never fires
  // (it must actually attempt and land a real merge for this test to exercise the identity fallback).
  const wt = path.join(os.tmpdir(), `loom-mmiw-wt-${sfx}`);
  tmpDirs.push(wt);
  execFileSync("git", ["worktree", "add", "-q", "-b", "loom/mmiw-branch", wt, "HEAD"], { cwd: repo });
  fs.writeFileSync(path.join(wt, "branch-file.txt"), "branch work\n");
  execFileSync("git", ["add", "."], { cwd: wt });
  execFileSync("git", [...ID_ARGS, "commit", "-q", "-m", "branch work"], { cwd: wt });

  // Advance main independently so there is a genuine tip for the worktree to merge.
  fs.writeFileSync(path.join(repo, "main-file.txt"), "main advance\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", [...ID_ARGS, "commit", "-q", "-m", "main advance"], { cwd: repo });

  process.env.EMAIL = "env-mmiw@loom";

  const res = await mergeMainIntoWorktree(repo, wt);

  check(`(C) mergeMainIntoWorktree succeeds (reason: ${res.ok ? "n/a" : res.reason})`, res.ok === true);
  check("(C) a real merge actually happened (merged:true)", res.ok === true && res.merged === true);
  if (res.ok) {
    const author = lastCommitAuthor(wt);
    check(`(C) the landed merge commit's AUTHOR keeps the configured name + EMAIL-env address, NOT the fallback (got "${author}")`, author === "configured-mmiw <env-mmiw@loom>");
    const committer = lastCommitCommitter(wt);
    check(`(C) the landed merge commit's COMMITTER keeps the configured name + EMAIL-env address, NOT the fallback (got "${committer}")`, committer === "configured-mmiw <env-mmiw@loom>");
  }
} finally {
  for (const k of Object.keys(savedEnv)) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — mergeMainIntoWorktree's union-merge commit keeps a partially-configured (name in config, email via EMAIL env) identity, never silently overridden by the generic Loom fallback."
  : `\n❌ ${failures} FAILURE(S).`);

for (const d of tmpDirs) {
  try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best-effort */ }
}

process.exit(failures === 0 ? 0 : 1);
