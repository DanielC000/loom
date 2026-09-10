# 2ca18433 — durable-message dedup: the restart-intent snapshot excludes them, and `onDeliver` fires only on a real drain

## Restart-intent pending snapshot excludes durable-tracked messages (dedup)

Snapshot each resumed session's in-memory pending inbound FIFO so the undelivered queue survives the process death and is replayed on boot (`index.ts`) — the persisted analogue of recycle's in-process `carriedPending`. Grab it NOW, while the ptys are still alive (the queue dies with the process on exit). Only non-empty FIFOs are included. Defensive caps keep the intent JSON small: a real FIFO holds a handful of short messages, so clip a pathologically long queue and skip a single absurdly large message rather than bloat the persisted intent.

DEDUP: use `getPersistablePendingSnapshot`, NOT `getPending` — durable-tracked messages (`session_message`/`message_worker`, persisted as `session_message_queued`) are EXCLUDED here because the boot scan (`recoverUndeliveredMessagesOnBoot`) is their single re-enqueue owner. Were they in BOTH stores, a normal `daemon_restart` would deliver them TWICE. Non-durable held items (worker reports, idle/resume nudges) carry no callback → stay in the snapshot, replayed as before.

**Do not:**
- Do not include durable-tracked messages (persisted as `session_message_queued`) in this restart-intent snapshot — `recoverUndeliveredMessagesOnBoot` is their single re-enqueue owner; including them here double-delivers on a normal `daemon_restart`.
- Do not use `getPending` for this snapshot — use `getPersistablePendingSnapshot`, which already excludes the durable-tracked set.

## `onDeliver` fires only on a real drain/pull, never on the immediate idle-submit path

`onDeliver` is an OPTIONAL, additive delivery callback on a queued FIFO entry (`pty/host.ts`): set ONLY by `SessionService`'s durable-message helpers, it fires the instant this held entry is actually HANDED to the recipient — at the next Stop drain (`drainPending`) or via `inbox_pull` (`consumePending`) — so the durable queued-message event can be marked delivered. It is NEVER invoked on the immediate idle-submit path (that returns `delivered:true` synchronously and persists nothing), so the load-bearing M1/M2 busy-gate ordering is untouched; for every existing (non-messaging) entry it is undefined → a no-op. Internal to the host (stripped from `getPendingEntries`, never persisted), the callback dies with the pty like the queue.

It takes an OPTIONAL `reason`: the drain/pull paths call it with NO arg (a plain delivery), while a caller that RETIRES a held entry rather than delivering it — `flushPending`'s consumer (`worker_redirect`) — passes a reason ("superseded") so the resolution event records WHY.

(The same queued-FIFO-entry struct also carries `id` — a stable, server-minted handle so the human UI can delete/edit/reorder a SPECIFIC entry despite the FIFO draining autonomously between a poll and a click — and `source` ('human' vs 'system'), the trust boundary those mutators enforce: delete/edit/reorder may only touch a 'human' entry.)

**Do not:**
- Do not invoke `onDeliver` from the immediate idle-submit path — that path already returns `delivered:true` synchronously; firing it there would double-count delivery and risk the load-bearing M1/M2 busy-gate ordering.
- Do not let a human-facing delete/edit/reorder mutator touch a `source: 'system'` entry — that boundary stops an agent's queued report from being rewritten out from under it.

## `recoverUndeliveredMessagesOnBoot` is the single re-enqueue owner

The OTHER half of the dedup above: `recoverUndeliveredMessagesOnBoot` (`sessions/service.ts`) is the one
place a still-undelivered durable `session_message_queued` record gets acted on after a restart, boot,
or crash — since the intent snapshot never carries one, this scan is the ONLY redrive path. Runs ONCE at
boot (`index.ts`, after the fleet resumes), covering every case the intent snapshot misses (crash,
OS-service restart, non-live recipient at restart time), not just a plain `daemon_restart`.

Per still-undelivered message (after the `mintedBefore` skip — see `docs/decisions/06ebbb78-…md`):
LIVE recipient → re-enqueue with the SAME `msgId`, delivery proven at the next turn boundary, never
assumed at dispatch; GONE/superseded/archived → RETIRE (`reason:"recipient-gone-or-superseded"`), so the
undelivered set can't grow unbounded; EXISTS but not live → left for a later boot. Every still-stuck
message is then surfaced to its live sender to re-send — best-effort, never throws.

## Do not (2)

- Do not add a second re-enqueue path for a pre-boot message — this scan is the sole owner.
- Do not silently drop a stuck message — surface it to the live sender instead.

## Source (3)

JSDoc above `recoverUndeliveredMessagesOnBoot`, `service.ts` lines 5059-5108, as of main `1cbc0d74`.
Relocated by card `61632c05` (tranche 15). The `mintedBefore` mechanism this JSDoc also described is out
of scope here — see `docs/decisions/06ebbb78-resumefleetonboot-routes-through-enqueuedurablenudge.md`.

## Source

- `packages/daemon/src/sessions/service.ts` (`requestDaemonRestart`): lines 4295-4304, as of commit `6faf27824c7f550d57bfdeb9e4724c7070b82315`. Relocated by card `5b8d2b0c`. See also `docs/decisions/9e27f4d2-giveupheldsuntil-rides-restart-intents-holds-map.md` and `docs/decisions/a1b79655-restart-intent-snapshots-cap-queued-worker-spawn-intents.md`.
- `packages/daemon/src/pty/host.ts` (the queued FIFO entry interface doc, `onDeliver`/`id`/`source` fields), as of commit `1974444dc94618d380f474192e22edff20215ec5`. Relocated by card `de94a415` (tranche 2 on `pty/host.ts`). Folded into this pre-existing `2ca18433` record (rather than a second file) after card `de94a415`'s tranche 2 created a same-id collision the injector's one-record-per-id resolution can't serve — see that card's `worker_report` for the mechanism.
