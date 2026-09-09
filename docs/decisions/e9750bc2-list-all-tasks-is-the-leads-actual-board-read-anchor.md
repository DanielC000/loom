# e9750bc2 — `list_all_tasks` is the Lead's ACTUAL board-read anchor, and recording it on `countsOnly` too is a deliberate, hazard-accepting trade-off

## Narrative

This is the Lead's ACTUAL board-read anchor — `recordBoardRead`'s only call site used to be `mcp/server.ts`'s `tasks_list` handler, which a Lead's own doctrine never calls (it reads through `list_all_tasks` instead), so the idle nudge's board-delta digest never computed for a platform session in practice. Recorded for EVERY project this call scanned (`projectIds` — every live project when unfiltered, or the single narrowed one), independent of `columns`/`includeDone`/pagination — same "snapshot the whole non-terminal board regardless of this call's own filter" contract `recordBoardRead` already has for `tasks_list`. `!callerSessionId` mirrors `session_transcript`'s own guard (no caller session on a non-real request path).

Recorded on `countsOnly` TOO (deliberately, not by default) — the Lead's standing park-check convention is `list_all_tasks({countsOnly:true})`, the cheapest way to detect arrivals, so anchoring only on the (rarer) full-row path would leave the digest permanently uncomputed for a Lead that only ever parks via `countsOnly`. ACKNOWLEDGED HAZARD (demonstrated in `list-all-tasks-records-board-read.mjs`): this moves the anchor forward WITHOUT the Lead having seen card contents. Concretely — content read at T0, a card changes, `countsOnly` at T1 (anchor moves to T1 even though only a count was seen), another change, digest at T2 → the digest reports ONLY the T1→T2 change; the T0→T1 change is silently folded into what "already seen" means and never separately surfaced. Accepted trade-off: a `countsOnly` result already surfaces the count change itself (the Lead sees the total move and re-reads), so the change is never truly invisible — just not itemized in this one digest.

## Do not

- Never "fix" this by skipping `countsOnly` recording — that would just resurrect the exact permanently-uncomputed digest bug card `e9750bc2` exists to close (the digest never computing for a Lead that only ever parks via `countsOnly`).
- Do not assume the T0→T1 window is lost information the Lead never sees — a `countsOnly` result already surfaces the total-count move, which is why the trade-off was accepted rather than treated as a bug to fix.

## Source

Inline comments in `packages/daemon/src/mcp/platform.ts` (`list_all_tasks` handler, lines 2640-2660 as of this tranche's HEAD, prior to compression), positive-controlled against `test/list-all-tasks-records-board-read.mjs`. Relocated by card `b721401b` (tranche 1 on `mcp/platform.ts`).
