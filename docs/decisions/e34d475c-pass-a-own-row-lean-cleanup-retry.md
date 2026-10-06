# e34d475c — boot-reconcile Pass A retries an own-row's stuck worktree cleanup WITHOUT replaying its finalize bookkeeping

## Narrative

Two worker worktree dirs under one project's `.loom-worktrees` could never be removed (root cause
unidentified — read-only inspection found no symlinks/junctions/long paths/special attributes; Defender
real-time protection was on, consistent with but not proven as the cause). Because the dir never cleared,
Pass A's cheap early-out (`alreadyFinalized && !worktreeOnDisk`) never fired for either worker even though
each had a recorded `merge_done` for its own landing. Execution fell through on every boot to
`retireWorkerSession` + a full `finalizeMerge` call — `finalizeMerge` appends its `merge_done` event
UNCONDITIONALLY on every call (by design, for a genuine cross-row replay — see `@decision daaf7fc9`), so
this duplicated `merge_done` and `worker_retired` events forever (15+ times over 3+ days in the real
incident), re-ran the squash-lookup + `isBranchHeld` git subprocesses every boot for nothing, and — once
the branch ref itself had already been deleted by an earlier attempt — attempted a `deleteBranch` CAS
call against a ref with nothing left to delete.

`@decision 9ac3a739` (round 2, item 2) had previously made an own-row retry (`alreadyFinalized` true,
worktree still on disk) EXEMPT from the cross-row seq-check specifically so it would "always fall through
to the ordinary `finalizeMerge` call" — reasoning that this was safe because `finalizeMerge`'s own
`hadPriorMergeDone` guard already protects the task-column move, ship-state, and reingest. That reasoning
covered three of `finalizeMerge`'s four replay-sensitive effects — it did not cover the `merge_done`
append itself (left deliberately unconditional, by that same round's own documented LEAD) or
`retireWorkerSession`'s `worker_retired` append (called unconditionally right before `finalizeMerge`,
with no replay guard of its own). For a worktree that clears within a boot or two this was invisible; for
one that never clears, it replays forever.

## Fix, round 1 (WRONG — corrected below, kept here so the mistake isn't silently erased)

The first attempt gave the own-row retry its OWN standalone lean path, inserted BEFORE the squash lookup
(reasoning: an own-row `merge_done` is already definitive proof the landing happened, so neither the
trailer re-scan nor the hold check should be needed) — doing a bare `gcWorktreeDir` + a cheap
ref-existence-checked `deleteBranch`, with NO tip-guard at all.

**This was a real correctness regression**, caught by `worktree-recycle-alias-protection.mjs`'s own
fixture J: a SUCCESSOR row with its own recorded `merge_done` whose shared branch had a LATE COMMIT land
on it after that recording (the exact race `@decision cc9bce38`/`42daa283`/9ac3a739 round 3 item 3 exist
to protect against) — the standalone lean path blindly removed the worktree and deleted the branch,
destroying the late commit, because it never checked the live tip against anything. An own-row
`merge_done` being recorded does NOT mean no later commit can ever land on that same checked-out branch
before the worktree is actually removed — the fixture models exactly the scenario where a prior real
finalize call recorded `merge_done`, began removal, and was interrupted (crash) before completing it,
while a stray still-alive process made one more commit on the shared branch in that window.

## Fix, round 2 (ACTUAL FIX — what shipped)

