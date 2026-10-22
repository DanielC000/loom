import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a6f84660: `GitReader.log()`'s structural "does HEAD resolve" check (`git rev-parse --quiet
// --verify HEAD`) used to rely on `revparse()` REJECTING when it doesn't resolve — but simple-git's
// `.raw()`/`.revparse()` RESOLVE, with "" output, when git exits non-zero but writes nothing to stderr,
// and `--quiet --verify HEAD` on an unborn HEAD is exactly that shape (probe-verified, see project memory
// simple-git-raw-does-not-reject-on-exit-code-only-failure). That made `headResolves` never go false, so
// the structural check was dead code — a commitless repo was caught ONLY by the English message-match
// fallback `isCommitlessRepoLogError` (~reader.ts:165), which only survives at all because of this class's
// own LC_ALL=C/LANG=C locale pin (reader.ts's own doc comment on that fallback).
//
// (1) proves the PRIMARY (structural) path on its own, with the fallback forced to NEVER match: the
// injected fake `log()` throws a message matching NEITHER of isCommitlessRepoLogError's two regexes (a
// non-English-looking string) — so if `log()` is ever actually called, the fallback can't save it and the
// call rejects. Only a FIXED structural check (reading revparse's OUTPUT instead of trusting it to reject)
// can make `GitReader.log()` return [] here, and only by never calling the fake `log()` at all.
//   RED on current (unfixed) main: revparse() resolves (never throws) ⇒ `headResolves` stays `true` ⇒
//     the structural `if (!headResolves)` block is skipped ⇒ the fake `log()` IS called, throws the
//     non-matching message, `isCommitlessRepoLogError` returns false ⇒ the error propagates ⇒
//     `reader.log()` REJECTS instead of returning [].
//   GREEN after the fix: revparse()'s OUTPUT ("") is read ⇒ `headResolves` becomes `false` ⇒
//     `checkIsRepo()` resolves true ⇒ `GitReader.log()` returns [] WITHOUT ever calling the fake `log()`.
//
// (2)-(4) prove the real end-to-end shape through the actual git binary (no seam): a genuine `git
// init`'d, zero-commit repo returns []; a genuine non-repo path still throws; a repo with a real commit
// still returns it (no regression / no blanket-empty).
//
// HERMETIC + CLAUDE-FREE + NETWORK-FREE. No LOOM_HOME/DB/server needed — calls the compiled `GitReader`
// class directly, the same seam-injection pattern as git-writer-branchlocal-hang-bound.mjs.
//
// Run: 1) build (turbo builds shared first), 2) node test/git-log-unborn-head-quiet-resolve.mjs
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { GitReader } from "../dist/git/reader.js";
import { commitAll } from "./_git-commit.mjs";
import { mkdtempManaged } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// A fake ReaderGit whose revparse() mirrors the REAL simple-git shape being fixed: it RESOLVES with ""
// output on `--quiet --verify HEAD` against an unborn HEAD (never rejects) — and whose log() throws a
// message matching NEITHER of isCommitlessRepoLogError's regexes (/does not have any commits yet/i,
// /ambiguous argument ['"]?HEAD['"]?/i), so the English-message fallback can never catch it. Tracks
// whether log() was actually invoked, since the FIXED structural check must short-circuit before ever
// calling it.
function makeUnbornHeadFakeGit() {
  let logCalls = 0;
  const git = {
    checkIsRepo: async () => true,
    getConfig: async () => ({ value: undefined }),
    raw: async () => "",
    revparse: async (args) => {
      if (Array.isArray(args) && args.includes("--quiet") && args.includes("--verify") && args.includes("HEAD")) {
        return ""; // the real unborn-HEAD shape: resolves (does not throw), empty stdout
      }
      return "deadbeefcafe0000000000000000000000000000";
    },
    log: async () => { logCalls++; throw new Error("骛: 该代码库尚未有任何提交"); }, // non-English-looking — matches neither fallback regex
    branchLocal: async () => ({ current: "main", all: ["main"] }),
    show: async () => "",
  };
  return { git, get logCalls() { return logCalls; } };
}

// --- (1) SEAM: the primary structural path, proven in isolation with the fallback forced to miss. ---
{
  const fake = makeUnbornHeadFakeGit();
  const reader = new GitReader("/fake/repo/path/does/not/need/to/exist", {
    gitFactory: () => fake.git,
    timeoutMs: 5_000,
  });
  let result, threw = null;
  try { result = await reader.log(); } catch (e) { threw = e; }
  check("(1) GitReader.log() does NOT throw when the message-match fallback cannot catch it",
    threw === null);
  check("(1) GitReader.log() returns [] via the structural check alone" + (threw ? ` (threw: ${threw.message})` : ""),
    Array.isArray(result) && result.length === 0);
  check("(1) the fake log() was NEVER called — the structural check short-circuited before the fallback",
    fake.logCalls === 0);
}

// --- Real end-to-end fixtures: an actual git binary, no injected seam. mkdtempManaged (not a hand-rolled
// Date.now()/pid path) gives each a real, kernel-guaranteed-unique dir with guaranteed cleanup. ---
const unbornRepo = mkdtempManaged("loom-gitlog-unborn-");
execSync("git init -q", { cwd: unbornRepo });

const notARepo = mkdtempManaged("loom-gitlog-unborn-notarepo-");
fs.writeFileSync(path.join(notARepo, "file.txt"), "not a repo\n");

const committedRepo = mkdtempManaged("loom-gitlog-unborn-committed-");
fs.writeFileSync(path.join(committedRepo, "README.md"), "# committed\n");
execSync("git init -q", { cwd: committedRepo });
commitAll(committedRepo, "real commit", "-c user.email=r@loom -c user.name=r");

// --- (2) Real unborn-HEAD repo (zero commits, exactly what project_init leaves a fresh project in). ---
{
  const reader = new GitReader(unbornRepo);
  const log = await reader.log();
  check("(2) real git init (zero commits): GitReader.log() returns []",
    Array.isArray(log) && log.length === 0);
}

// --- (3) A genuine non-repo path still surfaces as an error, never silently emptied. ---
{
  const reader = new GitReader(notARepo);
  let threw = null;
  try { await reader.log(); } catch (e) { threw = e; }
  check("(3) a real non-repo path: GitReader.log() still throws (genuine failure, not swallowed)",
    threw !== null);
}

// --- (4) Control: a repo with a real commit is unaffected by the fix. ---
{
  const reader = new GitReader(committedRepo);
  const log = await reader.log();
  check("(4) real repo with a commit: GitReader.log() returns it",
    Array.isArray(log) && log.length === 1 && log[0].message === "real commit");
}

console.log(failures === 0
  ? "\n✅ ALL PASS — GitReader.log()'s structural unborn-HEAD check works on its own (fallback forced to " +
    "miss via a non-English-looking injected error, and the fake log() was proven never called), and the " +
    "real git-binary end-to-end shapes (unborn HEAD / genuine non-repo / a real commit) are all unaffected; " +
    "claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
