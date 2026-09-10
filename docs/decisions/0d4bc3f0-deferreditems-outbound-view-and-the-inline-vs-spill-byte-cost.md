# 0d4bc3f0 — `Task.deferredItems`: the OUTBOUND view, and the measured NDJSON byte cost of shipping it

## Narrative

Card 0d4bc3f0 added `Task.deferredItems` — sub-items THIS card's own DoD deferred onto ANOTHER card, recorded structurally (see `DeferredItem`'s own doc) alongside — never instead of — a `Related:`/prose note in the body.

BEHAVIOR is unchanged for the overwhelming majority of cards that never defer anything, default `[]`/absent — but this is NOT byte-identical-to-today at the serialized-row level: the always-present `[]` adds a small constant (~19 bytes as `"deferredItems":[]`) to EVERY full Task row, which measurably ate into the NDJSON inline-vs-spill headroom (`SPILL_INLINE_BUDGET_CHARS`, spill.ts) on the two tests closest to that budget (`platform-cross-project-task.mjs`'s bulk-pagination section, `mcp-scope.mjs`'s tool-list assertion) when this field shipped. This was a DELIBERATE choice, not an oversight: NOT omit-when-empty, because a uniform always-present array is the more predictable consumer shape, and the cost lands only on full-body reads (`TaskSummary`/`tasks_list`'s hot path stays clean, verified by `task-summary-inline-capacity.mjs`) — the next field that erodes spill headroom should cost bytes here again, not dodge measurement by omitting itself.

Written ONLY via the dedicated `tasks_defer_item`/`tasks_defer_item_ack` tools (mcp/tasks.ts `deferTaskItem`/`updateDeferredItemStatus`) — never a raw `tasks_update` patch field; see `deferTaskItem`'s own doc for why an append needs its own choke point rather than a client-constructed full-array replace.

`deferredItems` is the OUTBOUND view (what this card handed to others); the INBOUND view — "what has been handed to THIS card and not yet acknowledged" — is a different, DERIVED thing computed at read time by scanning every OTHER task's own `deferredItems` for an entry whose `toTaskId` names this card: see `TaskWithRequests.incomingDeferredItems` (mcp/tasks.ts `getProjectTask`), surfaced by `tasks_get` the same way `requests` already is — so a card can be on the RECEIVING end of a hand-off without ever having been told the donor's id in advance. THIS is the mechanism that makes a dropped hand-off detectable (card DoD-4): reading the recipient's OWN card surfaces a still-`"open"` item structurally, instead of requiring anyone to go re-read the donor card's prose to notice nothing ever answered it.

## Do not

- Do not write `deferredItems` via a raw `tasks_update` patch — use the dedicated `tasks_defer_item`/`tasks_defer_item_ack` tools; an append needs its own choke point, not a client-constructed full-array replace.
- Do not omit `deferredItems` when empty to save bytes — the always-present `[]` is deliberate for consumer-shape uniformity; a future field that erodes spill headroom should be measured the same way, not dodge measurement by omitting itself.
- Do not assume a card must be told a donor's id in advance to detect an incoming hand-off — `incomingDeferredItems` is derived at read time by scanning every other task's own `deferredItems`.

## Source

JSDoc comment in `packages/shared/src/types.ts` (`Task.deferredItems`'s own doc comment). Extracted by card 555f817f (tranche 3 on `packages/shared/src/types.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
