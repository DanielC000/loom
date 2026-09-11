# d78a6d5d — 2026-08-28 re-verification of the `MARKERS` copy against the live vault section

## Narrative

The `MARKERS` list in `packages/daemon/scripts/rotation-gate.mjs` is a copy of `Projects/Loom/Operations/Orchestrator Rules.md` §ROTATION-GATE, and that copy can drift silently since the vault file is unreachable from this repo/worktree. Card `d78a6d5d` re-verified the copy against the live vault section on 2026-08-28: at that point the marker list held 14 entries and matched §ROTATION-GATE verbatim, with no drift found. This verification is now superseded by the later cuts (`bcd3f690`'s 2026-09-02 retirement of 3 markers, `a681aed5`'s same-day restoration of one) — kept here only for provenance of when the copy was last confirmed accurate.

## Do not

- Do not treat this 2026-08-28 verification as still current — the marker count and contents have changed since (see `bcd3f690` and `a681aed5`).
- Do not assume the copy is self-verifying — it must be re-checked against the live vault section by whoever next edits this file (see `packages/daemon/scripts/rotation-gate.mjs`'s own `--audit-vault` mechanism, card `d8062fbb`, for the opt-in mechanical way to do this).

## Source

Condensed/paraphrased from the inline file-header comment ("Prior verification history") in `packages/daemon/scripts/rotation-gate.mjs`, as of base sha `79bf901d` — this record's wording is NOT a verbatim quote of the source comment. Extracted by card `7a4c54f3` (tranche 1 on `packages/daemon/scripts/rotation-gate.mjs`).
