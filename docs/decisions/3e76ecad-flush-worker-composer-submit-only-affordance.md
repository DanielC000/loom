# 3e76ecad — `flushWorkerComposer`: a manager-facing submit-only affordance, plus its `recovered`/`resumability` discriminators

## Narrative

Card `3e76ecad`: the manager-facing submit-only/flush affordance — press Enter on one of your workers'
own composer without writing any new text. See `pty.flushComposer`'s own doc for the mechanics
(genuinely non-writing, no-ops on an empty composer, a remedy to TRY not a guaranteed recovery, reuses
the existing give-up-redelivery Enter-retry ladder — see `docs/decisions/b9b8f8db-…md` for that
ladder's own design). This wrapper only adds the "not your worker" ownership gate (mirrors
`setWorkerMode`/`reapWorkerStrays`) and appends `worker.resumability` (`dead` vs `resumable`/`unknown`)
as a SECOND discriminator alongside the flush outcome: a `dead` session (its process/transcript already
confirmed gone) makes a submit-only retry moot regardless of what `ok`/`confirmed` report. The parent
card flagged this as possibly useful but left it unverified — surfaced as an ADDITIONAL signal, not a
replacement for `ok`/`reason`/`confirmed`.

Card `29b3c396` adds `recovered`: `confirmed:false` alone no longer distinguishes "still genuinely
running, just slow to confirm" from "was stuck and this flush just cleared it" — `recovered:true` means
THIS call's own give-up ladder fell through to GIVE-UP RECOVERY (busy cleared, the original message
requeued for redelivery on the next natural drain), so the caller should stop retrying.

Card `ac7884e3` adds `lastFlushAttribution` (always present, `null` when nothing has ever resolved) —
see that card's own record (`docs/decisions/ac7884e3-…md`) for the full reading guide. Read fresh from
`pty.getLastFlushAttribution` AFTER the flush call resolves, not taken from `result` itself: it is
STICKY (survives past any one call's own bounded wait), so this is the read that answers "did an EARLIER
flush on this worker eventually turn out to be attributable" — the case `result.attributable` cannot
cover, because that field only ever reflects THIS call's own generation resolving within THIS call's own
window.

## Do not

- Do not treat `ok`/`confirmed` alone as sufficient when `worker.resumability` is `dead` — a dead
  session's process/transcript is already confirmed gone, making a submit-only retry moot regardless of
  what the flush itself reports.
- Do not read `recovered:false` (or its absence) as "still stuck" — a `false` here just means this
  call's own give-up ladder didn't fall through to GIVE-UP RECOVERY; check `confirmed` for the
  still-running case.
- Do not read `lastFlushAttribution` off `result` — always re-fetch it fresh via
  `pty.getLastFlushAttribution` after the flush resolves; it is sticky across calls and `result` only
  ever reflects the current call's own generation.

## Related

- `docs/decisions/b9b8f8db-giveup-redelivery-retries-enter-only-not-a-full-repaste.md` — the
  give-up-redelivery Enter-retry ladder this flush reuses.
- `docs/decisions/ac7884e3-flush-attribution-gen-match-is-not-causation-proof.md` — `lastFlushAttribution`'s
  own reading guide.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, above `flushWorkerComposer`: lines
6934-6956, as of main `fbb3555c`. Relocated by card `1acde858` (tranche 17); wrapped source lines joined
into a flowing paragraph, wording otherwise unchanged.
