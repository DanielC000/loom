# a140598a — reference extraction: false-match limiting for bare card ids

## Context

`project-memory-references.ts` auto-extracts card ids, `@decision` anchors, and path tokens from memory
note text to build a reverse "which notes mention X" index (surfaced like the manual `[[wikilink]]`
backlink mechanism, but on a different signal). A bare 8-hex token is ambiguous by construction — it is
shaped exactly like a git commit sha, or any other incidental hex run, not just a card id.

## Decision

A bare 8-hex candidate only counts as a "card mention" once it resolves, via the same `resolveIdPrefix`
every other `*_get`/`resolveProjectTaskId`-style id-prefix lookup in this codebase already uses, to
EXACTLY ONE real task on the project whose memory note contains it. An ambiguous prefix (matches more
than one task) is treated as unresolved, never silently guessed — the same discipline
`ProjectMemoryEntry.requestIds`'s own doc comment already names as the fix for a prior, real id-prefix
bug (3a3f587): "an id here is only ever what the writer explicitly passed," never regex-sniffed and
guessed.

A structured `@decision <id>` / `@decision sha:<8hex>` citation is deliberately NOT put through this same
resolve-to-a-real-task filter. That syntax is already a deliberate, structured marker (the project's own
comment-taxonomy grammar — see `CLAUDE.md`'s "Comment taxonomy" section) and is far less prone to an
incidental false positive than a bare hex run; verifying a `sha:` id against real git history would also
need a repo/git call this module has no business making on a kickoff-time hot path.

A path token is likewise never verified against the real filesystem — the same posture
`extractPathTokens`'s own `triggerGlob` consumer already takes (card aeec1880): a free-text heuristic,
not a path-existence check.

## Do not

- Do not drop the resolve-to-a-real-task filter for bare card ids — without it, a random commit sha or
  other incidental hex blob would silently populate the "card mentions" reverse index.
- Do not resolve an ambiguous id-prefix to "the first match" or any other guess — treat it as unresolved,
  matching the `3a3f587` precedent `requestIds`'s own doc comment already documents.
- Do not add the same resolve-to-a-real-task filter to `@decision` anchors or path tokens — that citation
  syntax is already structured enough, and verifying a path/sha would need filesystem/git access this
  module should not be making on the kickoff hot path.

## Round 2 — kickoff-path performance and path-token false positives

A manager review (merge blocker) found that `annotateNote` → `annotateMentions` →
`findConnectedMentions` fetched the WHOLE project memory corpus and task list, and re-extracted every
note's references from scratch, on EVERY note annotated in a digest composition (every pinned note plus
every related match) — and did the same again for the never-drop floor-tier / REST-tier byte estimates
at `memory_write` time. On top of that, resolving a single bare-hex candidate against the task list used
`resolveIdPrefix`, an O(tasks) linear scan, called once per candidate.

MEASURED on a hermetic fixture sized like this project (760 notes of realistic length, 4700 tasks, 30
pinned, 5 `retrieveProjectMemoryForKickoff` calls averaged after a warmup call): **~11,750ms per kickoff
before this round's fix, ~776ms after** — roughly a 15x reduction, and critically moves kickoff
composition from several SECONDS of synchronous daemon-thread blocking to under a second.

### The fix

- `buildCardIdPrefixCounts(tasks)` builds an O(tasks) `prefix(8) -> count` map ONCE; resolving a
  candidate against it is an O(1) `Map.get`, replacing the O(tasks) `resolveIdPrefix` scan per candidate.
- `findConnectedMentionsBulk` (already existed) now uses that prebuilt map internally instead of
  re-deriving resolution per note.
- `buildMentionsIndex(db, projectId)` is the ONE impure entry point real callers use: fetches the corpus
  + task list exactly ONCE per digest composition (or per write-time status computation), then hands the
  resulting `Map<noteKey, {matches, totalFound}>` down to every `annotateNote` call via
  `annotateMentionsPrecomputed` — an O(1) lookup per note, never a fresh scan.
- `extractPathTokens` moved out of `project-memory-recall.ts` into a new `project-memory-path-tokens.ts`
  so `project-memory-recall.ts` can import `buildMentionsIndex` from `project-memory-references.ts`
  (to build the index once at the top of `retrieveProjectMemoryForKickoff`) without the two modules
  importing each other in a cycle.
- `extractPathTokens`'s own matches are filtered, ONLY at this module's call site (via
  `isPlausiblePathToken`), to tokens containing a letter AND either a dot-extension suffix or a
  real-looking (2+ char, letter-bearing) segment — rejecting a bare numeric ratio like "3/3" in prose
  (e.g. "proven 3/3"), which otherwise matched as a syntactically valid 2-segment "path" and could link
  two unrelated notes that merely share a test-result ratio. `extractPathTokens` itself, and its
  pre-existing `triggerGlob` caller, are unchanged.

