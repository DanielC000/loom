# 02621025 — retiring a stale queued message is exception-scoped, not a general staleness rule

## Narrative

Card 02621025: `staleQueuedMessageReason` decides whether a durable `session_message_queued` record `e`
is safe to retire, rather than redrive, for `recipientId`. ONE shared timeline fetch
(`db.listEventsForWorker`, already ts-ordered) backs both checks below — there are exactly two, and
nothing else retires a record.

1. **Superseded by a later redirect.** `worker_redirect`'s own contract already declares "flush +
   supersede ALL pending direction" (`deliverRedirect`'s step (a): `pty.flushPending` +
   `onDeliver("superseded")`). But that flush only reaches whatever is sitting in the LIVE
   `live.pending` FIFO at redirect-send time. If the recipient wasn't live then (crashed / not yet
   resumed), `flushPending` finds nothing to supersede, and this durable record is the ONLY surviving
   trace of the direction the redirect had already declared dead. Retiring it here at redrive time just
   extends that SAME declared semantics into the gap `flushPending` couldn't reach — it is not new
   supersession policy.

   SELF-MATCH HAZARD (caught in review — do not "fix" by relying on `ts` alone): a HELD redirect
   enqueues its OWN `session_message_queued` record (inside `enqueueDurableMessage`) and THEN appends
   its sibling `redirect_worker` event (`deliverRedirect`, after the enqueue) — two SEPARATE `new
   Date()` calls, so the sibling event's `ts` is typically AT OR AFTER its own record's `ts` (not a rare
   millisecond-boundary edge case — it's the ordinary case, since real work, including
   `interruptForRedirect`, runs between the two timestamps). A plain `ev.ts > e.ts` scan would treat a
   redirect's own just-queued record as "superseded by itself" and silently drop it — the exact
   silent-direction-loss failure this card exists to prevent, just relocated to the redirect arm. So
   this excludes the sibling by IDENTITY, not timing: `deliverRedirect` stamps `detail.queuedMsgId` on
   its `redirect_worker` event with the exact `msgId` of the `session_message_queued` record it just
   created (when held) — a `redirect_worker` event only counts as "later" if its `queuedMsgId` is
   something OTHER than `e`'s own `msgId`, i.e. it is a genuinely different, independent redirect.

2. **Already reported.** The worker submitted a `worker_report` for the SAME taskId after this record
   was queued. Whatever this instruction was asking it to check/commit/report has a known outcome
   already; redriving it just re-asks an already-answered question. This is the origin incident's
   actual shape (card 39cbe5b5): the worker recognized the redriven text as something it "already
   completed" — i.e. a `worker_report` for that task had already landed between this record's queue
   time and its redrive. No self-match hazard here: a `session_message_queued` and a `worker_report` are
   never siblings of the same call, so `ev.id !== e.id` (always true across different kinds) is
   sufficient.

DELIBERATELY NOT triggered by a later PLAIN `message_worker` / `session_message` — `worker_message` is
ADDITIVE by contract (a manager routinely sends "fix finding 1" then, separately, "also fix finding 2").
Retiring an older queued record merely because a newer additive one exists would SILENTLY DESTROY
manager-authored content — the same failure class this card fixes (a directive never executed), just
with worse, invisible blast radius (no worker ever sees a stale-and-wrong redrive to notice; the
instruction just vanishes). Two co-pending DURABLE records for the same recipient already redrive in
chronological order (`ORDER BY ts, rowid` in `listUndeliveredQueuedMessages` /
`listUnresolvedQueuedMessagesForWorker`); the only way order breaks is a newer message that bypassed the
durable table by delivering as an immediate live turn, and the daemon cannot rewind an already-executed
turn to "demote" the older one behind it — so that case is left to redrive as today, unchanged by this
guard.

## Do not

- Do not compare `ev.ts > e.ts` alone to decide "later" for the redirect-supersede check — a HELD
  redirect's own just-queued record and its sibling `redirect_worker` event are typically stamped in
  that order with `ts` ties or near-ties, so a raw timestamp compare treats a redirect as superseding
  itself. Exclude the sibling by identity (`detail.queuedMsgId !== e.msgId`), never by timing.
- Do not retire an older queued record merely because a newer PLAIN `worker_message`/`session_message`
  exists for the same recipient — `worker_message` is additive by contract, and treating a newer one as
  superseding silently destroys manager-authored content with no trace.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`staleQueuedMessageReason`'s own JSDoc):
lines 5294-5337, as of commit `44cc810878d23339041505a9c3e1e9f275cc5709` (`fix(sessions): don't redrive
a stale queued instruction over newer manager direction`). Relocated by card `61632c05` (tranche 15);
no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers
stripped.
