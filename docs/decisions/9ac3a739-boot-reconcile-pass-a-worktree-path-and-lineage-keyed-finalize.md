# 9ac3a739 — boot-reconcile Pass A keys worktree protection on PATH and "already finalized" on the LANDING, never on the iterated session row

## Narrative

Full review lane 1 (card `2785fbc2`) traced a two-pass cascade through boot-reconcile's Pass A (the
orphaned-squash-merge finisher, `SessionService.reconcileOrchestrationOnBoot`): a `worker_recycle` chain
`A→B` shares ONE `worktreePath`/`branch`/`taskId` across both rows (`recycleWorker` never clears the
predecessor's own values — the fresh successor just carries them forward). Pass B already closed this
hole for its own worktree-GC decision, per `@decision 40b63f1c`, by building a `protectedWorktreePaths`
set up front (any row protected-for-resume OR currently live contributes its OWN `worktreePath`) and
keying its GC/keep decision on that set, never on the iterated row's id. Pass A had no equivalent: its
finalize loop skipped only `if (protectedSessionIds.has(s.id))` — the iterated row's OWN id — so a
dangling recycle predecessor (exited, unprotected-by-id, but sharing the live successor's worktree and
branch) sailed through Pass A's `Loom-Worker-Branch`-trailer lookup and got finalized: worktree removed,
task forced terminal, branch CAS-deleted — destroying what the protected successor needed, out from
under a crash-recovery resume about to land on it.

A second, related gap (m1): Pass A's own "already finalized" early-out
(`workerEvents.some(e.kind === "merge_done")`) is keyed on the ITERATED row's own events. Once a merge is
actually finalized through one row's id (commonly the successor's, since that's the row that calls
`confirmWorkerMerge`), a SIBLING row sharing the same branch (a dangling predecessor) never reads as
already-finalized on a later boot, so Pass A can re-run `finalizeMerge` through it — forcing the task
column back to terminal, resetting `mergedVerification`, and filing a duplicate `merge_done` + reingest.

## Fix

