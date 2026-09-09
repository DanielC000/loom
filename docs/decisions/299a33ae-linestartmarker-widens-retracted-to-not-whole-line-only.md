# 299a33ae — `lineStartMarker` widens the "retracted" family off whole-line-only, measured 9%→19%

## Narrative

`lineStartMarker(phrase, excludeAfter?)` is a widened sibling of `lineAnchoredMarker` (see [[cf60a32a-retraction-vs-title-merge-review-warning]] for that primitive and its own markers), for the "retracted" family only. Still anchored at the true START of a line — preceded by nothing but decoration, never ordinary prose — which excludes the two live false positives card `637558ca` narrowed against (both bury the word mid-sentence: "...categorically different from the retracted count-floor idea..." and "...and retracted before I'd checked."). But unlike `lineAnchoredMarker`, it no longer requires the phrase to BE the whole line: reading the corpus's unmatched retraction bodies found most real declarations continue on the SAME line with an explanation — "RETRACTED 2026-06-26 — DUPLICATE.", "RETRACTED: this card previously called...", "RETRACTED — the card's WARRANT, not its numbers" — which the old whole-line-only shape rejected right alongside the false positives it was built to reject.

Its decoration set, `LEADING_DECORATION`, is the ASCII markdown/list/quote/emphasis set widened to any run of non-alphanumeric symbols — a corpus read of the unmatched population found real "emoji-prefixed heading" retractions (`❌ RETRACTED BY THE MANAGER:`, `🔴🔴 RETRACTION —`) the old fixed ASCII class rejected.

`excludeAfter` is a NEGATIVE-lookahead guard for a glued continuation that isn't a declaration at all — found while measuring this widening against card `637558ca` (which discusses this predicate): it quotes this file's own warning template verbatim, `` `RETRACTED-PREMISE: this card's body carries…` ``, and an unconstrained trailing matched it as a false positive. The glue is the tell — every genuine declaration separates a qualifier from "retracted" with a SPACE ("PREMISE RETRACTED"), never a bare hyphen immediately after. `retracted` uses `lineStartMarker("retracted", "-premise\\b")` for exactly this reason.

## The measurement

Measured 2026-09-02 against the live `loom.db`, read-only: the population had grown to 377 tasks mentioning "retract" / 110 `fix(`-titled among them (a later snapshot than card `a29ee2a6`'s own count, not a re-run of it). Reading all ~100 bodies the regex still missed found the gap was PHRASING, not surface — free-form prose (left alone: widening to catch it would reopen the mid-sentence false-positive class `637558ca` narrowed this predicate to avoid), decorated/emoji-prefixed headings, and a same-line trailing explanation the old whole-line-only shape rejected. This widening covers exactly those two axes for the "retracted"/"premise retracted" markers, leaving `won't-do`/`not a bug` untouched (no unmatched specimens found for either) and deliberately declining to add a bare "RETRACTION" noun marker — see [[cf60a32a-retraction-vs-title-merge-review-warning]] for why that lever is a net-negative in this corpus.

Match rate rose from 10/110 (~9%, old regex) to 21/110 (~19%, new regex), both counts against the identical set of 110 rows. All 11 newly-matched rows were read individually and confirmed genuine standalone declarations, not quoting artifacts. The remaining ~81% miss is overwhelmingly free-form prose with no standalone declaration line at all — by design still unmatched.

## Do not

- Do not widen `lineStartMarker` to match mid-sentence mentions — the exact false-positive class card `637558ca` narrowed this predicate to avoid.
- Do not drop the `-premise\b` exclusion on the `retracted` marker — without it, this predicate's own warning template text is a confirmed false positive.
- Do not widen `won't-do`/`not a bug` the same way without a corpus specimen first — none were found for either.

## Consequences

Match rate on the measured corpus roughly doubled (9% → 19%), with the remainder being free-form prose retractions deliberately left unmatched.

## Source

Inline comments in `packages/daemon/src/git/worktrees.ts`: `lineStartMarker`'s own doc comment and `matchRetractedPremiseTitle`'s measurement paragraphs (~lines 2078-2100 of this worktree's HEAD before this extraction). Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
