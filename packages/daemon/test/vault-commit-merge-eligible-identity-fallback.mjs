import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 7b59e981 (CR ff3eec9f) — mutation-detecting test gap: `commitVault`'s MERGE-ELIGIBLE branch
// (vault/versioner.ts, the `killableCanonicalRaw` call around line 1195) merges `identityEnv` into its
// `env` param — but nothing in this repo's existing coverage exercises that branch with a NON-EMPTY
// identityEnv. `vault-write-tool.mjs`'s (f1)/(f2)/(f3) and `vault-commit-merge-eligible-kill-confirm.mjs`
// either go through the ORDINARY (non-merge-eligible) branch or never need the fallback at all, so
// stripping `...identityEnv` from the merge-eligible branch's env merge would go completely undetected.
// This file forces BOTH roles to need the fallback, on a REAL merge-eligible vault (same shape
// `vault-commit-merge-eligible-kill-confirm.mjs` already uses: a vaultOnly project whose own
// repoPath === vaultPath), so a dropped merge is the only way this can pass.
//
// Run after build: node test/vault-commit-merge-eligible-identity-fallback.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit, useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-vcmeif-home-");
requireHermeticEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distVaultDir = path.join(__dirname, "..", "dist", "vault");
const { commitVault, setCodeRepoGuardProvider } = await import(pathToFileURL(path.join(distVaultDir, "versioner.js")).href);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const git = (cwd, args) => execFileSync("git", args, { cwd, encoding: "utf8" });
const lastCommitAuthor = (cwd) => git(cwd, ["log", "-1", "--format=%an <%ae>"]).trim();
const lastCommitCommitter = (cwd) => git(cwd, ["log", "-1", "--format=%cn <%ce>"]).trim();

const root = fs.realpathSync(mkdtempManaged("loom-vcmeif-"));

// Same merge-eligible shape vault-commit-merge-eligible-kill-confirm.mjs already uses: a vaultOnly
// project whose own repoPath === vaultPath, so isCommitPathMergeEligible(vaultPath) is true while
// checkCodeRepoCollision exempts it (the vaultOnly-per-candidate exemption).
function makeMergeEligibleVaultRepo(tag, setupIdArgv) {
  const repo = path.join(root, `repo-${tag}`);
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ["init", "-q"]);
  git(repo, [...setupIdArgv, "commit", "-q", "--allow-empty", "-m", "init"]);
  setCodeRepoGuardProvider({
    snapshot: () => [{ id: `p-vcmeif-${tag}`, repoPath: repo, repos: [], vaultOnly: true, vaultPath: repo }],
    recordEvent: () => {},
  });
  return repo;
}

console.log("\n— merge-eligible vault commit: NO identity anywhere — must land under the Loom fallback —");
{
  const isolatedHome = mkdtempManaged("loom-vcmeif-ghome-");
  const emptyGlobalConfig = path.join(isolatedHome, "empty-gitconfig");
  fs.writeFileSync(emptyGlobalConfig, "");
  const savedEnv = {};
  for (const k of ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) {
    savedEnv[k] = process.env[k];
  }
  // Setup (repo init) uses a scoped `-c` ID, set BEFORE the host is isolated below, so the isolation never
  // interferes with it — mirrors merge-solo-squash-identity-fallback.mjs's own scenario (A)/(E) ordering.
  const setupIdArgv = ["-c", "user.email=vcmeif-setup@loom", "-c", "user.name=vcmeif-setup"];
  const repo = makeMergeEligibleVaultRepo("noident", setupIdArgv);

  process.env.HOME = isolatedHome;
  process.env.USERPROFILE = isolatedHome;
  process.env.XDG_CONFIG_HOME = isolatedHome;
  process.env.GIT_CONFIG_GLOBAL = emptyGlobalConfig;
  process.env.GIT_CONFIG_SYSTEM = emptyGlobalConfig;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  for (const k of ["GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL", "EMAIL"]) delete process.env[k];

  try {
    fs.writeFileSync(path.join(repo, "note.md"), "# real content, no identity anywhere\n");
    const before = parseInt(git(repo, ["rev-list", "--all", "--count"]).trim() || "0", 10);
    const result = await commitVault(repo, "loom: auto-commit (merge-eligible, no identity anywhere)");
    check("a merge-eligible commitVault still commits despite no configured identity anywhere", result.committed === true);
    check("...and a new commit actually landed", parseInt(git(repo, ["rev-list", "--all", "--count"]).trim() || "0", 10) === before + 1);
    if (result.committed) {
      const author = lastCommitAuthor(repo);
      check(`[FIX TARGET] ...the landed commit's AUTHOR is the Loom fallback identity (got "${author}")`, author === "Loom <loom@localhost>");
      const committer = lastCommitCommitter(repo);
      check(`[FIX TARGET] ...the landed commit's COMMITTER is the Loom fallback identity (got "${committer}")`, committer === "Loom <loom@localhost>");
    }
  } finally {
    for (const k of Object.keys(savedEnv)) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
  }
}

setCodeRepoGuardProvider(undefined);
await finishAndExit(failures === 0 ? 0 : 1);
