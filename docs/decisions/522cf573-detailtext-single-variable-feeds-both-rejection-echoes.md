# 522cf573 — one `detailText` variable feeds both the rich rejection notify and the generic fallback echo

## Narrative

At a gate-rejection return site in `confirmWorkerMerge`, `detailText` is built as the FULL rich rejection
detail: the headline plus `detailBits` (including `failingTest`, the single highest-value field per card
`522cf573`), the squash-phase-began state, the canonical-repo clause, the steps line, and the raw output
tail. It is captured into ONE local variable so that BOTH the rich `[loom:merge-rejected]` notify sent
right below it AND the generic `[loom:merge-failed]` completion echo — fired instead whenever this notify
is reconciled away by `shouldSuppressMergeReject`, with `confirmWorkerMergeTracked`'s `onSettle` callback
reading `detailText` off the return — carry the IDENTICAL detail, by construction. There is no way for the
two to drift apart, because neither is a separate re-derivation; both read the same variable.

At this specific rejection site, "squash phase never reached" is always true in the composed detail: the
gate runs strictly before the squash, so a gate rejection can never have reached the squash phase.

`confirmWorkerMergeTracked`'s generic fallback echo falls back to the bare `reason` string only for a
return site that predates `detailText` — none currently exist; this is a belt-and-suspenders honest
degrade, not an expected path, kept so the echo is never the empty "build gate failed" text the card's
originating incidents were about.

The echo's own site names `detailText`'s full composition explicitly: `detailBits`'s own fields
(`headline`/`step`/`phase`/`failingTest`/`exitCode`/`signal`/`timedOut`/`stderrTail`), the
squash-phase-began state, and the canonical-repo-state clause — the same enumeration as the rich notify's
own construction, so a reader of either surface sees the identical field manifest.

## Do not

- Do not build a second, separately-derived string for the generic `[loom:merge-failed]` fallback echo —
  it must read `detailText` off the same return value the rich notify was built from, or the two can drift
  apart on future edits.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts`, `confirmWorkerMerge`'s gate-rejection return
(~line 13290), as of this tranche's HEAD. Condensed and reworded, not verbatim.
