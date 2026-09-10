# 0f693dea — `peerMessageStatusByMsgId`: three Code Review fixes, all measured against the running daemon

## Narrative

Card 0f693dea DoD-2 — the sender-facing per-msgId delivery read behind `peer_message_status`. A `peer_message` sender has NO cross-project read into the target project's session at all (see `handleGiveUpExhausted`'s `canCheckRecipient` doc, sessions/service.ts — the honest "no read exists" clause a peer sender gets in a `[loom:redelivery-parked]` notice) — the actual gap this card exists to close. This function genuinely never reads the peer manager's own event stream; earlier drafts of this doc and of this function's own body disagreed on that point (a real "the sentence asserting a policy is where it breaches" instance, caught in Code Review) — fixed at the SOURCE instead, in the ownership guard now kept inline at this function.

THREE fixes landed here after Code Review on this card's first pass, all measured against the running daemon rather than assumed from the shape of the code:

(CRITICAL) A held/queued send that later drains normally used to read "pending" FOREVER. Root cause: `resolveDirectiveOutcome`'s delivered-check for a NON-immediate hand-off looks for a `session_message_delivered` event carrying this msgId — but `resolveQueuedMessage` (sessions/service.ts) used to stamp that event with `managerSessionId:""` (never the sender), so it could never appear in a sender-scoped stream. TWO candidate fixes were considered and REJECTED: (a) merge in the recipient's own `db.listEventsForWorker` stream here — rejected because it reads the PEER MANAGER's own event stream across a project trust boundary to answer a question about OUR OWN message, a genuinely weaker ownership property than "scoped to the caller's own stream" for a PRIVATE product, even though the RETURNED shape stays narrow; (b) `db.isQueuedMessageDelivered(msgId)` as a boolean existence check — rejected because it has no timestamp, forcing `at:null` on a resolved "delivered" state and breaking this function's own "`at` is null only while pending" contract. FIXED AT THE SOURCE INSTEAD: `resolveQueuedMessage` now threads the real originating sender through (every call site updated) instead of hard-coding `""` — the SAME sender its own paired `session_message_queued` event has ALWAYS carried. The event simply appears in this function's existing sender-scoped read once stamped correctly; nothing about this function's OWN scope needed to change.

(MAJOR) `peer_message_status` is scoped to `managerSessionId`'s own RECYCLE LINEAGE (`ownLineageIds`, same widening `directiveDeliveriesForCaller` already applies for the recipient side), not just its exact live session id — a sender that recycles must still be able to resolve a msgId its PREDECESSOR minted; this is, after all, the card about recycle-awareness.

(MAJOR) Accepts an unambiguous id-PREFIX (`resolveIdPrefix`, `id-prefix.js`), not just a full msgId — the SAME `tasks_get`/`agent_get`/`worker_relink` convention used everywhere else Loom hands a truncated id to a reader. The `[loom:redelivery-parked]` notice this tool exists to answer only ever prints an 8-char slice of the msgId (mirrors every other id it slices the same way); requiring an exact full-id match would make the notice's own prescribed action fail — this card's dead end, reintroduced inside its own fix. An ambiguous prefix across the lineage returns `found:false` (same as a genuine miss — there is no legitimate reason to distinguish them for this reader; unlike an id-scoped `*_get`, nothing here is lost by not naming the candidates).

## Do not

- Do not merge in the recipient's own `db.listEventsForWorker` stream to answer a sender-side "was it delivered" question — that was explicitly considered and rejected as a weaker cross-project ownership property, even with a narrow returned shape.
- Do not resolve `at:null` for a resolved "delivered" state via a boolean existence check (`db.isQueuedMessageDelivered`) — that was rejected too, since it breaks the "`at` is null only while pending" contract.
- Do not require an exact full msgId match — the `[loom:redelivery-parked]` notice only ever prints an 8-char prefix; an id-prefix accept path is required for the notice's prescribed action to actually work.

## Source

JSDoc comment in `packages/daemon/src/mcp/orchestration.ts`, above `peerMessageStatusByMsgId`. Relocated by card 210cd10c (tranche 1 on `mcp/orchestration.ts`) — the by-construction ownership guard sentence stayed inline per `CLAUDE.md`'s class-A rule, compressed in place. No wording changed in the narrative moved here; wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.

## DoD-2/mechanics, consumer side: `handleGiveUpExhausted` gains a third read branch

Card 0f693dea DoD-2: a `peer_message` sender used to fall into the `[loom:redelivery-parked]` notice's unconditional "no read exists" branch — the dead end this card's own new-evidence measured verbatim off that notice. `peer_message_status` closes it: a third branch sits alongside `canCheckRecipient`'s worker case, gated on the sender's own `cross_project_message` audit event carrying this `rootMsgId` as its `msgId` (stamped by `messagePeerManager`) — the same signal `peerMessageStatusByMsgId`'s own resolver keys on, so the notice's pointer and its actual resolution can't drift apart. Computed lazily inside the ternary's else-arm (CR follow-up) — wasted work only when `canCheckRecipient` already short-circuits, and the park path is rare.

## Source (2)

Inline comment in `packages/daemon/src/sessions/service.ts` (`handleGiveUpExhausted`'s notice-building block), as of main `c461821e`. Relocated by card `1341fcde` (tranche 20 on `sessions/service.ts`).
