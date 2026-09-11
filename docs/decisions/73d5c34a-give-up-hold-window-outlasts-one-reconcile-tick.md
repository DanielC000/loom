# 73d5c34a — the give-up requeue hold window is sized past one reconcile tick, deliberately un-coupled

## Narrative

Card 73d5c34a: how long a GIVE-UP-requeued entry stays INELIGIBLE for `drainPending` after `requeueGiveUpOrigin` puts it back on `live.pending`, giving a late confirming hook a fair window to `purgeConfirmedGiveUpRequeue` it before anything can resubmit it a second time — see that method's doc for the race this closes (a ~10s reconcile tick beating a merely-late hook to the punch). Sized well past one reconcile tick (`watchers.reconcileMs`, daemon-default 10_000ms) so an ordinary reconcile pass can never win the race outright; NOT tied to the live reconcile interval itself (this file has no access to that daemon-resolved config, and coupling to it would make the bound implicit and un-overridable in isolation). Still a HARD bound, never infinite: a genuine give-up (no hook ever arrives) is held only this long before falling through to the pre-existing recovery-and-drain behavior (card 441499ee) — the silent-drop protection that bound exists to preserve. Env-overridable so a hermetic test can shrink it instead of waiting real seconds.

EXPORTED (card ccb407eb CR follow-up): `sessions/service.ts`'s cross-turn-boundary re-mint reuses this SAME constant when stamping its own `giveUpHeldUntil` — "matching the requeue path's own discipline" means literally sharing the bound, not maintaining a second one that could drift from it.

## Do not

- Do not couple this bound to the live reconcile interval directly — this file has no access to that daemon-resolved config, and doing so would make the bound implicit and un-overridable in isolation.
- Do not give `sessions/service.ts`'s cross-turn-boundary re-mint its own separate hold constant — it must reuse `GIVE_UP_HOLD_MS` so the two disciplines can never silently drift apart.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`GIVE_UP_HOLD_MS`'s top-of-const doc). Relocated by card a4818d7a (tranche 1 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.

## `drainPending`'s own held-entry skip — a second site under this same id

Card 73d5c34a: a still-`isGiveUpHeld` entry (see that method) is skipped when `drainPending` chooses what to drain next — it stays in `pending` at its current position, untouched, while the search for an eligible head continues past it. This is what stops a held entry (unshifted to the FRONT by `requeueGiveUpOrigin`) from stalling every unrelated queued message behind it: the FIRST non-held entry becomes the drain's effective head, and the same route/kind run-collection that follows additionally stops at the next held entry it meets (never folding a still-ambiguous entry into a run). If EVERY pending entry is held, the call is a no-op — exactly as if the queue were empty — and the reconcile tick that called it will simply find the same thing next time until a hook purges the hold or it expires (`GIVE_UP_HOLD_MS`).

## Do not (2)

- Do not let a still-held entry become (or be folded into) a drain's effective head or run — skip past it and let the next reconcile tick re-check once the hold clears naturally.

## Source (2)

Inline comment in `packages/daemon/src/pty/host.ts` (`drainPending`'s own top-of-method doc), as of commit `b05e83e4fc69ad67baa53fd70b25e97f9595e0be`. Relocated by card `84a4e0d0` (tranche 29 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.

## The FIFO-front guard — a genuinely fresh generation must not be misattributed

Card 73d5c34a (code review follow-up): the FIFO-front correlation assumes the next hook most likely confirms the OLDEST still-ambiguous generation — true whenever every generation since `gen` has ALSO given up. It stops being true the instant a genuinely FRESH, never-ambiguous generation is issued (e.g. an unrelated inbound message taking `enqueueStdin`'s idle immediate-submit path while `gen`'s entry sits held) and confirms quickly: THIS hook almost certainly proves the FRESH generation's turn, not `gen`'s — yet unconditional correlation would attribute it to `gen` and DELETE `gen`'s still-genuinely-unconfirmed entry, a SILENT LOSS worse than the duplicate this file exists to avoid ("fail toward a duplicate, never a loss" — a lost message is invisible to both sides; a duplicate is at least visible, and was how this card's specimen was caught). So the destructive delete loop runs ONLY when `live.submitGeneration` is either still `gen` itself (the common, single-ambiguity case) or is itself present in `giveUpConfirmQueue` (the established cross-generation case, handled exactly as before) — otherwise a fresh generation has taken over and this hook is left for it: `gen`'s entry survives, un-purged, to resolve via its own bounded hold (a duplicate at worst) instead of being deleted on a misattributed guess. The `turnEnded` queue-front shift stays UNCONDITIONAL regardless — it only ever discards bookkeeping (which generation is "next to maybe-confirm"), never a `pending` entry, so there is no data-loss risk in still advancing past `gen` even when this hook wasn't really about it; leaving it un-advanced would just leak `gen` in the queue forever once its entry has already drained under a later identity.

## Do not (3)

- Do not run the destructive delete loop unless `live.submitGeneration` is either still `gen` itself or present in `giveUpConfirmQueue` — a demonstrably fresh, non-ambiguous generation must be left for its own hook, or a still-genuinely-unconfirmed entry gets silently deleted.

## Source (3)

Inline JSDoc in `packages/daemon/src/pty/host.ts` (`purgeConfirmedGiveUpRequeue`'s own method doc, "THE GUARD BELOW" paragraph). Extracted by card `1c218980` (tranche 43 on `pty/host.ts`); condensed and reworded, not verbatim.
