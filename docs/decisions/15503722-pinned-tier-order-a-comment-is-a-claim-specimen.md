# 15503722 — pinned delivery order replaces key-alphabetical sort; a `a-comment-is-a-claim` specimen

## Narrative

Card 15503722 replaces the original key-alphabetical sort of the pinned tier, which delivered notes by spelling and size, not importance: `db.ts`'s `listPinnedProjectMemory` doc comment already stated the intended order was "newest-updated first," but the consuming function silently discarded that order and re-sorted by key instead — a specimen of this project's own `a-comment-is-a-claim` rule: the DB layer's comment asserted an order its own consumer threw away. (This card's own `updatedAt DESC` fix was itself later superseded by card 6def8bf4's LRU fairness sort — see [[6def8bf4-pinned-tier-lru-fairness-sort]] for why `updatedAt` alone still starves a never-edited note.)

The same card also added the SECOND overflow-visibility surface for the pinned tiers (the first is the in-digest line itself, seen by the spawned agent): a daemon log line for a human/dev scanning logs. `console.error` for a `NEVER_DROP_TAG` drop (a broken guarantee — an operational alarm), `console.warn` for a routine budget drop — kept as two distinct calls so the alarm doesn't read as routine in the logs either.

## Do not

- Do not trust a doc comment's stated ordering claim without checking the consumer actually applies it — this is the concrete case that seeded the project's `a-comment-is-a-claim` rule.
- Do not fold the `NEVER_DROP_TAG` daemon-log line into the same `console.warn` call as a routine pinned-REST drop — the alarm must not read as routine overflow in the logs.

## Source

JSDoc comment above `composeProjectMemoryDigest` in `packages/daemon/src/sessions/project-memory-recall.ts`, lines 356-397 as of tranche 1 on that file (the ordering rationale); the log-severity paragraph is also cited, without new content, in `retrieveProjectMemoryForKickoff`'s own doc comment, lines 716-730 same file/tranche.
