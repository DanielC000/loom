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
  re-arm fallback (the manager-recycle carry path) both call `handleGiveUpExhausted` WITHOUT this
  parameter at all, defaulting to `false` — unchanged behavior. `isAutoJoinedResend` was never threaded
  through either path before this fix (neither the live in-memory flag nor the persisted
  `session_message_queued` durable-record detail ever carried it), so there is nothing to migrate: a
  chain that survives a restart or a manager recycle has always lost this status and reverted to the
  default, non-exempt behavior. That default fails toward MORE suppression (fewer sender-visible
  notices), never toward the duplicate-notice regression this card fixes, so the pre-existing gap is
  safe to leave as-is rather than widen the persisted record schema to carry it.
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
- Do not widen `redriveQueuedMessage`/`carryPendingToSuccessor` to carry `joinedOntoParkedRoot` across a
  restart/recycle without also checking whether the matching persisted `session_message_queued` detail
  needs a new field — today neither path threads it, by design (see above); adding one half without the
  other silently reintroduces an inconsistency.

Related: 844ca34e (the round 3/4 work this corrects), 085d9422 (the original duplicate-notice fix this
regression reopened for one sub-case), ba9225f0 (the prior verification of `suppressMootParkNotice`'s
mechanism that this card's regression postdates).
