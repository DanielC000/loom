# c90e9525 — `deferredAt`/`deferredReason`: a manual deferral must explain itself

## Narrative

Card c90e9525 added `deferredAt`/`deferredReason` as a self-explaining pair for a MANUAL deferral (no `deferredUntilTaskId` — see docs/decisions/793ac76d-deferreduntiltaskid-auto-clears-deferred-on-observed-merge.md for that route, which this does NOT cover).

`deferredAt` is the instant a manual deferral most recently STARTED: stamped server-side (`updateProjectTask`, mcp/tasks.ts) on a genuine `false → true` transition, or the first time a reason lands on a legacy row that had none — never on a later edit that only touches the reason text (that's what `updatedAt` is for; `deferredAt` answers "since when has it actually been deferred", which `updatedAt` cannot, since it moves on ANY unrelated edit). `null` = never recorded: either genuinely not deferred, or a manual deferral that predates this column (a legacy row) — the migration NEVER backfills a fabricated start time (there is none to recover), so `null` here means exactly "unknown," not "just now." Reset to `null` on an explicit manual clear (`deferred:false`), mirroring `heldBy`'s own reset-on-clear. Untouched by route-(a) deferrals (`deferredUntilTaskId` set) — those already carry their own self-explaining release condition (the named blocker task) by a different mechanism, so this field is deliberately never populated for them.

`deferredReason` is the human-readable REASON / release condition for a manual deferral, paired with `deferredAt`. `updateProjectTask` REJECTS a write that would leave the card manually deferred (`deferred:true`, no `deferredUntilTaskId`) with no reason recorded either before or after the patch — a date alone does not satisfy this field's purpose (the card's own DoD-1 is explicit: "a date alone does NOT satisfy"). `null` = no reason recorded: a legacy row that predates this column (never invented) or a card that has never been manually deferred. Reset to `null` on an explicit manual clear. Not required for a route-(a) deferral — that route's release condition is the named blocker task itself.

## Do not

- Do not bump `deferredAt` on an edit that only touches the reason text — it answers "since when has it actually been deferred", not "when was this last edited" (that's `updatedAt`).
- Do not accept a manual-deferral write with a date but no reason — a date alone does not satisfy this field's purpose; `updateProjectTask` rejects it.
- Do not backfill a fabricated `deferredAt` for a legacy row that predates the column — `null` means "unknown," not "just now."
- Do not require `deferredReason` for a route-(a) deferral (`deferredUntilTaskId` set) — that route's release condition is the named blocker task itself.

## Source

JSDoc comment in `packages/shared/src/types.ts` (`Task.deferredAt` and `Task.deferredReason`'s own doc comments). Extracted by card 555f817f (tranche 3 on `packages/shared/src/types.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
