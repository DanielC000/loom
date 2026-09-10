# 738568b6 — the related-tier reserve is PROBED, never reserved unconditionally

## Narrative

`RELATED_RESERVE_FRACTION` (30%) is the MAXIMUM share of `budgetTokens` the RELATED tier can wall off from the pinned-REST sub-tier — a CEILING on the reservation, not an unconditional grant. Card 738568b6 fixes a structural bug, not a tuning shortfall: `PLATFORM_DEFAULTS`' own `memory.budgetTokens` doc comment (`shared/src/config.ts`) states the 4000-token default is sized for "a handful of pinned notes plus a sizeable related-tier slice" — but before this fix, pinned-REST packed greedily against the FULL budget with no reservation, so any pinned set that alone exceeded `budgetTokens` (measured live on this project: ~20,300 tokens of pinned notes vs. a 4000 budget) left RELATED a guaranteed, permanent zero — the exact opposite of the documented intent.

30%, derived from this project's own measured corpus (`memory_list`, 2026-08-05): unpinned note blocks (the RELATED tier's own population) average ~782 tokens / median ~831 tokens, so a 30% reserve (1200 tokens at the 4000 default) reliably fits at least one typically-sized related note plus its section header, with room for a second smaller match — while still leaving 70% for pinned.

CORRECTED (code review, same card): an EARLIER version of this fix reserved this fraction UNCONDITIONALLY, regardless of whether related had anything in it or needed the full reserve — an empty or small related tier then walled off space nothing occupied, dropping MORE pinned notes than before this card for ZERO benefit (a straight regression the original test suite couldn't see, since it only ever seeded related notes bigger than the reserve). `composeProjectMemoryDigest` now PROBES how much related would ACTUALLY consume (via `packRelatedPrefix`, capped at this fraction) and reserves only THAT — empty related ⇒ zero reserved ⇒ byte-identical to pre-this-card behavior.

This DELIBERATELY drops MORE ordinary pinned notes than before under a tight budget WHEN related genuinely needs the room: a note the FTS matcher scored against THIS task's text is more likely to matter for THIS task than the Nth-most-recent general pinned note, so trading some of that margin to related is the intended outcome, not a regression — but ONLY when related actually uses it. `NEVER_DROP_TAG` notes are UNAFFECTED — the floor tier keeps packing against the FULL `budgetTokens` exactly as before; this reserve narrows only the ordinary pinned-REST sub-tier's own ceiling, and whatever it reduces can only be eaten by FLOOR (which keeps absolute priority), never by REST.

## Do not

- Do not reserve `RELATED_RESERVE_FRACTION` unconditionally — probe via `packRelatedPrefix` first, and reserve only what related actually needs.
- Do not apply this reserve to `NEVER_DROP_TAG` notes — the floor tier always packs against the full `budgetTokens`.
- Do not re-derive the 30% figure without re-measuring the corpus — it's sized off this project's own average/median unpinned note size, not a universal constant.

## Source

JSDoc comment above `RELATED_RESERVE_FRACTION` in `packages/daemon/src/sessions/project-memory-recall.ts`, lines 215-239 as of tranche 1 on that file; also cited (mechanism recap only, no new content) in `composeProjectMemoryDigest`'s own doc comment, lines 356-397 same file/tranche.
