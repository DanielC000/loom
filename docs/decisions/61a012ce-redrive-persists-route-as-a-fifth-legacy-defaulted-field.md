# 61a012ce — a redrive persists `ctx.route` too, a fifth field in card 129efe74's list

## Narrative

Card 61a012ce extends card 129efe74's persisted-field list (see
`docs/decisions/129efe74-redrive-reads-back-persisted-kind-hold-chain-legacy-defaults.md`) with a fifth
field: `route`. A durable `session_message_queued` record is the only thing a redrive (across a restart)
has to reconstruct dispatch semantics from — a companion-routed dispatch (e.g. a `wake_me` fired back
through a captured chat route) needs its `route` persisted too, or a restart-triggered redrive would
silently deliver it as a plain (routeless) nudge instead.

Legacy rows (persisted before this card) carry no `route` key — `undefined` values are dropped by JSON
serialization, so an old record (or any caller that omits it) redrives exactly as it always has: a plain
nudge. Every caller that omits `ctx.route` is byte-identical to before this field existed.

## Do not

- Do not persist a companion-routed dispatch without its `route` field — an untouched restart-triggered
  redrive would silently downgrade it to a plain nudge.
- Do not treat a legacy (pre-card) record's missing `route` as a bug — JSON serialization already drops
  `undefined`, so it correctly falls back to the plain-nudge behavior it always had.

## The wake.ts site: what the DURABLE dispatch replaced

The mechanism itself (claim-first deletion, the `session_message_queued` record, `recoverUndeliveredMessagesOnBoot`) stays inline, verbatim, at `WakeService.tick()`'s own dispatch comment in `orchestration/wake.ts` (Class C — it's the current contract, not narrative) — this record carries only the WHY: before card `61a012ce`, `WakeService.tick()` deleted the due wake row FIRST (claim-first, so a re-fire loop is impossible) and dispatched via a bare `pty.enqueueStdin` — which used to mean a HELD delivery (busy target) lost to a restart before drain had NO surviving record anywhere.

### Do not (wake.ts site)

- Do not revert the wake dispatch to a bare `pty.enqueueStdin` — the wake row is already deleted
  claim-first, so a HELD delivery lost to a restart before drain would again have no surviving record
  anywhere.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`enqueueDurableMessage`'s function doc, and
the held-record branch below `redriveQueuedMessage`'s own persisted-field comment): lines 6987-6991 and
7102-7104, as of main `a1c91ab66ab74e401387ad5f6336eae21175ec45`. Relocated by card `34cbd17a` (tranche
18).

The "wake.ts site" section above: inline comment above the dispatch branch in `WakeService.tick()`,
`packages/daemon/src/orchestration/wake.ts`, originally lines 215-220 as of this tranche's HEAD. No
wording changed; `//`-prefixed lines joined into a flowing paragraph.

## Related

- `docs/decisions/129efe74-redrive-reads-back-persisted-kind-hold-chain-legacy-defaults.md` — the
  original persisted-field list this card extends.
