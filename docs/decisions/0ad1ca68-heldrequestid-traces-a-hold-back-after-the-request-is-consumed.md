# 0ad1ca68 — `heldRequestId` exists because a resolved Request stops being findable anywhere else

## Narrative

Card 0ad1ca68 added `Task.heldRequestId` — a standing annotation naming WHICH owner Request a card's `held` hold traces back to, independent of `held`/`deferred` themselves and independent of that Request's own `taskId` (a project-wide owner "decision" Request is very often filed with `taskId:null`, or tied to a sibling/epic card rather than this one).

The gap this closes: `held`/`deferred` are the brake, but neither says WHY — and once the gating Request is answered/consumed, it stops showing up as a live pending question anywhere, so a manager reading a still-held card long afterward has no mechanical way back to the decision that explains it, only body prose. Real specimen: session `bb707b3f` — a multi-harness epic held by an already-consumed 2026-08-27 answer, with the owner unable to find "which request is related to multi-harness epic".

## Do not

- Do not rely on body prose alone to trace a held card back to the Request that gates it — the Request stops showing up as a live pending question the moment it's answered/consumed, exactly when a manager most needs to find it.

## Source

JSDoc comment in `packages/shared/src/types.ts` (`Task.heldRequestId`'s own doc). Extracted by card 04705438 (tranche 2 on `packages/shared/src/types.ts`); reworded into flowing prose (split into two paragraphs), but the concrete specimen — session `bb707b3f`, the 2026-08-27 date, and the owner's quoted words — is carried verbatim.
