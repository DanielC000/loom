import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 816f0056 — `VaultVersioner.flushSync()`'s three `execSync` git calls carried NO timeout and NO
// `GIT_TERMINAL_PROMPT=0`, violating CLAUDE.md's documented invariant ("every git write is bounded +
// non-interactive"). `flushSync` runs inside `gracefulShutdown` (index.ts), which ends in
// `process.exit(0)` — a hung child there means `loom stop` hangs and, worse, `daemon_restart`'s exit `75`
// hangs, so the supervisor never relaunches and the whole self-hosted fleet stays down.
//
// @decision ffe98495 update (review round 2): this file originally forced the hang via a REAL git
// exec-config trick (first a `.git/hooks/pre-commit` hook, then a hanging `gpg.program`) — but card
// ffe98495 round 2 ALSO forces `-c commit.gpgsign=false` unconditionally, closing that mechanism too, on
// top of the hooksPath/fsmonitor neutralisation that already closed the first one. `flushSync` is fully
// SYNCHRONOUS (no promise to leave un-resolved the way an async `gitFactory` mock does for `commitVault`'s
// own hang test), so simulating a genuinely hung child for it still needs a REAL blocking subprocess — but
// it no longer needs to be GIT at all. `VaultGitDeps.flushExecFileSyncImpl` (new, this card) lets a test
// substitute flushSync's git-invoking function: ordinary calls (`add`/`status`) delegate to the real
// `execFileSync` against the real repo, while the ONE call under test spawns something else entirely — a
// plain `node -e "setTimeout(...)"` child — through that SAME real `execFileSync`, so Node's own real
// timeout/SIGTERM enforcement still fires, without touching git's hook/gpg/config exec surface at all.
// Verified by manual probe: a real `execFileSync` against this exact script throws `{code:"ETIMEDOUT",
// signal:"SIGTERM"}` at the given bound, with the marker file written first — same proof shape as the old
// hook/gpg mechanisms, without their now-closed attack surface.
//
// RED PROOF (performed manually against this SAME file, not committed): reverting ONLY the
// `timeout`/`env` addition to `flushSync`'s `execSync` opts in
// packages/daemon/src/vault/versioner.ts (`git checkout HEAD -- packages/daemon/src/vault/versioner.ts`
// against the pre-fix commit), rebuilding, and re-running this unchanged test shows Case A's `flushSync`
// call taking the full injected hang duration (not the injected tiny timeout) before returning `true` with
// a real (very slow) commit landed — i.e. no bound at all, exactly the defect this fix closes. Restoring
// the fix and rebuilding returns this file to green. See the worker's own report for the observed numbers.
//
// Review round 2 (card 816f0056): a Code Reviewer found, by REPLICATION (not inference), that the
// original Case A could pass all three of its checks even when the hooked `git commit` NEVER RAN — a
// bound tiny enough to time out `git add -A` itself leaves the marker file untouched, yet elapsed/false/
// no-partial-commit still all read as expected. Fixed below by having the injected commit call touch a
// marker BEFORE hanging and asserting the marker exists — proving the hang genuinely happened inside the
// commit step, not merely that SOME earlier call timed out. Also added: Case C (an asymmetric add/commit
// timeout, closing the same reviewer's finding 7 — a single shared override could never tell "add and
// commit share one timeout" apart from "they're bound independently") and Case D (the identity-fallback
// regression this round's `versioner.ts` fix also adds, closing finding 2, using the same hermetic
// GIT_CONFIG_GLOBAL/SYSTEM redirection test/vault-write-tool.mjs's (f) already established).
//
// Review round 3 (card 816f0056, since superseded by the ffe98495 rewrite above): the identity-fallback
// commit call moved from a shell-string `execSync` to an argument-array `execFileSync`. Round 4: whether a
// KILLED real `git commit`'s object lands is a genuine race, not a fixed property of the code — see
// `flushSync`'s own doc comment (versioner.ts). That race is specific to a REAL git child being killed
// mid-write; the ffe98495 mechanism's injected child is a plain `node` process that writes nothing git
// cares about, so this file no longer needs to hedge around that race at all — case A/C now assert a
// commit count of exactly `before` (never ambiguous) rather than "checked immediately, race resolves
// later".
// Run after build: node test/vault-flush-sync-hang-bound.mjs
import fs from "node:fs";
import path from "node:path";
import { execFileSync, execSync } from "node:child_process";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

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

