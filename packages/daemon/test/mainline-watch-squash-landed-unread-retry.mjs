import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 027bad41 — UNIT-level coverage of mergeBranchLocked's one bounded retry of the post-commit
// confirmatory `rev-parse HEAD` read (git/worktrees.ts ~L11200), isolated from the service layer (calls
// mergeBranch directly, same pattern as mainline-watch-own-commit-verify.mjs's own (UNIT) blocks).
// (UNIT-RECOVER): a one-shot read failure recovers on retry, verified exactly like a first-attempt
// success. (UNIT-FORGE): a racer landing specifically in the retry window is rejected, never ledgered.
// (UNIT-EXHAUSTED): every attempt failing still falls through to squashLandedUnread, unchanged. Full
// analysis: docs/decisions/027bad41-retry-the-post-commit-head-read-before-refusing-a-landed-squash.md
//
// Run: 1) pnpm build, 2) node packages/daemon/test/mainline-watch-squash-landed-unread-retry.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commitAll } from "./_git-commit.mjs";
import { registerForCleanup, useOwnLoomHome, mkdtempManaged } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";

useOwnLoomHome("loom-mwslur-home-");
requireHermeticEnv();

const { mergeBranch } = await import("../dist/git/worktrees.js");
const { CanonicalGitRefusal, WithTimeoutExpiry } = await import("../dist/git/bounded.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const IDENT = { GIT_AUTHOR_NAME: "mwslur", GIT_AUTHOR_EMAIL: "mwslur@loom", GIT_COMMITTER_NAME: "mwslur", GIT_COMMITTER_EMAIL: "mwslur@loom" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...IDENT }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const GIT_ID = "-c user.email=mwslur@loom -c user.name=mwslur";

function makeRepo(sfx) {
  const repo = mkdtempManaged(`loom-mwslur-repo-${sfx}-`);
  fs.writeFileSync(path.join(repo, "README.md"), "# mwslur\n");
  git(repo, "init", "-q", "-b", "main"); git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "user.email", "mwslur@loom"); git(repo, "config", "user.name", "mwslur");
  commitAll(repo, "init", GIT_ID);
  return repo;
}

function makeBranchWorktree(repo, name, fileContent) {
  const branch = `loom/${name}`;
  git(repo, "branch", branch);
  const worktree = mkdtempManaged(`loom-mwslur-wt-${name}-`);
  git(repo, "worktree", "add", "-q", worktree, branch);
  registerForCleanup(worktree);
  fs.writeFileSync(path.join(worktree, `${name}.ts`), fileContent);
  commitAll(worktree, `feat(x): ${name}`, GIT_ID);
  return branch;
}

// NARROWEST NATIVE SEAM, same shape as merge-confirm-squash-landed-unread.mjs's own
// `postCommitReadFailFactory`: the real `git commit -F <file>` always lands; only the `rev-parse HEAD`
// read(s) that follow it are faulted, up to `failCount` times, before falling through to real git.
// `errorFactory(attemptNumber)` picks the thrown error's TYPE (default: a plain Error) — used to prove
// the retry's own classification (a CanonicalGitRefusal/WithTimeoutExpiry must never be retried). `stats`
// (optional, `{attempts: 0}`), when passed, is mutated to count every post-commit `rev-parse HEAD` CALL
// actually made (fail or not) — the only direct way to prove "only one attempt happened" for those two
// non-retried classes, since the function's own return value can't distinguish "never retried" from
// "retried once and got the same answer".
function readFailFactory({ failCount, onEachFail, errorFactory, stats } = {}) {
  let commitSucceeded = false;
  let failsSoFar = 0;
  return (repoPath, blockTimeoutMs) => ({
    raw: async (args) => {
      const { boundedSimpleGit } = await import("../dist/git/bounded.js");
      const { nonInteractiveEnv } = await import("../dist/git/writer.js");
      const real = boundedSimpleGit(repoPath, blockTimeoutMs, nonInteractiveEnv());
      if (Array.isArray(args) && args[0] === "commit" && args[1] === "-F") {
        const out = await real.raw(args);
        commitSucceeded = true;
        return out;
      }
      if (commitSucceeded && Array.isArray(args) && args[0] === "rev-parse" && args[args.length - 1] === "HEAD") {
        if (stats) stats.attempts++;
        if (failsSoFar < failCount) {
          failsSoFar++;
          onEachFail?.(repoPath);
          throw errorFactory ? errorFactory(failsSoFar) : new Error(`simulated post-commit HEAD read failure (attempt ${failsSoFar})`);
        }
      }
      return real.raw(args);
    },
  });
}

