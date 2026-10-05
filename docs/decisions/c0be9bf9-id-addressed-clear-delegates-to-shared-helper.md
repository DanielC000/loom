# c0be9bf9 — an id-addressed merge-quarantine clear delegates to the shared helper, never re-implements it

## Context

Round 1 of `clearMergeQuarantineLatchFile` (the `POST /internal/merge-quarantine/clear-by-path` `{id}`
form) re-implemented `clearMergeQuarantine`'s own clear logic by hand: it purged the in-memory entry at
every one of its `armedKeys`, then unconditionally unlinked exactly `<id>.json` — the one physical file
whose name happens to equal `id`.

That missed two things `clearMergeQuarantine` already handles correctly:

- **Per-armed-key latch deletes (decision 54054c01).** A dual-armed entry (armed under both its
  `resolvedKey` and a degraded current-key fallback — see that decision for when this happens) can have
  its REAL durable file sitting at a DIFFERENT hash than `id`. Deleting only `<id>.json` leaves that real
  file on disk, and it re-arms the quarantine on the next boot even though the in-memory entry (and the
  human) believed it was cleared.
- **The `orphanLatchFiles` sweep (decision 24c0bdba round 7, M2).** An entry that exists only because a
  corrupt boot-time orphan latch fail-closed every registered repo must also delete that orphan file once
  nothing else references it — or the orphan re-quarantines everything again on the very next boot, even
  after every repo it touched has been individually "cleared" by id.

Round 2 (Code Review `c2aa28c3` of commit `e5ba5376`) found both gaps as a single blocking Major.

## Round 3 (delta Code Review `4168d232` on commit `f82358d8`)

