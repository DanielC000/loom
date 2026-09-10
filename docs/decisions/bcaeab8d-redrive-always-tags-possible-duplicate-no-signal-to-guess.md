# bcaeab8d — a redrive always tags `framePossibleDuplicate`, because this route has no signal to guess from

## Narrative

Card bcaeab8d: `redriveQueuedMessage` hands the recipient `framePossibleDuplicate`-tagged text
unconditionally, whether or not the message was actually delivered before. This is Loom's ONLY
redelivery route with no in-process signal of a prior attempt — unlike a same-turn coalesced arrival
(gated on `giveUpGen`/`chainDepth`, a reliable in-process signal that "this exact attempt already failed
to confirm once"), a redrive can run after a daemon restart, and the persisted `session_message_queued`
row is never mutated with an attempt count. There is no way to tell "first-ever delivery, recipient just
wasn't live yet" apart from "already physically written once, but the delivered marker never made it to
disk before a crash" (that race is card bcaeab8d's own DoD-6, deliberately left unverified).

Given that genuine ambiguity, tag UNCONDITIONALLY rather than silently guess: `framePossibleDuplicate` is
idempotent (strips any existing frame first) and costs nothing on the common first-delivery case beyond a
harmless, self-explanatory prefix — the alternative is a redelivery that is STRUCTURALLY INCAPABLE of
ever being flagged as one. The original `text` stays pristine for `onGiveUpExhausted`'s own re-mint,
which applies this same framing itself with the unframed original.

DoD-4 (a related follow-up on the same card): before this fix, the ONLY log line anywhere in the redrive
machinery was the decline branch (retiring a stale row) — the branch that actually re-sends logged
nothing at any spelling, which is exactly why a prior peer's log census of `redrive`/`session_message_queued`
came back a censored zero instead of a genuine absence. The re-send branch now logs too, anchored with the
same `^[redrive]` prefix as the decline branch so both are greppable the same way.

## Do not

- Do not try to infer "first delivery" vs "already delivered once" for a redrive and skip the duplicate
  tag on the inferred-first-delivery branch — there is no persisted attempt count to infer it from, and
  guessing wrong is a redelivery that silently looks like a duplicate should have been flagged as one.
- Do not add a NEW un-logged branch to the redrive machinery — every branch that re-sends logs with the
  `^[redrive]` prefix so a log census can find it.

## `redriveQueuedMessage` is idempotent two separate ways

The single per-message engine shared by the one-shot boot scan (`recoverUndeliveredMessagesOnBoot`) and
the resume/live-flip path (`redriveUndeliveredMessagesForRecipient`), so the two can NEVER
double-deliver. Idempotent TWO ways: (1) the in-process `redriveInFlightMsgIds` guard — a msgId whose
previous re-drive is still HELD in a FIFO is reported `"reEnqueued"` without enqueuing a SECOND copy (the
guard the boot-scan↔resume overlap needs, since the held record stays unresolved until it drains); (2)
across restarts, the durable `session_message_delivered` marker (the unresolved-set query already
excludes resolved ones, and `resolveQueuedMessage` is a no-op if already marked).

### Do not (2)

- Do not add a third re-drive path without going through `redriveQueuedMessage` — it is the single shared
  engine specifically so the boot scan and the resume/live-flip path can never double-deliver.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`redriveQueuedMessage`'s own JSDoc and its
re-enqueue branch): lines 5105-5124 and 5245-5284, as of main `1cbc0d74`. Relocated by card `61632c05`
(tranche 15); no wording changed, wrapped source lines joined into a flowing paragraph and the `*`/`//`
comment markers stripped.
