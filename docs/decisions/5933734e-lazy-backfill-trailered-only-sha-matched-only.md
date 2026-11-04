# 5933734e — the lazy ship-state backfill never scans a trailers-off repo, and never overwrites a recorded `mergedSha`

## Narrative

Code Review `295fdd33` (card `5933734e`, the `merge_batch`-path `commitTrailers` honesty fix) found that
`GET /api/tasks/:id`'s lazy ship-state backfill (`gateway/server.ts`, card `1eebc46a`) triggered on
`!t.mergedSha || t.mergedVerification == null` — i.e. it re-ran `resolveMergedInfo`/`getTaskMergedInfo`
(a trailer-based, branch-NAME scan, not a lookup pinned to the sha already on the row) on EVERY drawer
open for a card whose `mergedSha` was already known but `mergedVerification` was still `null`. A
trailers-off batch landing is exactly that shape (`mergedSha` set at landing time, `mergedVerification`
left `null` by the honesty fix — see `docs/decisions/634edd2b-*.md`'s "Update (card 5933734e)" note), so
every drawer open on such a card re-ran a full `MERGED_LOOKUP` scan that is structurally INCAPABLE of
ever converging: the scan is trailer-keyed and a trailers-off landing wrote no trailer, so it can never
find anything to backfill.

**Round 1 of this fix (reverted below) over-corrected.** It narrowed the trigger to `!t.mergedSha` only,
which also killed the LEGITIMATE backfill this route exists for on OLDER, TRAILERED cards — pre-fix
history, a solo ALREADY_MERGED/boot-reconcile landing, a `noop` batch landing — where the scan genuinely
CAN still resolve a verification tier for the SAME sha already recorded (that's what cards `634edd2b`/
`d6d40edd` built this backfill for in the first place). The real distinguishing fact is not "is
`mergedSha` set" but "is this repo's `commitTrailers` config `off`" — only THAT structurally guarantees
the scan can never find anything.

Independent of the trailers-off case, there is also a genuine STALENESS risk the review named: if the
SAME task's branch landed MORE THAN ONCE (e.g. the toggle flipped between two landings of the same branch
name), the scan could resolve a DIFFERENT, older commit that still carries a matching trailer, and the
write-through (`setTaskMergedInfoNoTouch`) would silently OVERWRITE the correct, already-recorded
`mergedSha` with that stale one.

## The fix

Two independent guards, both on the restored original trigger (`!t.mergedSha || t.mergedVerification ==
null`):

