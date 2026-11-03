# 3dee1d51 — the manager emergency-recycle interrupt must enqueue at the queue HEAD, not the FIFO tail

## Context

`SessionService.redirectManagerForEmergencyRecycle` (card `9f279c7b`, Trigger A) reuses the shared
`deliverRedirect` core with `supersedeQueue:false` — it never flushes a manager's own queue, because that
queue can hold OTHER parties' inbound content (a worker's `worker_report`, a `peer_message`, a platform
`session_message`) this interrupt has no business discarding.

Before this card, it enqueued without `headInsert`, so the emergency text landed at the FIFO tail. A
manager that already had queued worker reports/notices ahead of it would drain those as their own turns
FIRST — at emergency context occupancy, one of those turns can be the very one that exhausts the manager,
defeating the point of an *emergency* interrupt.

`redirectWorkerForContextInterrupt` (card `dacc6d9e` round 2) already solved the identical problem for the
WORKER-side context interrupt by passing `headInsert:true`, which threads through `deliverRedirect` →
`enqueueDurableMessage` → `PtyHost.enqueueStdin`'s `EnqueueStdinTail.headInsert` (`pty/host.ts`): it
splices the new entry at `live.pending[0]`, skipping the same-sender reorder/leapfrog scan entirely
(`!headInsert` guards that whole block, so `leapfrogCount` on already-queued entries is never touched).

This redirect's own shape — `enqueueSender:"system"` (null-mapped by `coalesceSenderIdentity`) and
`kind` defaulting to `"agent"` — means the entry drains COMPLETELY ALONE at drain time regardless of
where it sits: `drainPending`'s agent-coalescing extension loop is gated on `senderKey !== null`, so a
null-sender entry can never coalesce forward into (or be coalesced into by) anything else queued, same- or
different-sender. Moving it to the front was therefore safe to do by reusing the exact same mechanism
`dacc6d9e` already shipped and tested (`pty-head-insert.mjs` scenario E) — no new `pty/host.ts` design was
needed.

## Decision

`redirectManagerForEmergencyRecycle` now passes `headInsert:true` alongside its existing
`supersedeQueue:false`, mirroring `redirectWorkerForContextInterrupt` exactly.

## Do not

- Do not drop `headInsert:true` from this call site — without it the emergency text silently reverts to
  draining behind whatever else is already queued, defeating the whole point of an emergency interrupt.
- Do not add `supersedeQueue:true` (or flush this queue some other way) to "simplify" the ordering — this
  queue can hold other parties' inbound content; only the INSERTION POSITION changes here, never the
  flush behavior.
- Do not assume this redirect's "drains alone" property is guaranteed by `headInsert` itself — it comes
  from the null `senderId` (`enqueueSender:"system"`) combined with `kind:"agent"`'s sender-gated
  coalescing extension. If this call site ever gains a real sender or an explicit non-"agent" `kind`, the
  isolation guarantee must be re-verified, not assumed to still hold.
