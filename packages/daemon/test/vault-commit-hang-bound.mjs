import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 54b839c5 — `commitVault` (versioner.ts), THE single vault commit path shared by the auto-committer
// and human UI writes (vault/writer.ts), built a plain `simpleGit(vaultPath)` with NO block timeout and
// NO `GIT_TERMINAL_PROMPT=0`, then ran `add`/`status`/`commit` through the user's own pre-commit hook with
// nothing bounding any of it — the exact hang vector card 816f0056 hardened on `flushSync`'s SHUTDOWN
// path, left open here on the path a human's HTTP request (vault/writer.ts) actually blocks on.
//
// @decision ffe98495 update (review round 2): this file originally forced the hang via a REAL git
// exec-config trick (first a `.git/hooks/pre-commit` hook, then a hanging `gpg.program`) — but card
// ffe98495 round 2 ALSO forces `-c commit.gpgsign=false` unconditionally, closing that mechanism too, on
// top of the hooksPath/fsmonitor neutralisation that already closed the first one. With every git
// exec-config surface this module can reach now neutralised BY DESIGN, this file switches to the
// project's own established seam for exactly this situation (see test/vault-versioner-wiring.mjs's
// `hangingFactory`): a `VaultGitDeps.gitFactory` that delegates every call to a REAL `simple-git` instance
// against the real repo EXCEPT the one under test, which returns a promise that never resolves. This
// still exercises the REAL, production `withTimeout` race and the real repo's own `checkIsRepo`/`add`/
// `status` behaviour — only the one call being tested for hang-tolerance is a mock, not the whole git
// interaction.
// Run after build: node test/vault-commit-hang-bound.mjs
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { simpleGit } from "simple-git";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const { commitVault } = await import("../dist/vault/versioner.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const git = (cwd, args) => execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init");
  git(dir, "config user.email vault-commit-hang@example.com");
  git(dir, "config user.name vault-commit-hang-test");
}
// `git rev-list --all --count` is 0 (clean exit) on a fresh repo with no commits yet — unlike `git log`.
const commitCount = (dir) => parseInt(git(dir, "rev-list --all --count").trim() || "0", 10);

// The injected per-op timeout (VaultGitDeps.timeoutMs, threaded through commitVault's `opts.deps` — the
// SAME test-only injection seam every other bounded git call in this module already accepts). Collapses
// BOTH commitVault tiers (cheap plumbing + working-tree) onto this one small value (see commitVault's own
// doc for why real callers never do this).
const TINY_TIMEOUT_MS = 2_000;

/**
 * A `VaultGitDeps.gitFactory` that delegates `checkIsRepo`/`revparse`/`init`/`add`/`status`/`commit` to a
 * REAL `simple-git` instance against `repo` (so the surrounding repo state behaves exactly as production
 * would), except: any `raw()` call whose argv contains `"commit"` returns a promise that NEVER resolves —
 * simulating a genuinely wedged commit without touching any git hook/gpg-program/exec-config surface
 * (@decision ffe98495 review finding 2). `commitVault` calls this factory THREE times per invocation
 * (once for its unpinned discovery instance, twice more for its two repo-pinned tiers) — `fired()` reports
 * true the moment ANY of them reaches the wedged call, distinguishing "we genuinely reached commit" from
 * "an earlier call (e.g. `add`) timed out first" — the same distinction the old hook-based marker proved.
 */
function makeHangingCommitGitFactory(repo) {
  let firedFlag = false;
  const factory = (repoPath) => {
    const real = simpleGit(repoPath);
    return {
      checkIsRepo: () => real.checkIsRepo(),
      revparse: (args) => real.revparse(args),
      init: () => real.init(),
      add: (paths) => real.add(paths),
      status: () => real.status(),
      commit: (msg) => real.commit(msg),
      raw: (args) => {
        const arr = Array.isArray(args) ? args : [args];
        if (arr.includes("commit")) {
          firedFlag = true;
          return new Promise(() => {}); // never resolves — a wedged commit, no real exec-config trick
        }
        return real.raw(arr);
      },
    };
  };
  factory.fired = () => firedFlag;
  factory.repo = repo;
  return factory;
}

{
  // --- Case A: a wedged `git commit` must not block commitVault past its bounded timeout, must REJECT
  // (never a false success), must not leave a partial commit behind (checked immediately), and must be
  // proven to have actually reached the commit step, not merely that some earlier call timed out first.
  const repoA = mkdtempManaged("loom-commit-hang-a-");
  initRepo(repoA);
  fs.writeFileSync(path.join(repoA, "urgent.md"), "edited just before a wedged REST commit\n");
  const beforeA = commitCount(repoA);
  const hangingFactory = makeHangingCommitGitFactory(repoA);

  const t0 = performance.now(); // MONOTONIC — survives an NTP/backward clock step (see test/worktrees.mjs)
  let resultA;
  let threwA;
  try {
    resultA = await commitVault(repoA, "loom: write urgent.md (via UI)", {
      deps: { gitFactory: hangingFactory, timeoutMs: TINY_TIMEOUT_MS },
    });
  } catch (err) {
    threwA = err;
  }
  const elapsedA = performance.now() - t0;

  check(
    `commitVault against a wedged commit returns within its bounded timeout ` +
    `(${Math.round(elapsedA)}ms, cap ${TINY_TIMEOUT_MS}ms)`,
    elapsedA < TINY_TIMEOUT_MS * 3,
  );
  check("commitVault against a wedged commit REJECTS (bounded, never hangs, never a false success)", threwA !== undefined && resultA === undefined);
  check("the rejection names a bound timeout (not some unrelated git error)", String(threwA?.message ?? "").includes("exceeded"));
  check("commitVault against a wedged commit leaves no partial commit behind YET (checked immediately)", commitCount(repoA) === beforeA);
  check("the wedged commit call genuinely fired (the hang is the REAL commit step, not an earlier call timing out first)", hangingFactory.fired());

  // --- Case B (control, on the SAME tiny timeout): an ordinary, un-hung commit still succeeds under the
  // exact same tiny injected timeout — proves the bound doesn't itself break the normal commit path (the
  // distinct failure mode a too-tight timeout would cause, which the card explicitly warns against: a
  // bound that's wrong in THIS direction drops a real user edit).
  const repoB = mkdtempManaged("loom-commit-hang-b-");
  initRepo(repoB);
  fs.writeFileSync(path.join(repoB, "urgent.md"), "edited just before an ORDINARY REST commit\n");
  const resultB = await commitVault(repoB, "loom: write urgent.md (via UI)", { deps: { timeoutMs: TINY_TIMEOUT_MS } });
  check(
    "commitVault under the SAME tiny timeout still commits a normal (un-hung) write",
    resultB.committed === true && commitCount(repoB) === 1,
  );

  console.log(failures === 0
    ? "\nALL PASS — commitVault's git calls are bounded, a wedged commit is rejected without " +
      "wedging the caller, and an ordinary commit still succeeds under the same bound."
    : `\n${failures} FAILURE(S).`);
  // repoA/repoB were both created via mkdtempManaged, which already registers them for guaranteed cleanup
  // at process exit (card 995be21f) — nothing else to release here.
}

await finishAndExit(failures === 0 ? 0 : 1);
