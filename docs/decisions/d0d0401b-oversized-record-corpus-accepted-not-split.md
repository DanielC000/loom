# d0d0401b — the current over-cap record corpus is explicitly accepted, not retroactively split

## Narrative

Card `d0d0401b` moved the `PER_RECORD_MAX_BYTES` constraint from silent enforcement at read time
(`decision-records.mjs` truncating an oversized record on injection, head+tail, with an explicit marker)
to visible enforcement at authoring time: `comment-anchor-lint.mjs`'s whole-repo CLI scan now reports an
`oversizedRecords` check, reading the cap from `decision-records.mjs`'s own exported `PER_RECORD_MAX_BYTES`
constant (imported, not a second hand-copied number — see that constant's own doc comment for why the
import is safe despite this repo's general "assets stay standalone" duplication convention).

The card's own body measured 4 of 91 records over cap on the day it was filed (2026-09-09, before
`784caba` even fully landed). A re-measurement immediately before this card's own report — same
`comment-anchor-lint.mjs .` scan, this worktree's HEAD `1974444dc94618d380f474192e22edff20215ec5`,
2026-09-09T19:47:32Z — found **41 of 205** records over the 6000-byte cap (1 in `docs/adr`, 4 in
`docs/decisions`, 36 in `docs/investigations`). The corpus grew roughly 2.3x in records and the over-cap
count grew roughly 10x in the same day, confirming the card's own thesis: a byte cap checked against a
snapshot cannot stay true on a corpus moving this fast, and the count itself is not a stable thing to chase.

**Decision: the 41 currently-over-cap records are explicitly accepted as-is, not split or trimmed by this
card.** Splitting 41 records (most of them `docs/investigations/*/findings.md` — detailed multi-day
investigation reports, several 3-6x over cap) is a large, judgment-heavy editorial undertaking with no
natural stopping point while the corpus keeps growing underneath it; doing it inside this card would not
even leave the corpus under cap by the time the card closes. The card's actual deliverable — a lint that
makes a NEW over-cap record loud at authoring time instead of silently truncating on read — is what
prevents the population from growing further un-noticed. Read-time truncation (head+tail, explicit marker)
remains the correct, unchanged safety net for the 41 records above, exactly as DoD-4 requires.

## Do not

- Do not read "41" (or any other count reported here) as a stable, current number — re-run
  `node packages/daemon/assets/comment-anchor-lint.mjs .` and read `oversizedRecords` fresh; this record's
  own count was already stale relative to concurrently-landing lanes by the time it was written.
- Do not treat this acceptance as permanent cover for a record that gets touched again — an author editing
  an already-over-cap record who sees the lint's own warning should still consider splitting it then,
  rather than citing this record as blanket permission to leave it oversized forever.
- Do not remove or weaken the read-time truncation in `decision-records.mjs` on the theory that the lint
  now makes it redundant — DoD-4 is explicit that truncation stays the last-resort safety net, and the 41
  records this decision accepts are still relying on it today.

## Consequences

New records landing over `PER_RECORD_MAX_BYTES` are now visible at authoring time via the CLI lint scan
(not yet wired into the live per-file hook — records live under `docs/`, outside `SOURCE_ROOTS`, so the
hook structurally never observes a record file being written; see `comment-anchor-lint.mjs`'s own header).
The 41 pre-existing oversized records continue to truncate on injection, unchanged, until someone
individually revisits and splits them.

## Source

`packages/daemon/assets/comment-anchor-lint.mjs`'s `oversizedRecords` check (card `d0d0401b`) and
`PER_RECORD_MAX_BYTES` in `packages/daemon/assets/decision-records.mjs` (card `da723d41` raised it
4000→6000; exported for this card so the lint reads one source of truth).