## Do not (round 2)

- Do not call `buildMentionsIndex` / `findConnectedMentionsBulk` more than once per digest composition or
  per write-time status computation — that per-note re-fetch of the whole corpus + task list is the
  exact ~15x cost blowup this round measured and fixed.
- Do not resolve a card-id candidate via a fresh linear scan (`resolveIdPrefix` or equivalent) once
  `buildCardIdPrefixCounts` is available — always build the prefix-count map once and look candidates up
  in O(1).
- Do not change `extractPathTokens` itself to fix the "3/3" false positive — filter at the mentions
  feature's own call site (`isPlausiblePathToken`) so the pre-existing `triggerGlob` caller's behavior
  stays byte-identical.

## Round 3 — cost vs. main (not vs. round 2's own first draft), and the narrowest reduction

Round 2 measured round 2's OWN code against round 1's (both already carrying this feature). The real
question is the cost THIS FEATURE adds over a build with it ENTIRELY ABSENT — i.e. against `main`
(measured at a fixed pre-feature sha, 43aa61b0). Re-measured on the SAME hermetic fixture (760 notes ×
~3.6KB, 4700 tasks, 30 pinned), paired runs of the identical script against each code state:

- **Kickoff** (`retrieveProjectMemoryForKickoff`, 8 calls averaged after a warmup call): main
  495.15ms vs. this feature (round 2 code) 631.38ms — **delta ≈ 136ms**, over the ~100ms bar.
- **`memory_write`** (5 calls averaged, each against a note already in the corpus so size stays fixed):
  a never-drop write: main 10.51ms vs. round-2 163.91ms (**delta ≈ 153ms**); an ordinary-pinned write:
  main 255.81ms vs round-2 491.52ms (**delta ≈ 236ms**); an unpinned write: main 1.79ms vs round-2 4.03ms
  (delta ≈ negligible — neither status function reaches `buildMentionsIndex` for an unpinned write, see
  below).
- **Confirmed via direct instrumentation (not inferred from reading the code): `buildMentionsIndex` is
  called AT MOST ONCE per write, never twice.** `computeNeverDropStatus` and `computeRestTierSignal`
  share one mutually-exclusive gate (`entry.tags.includes(NEVER_DROP_TAG)` XOR), so at most one of them
  ever proceeds past its own early return for a given note; a genuinely UNPINNED write hits neither gate
  at all and never builds the index.

### Breakdown of the round-2 ~631ms kickoff call (isolated, same fixture)

