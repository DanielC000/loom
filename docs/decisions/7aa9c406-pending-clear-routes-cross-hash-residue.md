# 7aa9c406 — every pending-tier clear route arms the cross-hash tmp residue its freed key collapses onto

Sibling of `cdcd55c2` (read `docs/decisions/cdcd55c2-pending-clear-cross-hash-residue.md` first) and `f8e11853`.
cdcd55c2 fixed this only for the by-id clear. Its "Not covered" section named the rest.

## The bug (run RED per route before any fix)

Same fixture as cdcd55c2's MAIN scenario: a resolvable-now PENDING entry P blocks its canonical key through the
pending tier, X = `P/ghost` reads as enforced, and X's armable tmp residue is filed under an unrelated hash. After
the clear, in-process `stillBlockedEntryFor(X)` was `undefined` while a fresh boot of the same on-disk bytes armed X.

| Route | In-process / reboot (before) | Cause |
|---|---|---|
| `clearMergeQuarantineLatchFile` (by id) | true / true | fixed by cdcd55c2 (control) |
| `clearMergeQuarantine(p)`, p resolvable | false / true | falls to `clearMergeQuarantineByKey`; its pending loop swept only each entry's own sourceFile |
| `clearMergeQuarantineByRecordedPath` (and `clearMergeQuarantine` for an unresolvable p) | false / true | `tryClearMergeQuarantineByOwnIdentity`'s pending branch ran the own-source and orphan sweeps, never the tmp sweep |
| `clearMergeQuarantineByToken` | false / true | `clearTokenFromPendingIndices`' remove branch: same omission |
| `clearMergeQuarantineReporting` | true / true | thin wrapper over `clearMergeQuarantine`; inherits the fixes above |

The kickoff's `~:5887` hypothesis was wrong: that call is `clearActiveEntryTokenAtKey`'s partial-clear write, where the
entry stays armed and frees no key.

## The fix

- `freedKeysForClearedPendingEntries` — cdcd55c2's freed-key rule extracted verbatim (resolvable entry, or an
  unresolvable one with informative keys, frees `canonicalKeyOrUndefined(entry.repoPath)`; never its `resolvedKey(s)`).
  The by-id site now calls it, so there is one implementation.
- `sweepTmpResidueForClearedPendingEntries` — for the routes without a clear-by-id `id`: one
  `sweepTmpResidueForHashIfUnreferenced` per DISTINCT own-latch hash of the removed entries, each passed the union of
  freed keys. The hash is the entry's `sourceFile` stem (a final, or a crash-left tmp of it), else the hash Loom would
  write for its canonical key; if neither is derivable the entry's pass is skipped and logged. The sweep function's
  contract is unchanged.
- Wired into `clearMergeQuarantineByKey`'s pending loop (collects the wrappers it actually removes),
  `tryClearMergeQuarantineByOwnIdentity`'s pending branch, and `clearTokenFromPendingIndices`' remove branch
  (log-only, like its orphan sweep). The entries are always dropped from `pendingUnresolvedQuarantines` first.

## Do not

- Do not copy the freed-key rule into a call site or compute it with a mutating lookup (`resolveQuarantineFor`).
- Do not invent a hash for an entry with no derivable one; skip and log.
- Do not add the sweep to a clear that keeps the entry armed (partial token clears): no key is freed there.
- Do not touch `deleteMergeQuarantineLatchByKey`'s single-key / `armedKeys` handling here (card 119019d3).

## Ordering (Code Review round)

By-id runs its tmp sweep AFTER the cleared entry's tombstones and never lets the sweep's keep reach the tombstone
gate. The by-path/by-key and recorded-path sites now do the same: the durable-tombstone decision is made first (in
the by-key function it was moved up to just after the own-state reclassify; the sweep's keeps are merged in and
re-reclassified afterwards), and the recorded-path site no longer folds the sweep's `kept` into `pendingAnyKept`.
A foreign residue's disposition says nothing about the cleared entry's own tokens.

