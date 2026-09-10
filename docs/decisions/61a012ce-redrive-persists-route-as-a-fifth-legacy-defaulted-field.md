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

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`enqueueDurableMessage`'s function doc, and
the held-record branch below `redriveQueuedMessage`'s own persisted-field comment): lines 6987-6991 and
7102-7104, as of main `a1c91ab66ab74e401387ad5f6336eae21175ec45`. Relocated by card `34cbd17a` (tranche
18).

## Related

- `docs/decisions/129efe74-redrive-reads-back-persisted-kind-hold-chain-legacy-defaults.md` — the
  original persisted-field list this card extends.
