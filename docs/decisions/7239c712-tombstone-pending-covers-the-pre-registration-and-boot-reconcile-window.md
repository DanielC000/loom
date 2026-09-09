# 7239c712 — tombstone `"pending"` also covers the pre-registration and post-restart boot-reconcile window

## Narrative

Card 7239c712: the `pending_gate_ops` tombstone's `"pending"` state covers the genuinely-real window where a row was minted but is not yet visible in the live `GateSemaphore` — either about to register, or, after a real daemon restart, awaiting the next boot's `reconcileOrphanedGateOps`/`reconcileUnsurfacedPendingGateOps` sweep. The op demonstrably EXISTS in either case, so `gate_status` must never collapse this window to `never_existed`.

## Do not

- Do not treat the pre-registration or post-restart-pre-reconcile window as `never_existed` — the tombstone row already exists; `"pending"` is the correct, honest state until the boot sweep (or live registration) catches up.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts` (`gateStatus`). Relocated by card `f05ca65c` (tranche 8); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