| step | avg ms |
|---|---|
| `db.listProjectMemory` (760 notes) | ~15 |
| `db.listTasks` (4700 tasks, OLD — full rows) | ~64–83 |
| `buildCardIdPrefixCounts` (4700 tasks → prefix map) | ~1.5 |
| corpus regex extraction + reference index + per-note lookup (760 notes) | ~76–88 |
| **`buildMentionsIndex` total** (the above, minus the existing-digest machinery) | **~170** |
| existing digest machinery (FTS search, backlinks, packing — i.e. main's own ~495–631ms baseline... see below) | the remainder |

`db.listTasks` was the single biggest line item — it reads every column through `toTask` (JSON-parsing
`deferredItems`, mapping a dozen fields) and pays a separate `loadDeferralIds` join, none of which this
module needs; it only ever reads `id.slice(0,8)`.

### The reduction — narrow the task read

Added `Db.listTaskIds(projectId): string[]` (`SELECT id FROM tasks WHERE project_id = ?`, no `toTask`,
no deferral join). `buildMentionsIndex` now calls it instead of `db.listTasks`. MEASURED in isolation
(4700 tasks): `db.listTasks` ~83ms vs. `db.listTaskIds` ~6.66ms — **~12.5x faster**, cutting the single
biggest line item in `buildMentionsIndex`'s own cost from ~170ms to ~91ms.

**Re-measured after this fix, same fixture, same paired-script methodology:**
- **Kickoff**: main 495.15ms vs. this feature (round 3) 528.91ms — **delta ≈ 34ms**. Comfortably under
  the ~100ms bar.
- **`memory_write`**: never-drop write: main ~10ms vs round-3 ~70–82ms (**delta ≈ 60–72ms**, under the
  bar); ordinary-pinned write: main ~256–305ms vs round-3 ~364–383ms (**delta ≈ 78–128ms across repeated
  pairs** — see "why it can't cleanly go lower" below); unpinned write: unchanged, negligible.

### Why the ordinary-pinned-write delta doesn't cleanly settle under 100ms, and why that's not this
### feature's cost to chase further

Re-running the SAME paired main-vs-tip write-timing script multiple times showed the delta swing between
~78ms and ~128ms across repeats — but `buildMentionsIndex` itself, measured directly and in isolation on
this fixture, costs a STABLE ~91ms regardless of which write path triggers it (never-drop or
ordinary-pinned — it's the identical call either way). The swing is coming from `main`'s OWN baseline for
an ordinary-pinned write, which varied by up to ~50ms across repeats with NO code change at all: that
write path calls `annotateBacklinks` once per REST-tier pinned note (≈31 notes in this fixture), and
`annotateBacklinks` does its OWN full `db.listProjectMemory` corpus scan PER CALL — a pre-existing,
already-accepted O(N²) cost (card d305f1a2), unrelated to this card, and volatile on its own. Chasing the
noisy TOTAL delta down would mean optimizing backlinks' pre-existing per-note corpus scan, which is out
of this card's scope (and this card's own kickoff doctrine: "stay in recall/backlink code," not "rewrite
backlinks' algorithmic cost"). The number this card IS responsible for — `buildMentionsIndex`'s own
isolated cost — is ~91ms, under the bar, and stable.

### Options considered and not taken

- **Skip `listTaskIds` when the corpus has no bare-hex candidate at all:** would require a separate
  candidate-detection pass over the corpus BEFORE deciding whether to fetch tasks, duplicating the
  extraction work it's trying to avoid, and buys nothing for a corpus that (like this project's real
  one) actually cites card ids — the common case this feature exists for. Not implemented; revisit only
  if a project's real corpus is shown to have zero card-id candidates in practice.
- **Restrict extraction to only the notes the digest renders:** the index's correctness depends on
  scanning the WHOLE corpus for "does any OTHER note mention this" — restricting extraction to
  rendered notes would still require scanning every OTHER note to answer that question, so it doesn't
  reduce the dominant cost (the full-corpus regex pass) at all.

## Do not (round 3)

- Do not call `db.listTasks` from `buildMentionsIndex` (or any future card-id-resolution call site) —
  use `db.listTaskIds`, which this round measured at ~12.5x faster for the one thing this module reads.
- Do not chase the ordinary-pinned-write TOTAL delta below its current noisy ~78–128ms band by optimizing
  this card's own code further — the volatility is `annotateBacklinks`' pre-existing per-note corpus
  scan (card d305f1a2), not `buildMentionsIndex`, which measures a stable ~91ms on its own.

## Round 4 — card 57a91801 (expiresAt) landed on main; reconciled by merge, not rebase

Card 57a91801 added an optional `expiresAt` that retires a note from every kickoff-rendering tier
(`composeProjectMemoryDigest` filters both `pinned`/`related`; `computeFloorTierStatus`/
`computeRestTierStatus` each filter to `live` before using `isNeverDrop`/REST membership) while leaving
it fully readable via `memory_read`/`memory_list` and still a valid `findNearDuplicateProjectMemory`
candidate (that corpus is deliberately NOT filtered — an expired note is still a legitimate
near-duplicate target). It did not touch `project-memory-backlinks.ts` at all, so backlinks' own
inbound-link index is unaffected by this round and stays out of scope here.

**Decision: an expired note counts as NEITHER a mentioner NOR a mentioned note** — `buildMentionsIndex`
now filters its corpus with the same `isProjectMemoryExpired` predicate card 57a91801 introduced, before
building the reverse index at all. Consistent with 57a91801's own choice to exclude an expired note from
every kickoff-rendering tier: the mentions annotation is injected INTO a kickoff digest, exactly the same
category of artifact `composeProjectMemoryDigest`/`computeFloorTierStatus`/`computeRestTierStatus`
already filter for — not the near-duplicate detector's category (which deliberately keeps expired notes
as it looks backward at history, not forward at what will render).

Concretely: if note A is expired and note B is live, and both mention card X, B is reported as NOT
connected to anything via card X — an expired note's reference must not silently inflate a live note's
connection count with something that no longer shows up anywhere in a kickoff. A's own key never gets an
entry in the mentions map at all (it's excluded from the corpus before the index is built), so a lookup
on it safely returns `[]` via the existing "no entry" branch, no special-casing needed.

Merged via `git merge main` (a normal merge commit, both sides kept) rather than a rebase, per
instruction — one real conflict (two adjacent new import lines in `mcp/memory.ts`), resolved by keeping
both.

## Do not (round 4)

- Do not treat an expired note as eligible to connect two other notes, or to be connected to by one —
  filter the mentions corpus with `isProjectMemoryExpired` before building the reverse index, the same
  predicate (and the same exclusion posture) card 57a91801 already applies to every other kickoff tier.
- Do not extend this exclusion to `project-memory-backlinks.ts` as part of this card — 57a91801 did not
  touch it, and whether an expired note should count as an inbound wikilink-backlinker is a decision for
  that module's own card, not this one.
