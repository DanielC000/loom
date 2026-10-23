# 6be6c9ff — a multi-key twin's OTHER armed key(s), covered via live occupancy, never `armedKeys` alone

From Code Review `3e2c79c5` of `0faffa95` (`425f97cd`), SF1 — reproduced with a hermetic scratch probe
before any fix; RED in both env states, GREEN after. NOT a regression: pre-`0faffa95` was equally broken.

## The hazard

`protectOccupantContentBeforeDelete`'s own both-indices re-point branch re-points EVERY
`activeQuarantines` slot whose value is the twin being replaced onto one freshly-written replacement,
`written.entry` — a twin armed at `[kTwin, kTwin2]` gets BOTH keys re-pointed. But
`written.entry.armedKeys` is NEVER unioned with the twin's own (only sourced from
`toPersist`/`oldAtFilename`, `@decision c9114934`/`cd5a3cf9`), so the replacement carries NO `armedKeys`
even though `activeQuarantines` now maps TWO keys to it.

`clearActiveEntryTokenAtKey`'s `armedKeysForEntry = entry.armedKeys?.length ? entry.armedKeys : [key]`
(and `clearMergeQuarantineByKey`'s `keysToLift`, identical shape) then collapses to the ONE key resolved.
The OTHER key is never visited: REDUCE leaves its latch holding the cleared token (a restart resurrects
it); REMOVE leaves it mapped, IN-PROCESS, to an entry still holding the token —
`assertRepoNotQuarantined` refuses with NO restart needed. Fail-closed; the `3d27c045` bug shape.

## The fix

A new shared helper, `liveArmedKeys(key, entry)`: the UNION of `entry.armedKeys`, a live scan of
`activeQuarantines` for every `k` where `activeQuarantines.get(k) === entry` (same discriminator
`replaceEntryEverywhere` uses), and `key`. Union only — ADDS a key never recorded, never DROPS one (a
caller's own `entryStillOwnsKey` gate screens stale members for an ACTING decision).

This is `@decision 8db913e2`'s own ("armedKeys — left unfixed (Lead ruling)") endorsed alternative to
copying a replaced object's stale `armedKeys` forward — applied at three chokepoints:

1. **`clearActiveEntryTokenAtKey`'s `armedKeysForEntry`** — via `liveArmedKeys`, BEFORE building
   `updated`, STAMPED onto `updated.armedKeys` so a LATER reader (`writeMergeQuarantineLatch`'s own
   `freshSecondaryKeys`) also sees the complete set.
2. **`clearMergeQuarantineByKey`'s `keysToLift`** —
   `liveArmedKeys(key, entry).filter((k) => k === key || entryStillOwnsKey(k, entry))`.
3. **`enterMergeQuarantine`'s existing-branch raise** — SAME shape, found via grep audit, on the write
   side: a raise onto an already-armed multi-key twin only rewrote ONE key's latch. Fixed the same way,
   stamped onto `baseEntry` too — union-only, every existing raise-path test stays byte-identical.

**Direction (a) — unioning the OLD objects' `armedKeys` onto `written.entry` at the re-point — NOT
taken:** `@decision 8db913e2` already forbids this. Direction (b) is that ruling's own endorsed
alternative: robust against this file's 20+ `replaceEntryEverywhere` sites leaving `armedKeys` stale
(already recurred: `37452ddd`/`d4b25feb`/`4b06875f`), fail-safe (union-only never omits an armed key).

## Grep audit for other consumers (every `.armedKeys` read, classified by symbol)

- **Shares the defect, FIXED:** the 3 sites above.
- **FIXED FOR FREE:** `writeMergeQuarantineLatch`'s `freshSecondaryKeys` — reads whatever caller-passed
  `entry.armedKeys`; correct now via the 3 sites above.
- **Structurally UNREACHABLE here:** `clearTokenFromPendingIndices`'s `ownedArmedKeys` —
  `@decision 64283e06` and `0faffa95`'s own `liveIsActiveTwin` defer already exclude an active twin.
- **Legitimate union of co-existing records, not a copy-forward:** `unionQuarantineEntries`,
  `unionArmedKeys`, `armQuarantineKey`'s write loop, `consumeMatchedPendingsIntoArmedEntry`.
- **Diagnostic only:** `ambiguousIdentitiesForLatchId`'s `armedKeys?.[0]` fallback, already imprecise.
- **NOT fixed, carded `c52b290e` (discoveredFrom this card) — all FAIL-CLOSED:**
  `confirmedDurableBackingElsewhere`; `tiedViaKeyOrOrphanRef` in `clearMergeQuarantineByKey`;
  `ownedKeysIncluding` → the raise's own `liftedKeys` (same `armedKeys`-only shape, NOT widened here —
  its caller must stay conservative); `clearMergeQuarantineByRecordedPath`'s `activeLiftedKeys`
  (Code Review `2029fcf5`/SF1 — its `seen.has(entry)` skips a twin's OTHER key once the FIRST is
  visited). All exposed to the TRUE unfixed gap: `protectOccupantContentBeforeDelete` never stamps
  `written.entry.armedKeys`. This card's 3 fixes close every REACHABLE defect its DoD requires.

## Do not

- Do not union a replaced/discarded object's own `armedKeys` forward onto a replacement — derive from
  LIVE occupancy instead. See `@decision 8db913e2`'s own "Do not" for the regression this avoids.
- Do not use `liveArmedKeys`'s raw output as `liftedKeys` directly, unfiltered — `enterMergeQuarantine`'s
  own `liftedKeys` (`ownedKeysIncluding`) now ALSO derives from `liveArmedKeys` (card `c52b290e` widened
  it, after re-deriving the formula does not reopen the FAIL-OPEN `78fccd3f` guards against), but always
  re-filtered through `entryStillOwnsKey` — never the raw, unfiltered union.
- **Sites 1-4 of this card's own audit are closed by `c52b290e`** — `confirmedDurableBackingElsewhere`,
  `ownedKeysIncluding`, and `clearMergeQuarantineByRecordedPath`'s `activeLiftedKeys` are fixed there;
  `clearMergeQuarantineByKey`'s `tiedViaKeyOrOrphanRef` is closed non-reproducible there, not widened. The
  ROOT CAUSE (`protectOccupantContentBeforeDelete`'s own re-point never stamps `armedKeys`) and the
  remaining `armedKeys`-only consumers `c52b290e` did not touch are **NOT** closed — tracked on card
  `1fc3a561` ("fix(git): widen the remaining armedKeys-only quarantine clear consumers to live-armed
  keys"). See `c52b290e`'s own decision record for the Sites-1-4 audit, fixes, and the equivalence proof.

## Verification

- `test/merge-quarantine-6be6c9ff-multikey-twin-armed-keys.mjs` — REDUCE/REMOVE, T2 armed at TWO keys,
  a REAL on-disk latch per key, asserted on disk, an in-process `assertRepoNotQuarantined` check for
  REMOVE, a simulated restart for REDUCE; plus (CR `2029fcf5`, SF2) a REAL `enterMergeQuarantine` raise
  onto such a twin, asserting the SECOND key's own latch GAINS the new token, then clears it.
- Negative-control (`--ref HEAD~1`, plus a scoped single-site revert for SF2): RED each, GREEN after,
  tree restored byte-identical.
- All `merge-quarantine*.mjs`, individually, both env states, FRESH `LOOM_HOME` per file: 0/128 failed.
- `pnpm --filter @loom/daemon guards`: 30/30 green, committed first.

See `docs/decisions/0faffa95-skip-active-twin-reresolve-defer-to-phase2.md`'s own residual section,
now updated to state it is closed by this card.
