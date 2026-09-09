# 3c39be30 — the branded `DirectiveEventStream` closes the freehand-scoped-query hazard, at runtime not just types

⚠️ Spans two decisions, both in `mcp/orchestration.ts`: this record (§1), and `resolveMsgIdOutcome`'s
twins-fold (§2). `resolveRecord` serves one file per id; folded here rather than left as a second
unreachable `3c39be30-*.md` file (card `6de8956e`).

## §1 — Narrative

Card 3c39be30 — `resolveDirectiveOutcome` had an UNDOCUMENTED, UNENFORCED precondition: the `events` array it walks must actually be CAPABLE of containing the `session_message_delivered`/`session_message_gave_up` rows for the msgId chain it's asked to resolve — i.e. it must come from a query scoped to a session id that genuinely appears on that chain's events, via the SAME column the query filters on. Get that wrong (e.g. filter `manager_session_id` on a worker's own id, which — bar coincidence — never appears there) and the array is silently, permanently missing the one row that would flip the answer: `resolveDirectiveOutcome` returns a CONFIDENT `"pending"` forever, never an error. This tripped `peerMessageStatusByMsgId`'s first implementation (card 0f693dea) — fed `db.listEvents(managerSessionId)` before `resolveQueuedMessage` (sessions/service.ts) threaded the real sender through, so the one row that would have resolved a drained HELD send to "delivered" was filed under nobody's session and a passing test suite never caught it (it asserted "pending" on a message it never actually drained).

FIX: fold stream selection OUT of every call site and into three named constructors (`workerDirectiveStream`, `workerLineageDirectiveStream`, `managerLineageDirectiveStream`) — the ONLY way to produce a `DirectiveEventStream`. A caller can no longer freehand a query and hope it's scoped right; it picks one of "this worker", "this worker's own recycle lineage", or "this manager's own recycle lineage" and the constructor runs the correspondingly-correct `Db` query itself. `resolveDirectiveOutcome` then REFUSES (throws) an array that didn't come from one of these — a real runtime tag, not just a TS-erased phantom type, so the guard survives even a JS-level or manually-cast call, not only a `tsc` pass. Chosen over a bare top-of-function assertion (the smallest diff, and the one this card explicitly warns against defaulting to) because an assertion alone still leaves every call site free to hand-assemble its own array the WRONG way and merely get caught after the fact; folding selection into named constructors removes the freehand assembly step entirely — there is no longer a "build the array yourself" path to get wrong. See `resolveMsgIdOutcome` for the shared resolver these streams feed (DoD-2's twins fold), and `resolve-directive-outcome-stream-guard.mjs` for the regression proof this guard actually fires.

### Do not

- Do not hand-assemble a `DirectiveEventStream` from a freehand `Db` query — always go through `workerDirectiveStream`/`workerLineageDirectiveStream`/`managerLineageDirectiveStream`; `resolveDirectiveOutcome` throws on anything else, by design.
- Do not replace the runtime brand with a bare top-of-function assertion or a TS-erased phantom type — considered and rejected: it still leaves every call site free to build the array the wrong way and only catches it after the fact.

### Source

JSDoc in `mcp/orchestration.ts`, above the `DirectiveEventStream` type/`tagDirectiveEventStream`. Relocated by card `210cd10c` (tranche 1).

## §2 — `resolveMsgIdOutcome` folds `directiveByMsgId`/`peerMessageStatusByMsgId`'s duplicated three steps into one

### Narrative

DoD-2 — `resolveMsgIdOutcome` is the SHARED engine behind `directiveByMsgId` and `peerMessageStatusByMsgId`. Both need exactly the same three steps: find an "origin" event matching some caller-specific predicate (which differs — `message_worker`/`redirect_worker`'s own `msgId`/`queuedMsgId` field, vs a `cross_project_message`'s own `msgId` field), resolve that origin's msgId chain via `resolveDirectiveOutcome`, and project the outcome into the `{msgId, found, state, at}` shape both tools return. Before this card those three steps were duplicated verbatim in each twin — "same signature, same 4-way `at` ternary, same return shape" — and had ALREADY drifted (`peerMessageStatusByMsgId`'s own history: prefix matching + lineage-widening landed there but never in `directiveByMsgId`). Folding to one resolver means the outcome-projection logic, and the STREAM PRECONDITION `resolveDirectiveOutcome` now enforces (§1), are each stated once.

`findOrigin` receives the ALREADY-SCOPED `DirectiveEventStream` (never a raw array) and returns the origin event + the msgId to walk from it, or `undefined` on no match — callers never touch `resolveDirectiveOutcome` directly, so they cannot feed it anything but the stream this function already built via the correct constructor.

`sentAt` (card `af995d1d` DoD-4) is the ORIGIN event's own timestamp — when the ROOT msgId a caller is holding was actually sent — regardless of how far the chain has since walked (a remint changes `msgId` but never the original send instant). Lets a `peer_message_status`/`directive_status` caller compute its own elapsed-since-send for a still-`pending` read without holding a separate send-time stamp.

### Do not

- Do not let a caller of `directiveByMsgId`/`peerMessageStatusByMsgId` call `resolveDirectiveOutcome` directly — always go through `resolveMsgIdOutcome`'s `findOrigin`, which guarantees a correctly-scoped `DirectiveEventStream`.
- Do not re-duplicate the three-step walk in a future twin — that duplication already drifted once (prefix matching + lineage-widening landing in one twin but not the other) before this fold.

### Source

JSDoc in `mcp/orchestration.ts`, above `resolveMsgIdOutcome`. Relocated by card `210cd10c` (tranche 1). Folded into this pre-existing record by card `6de8956e`.