Own-row and sibling-row "already finalized" are now treated as ONE condition, sharing the EXISTING,
already-tip-guarded cleanup-only path (the one round 2/3 of `@decision 9ac3a739` built for the sibling
case): `if (alreadyFinalized || finalizedElsewhere) { ... }`, run AFTER the squash lookup + `isBranchHeld`
(never before — the fresh squash lookup's `paLooked.landedTip`/`branchGone` is exactly what the tip guard
needs, and there is no cheaper substitute for it without inventing a new persisted field, which round 1
of `9ac3a739` itself already declined to do without clearing it with the project owner/manager first).
`alreadyFinalized` is ORed in (never AND'd) so it can never be false-negatived by an unrelated newer
`merge_request` on the same branch the way the bare cross-row seq comparison alone could (e.g. a re-task's
own later request still pending).

This squanders the round-1 attempt's git-subprocess-avoidance optimization (the squash lookup/`isBranchHeld`
now DO run for an own-row retry, same cost as before this card) — a deliberate trade: correctness (the
tip guard) over that one cost reduction. The duplicate-event bug (the actual incident) is still fully
fixed, since `retireWorkerSession`/`finalizeMerge` are still never called for this case either way — only
the cleanup-only path's OWN entry condition changed, not what it does once entered.

1. **`alreadyFinalized` is scoped to THIS row's current task+branch**, not bare `merge_done` presence for
   the worker id. What actually shipped (round 4 below corrected a further drift in this bullet's own
   quoted shape — see its own note there): the precomputed `eventPresenceMap` lookup —
   `!!eventPresenceMap.get(s.id)?.mergeDoneKeys.has(workerEventPresenceKey(s.taskId, s.branch)) ||
   !!eventPresenceMap.get(s.id)?.mergeDoneKeys.has(workerEventPresenceKey(s.taskId, null))` — the second
   `(taskId, null)` leg is round 3's own legacy-row-with-no-branch fix (below), folded into the SAME bulk
   map `c1161989` built rather than a fresh `.some()` scan. This is the same shape of over-broad presence
   check `9ac3a739` already fixed once for the cross-row case, closed here for the single-row case too,
   defensively.
2. **The unified cleanup-only path never calls `retireWorkerSession` or `finalizeMerge`** — only the
   shared `finalizeWorktreeAndBranch` tail (round 4 below), which runs `gcWorktreeDir` (tip-guarded,
   exactly as the sibling case already was) then a CAS `deleteBranch` GATED on that removal's own outcome:
   skipped when the worktree was retained dirty/nested-blocked/still-checked-out (round 4's own Major fix,
   below), and skipped when the branch is already gone (`skipDeleteWhenBranchGone`, round 5's own Major
   fix — round 4 alone did NOT actually gate on this despite this bullet's original claim; see Round 5
   below) — never a standing destructive call against a branch still genuinely in use, nor against one
   with nothing left to delete.
3. This still satisfies `9ac3a739`'s original intent (the own-row cleanup retry is never silently
   dropped) without its literal mechanism (calling `finalizeMerge` itself) — see that record's own Round 4.
