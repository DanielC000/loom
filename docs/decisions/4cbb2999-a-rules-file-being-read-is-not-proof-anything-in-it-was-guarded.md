# 4cbb2999 — a rules file being READ by `--rules` is not proof anything in it was actually GUARDED

## Narrative

ADDED 2026-09-07 (card `4cbb2999`, found by the Platform Lead on its own setup and reported unprompted): two new markers, `PRAISE-IS-THE-LEAST-AUDITED-INPUT` and `PRE-MERGE-PAIR` — the `MARKERS` list grew 10 → 12 entries.

THE FALSE GREEN THIS FIXES: `resume_doc_check`'s (and `rotation-gate.mjs`'s own) `--rules`/`rulesPath` union satisfies a marker from EITHER the active doc OR a listed rules file — so a rules file merely being READ was never proof anything in it was GUARDED. Measured live: all 10 pre-existing markers resolved via the active doc alone, meaning `Operations/Orchestrator Rules.md` (where the whole non-rotating doctrine now lives) could be gutted entirely and every marker would still report green.

These two tokens are deliberately chosen to be RULES-FILE-ONLY (0 hits in the active `Orchestrator Log.md`, ≥6 hits each in the rules file), so they are the first tokens this script (and the project's `orchestration.rotationMarkers` config, landed separately) actually depend on `--rules`/`rulesPath` to satisfy — proven by running the script with and without `--rules` against the real vault files (card `4cbb2999`'s own DoD).

Two candidates from the same batch, `ANNOUNCE-CANNOT-CARRY-A-SHA` and `MY-PEER-SEND-LEDGER`, were deliberately NOT used: both name rules this script already retired (`bcd3f690`), so re-adding them as markers would re-protect dead ceremony rather than live doctrine.

## Do not

- Do not treat a green marker check as proof the rules file is load-bearing — check whether at least one marker is genuinely RULES-FILE-ONLY, or the file could be gutted and nothing would notice.
- Do not re-add `ANNOUNCE-CANNOT-CARRY-A-SHA` or `MY-PEER-SEND-LEDGER` as markers — both protect rules already retired by `bcd3f690`.

## Source

Condensed/paraphrased from the inline file-header comment ("ADDED 2026-09-07") in `packages/daemon/scripts/rotation-gate.mjs`, as of base sha `79bf901d` — this record's wording is NOT a verbatim quote of the source comment. Extracted by card `7a4c54f3` (tranche 1 on `packages/daemon/scripts/rotation-gate.mjs`).
