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

## `reconcileUnsurfacedPendingGateOps` (DoD-3): deliberately no nudge, no recovery, all three kinds

Card 7239c712, DoD-3: this sweep DELIBERATELY PUSHES NO NUDGE, unlike its `reconcileOrphanedGateOps`
sibling — every row it touches has `surfaced_pending=0`, meaning NO caller was EVER told "pending" for
it, so surfacing one now would fabricate a notification for a state nobody observed in the first place.
It also attempts NO durable-history recovery (contrast
`docs/decisions/7d492f8b-find-gate-op-events-is-an-unindexed-boot-only-scan.md`, §2): that recovery
exists to make a PUSHED NUDGE tell the truth; since this sweep pushes no nudge, recovering a real verdict
here would only improve a later `gate_status(opId)` read, not close the gap this method exists for — and
`recoverGateOpVerdict` doesn't accept `kind:"deploy"` today besides. Left a deliberate simplification.

SCOPE covers ALL THREE kinds, including "deploy" — deliberately WIDER than `reconcileOrphanedGateOps`'s
own `deploy` exclusion. That exclusion exists there only because a "deploy" row can never be
`surfaced_pending=1` (a defensive no-op, not a real filter) — it says nothing about whether deploy's OWN
unsurfaced-tombstone exposure should be swept. `deployOwnProject` mints and settles back-to-back in one
synchronous span by design; a daemon death anywhere inside that span strands it `pending` forever with
nothing else to reconcile it. `mergeBatch` is exposed to the IDENTICAL failure mode for the same reason
despite its now-wider window (`docs/decisions/81d795de-mergebatch-settle-deferred-to-whole-batch-completion.md`)
— `surfaced_pending` is never flipped for either mint site, and this sweep's own unsurfaced-row scan
covers both regardless of span width. Since this sweep pushes no nudge regardless of kind, none of
`reconcileOrphanedGateOps`'s "wrong re-run advice for a batch" reasoning for excluding deploy applies
here — narrowing to "gate"/"merge" only would leave deploy's identical exposure unclosed for no reason.
Runs alongside `reconcileOrphanedGateOps` at boot; order between the two does not matter, since they
operate on disjoint row sets (`surfaced_pending=1` vs `=0`).

### Do not (2)

- Do not push a recovered/synthetic nudge from this sweep — every row it touches was never told "pending"
  in the first place, so there is no stale promise to correct; that would fabricate a notification.
- Do not narrow this sweep's kind coverage to "gate"/"merge" by analogy with `reconcileOrphanedGateOps`'s
  own deploy exclusion — that exclusion is a defensive no-op there (deploy can't reach it anyway), not a
  reason to leave deploy's own unsurfaced-tombstone exposure unswept here.

### Source (2)

Inline comment in `packages/daemon/src/sessions/service.ts`, above `reconcileUnsurfacedPendingGateOps`:
lines 6494-6526, as of main `055e96ce`. Relocated by card `c7ca6c08` (tranche 16); no wording changed,
wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
