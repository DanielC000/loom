# a5987cf3 — the duplicate-parked override must require "joined onto an ALREADY-parked root", not merely "ever auto-joined"

## Background

Card 844ca34e round 3 (commit a5f791b95, later squashed into cdbfa311) added `isAutoJoinedResend`
(`sessions/service.ts`): true whenever a dispatch's content auto-matched a still-ambiguous prior chain
via `hasAmbiguousMatch`, OR'd forward across every re-mint of that chain. It was read in exactly one
place — `handleGiveUpExhausted`'s PARKED branch — to override `suppressMootParkNotice`'s
"duplicate-parked" verdict to `null`, on the theory that an auto-join always means a deliberate manual
resend reacting to an already-PARKED chain, so its own eventual park is "genuinely new information, not
a repeat" and must never be silently suppressed.

That theory is false in general: `hasAmbiguousMatch` auto-joins ANY two dispatches whose content matches,
whether or not the matched chain has parked YET. Two genuinely INDEPENDENT, system-originated dispatches
(e.g. two separate `messageWorker` calls with identical text, dispatched before either one parks) can
auto-join on a chain that is merely still ambiguous (requeued, never parked) — `isAutoJoinedResend` is
still set `true` for the second one, and stays `true` through all its own re-mints. When that second
chain eventually parks — by which point the FIRST chain has already parked and recorded a real
"duplicate-parked" verdict for it — the override fired anyway, un-suppressing a notice that
`suppressMootParkNotice` had correctly identified as moot. The sender received TWO
`[loom:redelivery-parked]` notices for what was, from their perspective, one message that silently
duplicated and both copies wedged — precisely the bug card 085d9422 exists to prevent, reopened for this
one sub-case. Caught by `packages/daemon/test/redelivery-parked-notice-suppression.mjs` going
deterministically red on main (card a5987cf3), bisected to cdbfa311 with real builds against its clean
parent da96d023, both env states.

Card 844ca34e round 4 (commit cfb9b7ff2) had already identified the RIGHT condition for a sibling
decision — the composer-write bypass — and named it precisely: `bypassOwnershipGateOnce`, gated on
`autoJoinedId != null && isRootParked(recipientId, autoJoinedId)` ("onto a PARKED root", literally), kept
strictly one-shot (stripped on every re-mint) so it can never re-grant the write bypass on a retry. Round
4's own decision record even states the two flags are "related but DIFFERENT conditions" by design — but
never revisited whether the notice-suppression override (which kept reading the BROADER
`isAutoJoinedResend`) should have used the SAME narrow "onto a PARKED root" condition instead.

## The fix

`isAutoJoinedResend` is renamed to `joinedOntoParkedRoot` and its FRESH (non-carried) component changed
from `autoJoinedId != null` to `bypassOwnershipGateOnce` (i.e. `autoJoinedId != null &&
isRootParked(recipientId, autoJoinedId)`) — the exact condition `bypassOwnershipGateOnce` already
computes for the sibling write-bypass decision, reused rather than re-derived. Unlike
`bypassOwnershipGateOnce` itself, `joinedOntoParkedRoot` is still OR'd forward across every re-mint of the
chain (`ctx.joinedOntoParkedRoot === true || bypassOwnershipGateOnce`), because the duplicate-parked
decision is evaluated at PARK time, which can be several re-mints after the original join — the same
propagation shape `isAutoJoinedResend` always had, just gated on the narrower fresh condition.

This preserves round 3's actual intent (a deliberate resend that auto-joins an ALREADY-parked root is
never silently suppressed as a duplicate of that same park) while fixing the regression (two independent,
NOT-yet-parked chains that happen to share content and auto-join still correctly dedupe to one notice).

`isAutoJoinedResend` had exactly one production purpose (gating this one override) — it is removed
entirely rather than left alongside the new flag as dead code.

### Readers of the old flag, and what happened to each

