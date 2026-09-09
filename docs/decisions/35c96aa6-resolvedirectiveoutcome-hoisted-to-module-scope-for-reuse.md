# 35c96aa6 — `resolveDirectiveOutcome` hoisted to module scope so a second caller can reuse the exact same walk

## Narrative

`resolveDirectiveOutcome` resolves ONE directive's (a `message_worker`/`redirect_worker` send's) current fate from durable event history alone, walking its give-up/re-mint chain from `rootMsgId` forward. Card 35c96aa6: hoisted out of `buildServer`'s `staleDirectiveProjection` closure to MODULE scope (unchanged logic — it never closed over anything but its own three parameters; `events`' type was previously spelled via `ReturnType<typeof db.listEventsForWorker>` purely for convenience, now the equivalent `OrchestrationEvent[]`) so a second caller — the worker-facing `directive_status` tool — can reuse the EXACT SAME walk instead of a parallel reimplementation that could silently drift from it. `staleDirectiveProjection`'s own call site is untouched; this is a pure scope move, not a behavior change.

Each msgId gives up AT MOST ONCE (a give-up either re-mints to a brand-new msgId or parks terminally — see `handleGiveUpExhausted`'s doc) — so walking msgId → its one give-up event → the next msgId cannot loop; `seen` is a cheap defensive bound, not a real cycle guard.

Card 3c39be30: `events` is now the branded `DirectiveEventStream`, not a raw `OrchestrationEvent[]` — see that card's own record for the precondition this enforces and why.

## Do not

- Do not reimplement the give-up/re-mint chain walk at a second call site — reuse `resolveDirectiveOutcome` itself; a parallel reimplementation is exactly the drift risk this hoist closes.

## Source

JSDoc comment in `packages/daemon/src/mcp/orchestration.ts`, above `resolveDirectiveOutcome`. Relocated by card 210cd10c (tranche 1 on `mcp/orchestration.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
