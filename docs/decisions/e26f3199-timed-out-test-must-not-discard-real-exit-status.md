# e26f3199 — a timed-out test file must not discard its own real exit status

## Narrative

Before this card, a timeout was reported as `status: "timeout"` with the child's REAL exit status
discarded — so "the child completed successfully and `close` merely arrived late" (mechanism A: a
grandchild inheriting the stdio pipe kept it open after the child itself was long gone — Node fires
`exit` the instant the process terminates, but `close` only once every stream referencing that pipe
closes) printed IDENTICALLY to "genuinely wedged, killed, and never exited" (mechanism B). They must not
print the same.

**The fix:** `spawnWithTimeout` records `exitAt`/`timeoutFiredAt` (real timestamps, not booleans) as the
discriminator, MEASURED rather than argued — if the child's own `exit` fired before the timer ever
called `child.kill()`, nothing was actually killed; something downstream just kept the pipe open.
`describeTimeoutDetail` is a pure classifier (drivable directly by a test against any combination) that
never guesses: `exitAt: null` (the child's own `exit` never observed) is reported as "killed, never
exited", not a fabricated exit.

**Recorded for EVERY completed run, not just a timeout** — `exitAt`/`closeAt`/`exitToCloseGapMs` land on
every non-errored `runOne` result and every gate-timing NDJSON row, real numbers on a normal PASS too.
Deliberate: a pass's own exit→close gap is a free population baseline for how often a grandchild holds
the pipe open at all, across the whole suite, on every gate run — data neither the card nor a one-off
investigation could otherwise get. `timeoutDetail` alone stays genuinely timeout-only (null otherwise).
The same "timeout (<detail>)" wording is reused in the live per-file streaming PASS/FAIL line, not just
the end-of-run `FAILURES:` summary, so the real exit status is visible as the suite runs too.

## Do not

- Do not report a timeout's `status` without also carrying `exitAt`/`timeoutFiredAt` (or the derived
  `timeoutDetail`) — collapses mechanism A and mechanism B back into identical output.
- Do not gate `exitAt`/`closeAt`/`exitToCloseGapMs` capture on `timedOut` — record them for every
  completed run, pass or fail, to keep the population baseline honest.

## Source

Inline comments in `packages/daemon/scripts/test-daemon.mjs`: above `describeTimeoutDetail` (~917-928)
and `spawnWithTimeout` (~939-942), the `runOne` NDJSON-row comment (~1217-1223), the live streaming
comment in `runLane` (~1246-1249), the gate-timing NDJSON row comment (~1270-1276), and the `FAILURES:`
epilogue's own anchor (~1855-1856) — all as of this tranche. Card `e26f3199`. Introduced by commit
`0bd8be04`.
