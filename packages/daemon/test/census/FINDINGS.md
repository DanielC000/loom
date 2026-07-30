# Suite flake census — findings (card `d39db2db`)

Card closes at this state: the baseline-N=20 census is **retired at 7 samples**, not completed to 20.
This document is the durable answer to "why did it stop at 7" — read this, not a transcript, for that.

## Summary of the whole census (all phases)

1. **Phase 0 — harness positive control**: passed in both directions (known-good pair stays clean;
   known-bad assertion failure and known-bad timeout both correctly caught). The mandatory synthetic-dir
   isolation check also passed: a probe file under `test/census/synthetic/` is invisible to the real
   gate's discovery (585 tests found with or without it present — `fs.readdirSync` on `test/` is shallow).
2. **Phase 0.5 static audit — three literal-identity patterns checked, all negative**:
   - Duplicate `Date.now()`-only temp-dir prefixes: exactly one duplicate pair across all 585 hermetic
     files (`E2E-`, shared by `integration-e2e.mjs`/`skills-e2e.mjs`) — **both are `NOT_HERMETIC`**, never
     reach the real gate.
   - Duplicate hardcoded `LOOM_PORT` literals: 77 hermetic files hardcode a port, 20 duplicate groups /
     43 files — looked like a strong lead, but **none of the 43 call `.listen()`**; all either use
     Fastify's in-memory `.inject()` or never stand up a server. Inert, not a live collision surface (real
     code-hygiene smell, not this mechanism).
   - One fully-fixed literal tmpdir name shared by 2 files (`loom-voice-web-`) — safe, both wrap it in
     `fs.mkdtempSync` (collision-safe unique suffix).
3. **Phase 1 — forced pairwise probe, validated instrument, all negative**: a known-colliding fixture
   pair (`collide-a`/`collide-b`, share one fixed external path) failed 5/5 together, 0/6 solo — proving
   the probe can catch a real collision — then 6 real candidate pairs (the `TEST_TIMEOUT_OVERRIDES`
   git-heavy tests, `codescape-lifecycle-hooks`, `worker-spawn-cap-toctou-race`, each crossed against the
   historically-worst offender `merge-gate-reuse` plus filler contrasts) came back clean across 3
   conditions each (forced-concurrent, sequential at concurrency=1 — the peer's exact
   in-suite-at-`concurrent=1` signature — and solo), 0/26 total runs.
4. **Phase 1b — the `getFreePort`-shaped TOCTOU pattern, forced, negative with a caveat**: found a real
   instance in production code, `src/codescape/supervisor.ts`'s `pickLoopbackPort()` (binds ephemeral,
   reads the port, closes it, then a separate child process rebinds that port moments later). Forced the
   only 2 hermetic files that exercise it repeatedly (`codescape-health-probe.mjs`,
   `codescape-supervisor.mjs`): 0/10 forced-concurrent, 0/6 solo. **Caveat**: a real OS ephemeral-port
   collision is a much lower-probability-per-encounter event than the probe fixture's ~100%-by-design
   collision, so this negative is weaker than #3's.
5. **The `fa52f555` check** (surfaced via project memory mid-census): `scripts/test-daemon.mjs`'s own
   comment claims its `4400+lane` port scheme is "safe under concurrency" — true within one invocation,
   false across two concurrent gate runs. Checked reachability: **zero hermetic tests bind a real
   listener on the assigned `LOOM_PORT`** (comprehensive grep for non-ephemeral `.listen()` across all 585
   files) — every hermetic test uses `.inject()` or an unrelated ephemeral `:0` bind. The reasoning flaw
   is real (carded on `fa52f555`) but not currently reachable in this suite. An accidental real-world
   instance of exactly this scenario occurred later (see below) and is consistent with this conclusion.
6. **Phase 2 — baseline census, retired at 7 rows** (below).

## Phase 2 baseline — the 7 rows, per-row attribution

