# 7a7e041b — `protectOccupantContentBeforeDelete`'s own on-disk token read never subtracted `clearedTokens`

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up 7a7e041b (Code Review of d6efbc9b, reviewer 00513d54) — `protectOccupantContentBeforeDelete`'s own on-disk token read never subtracted `clearedTokens`

Pre-existing, fails closed (not a regression — it fails the same way on `d529d42d`).
`protectOccupantContentBeforeDelete` (merge-quarantine.ts) copies a degraded foreign occupant's final
aside using the on-disk `tokens` exactly as parsed, never subtracting `clearedTokens` — unlike its
sibling reader `reconcileMarkedBasenameBeforeWrite`, which already does. So when a kept final whose
`repoPath` names a different, now-unresolvable identity still physically holds a token this process has
already deliberately cleared, that token rides back in — as a brand-new pending-divert record for the
degraded identity — the next time a DIFFERENT raiser's own raise reaches this copy-aside.

Repro (P3, the reviewer's own, ported verbatim as `7a7e041b-p3` in `merge-quarantine-raise-protect-failure.mjs`
— the reviewer's own scratch probe `zz-cr5-probe.mjs` was never committed):
1. `d` = `R`/sub-d, a resolvable subdirectory of `R`; `canonicalRepoLockKey(d) === Kr`.
2. `d1 = enter(d)`.
3. `t1 = enter(R)` — takes the existing branch (longest-outstanding raise wins the identity), so the
   entry has `repoPath: d`, `tokens: [d1, t1]`.
4. `clearByToken(d, d1)` — a partial clear. The final now holds `{repoPath: d, tokens: [t1]}`.
5. `rm -r sub-d`.
6. `clearByToken(R, t1)`, with read #1 of the final failing — the last remaining in-memory token on
   that entry. `clearMergeQuarantineByKey` keeps the final (fail-closed), but `d6efbc9b`'s own fix still
   tombstones `t1` unconditionally. `R` is lifted in-process.
7. `t2 = enter(R)` — a fresh raise, no injection at all. The still-marked final physically holds `[t1]`
   (kept by step 6), and `d`'s own identity is unresolvable, so this hits the "different, still-
   unresolvable identity" branch and calls `protectOccupantContentBeforeDelete(final, d, R)`. Pre-fix: it
   parses `[t1]` straight off disk and copies it aside into a BRAND-NEW pending `d` record — a pending
   sub-d record now holds `t1` again.
8. `clearByToken(R, t2)` — `t1` still survives via that pending record, and comes back after a reboot.

### The fix

1. **One shared on-disk-token reader.** `readSurvivingOnDiskTokens(parsed)` — parses `tokens`/`token`
   (same fallback shape both readers already used) and subtracts `clearedTokens`, returning BOTH the raw
   on-disk array and the surviving (post-subtraction) one. `reconcileMarkedBasenameBeforeWrite` now calls
   it instead of re-deriving the same filter inline; `protectOccupantContentBeforeDelete` calls it too —
   the two readers can no longer drift apart, which is exactly how this card's own bug happened in the
   first place (one reader was fixed in round 3, the other never was).
2. **Skip the copy-aside entirely when every real on-disk token is already tombstoned.**
   `protectOccupantContentBeforeDelete` now checks `rawTokens.length > 0 && survivingTokens.length === 0`
   right after validating `final`'s own shape, and returns `true` (the same "nothing to protect"
   contract its ENOENT/corrupt branches already use) WITHOUT building `toPersist`, writing a
   pending-divert file, or pushing anything onto `pendingUnresolvedQuarantines` — never a record with an
   empty `tokens` array, and never one backed by a freshly-minted random token standing in for content
   that no longer has an owner.
3. **Why skipping is safe (the card's own ruling).** File ownership holds: nobody still holds any of
   those on-disk tokens — each one was deliberately released through its own normal clear path
   (`tombstoneIfNotSurviving`), which already durably removed its own record before this copy-aside ever
   ran. Eviction never discards: there is nothing left for this copy-aside to discard in the first place
   — the content it would have protected was already, correctly, released by its own owner; skipping is
   not a NEW loss, it is recognizing a loss that already legitimately happened. The one-read-per-write
   rule (round 3) is unaffected — this is a NEW reader (`protectOccupantContentBeforeDelete` never shared
   a read with `writeMergeQuarantineLatch`'s own chokepoint to begin with), not a second independent read
   of the same file for the same write.
4. **A genuine MIXED on-disk token set carries forward only the survivor.** When `rawTokens` holds some
   tokens already tombstoned and at least one that was never cleared, `readSurvivingOnDiskTokens`' own
   `surviving` array — never the raw one — is what gets persisted into `toPersist.tokens` (falling back
   to a freshly-minted token only when `rawTokens` itself is empty, the pre-existing legacy-shape
   fallback, unchanged by this card). The tombstoned token is dropped silently; the still-owed one is
   protected exactly as before.

### Tests

`merge-quarantine-raise-protect-failure.mjs`:
- **`7a7e041b-p3`** — P3 above, ported verbatim. Doubles as the card's own "all-tokens-tombstoned"
  scenario: by the time the copy-aside runs, the only token physically on `final` (`t1`) has already
  been tombstoned, so the fix must skip the copy-aside outright. Asserts `t1` is never resurrected by
  `R`'s own re-raise (in-process and across a reboot), that NO pending record for `d`'s own identity is
  ever minted, and that `R` lifts fully and stays lifted.
- **`7a7e041b-mixed`** — a genuine mix: `final` physically holds two tokens, one already tombstoned (via
  a wholly unrelated repo's own raise, fully cleared, reusing the identical token string — the tombstone
  set is keyed on the string alone, exactly as it is in production) and one never cleared at all. Hits
  the SAME call site as P3 (`protectDegradedOccupantBeforeDelete`'s own "no existing"/brand-new-entry
  region — nothing is ever armed in-memory for the degraded identity in this scenario, so there is no
  "existing"-branch identity-exemption to route around). Asserts the tombstoned token is dropped from the
  copy-aside, the still-owed token survives it (in-process and across a reboot), and the raiser's own
  fresh token is enforced too.

Both scenarios measure tokens directly via `listActiveMergeQuarantines().flatMap(q => q.tokens ?? [])`,
never `assertRepoNotQuarantined`, and both check a reboot through a fresh module import. Proven RED on
`HEAD` (pre-fix, this card's own uncommitted working-tree edit) and GREEN after, via
`scripts/negative-control.mjs` — the RED phase fails exactly the seven new assertions these two scenarios
add (both scenarios' own `*** THE FIX ***`-labeled checks), with the build succeeding on both sides, so
the RED is behavioral, not a build failure. All `merge-quarantine*.mjs` files re-verified individually,
each exit 0. All static guards (`pnpm --filter @loom/daemon guards`) re-verified green.

## Do not

- **(Follow-up 7a7e041b)** Do not let `protectOccupantContentBeforeDelete` parse its own on-disk
  `tokens`/`token` independently of `reconcileMarkedBasenameBeforeWrite` — route BOTH through the shared
  `readSurvivingOnDiskTokens`, or the two readers can drift apart again exactly as they did here (one
  subtracted `clearedTokens`, the other never did).
- **(Follow-up 7a7e041b)** Do not persist an empty-`tokens` or freshly-minted-random-token pending record
  when every real on-disk token is already tombstoned — skip the copy-aside entirely and return `true`
  ("nothing to protect"). Every one of those tokens was deliberately released by its own holder before
  this copy-aside ever ran; there is nothing left to protect, and inventing a record to protect it with
  would itself be the fail-open bug.
