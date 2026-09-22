# ccb407eb — Give-up-exhausted terminal-branch policy: carry `onGiveUpExhausted`, pin `GIVE_UP_REMINT_LIMIT`, and record outcomes via `session_message_gave_up`

## Merge note

This record merges three files that all carried the id `ccb407eb` and collided under `resolveRecord()`'s
one-file-per-id resolution (store precedence, then alphabetically-first within the store) — only one was
ever reachable via the 9 live `@decision ccb407eb` anchors in source; the other two were silently
unreachable, forever, with no error and no lint failure by default. Fixed by card `c37d86c7`. Former
filenames, each now a topic below: `ccb407eb-carry-givenupexhausted-through-upgrade-requeue.md` (Topic A),
`ccb407eb-give-up-remint-limit-pinned-at-1-measured-cost.md` (Topic B),
`ccb407eb-session-message-gave-up-event-kind-and-confirmed-after-park.md` (Topic C). No wording changed
in the merge; only "Do not" headings were renumbered sequentially across the merged file and each former
file's own top-level content was nested one heading level deeper under a new "Topic" divider.

## Topic A — Carry `msg.onGiveUpExhausted` through the companion-upgrade requeue paths (finding [6])

### Narrative

CR follow-up (card ccb407eb, finding [6]): carry msg.onGiveUpExhausted too.

Card ccb407eb, finding [6]: a durable (onDeliver-bearing) entry is skipped above, so this loop only ever carries plain (non-durable) entries — msg.onGiveUpExhausted is always undefined here in practice, but pass it through anyway.

### Do not

- Do not drop `msg.onGiveUpExhausted` when requeuing a drained message back onto the pty in either `upgradeCompanionCapabilities` path (same-pty abort, or post-`resume()`) — carry it through even when it's undefined in practice.

### Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`upgradeCompanionCapabilities`): lines 4136-4137 (abort path) and 4175-4176 (post-resume path), as of commit `7a20d971f1c5d3d098b36030b5cc5feebd8be930`. Relocated by card `6065685c`; no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped. Narrowly scoped to this method's two requeue sites — `finding [6]`'s broader `ccb407eb` feature has other sites elsewhere in this file, out of this record's scope.

### `onGiveUpExhausted` is PtyHost's own hook, deliberately not a reuse of `onDeliver`

`onGiveUpExhausted` (QueuedMessage field) is the same shape of hook `onDeliver` is — a caller-supplied
closure PtyHost invokes and otherwise knows nothing about — but fired on the OPPOSITE outcome:
`requeueGiveUpOrigin` calls it instead of silently discarding a message whose `giveUpRequeues` has
exceeded `GIVE_UP_REQUEUE_LIMIT`.

Deliberately NOT reusing `onDeliver` for this: `onDeliver` fires (and, via `enqueueDurableMessage`'s
wiring, marks the durable record "delivered") the instant a held message is HANDED to the recipient — for
a message that ends up giving up, that has usually ALREADY fired by the time exhaustion is detected, so a
second call would just be an idempotent no-op, not a channel this branch can repurpose.

`onGiveUpExhausted` is PtyHost's only hook for "this message's final in-session attempt failed and its
budget is spent" — everything upstream of that (re-mint a fresh dispatch, or park it and tell the sender)
is sessions/service.ts's `enqueueDurableMessage`/`handleGiveUpExhausted` concern, not PtyHost's; PtyHost
stays DB-agnostic exactly as it already is for every other durability guarantee. undefined for every entry
that never had one wired — a strict no-op, never invoked.

### Do not (2)

- Do not repurpose `onDeliver` for the give-up-exhausted case — it has usually already fired by the time
  exhaustion is detected, so reusing it is an idempotent no-op, not a real second channel.
- Do not put any give-up-exhausted policy decision (re-mint, park-and-notify) into PtyHost itself — that
  belongs to `sessions/service.ts`'s `enqueueDurableMessage`/`handleGiveUpExhausted`; PtyHost stays
  DB-agnostic.

### Source (2)

