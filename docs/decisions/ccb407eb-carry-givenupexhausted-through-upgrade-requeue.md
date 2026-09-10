# ccb407eb — Carry `msg.onGiveUpExhausted` through the companion-upgrade requeue paths (finding [6])

## Narrative

CR follow-up (card ccb407eb, finding [6]): carry msg.onGiveUpExhausted too.

Card ccb407eb, finding [6]: a durable (onDeliver-bearing) entry is skipped above, so this loop only ever carries plain (non-durable) entries — msg.onGiveUpExhausted is always undefined here in practice, but pass it through anyway.

## Do not

- Do not drop `msg.onGiveUpExhausted` when requeuing a drained message back onto the pty in either `upgradeCompanionCapabilities` path (same-pty abort, or post-`resume()`) — carry it through even when it's undefined in practice.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`upgradeCompanionCapabilities`): lines 4136-4137 (abort path) and 4175-4176 (post-resume path), as of commit `7a20d971f1c5d3d098b36030b5cc5feebd8be930`. Relocated by card `6065685c`; no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped. Narrowly scoped to this method's two requeue sites — `finding [6]`'s broader `ccb407eb` feature has other sites elsewhere in this file, out of this record's scope.

## `onGiveUpExhausted` is PtyHost's own hook, deliberately not a reuse of `onDeliver`

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

## Do not (2)

- Do not repurpose `onDeliver` for the give-up-exhausted case — it has usually already fired by the time
  exhaustion is detected, so reusing it is an idempotent no-op, not a real second channel.
- Do not put any give-up-exhausted policy decision (re-mint, park-and-notify) into PtyHost itself — that
  belongs to `sessions/service.ts`'s `enqueueDurableMessage`/`handleGiveUpExhausted`; PtyHost stays
  DB-agnostic.

## Source (2)

Inline comment in `packages/daemon/src/pty/host.ts` (the `onGiveUpExhausted` field doc on `QueuedMessage`),
as of commit `94d7f15344bffb12a8ae413d8345da2ff62b6071` (`fix(pty): queued-message give-up terminal branch
discards permanently (budget 1) and invisibly...`). Relocated by card `3f45b7d8` (tranche 6 on
`pty/host.ts`); distinct from this file's original `finding [6]` narrative (a different site in
`sessions/service.ts`).

## BLOCKING finding [2]: a redrive that then gives up must not silently drop, either

CR follow-up (card ccb407eb, BLOCKING finding [2] — a third, distinct site under this card, unrelated to
findings [6] and the pty/host.ts field doc above): before this fix, `redriveQueuedMessage`'s re-enqueue
branch had NO `onGiveUpExhausted` at all. A redriven message — the exact path a crashed/wedged session
actually takes — that then gave up hit the pre-card bare-drop branch: no re-mint, no park, no event, no
sender surface, AND its `onDeliver` had already fired (see `resolveQueuedMessage`'s own doc) so it would
never be redriven again either. Specimen Z's exact failure, intact, on this one path. Fixed by wiring the
SAME `handleGiveUpExhausted` policy every other durable dispatch already uses — no separate policy for a
redriven message.

## Do not (3)

- Do not let a redrive's re-enqueue branch omit `onGiveUpExhausted` — a redriven message that then gives
  up is the exact path a crashed/wedged session takes, and dropping it there silently loses the message a
  second time (its `onDeliver` already fired, so nothing else will ever redrive it again).

## Source (3)

Inline comment in `packages/daemon/src/sessions/service.ts` (`redriveQueuedMessage`'s re-enqueue branch):
lines 5166-5171, as of commit `94d7f15344bffb12a8ae413d8345da2ff62b6071` (`fix(pty): queued-message
give-up terminal branch discards permanently (budget 1) and invisibly...`). Relocated by card `61632c05`
(tranche 15); no wording changed, wrapped source lines joined into a flowing paragraph and the `//`
comment markers stripped.

## Two more fixes bundled at this same site (card ccb407eb)

The re-mint also fixes: `enqueueDurableMessage`'s `if (!r.delivered)` append never ran for an
immediate re-mint (no `session_message_queued` row, not crash-durable) — the `giveUpHeldUntil` HELD
branch fixes this too. `sender` is `"system"` for every settle-nudge site (no real session); safe —
`ctx.sender` only feeds `managerSessionId` attribution and the sender-surface step, a no-op for
`db.getSession("system")` (same shape `recoverUndeliveredMessagesOnBoot` documents).

## Source (4)

`sessions/service.ts` (`handleGiveUpExhausted` doc), lines 7131-7176, main `fb53a9f6`. Relocated by
card `0d854939` (tranche 19); remainder duplicates the sections above.
