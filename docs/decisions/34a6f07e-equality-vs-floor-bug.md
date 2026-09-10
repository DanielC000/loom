# 34a6f07e — the LIVE-COMMITMENTS count check is a FLOOR (`>=`), never an exact EQUALITY (`===`)

## Narrative

An earlier version of the resume-doc rotation checker used an exact-count check for the LIVE-COMMITMENTS-style numbered section. An exact-count check let a doc dodge protection by keeping new commitments OUT of the counted section entirely — a fixed arity doesn't merely fail to catch overflow, it actively CREATES an incentive to produce it, since any count other than the exact expected number reads as a failure regardless of whether the doc actually grew or shrank in the direction that matters.

`rotation-check.ts` (card 1069c8e1, a fresh TypeScript port of `rotation-gate.mjs`'s algorithm) does not automatically inherit any bug the script already fixed, so this port carries a regression test proving the floor check stays `>=`. `countNumberedSection`'s caller in `checkRotation` computes `ok` as `section.count !== null && section.count >= input.commitmentsFloor` — never `===` — so a doc that has grown its live-commitments section still passes.

## Do not

- Do not replace the `>=` floor comparison with an exact `===` equality check — that reopens the incentive to keep new commitments out of the counted section rather than growing it.
- Do not treat this as merely a stylistic choice; it is the fix for a specific historical bug (the equality-vs-floor bug) in the script this module ports.

## Source

Inline JSDoc in `packages/daemon/src/orchestration/rotation-check.ts` (file header), as of this tranche's HEAD, prior to compression. Extracted by card `1c247269` (tranche 1 on `orchestration/rotation-check.ts`).