// Same-parent, different-tree racer — the identical construction mainline-watch-own-commit-verify.mjs's
// own installForgingPostCommitHook uses (a hook there, fired by `git commit` itself; a direct synchronous
// call here, since this needs to fire specifically BETWEEN the two confirmatory reads, not during the
// commit). Plumbing-only (write-tree/commit-tree/update-ref) — never disturbs the retry's own plain
// `rev-parse HEAD` read.
function forgeSiblingOntoMain(repo) {
  const current = git(repo, "rev-parse", "HEAD");
  const parent = git(repo, "rev-parse", `${current}^1`);
  fs.writeFileSync(path.join(repo, "EVIL.txt"), "evil\n");
  git(repo, "add", "EVIL.txt");
  const tree = git(repo, "write-tree");
  const forged = git(repo, "commit-tree", tree, "-p", parent, "-m", "feat(x): innocuous", "-m", "Loom-Worker-Branch: loom/deadbeef0000");
  git(repo, "update-ref", "-m", "commit: x", "refs/heads/main", forged);
  git(repo, "reset", "--hard");
  return forged;
}

// ===================== (UNIT-RECOVER) a ONE-SHOT confirmatory-read failure recovers via retry ==========
{
  const repo = makeRepo("recover");
  const branch = makeBranchWorktree(repo, "recover", "export const recover = 1;\n");
  const preCommitHead = git(repo, "rev-parse", "HEAD");
  const result = await mergeBranch(repo, branch, "feat(x): unit recover", { gitFactory: readFailFactory({ failCount: 1 }) });
  const landedSha = git(repo, "rev-parse", "HEAD");
  check("(UNIT-RECOVER) a one-shot read failure is recovered: ok:true (never squashLandedUnread)", result.ok === true && result.squashLandedUnread !== true);
  check("(UNIT-RECOVER) the real landed sha is reported", result.sha === landedSha);
  check("(UNIT-RECOVER) landedBase equals the real pre-commit HEAD — verified as OUR OWN commit", result.landedBase === preCommitHead);
  check("(UNIT-RECOVER) landedVerify is \"verified\"", result.landedVerify === "verified");
}

// ===================== (UNIT-FORGE) a racer lands IN the retry window — rejected, never ledgered ========
{
  const repo = makeRepo("forge");
  const branch = makeBranchWorktree(repo, "forge", "export const forge = 1;\n");
  const preCommitHead = git(repo, "rev-parse", "HEAD");
  let forgedSha;
  const result = await mergeBranch(repo, branch, "feat(x): unit forge", {
    gitFactory: readFailFactory({ failCount: 1, onEachFail: (repoPath) => { forgedSha = forgeSiblingOntoMain(repoPath); } }),
  });
  check("(UNIT-FORGE) setup: the racer genuinely replaced refs/heads/main", git(repo, "rev-parse", "HEAD") === forgedSha);
  check("(UNIT-FORGE) setup: the racer shares the real commit's own parent (a bare parent check alone would pass)", git(repo, "rev-parse", `${forgedSha}^1`) === preCommitHead);
  check("(UNIT-FORGE) the retry picks up the racer's sha, not the real commit's", result.sha === forgedSha);
  check("(UNIT-FORGE) mergeBranch still reports ok:true (the landing itself happened; 4fa36502's own Do-not)", result.ok === true);
  check("(UNIT-FORGE) landedBase IS a present key (the fix's own field, never absent)", Object.hasOwn(result, "landedBase"));
  check("(UNIT-FORGE) landedBase is undefined — the racer is NEVER trusted as our own commit", result.landedBase === undefined);
  check("(UNIT-FORGE) landedVerify is \"rejected\" (checked, and it failed) — never \"uncaptured\"", result.landedVerify === "rejected");
}

// ===================== (UNIT-EXHAUSTED) every confirmatory-read attempt fails — unchanged refusal =======
{
  const repo = makeRepo("exhausted");
  const branch = makeBranchWorktree(repo, "exhausted", "export const exhausted = 1;\n");
  const result = await mergeBranch(repo, branch, "feat(x): unit exhausted", { gitFactory: readFailFactory({ failCount: 2 }) });
  check("(UNIT-EXHAUSTED) both attempts fail: ok:false, squashLandedUnread:true — unchanged from before this card", result.ok === false && result.squashLandedUnread === true);
  check("(UNIT-EXHAUSTED) the commit genuinely landed regardless (the read, not the commit, failed)", git(repo, "log", "-1", "--format=%s") === "feat(x): unit exhausted");
}

