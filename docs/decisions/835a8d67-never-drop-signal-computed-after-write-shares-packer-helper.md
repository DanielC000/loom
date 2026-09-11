# 835a8d67 — `neverDropStatus` is post-write-only and shares the packer's own helper

## Narrative

Card 835a8d67 adds `neverDropStatus`, an informational signal returned ALONGSIDE a successful `memory_write` — never a rejection, and computed only after the write has already succeeded. It is present only when the note's (post-write) `tags` include `NEVER_DROP_TAG`, and takes one of two mutually exclusive shapes: `inert: true` when the tag sits on an UNPINNED note (the packer's floor tier is `pinned && never-drop`, per `computeFloorTierStatus`/`isNeverDrop` in `project-memory-recall.ts`, so an unpinned tagged note is never in it and the tag does nothing until the note is also pinned); or the floor-tier numbers (`floorTokens`/`budgetTokens`/`overBudget`) when the note actually IS pinned+never-drop and so is genuinely in the tier being measured.

The floor-tier numbers come from `computeFloorTierStatus` — the SAME helper `composeProjectMemoryDigest`'s own in-digest ALARM line uses internally (via `floorSectionTokens`). Sharing one function is deliberate: the number this write-time signal reports and what the packer actually drops on the next kickoff can never disagree, because both reads run through the identical computation.

## Do not

- Do not read `neverDropStatus` as a way to prevent or veto an over-cap/over-budget floor write — it is computed strictly after the write already succeeded (mirrors `MAX_NEVER_DROP_TEXT_BYTES`'s own rejecting precondition existing for exactly the class of problem this signal can only report on; see `046c721e`).
- Do not expect this signal on a note that is tagged `never-drop` but not pinned — it is present only for the pinned+never-drop combination; an unpinned tagged note gets the `inert: true` shape instead.
- Do not recompute the floor-tier numbers with a separate calculation — always route through `computeFloorTierStatus` so this signal and the digest's own ALARM line cannot silently diverge.

## Source

JSDoc comment above the `NeverDropSignal` interface in `packages/daemon/src/mcp/memory.ts`, condensed, not verbatim; a second, shorter citation of the same card near `writeProjectMemory`'s own doc comment restates the same fact and is not separately extracted here. Extracted by card `6fe7361d` (tranche 2 on this file).
