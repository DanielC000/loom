# 1fb27e46 — the by-path clear re-derives a content keep blocked only by the leaving identity before it decides P's tombstone

Found by card 7aa9c406's round 2 (see `7aa9c406-pending-clear-routes-cross-hash-residue.md`). On the resolvable by-path route (`clearMergeQuarantine` -> `clearMergeQuarantineByKey`), when a foreign residue X sat under P (X's recorded repoPath is a subdirectory of P, so it collapses onto key(P)) and X's tmp residue was filed under an unrelated hash, P's durable tombstone was withheld. The recorded-path and token routes tombstoned P in the same shape.

## Cause (measured, not inferred)

`keptContentRepoPaths.size === 0` was the only failing clause of ByKey's push-time `nonFailureOk` (other parts logged: no write failure, no referencing keeps, no unattributed keep, the physical-record scan false). X entered that map from the active-key loop's `deleteMergeQuarantineLatchByKey` call (its trailing `sweepTmpResidueForHashIfUnreferenced` with `freedKeys`), which runs BEFORE the pending loop drops P's own pending entry. At that moment P's entry still enforced X's key, so X could not be armed and was classified content-kept, blocked by P. P was then removed and 7aa9c406's later sweep armed X, but the stale keep was never retracted, so the tombstone was skipped and the result listed X twice (a content keep blocked by the already-released P, and a still-blocked co-occupant).

## The fix

`retractContentKeepsBlockedOnlyByClearedIdentity` runs immediately before ByKey's single push-time `nonFailureOk`. It only RETRACTS (removes from the paired `keptContentRepoPaths` / `keptContentBlockedBy` maps); it never adds a keep or a withhold. An entry is retracted only when ALL hold: (a) `blockedBy` names the clearing identity; (b) nothing of that identity survives (`ownIdentityEntryFor`: own or contributor entry, active or pending); (c) the kept file is readable and holds none of the cleared tokens. Unreadable, unparsable, token-less, or blockedBy-less entries stay (fail-closed).

Clause (c) is load-bearing: `identityHasAnyPhysicalRecordHoldingToken` only matches files whose recorded repoPath is the clearing identity and skips tracked basenames, so a foreign residue that also holds a cleared token is invisible to it.

Placement: before the push, not in the deferred decider. The job carries one boolean, so the immediate path and the 14bdcb2f deferred path (including the `"none"` route) share one value. Shipping keep sets into `decideDeferredTombstones` would AND one site's foreign-keep signal into another site's decision (d2592cd5, 14bdcb2f). `deferred.writeFailed` is not touched.

If the later 7aa9c406 sweep cannot arm a retracted X (a surviving pending W still encloses it), the sweep re-adds X as a content keep from a fresh classification, blocked by W: X is disclosed exactly once.

The helper returns the retracted repoPaths so card 8596ddfb (a stale content-keep disclosure after a pending tmp sweep deletes the file) can reuse it.

## Do not

- Do not move the re-derivation into `decideDeferredTombstones` or pass keep sets into a job.
- Do not add a retraction rule that is not one of (a)-(c), and do not make the helper add a keep or a withhold.
- Do not feed a retraction outcome into `deferred.writeFailed`.
- Do not drop clause (c) because "the physical-record scan covers it": it cannot see a foreign residue.
- Do not touch `deleteMergeQuarantineLatchByKey`'s single-key / `armedKeys` handling here (card 119019d3).

## Verified

Test: `merge-quarantine-1fb27e46-by-path-tombstone-foreign-residue.mjs` (A order-a + result shape + reboot, B and B2 clause (c) incl. a pre-armed tracked X, C surviving twin, D re-add). Mutants via `negative-control --mutant` (each BEHAVIOURAL, green=pass, restore=verified): retraction disabled (A, result shape, D RED, 3 failures), clause (c) dropped (B, B2 RED), clause (b) dropped (C RED: X vanishes from the result while still blocked by the surviving twin), re-add disabled (D x2 RED).

What is the fix's own RED and what is a characterization: only A's tombstone line, A's result shape and D's tombstone line fail on pre-fix code. D's re-add assertions (disclosed once, blocked by W) also PASS on pre-fix code; they are a characterization kept honest by the re-add-disabled mutant. C's untombstoned-tokens line describes current behaviour, not a requirement.

Not covered: the recorded-path route tombstoning a token a tracked residue still holds (shape B on the recorded route) is a separate card.
