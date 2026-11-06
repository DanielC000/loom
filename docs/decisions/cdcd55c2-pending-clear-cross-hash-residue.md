# cdcd55c2 — a pending-tier clear-by-id arms cross-hash tmp residue that collapses onto a key it freed

Sibling of `f8e11853` (read `docs/decisions/f8e11853-freed-key-cross-hash-residue.md` first).

## The bug (run RED before any fix)

A PENDING entry P whose path is resolvable now (raised while unresolvable, repo materialised later) blocks
its canonical key through the pending tier (`activeMergeQuarantineForPeek` → `findPendingIndicesFor`, the
resolvable-by-key tier). X = `P/ghost` therefore reads as already-enforced, and an armable tmp residue of X
filed under an unrelated hash stays boot-deferred. `clearMergeQuarantineLatchFile`'s matchedPending branch
then dropped P, but its tmp sweep passed no `freedKey`, so only the `${id}.json.tmp-` prefix was examined:
in-process `stillBlockedEntryFor(X)` was `undefined` while a reboot from the same on-disk snapshot armed X.

## The fix

`sweepTmpResidueForHashIfUnreferenced`'s optional trailing parameter became `freedKeys: ReadonlySet<string>`
(only the relevance predicate widened — the whole f8e11853 selection/decision pipeline is reused, not
copied). `deleteMergeQuarantineLatchByKey` passes `new Set([key])`; the matchedPending branch passes the
keys its matched pending entries blocked, which mirror `findPendingIndicesFor`'s key tiers exactly:

- tier 1 (`directPathIdentity`) and tier 2 (`ancestorAwarePathIdentity`) match the entry's OWN path identity —
  no key is freed for a foreign path (own-identity residue stays content-kept via `matchedIdentities`);
- tier 3: a RESOLVABLE entry blocks `canonicalRepoLockKey(entry.repoPath)`;
- tier 4: an UNRESOLVABLE entry with `informativeKeysFor(entry).length > 0` (a 883e29bc divert) blocks
  `canonicalRepoLockKey(entry.repoPath)` — its degraded walked-up key — NOT its `resolvedKey(s)`.

So freed keys = `canonicalKeyOrUndefined(entry.repoPath)` when the entry is resolvable OR has informative keys; the
`resolvedKey(s)` themselves are never added (no pending tier consults them; a `resolvedKey` armed in
`activeQuarantines` is the active tier's business). The set is read from `matchedPending` after the entries are
dropped from `pendingUnresolvedQuarantines`; the entry objects are unchanged. A still-occupied key stays "already-enforced"
via `armForeignOrphanContentInMemoryIfUnenforced`'s own gate. The clearer's own identity stays excluded
(`matchedIdentities`) → content-kept, never armed.

## Do not

- Do not copy the cross-hash loop into the pending branch; widen the key set only.
- Do not compute freed keys with a mutating lookup (`resolveQuarantineFor`/`activeMergeQuarantineFor`).

## Not covered (known siblings, filed as separate investigate-first cards)

- Other pending-tier clears pass no freed keys: `clearTokenFromPendingIndices` (token route) and the
  clear-by-path / recorded-path pending paths.
- `deleteMergeQuarantineLatchByKey` passes only the single armed `key`, not the entry's secondary `armedKeys`.
