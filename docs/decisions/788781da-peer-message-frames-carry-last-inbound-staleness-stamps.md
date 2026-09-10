# 788781da — `peer_message` frames carry two server-computed "last inbound from you" staleness stamps, computed at send time

## Narrative

A crossing pair — A sends a `peer_message`, B sends its own before receiving A's — used to be
indistinguishable from a genuine, undiligent non-reply: nothing in the frame told the recipient
whether the sender already knew about B's side of the conversation. This card adds two
server-computed timestamps to every `peer_message` frame (and to the boarded-fallback task body,
DoD-7, when no live target manager exists) so the sender's own staleness becomes a property of the
transport, not a judgment about the author's diligence.

**§SCOPE** — the thing that reads a thread is a SESSION, not a project, so both stamps exist and
neither substitutes for the other:

- `last-inbound-this-session` (`lastInboundPeerMessageThisSession`) — does THIS AUTHOR (the literal
  sending session id) know? Scoped to the exact session id via `db.listEventsForWorker` only,
  deliberately NEVER widened across a recycle lineage — a predecessor's inbound history is
  invisible here on purpose. This is what makes the recycle case possible: the session stamp reads
  `none` while the project stamp still carries the predecessor's receipt. Widening this read would
  silently reintroduce the "they were told, this author wasn't" false-confidence bug one level down.
- `last-inbound-project` (`lastInboundPeerMessageProject`) — was the PROJECT ever told, surviving a
  recycle? Never keys on a session id at all — `db.listCrossProjectMessagesFromTo` matches purely on
  the two project ids carried in each event's own `detail`.

Both render literally as `none` when `null` (never corresponded, from that stamp's own point of
view) — distinct from the field being ABSENT entirely, which only ever means "this frame predates
the guard." A never-corresponded exchange's frame carries both fields reading `none`, otherwise
byte-identical to before this card; `PEER_MESSAGE_FRAME_RE`'s `[^\]]*` already tolerates whatever
sits inside the brackets, so no existing consumer needs to parse the new fields.

**Computed HERE, at SEND time** (`messagePeerManager`), not earlier at compose time — that gap
between compose and send is exactly the staleness being measured; computing earlier would
understate it.

**§INBOUND — "inbound" means DELIVERED, never merely QUEUED** (`crossProjectMessageDeliveredAt`):
`deliveryStatus` "delivered-live" was handed to a turn the instant it was sent (`ts` IS the delivery
instant, same stamp `messageWorker`'s own immediate path uses); "boarded" was told to the target
project the instant its board card was created (`ts` again); "queued" is NOT yet delivered until a
`session_message_delivered` marker exists for its `msgId` (`db.getQueuedMessageDeliveredAt`) — a
bare send-time `ts` on a still-queued entry would claim "they have it" before it landed, the exact
false-confidence failure this card exists to fix. Deliberately does NOT walk the give-up/re-mint
retry chain `resolveDirectiveOutcome` (mcp/orchestration.ts) walks for a sender's OWN outbound
directive — this field is an advisory staleness hint, not a delivery guarantee, and a message
needing a retry is the rare case; the simplification fails toward UNDER-claiming (an older/absent
timestamp, never a false "delivered").

**DoD-7** — the boarded-fallback task body (no live target manager) carries the SAME two stamps, in
its own "From" block, so a human reading a boarded card off a linked project's board gets the
identical staleness signal a live frame would have given a manager.

**Decided NO for this card:** the DoD's own "consider surfacing `position` too" — `position` is
already returned to the caller, unrelated to inbound staleness, and out of scope.

**Cross-project privacy:** this exposes only a correspondence TIMESTAMP between two projects the
owner has already explicitly linked (`db.areProjectsLinked`) — no message content, consistent with
the frame's existing projectId/sessionId disclosure.

## Source

`packages/daemon/src/sessions/service.ts` — `crossProjectMessageDeliveredAt`,
`lastInboundPeerMessageThisSession`, `lastInboundPeerMessageProject`, and `messagePeerManager`
(extraction tranche 31).
