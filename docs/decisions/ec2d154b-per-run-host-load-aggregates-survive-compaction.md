# ec2d154b — per-run host-load aggregates survive gate-timing retention compaction

## Narrative

Finding, measured by a worker on a related card: `gate-timing-retention.mjs` compacts every run older than the most recent `keepFullRuns` (all `test-daemon.mjs` invocations on the host, ≈7 hours at the fleet rate observed) down to its `run-summary` row alone, dropping the periodic `kind:"host-sample"` rows (`cpuBusyPct`/`diskProbeMs`/`freeMemMB`, 5s cadence) entirely. The `run-summary` row itself survives the whole window but, before this card, carried only `hostBefore`/`hostAfter` `{freeMemMB,...}` snapshots — no CPU or disk. Consequence, measured: a flake-attribution question ("does host load discriminate failing vs. passing runs?") could use CPU/disk data for only 10 of 64 runs; the other 54 were unrecoverable once compacted.

**The fix:** at run end, compute per-run aggregates from that run's *own* host samples — `cpuBusyPct` mean/p95/max, `diskProbeMs` p95/max, minimum `freeMemMB`, and a sample count — and write them into the `run-summary` row (which the compactor keeps), rather than changing `keepFullRuns` or the retention policy itself. `computeHostLoadAggregates` is pure and takes the *same* in-memory sample arrays `onHostSample` already accumulates for the existing human-readable summary lines (`formatHostLoadSummaryLine`/`formatDiskProbeSummaryLine`), so a test can drive it with synthetic arrays instead of a real gate run.

**Sample-count and null conventions, carried from the sibling instruments this one aggregates:**

- `cpuBusyPctSamples`/`diskProbeMsSamples` already exclude `null` entries (no-prior-reading on the sampler's first tick; a failed disk probe) before reaching this function, matching the convention `formatHostLoadSummaryLine`/`formatDiskProbeSummaryLine` already use.
- `freeMemMBSamples` is never null-filtered — every tick records a real reading — so its own length is used as `sampleCount`: the count of host-sample *ticks* the run actually took, which can exceed the CPU/disk sample counts without ever being smaller than either.
- Every output field is `null` when its own source array is empty (a run too short for one tick, or a run where every disk probe failed) — never a fabricated `0`, the same posture `cpuBusyPctDelta`/`diskProbeWriteMs` themselves use.
- `p95` is nearest-rank (`ceil(0.95 * n) - 1`, clamped), not interpolated — deliberately simple over the small, host-generated sample counts this module produces, where sub-percentile precision isn't meaningful; it returns `null` for an empty input rather than a fabricated number.

This is additive only, the same posture as card `237aa3a9`'s `failureDetail`: a reader written before this card simply lacks the key. Every existing reader of `run-summary` rows must be checked to still parse the widened row.

## Do not

- Do not change `keepFullRuns` or the retention policy to solve this — the per-tick rows are large by design; the fix is a small summary that survives compaction, not keeping more full runs.
- Do not fabricate a `0` for an empty sample array on any aggregate field — `null` is the only honest value when there were no samples (or, for disk, every probe on the run failed).
- Do not interpolate `p95` — nearest-rank only, matching this module's existing simplicity convention for small host-generated sample counts.

## Source

Inline comments in `packages/daemon/scripts/test-daemon.mjs`: the module-header decision-history mention (originally lines 121-131) and the `computeHostLoadAggregates` design doc (originally lines 365-383), as of this tranche's HEAD. Card `ec2d154b`, filed 2026-09-10 from a finding on card `427590d2`.
