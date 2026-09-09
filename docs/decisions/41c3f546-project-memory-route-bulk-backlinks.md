# 41c3f546 — `GET /api/projects/:id/memory` uses `findInboundBacklinksBulk`, one corpus fetch per request

## Narrative

`GET /api/projects/:id/memory` is the read-only, per-project window into `project_memory` (the durable knowledge the fleet writes + recalls via the `memory` MCP: `memory_write`/`read`/`list`/`forget`). PROJECT-SCOPED: the DB query filters by `projectId` (`WHERE project_id = ?`), so this ONLY ever returns THIS project's own memory — never another project's. It calls `db.listProjectMemory` DIRECTLY (raw rows, no `requestAnnotations`) rather than the `memory_list` MCP tool's business logic — that tool wraps the same rows with a live-resolved-request-link annotation (card `e6d270b3`); this route deliberately doesn't, since the owner viewing this page can already see a request's live state via the Requests UI directly. Returns full entries — pinned flag + retrievalCount + updatedAt + the note text — so a single list read backs BOTH the entry list and the note-detail body. HUMAN-only loopback read, same trust posture as the sibling `/board` + `/vault` project reads; READ-ONLY — no write/forget surface here (curation stays the memory MCP's job).

The "corpus is small by design: dozens to low-hundreds of short notes" premise this route's own comment used to cite is stale (this project's own store already measured at 487 notes, 2026-09-03; see `project-memory-backlinks.ts`'s `findInboundBacklinks` doc comment for the live reconciliation). This route stays safe at that scale ONLY because backlinks are resolved via `findInboundBacklinksBulk` over one fetched corpus, not per row: the per-row shape used to mean N+1 `db.listProjectMemory` fetches and N full-corpus regex scans for a listing of N notes — measured at ~4.2s wall-clock (synchronous, blocking the daemon's single event loop for the whole request) against this project's own 487-note corpus, versus ~15ms for the bulk path over the identical corpus and cap. `corpus` here is fetched exactly once and reused for every row's backlink lookup.

## Do not

- Do not resolve `backlinks` per row (one `findInboundBacklinks` call per note) — that reintroduces the N+1-fetch, N-full-corpus-scan cost measured at ~4.2s (vs ~15ms bulk) against a 487-note corpus, blocking the daemon's single event loop for the whole request.
- Do not assume the corpus stays "dozens to low-hundreds" — that premise is already stale (487 notes measured); this route's safety at scale depends on the bulk path, not on corpus size staying small.

## Source

Inline comment in `packages/daemon/src/gateway/server.ts` (`GET /api/projects/:id/memory`, lines 3768-3801 as of commit `a9b55042`). Relocated by card `2bf0b41d`; wording condensed, no substantive detail dropped.
