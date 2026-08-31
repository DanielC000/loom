import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 816f0056 — `VaultVersioner.flushSync()`'s three `execSync` git calls carried NO timeout and NO
// `GIT_TERMINAL_PROMPT=0`, violating CLAUDE.md's documented invariant ("every git write is bounded +
// non-interactive"). `flushSync` runs inside `gracefulShutdown` (index.ts), which ends in
// `process.exit(0)` — a hung child there means `loom stop` hangs and, worse, `daemon_restart`'s exit `75`
// hangs, so the supervisor never relaunches and the whole self-hosted fleet stays down.
//
// This induces a REAL hang — a genuine `git commit` child blocked inside an actual pre-commit hook
// (`sleep`), not a mocked/injected promise — same proof shape and same reasoning as
// test/merge-hang-does-not-wedge-queue.mjs (see that file's own header for why a real hook, not a mock,
// exercises the actual production spawn path). `execSync` is fully synchronous, so unlike an async
// Promise-race test there is no need to race a guard timer: the wall-clock time this script itself is
// blocked FOR is the direct measurement.
//
// RED PROOF (performed manually against this SAME file, not committed): reverting ONLY the
// `timeout`/`env` addition to `flushSync`'s `execSync` opts in
// packages/daemon/src/vault/versioner.ts (`git checkout HEAD -- packages/daemon/src/vault/versioner.ts`
// against the pre-fix commit), rebuilding, and re-running this unchanged test shows Case A's `flushSync`
// call taking the hook's full ~HOOK_SLEEP_S (not the injected tiny timeout) before returning `true` with
// a real (very slow) commit landed — i.e. no bound at all, exactly the defect this fix closes. Restoring
// the fix and rebuilding returns this file to green. See the worker's own report for the observed numbers.
//
// Review round 2 (card 816f0056): a Code Reviewer found, by REPLICATION (not inference), that the
// original Case A could pass all three of its checks even when the hooked `git commit` NEVER RAN — a
// bound tiny enough to time out `git add -A` itself leaves the marker file untouched, yet elapsed/false/
// no-partial-commit still all read as expected. Fixed below by having the hook touch a marker BEFORE
// sleeping and asserting the marker exists — proving the hang genuinely happened inside the hooked
// commit, not merely that SOME earlier call timed out. Also added: Case C (an asymmetric add/commit
// timeout, closing the same reviewer's finding 7 — a single shared override could never tell "add and
// commit share one timeout" apart from "they're bound independently") and Case D (the identity-fallback
// regression this round's `versioner.ts` fix also adds, closing finding 2, using the same hermetic
// GIT_CONFIG_GLOBAL/SYSTEM redirection test/vault-write-tool.mjs's (f) already established).
//
// Review round 3 (card 816f0056): the identity-fallback commit call moved from a shell-string `execSync`
// to an argument-array `execFileSync` (safe-by-coincidence identity interpolation → genuinely
// argument-safe). Side effect: `execFileSync` spawns `git.exe` with no shell in between, so a timeout now
// kills the REAL committing process directly — Case A's old "the orphan lands its commit later" assertion
// no longer holds in-worktree. It was first replaced with the opposite absolute ("the commit never
// lands"), which the merge gate then falsified too — under gate conditions (different host/scheduling
// timing) the commit DID land. **Whether a killed `git commit` produces a commit object is a RACE, not a
// property of the code**: it depends on how far `git.exe` had progressed (had it already written the
// commit object and updated the ref?) before the kill signal reached it — see `flushSync`'s own doc for
// the same note. This file does not assert either direction; it asserts only what is genuinely invariant
// (elapsed time stays bounded, the return value is `false`, no partial commit is visible IMMEDIATELY
// after the call returns). See `installHangingPreCommitHook`'s and Case A's own comments for the mechanism.
// Run after build: node test/vault-flush-sync-hang-bound.mjs
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";

