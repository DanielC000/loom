# cf60a32a — The retraction-vs-title merge-review warning's matching primitive

## Narrative

`matchRetractedPremiseTitle` is the retraction-vs-title merge-review warning's matching primitive (card `cf60a32a` — the mechanical half of `0fa32321`; doctrine half merged as `514da7cf`). A card's BODY can be retracted after its TITLE was already written (and already valid Conventional form, so `toConventionalSubject`/`coerced` — card `b88704bb` — is a no-op passthrough and stays blind to this case entirely). Card title = squash-commit subject on this project, so an un-retitled `fix(…)` merging over a retracted premise stamps a fix for a bug that never existed into permanent mainline history.

It returns the matched marker label when the TITLE still starts with the literal `fix(` (lowercase, this project's Conventional Commits type casing) AND the BODY carries one of the markers below as its OWN standalone line — else `null`. PURE (no I/O), so trivially unit-tested; mirrors `matchAddedDenyGlobs`'s shape.

This was originally a bare `\bretracted\b` substring match over the whole body; two live false positives (card `e7bcb0df`'s "the retracted count-floor idea", a discarded design option, and card `66d91a11`'s "...and retracted before I'd checked", a person retracting a belief) proved that "retraction" is an open vocabulary no keyword list converges on. `lineAnchoredMarker(phrase)` converts it to a closed one: the phrase must stand ALONE on its own line — optionally under markdown heading/bullet/blockquote/bold decoration (`#`, `*`, `_`, `>`, `-`, whitespace, a trailing `:`) — with nothing else on that line, so a real sentence can never satisfy it no matter where it falls. `won't-do`/`not a bug` stay on this shape unchanged. The "retracted" family is further widened by `lineStartMarker` — see [[299a33ae-linestartmarker-widens-retracted-to-not-whole-line-only]] for that widening and its measurement. Kept narrow on purpose (narrowed against card `637558ca`): a heuristic here is only acceptable because it keys on a deliberate declaration a human chose to write, never on inferred intent.

## Markers, and the declined lever

```
retracted            → lineStartMarker("retracted", "-premise\\b")
premise retracted    → lineStartMarker("premise\\s+(?:partly\\s+|fully\\s+)?retracted")
won't-do             → lineAnchoredMarker("won'?t-do")
not a bug             → lineAnchoredMarker("not a bug")
```

DECLINED LEVER (same corpus read as `299a33ae`): the bare noun "RETRACTION" (vs. the participle "retracted") is deliberately NOT added as its own marker. In this exact corpus, "RETRACTION" at a true line start is used AT LEAST as often as a title-check CHECKLIST LABEL whose verdict is the OPPOSITE of a retraction — "RETRACTION checked and did NOT fire", "RETRACTION ✅ — premise held" — as it is for a genuine declaration ("RETRACTION — A 'CARD DEFECT' I ACCEPTED THAT WAS NEVER REAL"). Widening to it would trade the mid-sentence false-positive class this predicate was built to avoid for an equally real line-start one — so it stays out.

## Known blind spot: card-only, never a session transcript (card `a29ee2a6`)

Measured 2026-08-29 against the live `loom.db`, read-only, positive-controlled against the origin incident `c7bf65aa`: this reads the card's CURRENT title+body only — a retraction stated solely in a session transcript, never written into the card, is invisible here. The one confirmed real specimen of that exact shape (`c7bf65aa` itself) never actually merged, so it caused no harm. Of 314 tasks (all projects) whose title or body mentions "retract", 87 had a title starting `fix(`; of THOSE, only 9 (~10%) matched the then-current regex and 78 (~90%) did not — transcript-only silence is the RARE case, not the common one. Widening the input surface to read transcripts is NOT supported by that measurement.

## Do not

- Do not revert to a bare `\bretracted\b` substring match over the whole body — that reproduces the two confirmed false positives (`e7bcb0df`, `66d91a11`) this line-anchoring was built to exclude.
- Do not add a bare "RETRACTION" noun marker — measured in this corpus to fire at least as often on a checklist label whose verdict is the OPPOSITE of a retraction as on a genuine declaration.
- Do not widen the input surface to read session transcripts without new measurement — the one measured blind-spot specimen never actually merged, and transcript-only silence is the rare case.

## Consequences

An un-retitled `fix(…)` card whose body carries a deliberate, standalone retraction declaration is now flagged at merge review — closing most of the gap where a retracted premise's fix subject would otherwise stamp permanent, misleading mainline history.

## Source

Inline comments in `packages/daemon/src/git/worktrees.ts`: `lineAnchoredMarker`'s own doc comment, `RETRACTION_MARKER_RES`'s own doc comment, and `matchRetractedPremiseTitle`'s own doc comment, as of this worktree's HEAD before this extraction. Wrapped source lines joined into a flowing paragraph, `*` comment markers stripped, no wording changed.
