# c93e9e7a — cross-pending-entry lifted-key union computed before any delete

_Split out of the former single `8db913e2` record by card `3608937e` so each record's injected Do-not extract fits the per-record cap; every section below is verbatim from it (pinned blob `2f1a55286d01`). The core record keeps the card's own rounds 1 and 3 and holds the index of every split-out record (rounds 2 and 4 of the card are in `sha:d529d42d`, record `d529d42d-raise-divert-rounds-2-and-4-chokepoint-union-and-in-memory-repoint.md`): `8db913e2-raise-diverts-instead-of-overwriting-a-kept-occupant.md`._

## Follow-up c93e9e7a — cross-pending-entry lifted-key union computed before any delete

Two same-identity pending twins both armed (via `armedKeys`) at a key `Kb` outside the active entry's own
`keysToLift`: each of `clearTokenFromPendingIndices`, `clearMergeQuarantineByKey`'s pending filter, and
its own active `keysToLift` loop recomputed `ownedArmedKeys`/`liftedKeys` via `entryStillOwnsKey` against
the LIVE `activeQuarantines` map — read AFTER an earlier-processed twin's own iteration (in the SAME
clear) had already deleted `Kb`. The later twin's own narrower set then let a foreign occupant X,
co-located at the twin's own OTHER genuinely-owned key, wrongly RETAIN `resolvedKey: Kb` even though `Kb`
was genuinely lifted this same call — fail-closed reboot resurrection of an innocent third-party repo
whose own canonical key IS `Kb`. `clearMergeQuarantineByRecordedPath`'s own `matchedPending` sweep had the
identical shape, transitively through delegation.

**THE FIX:** each site computes `L`, the full lifted-key union, ONCE before any delete — the active
entry's own `keysToLift` plus every tied pending twin's own pre-delete-snapshot-owned armed keys (a twin
that 64119847's path REDUCES contributes nothing) — then threads that SAME `L` into every subsequent
protect/exclude call, including the active loop itself (round-2 MAJOR 2: it used to miss a key only a
tied pending twin owned). `clearMergeQuarantineByKey` gained an optional `externalLiftedKeys` param so
`clearMergeQuarantineByRecordedPath` can compose its OWN outer union (computed before any delegated call)
into each one. Deliberately NOT a global deferred finalize across the whole operation (an earlier,
unmerged WIP design) — that over-unblocked two distinct foreign occupants sharing one stale key.

Tests: `merge-quarantine-c93e9e7a-cross-entry-liftedkeys.mjs` — 11 scenarios, including a one-twin
negative control, the active-loop-union case, a 64119847-reduced-twin interaction, a no-over-unblock
control, the two-distinct-foreign-occupant regression guard, and (round 2) `recorded-path-threading-pin`.
RED on the unmodified file via `negative-control`; per-site RED confirmed for the ByKey pre-pass,
`clearTokenFromPendingIndices`, and the ByRecordedPath delegated-call threading, each reverted alone —
GREEN, byte-identical restore, every time. All 51 `merge-quarantine*.mjs` (+
`batch-merge-quarantined-not-cached.mjs`) run serially, exit 0, both env states.

**ROUND 2 (Code Review `89aa6630`):** production code CONFIRMED CORRECT, no over-unblock (reduced twins,
3+ occupants, error paths, Q2 all probed) — zero behavior change this round. Two test gaps, both fixed:

1. `twin-twin-by-recorded-path`'s own KNOWN GAP (a pending twin tied via `subsetOfClearedTokens` is, by
   construction, redundant with `clearMergeQuarantineByKey`'s own internal completeness) is real and
   stays — but `recorded-path-threading-pin` (new) closes it from a DIFFERENT angle: W (armed only at K,
   its own physical file holding foreign X) and P (pending, DISJOINT tokens, its OWN separate active
   match at Kq) are structurally UNTIED to each other, so only the OUTER `activeLiftedKeys`/`L` — built by
   scanning every matched active entry, including P, before delegation — carries Kq into W's own delegated
   call. Removing `, L` from the `clearMergeQuarantineByKey(m.key, m.repoPath, L)` call site now turns
   this scenario RED (confirmed); nothing else moves.
2. The original `pure-pending-by-token` armed its own P1/P2 directly, making them their own `activeMatches`
   and routing them through `clearActiveEntryTokenAtKey` — never reaching `clearTokenFromPendingIndices`
   at all; the comment claiming otherwise was false. Rebuilt per the CR's own construction: a REAL active
   entry O (never the twins themselves) owns the shared keys, so the pure-pending twins reach
   `clearTokenFromPendingIndices` directly. Reverting only that function now turns this scenario RED
   (confirmed); nothing else moves.

Also this round: `clearTokenFromPendingIndices` now caches ONE plan per index (reduce-or-remove, pre-pass
and mutating loop reuse it) instead of deriving the decision twice, mirroring `clearMergeQuarantineByKey`'s
own `pendingPlan`. `entryStillOwnsKey`'s optional map parameter was removed (every caller relied on the
default; no caller needed it).

**Two sub-mechanisms in `clearMergeQuarantineByRecordedPath` are honestly redundant, not load-bearing on
their own:** the pending-owned contribution to the outer `L` (every identity-matched pending entry's own
armed keys, unioned in before delegation) and the matchedPending loop's own reuse of that pre-delegation
snapshot (`pendingOwnedArmedKeys.get(p)`, never a live recompute). The CR found removing either turns
nothing RED, and the reason is structural, not merely untested: `entryStillOwnsKey` can only ever report
ownership of a key that something currently occupies in `activeQuarantines`, and anything occupying a key
under this SAME identity is unconditionally discovered by the `matched` active-entry scan too — so
whatever either mechanism would contribute to `L`, `clearMergeQuarantineByKey`'s own internal pre-pass (fed
by the pre-existing `activeLiftedKeys`) already computes independently once delegated. Kept, not removed,
this round: they were part of the original design spec, cost nothing at runtime, and offer defense-in-depth
against a future change to that invariant — but the record states plainly they are not independently
proven necessary by any current test, and neither should be cited as such.
