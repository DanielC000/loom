# abd049da — inject only a record's Do-not section + pointer; lint flat-store Do-not coverage

## Narrative

Filed by the Platform Lead on an explicit owner decision (request `e17fd9bf`: "Inject only the Do-not
section + a pointer"). A net-token measurement found the prior whole-record injection cost roughly 60-70x
what the leaner reads it replaced actually saved, at this repo's corpus scale (867 records, 1,583 anchors
at measurement time). The property that stops a wrong edit is the PROHIBITION, not the narrative behind it
— so this card keeps the guard and drops the rest.

**The change** (`decision-records.mjs`): `extractDoNotOnly` returns a record's title (level-1 headings)
plus every 'Do not'-style heading, in order — the same "protected content" card `8449a258` defined — and
the hook injects ONLY that, plus a pointer. `truncateRecord` (which used to split "protected vs. other"
and truncate the "other" half) is DELETED — no "other" half is left once the narrative is never injected;
the `8449a258` anchor moved to `extractDoNotOnly`, where that decision is enforced now. No Do-not section
→ an explicit labelled fallback note (DoD-2: never nothing, never the old narrative either).
`PER_RECORD_MAX_BYTES` (unchanged, 6000) bounds this smaller body; ordinarily nothing truncates. The full
narrative stays one `decisions_for` call away. If the reduced body itself is ever over cap on a record
WITH a Do-not section (measured corpus-wide: unreached today), the elided middle would be cutting a
prohibition, not narrative — the marker says so explicitly rather than reusing the plain wording.

**Re-measurement (DoD-5), MEASURED:** same methodology as the card's prior measurement (150 real
`@decision` sites, direct `node decision-records.mjs <dedupeDir>` invocation, synthetic 50-line `Read`
payload, fresh dedupe dir + session id per sample, never a live claude session), re-run at base sha
`4ada95de68165ef06c5dd639579505b4ebeb55c9` (population now 1,934 anchor sites):

| | before (150 of 1,583 anchors) | after (150 of 1,934 anchors) |
|---|---|---|
| median | 9,956 B (~2,489 tok) | **2,664 B (~666 tok)** |
| mean | not recorded | **3,464.1 B (~866 tok)** |
| range | not recorded | 439 B – 10,627 B |

Median dropped **~73.2%** — real, short of the card's own **~85%** projection (which compared raw
Do-not-vs-whole-record file sizes alone, before the message envelope and shared-budget contention). 73% is
the real number for this corpus at this commit; re-measure rather than trusting either figure later.

Of the 143 sampled reads that produced an injection, 7 (~4.9%) rendered the no-Do-not fallback note rather
than a real section — the fallback path is genuinely exercised, not merely reachable in principle.

**The lint** (`comment-anchor-lint.mjs`): `findRecordsMissingDoNot` (check 15, imports `hasDoNotSection`
from `decision-records.mjs` — one predicate shared by injector and lint) reports every `docs/adr`/
`docs/decisions` record with no Do-not heading at any level. CLI-scan only, same ground as
`oversizedRecords`/`collidingRecords`: records live outside `SOURCE_ROOTS`.

**Scoping: `docs/investigations/**/findings.md` is excluded, not deferred.** Those are narrative reports,
not prohibition-carrying records — measured, all 37 lack a Do-not section, and forcing one in would
fabricate prohibitions that don't exist. The runtime fallback still covers them.

**The accepted flat-store population.** `findRecordsMissingDoNot` reports **33** `docs/adr`/`docs/decisions`
records with no Do-not section at this base sha (not the card's cited "35" — that counted `##`-only
headings on a different snapshot; this uses the shared any-level predicate). Following card `d0d0401b`'s
precedent (declining to retrofit 36 oversized investigation records as "judgment-heavy... no natural
stopping point... zero correctness benefit today"): these 33 are **explicitly accepted as known debt, not
fixed by this card.** The runtime fallback already covers every one (an explicit note, never silence).

Per this repo's "point at a source of truth" convention, the 33 ids are NOT enumerated here (a static list
drifts silently the moment one gains a Do-not section). Authoritative current list: `node
packages/daemon/assets/comment-anchor-lint.mjs .` → `missingDoNotRecords.items`. Spot examples at the time
of this decision: `0db42b7f`, `245a3708`, `661b7d46`, `98c4a651`, `dbad4b59`.

## Do not

- Do not read the 33 accepted records as permanently exempt from ever needing a Do-not section — the lint
  (`missingDoNotRecords`) reports them every run, and a future edit that gives one of them a real
  prohibition to state should add a genuine Do-not heading, not treat this acceptance as a ban on doing so.
- Do not extend `findRecordsMissingDoNot`'s scope to `docs/investigations/**/findings.md` — those are
  narrative reports, measured to universally lack a Do-not section, and forcing one in would fabricate
  prohibitions that don't exist.
- Do not raise `PER_RECORD_MAX_BYTES` or `TOTAL_MAX_BYTES` — unrelated to this card, and the owner's answer
  to request `a0155873` (card `8449a258`) already forbids it.
- Do not read the 73.2%/85% figures above as stable — re-run the sampling methodology described here
  (or `node packages/daemon/assets/comment-anchor-lint.mjs .` for the flat-store no-Do-not count) fresh;
  both numbers will drift as the corpus and the injector change.

## Source

`packages/daemon/assets/decision-records.mjs`: `extractDoNotOnly`, `hasDoNotSection`, and the render loop
in `main()`. `packages/daemon/assets/comment-anchor-lint.mjs`: `findRecordsMissingDoNot`,
`missingDoNotRecords` (check 15). Card `abd049da`, owner request `e17fd9bf`.