const { VaultVersioner } = await import("../dist/vault/versioner.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const git = (cwd, args) => execSync(`git ${args}`, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
function initRepo(dir) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init");
  git(dir, "config user.email flush-hang@example.com");
  git(dir, "config user.name flush-hang-test");
}
// `git rev-list --all --count` is 0 (clean exit) on a fresh repo with no commits yet — unlike `git log`.
const commitCount = (dir) => parseInt(git(dir, "rev-list --all --count").trim() || "0", 10);

// Long enough to be unambiguously distinct from the injected TINY_TIMEOUT_MS bound below, with generous
// headroom over suite contention (same reasoning as merge-hang-does-not-wedge-queue.mjs's own
// HOOK_SLEEP_S comment); short enough that a worst-case (regression) run doesn't burn excessive wall time.
const HOOK_SLEEP_S = 10;
// The injected per-op timeout (VaultGitDeps.timeoutMs — the SAME test-only injection seam every other
// bounded git call in this module already accepts, now also honored by flushSync). Small relative to the
// real production ceilings (15s / 5min) so this test settles in a couple of seconds on the fixed code
// instead of waiting out either one — but NOT as tiny as this repo's other tiny-timeout injections
// (vault-push-status.mjs / vault-versioner-wiring.mjs / boot-reconcile-keep-work.mjs all inject against a
// never-resolving MOCK git, where spawn latency is structurally zero). Case B below runs a REAL 3-spawn
// git cycle (add/status/commit) bounded by this SAME value, and a real Windows process spawn has real
// latency: measured on this host (bash `date +%s%3N` bracketing, itself an overstatement since it
// includes date's own spawn cost) at n=5 each, under 3 live Loom workers + up to 2 concurrent gates on the
// shared merge-gate corpus this file joins: `git add -A` 68-108ms, `git status --porcelain` 65-102ms,
// `git commit` 92-113ms. A 300ms cap left only ~2.65x margin over the worst observed op on a
// partially-loaded host — thin enough for a false RED on the shared gate to be a live outcome. 2000ms
// keeps HOOK_SLEEP_S (10s) 5x above it (GREEN still lands in ~2.2s vs. a 10.5s RED — wide separation
// preserved) while sitting ~18x over the worst real cost measured above.
const TINY_TIMEOUT_MS = 2_000;

// Written via plain fs calls (no bash chmod) — Git for Windows invokes a shebang script via its bundled
// sh regardless of the exec bit; chmod is for POSIX hosts. Same convention as
// merge-hang-does-not-wedge-queue.mjs's installHangingHook. Touches a marker BEFORE sleeping (review
// round 2, finding 3) so a caller can prove the hook genuinely fired, not merely that flushSync returned
// on time — an earlier call (`git add -A`) timing out first would ALSO produce a fast/false/no-commit
// result, indistinguishable from a real hooked-commit hang without this marker.
// Touches a "fired" marker BEFORE sleeping (review round 2, finding 3 — proves the hook genuinely
// started, not merely that some earlier call timed out first) and a "done" marker AFTER (review round 3
// — an OBSERVABLE completion signal for Case A's delayed check below, instead of trusting a blind
// duration to mean the hook process has actually exited).
function installHangingPreCommitHook(repo) {
  const hookPath = path.join(repo, ".git", "hooks", "pre-commit");
  fs.writeFileSync(hookPath, `#!/bin/sh\ntouch .git/pre-commit-fired\nsleep ${HOOK_SLEEP_S}\ntouch .git/pre-commit-done\n`);
  fs.chmodSync(hookPath, 0o755);
}
const hookFired = (repo) => fs.existsSync(path.join(repo, ".git", "pre-commit-fired"));
const hookDonePath = (repo) => path.join(repo, ".git", "pre-commit-done");
// Polls for an observable event rather than trusting a blind fixed wait — the file/handle either now
// exists or the bounded budget ran out; either way this RETURNS with a real answer instead of guessing at
// "surely done by now".
async function waitForFile(filePath, timeoutMs) {
  try {
    return await sharedWaitUntil(() => fs.existsSync(filePath), { timeoutMs, intervalMs: 100, label: "vault-flush-sync-hang-bound: waitForFile" });
  } catch (err) {
    if (!/waitUntil: timed out/.test(err?.message ?? "")) throw err;
    return fs.existsSync(filePath);
  }
}
// KNOWN, ACCEPTED cleanup risk (same as merge-hang-does-not-wedge-queue.mjs's own note): the shell-string
// `execSync` calls' `timeout` ABANDONS the immediate spawned shell rather than stopping it (review round
// 2, finding 4 — no job object, no tree kill), so the hook's `sleep` survives and keeps running for the
// rest of HOOK_SLEEP_S regardless of which call triggered it. repoA/repoC's directory can therefore stay
// locked (a logged, non-fatal EBUSY from _tmp-fixture.mjs's best-effort cleanup) until that orphan exits
// on its own, up to HOOK_SLEEP_S after this file's process exits. Harmless and self-clearing; not the
// concern this test targets (flushSync's OWN bound on how long IT waits).

