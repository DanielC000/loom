# d0d0401b — deferral scoped to the 36 UNREACHABLE oversized records, not the whole 41

## Narrative

Card `d0d0401b` moved the `PER_RECORD_MAX_BYTES` constraint from silent enforcement at read time
(`decision-records.mjs` truncating an oversized record on injection, head+tail, with an explicit marker)
to visible enforcement at authoring time: `comment-anchor-lint.mjs`'s whole-repo CLI scan reports an
`oversizedRecords` check, reading the cap from `decision-records.mjs`'s own exported `PER_RECORD_MAX_BYTES`
constant (imported, not a second hand-copied number).

A fresh census (`node packages/daemon/assets/comment-anchor-lint.mjs .`, this worktree HEAD
`1974444dc94618d380f474192e22edff20215ec5`, 2026-09-09T19:47:32Z) found **41 of 205** records over the
6000-byte cap. **The 41 are not one uniform risk.** `decision-records.mjs` only ever injects (and therefore
only ever truncates) a record whose id has a real `@decision <id>` anchor somewhere in the repo — no
anchor, no `Read` ever resolves it, so it can never be truncated in practice, regardless of size.
Splitting the 41 by that criterion:

| | count | stores |
|---|---|---|
| **ANCHORED** (can inject today) | **5** | 1 `docs/adr`, 4 `docs/decisions` |
| **ORPHAN** (no anchor anywhere — cannot inject today) | **36** | all `docs/investigations` |

**Method, and how it was independently checked (not just taken on report):** "anchored" here means the
record's id is NOT in `comment-anchor-lint.mjs`'s own `orphanRecords` — i.e. at least one `@decision <id>`
anchor for it exists somewhere across the swept source (`SOURCE_ROOTS`: `packages/{daemon,web,shared}` src
+ `packages/daemon/{assets,scripts}`). That sweep excludes `test/`/`tests/`/`e2e/` by design (synthetic
fixture ids) and only walks `.ts`/`.tsx`/`.mjs` files, so it does NOT by itself prove an id has no anchor
ANYWHERE in the repo — only that it has none in the scanned subset. Closed that gap directly: a whole-repo
`git grep -niE "@decision[[:space:]]+(<id>|<id>|...)"` (all 36 orphan-investigation ids in one pattern, no
path/extension restriction — every git-tracked file) against the SAME repo state, with a positive control
proving the pattern discriminates (a known-anchored id, `184fd82e`, was found at its two real anchor
sites first) — returned **zero hits** for all 36 ids. So the 36/5 split holds under the wider check, not
just the lint's own narrower one.

The 5 anchored, over-cap records (largest first):

- 9117 bytes — `docs/decisions/d88163b7-hold-drain-surface-and-bounded-busy-wait.md`
- 9056 bytes — `docs/adr/184fd82e-defer-serializing-fresh-codex-spawns-per-cwd.md`
- 6476 bytes — `docs/decisions/e1ac691b-worker-merge-confirm-surfaces-every-mismatch-candidate-chronologically.md`
- 6269 bytes — `docs/decisions/be260976-batch-verdict-derivation-closes-the-never-existed-gap.md`
- 6176 bytes — `docs/decisions/ccb407eb-give-up-remint-limit-pinned-at-1-measured-cost.md`

**Decision: this card defers ONLY the 36 orphan `docs/investigations` records — not the whole 41.** They
are not split or trimmed here because nothing anchors them today, so none of the 41 records that can
actually truncate on injection is left unaddressed by this deferral; splitting 36 long investigation
reports (several 3-6x over cap) inside this card would be a large, judgment-heavy editorial undertaking
with no natural stopping point on a corpus still growing under concurrently-landing lanes, for zero
correctness benefit today. The 5 ANCHORED records are a real, tractable follow-up, small enough to be its
own card rather than resolved here — left OPEN, not resolved by this decision.

## Do not

- Do not read "36 orphan records are unreachable" as "36 orphan records are PERMANENTLY safe." The moment
  anyone writes an `@decision <id>` anchor pointing at one of those 36 — a wholly ordinary, expected future
  action, since that is exactly what the decision-records convention asks authors to do — it becomes
  injectable and, at its current size, truncates on the very next matching `Read`. The 41-vs-5 split
  describes today's reachability, not a permanent property of any given record.
- Do NOT "clean up" `comment-anchor-lint.mjs`'s `oversizedRecords` check to exempt orphan/investigation
  records from the report on the strength of this decision. The lint deliberately keeps reporting all 41,
  not just the 5 currently-reachable ones — an author who anchors a 36th record later needs the lint to
  already be watching it, not to have been taught to ignore investigations as a category. Reporting all 41
  is correct as shipped; this decision explains why the AUTHOR'S remediation was scoped to 5, not why the
  LINT'S scope should be.
- Do not treat this record as resolving the 5 anchored over-cap records — that is a separate, open card
  the manager is filing off this finding. Check the board for its current state before assuming it's done.
- Do not read the count "41" (or "5"/"36") as stable — re-run
  `node packages/daemon/assets/comment-anchor-lint.mjs .` and re-derive the anchored/orphan split fresh;
  both this record's own count and the anchored-vs-orphan split were already stale relative to
  concurrently-landing lanes by the time they were measured.

## Consequences

New records landing over `PER_RECORD_MAX_BYTES` are now visible at authoring time via the CLI lint scan
(not yet wired into the live per-file hook — records live under `docs/`, outside `SOURCE_ROOTS`, so the
hook structurally never observes a record file being written; see `comment-anchor-lint.mjs`'s own header).
The 5 anchored over-cap records continue to truncate on injection, unchanged, until the follow-up card
splits or trims them. The 36 orphan records also continue to truncate-on-paper (the read-time safety net
is unconditional, per-record, and does not check reachability) but never actually exercise that path today
— until one of them gains an anchor, at which point it behaves exactly like the 5.

## Source

`packages/daemon/assets/comment-anchor-lint.mjs`'s `oversizedRecords` and `orphanRecords` checks (cards
`d0d0401b` and `5329a9af`) and `PER_RECORD_MAX_BYTES` in `packages/daemon/assets/decision-records.mjs`
(card `da723d41` raised it 4000→6000; exported for `d0d0401b` so the lint reads one source of truth).
