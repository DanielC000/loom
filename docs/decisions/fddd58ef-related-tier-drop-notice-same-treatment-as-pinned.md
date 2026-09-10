# fddd58ef — RELATED-tier drops get the same notice treatment as pinned, despite being best-effort

## Narrative

Card fddd58ef: unlike PINNED (which promises "injected IN FULL on EVERY kickoff," so a drop breaks a stated guarantee), RELATED is relevance-matched and best-effort BY CONSTRUCTION — nothing ever promised a given related note survives. That alone would argue for silence.

But MEASURED on this project's real corpus at its live `budgetTokens`, the drop rate was 100% (200/200 candidates across 25/25 real kickoffs) — not an occasional near-miss, a structurally dead tier with zero way for a reader to discover it. That volume is what earns RELATED the same `droppedRelatedKeys` + notice treatment as the pinned tiers (reusing the same key-list summarizer as the pinned tiers use — one idiom, not a second convention): the everything-past-the-break-point suffix of `related` (already rank-ordered, so no per-note collect-while-skipping is needed the way the pinned sub-tiers need it).

At the daemon-log level (`retrieveProjectMemoryForKickoff`), this card adds a third `console.warn` for RELATED-tier drops, at the SAME routine severity as the pinned-REST one — RELATED never promised full inclusion, so a drop here is not a broken guarantee either, and must not be logged as one.

## Do not

- Do not silence a RELATED-tier drop notice just because the tier is best-effort by construction — the measured 100% drop rate makes it a structurally dead tier without one.
- Do not give a RELATED-tier drop `console.error`/alarm severity — it never promised full inclusion, so its daemon log stays a routine `console.warn`, matching pinned-REST, not the `NEVER_DROP_TAG` alarm.

## Source

JSDoc comment above `composeProjectMemoryDigest` in `packages/daemon/src/sessions/project-memory-recall.ts`, lines 356-397 as of tranche 1 on that file; the log-severity paragraph is also cited, without new content, in `retrieveProjectMemoryForKickoff`'s own doc comment, lines 716-730 same file/tranche.
