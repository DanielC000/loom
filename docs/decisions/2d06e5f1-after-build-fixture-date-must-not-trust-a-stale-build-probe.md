# 2d06e5f1 — size a fixture's "after build" date off max(probe, now), never the probe alone

## Do not

- Do not derive a "commit after build" fixture date from a one-time dist-build-clock probe alone —
  `computeDeployStaleness()` re-reads the build clock on EVERY call, so a dist write between the probe
  and the assertion (another lane in a full gate) can push the clock past a probe-derived date and
  silently flip the result to `stale:false`/`commitsBehind:0`.
- Do not treat this as a `c6e7ebe7`-style production `GIT_TIMEOUT_MS`/git-hiccup issue — the root cause
  was test-side (a stale fixture date); the production staleness computation behaves as designed
  (`8ff7ccde`).

## Narrative

Filed by mgr #101 (2026-08-02) as the deliberately deferred half of `19fbeede`. `served-status.mjs`'s
`(4-setup)` real-tree probe rejected at least one innocent branch (card `2281009d`, twice) with no
diagnostic content. `19fbeede` first made the probe print its failure `reason` — deliberately NOT fixing
anything yet, since fixing early would have destroyed the evidence this card needed (§SEQUENCING). On
2026-09-24 three real gate logs captured the live reason: `stale: commitsBehind counts the new commit` /
`a daemon/src commit AFTER the real dist build ⇒ deployStaleness.stale:true`.

**Root cause** (Bugfix worker `189eacfd`, lead-accepted): the test probes the dist build clock ONCE
(~line 115) and derives `afterBuild = realDistMtime + 60s` — the date a fixture claims a commit landed.
`deploy-staleness.ts`'s `computeDeployStaleness()` instead recomputes the build clock LIVE on every call
(`newestMtimeMs` over both daemon/shared dist dirs). A dist write mid-test (another lane of the same full
gate rebuilding) pushes that live clock past the one-time `afterBuild` probe value, so the fixture's
"commit after build" date stops being after the build by the time the assertion runs. The accompanying
`bad object <sha>` noise in the same logs is unrelated and present in green standalone runs too.

**Fix:** the shared fixture helper derives the date as `max(probedDistMtimeMs, now) + 60s`
(`commitDateAfterBuild`), not `probedDistMtimeMs + 60s` alone (`commitDateAfterBuildProbeOnly`, kept only
so the regression test can prove the OLD derivation goes RED). The regression test forces a dist write
mid-test to reproduce the exact 2-FAIL gate signature pre-fix, and shows it green after.

## Source

`packages/daemon/test/_served-status-fixture-dates.mjs`, `@decision 2d06e5f1`. Merged `4e82087`.
Related: `19fbeede` (the diagnosability half), `c6e7ebe7` (the separate, deliberately untouched
production `GIT_TIMEOUT_MS` question), `cc595ca7` (git-contention precedent).
