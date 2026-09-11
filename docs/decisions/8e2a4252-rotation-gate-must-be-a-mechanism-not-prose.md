# 8e2a4252 — the resume-doc rotation gate must be a MECHANISM, not prose someone has to remember to run

## Narrative

`packages/daemon/scripts/rotation-gate.mjs` exists because the gate it now runs was previously only PROSE — documented in `Operations/Orchestrator Rules.md`'s own §ROTATION-GATE section — and was proven live only by having caught two real mistakes when a human/agent happened to remember to apply it by hand. A passive notice, however prominent, is not someone running it (see project memory `shipping-a-detector-is-not-someone-reading-it`). This script turns the same check into a MECHANISM instead: a rotation either passes it structurally or is refused, with no step where a successor has to choose to re-read the procedure and reimplement it from memory.

## Do not

- Do not fold this gate back into pure prose/documentation-only form — a passive notice in `Orchestrator Rules.md` was already tried and only caught mistakes when someone happened to remember to run the check by hand.
- Do not read "the doc still mentions the rule" as proof it's protected — before this script, the only enforcement was a human choosing to re-apply the procedure from memory each time.

## Source

Condensed/paraphrased from the inline file-header comment ("WHY THIS EXISTS") in `packages/daemon/scripts/rotation-gate.mjs`, as of base sha `79bf901d` — this record's wording is NOT a verbatim quote of the source comment. Extracted by card `7a4c54f3` (tranche 1 on `packages/daemon/scripts/rotation-gate.mjs`). The neighboring "WHAT IT GATES" paragraph is Class C contract and stays inline, unmoved.
