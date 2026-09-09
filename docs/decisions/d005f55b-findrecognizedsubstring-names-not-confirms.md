# d005f55b — `findRecognizedSubstring` names a recognized write, it does not confirm anything

## Narrative

Card d005f55b DoD-3 (the card's own floor item — mergeable even if DoD-1/2 above are deferred). Tried ONLY once every exact-match candidate above (`replayedEntry`, `detectComposerAccumulation`, `detectComposerAccumulationOverDivergedPrior`) has already refused. Tests whether `reported` nonetheless CONTAINS a recorded write as a SUBSTRING ANYWHERE (rather than equalling it, or being one exact term of an exact-sum span) — this is deliberately NOT a confirmation of anything and asserts no new mechanism or confidence: it only names what WAS recognized so a caller can say the LEADING/TRAILING remainder around it is unaccounted-for, instead of the prior "could not be matched to any... at all" wording that reads identically whether zero bytes or nearly the whole payload are actually explained (§THE GAP, card d005f55b — this is what stops an observed foreign-content fusion from reading as noise).

DELIBERATELY NOT edge-anchored (an earlier draft of this function only tried `startsWith`/`endsWith` and would have MISSED the card's own motivating gen=4 specimen: `<26ch placeholder><gen3's full text><gen4's own text>` — gen3's own write sits SANDWICHED in the MIDDLE, between the placeholder prefix and the current generation's own trailing text, not at either edge). Uses `indexOf` (a true substring search) and reports BOTH remainders — whatever precedes and follows the match — since either or both can be non-empty depending on where the recognized write sits.

`window` must be the CALLER's own writes EXCLUDING the current generation's own just-pushed entry (pass `recentWrittenTurns.slice(0, -1)`, mirroring `priorEntry`'s own `length - 2` exclusion elsewhere in this file) — the current generation's own text is, by construction, almost always a literal trailing substring of `reported` in a fusion-shaped mismatch (`recentWrittenTurns.push` happens at submit() time, before this hook ever fires), so including it here would trivially "recognize" the caller's own current turn on nearly every unmatched-longer mismatch and never surface a genuinely PRIOR generation's write — the whole point of this check.

Checked most-recent-generation-first (mirrors this file's own `findLast` precedent elsewhere) so a match against the freshest prior write wins over an older, possibly-recycled one; only the FIRST hit is returned — this is a diagnostic aid, not an exhaustive census, and callers must not treat "no hit" as anything beyond that.

## Do not

- Do not pass the current generation's own just-pushed entry inside `window` — it would trivially "recognize" the caller's own current turn on nearly every mismatch and never surface a genuinely prior generation's write.
- Do not treat a "no hit" result as evidence of anything beyond "no hit" — this is a diagnostic aid, not an exhaustive census.
- Do not read this function's output as a confirmation — it only NAMES what was recognized so a caller can scope the unaccounted-for remainder; it asserts no new mechanism or confidence.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`findRecognizedSubstring`'s function doc). Relocated by card a4818d7a (tranche 1 on `pty/host.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
