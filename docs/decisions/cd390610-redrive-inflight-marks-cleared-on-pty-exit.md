# cd390610 — clear a recipient's redrive-in-flight marks on pty exit, not only on drain

`redriveInFlightByMsgId` (sessions/service.ts, a `Map<msgId, recipientId>`) guards against
double-enqueueing a durable `session_message_queued` record when the one-shot boot scan and the
resume/live-flip redrive both observe the same still-live recipient. A message's msgId is added
to this process-local map the instant its redrive is HELD on a recipient's pty FIFO, and —
before this fix — was only ever removed when that held entry actually drained (`onDeliver`,
which calls `resolveQueuedMessage`).

`pty/host.ts`'s exit cleanup (both the claude and codex paths) empties `live.pending` directly
(`live.pending.length = 0`) without firing each entry's `onDeliver`. That's deliberate for the
general case — the durable DB record must stay unresolved so a later boot's recovery scan can
still redrive it. But it meant `redriveInFlightByMsgId` never got cleared for a message whose
holding pty died before draining it.

Consequence (the bug this fixes): once a worker dies while holding a redriven message, EVERY
later same-process redrive attempt for that same recipient — including its own resume/live-flip
— hits the in-flight guard and returns `"reEnqueued"` without actually enqueueing anything. The
durable record then never resolves, so `workerReport`'s pending-direction guard refuses every
`done` from that worker until the whole daemon restarts (a fresh process starts with an empty
Set). A single crashed/recycled pty could silently strand a worker's `done` reports indefinitely.

Fix: `redriveInFlightByMsgId` (a single `Map<msgId, recipientId>` — originally built as a Set
plus a second, recipient-keyed companion index, collapsed into one map during code review so
the two structures can never drift apart) lets `clearRedriveInFlightForExit(recipientId)` clear
exactly that recipient's own held marks, by scanning the map for entries whose value matches
(cheap: the map only ever holds messages genuinely held awaiting drain across the whole fleet,
never a large or unbounded population — a full scan here is not the O(held marks for that
recipient) the original two-structure design gave, but the simplicity of a single source of
truth was judged worth that trade). `clearRedriveInFlightForExit` is called from
`onPtyExit(sessionId)`, a SessionService method that bundles it with the same exit's
`setProcessState`/`setBusy` bookkeeping; `onPtyExit` is what's wired into `PtyHostEvents.onExit`
(index.ts), so every pty death — claude or codex, graceful or hard — clears the recipient's
marks the moment the process is confirmed gone, before any later redrive attempt (e.g. that
same recipient's own resume) can run against a stale mark. Grouping the bookkeeping into one
method (rather than leaving it as separate statements inline in `index.ts`'s `onExit` callback)
means a test can drive the real onExit-facing entry point and so actually exercise the wiring,
rather than calling `clearRedriveInFlightForExit` directly and leaving the index.ts→SessionService
call site itself untested.

This does NOT touch the general `onDeliver`-on-exit behavior (still deliberately not fired) and
does NOT resolve the durable `session_message_queued` record on exit — that record correctly
stays unresolved so a later redrive (same process, post-resume, or a future boot) can still
deliver it for real.

## Do not

- Do not fire a pending entry's `onDeliver` from pty exit cleanup to "solve" this — that would mark
  the durable `session_message_queued` record resolved/delivered even though the message was never
  actually handed to the recipient, which is a worse bug (silent message loss) than the one this
  fixes.
- Do not clear `redriveInFlightByMsgId` wholesale on any exit — scope the clear to the exiting
  recipient's own marks (`clearRedriveInFlightForExit` scans for entries whose value equals the
  exiting recipientId), or a concurrent redrive genuinely in-flight on a DIFFERENT still-live
  recipient would be wrongly unblocked too.
- Do not gate the `redriveInFlightByMsgId.has(msgId)` guard on `recipient.processState === "live"`
  as an alternative fix — a recipient can be live again (freshly resumed) while the stale mark from
  its dead predecessor pty is still set; liveness alone doesn't distinguish "genuinely still held in
  the CURRENT pty's FIFO" from "a residual mark from an already-dead pty instance".
- Do not call `clearRedriveInFlightForExit` (or `db.setProcessState`/`setBusy`) directly from a new
  test or a new call site instead of going through `onPtyExit` — `onPtyExit` is the one method
  `PtyHostEvents.onExit` (index.ts) actually calls; bypassing it leaves the real wiring between
  index.ts and SessionService untested (the gap this card's own code review caught).
