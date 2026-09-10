# 47c11741 — `onPasteTripwireGiveUp` fires when the paste-recovery re-injection ITSELF also collapsed

## Narrative

Card 47c11741: the bare-placeholder tripwire's own one-shot RECOVERY re-injection (`PASTE_RECOVERY_TAG`, `paste-tripwire.ts`) ALSO collapsed — the give-up path, right where the combined `[paste-tripwire]` console.warn (this file's Stop-hook call site) already fires.

Distinct from `onPasteLengthLoss`: that one fires when Loom never wrote the lost text at all (the human/raw-paste gap); THIS one fires when Loom DID write it (twice) and DID detect both collapses, but the automatic-recovery budget is exhausted (one-shot by design — a second automatic attempt isn't warranted). `PtyHost` itself cannot notify beyond the session (no DB, no manager lookup — same layering boundary as `onPasteLengthLoss`/`onKickoffGiveUpExhausted`); the implementer (`sessions/service.ts`) decides how to fail loud to both the recipient and — where one exists — the sender, reusing `handlePasteLengthLoss`'s established shape rather than inventing a second one. `token` is whatever `matchEmbeddedPlaceholderToken` found in this turn's recorded text (may be `null` — the give-up itself never depends on a token match).

## Do not

- Do not conflate `onPasteTripwireGiveUp` with `onPasteLengthLoss` — the former fires when Loom wrote the text (twice) and the automatic recovery re-injection itself also collapsed; the latter fires when Loom never wrote the lost text at all.
- Do not retry the automatic paste-recovery re-injection a second time — it is one-shot by design; this event is the fail-loud report once that budget is exhausted, not a signal to retry.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `onPasteTripwireGiveUp` field doc on `PtyHostEvents`), as of `main` `8d9fe59d`. Extracted by card `a2a6b2ad` (tranche 11 on `pty/host.ts`); wording unchanged beyond joining wrapped lines and stripping `*` markers.
