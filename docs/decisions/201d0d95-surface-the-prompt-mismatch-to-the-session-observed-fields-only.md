# 201d0d95 — surface a submit-generation mismatch to the session, OBSERVED FIELDS ONLY

## Narrative

Card `201d0d95` Q1: SURFACE the mismatch to the session itself. Until this card, every branch of the
`UserPromptSubmit` mismatch-detection logic was LOG-ONLY (`daemon-output.log`), and the shipped doctrine
(orchestrate/SKILL.md) only ever documented the `byteIdentical=true` happy path — a manager had no way to
learn a submission had been silently substituted, nor that whatever WAS submitted might be a re-delivery
of an earlier message.

Fires on every `byteIdentical=false` confirmation reaching this point — not only the exact
single-generation-replay shape that originally motivated it — since ANY mismatch here means a turn is
about to run (or just ran) on content Loom did not intend for this generation.

**Report OBSERVED FIELDS ONLY** (lengths/hashes/gens) — never assert a CLI-internal CAUSE, which lives
outside this repo and is unverified (card `201d0d95` DoD-2's own stated limit). Name BOTH halves, since a
notice naming only one leaves the other invisible: the intended text may not have reached the engine at
all (a possible LOSS), and separately, the content that WAS submitted may itself be a duplicate
re-delivery of an earlier generation (a possible DUPLICATE) — checked directly against
`live.recentWrittenTurns` (the same ring `detectComposerAccumulation` already reads), a single-entry exact
match rather than a concatenated-span match, so this can name the specific prior generation when one
matches.

**Measured regularity, not a mechanism:** a Platform sweep, 2026-08-05, over RETAINED logs (a FLOOR, not
an all-time rate): 3,816 `[prompt-echo]` records, 288 mismatches (7.5%), 15 SUBSTITUTION-SIGNATURE
occurrences across 14 sessions (0.39% of submissions) — recurred within one session (gen 5 and gen 8), and
CURRENT (a session live on this fleet the same day). In ALL 15, the replay was of the IMMEDIATELY
PRECEDING RECORDED generation (N←N-1, never older) and `reportedLen < writtenLen` (the newer, larger
payload is always what's lost). LIMITS on that count: only this card's own gen=7/8 pair was eyeballed on
raw lines — the other 14 are matched by signature only, not individually inspected; the other 273
mismatches were NOT classified into this shape and must not be folded into it (plausibly the
pre-registered benign/accumulation classes instead); a gen number can be absent from the echo record, so
"N-1" means the previous *recorded* generation. This is a MEASURED REGULARITY, not a mechanism — the
notice states it as an observed pattern to help a reader find the right earlier message, never as a
claimed CAUSE.

**`findLast`, not `find`, when matching the replay ring:** Loom's own `warning`-kind nudges are
REPEATEDLY re-sent byte-identical text by construction (idle/context/busy-stuck watchdogs, boot
continuation notes), so the SAME string legitimately appearing at more than one generation in this ring is
an ordinary occurrence, not a contrived one. `find` would return the OLDEST match — if identical text was
also written at an earlier, non-adjacent generation, that would mislabel a genuine N-1 replay as an
"unusual shape", manufacturing apparent counter-evidence against the measured N←N-1 regularity this
notice itself cites. `findLast` returns the MOST RECENT matching generation, which is the one an actual
replay-of-the-immediately-preceding-submission would produce.

### Self-reference, noted and bounded

This notice is ITSELF delivered as a pty submission, which sets `live.lastPrompt` for its OWN generation exactly like any other turn — so a substituted mismatch-notice is structurally possible ("a mismatch notice about a mismatch notice"), and nothing downstream can currently tell a replayed NOTICE apart from a replayed ordinary payload. Deliberately NOT guarded (no recursion cap, no dedup): at the measured 0.39%-of-submissions base rate (see above), the expected chain length is `~1/(1-0.0039) ≈ 1.004` — a guard would be defending against an event this arithmetic says essentially never compounds — and the notice's own `kind:"warning"` coalescing further dampens any chain that did start, by merging with whatever else is already queued rather than stacking. If a cheap, non-invasive way to let a recipient distinguish "this IS a prompt-mismatch notice, replayed" from "this is a replayed ordinary message" turns up (e.g. a recognizable tag check), that is a follow-up, not scope creep here.

## Do not

- Do not assert a CLI-internal cause in the session-facing notice — only observed fields (lengths, hashes,
  generation numbers) are known; the cause lives outside this repo and is unverified.
- Do not fold the other 273 (of 288) measured mismatches into the N←N-1 substitution-signature shape —
  they were not individually classified and are plausibly the pre-registered benign/accumulation classes.
- Do not use `find` in place of `findLast` when matching the replay ring — `find` returns the oldest
  match, which can mislabel a genuine immediately-preceding replay as an unusual, non-adjacent one.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`deliverHook`'s `UserPromptSubmit` case, the
mismatch-notice-composition block), as of `main` `e0f71681`. Extracted by card `54dc1362` (tranche 20 on
`pty/host.ts`); wording condensed, content preserved.
