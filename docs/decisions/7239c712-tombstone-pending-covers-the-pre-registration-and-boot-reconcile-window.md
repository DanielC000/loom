# 7239c712 — tombstone `"pending"` also covers the pre-registration and post-restart boot-reconcile window

## Narrative

Card 7239c712: the `pending_gate_ops` tombstone's `"pending"` state covers the genuinely-real window where a row was minted but is not yet visible in the live `GateSemaphore` — either about to register, or, after a real daemon restart, awaiting the next boot's `reconcileOrphanedGateOps`/`reconcileUnsurfacedPendingGateOps` sweep. The op demonstrably EXISTS in either case, so `gate_status` must never collapse this window to `never_existed`.

## `listUnsurfacedPendingGateOps` — the complement set, at the query layer (same card, db.ts)

`Db.listUnsurfacedPendingGateOps` is the boot-time read of the COMPLEMENT set behind the same tombstone-window fact above: rows still `state:'pending'` at boot that were NEVER told "pending" to any caller (`surfaced_pending = 0`). Two paths produce them — a "merge"/"deploy" op minted by a single-synchronous-span call site that never flips `surfaced_pending` at all (`mergeBatch`'s own `insertPendingGateOp` call, and `deployOwnProject`'s), or the much narrower window of a "gate"/"merge" op that crashed between its own mint and either its `onSurfacedPending` flip or its `onSettle` callback. `SessionService.reconcileUnsurfacedPendingGateOps` is this table's sole reader, and these rows get NO synthetic nudge — nobody was ever told "pending" in the first place, so there's no promise to correct. Excludes legacy pre-e3e40167 rows by construction: `migratePendingGateOps` backfills those to `surfaced_pending = 1` specifically so they are not mistaken for this "never surfaced" set.

## Do not

- Do not treat the pre-registration or post-restart-pre-reconcile window as `never_existed` — the tombstone row already exists; `"pending"` is the correct, honest state until the boot sweep (or live registration) catches up.
- Do not push a synthetic nudge for a row `listUnsurfacedPendingGateOps` returns — nobody was ever told "pending" for it, so there's no stale promise to correct.
- Do not let `migratePendingGateOps`'s legacy pre-e3e40167 backfill stay `surfaced_pending = 0` — it must flip to `1`, or those rows get misread as "never surfaced" when they predate the whole surfaced/unsurfaced distinction.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts` (`gateStatus`). Relocated by card `f05ca65c` (tranche 8); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.

The "`listUnsurfacedPendingGateOps`" section above was appended by tranche 3 on `packages/daemon/src/db.ts` (card `d2c20218`), extracted from `Db.listUnsurfacedPendingGateOps`'s own doc comment — same decision, the query-layer complement-set implementation, folded into this existing file per the one-record-per-id rule rather than a new one.