Inline comment in `packages/daemon/src/pty/host.ts` (the `onGiveUpExhausted` field doc on `QueuedMessage`),
as of commit `94d7f15344bffb12a8ae413d8345da2ff62b6071` (`fix(pty): queued-message give-up terminal branch
discards permanently (budget 1) and invisibly...`). Relocated by card `3f45b7d8` (tranche 6 on
`pty/host.ts`); distinct from this file's original `finding [6]` narrative (a different site in
`sessions/service.ts`).

### BLOCKING finding [2]: a redrive that then gives up must not silently drop, either

CR follow-up (card ccb407eb, BLOCKING finding [2] — a third, distinct site under this card, unrelated to
findings [6] and the pty/host.ts field doc above): before this fix, `redriveQueuedMessage`'s re-enqueue
branch had NO `onGiveUpExhausted` at all. A redriven message — the exact path a crashed/wedged session
actually takes — that then gave up hit the pre-card bare-drop branch: no re-mint, no park, no event, no
sender surface, AND its `onDeliver` had already fired (see `resolveQueuedMessage`'s own doc) so it would
never be redriven again either. Specimen Z's exact failure, intact, on this one path. Fixed by wiring the
SAME `handleGiveUpExhausted` policy every other durable dispatch already uses — no separate policy for a
redriven message.

### Do not (3)

- Do not let a redrive's re-enqueue branch omit `onGiveUpExhausted` — a redriven message that then gives
  up is the exact path a crashed/wedged session takes, and dropping it there silently loses the message a
  second time (its `onDeliver` already fired, so nothing else will ever redrive it again).

### Source (3)

Inline comment in `packages/daemon/src/sessions/service.ts` (`redriveQueuedMessage`'s re-enqueue branch):
lines 5166-5171, as of commit `94d7f15344bffb12a8ae413d8345da2ff62b6071` (`fix(pty): queued-message
give-up terminal branch discards permanently (budget 1) and invisibly...`). Relocated by card `61632c05`
(tranche 15); no wording changed, wrapped source lines joined into a flowing paragraph and the `//`
comment markers stripped.

### Two more fixes bundled at this same site (card ccb407eb)

The re-mint also fixes: `enqueueDurableMessage`'s `if (!r.delivered)` append never ran for an
immediate re-mint (no `session_message_queued` row, not crash-durable) — the `giveUpHeldUntil` HELD
branch fixes this too. `sender` is `"system"` for every settle-nudge site (no real session); safe —
`ctx.sender` only feeds `managerSessionId` attribution and the sender-surface step, a no-op for
`db.getSession("system")` (same shape `recoverUndeliveredMessagesOnBoot` documents).

### Source (4)

`sessions/service.ts` (`handleGiveUpExhausted` doc), lines 7131-7176, main `fb53a9f6`. Relocated by
card `0d854939` (tranche 19); remainder duplicates the sections above.

## Topic B — `GIVE_UP_REMINT_LIMIT` is pinned at 1, by measured compounding cost, not a guess

### Narrative

Card ccb407eb: how many times a durable "agent" message may be re-minted (a fresh `enqueueDurableMessage` dispatch, budget reset, at the recipient's next genuine turn boundary) after its in-session `GIVE_UP_REQUEUE_LIMIT` (`pty/host.ts`) is exhausted, before `handleGiveUpExhausted` gives up on automatic redelivery and parks it instead (stops writing to the recipient's pty for this message; surfaces to a live sender). This is a separate, orthogonal bound from `GIVE_UP_REQUEUE_LIMIT` — that one guards the immediate in-turn retry loop against a session already shown wedged; this one guards against re-minting forever across turn boundaries if the recipient stays wedged.

Pinned at 1, measured (not a guess): a re-mint's own give-up cycle is not free — it re-runs the full `SUBMIT_MAX_ATTEMPTS`-Enter-attempt/`SUBMIT_VERIFY_TIMEOUT_MS` sequence at production timing (these constants are not test-shortened outside a suite that explicitly pins them), measured at ~5-6s per cycle. An earlier default of 3 here (0→1→2→park, 4 total give-up cycles for a message whose recipient stays wedged) turned `merge-spawn-tracked.mjs` from a clean ~26s pass into a >60s timeout — every settle-nudge push (population B, this same card) that happens to land on a session mid-give-up in any test now pays this cost, compounding across the whole suite, not just one message. 1 means: the message gets exactly one genuinely fresh second chance (2 total cycles) before parking — still strictly better than the pre-fix behavior (0 chances, a bare unrecoverable drop), while keeping the worst-case compounding cost bounded to roughly what a single ordinary give-up already cost. Override via env for a deployment that can afford more automatic chances. CR follow-up (card ccb407eb, finding [12]): not "or fewer" — `Number(…) || 1` treats `LOOM_GIVE_UP_REMINT_LIMIT=0` (falsy) the same as unset, silently falling back to 1; 0 is unreachable via this env var. Genuinely wanting zero re-mints (park on the very first exhaustion) needs a code change to the fallback expression, not an env override.

Card 518d0305, ADDENDUM (2026-08-05): the same pinning above also forecloses "just raise the kickoff park budget" — `handleKickoffGiveUpExhausted` (this file, `[loom:worker-spawn-broken]`'s other, independent sender; the idle-watchdog sender is `notifyManagerOfIdleWorker`/`buildBrokenSpawnMsg`, card 738f2109) reuses this constant for its own remint chain — it has no kickoff-scoped budget of its own to tune. Any raise here lands on population B (ordinary durable/settle-nudge messages) too, reopening the exact regression already recorded above (3→1, `merge-spawn-tracked.mjs` 26s→60s+). Measured (worker report, card 738f2109 DoD-1): n=177 give-up-driven, content-matched confirmations (kickoffs + ordinary messages pooled, 4 daemon-output.log rotations, ~2026-07-29–08-05): p50=8.5s, p90=45.9s, p95=342s, p99=675s, max=970s. The one fully-traced kickoff false positive (`ba6b65dc`, card 05056168) confirmed 120.6s after first write. A kickoff-scoped 1→2 remint (a separate constant, not this one) would land the park budget at ~113-116s (`PARK_HOLDS`=1×3=3 × `GIVE_UP_HOLD_MS` + the same ~53-56s submit-retry overhead already observed on top of the hold) — below 120.6s, so it would not have caught even the one specimen this card has. (`c33fb627`, the other park event in the observation window, was `worker_stop`'d before any confirmation could land — its true outcome is unrecoverable from logs and must not be counted as a second confirmed false positive.)

Second specimen, added 2026-08-05: `f229f9e0`, kickoff parked, engine-confirmed (content-matched `[loom:redelivery-confirmed]`) ~271s after write — more than 2× past the ~113-116s a 1→2 raise would have produced. Attribution between Loom's own late retry and a manual submit is not established (a manager-message origin is excluded: `worker_list` showed no directive ever sent to this worker); state only that it confirmed late. n=2 confirmed late-confirmation false positives; `c33fb627` stays excluded.

Decision: no constant moves. The notice's claim was made proportionate instead — see `confirmationLatencyProportionalityClause`, shared with `buildBrokenSpawnMsg` (card 738f2109's fix for the other sender) so both state the same derived numbers rather than drifting — plus the existing pre-park discriminator (`handleKickoffGiveUpExhausted`'s `readTranscript`/`hasFirstTurnStarted` check) which already suppresses the notice whenever the engine confirms before park-time. A load-elastic budget (cf. `66649a90`, which proposes the same shape for the remint re-dispatch delay) is deferred, not rejected: `66649a90` is itself unresolved on a cold-start trap (a cross-item/EWMA input reads empty at daemon start / first-of-batch). Re-open this once that card lands a proven rule shape, rather than designing a second, possibly-diverging one here.

### Do not (4)

- Do not widen `GIVE_UP_REQUEUE_LIMIT` to fix a loss — that was rejected; `GIVE_UP_REMINT_LIMIT` exists precisely so re-minting itself can't become a new unbounded loop.
- Do not raise `GIVE_UP_REMINT_LIMIT` (or its kickoff-scoped reuse via `handleKickoffGiveUpExhausted`) without re-checking the measured compounding cost against the whole test suite — a 1→3 raise previously turned a ~26s test into a >60s timeout.
- Do not treat `LOOM_GIVE_UP_REMINT_LIMIT=0` as reachable via the current `Number(…) || 1` fallback — it silently falls back to 1; zero re-mints needs a code change, not an env override.
- Do not count `c33fb627` as a confirmed false positive — it was `worker_stop`'d before any confirmation could land; its true outcome is unrecoverable from logs.

### Source (5)

Inline comment in `packages/daemon/src/sessions/service.ts` (`GIVE_UP_REMINT_LIMIT`'s top-of-const doc): lines 1589-1644, as of this tranche's HEAD. Relocated by card 5dcc1e98 (tranche 6); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.

## Topic C — `session_message_gave_up`'s three outcomes, and the confirmed-after-park correction

### Narrative

Card ccb407eb (the give-up terminal-branch fix): fires when a message's own IN-SESSION retry budget (`GIVE_UP_REQUEUE_LIMIT`, `pty/host.ts`) was exhausted after repeated GIVE-UP RECOVERY — the pty layer never confirmed the engine actually received it. Deliberately INDEPENDENT of `session_message_delivered`: that marker is stamped optimistically the instant a held message is HANDED to the recipient (`drainPending`, BEFORE give-up detection resolves — see `resolveQueuedMessage`'s doc), so a message that later gives up can already carry a (premature) delivered marker under the SAME `msgId`. `session_message_gave_up` is the correction a reader must consult alongside it, not a replacement for it — don't infer "never dropped" from `session_message_delivered`'s presence alone.

`detail` carries `{ msgId, rootMsgId, chainDepth, outcome: "reminted" | "parked" | "confirmed-after-park", remintedAs? }`. `rootMsgId` is the FIRST msgId in this logical message's chain (self-referential on the first give-up), so every re-mint traces back to one auditable origin instead of a chain of unrelated ids.

- `"reminted"` means a FRESH `session_message_queued` record (`msgId = detail.remintedAs`) was dispatched in its place, budget reset, `chainDepth+1` — never the same retry loop widened. CR follow-up (card ccb407eb, BLOCKING finding [1]): a turn-boundary dispatch, not an immediate re-hammer, is ENFORCED — not just intended — by the re-mint stamping its own `giveUpHeldUntil` (`sessions/service.ts` `handleGiveUpExhausted`), which forces `enqueueStdin`'s HELD branch even though `live.busy` is already false at that instant (the give-up detector clears it BEFORE this fires). Omitting that stamp was a real, shipped bug — see git history for card ccb407eb's Code Review — not a hypothetical.
- `"parked"` means `chainDepth` reached `GIVE_UP_REMINT_LIMIT`: Loom stops writing to this recipient's pty for this message and surfaces it to the sender (a `[loom:redelivery-parked]` notice, durable itself) — never a silent discard, per this project's "fail toward a duplicate, never a loss" principle (card 88f11385).
- `"confirmed-after-park"` (card 417cea0a) is a LATER, separate event (same `rootMsgId`) filed if a confirming hook later content-matches a message whose chain DID reach `"parked"` — `sessions/service.ts`'s `handleGiveUpConfirmed` files it and best-effort notifies the original sender (`[loom:redelivery-confirmed]`). Not filed for every confirmed give-up — only when the chain's own history actually reached `"parked"` first (an ordinary mid-chain reminted-then-confirmed resolution is ubiquitous and not news) — and never filed at all when the confirming content match spans more than one give-up batch (card bc0774c4's batch-provenance guard leaves those entirely unresolved) — so a `"parked"` event with no later `"confirmed-after-park"` is NOT evidence the message never landed.

### Do not (5)

- Do not infer "never dropped" from `session_message_delivered`'s presence alone — that marker is stamped optimistically before give-up detection resolves; consult `session_message_gave_up` alongside it.
- Do not widen `GIVE_UP_REMINT_LIMIT`'s retry loop on a re-mint — each re-mint resets the budget and increments `chainDepth`, it never re-runs the same loop.
- Do not read a `"parked"` event with no later `"confirmed-after-park"` as proof the message never landed — a confirming match spanning more than one give-up batch is left entirely unresolved by design.

### Source (6)

Inline comment in `packages/shared/src/types.ts` (`OrchestrationEventKind`'s `session_message_gave_up` case doc). Relocated by card 35d90c4e (tranche 1 on `packages/shared/src/types.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped.
