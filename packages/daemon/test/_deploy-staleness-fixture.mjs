// Card 062fa934, Code Review CRITICAL — shared fixture for every test that drives
// `SessionService.resumeFleetOnBoot` directly. That method now reads a live `currentDeployStaleness()`
// (a real, bounded `execFileSync("git", ...)`) whenever its caller omits the `deployStaleness` test seam —
// and on THIS repo, a turbo cache-hit build replays the PREVIOUS commit's `dist/build-info.json` (the
// exact `aad5fff3` cache-replay footgun CLAUDE.md documents), which makes `processBuiltSha` disagree with
// the freshly-committed HEAD and flips `deploySignatureMismatch:true` — silently turning "your merged
// daemon code is now LIVE" into a withheld-claim nudge in six previously-green assertions across four
// files, reproduced and isolated by the reviewer on card 062fa934's own branch.
//
// Every `resumeFleetOnBoot` call in this test corpus MUST pass one of these explicitly — never rely on
// the real read, which is both slow (a real git call) and, as above, actively wrong on a cached build.

/** Mirrors deploy-staleness.ts's own `unavailable()` return shape exactly — the "not applicable" case
 * every real non-checkout call site (a packaged install, a git failure) already degrades to. Use this for
 * every test that isn't specifically about the deploy-signature-mismatch wording itself. */
export const CLEAN_STALENESS = {
  available: false, reason: "test fixture", distBuiltAt: null, processStartedAt: null, runningCodeBuiltAt: null,
  distAheadOfProcess: false, mainlineHeadSha: null, mainlineHeadDate: null, commitsBehind: 0, stale: false,
  webDistBuiltAt: null, webCommitsBehind: 0, webStale: false, distBuiltSha: null, distBuiltDirty: null,
  processBuiltSha: null, processBuiltDirty: null, distBuiltShaDiffersFromProcess: false,
  processBuiltShaMatchesHead: null, deploySignatureMismatch: false, webBuiltSha: null, webBuiltDirty: null,
};

/**
 * The deploy-signature-mismatch case, for the tests that specifically assert its wording. TWO fields flip
 * from CLEAN_STALENESS, not one: `deploySignatureMismatch` (the field under test) AND `available` (true).
 * That second flip is deliberate, not incidental — `computeDeployStaleness`'s own `unavailable()` helper
 * hardcodes `deploySignatureMismatch: false` unconditionally, so `deploySignatureMismatch:true` can only
 * ever be produced on the `available:true` branch in real production code. A fixture claiming
 * `available:false` alongside `deploySignatureMismatch:true` would assert a combination the real function
 * can never return — this fixture stays realistic instead. The liveClaim gate in service.ts reads
 * `deploySignatureMismatch` directly, ungated on `.available` (deploy-staleness.ts's own invariant already
 * guarantees the pairing), so no test here depends on `.available` itself — only on the field it's paired
 * with for realism.
 */
export const MISMATCH_STALENESS = { ...CLEAN_STALENESS, available: true, deploySignatureMismatch: true };
