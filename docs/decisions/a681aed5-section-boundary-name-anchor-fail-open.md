# a681aed5 — section-boundary must anchor on heading DEPTH, never a heading's NAME

## Narrative

`packages/daemon/scripts/rotation-gate.mjs` (the original resume-doc rotation checker) anchored the LIVE-COMMITMENTS-style section's END boundary on a heading's NAME. Once that heading was renamed, the boundary lookup silently fell back to end-of-file, sweeping in an unrelated trailing numbered list and INFLATING the counted-item total. This fails OPEN: a doc that had actually lost real commitments could still read as passing, because the inflated count from the swept-in unrelated list happened to clear the floor.

`rotation-check.ts` is a fresh TypeScript port of the same algorithm (card 1069c8e1) and does not automatically inherit any bug the script already fixed, so this port carries a regression test proving it reproduces the fix, not the bug. `findSectionBoundary` (in `rotation-check.ts`) anchors the section's end STRUCTURALLY by markdown heading DEPTH instead: the first line at or after the section start whose heading level is <= the section heading's own level ends the section, regardless of that heading's name or wording. A deeper heading (e.g. a sub-note nested inside the section) does not prematurely end it; a shallower or same-level heading ends it even if its name has changed. "Same level or shallower" is what gets both cases right.

## Do not

- Do not anchor a section boundary on a heading's NAME/text — a rename silently reopens the fail-open behavior this fix closes.
- Do not treat a `rotation-check.ts` regression test for this bug as optional — it is the proof this TypeScript port did not reintroduce a bug already fixed once in `rotation-gate.mjs`.

## Source

Inline JSDoc in `packages/daemon/src/orchestration/rotation-check.ts` (file header, `findSectionBoundary`'s own doc), as of this tranche's HEAD, prior to compression. Extracted by card `1c247269` (tranche 1 on `orchestration/rotation-check.ts`).
