# 34a6f07e — the LIVE-COMMITMENTS count check is a FLOOR (`>=`), never an exact EQUALITY (`===`)

## Narrative

An earlier version of the resume-doc rotation checker used an exact-count check for the LIVE-COMMITMENTS-style numbered section. An exact-count check let a doc dodge protection by keeping new commitments OUT of the counted section entirely — a fixed arity doesn't merely fail to catch overflow, it actively CREATES an incentive to produce it, since any count other than the exact expected number reads as a failure regardless of whether the doc actually grew or shrank in the direction that matters.

`rotation-check.ts` (card 1069c8e1, a fresh TypeScript port of `rotation-gate.mjs`'s algorithm) does not automatically inherit any bug the script already fixed, so this port carries a regression test proving the floor check stays `>=`. `countNumberedSection`'s caller in `checkRotation` computes `ok` as `section.count !== null && section.count >= input.commitmentsFloor` — never `===` — so a doc that has grown its live-commitments section still passes.

## Do not

- Do not replace the `>=` floor comparison with an exact `===` equality check — that reopens the incentive to keep new commitments out of the counted section rather than growing it.
- Do not treat this as merely a stylistic choice; it is the fix for a specific historical bug (the equality-vs-floor bug) in the script this module ports.

## Specimen — a doc dodging the equality check by keeping new commitments OUT of the counted section

`rotation-gate.mjs`'s own check used to be named `REQUIRED_LIVE_COMMITMENTS_COUNT`, checked with equality (`!==`) — the name this bug's fix retired. Measured live on one seat's own rotation: 6 new binding terms were pushed into prose ABOVE the LIVE COMMITMENTS list specifically to dodge that (then-exact-count) check, and a doc that later dropped that prose block entirely still passed, because the equality check never looked at it either way. This is the concrete incident the floor fix (above) exists to close — not a hypothetical. The script's own name and `--help` text already promised the right (floor) semantics — "refuse to promote a rotation that … SHRINKS the LIVE COMMITMENTS list" — the exact-count implementation simply never matched its own documented contract.

## The floor VALUE has its own lifecycle, independent of the equality-vs-floor bug fix

`LIVE_COMMITMENTS_FLOOR` in `rotation-gate.mjs` was RAISED 14 → 20 by this same card (`34a6f07e`, 2026-08-28), to protect the 6 terms from the specimen above once they were moved into the counted section. It was later LOWERED 20 → 12 by card `bcd3f690` (2026-09-02), as part of that card's "cleanup all bad ceremonies" cut: real numbered LIVE COMMITMENTS items were removed alongside 3 retired markers (see `bcd3f690`), and 12 is the floor on what the lead's post-cut doc would still carry, based on the lead's own count of at least 12 surviving items.

This lands ahead of the matching vault edit — the same ordering rationale as `bcd3f690`'s marker cut (see that record). Lowering a `>=` floor ahead of the doc actually shrinking is always safe: a lower floor can only ever be MORE permissive, never refuse a doc that would have passed the old higher floor. The constant is the ONE place this number lives — whoever next changes the vault's real commitment count must update it in the SAME edit, never let it silently drift the way the marker list itself has already been shown to drift.

## Do not (specimen/lifecycle)

- Do not read "the record already covers the equality-vs-floor bug" as covering this specimen too — the specimen is the concrete proof the bug was real, not a restatement of the rule.
- Do not change `LIVE_COMMITMENTS_FLOOR` without updating it in the same edit as whatever changed the vault's real commitment count — a stale floor drifts silently, exactly like the marker list.

## Source

Inline JSDoc in `packages/daemon/src/orchestration/rotation-check.ts` (file header), as of this tranche's HEAD, prior to compression. Extracted by card `1c247269` (tranche 1 on `orchestration/rotation-check.ts`). Specimen/lifecycle sections are condensed/paraphrased from the inline file-header comment ("⭐ LIVE_COMMITMENTS_FLOOR IS A FLOOR, NOT AN EXACT COUNT") in `packages/daemon/scripts/rotation-gate.mjs`, as of base sha `79bf901d` — this section's wording is NOT a verbatim quote of the source comment. Extracted by card `7a4c54f3` (tranche 1 on `packages/daemon/scripts/rotation-gate.mjs`).
