# 8a1bc2ef — absorb a cross-tier sibling pending entry at every site that arms a key, and fold a per-file unlink failure on graduation success

From Code Reviewer `638ee0bc`'s review of `188b145f` (see
docs/decisions/188b145f-graduate-every-same-identity-pending-entry-at-once.md) — two pre-existing defects
that review found but explicitly left out of scope. Both fail CLOSED (a repo stays, or becomes,
quarantined when it shouldn't), never open.

## Item 1 — cross-tier stranding

Two SEPARATE registered repo paths bound to ONE physical repo (card `7673d096` — e.g. a project at a
repo's toplevel `R` and another at one of its subdirs `R/teamA`) collapse onto the SAME
`canonicalRepoLockKey` once both resolve, but each keeps its OWN `directPathIdentity`.
`activeMergeQuarantineFor`'s three-tier match cascade (and `enterMergeQuarantine`'s own, narrower
identity-only match) matches a pending entry by IDENTITY, never by key — so once ONE of the two siblings'
own pending entry graduates/arms a key, nothing ever goes back and looks for the OTHER sibling's own
still-pending entry sharing that exact key.

Reproduced at FOUR separate call sites — every place an entry can become armed/returned under a key:

1. **`activeMergeQuarantineFor`'s lazy-graduation tail** (the original card `188b145f` shape, now
   generalized): `activeMergeQuarantineFor(R/teamA)` graduates only `R/teamA`'s own pending entry (it
   matches at tier 1, its own identity). `R`'s own, separate pending entry — a DIFFERENT identity sharing
   the same key — is left stuck in `pendingUnresolvedQuarantines` forever: every LATER query for `R`
   hits the `direct` fast path (next item) and never looks at pending again.
