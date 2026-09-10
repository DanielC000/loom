# 2d8d2e42 — `onRepeatedCall` piggybacks the MCP census's already-computed `argsHash`

## Narrative

`PtyHost.recordToolCallArgsHash` (repeated-identical-call detection, see
`pty/repeated-call-tracker.ts`) needs an `argsHash` per tool call. Rather than compute that hash a
second time, `onRepeatedCall` (`mcp/inbound-log.ts`'s `logInboundMcpRequest`) piggybacks onto the
SAME per-entry loop that already computes `argsHash` for the `[mcp]` census line — reusing the
identical value rather than risking two independent hash computations silently drifting apart.

Unlike `attribute` (card `cd0c7fee`), which is scoped to `WATCHED_TOOL_NAMES`, `onRepeatedCall`
fires for EVERY tool call that carries an `argsHash` — see `pty/repeated-call-tracker.ts`'s own
doc for why the wider scope is deliberate and costs nothing in false positives. This does NOT gate
or refuse the call; it is advisory, same posture as `attribute`.

## Consumption: `handleRepeatedToolCall` is defense-in-depth, not the primary fix (`sessions/service.ts`)

`handleRepeatedToolCall` consumes `PtyHostEvents.onRepeatedToolCall`, fired at the Nth repeat and
every subsequent multiple of N (`RepeatedCallResult.firedAtThreshold`, `pty/repeated-call-tracker.ts`).
It is defense in depth behind card `45390f74`'s cheap primary fix (an anti-poll `note` on
`gate_status`'s live reply) — this fires regardless of whether that note was ever read, and regardless
of which tool the streak is on (generalized past `gate_status`).

Reuses the two-recipient shape established by `handlePasteLengthLoss`
([[b68d1f5b-window-sizing-and-calibration]]), with one deliberate difference in the RECIPIENT half: the
live nudge is queued for whenever the current turn eventually ends, not delivered as a mid-turn
interrupt — a live turn-interrupt was explicitly REJECTED as this card's option (c), since it could
break the loop mid-turn in an unpredictable way. The SENDER half (the manager, via `parentSessionId`)
is the one live party who CAN act on this while the loop is still running (e.g. `worker_recycle`),
since it is a wholly separate session/turn from the one stuck looping.

## Do not

- Do not deliver this nudge as a mid-turn interrupt — that option was explicitly rejected; queue it for
  the next turn boundary instead.

## Source

Inline comment in `packages/daemon/src/mcp/inbound-log.ts` (lines 48-54 as of commit `7da34b90`).
Relocated by card `d6bd207b` (extraction tranche 1).

The "Consumption" section above is from a second inline comment, `handleRepeatedToolCall`'s own JSDoc
in `packages/daemon/src/sessions/service.ts`, as of `main` `b4721fd1`. Extracted by card `da28e0a5`
(tranche 22 on `sessions/service.ts`).
