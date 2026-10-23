# c52b290e — the four residual under-including `armedKeys` consumers from `6be6c9ff`'s audit: three fixed, one closed non-reproducible

From `6be6c9ff`'s own grep audit (originally two sites) plus Code Review `2029fcf5`/SF1 (two more, folded
in). All four expose the SAME root shape: `protectOccupantContentBeforeDelete`'s own both-indices
re-point branch (`merge-quarantine.ts` ~:2629/2633/2642) can `replaceEntryEverywhere` a re-pointed
multi-key twin onto `written.entry` WITHOUT ever stamping `armedKeys` (the `c9114934`/`cd5a3cf9` union
gate restricts its source to `toPersist`/`oldAtFilename` alone) — `written.entry` can carry NO
`armedKeys` of its own even though `activeQuarantines` genuinely maps MULTIPLE keys to it. Each site
below was investigated (a hermetic probe, RED where reproducible) before any fix.

## Site 1 — `confirmedDurableBackingElsewhere` — FIXED

Scanned `entry.armedKeys ?? []` alone; for the re-pointed-twin shape this always returned `false` (no
backing confirmed) even when a genuinely durable, on-disk, same-identity, same-token copy existed at the
twin's OTHER live-armed key. Feeds `survivingTokenHolderRepoPaths` → `differentUnresolvableOccupantRepoPathAt`
(the sole prod call site passing `excludeFinalPath`) → over-reports a "surviving holder" — FAIL-CLOSED
(over-protective), never fail-open.

**Fix:** extracted a new key-less helper, `liveArmedKeysOf(entry)` — the union of `entry.armedKeys` and a
live `activeQuarantines` scan for `v === entry`, with no seed key to union in. `liveArmedKeys(key, entry)`
now calls it plus `key`, so there is ONE source for "every key this entry might be armed at right now".
`confirmedDurableBackingElsewhere` scans `liveArmedKeysOf(entry)` and is now exported (a pure,
side-effect-free predicate, same posture as `ownedKeysIncluding`) so the test corpus can call it directly.

## Site 3 — `ownedKeysIncluding` (feeds `enterMergeQuarantine`'s existing-branch raise's own `liftedKeys`) — FIXED

Same shape: `entry.armedKeys`-only, filtered through `entryStillOwnsKey` — under-included a live multi-key
twin's other key. The function's own prior doc deliberately kept this NARROWER than `keysToLift`
(`6be6c9ff`), reasoning that over-inclusion here is FAIL-OPEN (`78fccd3f`'s own fix: it wrongly strips a
resolvedKey from a protective copy that should survive).

