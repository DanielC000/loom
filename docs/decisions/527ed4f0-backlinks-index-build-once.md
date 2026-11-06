# 527ed4f0 — build the backlinks index once per digest composition, not once per note

> **Superseded in code:** the kickoff digest stopped injecting backlinks/mentions, and `buildBacklinksIndex`, `annotateBacklinksPrecomputed`, `buildMentionsIndex` and their equivalence test (`project-memory-backlinks-build-once.mjs`) were deleted as dead. `memory_read` resolves backlinks per note and returns single-note `mentions`; the text below is the history of the removed design.

## Context

Card a140598a built `buildMentionsIndex` so cross-note "mentions" annotation resolved once per digest
composition instead of once per note. Profiling that same card's own cost measurements (recorded in
`docs/decisions/a140598a-reference-extraction-false-match-limiting.md`) found `buildMentionsIndex` was
*not* the dominant cost on main — `annotateNote` → `annotateBacklinks` → `findInboundBacklinks` was:
every note a digest (or write-time status computation) annotates re-fetches the WHOLE project-memory
corpus and re-extracts every note's `[[wikilink]]` keys from scratch (card d305f1a2's pre-existing,
already-accepted O(N²), never amortized the way mentions was).

Measured on a hermetic fixture (760 notes × ~3.6KB, 4700 tasks, 30 pinned), `annotateBacklinks` was
>99% of the packing/status cost in BOTH `retrieveProjectMemoryForKickoff` (229ms of 231ms) and the
ordinary-pinned `memory_write`/`computeRestTierSignal` path (218ms of 219ms) — the single largest line
item in each real end-to-end total (64% of kickoff, 81% of the write).

## Decision

`findInboundBacklinksBulk`/`annotateBacklinksBulk` already existed (card 41c3f546, built for the
`memory_list` REST route) but were never wired into `annotateNote`, which still called the per-note
`annotateBacklinks`. This card wires them in, mirroring `buildMentionsIndex`'s own shape exactly:

- `buildBacklinksIndex(db, projectId, cap)` (project-memory-backlinks.ts) — the one impure entry point
  real DIGEST callers use, fetching the corpus and building the whole-corpus backlinks map EXACTLY ONCE
  per digest composition / write-time status computation.
- `annotateBacklinksPrecomputed(precomputed, targetKey)` — an O(1) lookup into that prebuilt map, mirroring
  `annotateMentionsPrecomputed`'s exact omit-safe shape (undefined ⇒ `[]`, never a live fallback scan).
- `annotateNote` (project-memory-annotations.ts) takes a new optional `backlinksIndex` param, used the
  same way as the existing `mentionsIndex` param, and both real callers (`retrieveProjectMemoryForKickoff`
  in project-memory-recall.ts, and `computeNeverDropStatus`/`computeRestTierSignal` in mcp/memory.ts) build
  one `backlinksIndex` alongside their existing `mentionsIndex` and pass both through.

**Expiry is deliberately untouched.** `buildMentionsIndex` filters its own corpus fetch with
`isProjectMemoryExpired` (card a140598a round 4); `buildBacklinksIndex` does its own SEPARATE, UNFILTERED
`db.listProjectMemory` fetch — not a shared/filtered corpus — so an expired note's backlink-eligibility is
byte-identical to before this card. a140598a's own "Do not (round 4)" explicitly scoped that question to
backlinks' own card, not a140598a's; this card still does not make that call — it only amortizes the
existing, unchanged matching semantics (`matchesFor`) over one fetch instead of one-per-note. This costs
one extra `db.listProjectMemory` call per composition (measured ~5-15ms) versus sharing a single raw fetch
between the two indexes — accepted: negligible against the ~150-250ms fix, and it keeps a140598a's own
already-decision-anchored `buildMentionsIndex` contract untouched.

`annotateBacklinks`/`findInboundBacklinks` (the per-note path) are UNCHANGED and still have a live
production caller: `readProjectMemory` (mcp/memory.ts, the `memory_read` on-demand single-note route),
which deliberately keeps the full `MAX_BACKLINKS` cap per the digest-vs-on-demand distinction card
e4e180ad already drew. Not deleted.

Equivalence is enforced by a dedicated test (`test/project-memory-backlinks-build-once.mjs`): for every
note in a realistic fixture (many notes, wikilinks, some over the backlinks cap, one expired note that
still links to a live one), the old per-note `annotateBacklinks` output and the new
`annotateBacklinksPrecomputed`-via-`buildBacklinksIndex` output must be byte-identical, with a positive
control proving the comparison can fail (a deliberately wrong cap/precomputed value is asserted NOT
equal first).

## Measured before/after (same fixture as the investigate-first checkpoint)

| path | before (main) | after (tip) |
|---|---|---|
| `retrieveProjectMemoryForKickoff` (end-to-end) | ~360ms | see worker_report for the re-measured tip numbers |
| ordinary-pinned `memory_write` / `computeRestTierSignal` (end-to-end) | ~268ms | see worker_report for the re-measured tip numbers |

(Exact tip numbers are reported fresh at merge time rather than hand-copied into this record, since a
hand-copied number here would drift the moment either side is re-measured — see this project's own
`CLAUDE.md` "point at a source of truth, never restate its content" rule. Re-run the investigate-first
checkpoint's fixture script against both shas to reproduce.)

## Do not

- Do not call `buildBacklinksIndex` more than once per digest composition or per write-time status
  computation — that is the exact per-note cost this card measured and fixed.
- Do not build `buildBacklinksIndex`'s corpus from `buildMentionsIndex`'s own expiry-filtered corpus, or
  add an `isProjectMemoryExpired` filter to it — backlinks stay expiry-agnostic; that is a decision for a
  future card on this module, not an accidental side effect of this one.
- Do not delete `annotateBacklinks`/`findInboundBacklinks` (the per-note path) — `readProjectMemory`
  (`memory_read`) still calls it, deliberately, for its own on-demand, full-`MAX_BACKLINKS`-cap read.
- Do not let `annotateBacklinksPrecomputed`'s rendered lines diverge from what `annotateBacklinks` would
  render for the same note and cap — both must stay routed through `matchesFor`/`linesForBacklinkResult`.
