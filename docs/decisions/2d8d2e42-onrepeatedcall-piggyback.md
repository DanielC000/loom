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

## Source

Inline comment in `packages/daemon/src/mcp/inbound-log.ts` (lines 48-54 as of commit `7da34b90`).
Relocated by card `d6bd207b` (extraction tranche 1).
