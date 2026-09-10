# 343441bd — the stale-directive signal is a PULL a manager reads, deliberately never a pushed watchdog nudge

## Decision A

## Narrative

Card 343441bd: "delivered vs. apparently acted upon" — a manager-facing signal, distinct from the synchronous `{delivered:true}` a `worker_message` call returns, which only proves the text was submitted-or-durably-queued (see the card body's `39cbe5b5` incident: that receipt was truthful and useless — the fix-pass it described was never executed, and the manager only found out by grepping the branch HEAD). PULL, not a nudge (deliberately no watchdog here — see the card's own steer against reintroducing a false-alarm nudge class, `a4bfe6d9`→`8e0bd254`): a sibling of `reportedProjection`, read only when a manager actually looks at `worker_list`/`worker_status`.

"Acknowledged" = the worker's next `worker_report` (ANY status) with a `ts` after the directive's recorded HAND-OFF ("delivery" here means the recorded hand-off point, not an engine-confirmed receipt) — the cheapest of the card's own candidate definitions, deliberately NOT a semantic match against the directive's text. Only applies to the `delivered` outcome — see card 9da2a435's note on why a `parked` outcome can NEVER be acknowledged this way. Scoped to the LATEST `message_worker` OR `redirect_worker` event (mirrors `reportedProjection`'s own "latest wins" scan, now widened across both kinds — card 0fbb0507). Before that widening this was `worker_message` ONLY; `worker_redirect` already carried a correlatable `queuedMsgId` on its held path (card 02621025) and the widening was deliberately deferred to keep 9da2a435 minimal.

`turnSeqAtDelivery` was stamped by `messageWorker` (immediate delivery) or `resolveQueuedMessage` (held — stamped at HAND-OFF, never at enqueue). A directive still sitting in the queue (held, not yet delivered) has no `turnSeqAtDelivery` anywhere yet — nothing to judge staleness against, so it reads as null exactly like an acknowledged one.

Card 9da2a435: hand-off is NOT confirmed delivery (see `enqueueStdin`'s `EnqueueResult` doc) — a submit that hands off optimistically can still GIVE UP asynchronously, and `handleGiveUpExhausted` (sessions/service.ts) either re-mints it under a FRESH msgId (`chainDepth+1`) or terminally PARKS it, appending a `session_message_gave_up` event either way. The OLD version of this function never looked for that event: a parked directive never gets a worker_report (nothing was ever handed to the worker to act on) AND never advances the worker's own turnSeq (no turn ran), so `turnsSinceDelivery` stayed 0 forever and `staleDirective` read `null` — indistinguishable from "recently delivered, no problem yet". `resolveDirectiveOutcome` walks the give-up chain first so a parked directive is reported as parked, never silently as "no signal". Card 35c96aa6: hoisted to MODULE scope (was a closure-local `const` here) so the worker-facing `directive_status` tool can call the SAME chain walk instead of reimplementing it — this call site is unchanged, only where the function lives moved.

## Do not

- Do not add a watchdog nudge on top of `staleDirective` — this is a deliberate PULL-only signal; a nudge class was already tried and retracted (`a4bfe6d9`→`8e0bd254`).
- Do not treat a directive still sitting in the queue (no `turnSeqAtDelivery` yet) as acknowledged — it reads `null` for a different reason (nothing to judge staleness against yet), not because it was acted on.
- Do not skip the give-up chain walk when deriving `staleDirective` — without it a parked directive is silently indistinguishable from "recently delivered, no problem yet" (the exact bug card 9da2a435 fixed).

## Source (this section only)

Inline comment in `packages/daemon/src/mcp/orchestration.ts`, above the `staleDirectiveProjection` closure. Relocated by card 210cd10c (tranche 1 on `mcp/orchestration.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped.

## Decision B (unrelated decision, same card id, `pty/host.ts`)

## Narrative

Card 343441bd, `pty/host.ts`: `onTurnCompleted` bumps the persisted "opportunities to act" turn counter (`staleDirective`'s clock — Decision A). CLAUDE fires it exactly once per genuine Stop/StopFailure completion, before `drainPending`, not at the `setBusy(false, "stop-hook")` edge nor from the file's other five `setBusy(false)` sites: `healIfStuck`'s two + `sendEnterAndVerify`'s give-up-recovery two (submit never confirmed started — counting them risks a false `staleDirective` fire); `interruptForRedirect`'s settle site (a real turn cut short — safe under-count); the two usage-cap park `break`s (§19c rate-limit, weekly-cap sentinel — non-opportunity, owned by the rate-limit signal). Every other path falls through, so it fires once per turn — never zero, never twice.

CODEX has its own site (361a5520): `armCodexBusyStaleTimer` CASE 2 (no hook relay), gated on `submitOutstanding` — same exclusion, different signal; a deliberate second site, not a sixth claude one.

`onTurnCompleted` is optional (unlike its siblings) so the ~115 daemon tests sharing the `SeamHost` fake-pty double (`test/_seam-host-fixture.mjs`) skip a no-op for an unused callback — the call site uses `?.`; production (`index.ts`) always wires a real one.

## Do not

- Do not wire `onTurnCompleted` to the five excluded `setBusy(false)` sites, or move it above the two park breaks — either reintroduces the false-alarm risk (a wedged worker is a different signal, owned by the busy-stuck watchdog).

## Source (this section only)

Inline comment in `packages/daemon/src/pty/host.ts` (`onTurnCompleted`'s field doc on `PtyHostEvents`), as of `main` `8d9fe59d`. Extracted by card `a2a6b2ad` (tranche 11); condensed to fit the byte cap, no clause dropped. Not Decision A — same id, unrelated content, per `resolveRecord()`'s one-file-per-id rule.
