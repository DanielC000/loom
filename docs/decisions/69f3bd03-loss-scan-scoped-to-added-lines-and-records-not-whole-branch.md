# 69f3bd03 — comment-extraction loss scan scoped to added lines + records, not the whole branch source

## Narrative

WHY THIS EXISTS: docs/extraction-program.md item 4 told a tranche worker to take every distinctive token from a removed comment, "subtract those still present in the branch source", and check the remainder against records. Subtracting the WHOLE branch source masks a real loss: a token that recurs ANYWHERE else in a 17k-line file reads as "present" even when the specific clause carrying it was deleted. Two lanes reported "0 misses" on their own DoD-4 whole-file check while a scoped scan (added lines + the records the added @decision ids resolve to — and ONLY those) found real losses: host.ts tranche 43 (card 1c218980 — a dropped serial-ordering justification, a dropped example, a dropped "fail toward a duplicate" parenthetical, enumerated-case labels) and service.ts tranche 51 (card a6d52081). This script is that scoped instrument, so every worker runs the SAME check instead of hand-rolling a weaker one.

## Source

Inline comment in `packages/daemon/scripts/extraction-loss-scan.mjs` (header, "WHY THIS EXISTS" paragraph, verbatim). Relocated by card `7fb7a5ba`.
