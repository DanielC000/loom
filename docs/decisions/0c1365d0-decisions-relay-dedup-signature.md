# 0c1365d0 — decisions-relay dedup signature only folds in the answer tuple

## Narrative

Card `0c1365d0`: `decisionSurfaceSignature` is a deterministic "as of this state" fingerprint used to tell a genuine re-alert (state/answer changed) apart from a repeat read of an unchanged pending decision, for the `decisions-relay` lever.

Only the answer tuple (`state`, `chosenOption`, `answeredAt`, `consumedAt`) is folded into the signature — a question's `title`/`body`/`options`/`recommendation` are set once at `question_ask` and never mutated afterward. This was confirmed by inspection of `db.ts`: its only `UPDATE questions` statements touch `session_id`/`project_id` reparenting, or the `state`/`chosen_option`/`note`/`answered_at`/`consumed_at`/`provision_*` columns — never `title`/`body`/`options_json`/`recommendation`. Folding those immutable fields into the signature would never change it and would just be dead weight.

## Do not

- Do not add `title`/`body`/`options`/`recommendation` to this signature without first re-verifying (against `db.ts`'s `UPDATE questions` statements) that they are still immutable post-creation — if a future change makes any of them mutable, the signature must be extended to include it or a genuine re-alert would be missed.

## Source

Inline comment in `packages/daemon/src/companion/capabilities.ts` (`decisionSurfaceSignature`'s top-of-function doc): lines 609-617, as of this tranche's HEAD. Relocated by card `d091d3fa` (tranche on `companion/capabilities.ts`); no wording changed beyond joining wrapped source lines into flowing paragraphs and stripping `*` comment markers.
