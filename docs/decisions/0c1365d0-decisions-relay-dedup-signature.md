# 0c1365d0 — decisions-relay dedup signature folds in title/body/options (REVISED by card 5ea0153c)

## Narrative

Card `0c1365d0`: `decisionSurfaceSignature` is a deterministic "as of this state" fingerprint used to tell a genuine re-alert (state/answer changed) apart from a repeat read of an unchanged pending decision, for the `decisions-relay` lever.

Originally only the answer tuple (`state`, `chosenOption`, `answeredAt`, `consumedAt`) was folded into the signature — a question's `title`/`body`/`options`/`recommendation` were set once at `question_ask` and never mutated afterward, confirmed by inspection of `db.ts`'s `UPDATE questions` statements at the time.

**REVISED by card `5ea0153c`:** `question_amend` (`db.ts`'s `amendQuestion`) now updates a still-`pending` row's `title`/`body`/`options` in place, so the immutability premise above no longer holds for those three fields. `decisionSurfaceSignature` now folds them in too, so an amendment reads as a genuine change here and a companion that already surfaced the ORIGINAL wording correctly reports `alreadySurfaced:false` (and re-narrates) for the amended one instead of silently suppressing it. `recommendation` stays OUT of the signature — no write path (question_amend included) ever touches it after `insertQuestion`, so it remains genuinely immutable.

## Do not

- Do not drop `title`/`body`/`options` back out of this signature — `question_amend` makes them mutable post-creation, and omitting them would mask a real amendment as `alreadySurfaced:true`, silently suppressing the re-narration the whole dedup mechanism exists to get right.
- Do not add `recommendation` without first re-verifying (against `db.ts`'s `UPDATE questions` statements) that it is still immutable post-creation.

## Source

Inline comment in `packages/daemon/src/companion/capabilities.ts` (`decisionSurfaceSignature`'s top-of-function doc), immediately above the function. Relocated by card `d091d3fa` (tranche on `companion/capabilities.ts`); revised by card `5ea0153c` (question_amend).
