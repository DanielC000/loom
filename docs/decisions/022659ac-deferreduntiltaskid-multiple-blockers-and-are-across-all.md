# 022659ac — `deferredUntilTaskId` widens to MULTIPLE blockers, ANDed for release, ORed for stuck

## Narrative

Card 022659ac widened `Task.deferredUntilTaskId` (see docs/decisions/793ac76d-deferreduntiltaskid-auto-clears-deferred-on-observed-merge.md for the single-blocker mechanism this extends) to accept an array of task ids/prefixes, each resolved to a full id under the same rules as the single-id form: must exist on this board, self-reference rejected.

`deferred` auto-clears only once ALL named blockers have a non-null `merged` — see `resolveDeferredEffective`'s own doc for why: a card genuinely blocked on two things is not unblocked by one of them landing. `deferredStuck` is the OR across all of them instead: ANY one dangling or closed-with-no-merge makes the whole deferral stuck, even while the others are still cleanly pending — it never waits for all of them to independently go bad. So the two derived signals use opposite quantifiers over the same blocker list, deliberately: release requires ALL, stuck requires ANY.

Read/write ALWAYS collapses a single resolved id back to a bare string (never a 1-element array) — this keeps every existing single-blocker caller (and every persisted single-blocker row) byte-identical; the array shape is reserved for a genuine 2+-blocker deferral.

Storage note (db.ts): a single id is still persisted as the bare TEXT value it always was (this is also why a PRE-existing legacy row — written before this card, always a bare id string — needs no migration and no format change); 2+ ids are persisted as a JSON array in the same TEXT column, distinguished on read by whether the stored text starts with `[` (a real id never does).

## Do not

- Do not clear `deferred` until EVERY named blocker in a multi-blocker array has a non-null `merged` — one landing does not unblock a card genuinely blocked on several.
- Do not wait for all blockers to go bad before setting `deferredStuck` — it is an OR across the array: any one dangling or closed-with-no-merge trips it.
- Do not persist a single-blocker deferral as a 1-element array — read/write always collapses it back to a bare string, keeping every existing caller and stored row byte-identical.

## Source

JSDoc comment in `packages/shared/src/types.ts` (`Task.deferredUntilTaskId`'s own doc, the "MULTIPLE blockers" paragraph). Extracted by card 555f817f (tranche 3 on `packages/shared/src/types.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