4. **Side effect, confirmed correct, not a regression:** `worktreesPruned` now also counts an own-row
   cleanup-only removal (it already counted the sibling case before this card). A pre-existing test
   (`worktree-nested-repo-guard.mjs`'s "(boot)" scenario) incidentally relied on the OLD gap — two
   unrelated, already-finalized-but-retained worktrees from EARLIER scenarios sharing its `db` were
   invisible to this counter before, and are now correctly counted when this card's unification lets
   their own-row retry run through the SAME counted path. Fixed by updating that test's assertion to
   name the two incidental removals explicitly, rather than asserting a blanket zero that depended on the
   old omission.

## Round 3 (Code Review follow-up) — a legacy row with no recorded branch must match on task alone

`merge_done.detail.branch` postdates some history — a row from before branch recording existed has no
`branch` key at all. Matching strictly on `task AND branch` (round 2's shape) would never match such a
row, forcing it through a full re-finalize every boot forever — the EXACT incident this card exists to
fix, just reached via a different gap. Fixed: `e.detail?.branch == null || e.detail.branch === s.branch`
— a legacy row (absent OR explicit-null branch) matches on task alone; a row that DOES carry a branch
still requires it to match (task mismatch always disqualifies, regardless of branch).

**A real test-fixture trap, worth naming:** the first draft of this round's own regression tests reused
one shared project row (and therefore its `repoPath`) across three new fixtures, each landing its real
squash in a DIFFERENT git repo — Pass A's squash lookup silently searched the WRONG repo, returned
`landedSha: null`, and every fixture `continue`d before reaching the code under test at all. All three
checks passed anyway, vacuously, for a reason that had nothing to do with branch matching. Caught only by
reverting the fix under test and finding the "RED" tests stayed green. Each fixture needing its own real
git landing now gets its OWN project row via a shared `setupLandedWorker(tag)` helper — one project row,
one repo, one landing, no path to reuse the wrong one.

**A second, narrower confound in the MISMATCH negative control:** stamping the foreign event under the
SAME `workerSessionId` as the real landing (deliberately, to test task-matching on one row's own event
history) also incidentally triggers `finalizeMerge`'s own SEPARATE, worker-id-only `hadPriorMergeDone`
replay guard — a pre-existing mechanism, unrelated to this card, that then skips the task-column-move/
reingest. The fixture's assertions were narrowed to `worker_retired` + a freshly-task-scoped `merge_done`
(the clean, direct signal that Pass A itself took the genuine-finalize branch, not the cleanup-only skip)
rather than the task-column/worktree-removal side effects, which that other mechanism also affects.

## Round 4 (Code Review `203fbd24`, CHANGES, Major reproduced) — the lean path ran its CAS delete unconditionally

The cleanup-only path (round 2/3 above) called `gcWorktreeDir` then, whenever `soloFinalizeTipGuard`
reported a tip to protect, called `deleteBranch`'s CAS UNCONDITIONALLY — regardless of what
`gcWorktreeDir` itself had just reported. `finalizeMerge`'s own tail has always gated that same delete on
`!nestedRepoBlock && !dirtyWorktreeRetained` (decisions `6796c9ea`/`cc9bce38`), plus a
`listCheckedOutBranches` read when a tip is expected — the lean path had neither gate. Reproduced: a
dirty own-row stuck worktree (still checked out on its branch) had its branch ref CAS-deleted anyway,
exactly the data-loss shape `cc9bce38` exists to prevent. The gap was pre-existing for the SIBLING case
too (round 2/3 never added these two gates there either) — this card's own unification (round 2) just
routed the own-row case through the same ungated path, widening who hits it.

**Fix:** `finalizeMerge`'s worktree-removal + guarded-CAS-branch-delete tail is now the ONE shared private
method (`finalizeWorktreeAndBranch`, `sessions/service.ts`) both `finalizeMerge` and this cleanup-only path
call — no second copy of the delete-skip logic to drift out of sync again. `finalizeMerge` can't simply
call it once, though: its own terminal bookkeeping (task column move + the `merge_done` event) must run
strictly BETWEEN the removal and the delete (`@decision sha:252e57ec` — the delete is the destructive op
and must run LAST, after `merge_done` is durable), so the shared method takes a `betweenRemovalAndDelete`
callback as the ONE interleave seam: `finalizeMerge` passes its bookkeeping block there; the cleanup-only
path (no bookkeeping to run) omits it. The callback is invoked UN-WRAPPED (no try/catch) so a throw inside
it propagates straight out exactly as it did when the code ran inline — pinned by
`merge-finalize-bookkeeping-throw-skips-delete.mjs`.

**Tests, this round:** `pass-a-stuck-worktree-no-replay.mjs` gained DIRTY (own-row stuck worktree, branch
present at its landed tip, an untracked file makes it dirty — RED-proofed against pre-fix code: the branch
got deleted anyway) and NESTEDBLOCKED (same shape, a nested git repo instead) — both now assert the branch
ref SURVIVES. A third fixture, proving the ordinary case is unaffected (worktree genuinely removable,
nothing dirty/nested), needed its OWN isolated `SessionService` with a REAL (non-stubbed) `removeDir` —
that file's shared `removeDir` ALWAYS reports a clean-reject failure by design (to prove the stuck-forever
case), so a worktree there can never be genuinely de-registered and `listCheckedOutBranches` would
correctly keep holding its branch regardless of this fix, which isn't "nothing blocking it." That positive
control lives in its own file, `pass-a-own-row-cleanup-deletes-branch.mjs`.

**Why `finalizeMerge`'s `merge_done` append stays UNCONDITIONAL (moved here from an inline comment, which
had grown past the taxonomy's own cap):** card `daaf7fc9`'s own LEAD (not a finding) is that a replay
finalize still appends a SECOND `merge_done` for this worker. The `alreadyFinalized`/`hadPriorMergeDone`
guards elsewhere in `finalizeMerge` use `.some()`, so they stay correct either way regardless of how many
`merge_done` rows exist for a worker. Two DIFFERENT counts matter before this could safely be guarded —
don't conflate them, and don't trust a hardcoded total for either (a repo-wide grep count drifts with
every edit):
- **WRITERS** of the `merge_done` event kind — the number that actually bounds how many rows a replay can
  produce. Re-derive live: search for the TypeScript event-literal shape `kind:` immediately followed by
  the quoted event-kind string, in `packages/daemon/src/`. At the time this was written: exactly 2, both
  in `sessions/service.ts` — `finalizeMerge`'s own append, and boot-reconcile Pass A2's.
- **READERS** (filter/`some()`/count consumers of the event) — the population that would need auditing
  before this append could safely be guarded too. Re-derive live: `grep -rln merge_done
  packages/daemon/src/`. At the time this was written: `sessions/service.ts` plus `db.ts`,
  `mcp/orchestration.ts`, `idle-watcher.ts`, `companion/attention-push.ts` — the overwhelming majority of
  individual mentions live in `sessions/service.ts`, not spread across the other four. None of them, here
  or there, had been audited for a consumer that COUNTS events rather than checking presence.

Audit the reader population before guarding this append; until then, it fires on every finalize call,
replay or not.

## Round 5 (delta Code Review `6bb9e8c2`) — the shared tail still ran a plain `git branch -D` on a gone ref

Round 4's unification gated the CAS delete on `gcWorktreeDir`'s own outcome (nested/dirty/still-checked-
out), but it did not gate on whether the branch was confirmed ALREADY GONE (`expectedBranchTip`
undefined, the `soloFinalizeTipGuard` contract) — so the cleanup-only path still called `deleteBranch`
unconditionally in that case, which runs a plain, unconditional `git branch -D` (no CAS, since there is
no tip to compare against). That is the exact standing destructive call this card exists to remove,
reintroduced by the round-4 unification: every boot over a permanently stuck dir re-issued it against a
ref with nothing left to delete.

**Fix:** `finalizeWorktreeAndBranch` takes a new `skipDeleteWhenBranchGone` flag, set ONLY by Pass A's
cleanup-only caller — when true and `expectedBranchTip` is undefined, the whole `deleteBranch` call is
skipped entirely, not just made idempotent. (Its preceding `listCheckedOutBranches` read is already
gated on `expectedBranchTip` being truthy on its own, independent of this flag — never reached either
way once the branch is confirmed gone.)
`finalizeMerge` never sets this flag (as of this round), so its own gone-branch behaviour (still calling
`deleteBranch`, which swallows an already-missing ref) is byte-identical to before this round.
**Superseded by card `ed2d878e`:** `finalizeMerge`'s own call now sets this flag too — see that card's
own decision record for why. The cleanup-only call
site also now passes `logPrefix: "[reconcile]"` (NIT: the shared tail previously logged every Pass A
warning under the manager-facing `[finalizeMerge]` prefix) and a test-only `gitFactory` seam threaded
from `reconcileOrchestrationOnBoot`'s existing `gitDeps` param (card `6ee48e4d`).

**Test:** the base fixture's 3-boot loop (gone-branch, stuck-dir worker) now asserts via an injected
`gitFactory` spy that `deleteBranch`'s own `git branch -D` is never attempted across any of the 3 boots —
RED-proofed against pre-round-5 code (the spy records the call every boot).

## Do not

- Do not match `alreadyFinalized` on `task AND branch` unconditionally — a legacy `merge_done` row with
  no recorded branch (round 3) must match on task alone, or it is forced through a full re-finalize every
  boot forever, the exact incident this card fixes, reached via a different gap.
- Do not give a regression-test fixture a shared project row across multiple real git landings in
  different repos (round 3's own near-miss) — each fixture needing a genuine squash lookup to succeed
  needs its OWN project row with its OWN matching `repoPath`, or the lookup silently searches the wrong
  repo and every assertion built on top of it passes vacuously regardless of the code under test.
- Do not revert to calling `retireWorkerSession`/`finalizeMerge` for an own-row retry "to keep it simple"
  — both append a durable event unconditionally on every call, and a worktree dir that never clears turns
  that into an unbounded, forever-repeating replay (the exact incident this card fixes).
- Do not give an own-row retry a SEPARATE cleanup path from the sibling case, and do not run it BEFORE the
  squash lookup/`isBranchHeld` — round 1 of this exact card did both and introduced a real data-loss-class
  regression (fixture J, above): an own-row `merge_done` being recorded is NOT proof no later commit can
  land on the branch before the worktree is actually removed. The tip guard both cases need is identical;
  share the ONE path, after the squash lookup, same as the sibling case always has.
- Do not skip the cheap branch-ref existence read before `deleteBranch` in the unified path — a standing
  CAS delete attempt against an already-gone ref is wasted git-subprocess cost on every boot, for nothing
  (this is already how `soloFinalizeTipGuard`'s `branchGone`/`expectedBranchTip` behave; don't reintroduce
  a second, bespoke existence check on top of it).
- Do not assume this closes the un-removable-directory root cause itself — it does not; the directory may
  still never clear. This card only stops Pass A from re-running finalize bookkeeping while it doesn't.
- Do not run `deleteBranch`'s CAS from the cleanup-only path (or anywhere else) without routing through
  `finalizeWorktreeAndBranch` (round 4) — it is the ONE place the delete is gated on `gcWorktreeDir`'s own
  outcome; a second, ungated copy is exactly how this card's own Major regressed.
- Do not wrap `finalizeWorktreeAndBranch`'s `betweenRemovalAndDelete` callback in a try/catch — a throw
  inside it must propagate and skip the delete, not be swallowed.
- Do not add a replay guard around `finalizeMerge`'s `merge_done` append without first re-deriving AND
  auditing the READER population above (not just the writer count) — an unaudited reader that counts
  rather than checks presence of this event would silently break the moment the append stopped firing
  unconditionally.
- Do not assume `deleteBranch` being idempotent (swallowing an already-gone ref) is enough to call it
  unconditionally from the cleanup-only path (round 5) — idempotent still means a real `git branch -D`
  subprocess runs on every boot forever; the cleanup-only caller must pass `skipDeleteWhenBranchGone` and
  skip the call ENTIRELY once the branch is confirmed gone, not merely tolerate its no-op outcome.

Tests: `packages/daemon/test/pass-a-stuck-worktree-no-replay.mjs` (RED-proofed against pre-fix code:
3 boots over a permanently stuck dir produced 4 `merge_done` and 3 `worker_retired` events for one
worker; fixed code holds both at their original counts while the removal retry still fires every boot;
round 4 added its DIRTY/NESTEDBLOCKED fixtures, see above; round 5 added a `gitFactory` spy on the base
fixture's 3-boot loop proving `deleteBranch`'s own `git branch -D` is never attempted for the gone-branch
worker, RED-proofed against pre-round-5 code). `packages/daemon/test/worktree-recycle-alias-
protection.mjs`'s fixture J (pre-existing, caught round 1's regression) and `packages/daemon/test/
codescape-reingest-replay-guard.mjs`'s REPLAY case (pre-existing, updated assertions) both exercise this
fix too. Round 4 added `packages/daemon/test/pass-a-own-row-cleanup-deletes-branch.mjs` (the ordinary-case
positive control) and `packages/daemon/test/merge-finalize-bookkeeping-throw-skips-delete.mjs` (pins the
exception semantics of the `finalizeWorktreeAndBranch` extraction).
