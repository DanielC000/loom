# f8b176f7 — compact old gate-timing runs to their run-summary row, don't rotate

## Narrative

`test-daemon.mjs`'s gate-timing NDJSON (`<LOOM_HOME>/gate-timing/daemon-per-file-timing.ndjson`) needed a growth bound without destroying the cross-run comparability the artifact exists for: `kind:"file"` and `kind:"host-sample"` rows are the overwhelming majority of every run's bytes (~86% of rows, per `gate-timing-band.ts`'s own measurement) but are useless to cross-run trend analysis — only `kind:"run-summary"` rows (one per run, a few hundred bytes) feed `computeGateTimingBand` at all.

Deleting old history outright was rejected: it would starve that consumer exactly the way this card's own kickoff measured (`n:8, nExact:3` — already sample-starved before this module existed). Instead, `gate-timing-retention.mjs` compacts old runs down to their `run-summary` row alone and drops their `file`/`host-sample`/`run-start` rows; a `run-summary` row survives forever (subject to the module's own hard ceiling), only the bulk per-file detail expires.

Compaction ("compact old runs to their run-summary rows and drop the per-file detail") is the third candidate the card names — the card pre-blesses none of its candidates; this module chose it over straightforward segment rotation (rename-on-overflow, e.g. this repo's own `scripts/lib/rotating-log.mjs`). Rotation was rejected because `computeGateTimingBand` reads ONLY the canonical path — a rotated-away segment would be invisible to it forever, which would make cross-run comparability WORSE on every rotation, not better. Compaction never moves the canonical file out of that path, so a `run-summary` row the module preserves stays visible to that reader for as long as it survives the retention ceiling.

## Do not

- Do not solve the growth problem by rotating the file to a new path on overflow — `computeGateTimingBand` only ever reads the canonical path, so a rotated-away segment becomes permanently invisible to it, which is worse for cross-run comparability than the unbounded growth this card set out to fix.

## Source

Condensed and reworded from the module-header decision narrative in `packages/daemon/scripts/lib/gate-timing-retention.mjs` (originally lines 9-22, as of this tranche's HEAD). Card `f8b176f7`.
