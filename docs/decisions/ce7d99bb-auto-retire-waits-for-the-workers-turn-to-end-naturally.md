# ce7d99bb — auto-retire's graceful-stop bounds the wait for the worker's turn to end naturally

## Narrative

The no-commit auto-retire path used to stop the worker's pty with a flat `setTimeout(..., 3000)`
straight to `pty.stop`, deferred only so THIS tool call's own MCP response (`worker_report`'s reply,
still in flight over the MCP transport back to the worker's CLI) could flush before the pty's
Ctrl-C×2 landed (card `f46f4b0d`). That guarded the immediate race but not a slower one: a
`noCommit` worker's `worker_report(done)` call is itself mid-turn, and the model often keeps
generating a post-report recap for LONGER than 3s afterward — so the flat timer routinely fired
while the worker was still busy, Ctrl-C'ing an in-flight generation. That (a) skipped the worker's
own Stop hook, which is what normally captures ctx metrics (`readContextStats`/`setContextCounters`
— see `pty/host.ts`'s Stop-hook handler), permanently leaving `model`/`ctxInputTokens`/`ctxTurns`
null; and (b) is what stamps Claude Code's own generic "[Request interrupted by user]" line into the
transcript — the CLI can't tell a daemon-sent Ctrl-C from a real keypress, so an auto-retired
session's transcript falsely reads as a human interrupt.

`autoRetireStopWhenIdle` replaces the flat timer with a BOUNDED wait (`AUTO_RETIRE_IDLE_WAIT_MS`)
for the turn to end NATURALLY first — mirroring the companion-upgrade busy-wait shape (`isBusy`, a
monotonic-clock bound; see `UPGRADE_BUSY_WAIT_MS`'s doc for the sibling pattern) rather than
inventing a new one. `isBusy` reads the LIVE in-memory pty flag (no DB round-trip) — deliberately
NOT the DB row's `busy` column, which this same auto-retire branch already stamped `false` moments
ago (to free the concurrency slot deterministically) and so would always read as idle here
regardless of the pty's real state.

**COMMON PATH:** the worker's `worker_report(done)` call is itself mid-turn, and the model often
keeps talking (a redundant post-report recap) afterward — this wait gives that turn up to
`AUTO_RETIRE_IDLE_WAIT_MS` to finish on its own. Once it does, the worker's own Stop hook has
ALREADY fired (that's what `busy=false` means), so ctx metrics are already captured through the
normal path — the explicit read below just reconfirms it — and `pty.stop`'s Ctrl-C×2 lands on an
already-IDLE session (a clean exit). No interrupted-turn artifact, no false "[Request interrupted by
user]" line.

**FALLBACK PATH:** a turn still busy when the bound expires is STILL force-interrupted, exactly as
before this fix (a genuinely long or wedged final turn — the interrupt, and the CLI's own generic
marker, are unavoidable there, the same residual every other graceful-stop escalation in this
codebase already accepts). This is also the ONLY case where the explicit ctx-metrics read is
load-bearing rather than belt-and-suspenders: the interrupt about to fire prevents that worker's
Stop hook from ever running for the still-in-flight turn, so without this explicit capture its ctx
metrics would stay null.

Either way, the capture is keyed off the DURABLE `cwd`/`engineSessionId` on the session row (the
SAME whole-file transcript read the Stop hook itself does — `readContextStats` + `setContextCounters`,
see `@decision 21a77e85` for why this is NOT a tail-read), never the live pty state the interrupt is
about to disturb — so it's identical on both paths, no divergence in WHAT gets captured. Best-effort
throughout: a dead/gone session, or any read/write hiccup, never blocks the stop itself.

## Source

`packages/daemon/src/sessions/service.ts` — the inline comment before the `autoRetireStopWhenIdle`
call, and `autoRetireStopWhenIdle`'s own JSDoc (extraction tranche 33).
