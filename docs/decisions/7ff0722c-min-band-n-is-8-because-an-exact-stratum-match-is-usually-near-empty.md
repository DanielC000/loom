# sha:7ff0722c — `MIN_BAND_N` is 8 because an exact `poolSize`+`testCount` match is nearly always statistically empty

Source: commit `7ff0722c`, no board card ("feat(orchestration): surface the gate-timing NDJSON nobody queries"). Condensed, not verbatim.

## Narrative

A manager correction to this card's own original filing: an EXACT `poolSize`+`testCount` match is nearly always statistically empty in practice. Measured live against the real 115MB timing NDJSON file: the most recent real run's own exact stratum had `n=2`; across the whole file, 127 distinct strata existed and 98 of them (77%) had a clean `n < 5`.

`testCount` increments on every single test file added or removed, so a real full-suite stratum is a handful of runs at best and collapses to 0–2 for WEEKS after any test lands — the band is emptiest exactly when someone has just changed the suite and most wants to know whether it got slower. `MIN_BAND_N` exists so a near-empty exact stratum still widens outward to a usable sample instead of reporting off `n=2`.

## Source

Inline comment in `packages/daemon/src/orchestration/gate-timing-band.ts`, above `MIN_BAND_N`, as of main `db57bdc4`. Relocated by card `f7552bf6` (runtime-subsystem residue, closing sweep). Condensed and reworded, not verbatim.
