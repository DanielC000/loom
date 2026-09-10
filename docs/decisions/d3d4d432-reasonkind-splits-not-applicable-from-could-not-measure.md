# d3d4d432 — `reasonKind` discriminates WHY `available` is false, classified at the source

## Narrative

`reasonKind` discriminates why `available` is false, classified at THE SOURCE (each `unavailable()` call site in `deploy-staleness.ts`), never by string-matching the human-readable `reason` prose downstream — that would be the same defect class this card exists to fix. `"not-applicable"` means the signal is NEVER meaningful here (e.g. no `.git` — a packaged install) and staying silent is correct forever. `"could-not-measure"` means the instrument was reachable in principle but a step failed (a race, a git error, a timeout) — this is NOT the same as "verified current", and a consumer that collapses the two produces a false all-clear.

This replaced an earlier, uniform policy (see `c6e7ebe7`'s record) where `composeManagerStartupPrompt` treated every `available:false` reason as silent alike. `reasonKind` still does not single out a timeout beyond the two-class split — a timeout classifies as `"could-not-measure"`, the same as any other reachable-but-failed cause. Anyone who wants the raw, uncollapsed reason can already read it — `served_status` returns `available`/`reason`/`reasonKind` uncollapsed.

## Do not

- Do not classify `reasonKind` downstream by string-matching the `reason` message — classify it at the `unavailable()` call site that actually knows why, or the same defect this card fixed comes back.
- Do not collapse `"not-applicable"` and `"could-not-measure"` back into one silent case — a consumer that does produces a false all-clear for a signal that was merely unreachable, not verified current.

## Source

Inline doc comment (the `DeployUnavailableReasonKind` type's own doc) in `packages/daemon/src/deploy-staleness.ts`, as of commit `8c64cf77`. Relocated by card `f63b17e5` ("deploy-staleness.ts, tranche 1"); no wording changed, `*`-prefixed lines joined into flowing paragraphs.