- `enqueueDurableMessage`'s `ctx.isAutoJoinedResend` field → renamed `ctx.joinedOntoParkedRoot`; its fresh
  component is now `bypassOwnershipGateOnce`, not a bare `autoJoinedId != null` check.
- `handleGiveUpExhausted`'s trailing `isAutoJoinedResend` parameter → renamed `joinedOntoParkedRoot`, same
  position, same default `false`.
- The remint call inside `handleGiveUpExhausted` (carries the flag onto `ctx` for the next dispatch) →
  carries `joinedOntoParkedRoot` instead.
- The duplicate-parked override itself (`handleGiveUpExhausted`'s PARKED branch) → reads
  `joinedOntoParkedRoot` instead of `isAutoJoinedResend`.
- `bypassOwnershipGateOnce` itself (the write-bypass gate) → UNCHANGED; still computed fresh per call,
  never reads any carried ctx field, per round 4's own "never reads `ctx.joinedOntoParkedRoot`" rule
  (renamed from "never reads `ctx.isAutoJoinedResend`" — same rule, same reason).
- `redriveQueuedMessage` (the boot/restart redrive path) and `carryPendingToSuccessor`'s durable re-mint
  re-arm fallback (the manager-recycle carry path) both called `handleGiveUpExhausted` WITHOUT this
  parameter at all, defaulting to `false`. `isAutoJoinedResend` was never threaded through either path at
  the time of this (Round 1) fix — neither the live in-memory flag nor the persisted
  `session_message_queued` durable-record detail ever carried it — so Round 1 judged there was nothing to
  migrate and left both paths unthreaded, reasoning that the resulting default (MORE suppression, fewer
  sender-visible notices) was an acceptable pre-existing gap, never the duplicate-notice regression being
  fixed here. **That reasoning did not hold: Round 2 (card 3b420e0d) found the same over-suppression is
  itself a real, user-visible regression and threads the flag through both paths — see Round 2 below.**
- `handleKickoffGiveUpExhausted` (the turn-1 kickoff give-up path) never had an `isAutoJoinedResend`-style
  override at all — kickoffs are always self-rooted, never auto-joined via `hasAmbiguousMatch` — so it is
  unaffected by this card either way.

## Do not

- Do not read ANY auto-join signal (`autoJoinedId != null` alone) as evidence the matched root has
  already parked. Two independent dispatches can auto-join on a chain that is merely still ambiguous
  (requeued, not parked) — only `isRootParked(recipientId, autoJoinedId)` (or the carried
  `joinedOntoParkedRoot` it feeds) proves that.
- Do not read `joinedOntoParkedRoot` as interchangeable with `bypassOwnershipGateOnce` — one OR's forward
  across every re-mint (the duplicate-parked-override purpose), the other is strictly one-shot, freshly
  computed every call, and gates the write bypass only (round 4's own rule, unchanged by this card).
- Do not thread `joinedOntoParkedRoot` through the persisted `session_message_queued` detail, or through
  `redriveQueuedMessage`/`carryPendingToSuccessor`'s read-back of it, without doing BOTH halves together —
  one without the other silently reintroduces an inconsistency. Round 1 left both paths unthreaded (see
  above); Round 2 (card 3b420e0d) threads both halves together — see that section.

## Round 2 (card 3b420e0d) — restart/recycle persistence, and an explicit `resendOf` onto a parked root

Two pre-existing gaps, present since this card's own round-1 fix landed (via cdbfa311), not introduced by
it: (1) `redriveQueuedMessage` and `carryPendingToSuccessor` called `handleGiveUpExhausted` without
`joinedOntoParkedRoot` (and the persisted `session_message_queued` detail never carried it), so a daemon
restart, or a worker/manager/platform-lead recycle, inside a resend's give-up window silently dropped the flag back to its default
`false` — the resend's own eventual park was then wrongly suppressed as "duplicate-parked". Fixed by adding
`joinedOntoParkedRoot` to the persisted detail object and threading the read-back value, verbatim (never
re-derived), through all three sites: `redriveQueuedMessage`'s `handleGiveUpExhausted` call, the
`carryPendingToSuccessor` re-mint's `enqueueDurableMessage` ctx, and that method's own mint-failure re-arm
`handleGiveUpExhausted` call. The re-arm branch's `enqueueStdin` onto `oldId` only ever lands LIVE in
production for a manager or platform-lead recycle (`attemptPendingQueueCarry`/`recyclePlatformLead`, both
of which carry the predecessor's queue BEFORE `settleRecycleHandoff`/the hard-stop below it retires it) —
`recycleWorker` hard-stops its predecessor before calling `carryPendingToSuccessor` at all, so there the
re-arm's target is already dead and the failure is merely logged, not actually re-delivered. (2) An
explicit `ctx.resendOf` short-circuited `autoJoinedId` to `undefined`
(see `enqueueDurableMessage`'s own join-priority comment), so `bypassOwnershipGateOnce` — and therefore
`joinedOntoParkedRoot`, which reused it verbatim — could never be true for a `resendOf`-only dispatch, even
one naming a root that is ALREADY parked. Per `messageWorker`'s own doc, `resendOf` is "a manager who knows
the exact msgId/rootMsgId... can cite it to force the join" — a MORE deliberate assertion of "this is a
resend of that parked chain" than an inferred content-match auto-join, so excluding it was a two-path
asymmetry against this card's own stated intent (the first paragraph above: "a deliberate resend... is
never silently suppressed").

**The fix**: `joinedOntoParkedRoot`'s fresh component widens to
`bypassOwnershipGateOnce || (ctx.resendOf != null && isRootParked(recipientId, ctx.resendOf))` — a second,
independent disjunct, never folded into `bypassOwnershipGateOnce` itself. `bypassOwnershipGateOnce` (the
round-4 write bypass) stays BYTE-UNCHANGED, scoped only to a fresh `autoJoinedId` match: its safety depends
on `hasAmbiguousMatch` having content-matched the CURRENT dispatch's actual text against what may physically
still be sitting in the composer — real evidence the composer's dirty content is this dispatch's own body. A
manager-cited `resendOf` carries no such content-match guarantee (the manager could cite an id while sending
genuinely different text), so extending the write bypass to it would risk pressing Enter and submitting a
DIFFERENT lineage's real unconfirmed content under the wrong identity — the exact fusion/substitution risk
round 2 of card 844ca34e exists to prevent. Notice suppression is comparatively low-stakes (worst case: one
extra, disregardable `[loom:redelivery-parked]` notice, never data corruption), so broadening it alone to a
trusted, explicit `resendOf` is safe. `isRootParked` stays `recipientId`-scoped exactly as before — a
`resendOf` naming a root parked on a DIFFERENT worker gets no exemption, since that worker's own event
history never contains the citing recipient's root.

## Do not (round 2 additions)

- Do not fold the `ctx.resendOf`-onto-a-parked-root exemption into `bypassOwnershipGateOnce` itself — that
  variable's safety is tied to a FRESH, content-matched `autoJoinedId`; a `resendOf` carries no such
  guarantee and must never license the physical write bypass.
- Do not widen `redriveQueuedMessage`/`carryPendingToSuccessor`'s carry of `joinedOntoParkedRoot` into a
  live re-derivation (a fresh `isRootParked` call at redrive/recycle time) — it is a historical fact about
  the ORIGINAL dispatch's own join, carried verbatim, exactly like `kind`/`rootMsgId`/`chainDepth`.

Related: 844ca34e (the round 3/4 work this corrects), 085d9422 (the original duplicate-notice fix this
regression reopened for one sub-case), ba9225f0 (the prior verification of `suppressMootParkNotice`'s
mechanism that this card's regression postdates), 3b420e0d (round 2's own card).
