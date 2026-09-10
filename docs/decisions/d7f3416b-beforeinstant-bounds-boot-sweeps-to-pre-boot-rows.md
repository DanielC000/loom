# d7f3416b — `beforeInstant` bounds a boot-time orphan sweep to rows minted strictly before THIS boot

## Narrative

Card d7f3416b: `beforeInstant` (an ISO string) is the caller's captured boot instant, threaded straight
into a boot-time reconcile sweep's own row query. It bounds the sweep to rows minted strictly before the
CURRENT process started, so an op minted during this very boot — still genuinely running — can never be
mistaken for a restart orphan just because it happens to still be `state:'pending'` when the sweep runs.
Without this bound, an ordinary op minted moments after boot would be swept (and wrongly marked
`orphaned-by-restart`) purely because nothing yet distinguishes "minted this boot, still running" from
"minted before a prior crash, stranded pending" — both look identical as a bare `state:'pending'` row.
Used identically by both `reconcileOrphanedGateOps` (the `surfaced_pending=1` candidate set) and
`reconcileUnsurfacedPendingGateOps` (the `surfaced_pending=0` complement set) in this file.

## Do not

- Do not sweep `state:'pending'` rows for restart-orphan reconciliation without a `beforeInstant` bound —
  a row minted during the current boot is indistinguishable, by state alone, from one truly stranded by a
  prior crash.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, above `reconcileOrphanedGateOps`: lines
6449-6452, as of main `055e96ce`. Relocated by card `c7ca6c08` (tranche 16); no wording changed, wrapped
source lines joined into a flowing paragraph and the `*` comment markers stripped. The same fact is
re-cited (not re-derived) at `reconcileUnsurfacedPendingGateOps`'s own doc, and again in `db.ts`/
`index.ts` at other call sites — those are out of this tranche's file fence.
