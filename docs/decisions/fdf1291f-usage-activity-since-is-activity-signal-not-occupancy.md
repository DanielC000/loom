# fdf1291f — usage-sample activity is a best-effort ACTIVITY signal, never a context-occupancy estimate

## Narrative

Card fdf1291f: `getUsageActivitySince` is a best-effort ACTIVITY signal for ContextWatcher's blind-turn detector. It sums a session's `session_usage_samples` rows recorded at/after `sinceIso` — a feed the `UsageSampler` fills on its OWN 5-minute timer, independent of the engine's turn boundary (Stop), which is exactly the blind spot this exists to see through (the live transcript's cumulative usage keeps growing through tool calls that never reach Stop).

These columns are per-interval BILLED-USAGE deltas (input/output/cache tokens actually sent to the model across API calls), NOT context occupancy (occupancy ≈ the last turn's input+cache tokens; these are a SUM across many turns). Composing them into a numeric occupancy estimate would need the turn-to-turn prompt-cache hit rate to be known and stable, which this table cannot tell you — a broken cache prefix re-pays the whole context as `cache_creation` every turn, silently inflating any such estimate by an unknown, unbounded factor. So this is used ONLY to confirm a blind manager is genuinely still WORKING (real token flow during the gap, ruling out a merely-hung `busy=1` session — a different, already-covered failure), never to estimate a % of window. Returns `null` when no sample has landed yet for this session at/after `sinceIso` (can't yet distinguish "burning tokens" from "hung idle").

## Do not

- Do not compose these per-interval SUM columns into a numeric context-occupancy estimate — the turn-to-turn prompt-cache hit rate is unknown and can silently inflate such an estimate by an unbounded factor.
- Do not read a `null` return as "hung idle" — it means no sample has landed yet, which is indistinguishable from "burning tokens but the sampler hasn't ticked".

## ContextWatcher's own use of this signal (Trigger B, `checkBlindTurn`)

`ctxInputTokens`/`ctxUpdatedAt` refresh ONLY at the Stop hook (end of a logical turn), so a manager
that issues hundreds of tool round-trips inside ONE turn (never reaching Stop) is invisible to the
ratio check for the ENTIRE duration — the worst case, since a long tool-looping turn is both the
fastest way to burn context and the thing that suppresses the only signal measuring it. The incident
this card investigates: a manager blind for ~65 minutes, ending only because a human intervened. The
fix is deliberately NOT a numeric estimate composed from this table (see above) — shipping a wrong
number here would be worse than the blindness it replaces.

The chosen fix reuses `BusyWorkerWatcher`'s PROVEN signal (`busy` + `lastActivity` staleness — the
same mechanism already proven for the identical worker-side gap), scoped to managers and gated by
`managerBlindTurnMinutes`; `getUsageActivitySince` (above) is consulted only as the best-effort
diagnostic it already is, never as the trigger itself. On trip it appends ONE `context_blind_turn`
event (once per episode, mirroring `worker_stuck`'s de-dup) — a SOFT, human-facing advisory only. It
deliberately does NOT attempt a queued nudge: the busy-gated stdin queue is exactly the mechanism that
can't reach a manager stuck mid-turn (it lands, unread, at the next turn boundary — the very event
that isn't arriving).

## Do not (Trigger B)

- Do not attempt a queued nudge for a blind-turn detection — the busy-gated stdin queue can't reach a
  manager stuck mid-turn; it only lands at the next turn boundary, the very event that isn't arriving.

## Source

Inline comment in `packages/daemon/src/db.ts` (`getUsageActivitySince`): lines 4679-4696, as of this tranche's HEAD. Second site: JSDoc comment in `packages/daemon/src/orchestration/context-watcher.ts` (the class doc's BLIND-TURN section, and `checkBlindTurn`'s own method doc): lines 96-114, as of this tranche's HEAD (tranche 1 on `context-watcher.ts`).
