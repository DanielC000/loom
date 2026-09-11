# d78a6d5d — 2026-08-28 re-verification of the `MARKERS` copy against the live vault section

## Narrative

The `MARKERS` list in `packages/daemon/scripts/rotation-gate.mjs` is a copy of `Projects/Loom/Operations/Orchestrator Rules.md` §ROTATION-GATE, and that copy can drift silently since the vault file is unreachable from this repo/worktree. Card `d78a6d5d` re-verified the copy against the live vault section on 2026-08-28: at that point the marker list held 14 entries and matched §ROTATION-GATE verbatim, with no drift found. This verification is now superseded by the later cuts (`bcd3f690`'s 2026-09-02 retirement of 3 markers, `a681aed5`'s same-day restoration of one) — kept here only for provenance of when the copy was last confirmed accurate.

## Do not

- Do not treat this 2026-08-28 verification as still current — the marker count and contents have changed since (see `bcd3f690` and `a681aed5`).
- Do not assume the copy is self-verifying — it must be re-checked against the live vault section by whoever next edits this file (see `packages/daemon/scripts/rotation-gate.mjs`'s own `--audit-vault` mechanism, card `d8062fbb`, for the opt-in mechanical way to do this).

## Decision B — the START boundary must anchor on a heading LINE, never a bare substring search

The same card's work on `rotation-gate.mjs` also fixed a second bug in `countLiveCommitmentsIn`: the prior version located the LIVE COMMITMENTS section's START via a plain case-insensitive `indexOf` on the raw text, so a PROSE mention of the boundary token anywhere above the section's real heading (e.g. a doc's own header block that happens to document this gate's contract in the same words) silently redefined the measured span, producing a maximally-alarming false "0 numbered item(s), expected 14" on an otherwise-correct document. The fix anchors the START boundary to a markdown HEADING LINE instead, the same structural mechanism the END boundary already uses (heading DEPTH, never a heading's NAME — see `a681aed5`): a prose mention that is never itself a heading line can no longer open the section.

## Do not (Decision B)

- Do not anchor the START boundary (or any section boundary) on a bare substring search — a prose mention of the boundary token elsewhere in the text can silently redefine the measured span, and the failure here is a false NEGATIVE (an undercount), the mirror image of `a681aed5`'s false-open overcount.

## Source

Condensed/paraphrased from the inline file-header comment ("Prior verification history") in `packages/daemon/scripts/rotation-gate.mjs`, as of base sha `79bf901d` — this record's wording is NOT a verbatim quote of the source comment. Extracted by card `7a4c54f3` (tranche 1 on `packages/daemon/scripts/rotation-gate.mjs`). Decision B is condensed/paraphrased from inline comments in `countLiveCommitmentsIn` (same file), as of base sha `0ffb1755` — also not a verbatim quote. Extracted by card `02588501` (tranche 2 on `packages/daemon/scripts/rotation-gate.mjs`).
