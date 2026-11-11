# 78fccd3f — follow-up to the raise-divert card (see the section body)

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up 78fccd3f

Code Review `c399729b` of `3152ec90` found `deleteMergeQuarantineLatchByKey`'s own DEFAULT `liftedKeys`
and `enterMergeQuarantine`'s existing-branch raise both built `liftedKeys` UNFILTERED — the same
over-include direction `3152ec90` fixed for `keysToLift` itself. `liftedKeys` feeds only
`excludeLiftedResolvedKey(s)`, so a stale `armedKeys` member surviving there is FAIL-OPEN (it can wrongly
strip a resolvedKey from a protective copy that should have survived).

**Raise path — narrowing-only, fail-open NOT reproduced.** An honest repro attempt (hermetic, in-process,
reusing `3152ec90`'s own twin-plus-stale-key fixture) found no constructible scenario where this site's
own protect call reaches a REAL on-disk foreign occupant to exercise the exclusion on: a boot-graduated
twin's secondary armed key never gets a physical final written at all, and this module's own overlapping
write-side guards (`d163aef5`, `e0192ffb`/`82032b5c`) prevent foreign content from durably coexisting at a
key a stale-but-still-armed twin's OTHER key occupies. THE FIX: this site now calls a new shared helper,
`ownedKeysIncluding(key, entry)` — `key` unconditionally plus every OTHER `armedKeys` member gated through
`entryStillOwnsKey`. Tested directly, via `*** CARD 78fccd3f ***` in `merge-quarantine-raise-protect-
failure.mjs` (the end-to-end protective-copy path can't discriminate filtered from unfiltered here).
Surgical negative control (drop the filter, rebuild): RED on exactly those two assertions; restoring
byte-identical (`cmp`-verified) turned it GREEN.

**Clear path — a genuinely reproduced CRITICAL, found by a second Code Review (of `a57f1e26`), FIXED.**
`deleteMergeQuarantineLatchByKey`'s former DEFAULT had exactly ONE caller — `clearMergeQuarantineByKey`'s
own primary `keysToLift` loop — which deletes every key in `keysToLift` from `activeQuarantines` BEFORE
that loop runs. Re-deriving `liftedKeys` from `entry.armedKeys` against that ALREADY-EMPTIED map made
`entryStillOwnsKey` reject every other key, collapsing `liftedKeys` to the one key in hand and wrongly
keeping a sibling key's own resolvedKey in a protective copy — a reboot then re-blocked an already-cleared
repo. THE FIX: `clearMergeQuarantineByKey` now passes `keysToLift` (computed BEFORE the deletes) as an
explicit override. With all 4 callers now passing one explicitly, the default was REMOVED entirely —
`liftedKeys` is a required parameter, so it can never again be lazily re-evaluated against a map a caller
already mutated.

Pinned by `78fccd3f-dual-arm-clear-route-resurrection` in `merge-quarantine-runtime-union-provenance.mjs`
(the clear-route sibling of that file's own `4b06875f-dual-arm-clear-resurrection` PROBE B). Checked out
`a57f1e26`'s own `merge-quarantine.ts` alone (tsbuildinfo cleared, rebuilt): RED on exactly the 2 expected
assertions; restored byte-identical (`cmp`-verified), rebuilt: GREEN. All 42 `merge-quarantine*.mjs` files
run serially, exit 0, under both `env -u LOOM_DEV -u LOOM_SUPERVISED` and `LOOM_DEV=1`. Item 3 (same card):
`merge-quarantine-clear-by-path.mjs`'s I3 precondition also asserts `armedKeys[0] === keyNoFile`.
