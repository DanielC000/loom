# cf803152 — `mergeBatchTracked`'s `attach()` call also carries `retainMs`/`verdictIdentity`/`classifyOutcome`/`identityOptional`

## Narrative

Card cf803152: `mergeBatchTracked`'s `PendingOpRegistry.attach()` call (see
[[f944d4e4-mergebatchtracked-dedupe-attach-key]] for the dedupe key itself) now ALSO carries
`retainMs`/`retainVerdictUntilSuperseded`/`verdictIdentity`/`classifyOutcome`/`identityOptional` — through
two Code Review corrections: the first added `verdictIdentity`/`classifyOutcome` after the initial version
shipped without them; the second added `identityOptional` after this card's OWN new test caught the initial
"no mirror of the solo path's `alreadyFinished`" draft breaking recovery for the single most common real
case, a batch that landed.

It still carries no `onOpMinted`/`onSurfacedPending` — the batch's own `insertPendingGateOp` mint, inside
the gate closure, is unchanged, and still just receives the `opId` `attach()` mints instead of a
locally-generated one. `opts.onSettle` IS now passed (card `81d795de` — see
[[81d795de-mergebatch-settle-deferred-to-whole-batch-completion]] for the full deferred-settle mechanism
this enables). Card `be260976` (see [[be260976-batch-verdict-derivation-closes-the-never-existed-gap]])
already established that a `pending_gate_ops` tombstone row DOES exist for this op, correcting an earlier
"never routes through PendingOpRegistry" framing — this card is a CONTINUATION of that same,
already-sanctioned direction, not a new reversal of it.

The bounded `{settled:false}` return this whole `attach()` design produces mirrors `worker_merge_confirm`'s
own `{opId, status:"pending"}` vocabulary at the MCP layer (`mcp/orchestration.ts`'s `merge_batch` handler
translates it, same as that tool's own handler already does for `worker_merge_confirm`) rather than
inventing a parallel shape.

## Do not

- Do not add `onOpMinted`/`onSurfacedPending` to this `attach()` call — the batch's own `insertPendingGateOp` mint inside the gate closure is unchanged and deliberately still receives the `attach()`-minted `opId` rather than generating its own.
- Do not invent a parallel pending/settled vocabulary at the MCP layer for `merge_batch` — reuse `worker_merge_confirm`'s own `{opId, status:"pending"}` shape, which `mcp/orchestration.ts` already translates this call's bounded `{settled:false}` return into.
- Do not omit `identityOptional` on the assumption every batch outcome mirrors the solo path's `alreadyFinished` shape — an earlier draft without it broke recovery for the single most common real case, a batch that landed, and this card's own new test is what caught it.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, `mergeBatchTracked`'s own JSDoc header, as of this tranche's HEAD.
