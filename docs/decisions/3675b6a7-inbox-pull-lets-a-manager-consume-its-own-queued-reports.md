# sha:3675b6a7 — `inbox_pull` lets a manager consume its own busy-gated inbox instead of waiting for it to drain

## Narrative

A worker report enqueued while its manager is mid-turn sits in `live.pending` (`delivered:false`)
and otherwise only drains on the next turn boundary via `drainPending` (coalesced — the whole queue
lands as one turn). A manager that has already handled the work proactively — it read each worker's
transcript directly and acted on it — would then get those same, now-stale queued copies re-surfaced
as a wasted turn later. This is NOT duplicate delivery; it is the single queued copy draining late.

`pullManagerInbox` (the `inbox_pull` MCP tool, manager surface only) adds the consume side of the
existing read-only pending-queue mechanism: it returns AND removes every queued, not-yet-delivered
inbound message for the manager's OWN session in one call, so it can consume the whole inbox at once
and discard or act on it as it sees fit. The manager's id is derived server-side from the URL path
(nothing to spoof), so this only ever drains the caller's own queue — mirrors `recordIdleReport`'s
role gate.

The underlying `worker_report` (and other) events stay recorded in the DB regardless — this only
clears the in-memory delivery queue, never the audit log. The auto-drain remains the safety net for
a manager that doesn't pull; a pulled message is removed from the same FIFO, so it can't also drain
later and reach the manager twice.

## Source

Inline JSDoc on `pullManagerInbox` in `packages/daemon/src/sessions/service.ts`, as of commit
`3675b6a75d0c1787b5d49a4ddcd10fafe3ebd673` (`feat(daemon): inbox_pull — let a manager consume its own
busy-gated inbox`) — no board card cited anywhere in the block or that commit; keyed by commit sha
per the extraction program's `sha:` grammar (extraction tranche 33).
