# e013b1ca — `markerHits` filters by the SAME excluded range the marker union scan already computed

## Narrative

`6dd3a17c` made the marker UNION SCAN (`checkMarkers`/`checkMarkersUnion`, which determines
`missing`/`markerSources`) read a copy of each rules source with its own `§ROTATION-GATE` section
stripped out. It left `buildMarkerHits` unchanged: it built per-marker hit locations
(`markerHits[token].hits`, the evidence surface `cd0c85f1` added, and the input to
`markersNeedingReview`) from the RAW, unstripped rule-source text. So a marker satisfied via a
`rules`/`rulesFiles` source could show — and `markersNeedingReview` could be inflated by — occurrences
sitting inside the exact section the union scan had just excluded. Confirmed live against this
project's own real vault docs before this fix: `MGR122-FLOOR` alone carried 48 raw hits, most of them
lines inside `Orchestrator Rules.md`'s own `§ROTATION-GATE` discussion prose, not the marker's real home.

## Rejected alternative 1: pass the already-stripped text into `buildMarkerHits`

Corrupts line numbers. `findMarkerHits` pushes a 1-based line index into whatever text it's handed;
stripping REMOVES lines, so a hit below the excluded section would report a line that doesn't match the
real file — worse than an extra hit, given `HONEST_LIMIT_NOTE` tells readers to trust
`markerHits[token].hits[].excerpt`. Proven by this fix's own regression test: under this naive shape,
`hits.length` for a marker satisfied only outside the excluded section still reads correctly, but the
surviving hit's `line` is shifted — a length-only assertion would pass on the naive fix and ship the
bug; only asserting `line` against the real unstripped file catches it.

## Rejected alternative 2: a second "blank, don't remove" strip mode

Blanking the excluded lines (instead of deleting) preserves numbering but needs a SECOND transform mode
of `stripSection` (delete vs. blank) that must agree with the first by construction — two shapes of "how
do I treat lines in this range," each able to independently drift from the other's idea of the boundary.

## Rejected alternative 3: re-scan for the heading independently inside `buildMarkerHits`

Having `buildMarkerHits` call `findHeadingLine`/`findSectionBoundary` a second time on each source text
is exactly the two-lists-that-drift shape `6dd3a17c` exists to stop, relocated one function over.

## Chosen shape: carry the range out of `stripSection` itself

`stripSection`'s return widened from `string` to `{ text: string; excludedRange?: { start: number; end:
number } }` — the exact 1-based `[start,end]` inclusive range it removed (absent when the heading wasn't
found). The delete-based `text` still feeds the union scan exactly as before (byte-identical to
`6dd3a17c`'s behavior). `excludedRange` is carried forward — per single `rules` source, or as a `label ->
range` map for the N-file `rulesFiles` union — into `buildMarkerHits`, which scans each source's RAW
text (`MarkerHit.line` always a true real-file line number) and filters out any hit whose `line` falls
inside that source's own range, before computing `multipleHits`.

This is a tighter guarantee against drift than a shared-but-separately-invoked helper: the stripped text
(for the scan) and the exclusion range (for the hit filter) come out of the exact SAME `stripSection`
call, as two fields of one result — no second boundary-search invocation to disagree with the first.
`activeText` is never in the exclusion map (`stripSection` is never applied to it, mirroring `6dd3a17c`'s
own scope limit), so active-doc hits are always unfiltered.

## Verified against the real vault (2026-09-15, post `6dd3a17c`/`5871b88c`)

Before this fix: `ok:true`, but 10 of 12 markers appeared in `markersNeedingReview`, several because
`markerHits` counted occurrences inside `Orchestrator Rules.md`'s own `§ROTATION-GATE` section
(discussion prose repeatedly re-naming marker tokens as worked examples). After: every rules-satisfied
marker's `hits` excludes those occurrences while every hit's `line` still matches its real unstripped
position. `markersNeedingReview`'s MEMBERSHIP was unchanged for this specific document (every affected
marker still has >=2 genuine hits outside the excluded section, so `multipleHits` still correctly
applies) — the fix corrects the EVIDENCE (which hits, which lines), not necessarily the flag count on
every document; a document whose ONLY multi-hit-ness came from the excluded section would see it drop.

## Do not

- Do not pass `buildMarkerHits` the already-stripped text — corrupts `MarkerHit.line` below the excluded
  section. Rejected alternative 1, above.
- Do not add a second "blank, don't remove" mode to `stripSection` — a second boundary-transform shape
  that must agree with the first by discipline, not construction. Rejected alternative 2, above.
- Do not re-derive the excluded range independently inside `buildMarkerHits` — `6dd3a17c`'s own
  two-lists-drift defect relocated one function over. Rejected alternative 3, above.
- Do not assert only `hits.length` in a regression test for this fix — the rejected naive alternative 1
  also passes a length-only assertion; assert the surviving hit's real, unstripped `line`.
