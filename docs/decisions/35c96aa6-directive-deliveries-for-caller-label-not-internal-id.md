# 35c96aa6 — `directiveDeliveriesForCaller` matches on the worker-visible LABEL, never the internal root id

⚠️ Spans two decisions, both in `mcp/orchestration.ts`: this record (§1), and `resolveDirectiveOutcome`'s
module-scope hoist (§2). `resolveRecord` serves one file per id; folded here rather than left as a second
unreachable `35c96aa6-*.md` file (card `6de8956e`).

## §1 — Narrative

Card 35c96aa6 — the read behind the worker-facing `directive_status` tool: "which durable, turn-confirmed hand-offs, of a message whose root label matches `rootLabel` (or of ANY root, when `rootLabel` is omitted), has `callerSessionId` — or a predecessor in its own recycle lineage — ever received?" DELIVERY history only, never a claim about action — see the tool's own description for the explicit non-claim.

Reuses `resolveDirectiveOutcome` per directive event (same function `staleDirectiveProjection` calls) rather than re-deriving chain state, applied to EVERY `message_worker`/`redirect_worker` event found in scope — not just the latest one `staleDirectiveProjection` tracks — because a manual resend (`resendOf`) can create a SEPARATE top-level directive event sharing the SAME true root, and each must be walked on its own.

LABEL, not internal id: a worker only ever sees the 8-hex-char label `framePossibleDuplicate` puts in a `[loom:possible-duplicate root:…]` tag — never the raw internal `rootMsgId` — so matching must use `possibleDuplicateRootLabel` (pty/host.ts), the SAME function that produced the tag, not a re-derived approximation. The TRUE internal root is recovered from `session_message_queued`/`session_message_gave_up` events' `detail.rootMsgId` — NOT from `message_worker`/`redirect_worker`'s own `detail.msgId`/`detail.queuedMsgId`, always a FRESH per-call mint (`enqueueDurableMessage`) that only coincidentally equals the true root for a first-ever send with no `resendOf`. An event absent from that map (never queued/gave up) self-roots and is never tagged — not because `framePossibleDuplicate` refuses a self-root (it applies UNCONDITIONALLY; no such guard exists — card `fb5d2220`'s gate-time audit) but by CALL-SITE DISCIPLINE: every real caller (`joinSubmittedText`'s `giveUpGen`-gated write, `handleGiveUpExhausted`'s re-mint, the kickoff re-mint, Path D's `redriveQueuedMessage`) only ever invokes it on a message that WAS queued or gave up. Path D's redrive (`bcaeab8d`) frames unconditionally but only ever redrives a row with an existing `session_message_queued` record. A real worker-supplied label can never legitimately match one — harmless.

Only `state: "delivered"` and `state: "confirmed-after-park"` outcomes ever produce a delivery record — `"parked"`/`"pending"` never reached any turn, so they carry no relevant information. A `confirmed-after-park` entry's `turnSeq` is `null` (no hand-off cleanly stamped) but is STILL a genuine, durably-recorded delivery. CAUGHT IN SELF-AUDIT: an earlier draft claimed such an entry "always predates the caller's current turn" — NOT verified; the confirming hook (`onGiveUpConfirmed`, pty/host.ts) fires asynchronously and can resolve mid-turn.

Each entry carries BOTH `fromSession` (actual SENDER) and `receivedBy` (which id in the CALLER's own lineage took the hand-off; may be a predecessor, never outside the lineage) — `receivedBy` differing from the live caller is precisely the recycle-boundary signal DoD-3 exists to surface. Bounded to the 20 most recent deliveries when `rootLabel` is omitted; a single-label filtered call returns its complete history uncapped.

### Do not

- Do not match a worker-supplied `rootLabel` against the internal `rootMsgId` directly — always compute the comparison label via `possibleDuplicateRootLabel`, the same function that produced the tag.
- Do not collapse `fromSession`/`receivedBy` into one field — their difference IS the recycle-boundary signal.
- Do not claim a `confirmed-after-park` entry predates the caller's current turn — NOT verified; the confirming hook fires asynchronously and can resolve mid-turn.

### Source

JSDoc in `packages/daemon/src/mcp/orchestration.ts`, above `directiveDeliveriesForCaller`. Relocated by card `210cd10c` (tranche 1).

## §2 — `resolveDirectiveOutcome` hoisted to module scope so a second caller can reuse the exact same walk

### Narrative

`resolveDirectiveOutcome` resolves ONE directive's (a `message_worker`/`redirect_worker` send's) current fate from durable event history alone, walking its give-up/re-mint chain from `rootMsgId` forward. Hoisted out of `buildServer`'s `staleDirectiveProjection` closure to MODULE scope (unchanged logic — it never closed over anything but its own three parameters; `events`' type, previously `ReturnType<typeof db.listEventsForWorker>` for convenience, is now the equivalent `OrchestrationEvent[]`) so a second caller — the worker-facing `directive_status` tool (§1) — reuses the EXACT SAME walk instead of a parallel reimplementation that could drift. `staleDirectiveProjection`'s own call site is untouched; a pure scope move.

Each msgId gives up AT MOST ONCE (a give-up either re-mints to a brand-new msgId or parks terminally — see `handleGiveUpExhausted`'s doc) — so walking msgId → its one give-up event → the next msgId cannot loop; `seen` is a cheap defensive bound, not a real cycle guard.

Card `3c39be30`: `events` is now the branded `DirectiveEventStream`, not a raw `OrchestrationEvent[]` — see that card's own record for the precondition this enforces and why.

### Do not

- Do not reimplement the give-up/re-mint chain walk at a second call site — reuse `resolveDirectiveOutcome` itself; a parallel reimplementation is exactly the drift risk this hoist closes.

### Source

JSDoc in `mcp/orchestration.ts`, above `resolveDirectiveOutcome`. Relocated by card `210cd10c` (tranche 1). Folded into this pre-existing record by card `6de8956e`.
