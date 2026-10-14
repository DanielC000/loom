import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 2267e8fa (CR 7163d56a round 2, MINOR finding 2) — `probeGitIdentResolvable` (git/bounded.ts) had
// dropped its `withTimeout` wrap when `resolveGitIdentityFallbackArgs`'s signature was reworked for the
// locale-pin fix (round 2 of this same card). A never-settling `git var` probe (a real hung child, or a
// test-injected promise that never resolves) would then silently widen `commitVault`'s own total-elapsed
// bound past `timeoutMs` — exactly the class of hang this whole codebase's bounded-git convention exists
// to close (see `git/bounded.ts`'s own module doc). Fixed by re-wrapping each `.raw(["var", …])` call in
// `withTimeout(…, timeoutMs, …)`, same as every other bounded call in this file.
//
// Proves: a `makeProbeGit` factory whose `raw()` returns a promise that NEVER settles still lets
// `resolveGitIdentityFallbackArgs` return (not hang) within a small, bounded multiple of `timeoutMs` —
// and, since a timeout is NOT git's own "cannot determine identity" fatal, it is treated as RESOLVED (per
// this card's own "any other probe error ⇒ fail toward the user's identity" ruling), so the result is the
// empty fallback-args array, never the generic Loom override.
//
// Run: 1) build daemon (pnpm build), 2) node test/identity-probe-timeout-bound.mjs
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const boundedUrl = pathToFileURL(path.join(__dirname, "..", "dist", "git", "bounded.js")).href;
const { resolveGitIdentityFallbackArgs } = await import(boundedUrl);

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const TINY_TIMEOUT_MS = 300;
// Each of the two `var` probes (author, committer) runs sequentially and each times out independently —
// bound generously above 2x so this stays robust under real host scheduling jitter without being able to
// mask a genuinely unbounded hang (which would blow well past even this).
const WALLCLOCK_CAP_MS = TINY_TIMEOUT_MS * 6;

let factoryCalls = 0;
let rawCalls = 0;
function neverSettlingProbeFactory() {
  factoryCalls++;
  return {
    raw: () => {
      rawCalls++;
      return new Promise(() => { /* never resolves — simulates a hung `git var` child */ });
    },
  };
}

const start = performance.now();
const result = await resolveGitIdentityFallbackArgs("Z:\\does-not-matter", TINY_TIMEOUT_MS, neverSettlingProbeFactory);
const elapsedMs = performance.now() - start;

check(`resolveGitIdentityFallbackArgs returns (does not hang) against a never-settling probe — settled in ${elapsedMs.toFixed(0)}ms (cap ${WALLCLOCK_CAP_MS}ms)`, elapsedMs < WALLCLOCK_CAP_MS);
check("the probe factory was actually invoked (the timeout path was genuinely exercised, not short-circuited)", factoryCalls === 1);
check("both the author AND committer `var` probes were attempted (genuinely bounded per-call, not just once)", rawCalls === 2);
check("a timed-out probe is treated as RESOLVED, never git's own 'cannot determine identity' fatal — no fallback args returned", Array.isArray(result) && result.length === 0);

console.log(failures === 0
  ? "\n✅ ALL PASS — a never-settling `git var` probe cannot widen resolveGitIdentityFallbackArgs past its own bounded timeout, and a timeout is treated as resolved (fail toward the user's own identity), never as git's own unresolvable-identity fatal."
  : `\n❌ ${failures} FAILURE(S).`);

process.exit(failures === 0 ? 0 : 1);