// The injected per-op timeout (VaultGitDeps.timeoutMs — the SAME test-only injection seam every other
// bounded git call in this module already accepts, now also honored by flushSync). Small relative to the
// real production ceilings (15s / 5min) so this test settles in a couple of seconds on the fixed code.
const TINY_TIMEOUT_MS = 2_000;

/**
 * A `VaultGitDeps.flushExecFileSyncImpl` that delegates ordinary calls to the REAL `execFileSync` against
 * the real repo, except: a call whose argv contains `"commit"` spawns a plain `node -e
 * "setTimeout(...)"` child instead (through that SAME real `execFileSync`, with the SAME `opts` —
 * `timeout`/`env`/`cwd`/`stdio`/`maxBuffer` — so Node's own real timeout/SIGTERM enforcement still fires).
 * The child writes `markerPath` before entering its infinite timer, so `fired()` can prove the hang
 * genuinely happened inside the commit step, not merely that an earlier call (`add`) timed out first —
 * see this file's own header for why this replaces the old git-hook/gpg-program mechanism.
 */
function makeHangingCommitExecImpl(markerPath) {
  let firedFlag = false;
  const impl = (file, args, opts) => {
    if (args.includes("commit")) {
      firedFlag = true;
      const script = `require("fs").writeFileSync(${JSON.stringify(markerPath)}, "1"); setTimeout(() => {}, 999999999);`;
      return execFileSync(process.execPath, ["-e", script], opts);
    }
    return execFileSync(file, args, opts);
  };
  impl.fired = () => firedFlag;
  return impl;
}

{
  // --- Case A: a wedged `git commit` step must not block flushSync past its bounded timeout, must report
  // false (a dropped flush, never a false success), must not leave a partial commit behind, and — review
  // round 2 — must be proven to have actually reached the commit step, not merely that `add` timed out.
  const repoA = mkdtempManaged("loom-flush-hang-a-");
  initRepo(repoA);
  const markerA = path.join(repoA, ".git", "commit-fired");
  const execImplA = makeHangingCommitExecImpl(markerA);
  const vcA = new VaultVersioner(repoA, 60_000, undefined, { timeoutMs: TINY_TIMEOUT_MS, flushExecFileSyncImpl: execImplA });
  await vcA.start();
  fs.writeFileSync(path.join(repoA, "urgent.md"), "edited just before a wedged shutdown\n");
  const beforeA = commitCount(repoA);

  const t0 = performance.now(); // MONOTONIC — survives an NTP/backward clock step (see test/worktrees.mjs)
  const resultA = vcA.flushSync();
  const elapsedA = performance.now() - t0;
  await vcA.stop();

  check(
    `flushSync against a wedged commit step returns within its bounded timeout ` +
    `(${Math.round(elapsedA)}ms, cap ${TINY_TIMEOUT_MS}ms)`,
    elapsedA < TINY_TIMEOUT_MS * 3,
  );
  check("flushSync against a wedged commit step reports false (dropped, never a false success)", resultA === false);
  check("flushSync against a wedged commit step leaves no partial commit behind (a plain `node` child writes no git object)", commitCount(repoA) === beforeA);
  check("the wedged commit step genuinely fired (the hang is the REAL commit step, not `add` timing out first)", execImplA.fired() && fs.existsSync(markerA));

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
  const markerC = path.join(repoC, ".git", "commit-fired");
  const execImplC = makeHangingCommitExecImpl(markerC);
  const vcC = new VaultVersioner(repoC, 60_000, undefined, {
    flushAddTimeoutMs: LARGE_ADD_MS,
    flushCommitTimeoutMs: TINY_TIMEOUT_MS,
    flushExecFileSyncImpl: execImplC,
  });
  await vcC.start();
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
  check("Case C: the wedged commit step genuinely fired (add succeeded well within its 60s bound, reaching commit)", execImplC.fired() && fs.existsSync(markerC));
  check("Case C: reports false (dropped, never a false success)", resultC === false);
  check("Case C: leaves no partial commit behind", commitCount(repoC) === beforeC);

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
    ? "\nALL PASS — flushSync's git calls are bounded (independently, per call), a wedged commit step is " +
      "dropped without wedging shutdown, an ordinary flush still commits, and a host with no git identity " +
      "still gets a fallback-identity commit instead of a silent, permanent failure."
    : `\n${failures} FAILURE(S).`);
  // repoA/repoB/repoC/repoD were all created via mkdtempManaged, which already registers them for
  // guaranteed cleanup at process exit (card 995be21f) — nothing else to release here (each
  // VaultVersioner's own watcher/handles were already stopped above, right after its flushSync call).
}

await finishAndExit(failures === 0 ? 0 : 1);
