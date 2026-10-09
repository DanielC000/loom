# 64283e06 — sync the armed twin when a pending raise merges a token

From Code Review `d6f37fcb` (round 3 of `d4b25feb`, MERGEABLE) — four non-blocking findings, none of
which fails open or produces a false clear. Reproduced and re-verified by this card's own worker before
any fix was written; current line numbers cited below, the card's own stale line numbers are not reused.

## Finding 1 — `mergeTokenIntoPendingEntries` never synced the active-side twin

`enterMergeQuarantine`'s `!verified` pending-merge branch routes a second (or later) unverified raise
through `mergeTokenIntoPendingEntries`, which splices the matched pending entry/entries out and pushes a
brand-new `merged` object — but never touched `activeQuarantines`. When the matched entry is ALSO an
`883e29bc` boot-diverted TWIN (the SAME object reference armed in `activeQuarantines` AND present in
`pendingUnresolvedQuarantines`), the active side was left pointing at the stale, pre-merge object.
`listActiveMergeQuarantines` then reported the identity twice: one stale (active), one merged (pending).

**Fix:** after building `merged`, route every one of `matched`'s entries through the existing
`replaceEntryEverywhere(activeQuarantines, m.entry, merged)` chokepoint (`fd189d91`/`d4b25feb` round 3's
own shared chokepoint for exactly this class of bug) before returning.

## Finding 2 — the identity invariant, and its own test, both missed the real twin shape

`assertQuarantineIdentityInvariantTestOnly`'s 2-object rule required the "active" side of the pair to be
active-ONLY (`aActive && !aPending`) — but an `883e29bc` twin is BOTH active and pending by reference, so
the real post-reboot "one twin + one independent pending entry" shape was wrongly flagged a violation.

**Fix:** relax the rule so a twin still counts as the "active" side —
`(aActive && bPending && !bActive) || (bActive && aPending && !aActive)` — dropping the `!aPending`/
`!bPending` requirement on whichever side is being treated as active; the OTHER side must still be
pending-ONLY.

The test scenario `identity-invariant-accepts-two-legitimate-rejects-overlap`
(`test/merge-quarantine-unverified-raise-divert.mjs`) had two separate problems, both fixed:
- Its "legit" half built two wholly SEPARATE objects (active-only + pending-only, never a twin), so it
  passed regardless of whether the invariant treats a twin as active — it never exercised the real bug.
- Its "overlap" half reused the SAME identity/`MERGE_QUARANTINE_DIR` as the legit half without clearing
  residue, so its own fresh boot read 4 on-disk files for that identity (not 2) — the `list.length === 2`
  branch never ran, so deleting `&& !tokensOverlap` from the invariant stayed green against it (a vacuous
  control).

