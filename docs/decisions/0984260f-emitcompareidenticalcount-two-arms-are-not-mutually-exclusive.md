# 0984260f — `emitCompareIdenticalCount`'s two arms are NOT mutually exclusive; a MIXED row is real

## Narrative

Card 0984260f corrects the two-arm picture of `GateHistoryRow.emitCompareIdenticalCount`/`emitCompareTestFiles` (see docs/decisions/6ca4b1a0-gate-history-emit-compare-fields-come-from-pending-gate-ops-not-detail-json.md for the two arms themselves): the emit-identity arm and the changed-test-files arm are NOT mutually exclusive. A diff can touch a compiled file AND a changed test file in the same commit, firing BOTH at once — `identicalCount` non-zero paired with a NON-EMPTY `emitCompareTestFiles`, measured live on merge gate op `b145371d`. That row is the MIXED case: the count is fully INFORMATIVE (a compiled file really was proven byte-identical) AND the named test files ran.

The trap this closes: a naive reader could see a non-empty `emitCompareTestFiles` and assume that alone makes any accompanying `identicalCount` vacuous (per the changed-test-files arm's own "0 means nothing to check" rule) — but that rule only applies when `identicalCount` is actually `0`. A non-zero `identicalCount` sitting alongside a non-empty `emitCompareTestFiles` does not make the count vacuous; it is the third, MIXED shape, distinct from either pure arm.

The `[loom:merge-done]` nudge text this mirrors ALWAYS prints the compiled-file count, including when it is zero, so it fully discriminates all three shapes without reading either field: "0 compiled file(s) … + N changed test file(s)" is the vacuous-zero (changed-test-files-alone) arm; ">0 compiled file(s) … + N changed test file(s)" is the MIXED arm — the count is real; ">0 compiled file(s)" with no changed-test-file clause is the emit-identity-alone arm.

## Do not

- Do not infer `emitCompareIdenticalCount` vacuity from `emitCompareTestFiles` being non-empty alone — vacuity requires `identicalCount === 0` specifically; a non-zero count alongside a non-empty test-file list is the real, informative MIXED case.

## Source

Inline comment in `packages/shared/src/types.ts` (`GateHistoryRow.emitCompareIdenticalCount`'s own doc comment). Extracted by card 555f817f (tranche 3 on `packages/shared/src/types.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
