# 05056168 — gate-timing NDJSON survives a SIGKILL: write-ahead run-start row + incremental per-file flush

## Narrative

Filed after card `17069e7e` shipped rich per-file gate telemetry — but verified at source that BOTH write call sites (the `run-summary` append, and the `for (const r of results) appendGateTimingRow(...)` loop over the completed results array) ran only in the `isMain` *post-run* block. A SIGKILLed run wrote nothing at all, not even a partial file — and every one of this project's then-7 unclassifiable `exit timeout` specimens left no per-file record, making "was this a slow suite or one hung file" permanently unanswerable after the fact. The existing `partial:true` path on `formatRssFloorLine`/`formatMaxGapLine` does not cover this case — it fires from a `catch` handler, which a SIGKILL bypasses entirely; it covers "the harness threw," never "the harness was killed."

**Design contributed by the Codescape peer (their card `a1c823f4`)**, with a key insight: the blind spot isn't the bounded output tail's *size*, it's *which file it shows*. Under parallel execution (pool size 2+) a truncated tail shows whichever file printed **last** — never the one that stalled. A truncated tail is byte-identical for "suite is slow" and "one file hung," so enlarging `OUTPUT_TAIL_BYTES` does not fix this and would waste the effort.

**The fix, two parts:**

1. A write-ahead record, appended *before* the first test spawn and closed at the end, carrying `selected` (the full run set by name). This is the one line a SIGKILL cannot defeat — it converts an absent record into a *visibly unterminated* one. A reader pairs a run-start row to its run-summary row by shared `runUid`; a run-start with no matching run-summary is a run that never terminated normally, and subtracting the "file" rows that *did* land (same `runUid`) from `selected` names the file(s) in flight when the process died (see the exported `neverCompletedFiles` helper).
2. The per-file ledger flushes **incrementally**, as each file completes, rather than in one post-run loop — so a killed run leaves completion rows for everything that finished, plus (via the subtraction above) the name of the file that never did.

**Positive control, and it is the whole card:** start a run, SIGKILL it mid-flight, and show the artifact names the in-flight file — a test that only exercises the clean-exit path proves nothing here; the clean path already worked.

## Do not

- Do not reintroduce a post-run-only write for any new row kind added to this file later — incremental, per-file flush is the property that makes a SIGKILLed run diagnosable, and every later addition (`237aa3a9`'s `failureDetail`, in particular) inherits it deliberately by attaching to this same per-file flush point.
- Do not regress `appendGateTimingRow`'s existing guarantees while adding incremental flushing: it must never throw, and per-call failures must be tallied, never printed per-call (a per-call `console.warn` would flood the bounded ~4KB gate-rejection tail and destroy the diagnostic output of the very suite it observes).
- Do not change any timeout ceiling as part of this card — it exists so that decision can later be made on evidence, not to make it itself.

## Source

Inline comment in `packages/daemon/scripts/test-daemon.mjs`, module-header decision-history block (originally lines 80-90), as of this tranche's HEAD. Card `05056168`, filed 2026-08-04; design credited to the Codescape peer's `a1c823f4`. Related: `eafc5598` (the 7 unclassifiable timeouts this instrument targets), `f1043732` (a sibling instrument-cannot-observe-what-it-bounds case).