// ===================== (UNIT-REFUSAL-NOT-RETRIED) a CanonicalGitRefusal on attempt 1 is NEVER retried ===
{
  const repo = makeRepo("refusal");
  const branch = makeBranchWorktree(repo, "refusal", "export const refusal = 1;\n");
  const stats = { attempts: 0 };
  const result = await mergeBranch(repo, branch, "feat(x): unit refusal", {
    gitFactory: readFailFactory({ failCount: 1, stats, errorFactory: () => new CanonicalGitRefusal("simulated canonical-git refusal") }),
  });
  check("(UNIT-REFUSAL-NOT-RETRIED) exactly ONE read attempt was made — never retried", stats.attempts === 1);
  check("(UNIT-REFUSAL-NOT-RETRIED) surfaces exactly as a single un-retried attempt always has: squashLandedUnread, never ok:true", result.ok === false && result.squashLandedUnread === true);
  check("(UNIT-REFUSAL-NOT-RETRIED) the real commit still landed (only the read, never the commit, was faulted)", git(repo, "log", "-1", "--format=%s") === "feat(x): unit refusal");
}

// ===================== (UNIT-TIMEOUT-NOT-RETRIED) a WithTimeoutExpiry on attempt 1 is NEVER retried =====
{
  const repo = makeRepo("timeout");
  const branch = makeBranchWorktree(repo, "timeout", "export const timeout = 1;\n");
  const stats = { attempts: 0 };
  const result = await mergeBranch(repo, branch, "feat(x): unit timeout", {
    gitFactory: readFailFactory({ failCount: 1, stats, errorFactory: () => new WithTimeoutExpiry("simulated withTimeout expiry") }),
  });
  check("(UNIT-TIMEOUT-NOT-RETRIED) exactly ONE read attempt was made — never retried (a retry would double the lock hold on a still-hung child)", stats.attempts === 1);
  check("(UNIT-TIMEOUT-NOT-RETRIED) surfaces exactly as a single un-retried attempt always has: squashLandedUnread, never ok:true", result.ok === false && result.squashLandedUnread === true);
  check("(UNIT-TIMEOUT-NOT-RETRIED) the real commit still landed (only the read, never the commit, was faulted)", git(repo, "log", "-1", "--format=%s") === "feat(x): unit timeout");
}

// ===================== (UNIT-RETRY-LOGS-ATTEMPT-1) a recovered retry logs the first failure ============
{
  const repo = makeRepo("logs");
  const branch = makeBranchWorktree(repo, "logs", "export const logsCase = 1;\n");
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(" ")); origWarn.apply(console, args); };
  let result;
  try {
    result = await mergeBranch(repo, branch, "feat(x): unit logs", { gitFactory: readFailFactory({ failCount: 1 }) });
  } finally {
    console.warn = origWarn;
  }
  check("(UNIT-RETRY-LOGS-ATTEMPT-1) the one-shot failure still recovers (sanity, same as UNIT-RECOVER)", result.ok === true && result.squashLandedUnread !== true);
  check("(UNIT-RETRY-LOGS-ATTEMPT-1) attempt 1's own failure is logged before the retry succeeds", warnings.some((w) => /post-commit HEAD read failed \(attempt 1\/2\)/.test(w) && /simulated post-commit HEAD read failure \(attempt 1\)/.test(w)));
  check("(UNIT-RETRY-LOGS-ATTEMPT-1) exactly ONE such log line (never one per attempt)", warnings.filter((w) => /post-commit HEAD read failed \(attempt 1\/2\)/.test(w)).length === 1);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — mergeBranchLocked's one bounded retry of the post-commit confirmatory HEAD read recovers a transient failure (landedBase/landedVerify exactly as a first-attempt success), logging attempt 1's own error; correctly rejects a racer that lands specifically in the retry window (never ledgered, never trusted); still falls through to the unchanged squashLandedUnread refusal once both attempts are exhausted; and never retries a CanonicalGitRefusal or a WithTimeoutExpiry, surfacing either exactly as a single un-retried attempt always has."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
