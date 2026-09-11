# 0ad1ca68 — two decisions share this card id (see `resolveRecord()`'s one-file-per-id rule)

Card `0ad1ca68` ("skip owner-gated respawns; persist hold links") shipped two independently-shippable halves in two different source files, each its own decision. Both are recorded here, under `## Decision A` / `## Decision B`, because `resolveRecord()` resolves an id to exactly one file — a second file for the same id would silently shadow one of the two, forever, with no error.

## Decision A — `heldRequestId` exists because a resolved Request stops being findable anywhere else

### Narrative

Card 0ad1ca68 added `Task.heldRequestId` — a standing annotation naming WHICH owner Request a card's `held` hold traces back to, independent of `held`/`deferred` themselves and independent of that Request's own `taskId` (a project-wide owner "decision" Request is very often filed with `taskId:null`, or tied to a sibling/epic card rather than this one).

The gap this closes: `held`/`deferred` are the brake, but neither says WHY — and once the gating Request is answered/consumed, it stops showing up as a live pending question anywhere, so a manager reading a still-held card long afterward has no mechanical way back to the decision that explains it, only body prose. Real specimen: session `bb707b3f` — a multi-harness epic held by an already-consumed 2026-08-27 answer, with the owner unable to find "which request is related to multi-harness epic".

### Do not

- Do not rely on body prose alone to trace a held card back to the Request that gates it — the Request stops showing up as a live pending question the moment it's answered/consumed, exactly when a manager most needs to find it.

### Source (this section only)

JSDoc comment in `packages/shared/src/types.ts` (`Task.heldRequestId`'s own doc). Extracted by card 04705438 (tranche 2 on `packages/shared/src/types.ts`); reworded into flowing prose (split into two paragraphs), but the concrete specimen — session `bb707b3f`, the 2026-08-27 date, and the owner's quoted words — is carried verbatim.

## Decision B — the pre-spawn owner-Request gate exists so a fresh manager seat isn't re-spawned into a board a predecessor already proved is 0-actionable (unrelated decision, same card id, `packages/daemon/src/orchestration/pending-request-gate.ts`)

### Narrative

`isProjectGatedOnPendingOwnerRequest` (`packages/daemon/src/orchestration/pending-request-gate.ts`) is a SPAWN-policy gate — deliberately NOT a nudge-policy change: `idle-watcher.ts`'s own `nonTerminal`/`openCards` predicate stays the source of truth for whether a LIVE manager gets idle-nudged, untouched by this function. This is the pre-spawn analogue of that check.

Before the Scheduler boots a fresh manager seat, it asks whether the project's board is already known to be fully gated on an unanswered owner Request. If so, an identical seat would just re-derive the same "0 actionable" conclusion a predecessor seat already reached, burning a full context window for zero commits. Real specimen: session `9d141891`, ~290 turns, shipped zero product change; its final report read "Board re-read fresh at park: 19 non-done … 2 owner-held + 17 deferred each on its own named unmet condition => **ACTIONABLE 0**".

### Do not

- Suppression is gated on an ACTUAL pending owner Request existing for this project, NEVER on "0 actionable cards" alone. A board can read 0-actionable for reasons that have nothing to do with the owner (every card manually deferred pending a sibling task, a lull between cards) — those cases must still get a fresh seat, because nothing else will ever re-check them. Only a genuinely owner-gated board — where the ONLY way forward is the owner answering something already sitting in their inbox — is safe to defer, because the owner's own answer already re-arms things (a stale-request escalation, per card `65ecafb3`, or the answer itself waking whoever asks next).

### Source (this section only)

Module-doc JSDoc comment above `isProjectGatedOnPendingOwnerRequest` in `packages/daemon/src/orchestration/pending-request-gate.ts`. Extracted by card b16cf56c (tranche 1 on `pending-request-gate.ts`); reworded into flowing prose, and the specimen identity (session `9d141891`, ~290 turns, zero product change) is carried verbatim from that JSDoc, which cited it as "the card's own specimen." The quoted final-report line ("Board re-read fresh at park: 19 non-done … 2 owner-held + 17 deferred each on its own named unmet condition => **ACTIONABLE 0**") is NOT from that JSDoc — the JSDoc never quoted it. It is carried verbatim (confirmed byte-for-byte) from card `0ad1ca68`'s own body, section "(1) The respawn cost — the real token burn", where the card itself attributes it to session `9d141891`. Not the same decision as Decision A above — see this file's own header line for why the two share an id.
