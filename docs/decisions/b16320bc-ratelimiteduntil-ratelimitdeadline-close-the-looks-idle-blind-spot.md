# b16320bc — `rateLimitedUntil`/`rateLimitDeadline` close the "looks idle but is rate-limited" blind spot on the fleet view

## Narrative

Card b16320bc: additive fields on the fleet view (`worker_list`/no-arg `worker_status`) — a non-limited worker's row is otherwise unchanged, both fields simply read `null`. Without them, a worker parked on a usage cap (§19c — `detectUsageLimit`'s `StopFailure` signal, or the weekly/account TEXT-sentinel fallback in `pty/host.ts`) showed as plain `busy:false`, indistinguishable from a healthy idle worker; a manager had to call `worker_status(id)` — or read the transcript — to discover the park. `worker_status(id)` already surfaced both fields (it returns the full session record), so this closes the SAME gap for the fleet view without adding a new field or scanner.

## Do not

- Do not treat a fleet-view row with `busy:false` and no rate-limit context as proof a worker is genuinely idle without checking `rateLimitedUntil`/`rateLimitDeadline` — a rate-limited park reads identically to healthy idle without them.

## Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts` (the fleet-view builder): lines 2605-2611, as of commit `f81f9c1108773e559efe78b7166cbf78b6201480`. Relocated by card `a2278b09` (tranche 2).
