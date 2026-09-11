# af87a9ff — why Archive nests by the original dispatcher, and why paging is TRUE offset, not a grown limit

## Narrative

Why not `parentSessionId` alone: it is reparented onto a recycle successor for a worker that was still live when its manager recycled (card af87a9ff).

Why the grown-limit dead-end was found: a grown-limit request would eventually exceed the server's `MAX_ARCHIVED_PAGE` clamp and get silently truncated, dead-ending "Load more" forever while `total` kept claiming more rows existed — code review finding on the first pass of this card, on the live instance's real 2137-row archive.

## Source

Inline comment in `packages/web/src/pages/Archive.tsx` (the page's own module header + the `ARCHIVE_PAGE_SIZE` constant's doc) — Class A/C description restored inline; this record carries only the WHY (mechanism + incident) behind each rule.
