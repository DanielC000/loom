# 60b26261 — `reportEventId` purges a queued report nudge the manager already read, without a worker-id ambiguity

## Narrative

Card 60b26261 (worker-report drop-on-read follow-up): `reportEventId` is the SAME shape of tag `questionId`
is, one field down on `QueuedMessage` — it OPTIONALLY tags a queued `[loom:worker-report] …` nudge with the
`worker_report` orchestration event's own id, the same id `worker_report_get` returns as `eventId`. Only
`SessionService.workerReport`'s manager-bound push sets it (stamped with the id it just gave
`db.appendEvent` for that same report); every other caller leaves it undefined.

It exists so `purgeQueuedByReportEventIds` can find and drop a still-queued copy of a report the manager
already read straight from durable storage via `worker_report_get` — WITHOUT keying on the worker id. A
worker id is deliberately NOT used as the purge key here: a worker can file `progress` then `done` in
succession, and purging by worker id would silently drop an UNREAD earlier report along with the read one.
This is unlike `purgeQueuedWorkerIdleNudges`, which safely keys on worker id because there is only ever one
live idle-nudge per worker at a time — no such ambiguity to guard against there, which is why that helper
uses a different key and this one deliberately does not.

## Do not

- Do not purge a queued worker-report nudge by worker id — a worker can file `progress` then `done`, and a
  worker-id key would drop an unread earlier report along with a read later one. Key on `reportEventId`
  (the specific report event already read) instead.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `reportEventId` field doc on `QueuedMessage`), as
of commit `663bb1ba7398012ff4edb733f31b117712987ff4`. Relocated by card `3f45b7d8` (tranche 6 on
`pty/host.ts`).