**Re-derivation before adopting the reviewer's suggested formula** (`liveArmedKeys(key, entry).filter(k
=> k === key || entryStillOwnsKey(k, entry))` — the same shape `6be6c9ff` already uses for
`keysToLift`): `liveArmedKeys`'s only ADDITION beyond `entry.armedKeys` is a live `activeQuarantines`
scan for `v === entry` — exact reference equality, so every key it adds is one `entry` genuinely,
currently occupies right now. Re-applying `entryStillOwnsKey` afterward admits a reference-equal addition
trivially (its own first branch) and still excludes a STALE `armedKeys` member exactly as before — the
filter itself is unchanged, so `78fccd3f`'s original fail-open fix is not touched, only widened to also
catch keys `armedKeys` never recorded at all.

**Part B — the `78fccd3f` filter's own guard, honestly described (Code Review finding SF1): this is NOT
a proof the widening is safe.** `existing` (R's own entry) has a STALE `armedKeys` member `kStale`, now
genuinely occupied by a DIFFERENT, unrelated object (identity `Z`). `kStale` is excluded from
`ownedKeysIncluding`'s result under BOTH the old and the new formula — `entryStillOwnsKey`'s
identity-mismatch branch rejects it regardless of which candidate set it was drawn from, so Part B (a
FOREIGN occupant `F` at `R`'s own primary final, `resolvedKey = kStale`, the protective copy correctly
KEEPING that `resolvedKey`) passes on the PRE-fix code too. It guards that the pre-existing `78fccd3f`
filter still runs, unmodified — not that the NEW live-scan addition is safe.

**The actual safety argument: the widening is EQUIVALENT to a fully-populated `armedKeys`, for any key the
entry genuinely, LIVE-owns.** `liveArmedKeys`'s only addition beyond `entry.armedKeys` is a live
`activeQuarantines` scan for `v === entry` — exact reference equality. Every key that scan adds is one
`entry` genuinely, currently occupies right now, so `entryStillOwnsKey`'s own reference-equality branch
admits it exactly as it would if that same key had been correctly, fully listed in `armedKeys` from the
start — the widening can never make `ownedKeysIncluding` behave differently than a hypothetical,
fully-accurate `armedKeys` would have.

**Part C — the reviewer's equivalence check, driven end-to-end through the REAL `enterMergeQuarantine`
raise, proving the above directly rather than merely asserting it:** the SAME scenario — `existing`
LIVE-armed (by reference) at both `key` and `K2`, a foreign occupant `F` at the primary final whose
`resolvedKey = K2` (a key `existing` genuinely owns) — run TWICE, once with `armedKeys:[]` (the
re-pointed-twin shape this card's fix targets) and once with `armedKeys:[key,K2]` (the ordinary,
fully-populated shape). `F`'s own outcome (protective copy written, `resolvedKey` correctly STRIPPED
since `K2` legitimately belongs to `existing`'s live arming, token preserved) is IDENTICAL in both runs —
empirically confirming the widening changes nothing for a key the entry truly, live-owns.

## Site 4 — `clearMergeQuarantineByRecordedPath`'s `activeLiftedKeys` — FIXED (no observable behavior change found)

`seen.has(entry)` fired, on a twin's SECOND (and later) live-key Map-iteration visit, BEFORE
`activeLiftedKeys.add(key)` ever ran for that key — `seen` was already populated by the twin's first key.
Confirmed by code reading; a direct probe (the real exported `clearMergeQuarantineByRecordedPath`, a
live multi-key twin with real on-disk latches at both keys) found NO observable defect: the delegated
`clearMergeQuarantineByKey` call independently recomputes its own `keysToLift` via `liveArmedKeys` on the
same entry object, recovering the twin's other key regardless of what this caller's `L` omitted. The one
theoretical exposure (`excludeLiftedResolvedKey`/`resolvedKeyToCarry`, fed by this same `L` for a
PENDING-side key clear) needs a further, separately-constructed foreign-occupant `resolvedKey` collision
at a pending key — not constructed in this investigation.

**Fix (cheap, no fail-open risk found, applied regardless of the above):** the loop computing
`activeLiftedKeys`/`matched` was extracted into its own function, `activeMatchesAndLiftedKeysFor(identity)`
(exported, for direct testing), with `activeLiftedKeys.add(key)` moved BEFORE the `seen.has(entry)`
de-dup gate — `seen` governs `matched`/the `armedKeys` scan only, never whether a live key this
iteration is holding belongs in `activeLiftedKeys`.

## Site 2 — `clearMergeQuarantineByKey`'s `tiedViaKeyOrOrphanRef` (`keysToLift.some((k) =>
p.entry.armedKeys?.includes(k))`) — CLOSED, NON-REPRODUCIBLE (NOT widened)

An attempted construction — an active `entry` with a stale `armedKeys` member `K2` now occupied by a
DIFFERENT, live object `occupant2` (admitted into `keysToLift` via `entryStillOwnsKey`'s subset-token
branch), with a pending twin `p` reference-equal to `occupant2` (the dual-tracked-twin shape,
`883e29bc`/`64283e06`) and `p.entry.armedKeys` empty — came back inconclusive: `subsetOfClearedTokens`
(checked earlier in the SAME `tiedToThisEntity` disjunction) always ALSO fired, because it reduces to the
IDENTICAL relation (`occupant2.tokens ⊆ entry.tokens`) whenever a non-reference-equal object's key enters
`keysToLift` via `entryStillOwnsKey`'s own subset branch.

**The structural argument, mirroring `78fccd3f`'s own precedent for its analogous raise-path finding —
covering all THREE ways a key can enter `keysToLift` (`entryStillOwnsKey`'s own three branches):**

1. `k === key` — the clear's own freshly-matched key, included unconditionally, never via
   `entryStillOwnsKey` at all. For a non-reference-equal `p` to be "truly tied" via this `k`, `p` would
   need to independently occupy `key` too — impossible without `p.entry === entry`, which is already the
   trivial FIRST disjunct of `tiedToThisEntity` (`p.entry === entry`), unconditionally tied regardless of
   `armedKeys`.
2. `occupant === entry` (reference equality) for some other `k` — if `p.entry` is ALSO that same object,
   `p.entry === entry` again, the same trivial first disjunct. If `p.entry` is a DIFFERENT object, it has
   no genuine claim via this `k` at all; `p.entry.armedKeys` happening to list `k` either way is the
   ALREADY-ADDRESSED stale-member case (`78fccd3f`/`3152ec90`), not a new compounding gap.
3. `occupant !== entry` but token-SUBSET match — the one substantive case: the only way a
   non-reference-equal object can enter `keysToLift` via genuine current occupancy rather than a stale
   label. If that object is ALSO the pending twin `p` being checked for a tie (the only way
   `armedKeys`-based detection could matter at all — a non-dual-tracked pending entry has no live signal
   connecting it to `entry`'s own `keysToLift` in the first place), `subsetOfClearedTokens` independently
   fires on the IDENTICAL relation (`p.entry.tokens ⊆ entry.tokens`, since `p.entry === occupant` here).

So `tiedViaKeyOrOrphanRef`'s `armedKeys`-based clause can never be the SOLE deciding factor for this exact
under-detection shape, across all three branches — there is no constructible scenario where widening it
would change any outcome. Left unwidened; this section is the closure.

## Do not

- Do not widen `clearMergeQuarantineByKey`'s `tiedViaKeyOrOrphanRef` armedKeys clause for this shape —
  see Site 2 above; the structural argument, not merely an unsuccessful repro attempt, is why.
- Do not read Site 4's "no observable behavior change found" as proof NOTHING could ever depend on
  `activeLiftedKeys`/`L` including a twin's other key — only the one consumption path this investigation
  actually probed (the active-side physical-latch lift) was shown unaffected; the `excludeLiftedResolvedKey`
  exposure named above is a genuine, un-probed residual, not a ruled-out one.

## Verification

- `test/merge-quarantine-c52b290e-confirmed-durable-backing.mjs` (Site 1): the card's own shape plus
  three negative controls (different token, no file, foreign identity) plus a pre-existing-shape control.
- `test/merge-quarantine-c52b290e-owned-keys-including.mjs` (Site 3): Part A direct RED/GREEN plus the
  `78fccd3f`-shape negative control; Part B the pre-existing filter's own guard (passes on PRE-fix code
  too — see Site 3 above for why that is honestly NOT a fail-open proof); Part C the reviewer's
  equivalence check, the actual no-fail-open proof.
- `test/merge-quarantine-c52b290e-active-lifted-keys.mjs` (Site 4): the card's own shape plus a
  single-key negative control and a foreign-identity negative control.
- **RED/GREEN, two kinds, named honestly rather than conflated:**
  - A full-file `--ref HEAD` revert (`pnpm --filter @loom/daemon negative-control --file
    packages/daemon/src/git/merge-quarantine.ts --test <all three above> --ref HEAD`) proves BUILD/IMPORT
    RED→GREEN→clean for all three — but for Sites 1 and 4 (and Site 3's Part B/C, which depend on the
    same exports) that RED is a `TypeError` from a missing export at `HEAD~1` (`confirmedDurableBackingElsewhere`/
    `directPathIdentity`/`activeMatchesAndLiftedKeysFor` did not exist pre-fix), not a behavioral
    assertion failure.
  - Sites 1 and 3-Part-A were ALSO re-proven with a LOGIC-ONLY revert (exports kept, only the function
    BODY temporarily reverted to the pre-fix formula, via Edit, rebuilt, re-run, then restored byte-for-
    byte and rebuilt again) — this produced REAL assertion failures (`FAIL` lines, not crashes),
    including Part C's own equivalence assertions, confirming the tests exercise the actual logic change.
  - **Site 4 has NO claimed behavioral RED** — its own investigation (above) found no end-to-end
    observable difference, so its full-file-revert RED was the missing export only; a logic-only revert
    there would show a genuine LOCAL assertion failure (`activeLiftedKeys` membership), but that is a
    regression guard for the code change itself, never evidence of an end-user-observable behavior
    change, which this card does not claim for Site 4.
- Full `merge-quarantine*.mjs` corpus, individually, fresh `LOOM_HOME` per file, both env states
  (`env -u LOOM_DEV -u LOOM_SUPERVISED` / `LOOM_DEV=1 LOOM_SUPERVISED=1`), one lane.
- `pnpm --filter @loom/daemon guards`, committed first.

The root cause (`protectOccupantContentBeforeDelete`'s re-point never stamps `armedKeys`) and the
remaining `armedKeys`-only consumers this card did not touch are tracked on card `1fc3a561` ("fix(git):
widen the remaining armedKeys-only quarantine clear consumers to live-armed keys") — this card closes
Sites 1-4 of `6be6c9ff`'s own audit only, never the root cause itself.

See `docs/decisions/6be6c9ff-live-armed-keys-covers-every-key-a-multi-key-twin-reaches.md`'s own "Do not"
section, now updated to state Sites 1/3/4 are closed here and Site 2 is closed non-reproducible here.