1. **Shared protected-path predicate.** `protectedWorktreePaths` (the exact set Pass B already built) is
   now computed ONCE near the top of `reconcileOrchestrationOnBoot`, before Pass A runs, and BOTH Pass A
   and Pass B consult the SAME set. Pass A's per-row skip is now `protectedWorktreePaths.has(worktreePath)`
   (worktreePath hoisted above the row's processing), not `protectedSessionIds.has(s.id)` alone. **This is
   a real WHAT change for Pass A, not merely a WHERE one** (corrected in round 2 below — the original claim
   here, that this only moved WHERE the test runs, was wrong): Pass A's own membership rule used to be
   `protectedSessionIds.has(s.id)` only, with no `isLive` leg at all, so Pass A gained a brand-new
   non-exited skip class it never had before. Pass B's own membership rule
   (`protectedSessionIds.has(s.id) || isLive`) is untouched, so this fix does NOT absorb the separate,
   SUSPECTED gap in card `5439b7d2` (whether that membership rule itself omits some crash-recovery-eligible
   session) — that stays open as its own smaller follow-up, now with one shared edit point instead of two.
   Pass A2 (the non-destructive, branch-gone dangling-merge resolver) deliberately keeps its row-id check:
   it never touches a worktree or branch, only files a missing event, so there is no destructive-aliasing
   hazard for the path predicate to guard there.

2. **Lineage-keyed "already finalized".** Checked whether `merge_done`'s `detail` carries a landed-sha
   field before designing this: it does NOT, except the attribution-only `landedSha` set exclusively when
   `gateSkipped` (`@decision 293d418e`) — which boot-reconcile's own Pass A finalize call never sets. A
   plain "any `merge_done` on this branch" check is also too coarse on its own: a HELD branch (card
   `13fc5227`) can legitimately carry TWO landings and two `merge_done` events (commits added after a
   merge_batch retained the branch, landed later as a separate "late range"), so that check would wrongly
   treat the SECOND landing's crash-orphan as already handled by the FIRST's event.

   Resolution (per manager direction, since no sha field exists to match on and inventing one on
   `merge_done` was out of scope for this card): after Pass A's trailer lookup resolves `landedSha` for a
   row NOT already caught by the cheap per-own-id early-out, compare that SPECIFIC landing's own commit
   time (`getCommitTimeIso`, a new small bounded-git helper in `git/worktrees.ts`) against the LATEST
   `merge_done` recorded for the branch (`db.listEventsForBranch`, already used in this same function by
   `isBranchHeld` for the identical cross-recycle problem, card `42daa283`). If the latest `merge_done`'s
   timestamp is at or after the landed commit's own time, this landing (or a later one) was already
   finalized through some other row sharing the branch — skip, no re-finalize. This check only runs AFTER
   the (already-expensive) trailer lookup, so it adds no git-spawn cost to the fast path the existing
   per-own-id early-out exists to protect (card `c33f94b2`) — it only applies to the population that early-
   out doesn't already resolve.

## Follow-on finding: Pass A2 has the identical row-vs-lineage bug

Writing the landed-recycle-chain regression test (fixture D below) surfaced a THIRD instance of this
same bug class, in Pass A2 (the branch-gone dangling-merge resolver), not named in the original card body.
A2's own `hasTerminal` check (`evts.some(e.kind === "merge_done" || e.kind === "merge_rejected")`) is ALSO
keyed on the iterated row's own events. With Pass A's finalize fix above correctly deferring the
predecessor's finalize to the protected/aliased path, an UNPROTECTED landed recycle chain's predecessor
row gets finalized (`merge_done` filed under the predecessor's id) — then A2 reaches the successor row on
the SAME boot: its task is now terminal (the predecessor's finalize just set it), it has its own
`merge_request` (filed under the successor, since that's the row that actually called `worker_merge`),
and its OWN events have no terminal event (the real one landed under the predecessor's id) — so A2 fires
a second, redundant "reconciling" `merge_done` for the successor, duplicating the bookkeeping. Fixed by
widening `hasTerminal` to also check `db.listEventsForBranch(branch, "merge_done")`, the same primitive
used above. Non-destructive (A2 never touches a worktree/branch), so this was a correctness/duplicate-
event defect, not a data-loss one — but it is the same lineage-keying principle this card's (c) item
already established, applied where the card's own body didn't name it.

## Round 2 (Code Review of commit `d0e4de42`, REQUEST CHANGES)

A full-lane review found three real defects in round 1's own fix, resolved with manager rulings:

1. **Two existing tests went red: `batch-merge-hold-repo-scoped.mjs` and `multi-repo-worker-lifecycle.mjs`
   scenario (5).** Root cause: Pass A's protected-path check now ALSO skips any `isLive` row (see the
   corrected item 1 above) — and `multi-repo-worker-lifecycle.mjs` left its orphan row `isLive` when
   production never would (`recoverStaleSessions()` always exits it first). Ruling: the new skip class is
   INTENDED, the safer rule — fix the fixture (`multi-repo-worker-lifecycle.mjs`'s orphan now calls
   `db.recoverStaleSessions()` before reconciling, mirroring production). **Round 3 correction:**
   `batch-merge-hold-repo-scoped.mjs` was never actually broken by the `isLive` skip at all — the delta
   review of round 2 (commit `4b116328`) traced its own red to item 3 below instead: the "already
   finalized" check ran BEFORE `isBranchHeld` and matched by branch name only, so it swallowed `isBranchHeld`'s
   own `mergesHeld++`/`handledWorktrees` bookkeeping for that fixture's held branch; reordering `isBranchHeld`
   first (item 3's own fix) is what actually turned it green, independent of any `isLive` fixture change.

2. **The round-1 "already finalized" check silently broke Pass A's own deliberate own-row cleanup
   retry** (`merge_done` recorded but the worktree still on disk — `worktreeGcWarning`'s own promise):
   because it matched on branch presence/commit-time with no notion of WHOSE merge_done it was looking
   at, it could treat an own-row retry as "already finalized" and skip it outright. Fixed by exempting
   the check entirely whenever `alreadyFinalized` (this row's OWN events already carry a `merge_done`) —
   that case now always falls through to the ordinary `finalizeMerge` call, which is safe via its own
   `hadPriorMergeDone` replay guards. For the opposite case — a genuine SIBLING row (no own `merge_done`)
   whose worktree dir still lingers because the OTHER row's removal was incomplete — Pass A now runs a
   cleanup-only path (`gcWorktreeDir` + a CAS `deleteBranch` at the landed tip) instead of a full
   `finalizeMerge`, since the task bookkeeping/`merge_done`/reingest already happened under that other row.

3. **The "already finalized" check ran BEFORE `isBranchHeld` and matched by branch NAME only, not
   repo-scoped.** A same-named branch re-cut in a different repo (the branch name carries no repo axis —
   `@decision a5be590f`) that already recorded its own `merge_done` could make this check fire first and
   `continue` before `isBranchHeld` ever ran — silently dropping that boot's `mergesHeld++`/
   `handledWorktrees` bookkeeping for a genuinely held branch in THIS repo. Fixed by moving `isBranchHeld`
   first, and scoping the already-finalized check to `(branch, repoKey)` via `detail.repoKey === (s.repoKey
   ?? null)`, mirroring every other branch-keyed reader in this file.

4. **Replaced the git-commit-time discriminator with DB event order.** `getCommitTimeIso` (git spawn, a
   second clock to reconcile against `ts`, itself only millisecond-precise) is removed outright. "Already
   finalized" is now: the latest `merge_done` **seq** for `(branch, repoKey)` is greater than the latest
   `merge_request` **seq** for the SAME `(branch, repoKey)` — `seq`, never `ts`/rowid (`@decision
   4ee527d1`: `ts` collides at ms resolution, sqlite reuses rowid on delete). `Db.latestEventSeqForBranch`
   is the new reader. The identical rule now also drives Pass A2's `hasTerminal` (fixing a re-task
   stale-MERGE-REQUEST-alert case: a branch-presence check there could let an OLD, unrelated `merge_done`
   on a reused branch name wrongly satisfy a re-task's own, later, still-unresolved `merge_request`).

5. **`protectedSessionIds.has(s.id)` stays alongside the path check in Pass A's skip**, not replaced by
   it — so an explicitly protected row whose `worktreePath` happens to resolve to nothing can't fall
   through unprotected, the same belt-and-suspenders shape `protectedWorktreePaths` is already built
   with.

Test fixture fallout: `codescape-reingest-replay-guard.mjs`'s REPLAY case used to append its synthetic
`merge_done` at a stale module-load `now` timestamp, which always predated the real squash commit's
committer time — this happened to dodge round 1's own regression (item 2 above) by accident rather than
proving the exemption; fixed to use a fresh timestamp taken after the commit. `worktree-recycle-alias-
protection.mjs`'s fixture E (held-branch two-landings) is RELABELED, not changed: it already passed on the
pre-round-1 parent (that code never consulted branch-wide `merge_done` presence at all), so it is a guard
against a naive presence-only implementation, never proof that round 1's fix was a regression-free
improvement on its own.

## Round 3 (delta review of commit `4b116328`, APPROVE with 3 Minors folded in before merge)

1. **`latestEventSeqForBranch`'s own repoKey filter had no test exercising it directly.** A reviewer
   mutated the filter to always-match (dropping the repoKey comparison) and all 12 existing repoKey-scoped
   tests in the suite stayed green — they exercise `isBranchHeld`'s own, separate repoKey filter, never
   this one. Two new fixtures close the gap: a merge_done for `(branch, "other")` at a higher seq than a
   primary (`branch, null`) merge_request now makes Pass A run a GENUINE full finalize (never the
   cleanup-only path) through the row with no own merge_done, and makes Pass A2 NOT treat it as
   satisfying a sibling's own, later, primary-scoped merge_request.

   **The missing-repoKey convention here deliberately differs from `isBranchHeld`'s own `inScope`
   filter — this is NOT a bug to unify.** `isBranchHeld` treats an ABSENT `repoKey` key (a legacy row,
   from before repo-scoping existed at all) as matching ANY repo scope, by design (`@decision
   42daa283`'s repo-scope section: "an absent repoKey key is a legacy row that matches any repo").
   `latestEventSeqForBranch` instead folds an absent key into `null` via `(detail.repoKey ?? null) ===
   repoKey` — so an absent key matches ONLY the primary scope, never every scope. Every real writer this
   function reads (`merge_done`/`merge_request` from `finalizeMerge`, `confirmWorkerMerge`,
   `mergeBatchTracked`, and Pass A2 itself as of item 2 below) has stamped `repoKey` as a required
   argument since card `a5be590f`, so the "legacy, no key at all" population `isBranchHeld`'s own
   broader convention exists for has no equivalent here — there is nothing this function's own
   convention needs to be lenient about.

2. **Pass A2's reconciling `merge_done` omitted `repoKey` entirely.** An omitted key is NOT the same as
   an explicit `null` for `latestEventSeqForBranch`'s own convention above (it would read as "primary"
   by the `??` fallback regardless, since `JSON.parse` of a detail object with no `repoKey` field leaves
   `detail.repoKey` `undefined`, and `undefined ?? null` is `null` either way — so this was latent, not
   yet a live divergence) — but it is still a real omission relative to every OTHER `merge_done` writer
   in this file, which all stamp `repoKey` explicitly as a required argument. Fixed: Pass A2 now stamps
   `repoKey: s.repoKey ?? null` (the SAME `repoScope` constant its own seq comparison above already
   computed), closing the gap before any future reader relies on presence rather than value.

3. **The sibling cleanup-only path did not mirror `finalizeMerge`'s own tip-check order.** It ran
   `gcWorktreeDir` unconditionally once `finalizedElsewhere` was true, and called `deleteBranch` only
   when `paLooked.landedTip` was truthy — with NO check that the branch's live tip still matched the
   landed one BEFORE removing the worktree, and no handling at all for `deleteBranch` returning `false`
   (a CAS refusal was silently swallowed). Fixed by routing this path through the SAME
   `soloFinalizeTipGuard` a solo finalize already uses: the live tip is read and compared to the expected
   one (derived from `paLooked.landedTip`/`branchGone`, same as `finalizeMerge`'s own
   `pinnedTipForLandedSquash` resolution) BEFORE `gcWorktreeDir` runs; a mismatch or unverifiable tip
   removes nothing and files the same `merge_branch_retained` event (`source: "solo"`) a solo finalize's
   own tip guard would. `deleteBranch` returning `false` now files the same event too (phase
   `"ref-kept-after-finalize"`), instead of being ignored.

4. Test fixture fallout, this round: `worktree-recycle-alias-protection.mjs` gains three fixtures — H/I
   (item 1, Pass A and Pass A2 respectively) and J (item 3: a real `Loom-Landed-Tip`-trailered squash
   followed by a late commit on the shared branch, proving the worktree/branch are kept and a notice is
   filed). The 59-file sweep this card's own DoD re-ran names every file that references
   `reconcileOrchestrationOnBoot`, `finalizeMerge`, `isBranchHeld`, `mergesHeld` or
   `recoverCrashOrphanedWorkers` — re-derive that list the same way (`grep -rl` those names across
   `packages/daemon/test`) rather than trusting a count restated here.

## Do not

- Do not run the "already finalized" check before `isBranchHeld` — a branch-name-only match (or any
  future, still-unscoped match) can swallow the held-branch skip's own `mergesHeld++`/`handledWorktrees`
  bookkeeping; `isBranchHeld` always runs first.
- Do not apply the "already finalized" seq check to an own-row retry (`alreadyFinalized` true) — it must
  always fall through to the ordinary `finalizeMerge` call; gating it there too silently drops Pass A's
  deliberate own-row cleanup retry.
- Do not call full `finalizeMerge` for a SIBLING row already finalized through another row's id — it
  would re-move the task column / re-persist ship-state / refire a reingest under the wrong row (the
  original m1 bug). Use the cleanup-only path (`gcWorktreeDir` + a CAS `deleteBranch`) instead.
- Do not run the sibling cleanup-only path's `gcWorktreeDir`/`deleteBranch` without first checking the
  live branch tip against the landed one (round 3, item 3) — a mismatch or unverifiable tip must remove
  nothing and file a `merge_branch_retained` notice, exactly like a solo finalize's own tip guard; and do
  not ignore `deleteBranch` returning `false` there either — it means the tip moved in the window since
  that check, not that nothing needed deleting.
- Do not "fix" `latestEventSeqForBranch`'s absent-repoKey handling to match `isBranchHeld`'s own
  any-repo-matches convention (round 3, item 1) — every real writer this function reads stamps `repoKey`
  explicitly, so there is no legacy population here for that leniency to serve; folding an absent key
  into primary-only is the correct, narrower rule for this reader.
- Do not add a new `merge_done` writer (or touch an existing one) without stamping `repoKey` explicitly
  (round 3, item 2) — an omission is latent-safe only by accident of today's `?? null` fallback, not by
  contract.
- Do not key any worktree-destroying decision in Pass A (or any future boot-reconcile pass) on the
  iterated session row's own id — key it on `protectedWorktreePaths` (the worktree PATH), exactly like
  Pass B, so a recycle predecessor sharing that path defers to it too.
- Do not key an "already finalized" check on the mere PRESENCE of a `merge_done` event for a branch — a
  HELD branch can carry two independent landings/two `merge_done` events; key on whether a finalize ran
  for THIS SPECIFIC landing (or a later one), via DB event seq order (round 2 below), never
  branch-presence alone and never a git commit-time comparison (round 2 replaced that mechanism).
- Do not invent a new sha field on `merge_done`'s `detail` to make this exact-sha matchable without
  checking with the project owner/manager first — `detail.landedSha` already exists but is deliberately
  attribution-only (`@decision 293d418e`) and conditional on `gateSkipped`; widening its meaning or adding
  a parallel field is a contract change this card did not clear.
- Do not assume this fix absorbs card `5439b7d2` — Pass A now consults the SAME protected-path
  membership rule Pass B already had, but that rule's own DEFINITION (`protectedSessionIds.has(s.id) ||
  isLive`) is untouched; that card's suspected gap is in the membership rule
  itself and remains a separate investigation.