Both are fixed with a genuine, own-fixture TWIN (manufactured the same way
`partial-clear-syncs-armed-twin-across-reboot-and-remount` does — a final at `hash(Kx).json` with
`resolvedKey: Kx`, boot-diverted) plus a wholly independent, separately-manufactured pending file sharing
the same identity, disjoint tokens — proven accepted, then mutated (the twin's own final rewritten to also
carry the independent entry's token) to prove the overlap clause is load-bearing on this SAME two-object
fixture, not merely satisfied by a population-count side effect.

## Finding 3 — `clearMergeQuarantineLatchFile`'s active-match branch claimed unqualified success

Its active-match branch called `clearMergeQuarantineByKey` then returned `liftedRepoPaths:
[activeMatch.entry.repoPath]` unconditionally. `clearMergeQuarantineByKey` already lifts every key an
entry is armed under (not the gap), but `d4b25feb`'s own "two independent raise-groups" shape (one repo,
raised once while resolvable — active — then again later while unresolvable — an independent pending
entry) means clearing the ACTIVE entry's own latch id can leave the SAME identity still quarantined via
its own separate pending record, which `clearMergeQuarantineByKey`'s pending-sweep deliberately does NOT
touch (it is genuinely independent, not tied to the entry being cleared — `d4b25feb` round 2's own fix). A
human reading `liftedRepoPaths:[X]` would wrongly conclude X is free.

**Fix (Lead ruling — the "leave it out" shape, not an overloaded `latchKept`):** after the clear,
re-resolve via `resolveQuarantineFor(activeMatch.entry.repoPath)` (mirroring
`clearMergeQuarantineReporting`'s own before/after pattern). If the SAME identity is still quarantined,
`liftedRepoPaths` leaves that repoPath OUT, and the response instead carries `stillQuarantined: true` plus
a `reason` naming the remaining record and the `/clear-by-path` remedy — reusing the message-building logic
factored out of `clearMergeQuarantineReporting` into the new shared `stillQuarantinedReason(after, before)`
helper, so the two routes can never disagree about how this is worded. `latchKept`/`referencingRepoPaths`
keep their EXISTING, unrelated meaning ("a physical file survives on disk because another entry still
needs it") — `stillQuarantined` is a distinct field for a distinct fact. The `/internal/merge-quarantine/
clear-by-id` REST route (`gateway/server.ts`) forwards both new fields through unchanged otherwise.

If `after` resolves to a DIFFERENT identity (e.g. a sibling genuinely sharing the same key once X's own
record is lifted), `liftedRepoPaths` still includes X — X's own record WAS lifted; the caller is merely
now blocked, if at all, by someone else's unrelated quarantine. Only the SAME-identity case excludes X.

## Round 2 (Code Review `3439677b` on `b5d1238e`) — all four Round 1 rulings met; three fold-ins before merge

**Item 1 — the MIRROR of finding 3, in the PENDING-match branch.** The pending-match branch had the
IDENTICAL bug, reached from the other side: it returned `liftedRepoPaths: matchedPending.map((p) =>
p.entry.repoPath)` unconditionally. Repro: `t1 = enter(X)` while resolvable (active), park `X`, `t2 =
enter(X)` (an independent pending raise, per `d4b25feb`'s "two independent raise-groups" shape),
clear-by-id with `t2`'s own PENDING id ⇒ `liftedRepoPaths:[X]` while `X` is still blocked by `t1`'s own
active entry. **Fix:** after the sweep, re-resolve EACH distinct identity among `matchedPending`'s own
entries (never just one — `matchedPending` can span SEVERAL claimants, card `882d6cff`'s multi-claimant
shape, several unrelated repoPaths sharing one physical file/id) via the SAME `resolveQuarantineFor` +
same-identity check the active branch uses; a repoPath whose identity is still blocked is dropped from
`liftedRepoPaths` and its own `stillQuarantinedReason` is collected (joined with every other still-blocked
reason, if more than one — the rare multi-claimant case).

**Item 2 — a route-level inject test for `POST /clear-by-path {id}`.** Section (AC) in
`test/merge-quarantine-clear-by-path.mjs` asserts `stillQuarantined`/`reason` are actually forwarded over
real HTTP by the gateway route, not just computed by the function — mirroring (Z1-route)'s own proof for
`latchKept`/`referencingRepoPaths`. Verified by hand that dropping the route's own conditional spread
(`...(result.stillQuarantined ? {...} : {})`) fails exactly this test's two new assertions and nothing
else, then restored byte-identical.

**Item 3 — the active branch was discarding `clearMergeQuarantineByKey`'s own `{latchKept,
referencingRepoPaths}`.** Captured into `activeClearResult` and spread onto BOTH of the active branch's
own return shapes (the `stillQuarantined` one and the ordinary success one) — the same few-line shape the
pending branch already had; no record-only deferral was needed.

The multi-claimant-on-disk follow-up (several matched pending entries genuinely sharing ONE physical
file, each needing its OWN independent re-resolve verified by a dedicated fixture) is tracked as its own,
separately-boarded card — not addressed here beyond the general per-identity loop above, which already
handles it correctly in principle; only its OWN dedicated test fixture is deferred.

## Finding 4 — `clearPendingEntryByToken`'s twin-sync block is provably unreachable today

`clearPendingEntryByToken` has exactly one caller: `clearMergeQuarantineByToken`'s fallback, reached only
after (1) the fast path at the freshly-computed key misses, AND (2) an identity-scan over EVERY entry in
`activeQuarantines` (matching the SAME `directPathIdentity`+`token` predicate) also misses. Since
`clearPendingEntryByToken` only matches a pending entry by that identical predicate, any pending entry it
could match that is ALSO an active twin (same object reference, hence the same `tokens` array) would
necessarily have already been caught by (2) first. `clearPendingEntryByToken` is also module-private — no
other call site exists anywhere in `packages/daemon/src`.

**Resolution (Lead ruling — justify in place, no deletion):** a short comment at the twin-sync call site
(the `replaceEntryEverywhere(activeQuarantines, pending.entry, updated)` call, plus the per-key write loop
immediately after it) states the reachability argument and explicitly forbids removing the routing on
that basis — matching `fd189d91`'s own "ROUTED, DEFENSIVE" posture for its Phase 2/3 sites (no known
caller reaches them today either, kept anyway as a structural backstop against a future caller or a future
change to the identity-scan silently reopening the bug class).

## Also fixed in passing

`d4b25feb`'s own decision record was checked for the mis-citation flagged in this card's checkpoint
report — **on closer reading, no mis-citation exists**: every citation of
`identity-invariant-accepts-two-legitimate-rejects-overlap` in that record (its own Verification section)
already correctly names `test/merge-quarantine-unverified-raise-divert.mjs`. The checkpoint's claim was
this worker's own error, not a real doc defect; retracted here rather than "fixed" with a no-op edit.

## Do not

- Do not rewrite only the pending side of a merge/split at a site that can reach an `883e29bc` twin —
  route every entry being replaced through `replaceEntryEverywhere`, never a hand-rolled partial update.
  This is the SAME rule `fd189d91`'s own "Do not" list already states; finding 1 is a case that rule's own
  author didn't yet know existed when writing it.
- Do not require the "active" side of `assertQuarantineIdentityInvariantTestOnly`'s 2-object rule to be
  pending-FREE — a twin (active AND pending, by reference) is still legitimately "active" for this rule;
  only the OTHER object must be pending-only.
- Do not trust a test's own "ACCEPTED"/"REJECTED" verdict without checking it actually reads the object
  count and shape you think it does — both of this scenario's original halves passed for reasons unrelated
  to what they claimed to prove (see Finding 2 above). Re-derive the actual on-disk file count/shape at
  boot time for any fixture reused across two sub-checks in a single scenario, rather than assuming no
  residue carries over.
- Do not let `clearMergeQuarantineLatchFile`'s active-match branch — OR its pending-match branch; both
  had the IDENTICAL bug, found in two separate review rounds — report a bare `liftedRepoPaths` without
  re-resolving. The SAME identity can still be quarantined by its own independent record (active OR
  pending) even after its matched latch is gone. Re-resolve EVERY matched identity, mirroring
  `clearMergeQuarantineReporting` — the pending branch specifically must not assume a single re-resolve
  covers it, since `matchedPending` can span several distinct identities at once (card `882d6cff`).
- Do not overload `latchKept`/`referencingRepoPaths` to mean "the identity is still quarantined" — that
  field means "a physical file survives on disk"; use the separate `stillQuarantined`/`reason` fields.
- Do not hand-roll a SECOND "still quarantined, here's why, here's the remedy" message at a new call
  site — call the shared `stillQuarantinedReason(after, before)` helper, or the wording can drift between
  `clearMergeQuarantineReporting` and `clearMergeQuarantineLatchFile` the next time either one changes.
- Do not remove `clearPendingEntryByToken`'s twin-sync routing on the grounds that it is unreachable
  today — it is unreachable ONLY because the caller's own identity-scan happens to catch any twin first;
  removing it reopens the bug class the instant that scan, or this function's own caller set, changes.

## Verification

New/modified scenarios in `test/merge-quarantine-unverified-raise-divert.mjs`:
`twin-sync-on-second-unverified-raise` (finding 1, manufactured twin + a second unverified raise, ≥3
reboots); `identity-invariant-accepts-two-legitimate-rejects-overlap` (finding 2, rewritten — a genuine
twin+independent-pending shape proven accepted, then mutated to an overlap and proven rejected, on the
SAME 2-object fixture); `clear-by-id-leaves-independent-pending-quarantined` (finding 3 — active entry +
independent pending entry, clear-by-id on the active one, assert `stillQuarantined`/`reason` and that a
direct query still refuses); `clear-by-pending-id-leaves-independent-active-quarantined` (round 2 item 1's
own mirror — clear-by-id on the PENDING entry this time, independent active entry survives; note the
remaining blocker there is ACTIVE, not pending, so the assertion uses `assertRepoNotQuarantined` rather
than `activeMergeQuarantineFor`, which has no tier that finds an unresolvable path's own active entry by
identity — only `resolveQuarantineFor`'s `ownIdentityEntryFor`, reached via `assertRepoNotQuarantined`,
does). New section (AC) in `test/merge-quarantine-clear-by-path.mjs` — round 2 item 2's route-level inject
test for `POST /clear-by-path {id}`, proving `stillQuarantined`/`reason` are forwarded over real HTTP.

`pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/merge-quarantine.ts --file
packages/daemon/src/gateway/server.ts --test packages/daemon/test/merge-quarantine-unverified-raise-divert.mjs`:
RED on `HEAD` (round 1 — exactly the 3 new/modified scenarios fail, at exactly the assertions each finding
predicts — every other scenario stays green), GREEN restored, tree confirmed byte-identical after.

`pnpm --filter @loom/daemon negative-control --file packages/daemon/src/git/merge-quarantine.ts --test
packages/daemon/test/merge-quarantine-unverified-raise-divert.mjs --test
packages/daemon/test/merge-quarantine-clear-by-path.mjs`: round 2 — RED on `HEAD` (exactly
`clear-by-pending-id-leaves-independent-active-quarantined`'s two new assertions fail; (AC) stays green on
`HEAD` since it exercises the already-fixed active branch, not this round's pending-branch fix), GREEN
restored, tree confirmed byte-identical. Round 2 item 2's own route-forwarding claim verified separately,
by hand: temporarily dropping the gateway's `...(result.stillQuarantined ? {...} : {})` spread fails
exactly (AC)'s two `stillQuarantined`/`reason` assertions and nothing else in the file; restored
byte-identical (confirmed via `git diff`), rebuilt, reconfirmed green.

All 27 `merge-quarantine*.mjs` files re-run serially, each its own process, across BOTH rounds: all green,
`exit=0`. The 14 other test files outside that family calling `enterMergeQuarantine`/
`clearMergeQuarantine`/`deleteMergeQuarantineLatchByKey`/`assertRepoNotQuarantined` also re-run clean,
both rounds.
