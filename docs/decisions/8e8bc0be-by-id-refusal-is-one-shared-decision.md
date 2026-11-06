# 8e8bc0be — the by-id refusal is ONE shared decision; a route id is offered only if the clear would follow it

Follow-up to `b6f573cf`, whose `latchIdIsAmbiguousActiveVsPending` mirrored only the clear's
active-vs-different-identity-pending refusal. It skipped the sibling / contributor / unknown-provenance
refusals (`ambiguousIdentitiesFor`), the pending-contributor / unknown-provenance refusal, and the clear's
re-ingest of a bare placeholder (which runs BEFORE every one of those checks). A route builder could therefore
offer an id the clear refuses — a dead id, never a wrong lift (the `{repoPath}` route is always present).

## Design

- `byIdClearRefusalFor(id, view)` is a PURE decision over `{activeMatch, matchedPending}` passed in. It returns
  `ambiguous-active | active-vs-different-pending | pending-contributor-or-unknown | undefined`.
  `clearMergeQuarantineLatchFile` calls it on its live, already-re-ingested state and only WORDS the result, so
  the clear's behaviour is unchanged (every existing merge-quarantine test stays green).
- Every route-id builder goes through `followableIdOrUndefined` -> `routeIdWouldBeRefused(id)`, which asks the
  same core twice: on the current entries, and on the purely computed reconciled copies
  (`reconcileClearedEntryIfPlaceholder` returns a new object and touches no map), both against the LIVE maps —
  no shadow state. EITHER refusing omits the id.
- The core reads no entry by reference identity. The reference-identity helpers
  (`selfClearRefusesForStaleKeyContributors`, `liveArmedKeysOf`, `entryGenuinelyOwnsALiveArmedKeyOfItsOwn`)
  appear only in the clear's reason TEXT, never in the decision, so none needs to accept a reconciled copy.
- Re-ingest cannot change a placeholder's `directPathIdentity` (`reconcileClearedEntryIfPlaceholder` returns
  the entry unchanged otherwise); it CAN change contributors / `provenanceUnknown`, which is why both views are asked.
- The two reason-TEXT sites that name a `{id}` (`stillQuarantinedReason`, `assertRepoNotQuarantined`'s ordinary
  branch) also ask `routeIdWouldBeRefused`; the ambiguity count alone misses b6f573cf's shape (Y active with
  absent subdirs pending at the same file: no sibling or contributor, yet the by-id clear refuses it).
- `foreignKeyStampNeeded` is the decision half of `preClearForeignKeyStamp`; the write half is the part that can fail.

## Invariant

A route id is handed out ONLY if the clear would follow it. The converse (every followable id is handed out) is
deliberately NOT guaranteed: the conservative either-view rule can omit an id the clear would have followed.

## Named residual (not modelled)

`preClearForeignKeyStamp`'s durable write can fail at runtime, giving `ok:true, refusedBeforeClear, lifted:[]`
(a no-lift). No predicate can foresee a write failure, so such an id can still be offered. "Followable" in tests
means `lifted` OR `released` non-empty: a released-but-still-blocked result counts as followable.

## Do not

- Re-copy any part of the refusal logic into a route builder; extend `byIdClearRefusalFor` instead.
- Add a decision input that reads an entry by reference identity (it would be wrong on the reconciled copy).
