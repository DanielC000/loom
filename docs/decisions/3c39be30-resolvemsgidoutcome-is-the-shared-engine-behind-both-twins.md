# 3c39be30 — `resolveMsgIdOutcome` folds `directiveByMsgId`/`peerMessageStatusByMsgId`'s duplicated three steps into one

## Narrative

Card 3c39be30 DoD-2 — `resolveMsgIdOutcome` is the SHARED engine behind `directiveByMsgId` and `peerMessageStatusByMsgId`. Both need exactly the same three steps: find an "origin" event matching some caller-specific predicate (which differs — `message_worker`/`redirect_worker`'s own `msgId`/`queuedMsgId` field, vs a `cross_project_message`'s own `msgId` field), resolve that origin's msgId chain via `resolveDirectiveOutcome`, and project the outcome into the `{msgId, found, state, at}` shape both tools actually return. Before this card those three steps were duplicated verbatim in each twin — "same signature, same 4-way `at` ternary, same return shape" per this card's own body — and had ALREADY drifted (`peerMessageStatusByMsgId`'s own history: prefix matching + lineage-widening landed there but never in `directiveByMsgId`). Folding to one resolver means the outcome-projection logic, and the STREAM PRECONDITION `resolveDirectiveOutcome` now enforces (see card 3c39be30's `DirectiveEventStream` record), are each stated once.

`findOrigin` receives the ALREADY-SCOPED `DirectiveEventStream` (never a raw array) and returns the origin event + the msgId to walk from it, or `undefined` on no match — callers never touch `resolveDirectiveOutcome` directly, so they cannot feed it anything but the stream this function already built via the correct constructor.

`sentAt` (card af995d1d DoD-4) is the ORIGIN event's own timestamp — when the ROOT msgId a caller is holding was actually sent — regardless of how far the chain has since walked (a remint changes `msgId` but never the original send instant). Lets a `peer_message_status`/`directive_status` caller compute its own elapsed-since-send for a still-`pending` read without holding a separate send-time stamp.

## Do not

- Do not let a caller of `directiveByMsgId`/`peerMessageStatusByMsgId` call `resolveDirectiveOutcome` directly — always go through `resolveMsgIdOutcome`'s `findOrigin`, which guarantees a correctly-scoped `DirectiveEventStream`.
- Do not re-duplicate the three-step walk in a future twin — that duplication already drifted once (prefix matching + lineage-widening landing in one twin but not the other) before this fold.

## Source

JSDoc comment in `packages/daemon/src/mcp/orchestration.ts`, above `resolveMsgIdOutcome`. Relocated by card 210cd10c (tranche 1 on `mcp/orchestration.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