1. **Skip the scan entirely when the task's repo resolves `commitTrailers: "off"`** — resolved via
   `resolveRepoByKey(project, t.repoKey)`, the same call the merge paths use (the field is project-level
   regardless of which repo-registry entry resolves — see `ResolvedRepo.commitTrailers`'s own doc). A
   stale `t.repoKey` (not in the current registry) is treated as "don't skip" — `resolveMergedInfo` below
   already degrades a stale key to primary safely, so there's nothing to protect against by skipping here
   too. **REMOVED by card `03f85c8e` — see "Update" below; its premise stopped holding.**
2. **Never write a `mergedSha` that differs from one already recorded.** After the scan resolves
   (`resolved.merged`), re-read the row (`fresh`, guarding the same TOCTOU race as before — a real landing
   completing between this handler's start and the write). If `fresh.mergedSha` is unset, write the full
   result (the original, unconditional case). If `fresh.mergedSha` is already set, write ONLY when the
   resolved sha is the SAME sha already recorded — and even then, only to fill a still-`null`
   `mergedVerification` (sha/repoKey/date stay exactly as recorded). A resolved sha that DIFFERS from the
   recorded one writes nothing at all.

The net effect AT THE TIME OF THIS FIX: a trailers-off card's `null` verification stayed `null` forever
(nothing to find, ever). A trailered legacy card's `null` verification CAN still backfill, but only when
the scan's own sha matches the one already on the row — never a silent overwrite with a different,
possibly stale, sha. **See "Update (card `03f85c8e`)" below — the trailers-off half of this is no longer
true; the sha-match half is unchanged and still what makes a write safe.**

## Do not

- Do not go back to skipping the scan on `!t.mergedSha` alone — that regresses the legitimate backfill for
  trailered legacy cards this record's "Round 1" section describes; the discriminator is the repo's
  `commitTrailers` config, not whether a sha happens to be set yet.
- Do not write a resolved sha that differs from an existing non-null `mergedSha` under ANY condition —
  only a sha-MATCH may ever update `mergedVerification` alone; a mismatch writes nothing.
- Do not skip the pre-write re-read (`const fresh = deps.db.getTask(t.id)`) as "redundant" given the outer
  guard — the outer guard is checked at request start; the re-read guards the actual write, after an
  `await` where state can change.
- Do not treat a stale `t.repoKey` (an `UnknownRepoKeyError` from `resolveRepoByKey`) as a reason to skip
  the scan — only a genuinely resolved `commitTrailers: "off"` skips it; a resolution failure falls
  through to attempt the scan as before (which itself degrades a stale key to primary safely).
- Do not assume this closes the SAME staleness risk for any OTHER caller of `getTaskMergedInfo` that
  writes through `setTaskMergedInfoNoTouch` without pinning — this fix is scoped to this one route.

## Consequences (AT THE TIME OF THIS FIX — see "Update" below for what changed)

A trailers-off card's `mergedVerification` was permanently `null` (an honest "unknown", never a wrong
guess). A trailered legacy card's `null` verification can still resolve to a real tier on a later drawer
open, exactly as cards `634edd2b`/`d6d40edd` intended, but a task whose branch landed twice under
different trailer regimes (or any other reason the scan finds a different commit) can never have its
recorded `mergedSha` silently replaced.

## Source

Code Review `295fdd33` on card `5933734e` (child of epic `d9332365`); corrected by the manager after this
record's own "Round 1" over-corrected per the review's own (partially incorrect) wording.

## Update (card `03f85c8e`, item 2) — the trailers-off skip is REMOVED; its premise stopped holding

Fix #1 above rested on one claim: a `commitTrailers:"off"` repo's scan is "structurally INCAPABLE of ever
converging" because the scan is trailer-keyed and no trailer was ever written. Card `aa09a59a` (decision
`e8d4fdc3` rounds 3-4) made that claim false: `getTaskMergedInfo` (what `resolveMergedInfo` calls) now
falls back to a branch-keyed `"ledger"` tier once its trailer walk misses, so a trailers-off landing CAN
converge — whenever Loom's own merge code left a `mainline_landed_commits`/`batch_landed_worker_tips` row
behind for that exact landing.

Card `03f85c8e` removed the `commitTrailersOff` skip from `GET /api/tasks/:id` (`gateway/server.ts`)
entirely — the route now calls `resolveMergedInfo` unconditionally, same as a trailered project. Fix #2's
sha-match write guard is UNCHANGED and is what still makes this safe: a resolved sha that differs from
the one already recorded still writes nothing, trailers on or off. Covered by
`task-merged-lazy-backfill.mjs` scenario (6a) (a ledger-backed, sha-matching landing now backfills to
`"ledger"`) and (6a-mismatch) (a ledger-backed but sha-MISMATCHED landing still writes nothing), proved
RED→GREEN against a mutant that re-adds the old skip while leaving every other scenario's behavior
untouched.

### Do not (card `03f85c8e` additions)

- Do not reintroduce the `commitTrailersOff` skip as a "safe no-op simplification" — it was only ever safe
  because the scan was GUARANTEED empty for that repo class; `aa09a59a`'s ledger tier removed that
  guarantee, so skipping now would silently withhold a real, available backfill.
- Do not read this as closing gap 1 of `docs/decisions/d9332365-*.md` (the crash-window) — that gap is a
  pre-commit-vs-ledger-write ordering problem, unrelated to whether a ledger row exists later; this update
  only concerns the STEADY-STATE read path once a ledger row genuinely was written.
- Do not assume every trailers-off card's `mergedVerification` now backfills — only one whose landing
  genuinely went through Loom's own merge code (and so left a ledger row) can; pre-ledger history or a
  landing from outside Loom's merge code still resolves `null`, same as `task-merged-state.mjs` scenario
  (6) proves for the read path generally.