| row | runIndex | start (UTC) | end (UTC) | durationMs | hostBefore procs/MB | hostAfter procs/MB | classification |
|---|---|---|---|---|---|---|---|
| 1 | 1 | 03:07:29.304 | 03:26:16.504 | 1,124,340 | 33 / 8403 | 10 / 3650 | **CONTAMINATED** — overlapped real merge gate `7145ea30` |
| 2 | 2 | 03:26:16.505 | 03:39:38.233 | 800,992 | 10 / 3650 | 15 / 4546 | CLEAN |
| 3 | 3 | 03:39:38.234 | 03:53:45.767 | 846,828 | 15 / 4547 | 14 / 3113 | CLEAN |
| 4 | 4 | 04:02:02.236 | 04:19:06.319 | 1,022,055 | 14 / 4144 | 50 / 12286 | **CONTAMINATED** — overlaps row 5 (11.58min, two independent invocations of this harness ran concurrently by accident, sharing one fixed base-port scheme) |
| 5 | 4 (dup label) | 04:07:31.705 | 04:27:22.933 | 1,190,185 | 17 / 4021 | 23 / 5683 | **CONTAMINATED** — overlaps row 4 (11.58min) and row 6 (8.28min) |
| 6 | 5 | 04:19:06.320 | 04:37:56.011 | 1,127,995 | 49 / 12266 | 18 / 4010 | **CONTAMINATED** — overlaps row 5's tail (8.28min); a THIRD contaminated row the same-label-only check would have missed — found by computing overlaps pairwise across all 7 rows, not just the duplicated label |
| 7 | 6 | 04:40:38.242 | 04:57:05.539 | 986,495 | 13 / 4819 | 15 / 4120 | CLEAN |

**Classification is by the MEASURED `hostBefore.nodeLikeProcessCount`/workingSet covariate, never by the
free-text `knownConcurrentActivity` annotation** — that annotation is what a worker can actually observe,
and it was wrong for row 1 (it claimed "negligible CPU log-mining" while row 1 in fact overlapped a real
merge gate; the measured covariate caught what the annotation could not).

**Result: 3 clean / 4 contaminated / 7 rows. 0 recorded failures in every row** — verified against raw
stdout (see below), not just the NDJSON's derived `failedCount` field.

**Re-derived clean-cluster duration range** (rows 2, 3, 7 only): **13.35–16.44 min**, wider than an earlier
stale "13.4–14.1min" citation (from an early two-row read) that had been repeated for part of this
session.

