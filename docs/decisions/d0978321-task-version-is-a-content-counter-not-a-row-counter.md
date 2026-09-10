# d0978321 — a task's `version` bumps only on title/body writes, and only `updateTaskChecked` gates on it

## Narrative

Card d0978321: `version` is a CONTENT counter, not a row counter — it advances only when a patch actually touches `title`/`body`. Bumping on every field-only move (column/priority/held/deferred) would make a body-composer's `baseVersion` go stale from an unrelated write, spuriously rejecting a healthy concurrent edit that never touched the prose at all.

`updateTask` is the ONLY place `version` is ever written — BLIND (no CAS check), mirroring `upsertProjectMemory` staying blind while `upsertProjectMemoryChecked` gates. Every caller of `updateTask` (the deferred-state write-through, the back-note append, the human REST route, ship-state writes, column repair) still correctly bumps it when it happens to touch title/body, which is exactly what lets a LATER stale agent write get caught by `updateTaskChecked` even though THIS write itself wasn't gated.

`updateTaskChecked` is an optimistic-concurrency-guarded wrapper around `updateTask`, mirroring `upsertProjectMemoryChecked`'s exact shape: wrapped in one `db.transaction()` so the read-current + conditional-write stays atomic, compares `baseVersion` against the row's CURRENT `version` (a stale OR omitted base against an existing row is rejected — omission is deliberately treated the same as staleness, since an update to an EXISTING row with no base at all is indistinguishable from a blind clobber), and returns `{ok:false, current}` instead of writing, so the caller can reconcile/merge and retry with the fresh version. The CALLER (`mcp/tasks.ts`'s `updateProjectTask`) decides WHEN to reach for this instead of the plain, blind `updateTask` — exactly when the patch touches `title`/`body` (field-only moves must never be gated). This function itself has no opinion on that.

## Contrast with `ProjectMemoryEntry.version`

`Task.version` mirrors `ProjectMemoryEntry.version`'s monotonic-INTEGER rationale (never derived from `updatedAt`, which can collide across two distinct writes on a coarse clock) but is UNLIKE it in one load-bearing way: `ProjectMemoryEntry.version` bumps on every write, because a memory note IS its content, while `Task.version` advances ONLY WHEN `title` OR `body` ACTUALLY CHANGES. A field-only move (`columnKey`, `priority`, `held`, `deferred`, `position`, `repoKey`, `deferredUntilTaskId`, `deferredAt`, `deferredReason` — including the read-time deferred-auto-clear write-through) leaves it untouched. Do NOT read an unchanged `version` across two reads as "the card is unchanged" — it only means "the title/body haven't changed"; the card may have moved column, changed priority, been held, or auto-cleared its deferral in between.

## Do not

- Do not bump `version` on a field-only patch (column/priority/held/deferred) — that would spuriously stale-reject a healthy concurrent title/body edit that never touched those fields.
- Do not treat an omitted `baseVersion` against an existing row as safe to apply — it's rejected the same as a stale one, since it's indistinguishable from a blind clobber.
- Do not gate a field-only move through `updateTaskChecked` — the caller must reach for the plain, blind `updateTask` for those, per this card's DoD.
- Do not read an unchanged `Task.version` across two reads as "the card is unchanged" — it only means the title/body haven't changed; the card may have moved column, changed priority, been held, or auto-cleared its deferral in between.
- Do not assume `Task.version` bumps on every write the way `ProjectMemoryEntry.version` does — a memory note IS its content, but a task's field-only moves are deliberately excluded.

## Source

Inline comment in `packages/daemon/src/db.ts` (`updateTaskChecked`, plus `updateTask`'s own inline `version`-bump comment): lines 6225-6234 and 6250-6264, as of this tranche's HEAD.

The "Contrast with `ProjectMemoryEntry.version`" section above was appended by tranche 3 on `packages/shared/src/types.ts` (card 555f817f), extracted from `Task.version`'s own doc comment — same decision, the type-level field contract, folded into this existing file per the one-record-per-id rule rather than a new one.
