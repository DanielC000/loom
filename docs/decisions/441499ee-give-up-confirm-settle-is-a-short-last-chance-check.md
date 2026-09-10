# 441499ee — the give-up confirm-settle window is a short last-chance check, not full coverage

## Narrative

Card 441499ee (hardening against the give-up discriminator's own measured false-negative rate — card 04de8bbf, n=84: ~86% of give-ups that reach this point are followed by a confirming hook, i.e. the turn actually started; only ~14% are genuine drops). A SHORT, bounded, OBSERVED wait for `enterConfirmed` to flip true, inserted right where the output-based discriminator has ALREADY failed to suppress a give-up — see `awaitGiveUpConfirmSettle`. Modeled on `REASSERT_SETTLE_POLL_MS`/`REASSERT_SETTLE_MAX_POLLS`'s own shape and accept-a-residual philosophy, but kept as an INDEPENDENT constant pair: that one is sized against a measured LOCAL terminal-protocol renegotiation latency (a completely different, much faster mechanism than an actual hook round-trip), so reusing it here would smuggle in an unmeasured assumption.

DELIBERATELY NOT sized to cover the full hook-confirmation latency distribution — give-ups are CONTENTION-DRIVEN BURSTS (see `SUBMIT_VERIFY_TIMEOUT_MS`'s own rejected-alternative note), so a bound wide enough to reliably catch a contention-delayed hook would have to keep growing to chase wherever fleet contention peaks next — the exact anti-pattern this project has reverted twice (cards 595aad10, fea23514). This is a SHORT last-chance check that only claims to catch the FASTEST-confirming subset of the 86% for free (zero requeue, zero purge race, ever, for those); anything slower still falls through to GIVE-UP RECOVERY's existing requeue, with `purgeConfirmedGiveUpRequeue` as the defense-in-depth for a confirmation that arrives later still, before the requeued entry has actually drained. Closing the gap further needs the discriminator itself fixed (04de8bbf), not a bigger constant here.

## Do not

- Do not reuse `REASSERT_SETTLE_POLL_MS`/`REASSERT_SETTLE_MAX_POLLS` for this window — that pair is sized against a measured LOCAL terminal-protocol renegotiation, a different and much faster mechanism than an actual hook round-trip.
- Do not widen this bound to chase fleet contention — that anti-pattern has been reverted twice already (cards 595aad10, fea23514). Closing the gap further needs the discriminator itself fixed (card 04de8bbf), not a bigger constant here.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`GIVE_UP_CONFIRM_SETTLE_POLL_MS`/`GIVE_UP_CONFIRM_SETTLE_MAX_POLLS`'s top-of-const doc). Relocated by card a4818d7a (tranche 1 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.

## `giveUpRequeues`/`giveUpGen` are per-message identity-scoped counters guarding the same false-negative

`giveUpRequeues` (QueuedMessage field) counts how many times THIS EXACT message object has already been
put back on `live.pending` after a submit give-up — identity-scoped to the object itself, never inferred
from matching text, so two legitimately identical messages are counted independently and a message that
keeps giving up can't requeue forever (bounded by `GIVE_UP_REQUEUE_LIMIT`).

`giveUpGen` tags a requeued entry with the `submitGeneration` its ORIGINAL (failed) submit ran under. The
give-up discriminator that produces both fields can itself be wrong in the OTHER direction too — a
confirming hook can arrive AFTER give-up already fired, proving the original turn actually started (this is
exactly the measured ~86% case this record's Narrative describes) — so `giveUpGen` is the correlation a
late confirmation uses (`purgeConfirmedGiveUpRequeue`) to find and purge the now-redundant requeued copy
before it can ever drain and double-deliver the same text.

## Do not (2)

- Do not infer `giveUpRequeues` from matching message TEXT — scope it to the message object's own identity,
  or two legitimately-identical messages get their retry budgets conflated.

## Source (2)

Inline comment in `packages/daemon/src/pty/host.ts` (the `giveUpRequeues`/`giveUpGen` field docs on
`QueuedMessage`), as of commit `88f11385c2c863db682b8e0d37c9a5f0118b0d17` (`fix(pty): hold a give-up
requeue and stop the purge misattributing it`). Relocated by card `3f45b7d8` (tranche 6 on `pty/host.ts`).