- What is and is not pinned: the by-key move is done for posture parity with by-id. It was unobservable while the
  by-path route's durable tombstone was withheld for the separate reason fixed by card 1fb27e46 (see
  `1fb27e46-by-path-tombstone-foreign-residue.md`); the order-a durable assertion now covers the by-path route too, but
  no mutant of the move itself has been run since, so the move is still not claimed as pinned. The ORDER test pins the recorded-path `kept` fold (a mutant that folds `kept` goes RED), not the
  move itself: a move-only mutant passes. The reason for the order is that a foreign residue's keep must never feed the
  cleared entry's own tombstone decision.
- Slightly more conservative durable tombstone: the later sweep means P's own deletable same-hash tmp is still on disk
  when the tombstone's disk re-verification scans, so the durable tombstone may be withheld where it would not have
  been; the sweep then deletes that tmp. Fail-closed and harmless, and identical to by-id.
- Token route: `tombstoneIfNotSurviving([token], …)` (in memory) already runs before the sweep, and the durable
  tombstone is a deferred job decided after the whole public call, so it is necessarily after the sweep. The sweep is
  log-only and never touches `removeWriteFailed`/`nonFailureOk`, so it cannot withhold anything. Nothing to reorder.
- Two Code Review premises did not survive a repro, so the tests assert what is true instead:
  - "A foreign residue holding a just-cleared P token is not armed with it" is false even for by-id: such a residue
    still physically holds the token, so `tombstoneIfNotSurviving` correctly keeps it live, and by-id arms X with both
    tokens. The test pins in-process === post-reboot for that shape instead.
  - The by-key route (`clearMergeQuarantine` on a resolvable path) withheld P's durable tombstone when X sat under
    P, with the new sweep disabled too, so it was not caused by this card. Fixed by card 1fb27e46; the order-a
    durable assertion now covers the path, recorded and token routes.

## Hash derivation

`PendingUnresolvedQuarantine.sourceFile` is typed `string`, so "no sourceFile" means "basename that does not match
`<stem>.json[.tmp-*]`"; that case falls back to the hash Loom would write for the canonical key (tested with a pushed
`odd-unmatched-name.dat`). Multi-entry dedupe is tested for distinct and shared stems; dedupe itself is only
observable as result equivalence. Running the cross-hash part once rather than once per hash was NOT done: the
cross-hash loop treats another entry's own-hash tmp as foreign content, so which call carries `freedKeys` would change
what a sibling hash's tmp is classified as; not a small change.

## Mutant evidence (`negative-control --mutant`, each RED from its own site's mutant)

Every run: `green=pass restore=verified => OK`; RED class BEHAVIOURAL.

| Site / route | Mutant | Failing assertions |
|---|---|---|
| `tryClearMergeQuarantineByOwnIdentity` (recorded path) | sweep called with `[]` | 17 |
| `clearTokenFromPendingIndices` (token) | sweep called with `[]` | 7 |
| `clearMergeQuarantineByKey` pending loop (by-path) | loop's sweep gated off | 6 |
| `freedKeysForClearedPendingEntries` | rule gated off (also run with the cdcd55c2 test) | 35 |
| `ownLatchHashForClearedPending` | canonical-key fallback removed | 1 (HASH-FALLBACK) |
| recorded-path ordering | sweep moved before the tombstone, `kept` folded into `pendingAnyKept` | 1 (ORDER recorded order-a) |

## Verified / not covered

- Test: `merge-quarantine-7aa9c406-pending-clear-routes-cross-hash-residue.mjs` — per route (path, recorded,
  reporting, token): MAIN (in-process === reboot), R-OCCUPIED-NEG (R's bytes unchanged), SCOPE-NEG,
  UNRESOLVABLE-NEG, TIER4; plus ORDER, HASH-FALLBACK and MULTI-ENTRY.
- Not covered: the same-hash branch for a pending entry whose `sourceFile` is a `pending-<hex>.json` divert has
  no dedicated scenario; it runs through the shared, already-tested sweep.
