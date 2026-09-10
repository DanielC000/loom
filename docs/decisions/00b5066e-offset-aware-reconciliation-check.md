# 00b5066e — the offset-aware reconciliation check, and why its two directions are bounded differently

## Narrative

Card 00b5066e — THE OFFSET-AWARE RECONCILIATION CHECK. Two live specimens (one Platform Lead session, 100 minutes apart) both fell through every check that precedes it to the generic "possible LOSS" fallback, with byte-identical wording despite being structurally opposite: a STRICT PREFIX missing one trailing char (`divergesAtChar == reportedLen`, `tailReportedLen == 0` — almost certainly an unechoed trailing newline) and a PREFIX INSERTION where every byte of `intended` is present, just offset by a prepended run (`divergesAtChar == 0`, both tails read FULL — the exact never-re-syncs shape card `cf2fef73` already documented for a mid-string benign re-render, relocated to char 0).

An exact byte-wise scan (the position `i`) cannot re-sync after content is inserted or removed at an offset, so BOTH specimens read as alarming as a genuine substitution to a bare divergence-point/tail-size read — that IS the bug this discriminator exists to fix. The check asks whether one string is a PREFIX/SUFFIX-offset copy of the other — NOT the same question `isBenignWhitespaceRerender`/`isStalePlaceholderPrefix`/`isChunkSeamFormFeed` ask (those are PROVEN, specific mechanisms and SUPPRESS the notice entirely). This is a WEAKER, general structural fact ("nothing here shows a byte of `intended` is genuinely missing/replaced") that only changes the notice's WORDING — the notice still fires, since the offset's own origin is not established.

### INSERTION direction (`reported.endsWith(intended)`, `reported` longer)

`reported` is some PREFIX run followed by `intended` unchanged in full — every byte of `intended` is provably present, in order, at the very end. Deliberately `endsWith`, NOT the broader `includes`: an earlier cut of this check used `includes` and false-matched card `68459420`'s own UNCHARACTERIZED "reported longer, unmatched" population (test scenario 13's own shape, `reported = intended + <unexplained SUFFIX>` — `intended` is a PREFIX of `reported`, the mirror-image shape, not a prefix insertion). That population is explicitly required to keep its "possible LOSS" wording verbatim (card `68459420` DoD-3, re-affirmed by this card's own DoD-3: "the LOSS wording is NOT weakened for any other population"). `endsWith` matches ONLY this card's own specimen shape (extra content PREPENDED, `intended` recovered whole at the tail) and correctly excludes the appended-suffix shape. An exact match over the entire (typically hundreds of chars) `intended` string cannot happen by coincidence, so this direction is left UNBOUNDED.

### OMISSION direction (`intended.startsWith(reported)`, `reported` a literal prefix, `reported` shorter)

BOUNDED to `OFFSET_OMISSION_MAX_TAIL_CHARS` (currently 2) — a large omitted tail is a genuine truncation and must keep crying loud unchanged; this direction only ever fires for this card's own tiny-trailing-artifact shape.

The bound is kept small and DELIBERATE: left unbounded, a short `reported` could coincidentally appear as a leading-prefix match of a large `intended` purely by chance, softening the wording for what is actually a genuine large-tail truncation — this card's own explicit hard bound ("a large missing tail is a genuine truncation and must keep crying loud"), citing the `-41638` gen=4 specimen (`divergesAtChar=7`, a 42,075-char missing tail). This card's own live specimen the bound is sized from had a tail of exactly 1 char (a trailing newline, almost certainly not echoed back) — 2 leaves a little headroom without coming anywhere near a size where coincidence becomes plausible. The INSERTION direction carries no equivalent risk (see above) and is deliberately left unbounded.

### Negative control

MEASURED to answer NO for the real gen=4 loss specimen this card's own hard bound cites (`reportedLen=444` vs `intendedLen=42,082`, unrelated content, `divergesAtChar=7`): neither direction matches — `reported` does not end with the whole of `intended` (insertion), and the omission bound alone already excludes a 42,075-char missing tail regardless of content.

## Do not

- Do not widen `endsWith` to `includes` for the INSERTION direction — that false-matches card `68459420`'s own UNCHARACTERIZED "reported longer, unmatched" population, which must keep its "possible LOSS" wording unweakened (card `68459420` DoD-3).
- Do not raise `OFFSET_OMISSION_MAX_TAIL_CHARS` casually — it is sized to this card's own 1-char specimen with a little headroom, not a round number; raising it risks coincidentally prefix-matching a genuine large-tail truncation.
- Neither direction suppresses the `[loom:prompt-mismatch]` notice — both only change its wording. Suppression is reserved for the PROVEN, specific mechanisms (whitespace rerender, stale placeholder prefix, chunk-seam form feed) that precede this check.

## Source

Inline comments in `packages/daemon/src/pty/host.ts`: the `OFFSET_OMISSION_MAX_TAIL_CHARS` constant's own doc comment, and the `isOffsetInsertion`/`isOffsetOmission` computation inside `deliverHook`'s `UserPromptSubmit` case. Relocated by card `6a9dba1a` (tranche 21). No wording changed in the narrative moved here beyond joining wrapped lines and stripping `//`/`*` markers.
