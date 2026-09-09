# b9161ad2 — an archived-sessions page must expose its own clamp, and a search filter must apply before paging

## Narrative

`listArchivedSessionsPage` returns a BOUNDED page of a project's archived sessions, newest-archived first, plus the TOTAL row count (for a "N of total — Load more" list UI). `limit` is clamped into `[1, MAX_ARCHIVED_PAGE]`; the method returns the EFFECTIVE (post-clamp) `limit` too — a caller that requested more than `MAX_ARCHIVED_PAGE` must be able to tell it was silently capped. This closes a Code Review finding on the card's first pass: an oversized requested limit with no way to observe the clamp made a client's own "load more until done" logic dead-end forever at the cap while `total` kept claiming more existed.

Card b9161ad2 then adds an optional `q` that filters server-side by a case-insensitive substring match against session id / agent name / role / task id / branch — the same fields Archive.tsx's own client-side search used to match — applied BEFORE the `LIMIT`/`OFFSET`, so a query reaches the FULL archived set for this project rather than only the pages already fetched. `total` is recomputed under the SAME filter so paging/`hasMore` stay correct while a query is active. Omitted/blank `q` is unfiltered, byte-identical to the pre-filter behavior (the no-search COUNT is untouched, still the original join-free query). The cross-project sibling `listAllArchivedSessionsPage` mirrors this exactly, plus project name in the search and an optional `role` filter that scopes the page to one `SessionRole` BEFORE limit/offset apply (card 9f010283).

## Do not

- Do not let a client apply search client-side over already-fetched pages — that dead-ends short of the real filtered total, the exact trap this card's server-side `q` (applied before LIMIT/OFFSET) avoids.
- Do not omit the effective (post-clamp) `limit` from the response — a caller requesting more than `MAX_ARCHIVED_PAGE` must be able to observe the cap, or its "load more until done" logic dead-ends forever.

## Source

Inline comment in `packages/daemon/src/db.ts` (`listArchivedSessionsPage` and `listAllArchivedSessionsPage`): lines 4991-5034, as of this tranche's HEAD.