Round 2's own fix still re-derived the repo by `repoPath`: once it matched an `id` to an entry, it called
`clearMergeQuarantineReporting(entry.repoPath)`, which recomputes `canonicalRepoLockKey(repoPath)` FRESH at
clear time — not the Map `key` that was actually matched. Under KEY DRIFT (the entry's own nested `.git`
removed between the match and the act, so a fresh recompute of its `repoPath` now walks up to a DIFFERENT,
outer repo's key) that fresh recompute can land on an entirely different entry's key, so the clear lifts
the WRONG repo's quarantine and reports `ok:true` while the entry actually addressed by `id` is left fully
armed.

**Fix:** factor a key-addressed core, `clearMergeQuarantineByKey(key)` — it lifts the entry currently armed
at `key` (every key in its own `armedKeys`), deletes each one's physical latch, sweeps a pending entry
matching `key`, and runs the `orphanLatchFiles` sweep; exactly what `clearMergeQuarantine` used to do
inline. `clearMergeQuarantine(repoPath)` is now a thin wrapper —
`clearMergeQuarantineByKey(canonicalRepoLockKey(repoPath))` — unchanged behavior for every EXISTING caller
(`/clear`, `/clear-by-path`'s `{repoPath}` form), neither of which ever had a separately-matched key to
preserve in the first place. `clearMergeQuarantineLatchFile`'s active-entry match now calls
`clearMergeQuarantineByKey(key)` with the exact Map key it matched `id` against — never `entry.repoPath` —
so the clear can never drift onto a different key than the one the id actually named. A pending-entry match
(matched by `sourceFile`, not a key at all) drops ONLY that specific pending entry and unlinks its own
`sourceFile` directly, for the identical reason: recomputing and delegating by key could drift there too.

Test: `merge-quarantine-clear-by-path.mjs` section (L) — a repo nested inside another git repo (its own
`.git`), both quarantined, the inner's own `.git` removed (the drift), then cleared by the INNER's id.
Asserts the inner entry is actually cleared and the outer entry is untouched. A fixture-sanity check (the
identical fixture with NO drift — labeled "(L fixture sanity, no drift)" since card `abccee85`, round 4:
it doesn't discriminate the bug, so "negative control" overstated what it proves) shows the
inner-cleared/outer-armed outcome holds either way, but only the drifted case can ever manifest the round-3
bug; without the drift, round 1/2's own code already passed this shape too.

### Round 3, minor — `quarantineLatchFileIdsFor`'s ordering, and the over-claiming docs it left behind

`quarantineLatchFileIdsFor` returned a dual-armed entry's ids in raw `armedKeys` order — PASS 1 always arms
the (degraded, no-file) current key FIRST and the (real, has-a-file) `resolvedKey` SECOND, so `ids[0]` — the
value `GET /internal/merge-quarantine/list` hands out as its `id` field — named the id with NO physical
file, not the real one. **Fix:** the function now sorts its id list so an id with a real on-disk file sorts
first. The function's own doc comment, and `gateway/server.ts`'s `/list` route comment, both previously
implied every returned id "resolves to a real file" — corrected to state only `ids[0]` is guaranteed that,
not the whole array.

**Round 4 correction (card `abccee85`):** even that narrower claim over-stated it — `ids[0]` names a real
file only WHENEVER any armed key has one; if the durable write itself failed (see
`writeMergeQuarantineLatch`), no armed key may have a file at all, and `ids[0]` is then just whichever key
happened to be first. Both doc comments (and the one above) are now worded that way. See decision
`abccee85` for the repoPath-form key-drift fix from the same round.

Test: `merge-quarantine-clear-by-path.mjs` section (I) (reusing its existing dual-armed fixture, no new
fixture needed) now also asserts `quarantineLatchFileIdsFor(dualEntry)[0] === realHash` — the id with the
real on-disk file — before the section's own `clearMergeQuarantineLatchFile(degradedId)` call.

### Round 3, nit — `quarantineLatchIdFor` has no production caller

Reworded its doc comment to say so plainly (TEST/DIAGNOSTIC HELPER ONLY) rather than imply a human-facing
route might still reach for it.

## Do not

- Do not have `clearMergeQuarantineLatchFile` purge `activeQuarantines`/`pendingUnresolvedQuarantines`
  and unlink a file by hand — resolve `id` to the matched entry's own Map KEY and delegate to
  `clearMergeQuarantineByKey`, the key-addressed core `clearMergeQuarantine` itself now wraps. Never
  resolve `id` to the entry's `repoPath` and delegate via `clearMergeQuarantineReporting`/
  `clearMergeQuarantine` instead (round 1's original fix, superseded in round 3 above) —
  recomputing `canonicalRepoLockKey(repoPath)` fresh at clear time can drift to a DIFFERENT key than the
  one actually matched (a nested `.git` removed between match and act), lifting the WRONG entry while
  reporting `ok:true`. A hand-rolled re-implementation here will drift from that helper's own fixes the
  moment either one changes without the other.
- Do not delegate a pending-entry match (matched by `sourceFile`) through a recomputed-key clear either —
  drop that exact pending entry and unlink its own `sourceFile` directly; recomputing its key and
  delegating could drift exactly the same way the active-entry path used to (round 3).
- Do not treat "no entry matches this id" as cause to skip the raw-file fallback — a genuinely corrupt/
  unparsable latch has no `repoPath` to delegate to, so that fallback (unlink exactly `<id>.json` + its
  tmp residue) is still the correct, and only, way to remove it.
- Do not report `wasQuarantined: true` from the raw-file fallback just because the unlink succeeded — it
  means "an in-memory quarantine was lifted", not "a file was deleted"; the two can disagree (a corrupt
  file with no matching entry still deletes a file but lifts nothing).
- Do not let `quarantineLatchFileIdsFor` return a dual-armed entry's ids in raw `armedKeys` order — PASS 1
  always arms the degraded (no-file) current key before the real (`resolvedKey`-hashed) one, so an
  unsorted list's `ids[0]` can name an id with no physical file at all. Sort so an id with a real on-disk
  file comes first (round 3).
