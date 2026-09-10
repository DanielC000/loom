# e6e55f7a — record whole-run RSS floor and max inter-event gap in the gate output

## Narrative

A sibling harness (the Codescape peer's test runner) prints a whole-run peak-RSS + max
inter-event-gap summary at the end of every gate run, pass or fail. Loom's gate emitted neither —
verified by grep across `packages/daemon/src` and `packages/daemon/scripts` for `RSS FLOOR` / `max
inter-event gap` (zero hits) — and a night was spent hand-reconstructing both numbers instead of
reading them off an existing instrument.

**Peak memory.** A live gate was hand-sampled for system commit charge to test whether allocation
pressure explains in-suite reds. The peer's own decomposition showed poor sensitivity in that
approach: their whole suite peaks at ~5.28 GB against a 71.9 GB commit limit, while system commit
sits flat at ~84% — that baseline is third-party residency, not the suite under test, so an
aggregate reading is dominated by a large constant and barely moves when the suite's own
contribution varies. The quantity that actually discriminates is the runner's own process tree's
peak RSS — exactly what the peer's line reports and Loom's didn't.

**Suite quietness.** `GATE_EXTEND_IDLE_MS` is 60s, and a gate that goes idle past it is refused its
extension — the failure mode that turns an over-budget run into a hard death. Only point-samples of
`gate_status().idleMs` had ever been taken by hand (observed up to 26.8s one run, 71.8s another).
Point samples establish presence, never absence — the actual maximum gap in a run could not be
stated without the peer's kind of continuous recording.

**Fix:** sample, on a fixed ~5s interval for the run's duration, the runner's own peak RSS and the
maximum gap between successive test-completion events (the same liveness notion
`GATE_EXTEND_IDLE_MS` reasons about), and print both as summary lines on pass and fail alike — a
rejected run's numbers are as valuable as a passed run's, arguably more so, since rejections are
disproportionately the interesting ones. The line is deliberately labelled "highest OBSERVED, not a
proven peak," with sample count and interval stated inline — a sampled max that reads like a
measured max is precisely the kind of number this project has been burned by before, so the
qualifier is not optional decoration.

Observation only: zero change to test selection, ordering, concurrency, or exit codes — the
no-argv default path stays byte-identical except for the two added output lines. Sampling itself
must not distort the measurement: cheap `process.memoryUsage`-class reads on a timer, no per-test
synchronisation, no added subprocess.

`readRssBytes` is injectable so a hermetic test can drive the tracker with synthetic readings
instead of asserting on real, non-deterministic process memory.

## Why a harness crash must never be swallowed (manager follow-up, not the card's literal DoD but its purpose)

`runInstrumentedSuite` wraps the actual run body so a harness crash mid-run — an uncaught
exception, a hang killed externally, anything that aborts before the normal summary prints — is
never silently lost; it is the single most opaque rejection mode this instrument exists to
illuminate, and a DoD that covered every other case except that one would be a technicality. On
success it resolves normally, unchanged from before. On failure it prints both the RSS-floor and
max-gap lines (labelled `partial: true`) and then rethrows the *same* error unchanged.

This file *is* the merge gate for every project on this daemon — a swallowed exception here would
silently green a dead harness. The exit code itself is never this wrapper's to decide: Node's own
default uncaught-exception handling is what decides that, exactly as it did before this wrapper
existed. `runInstrumentedSuite` only ever observes and rethrows; it never catches-and-exits.

## Do not

- Do not report an aggregate/system-wide memory reading as the discriminating signal — a
  third-party residency baseline can dominate it and mask the suite's own contribution; track the
  runner's own process tree instead.
- Do not print a sampled max without labelling it "highest OBSERVED, not a proven peak" plus the
  sample count/interval — an unlabelled sampled max reads as a measured peak and misleads.
- Do not let this change test selection, ordering, concurrency, or exit codes, or add a per-sample
  subprocess spawn — observation only.
- Do not swallow a harness-crash exception in `runInstrumentedSuite` — this file is the merge gate
  for every project on this daemon, and a swallowed exception here would silently green a dead
  harness. Always rethrow the same error unchanged; never catch-and-exit with a different code.

## Source

Inline comments in `packages/daemon/scripts/test-daemon.mjs`: the `createRssTracker` definition
(originally ~lines 713-717, before the later `f1043732` scope addendum) and the
`runInstrumentedSuite` crash-handling note (originally ~lines 784-790, a manager follow-up to this
same card). Card `e6e55f7a`, filed 2026-08-01, merged as commit `915b599`.