2. **`activeMergeQuarantineFor`'s `direct` fast path**: once `R/teamA` has graduated and armed `key`, a
   query for `R` (or vice versa) hits `activeQuarantines.get(key)` and returns that object AS-IS,
   immediately — `R`'s own token stays invisible on both the subdir's armed entry and any later direct
   query for `R` itself. `clearMergeQuarantine(R/teamA)` lifts the armed entry but leaves `R`'s own
   pending entry untouched (different `directPathIdentity`, so `clearMergeQuarantineByKey`'s identity-
   scoped pending filter doesn't match it) — so `activeMergeQuarantineFor(R)` reads quarantined AGAIN on
   the very next query, right after a clear.
3. **`enterMergeQuarantine`'s pending-merge branch / its "brand new entry" fallthrough**: a RAISE directly
   on `R`, while `R` has no pending entry of its own (only `R/teamA` does), falls straight to the "brand
   new entry" branch — which never looks at `pendingUnresolvedQuarantines` at all. Same stranding, reached
   through a raise instead of a query.
4. **`enterMergeQuarantine`'s `existing` branch**: once `R` is armed (by any of the above), a SECOND raise
   on `R` hits `activeQuarantines.get(key)` truthy and only appends a token — it never looks at
   `pendingUnresolvedQuarantines` either, so `R/teamA`'s own sibling pending entry is never absorbed even
   by a subsequent raise.

### Fix

A new, module-local `collectCrossTierSiblingIndices(key, excludeIndices)` selects every
`pendingUnresolvedQuarantines` index (outside `excludeIndices`) whose own path currently resolves and
whose `canonicalRepoLockKey` equals `key` — the SAME tier-3 predicate `activeMergeQuarantineFor`'s own
cascade already trusted for graduation, now applied at all four sites above. It only SELECTS indices;
every call site still routes the result through the existing, ONE shared `consumeMatchedPendingsIntoArmedEntry`
helper (card `188b145f`) — there is no second splice/union copy anywhere.

`consumeMatchedPendingsIntoArmedEntry` itself needed one generalization to make this safe: `armedKeys` is
now UNIONED (`[...new Set([...(unioned.armedKeys ?? []), key])]`) and the final armed object is set at
EVERY one of those keys, never overwritten to `[key]` alone. For the helper's two PRE-EXISTING callers
(the lazy-graduation tail, and the pending-merge branch's own matched-pendings-plus-fresh-raise union),
this is byte-identical — a bare pending entry or a fresh-raise `extra` never carries its own `armedKeys`.
But `extra` can now ALSO be an ALREADY-ARMED entry passed in by a cross-tier absorption at the `direct`
fast path or `enterMergeQuarantine`'s `existing` branch, and that entry CAN be genuinely dual-armed (PASS
1/1b, decision `54054c01`) — discarding its other key here would leave that other slot pointing at a
stale object forever.

Matching stays by KEY equality, never a wider net — two pending entries for genuinely unrelated repos
(different canonical keys) are never cross-absorbed; proven directly by a dedicated negative-control
scenario.

### Round 2 (Code Review) — CRITICAL: round 1 never verified the RECEIVER, only the sibling

Round 1's fix (above) checked that the SIBLING genuinely resolves to `key` — but never checked that the
entry RECEIVING the absorption (`direct` at the `direct` fast path, `existing`/`entry` at the `existing`
branch) is itself verified to BE the repo at `key`, as opposed to merely OCCUPYING `key` via PASS 1's own
degraded dual-arm fallback (its own `repoPath` unresolvable at boot, so `canonicalRepoLockKey` walked up
to an ENCLOSING repo and dual-armed there — see `reenterMergeQuarantinesAtBoot`'s PASS 1 migrate-else
branch).

Reproduced: `R` is a repo; `X = R/nested` is its OWN SEPARATE repo (own `.git`, own real key `Kx`); `T =
R/teamA` is a plain subdir of `R` (collapses onto `R`'s own key like every other sibling in this file). At
boot, BOTH `X` and `T` are unresolvable. `X`'s latch carries a recorded `resolvedKey` (`Kx`), so PASS 1
dual-arms it under BOTH its degraded, walked-up key (which lands on `R`'s own real key, since `X`'s
nearest existing ancestor once `X` itself vanishes is `R`) AND `Kx`. `T`, a pre-upgrade latch with no
`resolvedKey`, goes genuinely pending. `T` then becomes resolvable again WHILE `X` IS STILL UNMOUNTED. A
query for `R` hits `activeQuarantines.get(Rkey)` — `X`'s dual-armed entry — truthy. Round 1's own
`collectCrossTierSiblingIndices` check only verifies `T` (the sibling) resolves to `Rkey`, which it does —
so `T`'s genuinely separate, still-pending quarantine was silently merged into `X`'s entry (an entry that
is NOT verified to be `R`, or anything, right now) and its own pending record destroyed. A human then
clearing `X` (by its own recorded `Kx`, or by its recorded path) would silently lift `T`'s genuine
quarantine too — and it stays lifted after a restart, since `T`'s own durable record is already gone.

#### Fix

A new `isKeyVerifiedFor(repoPath, key)` — `isRepoPathCurrentlyResolvable(repoPath) &&
canonicalRepoLockKey(repoPath) === key` — gates every absorption INTO an already-armed/already-raised
receiver:

- The `direct` fast path only absorbs into `direct` when `isKeyVerifiedFor(direct.repoPath, key)`;
  otherwise it returns `direct` unchanged (today's pre-absorb, fail-closed posture — the sibling stays
  genuinely pending, exactly as it already was).
- `enterMergeQuarantine`'s `existing` branch only attempts the absorption when `isKeyVerifiedFor(
  entry.repoPath, key)`; otherwise it falls through to the ordinary token-append write, unchanged.
- `enterMergeQuarantine`'s pending-merge/"brand new entry" branch only computes `siblingIndices` at all
  when `isRepoPathCurrentlyResolvable(repoPath)` — `key` is computed FROM `repoPath` at the top of the
  function, so checking `canonicalRepoLockKey(repoPath) === key` there would be tautological; an
  UNRESOLVABLE `repoPath` is what makes that `key` a degraded, walked-up value never actually verified to
  be `repoPath`'s own.
- `activeMergeQuarantineFor`'s own lazy-graduation tail needed NO guard: by construction, it only reaches
  the graduation step once `first.entry.repoPath` — the winning tier's own match — has already been
  confirmed `isRepoPathCurrentlyResolvable`, and every one of its three match tiers only ever matches two
  paths that denote the SAME physical location as the original query, so `canonicalRepoLockKey(
  first.entry.repoPath)` already equals `key` by the predicates' own construction. This was verified by
  running the full scenario set — scenarios 1-5 are unaffected by this guard (none of their receivers are
  ever a degraded dual-arm), and the round-2 negative-control scenario (6, below) is RED on round 1's own
  commit and GREEN after.

Scenario 6 (`merge-quarantine-cross-tier-sibling-absorb.mjs`) reproduces the above directly, including the
clear-by-`Kx` step and a restart assertion. Proven RED against round 1's own commit (`c2df1ad5`, via
`negative-control --ref c2df1ad5`), GREEN after; scenarios 1-5 stay green on both, confirming the guard
doesn't regress the ordinary (non-degraded) absorption cases.

#### Scope correction (Code Review, round 2) — this closes IN-PROCESS absorption only, not boot-time union

**Do not read this fix as closing the cross-tier fail-open generally.** `isKeyVerifiedFor` gates only the
IN-PROCESS call sites (`activeMergeQuarantineFor`'s `direct` fast path, `enterMergeQuarantine`'s
`existing` branch and pending-merge branch) — it never touches `reenterMergeQuarantinesAtBoot`'s own PASS
1, which unions ANY two entries sharing a key via `armQuarantineKey` (~1296) with no equivalent
verification. If `X`'s own degraded, walked-up dual-arm latch and `T`'s own genuinely-verified latch are
BOTH present as separate on-disk files at the SAME boot (scenario 6's setup never reaches this — it
clears `X` in-process, through the now-guarded path, before any restart), PASS 1 unions them into ONE
entry at boot time exactly as it always has, with no distinction between "verified" and "degraded." A
human clearing `X` by its own recorded key in THAT state still lifts `T`'s genuine quarantine too, and it
stays lifted — the same consequence as the round-1 bug, reached through a restart/reload instead of a
live query. This is a separate, pre-existing PASS 1 defect, not fixed by this card; carded separately as
`883e29bc`.

## Item 2 — N-file partial unlink on a SUCCESSFUL graduation write

`consumeMatchedPendingsIntoArmedEntry`'s SUCCESS branch deletes every matched pending entry's own stale
`sourceFile` via `deleteSourceLatchIfSuperseded` — but that function swallowed unlink errors (EBUSY)
silently and returned nothing. If it failed on 1-of-N files during graduation, that stale file was left
on disk, UNTRACKED by anything: not folded into the armed entry's own `orphanLatchFiles` (only the
WHOLE-WRITE failure branch did that folding). A human `clear-by-id` on the real/fresh hash — the ordinary
clear a human would actually issue — correctly cleared the real entry, but had no way to know the stale
file existed, so it was left behind untouched. The NEXT boot then found this still-cleanly-parsing
leftover file and RE-ARMED the quarantine the human just cleared — fail-closed, the same class
`be79f4d5`/`9cabd143` exist to close, reached through a FOURTH shape (a per-file unlink failure on an
otherwise-successful write, rather than a whole-write failure).

### Fix

`deleteSourceLatchIfSuperseded` now reports success/failure instead of swallowing it: `true` for a
genuine success (deleted, a no-op skip because the name IS the fresh write target, or ENOENT — already
gone is not a problem) and `false` only when an unlink was actually attempted and failed. Any `false` is
folded into the armed entry's own `orphanLatchFiles` (deduped) and the entry is RE-PERSISTED via the
existing `writeMergeQuarantineLatch` — exactly mirroring the whole-write FAILURE branch's own fold. If
that re-persist itself fails, the surviving tmp stays able to re-arm the quarantine at the next boot — a
loud log names this explicitly; this is today's PRE-EXISTING safe (fail-closed, never open) posture for a
failed durable write, not a new risk this fix introduces.

The practical consequence: a clear-by-id on an UNRELATED stale hash now correctly KEEPS the surviving file
(it's referenced by the real entry's own `orphanLatchFiles`), while clearing the REAL entry now correctly
SWEEPS it away too (via `clearMergeQuarantineByKey`'s pre-existing `orphanLatchFiles` sweep loop) — closing
the fail-closed resurrection directly, rather than leaving the stale file to resurrect the quarantine a
human just legitimately cleared.

### Round 2 (Code Review) — MINOR: scenario 1's own restart assertion was weakened by its own earlier step

Scenario 1 clears by the STALE hash first (to prove that id-mismatched clear KEEPS the surviving file),
THEN clears the real/fresh hash and restarts. That earlier stale-hash clear step is itself what proves the
"kept" half of the fix — but it also means the surviving tmp was ALREADY swept away by the time the
restart assertion runs, from a DIFFERENT code path than the one the restart assertion is meant to be
proving. On the pre-fix baseline (commit `10beec69`, the commit before this card's round 1), scenario 1's
own restart assertion still PASSES — not because the fix is present, but because nothing in that specific
sequence needed it to discriminate by that point.

Fixed by adding scenario 3: the SAME graduation (one unlink injected to fail), but clearing the real/fresh
hash DIRECTLY — no stale-hash clear in between — then restarting. Proven RED against `10beec69`, GREEN
after.

### Round 2 (Code Review) — MINOR: restart-assertion discrimination is NOT a stable, reproducible per-scenario property

Measuring which scenario's restart assertions actually go RED against the pre-fix baseline (repeated
`negative-control --ref 10beec69` runs against the CURRENT, six-scenario `merge-quarantine-cross-tier-
sibling-absorb.mjs`) produced a DIFFERENT pattern on each of three consecutive, otherwise-identical runs —
e.g. one run showed scenarios 1 and 3's own "NO LOSS" restart check failing, the next showed 1 and 2, the
next showed 1, 4 and 5. Only scenario 1's "NO LOSS" restart check failed on all three runs; every other
scenario's restart-level result varied run to run. The IN-PROCESS (pre-restart) assertions inside each
scenario were stable and discriminating on every run — this volatility is confined to the restart
assertions specifically, even measured per-scenario in isolation (its own `LOOM_HOME`, one scenario per
process) — ruling out cross-scenario directory residue as the cause. **The real cause (Code Review, round
2, carded separately as `4480b077`): `reenterMergeQuarantinesAtBoot`'s PASS 1 migrate branch (`if (writeMergeQuarantineLatch(entry)) {
deleteSourceLatchIfSuperseded(f, entry); }`) OVERWRITES whatever is already durably written at the
fresh-hash target instead of unioning with it** — the in-memory union (`armQuarantineKey`, several lines
later) happens AFTER this raw write, so it never corrects what just landed on disk. When two siblings
sharing one canonical key each have their OWN separate stale-keyed `.json` file at the SAME boot, BOTH
migrate to the IDENTICAL fresh-hash filename in the SAME `files` loop — whichever one's own
`writeMergeQuarantineLatch` call runs LAST wins, clobbering the other's file with its own content alone.
Test-fixture repo paths live under `os.tmpdir()` with a randomized suffix, so their hashes are
effectively random strings with no stable relationship to each other — `fs.readdirSync`'s own return
order for `MERGE_QUARANTINE_DIR` is what decides which of the two migrate calls runs last, and that order
is not guaranteed stable across runs. **Do not cite any one run's specific per-scenario restart-pass/fail pattern as a
stable fact** (this correction exists because an earlier draft of this record did exactly that, sourced
from a single, unrepeated run) — rely on the in-process assertions as the discriminating signal, and treat
a passing restart assertion on the pre-fix baseline as "did not happen to need it this run," never as "the
bug doesn't reach this far."

## Follow-up (not fixed here — boarded separately)

`reenterMergeQuarantinesAtBoot`'s PASS 1 migrate branch (`if (writeMergeQuarantineLatch(entry)) {
deleteSourceLatchIfSuperseded(f, entry); }`) ignores `deleteSourceLatchIfSuperseded`'s new boolean return —
the SAME per-file-unlink-failure fold this card's Item 2 added to `consumeMatchedPendingsIntoArmedEntry`
was never ported to this sibling call site. Found by Code Review in round 2; carded separately, not fixed
by this change. Do not assume Item 2's fix closes every `deleteSourceLatchIfSuperseded` call site in this
module — it closes the ONE this card's own repro reached.

## Do not

- Do not hand-roll a second splice/union/arm sequence at a FIFTH site that can arm a key in this module —
  route it through `consumeMatchedPendingsIntoArmedEntry`, selecting whatever extra indices it needs via
  `collectCrossTierSiblingIndices` (or a narrower predicate) first. That is the entire point of having one
  shared helper; round after round of `188b145f`/`be79f4d5` review found a NEW call site with its own
  hand-copied drift precisely because this discipline wasn't followed from the start.
- Do not assume `consumeMatchedPendingsIntoArmedEntry`'s `armedKeys` handling only ever needs `[key]` —
  an `extra` entry passed in from a cross-tier absorption at an ALREADY-ARMED site (the `direct` fast
  path, `enterMergeQuarantine`'s `existing` branch) can be genuinely dual-armed; the union-and-arm-at-
  every-key shape is load-bearing, not cosmetic.
- Do not match a cross-tier sibling by anything other than `canonicalRepoLockKey` equality (plus
  resolvability) — never by filename hash (9cabd143's own point: a hash can be shared by two unrelated
  repos) and never "any other pending entry at all" (would merge two unrelated repos' quarantines).
- Do not treat a per-file unlink failure in `consumeMatchedPendingsIntoArmedEntry`'s SUCCESS branch as
  equivalent to the WHOLE-WRITE failure branch's own semantics when reasoning about `clearMergeQuarantineLatchFile`'s
  response — the practical effect for the one SURVIVING stale file is the same (folded into
  `orphanLatchFiles`, swept once the real entry it protects is itself cleared), but the surrounding
  context differs: the fresh/real latch DOES exist on disk in this case, unlike the whole-write failure
  branch where it never does.
- Do not read `deleteSourceLatchIfSuperseded`'s new boolean return as "did I delete a file" — ENOENT
  (already gone) and the "this IS the fresh write target, nothing to delete" no-op skip both return
  `true`, same as an actual successful unlink; only a genuine, attempted-and-failed unlink returns `false`.
- Do not absorb a cross-tier sibling into an entry that merely OCCUPIES `key` — verify the RECEIVER too,
  via `isKeyVerifiedFor(receiver.repoPath, key)`, at every site that absorbs INTO an already-armed or
  already-raised entry (the `direct` fast path, `enterMergeQuarantine`'s `existing` branch). An entry can
  occupy a key via PASS 1's degraded dual-arm fallback without ever having been confirmed to actually BE
  the repo at that key (round 2, Code Review — see the nested-repo repro above). The lazy-graduation tail
  does not need this guard — its own match tiers already only match the SAME physical location as the
  original query, confirmed resolvable before graduation ever runs.
- Do not trust a single `negative-control` run's per-scenario restart-level pass/fail pattern as a stable
  fact about which scenario "discriminates" — measured NON-deterministic across repeated identical runs
  (round 2, Code Review). Only the in-process (pre-restart) assertions are a reliable signal for this.

Tests: `merge-quarantine-cross-tier-sibling-absorb.mjs` (item 1 — scenarios 1-4 for the four sites, 5 for
the cross-key negative control, 6 for the round-2 nested-repo/degraded-key receiver-verification guard,
each with a restart assertion) and `merge-quarantine-partial-unlink-fold.mjs` (item 2 — scenario 1 for the
fold+sweep+no-resurrection path, scenario 2 as its no-injection negative control, scenario 3 isolating the
clear-fresh-hash-directly restart assertion round 1's own scenario 1 had weakened).