**Why 4 of 7 rows are contaminated, and why they were NOT discarded**: a process-management oversight
(an interrupt stops a worker's *turn*, not a background task it already launched) caused a duplicate
census invocation to run concurrently with the original, for rows 4/5/6. This is a genuine mistake in
sequencing, not a fabricated condition — but the 4 contaminated rows are kept as real DATA, not garbage,
because they turned into the accidental load-stress arm behind the Task 1 finding below. **Do not alter,
renumber, or delete any row** — `runIndex` duplication (label `4` appears twice) is itself evidence for
`f106f28e` (see below), and altering it would destroy that evidence.

## The positive finding: does gross host load reproduce `createworktree-repo-lock`'s known load-sensitivity?

A sibling investigation (feeding card `37640fd2`) found `createworktree-repo-lock` real-git-subprocess
timing stretches from 390–550ms quiet to 2340ms under a real MERGE GATE — a 4-6× stretch that raced a
1500ms synthetic timer. The 4 contaminated rows above, incidentally, are the closest thing this census
produced to a controlled load-stress arm: real full-suite runs peaking at 50 procs / 12,286 MB of
node-like process load — is that same test's timing margin broken by GROSS load, or does it need
something specific to a real merge gate?

**Checked, not assumed — with a positive-controlled counting method**:
- The NDJSON schema cannot answer this by itself. `testCount: names.length` (`phase2-baseline.mjs:35`)
  is a constant fixed BEFORE any test executes; `failed` (`:27`) is a pure blacklist. The full pass list
  is computed in `runCensusBatch` (`lib.mjs:143` returns it) and then **discarded before persisting** —
  "0 failures" alone cannot distinguish "ran and passed" from "silently never ran."
- **Worktree-resident console logs (`raw/baseline-batch{1,1b,1c,2}-console.log`) answer it directly.**
  `createworktree-repo-lock` shows an explicit `PASS` line in all 4 contaminated rows' segments.
- **The counting method was positive-controlled before being trusted**: counting `PASS`/`FAIL` lines
  between each run's own `[baseline] run N/20` completion marker, every ONE of the 4 contaminated rows'
  segments totals exactly **585** (the full hermetic suite, no short-circuit) — while partial/killed
  attempts that never reached the NDJSON at all show **188 / 484 / 203** in the SAME logs. That contrast
  proves the counting method actually detects a short-circuited run rather than trivially reporting 585
  by construction; without it, "585 everywhere" would be indistinguishable from an instrument that can
  only ever say 585.

**Finding**: `createworktree-repo-lock` genuinely ran to completion and passed in all 4 rows, including
the one peaking at 50 procs / 12,286 MB. **This SUPPORTS — does not prove, n=4, uncontrolled, incidental
— that gross host load is not what breaks that test's timing margin.** If load were the whole story, a
50-process / 12GB host should have been at least as hostile as a real merge gate's own load; it wasn't.
This sharpens the hypothesis toward canonical-git-index contention specific to concurrent `createWorktree`
operations against the same repo, which gross unrelated host load does not reproduce. **Card `28279371`**
(a targeted 3-arm experiment: quiet / gross load / concurrent `createWorktree` against one canonical
repo) is built to settle this with a controlled test — this census predicts arm 2 (gross load) will show
no stretch.

## The three caveats — what "0 failures" does and does not mean

A census run is a SINGLE run ⇒ structurally blind to **cross-run** collisions (a mechanism needing two
concurrent gates, like `fa52f555`'s reasoning flaw, cannot be exercised by any number of solo runs). The
**load-window class needs REAL merge-gate contention**, which a solo run — even an incidentally
host-loaded one, as demonstrated above — does not reproduce. Any **negative-polarity / false-negative**
class (a bug that makes a check pass when it shouldn't) is invisible to a pass/fail census by
construction, at any sample size. **0/7 (and 0/3 clean) rules out single-run test-level causes and
leaves all three of the above untested, not eliminated.**

## Why the remaining 17 runs were retired rather than completed

The only thing more solo runs could tighten is the single-run/test-level class's CI — already at 0/3
clean (Clopper-Pearson upper bound ≈70.8%, would tighten toward ≈16.8% at n=20, the number that would
statistically exclude the observed ~33%). **But that class was never a leading suspect**: the campaign's
own earlier arithmetic already puts the three previously-carded per-test flakes at ~0.9%/gate combined —
nowhere near 33%. The two classes that plausibly COULD explain ~33% — cross-run collision and real
merge-gate contention — are structurally untestable by any number of additional solo runs, confirmed
empirically above (gross load ≠ real gate contention). **Recommendation: retire the remaining ~4+ hours
of exclusive host time this would have cost, rather than spend it tightening a CI on a class that was
never the leading candidate.** If host time becomes available, `28279371`'s targeted experiment is the
higher-yield next step, not more baseline sampling.

## Other named line items from the card

- **`6c0a6fe5`** (`worker-spawn-cap-toctou-race`, expected 0 given the `createWorktree` per-repo lock
  fix): **0 failures observed** in every context it ran across this census — the 6 forced-pair reps in
  Phase 1, and as part of the full suite in all 7 baseline rows. Consistent with the fix; premise stays
  retracted as a TRUE POSITIVE, not a flake — not re-framed here.
- **Composition variation (DoD, hypothesis 4)**: not reached — the baseline retired before Phase 3 was
  scoped. The forced-pair work in Phase 1/1b is the closest evidence gathered and found no reproducible
  pairwise collision in the specific candidates tested — explicitly not exhaustive (6 pairs out of
  C(585,2) ≈ 171k possible; only two literal-identity patterns and one TOCTOU shape were checked
  statically). A composition sweep, if ever run, cannot come back "negative" in a way that excludes
  hypothesis 4 in general — only in a way that says these particular sampled compositions didn't collide.
- **Aggregate rejection rate implied by this census vs. the observed ~33%**: 0/7 (0%), but this number
  should not be over-read — it is underpowered (n=7, not 20) AND it only speaks to the single-run class
  per the caveats above, not to the classes most likely to actually explain 33%.

## What this census carded for follow-up (not fixed here, per the card's own DoD)

- **`fa52f555`** — `scripts/test-daemon.mjs`'s per-lane-port comment is a real reasoning flaw (safe
  within one run, false across two concurrent ones) — not currently reachable (no hermetic test binds a
  real listener on the assigned port), but worth fixing on its own terms.
- **`f106f28e`** — `phase2-baseline.mjs`'s `runIndex = start + i` (`:23`) has no read-back against
  existing NDJSON content, so a duplicate index can be (and was) appended silently — this census's own
  duplicate-label-4 rows are the live evidence. Also folded in per the manager: the schema gap that
  `runCensusBatch`'s full pass list (`lib.mjs:143`) is computed and then discarded before persisting is
  arguably the bigger defect, since it's why "0 failures" alone couldn't distinguish passed-from-never-ran
  without falling back to console logs that happened to survive.
- **`28279371`** — the 3-arm quiet/gross-load/concurrent-createWorktree experiment this census's Task 1
  finding fed into; this census's own prediction (no stretch under gross load) is attached to its arm 2.
- A small code-hygiene item, not carded: 43 hermetic test files hardcode a literal `LOOM_PORT` that is
  never used to bind a real listener (dead configuration) — found while investigating the port-duplicate
  lead, mentioned here for completeness, left uncarded since it's cosmetic and not this census's mandate.