{
  // --- Case A: a REAL hung `git commit` (blocked inside an actual pre-commit hook) must not block
  // flushSync past its bounded timeout, must report false (a dropped flush, never a false success), must
  // not leave a partial commit behind, and — review round 2 — must be proven to have actually reached
  // and blocked inside the REAL hook, not merely that some earlier call timed out first.
  const repoA = mkdtempManaged("loom-flush-hang-a-");
  initRepo(repoA);
  const vcA = new VaultVersioner(repoA, 60_000, undefined, { timeoutMs: TINY_TIMEOUT_MS });
  await vcA.start();
  installHangingPreCommitHook(repoA); // installed AFTER start() so start()'s own git calls aren't affected
  fs.writeFileSync(path.join(repoA, "urgent.md"), "edited just before a wedged shutdown\n");
  const beforeA = commitCount(repoA);

  const t0 = performance.now(); // MONOTONIC — survives an NTP/backward clock step (see test/worktrees.mjs)
  const resultA = vcA.flushSync();
  const elapsedA = performance.now() - t0;
  await vcA.stop();

  check(
    `flushSync against a REAL hung pre-commit hook returns within its bounded timeout ` +
    `(${Math.round(elapsedA)}ms, cap ${TINY_TIMEOUT_MS}ms)`,
    // Tightened (review round 2, finding 6): the old `< HOOK_SLEEP_S * 1000` bound left only ~500ms of
    // margin, guaranteed solely by the HOOK_SLEEP_S constant — a later change to either constant could
    // silently collapse the discriminator. 3x the injected timeout is generous headroom over real spawn
    // latency (see TINY_TIMEOUT_MS's own measured-margin comment) while staying far below HOOK_SLEEP_S,
    // and it also catches "all three calls timed out" (not just the commit).
    elapsedA < TINY_TIMEOUT_MS * 3,
  );
  check("flushSync against a hung git child reports false (dropped, never a false success)", resultA === false);
  check("flushSync against a hung git child leaves no partial commit behind YET (checked immediately)", commitCount(repoA) === beforeA);
  check("the pre-commit hook genuinely fired (the hang is the REAL hooked commit, not `add` timing out first)", hookFired(repoA));

  // finding 8 ("add the sibling's index.lock assertion") was investigated and DOES NOT reproduce on this
  // host: a direct minimal repro (a plain `git commit` against the same hanging-hook shape, checked from a
  // SEPARATE shell while the hook slept) found `.git/index.lock` absent throughout — this git version
  // takes that lock only much later, near the actual write, not while the hook runs. Dropped rather than
  // asserted falsely.
  //
  // Round 3: the commit call switched from shell-string `execSync` to argument-array `execFileSync` (the
  // required identity-fallback fix). This changes what "abandoned" means for THIS call specifically:
  // `execFileSync` spawns `git.exe` directly (no shell in between), so Node's timeout-kill terminates the
  // REAL committing process itself — unlike the shell-wrapped `add`/`status` calls, where the wrapping
  // `cmd.exe` dies but the real `git.exe` child survives and can complete its op later. The hooked
  // `sleep`/its wrapping `sh` still runs to completion in the background regardless (an orphan of the
  // now-dead `git.exe`) — anchored below to the hook's OWN observable completion (its "done" marker), not
  // a blind duration, so this can tell "the hook is still running" apart from "the hook has genuinely
  // finished".
  //
  // ⭐⭐ Round 4 (the actual finding this card produced): whether the commit OBJECT itself lands once
  // `git.exe` is killed is a RACE, not a fixed outcome of the code — it depends on how far `git.exe` had
  // progressed (had it already written the commit object and updated the ref?) before the kill signal
  // reached it. This exact assertion has now been written as BOTH absolutes across two rounds, and reality
  // falsified BOTH: round 2's "the orphan lands its commit later" held in-worktree but not once the call
  // became `execFileSync`; round 3's replacement, "the commit never lands", held in-worktree but was then
  // falsified by the merge gate itself (`flushSync` produced a landed commit under gate-host timing,
  // despite the hooked sleep having genuinely finished first). Do not assert a third absolute in either
  // direction — see `flushSync`'s own doc comment (versioner.ts) for the same note. What stays genuinely
  // invariant, and is what this card is actually about, is asserted above: `flushSync` RETURNS within its
  // bound, REPORTS `false`, and never reports a false success — commitCount checked IMMEDIATELY after the
  // call (line above) never observes a commit at that instant either way, since the race resolves only
  // later, asynchronously, well after flushSync has already returned.
  const hookReallyFinished = await waitForFile(hookDonePath(repoA), (HOOK_SLEEP_S + 5) * 1000);
  check(`the hooked script itself genuinely ran to completion (observed via its own done-marker, not a blind timer) within ${HOOK_SLEEP_S + 5}s`, hookReallyFinished);

  // --- Case B (control, on the SAME tiny timeout): an ordinary, un-hung commit still succeeds under the
  // exact same tiny injected timeout — proves the bound doesn't itself break the normal fast shutdown
  // flush (the distinct failure mode a too-tight timeout would cause).
  const repoB = mkdtempManaged("loom-flush-hang-b-");
  initRepo(repoB);
  const vcB = new VaultVersioner(repoB, 60_000, undefined, { timeoutMs: TINY_TIMEOUT_MS });
  await vcB.start();
  fs.writeFileSync(path.join(repoB, "urgent.md"), "edited just before an ORDINARY shutdown\n");
  const beforeB = commitCount(repoB);
  const resultB = vcB.flushSync();
  await vcB.stop();
  check(
    "flushSync under the SAME tiny timeout still commits a normal (un-hung) shutdown flush",
    resultB === true && commitCount(repoB) === beforeB + 1,
  );

  // --- Case C (review round 2, finding 7): flushAddTimeoutMs/flushCommitTimeoutMs are genuinely
  // INDEPENDENT seams — a LARGE `add` bound alongside a TINY `commit` bound must still let `add` succeed
  // (not itself constrained by the small commit ceiling) while `commit` is killed at ITS OWN tiny bound,
  // not the large add one. Case A/B's single shared `timeoutMs` override can never prove this: both calls
  // always get the same value either way, so a bug that swapped which production constant backs which
  // call would go undetected. This exercises the two fields independently instead.
  const repoC = mkdtempManaged("loom-flush-hang-c-");
  initRepo(repoC);
  const LARGE_ADD_MS = 60_000; // far larger than TINY_TIMEOUT_MS — `add` must not be affected by it
  const vcC = new VaultVersioner(repoC, 60_000, undefined, {
    flushAddTimeoutMs: LARGE_ADD_MS,
    flushCommitTimeoutMs: TINY_TIMEOUT_MS,
  });
  await vcC.start();
  installHangingPreCommitHook(repoC);
  fs.writeFileSync(path.join(repoC, "urgent.md"), "edited just before a wedged shutdown (asymmetric bounds)\n");
  const beforeC = commitCount(repoC);
  const tC0 = performance.now();
  const resultC = vcC.flushSync();
  const elapsedC = performance.now() - tC0;
  await vcC.stop();

  check(
    `Case C (asymmetric bounds): with a LARGE add bound (${LARGE_ADD_MS}ms) and a TINY commit bound ` +
    `(${TINY_TIMEOUT_MS}ms), flushSync still returns quickly (${Math.round(elapsedC)}ms) — bounded by the ` +
    `small commit ceiling, not the large add one`,
    elapsedC < TINY_TIMEOUT_MS * 3,
  );
  check("Case C: the hook genuinely fired (add succeeded well within its 60s bound, reaching commit)", hookFired(repoC));
  check("Case C: reports false (dropped, never a false success)", resultC === false);
  // Same race as Case A's commit call (both go through execFileSync against a hanging hook) — time-scoped
  // for the same reason: whether the commit object eventually lands is a race decided by how far git.exe
  // got before the kill, not something this immediate check can or should claim either way.
  check("Case C: leaves no partial commit behind YET (checked immediately)", commitCount(repoC) === beforeC);

  // --- Case D (review round 2, finding 2 — BLOCKING): flushSync must commit via the generic Loom
  // fallback identity on a host with NO git identity configured anywhere. `commitVault`'s own doc
  // (":415-418") already anticipates exactly this host; flushSync never had the fallback at all, so this
  // used to fail with `fatal: empty ident name (for <>) not allowed` — silently, forever, on such a host.
  // Hermetic, same technique as test/vault-write-tool.mjs's (f): redirect GIT_CONFIG_GLOBAL/SYSTEM to
  // paths this test controls (never the host's real config) so this never depends on whatever identity
  // (if any) is actually configured on the machine running the suite.
  {
    const savedEnv = { ...process.env };
    const IDENTITY_ENV_KEYS = [
      "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL",
      "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM",
    ];
    try {
      for (const k of IDENTITY_ENV_KEYS) delete process.env[k];
      const repoD = mkdtempManaged("loom-flush-hang-d-");
      git(repoD, "init"); // deliberately NOT calling initRepo() — no local identity either
      process.env.GIT_CONFIG_GLOBAL = `${repoD}-nonexistent-global-gitconfig`;
      process.env.GIT_CONFIG_SYSTEM = `${repoD}-nonexistent-system-gitconfig`;
      process.env.GIT_CONFIG_NOSYSTEM = "1";
      fs.writeFileSync(path.join(repoD, "urgent.md"), "edited on an identity-less host\n");
      const vcD = new VaultVersioner(repoD, 60_000, undefined, { timeoutMs: TINY_TIMEOUT_MS });
      await vcD.start();
      const beforeD = commitCount(repoD);
      const resultD = vcD.flushSync();
      await vcD.stop();
      check(
        "Case D: flushSync commits via the generic Loom fallback identity on a host with NO git identity configured anywhere",
        resultD === true && commitCount(repoD) === beforeD + 1,
      );
      const authorD = git(repoD, "log -1 --format=%an%x09%ae").trim();
      check("Case D: the fallback commit's author is the generic Loom identity", authorD === "Loom\tloom@localhost");
    } finally {
      process.env = savedEnv;
    }
  }

  console.log(failures === 0
    ? "\nALL PASS — flushSync's git calls are bounded (independently, per call), a hung child is dropped " +
      "without wedging shutdown, an ordinary flush still commits, and a host with no git identity still " +
      "gets a fallback-identity commit instead of a silent, permanent failure."
    : `\n${failures} FAILURE(S).`);
  // repoA/repoB/repoC/repoD were all created via mkdtempManaged, which already registers them for
  // guaranteed cleanup at process exit (card 995be21f) — nothing else to release here (each
  // VaultVersioner's own watcher/handles were already stopped above, right after its flushSync call).
}

await finishAndExit(failures === 0 ? 0 : 1);
