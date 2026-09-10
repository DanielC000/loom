# b16320bc — `rateLimitedUntil`/`rateLimitDeadline` close the "looks idle but is rate-limited" blind spot on the fleet view

## Narrative

Card b16320bc: additive fields on the fleet view (`worker_list`/no-arg `worker_status`) — a non-limited worker's row is otherwise unchanged, both fields simply read `null`. Without them, a worker parked on a usage cap (§19c — `detectUsageLimit`'s `StopFailure` signal, or the weekly/account TEXT-sentinel fallback in `pty/host.ts`) showed as plain `busy:false`, indistinguishable from a healthy idle worker; a manager had to call `worker_status(id)` — or read the transcript — to discover the park. `worker_status(id)` already surfaced both fields (it returns the full session record), so this closes the SAME gap for the fleet view without adding a new field or scanner.

## Detection: the weekly/account TEXT sentinel (`usage-limit.ts`)

The SESSION-scoped 5h cap kills the turn and fires a structured `StopFailure{error:"rate_limit"}` (`detectUsageLimit`) — but a weekly/account cap is answered by the interactive CLI as an ordinary assistant reply, e.g. "You've hit your weekly limit · resets 5pm (America/Los_Angeles).", followed by a CLEAN `Stop`, not a `StopFailure`. The structured detector never fires, so without a separate check the worker just stalls, replying bare "No response requested" to every later nudge — invisible in structured state (`busy:false`, both `rateLimitedUntil`/`rateLimitDeadline` empty), the exact blind spot this card closes.

`isWeeklyUsageLimitSentinel` (`usage-limit.ts`) closes it: `host.ts` tests the LAST assistant turn's TEXT-ONLY reply (`ContextStats.lastAssistantText` — `content[].type==="text"` blocks only, `tool_use`/`tool_result` excluded) from the SAME single-pass transcript scan `readContextStats` already does at the Stop/StopFailure chokepoint, on EVERY clean Stop. A match parks through the exact same path as the structured detector (`rateLimitedUntil`/`rateLimitDeadline`, above) — but with no `resetsAtSeconds` (plain text carries no machine-readable reset time), so `rateLimitedUntil` falls back to its default backoff / the already-polled usage-window reset, exactly as it does for a reset-less `StopFailure`.

Deliberately biased toward precision over recall: both `WEEKLY_LIMIT_HIT_RE` (the CLI's own "hit your weekly/account limit" framing, anchoring on that distinctive shape rather than generic vocabulary) and `WEEKLY_LIMIT_RESET_CLOCK_RE` (a real clock-time shape — an am/pm suffix or an `HH:MM` pair; a bare integer like "resets 5 items"/"resets 5×" does not qualify, and neither does a dateless mention like "resets on Monday"/"resets detection") must both match. This chokepoint runs on EVERY clean Stop across worker, manager, and companion sessions alike, so generic vocabulary would false-positive: a Loom dev session — including this card's own follow-up work — routinely discusses "weekly limits" and "resets" without being capped. A missed real cap is a visible, transcript-diagnosable stall (today's status quo); a false positive silently freezes a healthy session with a confidently-wrong signal — the worse failure of the two.

## Do not

- Do not treat a fleet-view row with `busy:false` and no rate-limit context as proof a worker is genuinely idle without checking `rateLimitedUntil`/`rateLimitDeadline` — a rate-limited park reads identically to healthy idle without them.
- Do not loosen `WEEKLY_LIMIT_HIT_RE`/`WEEKLY_LIMIT_RESET_CLOCK_RE` to generic "weekly limit"/"resets" vocabulary — ordinary conversation about this very feature would false-positive and silently freeze a healthy session.

## Review: one shared read serves both the context-stats refresh and the weekly-cap sentinel

`pty/host.ts`'s `Stop`/`StopFailure` case used to read+parse the transcript TWICE at this chokepoint: once
for the context-occupancy refresh, and again below for the weekly-cap text sentinel this card added. A
later review folded the weekly-cap sentinel's read into the SAME single-pass scan the context-occupancy
refresh already does — `stats.lastAssistantText` now comes from that one shared read — halving the
constant cost of a potentially multi-MB JSONL parse on this M2-sensitive synchronous Stop-hook chokepoint,
without changing the ORDER of the two checks.

## Source

- Inline comment in `packages/daemon/src/mcp/orchestration.ts` (the fleet-view builder): lines 2605-2611, as of commit `f81f9c1108773e559efe78b7166cbf78b6201480`. Relocated by card `a2278b09` (tranche 2).
- Inline comment in `packages/daemon/src/orchestration/usage-limit.ts` (module doc comment above `isWeeklyUsageLimitSentinel`): lines 22-49, as of commit `80dbeba069d14094047a40aa5de308ecd7ceb662`. Relocated by card `d1da6441` (tranche 1).
