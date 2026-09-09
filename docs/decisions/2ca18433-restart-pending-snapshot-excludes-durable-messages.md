# 2ca18433 — Restart-intent pending snapshot excludes durable-tracked messages (dedup)

## Narrative

Snapshot each resumed session's in-memory pending inbound FIFO so the undelivered queue survives the process death and is replayed on boot (index.ts) — the persisted analogue of recycle's in-process carriedPending. Grab it NOW, while the ptys are still alive (the queue dies with the process on exit). Only non-empty FIFOs are included. Defensive caps keep the intent JSON small: a real FIFO holds a handful of short messages, so clip a pathologically long queue and skip a single absurdly large message rather than bloat the persisted intent.

DEDUP (card 2ca18433): use getPersistablePendingSnapshot, NOT getPending — durable-tracked messages (session_message / message_worker, persisted as `session_message_queued`) are EXCLUDED here because the boot scan (recoverUndeliveredMessagesOnBoot) is their single re-enqueue owner. Were they in BOTH stores, a normal daemon_restart would deliver them TWICE. Non-durable held items (worker reports, idle/resume nudges) carry no callback → stay in the snapshot, replayed as before.

## Do not

- Do not include durable-tracked messages (persisted as `session_message_queued`) in this restart-intent snapshot — `recoverUndeliveredMessagesOnBoot` is their single re-enqueue owner; including them here double-delivers on a normal `daemon_restart`.
- Do not use `getPending` for this snapshot — use `getPersistablePendingSnapshot`, which already excludes the durable-tracked set.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`requestDaemonRestart`): lines 4295-4304, as of commit `6faf27824c7f550d57bfdeb9e4724c7070b82315`. Relocated by card `5b8d2b0c`; no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped. See also `docs/decisions/9e27f4d2-giveupheldsuntil-rides-restart-intents-holds-map.md` (the same snapshot's `giveUpHeldUntil` hold-window field, the very next paragraph at this site) and `docs/decisions/a1b79655-restart-intent-snapshots-cap-queued-worker-spawn-intents.md` (the sibling restart-intent snapshot immediately below, whose own entry-count cap reuses this snapshot's defensive-cap reasoning).
