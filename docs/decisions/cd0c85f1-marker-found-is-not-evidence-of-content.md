# cd0c85f1 — a marker "found" is not evidence it protects real content

## Narrative

The marker check is an exact-substring existence grep: a `rotationMarker` is "satisfied" the moment its token appears anywhere in the winning source, once, regardless of where. Sound while the token appears nowhere but the content it protects — but a doc that documents its own marker list (a "here is what is protected" note, a doctrine line warning "keep this so the marker resolves") makes that marker permanently satisfiable by the note itself, whether or not the protected content still exists.

Not hypothetical: a real rotation deleted a marker's protected content while a marker-list line elsewhere in the same file kept it green — `ok:true`, `missingMarkers:[]`, `markerSources` naming the correct home file, every existing field simultaneously correct and uninformative. An independent census on a different doc set found the same shape in most of that seat's configured markers, including one whose own doctrine *instructs* editors to leave the meta-mention in place "so the marker resolves" — prescribed, not accidental.

Three fixes were rejected first:
1. **Bare per-marker hit count.** Measured: a count of 1 occurs in both a healthy state (content only) and a fully vacuous one (meta-mention only); a count of 2 occurs in both an exposed and a legitimately-double-cited-content state. No signal either way.
2. **Convention only.** Unenforceable by the tool, and contradicted by at least one seat's own written doctrine.
3. **Extend the honest-limit note only.** Cheap, fixes nothing.

Shipped instead: per-marker hit LOCATIONS — every line in the winning source containing the token, each with a match-centered excerpt (not head-anchored: this project's own doc has lines to ~780 chars, with a real match past any fixed 200-char head window) and a structural flag, `sharedLineMarkers`, naming any OTHER configured marker sharing that exact line. This catches a genuine marker-list line but **not** a meta-mention naming only the one marker it undermines (two real specimens on this project share no other marker on their line) — no automatic content-vs-meta classifier ships; one built from a line heuristic would be confidently wrong on those specimens. `ok`/`missingMarkers`/`markerSources` are unchanged; the new data is additive.

`markersNeedingReview` (top-level array of tokens) was added on review: the hit data alone would sit as a passive notice nested under an `ok:true` nobody has reason to open — the exact failure ("dutifully ran the check, was told it passed") this card exists to fix. It surfaces every marker with a `multipleHits` or non-empty `sharedLineMarkers` — "inspect these," never a verdict, never folded into `ok`.

## Do not

- Do not read `markerSources`/`ok:true` alone as proof content survived — a marker satisfied by a line merely NAMING it reads identical to real content in every pre-existing field. Read `markerHits[token].hits[].excerpt` and `markersNeedingReview` instead.
- Do not ship a bare per-marker hit COUNT as the fix — measured: 1 occurs in both a healthy and a fully vacuous state; 2 occurs in both an exposed and an unexposed one. Count alone carries no signal.
- Do not build a content-vs-meta classifier from a line heuristic ("N configured markers on one line") and call it sound — proven, on this project's own doc, to miss a single-marker meta line sharing no other marker. `sharedLineMarkers` is a partial signal only.
- Do not head-anchor a hit excerpt — real marker matches on this project's doc sit past a 200-char head window (median line 219 chars). Window around the match; never split a UTF-16 surrogate pair when trimming.
- Do not make `sharedLineMarkers` absent when empty — it's a MEASURED zero, not an omission (mirrors this surface's own `composerDirtyLen`/`recentTimeoutStreak` convention).
- Do not fold `markerHits`/`markersNeedingReview` into `ok` — this module still cannot classify content vs. meta; a computed verdict here repeats the exact unsoundness rejected for the classifier itself.

## Source

`packages/daemon/src/orchestration/rotation-check.ts` (`MarkerHit`/`MarkerHitDetail`/`windowExcerpt`/`findMarkerHits`/`buildMarkerHits`, and `markersNeedingReview` in `checkRotation`), as of the commit introducing this record. Card `cd0c85f1`, filed by the Platform Lead from an external manager's escalation; the count-is-not-a-discriminator amendment and the independent census were produced during the same card's triage.
