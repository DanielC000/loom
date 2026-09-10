# 6def8bf4 — the pinned tier sorts by never-delivered-first LRU fairness, not `updatedAt`

## Narrative

Card 6def8bf4 replaces card 15503722's pure `updatedAt DESC` sort, which fixed the ORIGINAL key-alphabetical starvation but introduced a NEW one: a pinned note that is never edited after creation keeps the exact same `updatedAt`, so its sort position never changes between kickoffs — once the budget is tight, that note loses to the same higher-ranked notes on EVERY kickoff, forever (measured live on this project: 4 pinned notes dark for 19 days).

`retrievalCount` alone was rejected then for being self-reinforcing (a note the old bug already starved has `retrievalCount:0` and stays there); `lastRetrievedAt` doesn't have that problem — it's a TIMESTAMP a delivery updates (`db.touchProjectMemoryRetrieved`, called for every note `composeProjectMemoryDigest` actually includes), so ranking by it directly INVERTS starvation instead of entrenching it: a never-delivered note (`null`) gets top priority; the instant it IS delivered, its stamp becomes the newest in the corpus and it rotates to the back until every other note has had a turn. This converges to full coverage within a bounded number of kickoffs for any note that can individually fit the budget at all — a note that can't (a single oversized note exceeding `budgetTokens` on its own) is the pre-existing, separately-tracked size/budget case (see `NEVER_DROP_TAG`'s own doc comment and card 0186576f), not something ordering can fix.

`updatedAt` stays the secondary tiebreak deliberately: among notes tied on `lastRetrievedAt` (most commonly a bulk of never-delivered notes, all `null`), a freshly-edited note plausibly matters more RIGHT NOW than a stale one that's equally never-been-seen — preserving the useful half of card 15503722's original reasoning underneath the new fairness key. `key` ascending is the final deterministic tiebreak. Backward-compatible with any all-null-`lastRetrievedAt` corpus (e.g. every existing test fixture, and any project's first-ever kickoff): every entry ties on the primary key, so the sort degrades EXACTLY to the pre-this-card `updatedAt DESC, key ASC` order.

## Do not

- Do not sort the pinned tier by `retrievalCount` alone — it's self-reinforcing and never recovers a note the old bug already starved.
- Do not drop the `updatedAt` secondary tiebreak — among null-`lastRetrievedAt` ties, a freshly-edited note still plausibly matters more right now.
- Do not assume LRU ordering alone fixes a single oversized note exceeding `budgetTokens` — that's the separate `NEVER_DROP_TAG` size/budget case (card 0186576f), not something ordering can fix.

## Source

JSDoc comment above `sortPinnedByRecency` in `packages/daemon/src/sessions/project-memory-recall.ts`, lines 242-264 as of tranche 1 on that file.
