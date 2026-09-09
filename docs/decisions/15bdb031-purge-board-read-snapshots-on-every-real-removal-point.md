# 15bdb031 — purge a retired session's board-read snapshot on every real removal point, soft archive included

## Narrative

Card 15bdb031: `purgeBoardReadSnapshots` deletes every board-read snapshot a session left behind (see `BOARD_READ_META_PREFIX`'s own doc for why this is a prefix delete rather than one exact key). It's called from every real per-session removal point (`archiveSession`/`deleteSession`/`deleteProject`/`deleteAgent`) so a retired session's snapshot never outlives it, regardless of which removal path a caller used. Idempotent — a session with no recorded read matches nothing.

It is deliberately called from `archiveSession` too, even though that's a SOFT archive (row retained, `restoreSession` can bring it back) — not an oversight. Purging only on the hard-delete paths would leave the leak in place for nearly every session, since most sessions are archived on exit and never hard-deleted, which would largely defeat the point of this card. An archived-then-restored session simply comes back with NO board-read baseline — its next `computeBoardDelta` reads `computed:false` exactly like a brand-new session, and the one after that just has a WIDER delta (more cards read as "created" than actually were) until it re-records on its own next genuine board read. Never wrong, only momentarily less precise — the same bounded, benign cost this whole card accepts in exchange for not leaking forever.

## Do not

- Do not skip purging on `archiveSession` because it's a soft archive — that would leave the board-read snapshot leaking for nearly every session, since most sessions are archived on exit rather than hard-deleted.
- Do not treat a restored session's post-restore `computed:false` / widened delta as a bug — it's the accepted, bounded, self-correcting cost of purging on soft archive.

## Source

Inline comment in `packages/daemon/src/db.ts` (`purgeBoardReadSnapshots`): lines 3177-3191, as of this tranche's HEAD.
