# 53d2c734 — `blockedCoOccupantForReferencer` matches its own entry by `directPathIdentity`, never a raw string

Found by `25d0d45b`'s round 5 carriage re-CR (PROBE-SPELLING scenario). Round 5 fixed
`classifyKeptRepoPath`'s own disposition (live vs. content-kept) to compare by `directPathIdentity`, but
left `blockedCoOccupantForReferencer`'s own-entry lookup at a raw string compare
(`e.repoPath === repoPath`) — deliberately, per that round's own ruling, so the MINOR fix stayed scoped to
disposition only. For a spelling variant of `repoPath` (a trailing separator, or case on win32),
`classifyKeptRepoPath` already reported `live:true` via its own `stillBlockedEntryFor` fallback (which
DOES use `directPathIdentity`), but every caller that builds the final `BlockedCoOccupant` route by
re-calling `blockedCoOccupantForReferencer` directly (never `classifyKeptRepoPath`'s own result) got back
a route with no working `{id}` — the `{repoPath}` form alone, which still works via clear-by-path but has
no id for a clear-by-id caller.

## Fix

`blockedCoOccupantForReferencer`'s own-entry `.find()` over `activeQuarantines`/`pendingUnresolvedQuarantines`
now compares `directPathIdentity(e.repoPath) === directPathIdentity(repoPath)` (both the active and
pending finds), the SAME canonical-identity contract `classifyKeptRepoPath` already uses — never Round
3's rejected "whatever entry blocks X" widening (`directPathIdentity` never walks up, so a subdirectory
ghost `X/ghost` still does not match `X` itself).

This is a single change inside `blockedCoOccupantForReferencer` itself; every call site
(`classifyKeptRepoPath`, `clearMergeQuarantineByKey`, `tryClearMergeQuarantineByOwnIdentity`'s orphan
fold, `clearMergeQuarantineLatchFile`) inherits the fix automatically, since they all call this one
function to build the route.

## Why the `excludeIdentities` self-reference risk does not reopen

The card's own investigation step asked whether a spelling-variant PENDING TWIN of the identity being
cleared could now be found by this widened match and handed back as "still blocked" (or re-armed). It
cannot, for two independent, pre-existing reasons — neither of which this fix touches:

1. **The two sweep functions already exclude by identity, not by string.**
   `sweepOrphanLatchFileIfUnreferenced`/`sweepTmpResidueForHashIfUnreferenced`'s own `excludeIdentities`
   parameter is checked via `excludeIdentities?.has(directPathIdentity(e.repoPath))` (and the pending
   twin), so a spelling variant of the clearing identity is excluded from `referencingRepoPaths`/
   `keptEntries` BEFORE it ever becomes an `rp` argument to `blockedCoOccupantForReferencer`. This was
   already identity-aware before this card; this card does not change it.
2. **Same-identity pending twins are folded into the SAME clear, never left as a "kept" co-occupant.**
   `clearMergeQuarantineByKey`'s own `pendingPlan` construction gates on
   `directPathIdentity(p.entry.repoPath) !== identity` (continue if different) — a pending twin sharing
   the clearing identity, any spelling, is processed (reduced or removed) as part of THIS clear, not left
   to surface via `r.kept`. `clearMergeQuarantineLatchFile`'s `matchedIdentities` set (built the same way,
   from `matchedPending`) plays the identical role for its own excludeIdentities calls.

So every `rp` that ever reaches `blockedCoOccupantForReferencer` is, by construction, already a DIFFERENT
identity (by `directPathIdentity`) from whatever is being cleared in that same call — before and after
this fix. Widening the own-entry lookup to `directPathIdentity` only lets it find that `rp`'s OWN entry
(previously missed on a spelling variant); it does not let it find the clearing identity's own entry,
because that identity is never among the candidate `rp`s in the first place.

## Do not

- Do not revert `blockedCoOccupantForReferencer`'s own-entry match back to a raw string compare — that is
  exactly the `53d2c734` PROBE-SPELLING gap this record closes.
- Do not read this fix as reopening Round 3's rejected "whatever entry blocks X" widening — this is a
  same-function, same-direction identity comparison (`repoPath`'s own entry), never a route to an
  independent identity's entry. `directPathIdentity` never walks up, so `X/ghost` still never matches `X`.
- Do not assume `excludeIdentities` needed a change here — it was already `directPathIdentity`-scoped
  (card `25d0d45b`); re-verify against the two mechanisms above before adding a new exclusion "to be safe".
