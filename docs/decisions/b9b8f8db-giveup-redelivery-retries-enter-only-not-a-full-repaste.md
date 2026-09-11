# b9b8f8db (the composer-runaway fix) — a give-up redelivery retries ONLY the Enter, never repastes the body

## Narrative

Card b9b8f8db: a REDELIVERY of an already-attempted message — every member of `origin` carries `giveUpGen` (set only by `requeueGiveUpOrigin`'s `kept.push`) — must NOT repeat the backspace-then-repaste clear. `composerDirtyLen` is never reset except by a genuine confirmation, so in a genuinely wedged session (confirmation never arrives) every redelivery cycle used to backspace the FULL accumulated total and repaste the ~identical body again, compounding without bound. MEASURED: a 45,934 B kickoff's own single-generation write grew to 184,967 B — 4× — across 4 cycles in ~2.5 minutes.

The fix: since this exact message already put its own content in front of the engine once, ASSUME the composer still holds it (give or take the small possible-duplicate tag prefix `joinSubmittedText` adds at write time, which is never literally re-typed either way) and retry ONLY the Enter — do not touch the composer body at all.

**ASSUMPTION, stated (not inherited silently):** the composer genuinely still holds what was last written for this message — i.e. the earlier paste landed byte-for-byte and only the Enter/hook confirmation never registered. If that's wrong (a genuinely mangled/partial earlier paste), this Enter submits whatever content is ACTUALLY sitting there as a real turn, instead of self-correcting the way a full backspace+repaste would. That is a real tradeoff, taken deliberately: it applies ONLY to a message that has itself already been physically written once (never to a brand-new/different message, nor to a fresh re-mint's own FIRST attempt — `handleKickoffGiveUpExhausted`'s re-mint mints a NEW `QueuedMessage` with no `giveUpGen` of its own yet, so it still takes the full clear+repaste, unchanged), and it is bounded by the SAME `GIVE_UP_REQUEUE_LIMIT`/chainDepth cycle count as before — this does not remove the cap, it removes the wasted bytes inside each already-capped cycle.

This assumption was later found to have no way to verify itself when an intervening generation's own clear silently fails — see card `4796f999`, which closed that gap by adding a verification check on top of this same redelivery detection, and card `fa27d262`, which closed a second gap in the same detection when several queued entries coalesce into one redelivery batch.

## Do not

- Do not revert `giveUpGen`-gated redelivery detection back to a plain backspace+repaste for an already-attempted message — that reintroduces the unbounded compounding growth this card measured and fixed.

## Decision B (unrelated decision, same card id, `pty/host.ts`)

Card `b9b8f8db` also names the evidence that motivated building `flushComposer`/`worker_flush` (card
`3e76ecad`) in the first place: the owner recovered a session that had sat "apparently dead" for
~29 minutes by pressing Enter alone at the raw terminal — no new text, just the confirming keystroke.
Before `worker_flush` existed, a manager's only two documented remedies for a stranded worker were
`worker_message` (APPENDS, compounding an already-oversized buffer) or `worker_stop` + respawn
(DISCARDS whatever the worker had accumulated); this evidence is what justified adding a third,
submit-only option. **Not the same decision as the composer-runaway Enter-only-retry fix above** — this
is `worker_flush`'s own origin story, cited from the same card id at a different site.

## Source (this section only)

Inline JSDoc in `packages/daemon/src/pty/host.ts` (`flushComposer`'s own method doc), condensed, not
verbatim, as of main `df6d1c73` (this tranche's starting HEAD). Extracted by card `218e51fe`
(tranche 39 on `pty/host.ts`).

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`submit()`, the composer clear-prefix / give-up-redelivery block), lines 9826-9847, as of commit `dc53c7111807e103baf99544d3890df80e9a1c92` (this tranche's starting HEAD). Extracted by card `dfde8c66` (tranche 9). Regression test: `packages/daemon/test/pty-composer-runaway-bound.mjs`; also exercised by `packages/daemon/test/pty-giveup-clear.mjs`, `pty-giveup-requeue.mjs`, `pty-healifstuck-clear.mjs`, `pty-giveup-clear-single-attempt.mjs`.
