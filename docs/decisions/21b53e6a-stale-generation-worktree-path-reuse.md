# 21b53e6a — boot-reconcile Pass A keys worktree/branch decisions on the CURRENT GENERATION of a reused path, never on fs.existsSync alone

## Narrative

Found by worker `476afcc7` while building `worktree-recycle-alias-protection.mjs`'s fixture E (card
`9ac3a739`), reproduced and severity-assessed by reviewer `4305d326` (2026-10-02), reproduced again at
source on current main (2026-10-03) before this fix.

`createWorktree`'s worktree path AND branch name are both a pure function of `taskId` (`taskKey`,
`git/worktrees.ts`). Unlike a `worker_recycle` chain (which shares a path via `recycledFrom` — a real
lineage relationship `@decision 9ac3a739`/`40b63f1c` already protect), a RE-TASK — a brand-new worker
dispatched onto the SAME task after a prior worker already finished with it — reuses the exact same
path/branch with **no recycle relationship at all**. `db.listSessionsAtWorktreePath`'s own doc comment
already named this gap for the `worktreePathAliases` display signal; this card closes it for
boot-reconcile Pass A, which had no equivalent protection.

**Confirmed mechanism:** Pass A's cheap early-out (`if (alreadyFinalized && !worktreeOnDisk) continue`)
computed `worktreeOnDisk = fs.existsSync(s.worktreePath ?? s.cwd)`. For a stale, already-finalized worker
X whose path has been reused by a re-task Y, this reads Y's live (or crash-orphaned) worktree as if it
were X's own, so the early-out never fires and Pass A re-processes X.

Two confirmed severity tiers, both reproduced against current main in a throwaway fixture (not
committed) before implementing this fix:

- **Tier A (self-heals in a 2-generation case, but not reliably):** X genuinely landed+finalized itself
  before. `alreadyFinalized(X)` is true, so X takes the EXISTING tip-guarded cleanup-only path
  (`@decision e34d475c`) — gc'ing Y's real, not-yet-finalized worktree and CAS-deleting Y's real branch
  under X's wrong identity. In the simplest 2-row case this didn't corrupt board state, because Y's own
  row, processed later in the SAME pass, still read `alreadyFinalized(Y)=false` and `finalizedElsewhere
  (Y)=false` (nothing had advanced the branch's `merge_done` seq past Y's own `merge_request`) and ran a
  genuine finalize. But the ACTION itself (X destroying artifacts it has no business touching, under the
  wrong identity) is a real defect independent of whether the end state happens to recover.
- **Tier B (PERMANENT, reproduced end-to-end across two reconcile passes):** X never requested a merge at
  all (abandoned mid-work, crash before ever calling `worker_merge`). `alreadyFinalized(X)` and
  `finalizedElsewhere(X)` both read false, so X falls through to the GENUINE `finalizeMerge` call under
  its own (wrong) identity, with `mergedSha` = **Y's** real landed sha (the squash-by-branch-name lookup
  is blind to which generation is asking). `finalizeMerge`'s own `hadPriorMergeDone` check reads false for
  X (X genuinely has no prior `merge_done`), so it runs as a first-time finalize: task moves to done,
  `merge_done`+`worker_retired` filed under X's id. Y's own `merge_request` then PERMANENTLY reads as
  `finalizedElsewhere` (X's brand-new `merge_done` now outranks Y's older `merge_request` by seq) with
  nothing left on disk to clean — unresolvable on every subsequent boot.

(The card's own severity write-up described the mechanism as "`hadPriorMergeDone(X)` is true" for a
GENUINELY prior-finalized X — that literal shape could not be reproduced on current main, because round 4
of `@decision e34d475c` already routes an `alreadyFinalized` row into the cleanup-only path, never into a
real `finalizeMerge` call. Tier B above is the mechanism that actually reproduces the described
misattribution/permanent-stranding outcome; flagged here per the "verify before adopting" doctrine rather
than silently rewriting the card's own history.)

## Fix

1. **`currentGenerationIds`** (computed once, up front, same place as `protectedWorktreePaths`): for every
   distinct `worktreePath` among worker rows, group sessions sharing that path by RECYCLE LINEAGE first
   (walk `recycledFrom` to find each lineage's "head" — a row nobody else in the group recycled from),
   then pick the lineage whose head has the latest `createdAt` as the CURRENT generation. Every row in
   that winning lineage (the head plus its recycle-chain ancestors) is "current"; every other row sharing
   the path is "stale". Grouping by lineage FIRST (before comparing `createdAt`) means a tied `createdAt`
   within one recycle chain — which test fixtures often stamp for convenience — never matters; `createdAt`
   is only compared ACROSS distinct lineage groups, i.e. at a genuine re-task boundary.
2. **`worktreeOnDisk` is now generation-aware**: `fs.existsSync(path) && !staleGeneration`. A stale row's
   cheap early-out now correctly fires once it's `alreadyFinalized`, regardless of what physically
   occupies the shared path.
3. **A stale, NOT-yet-`alreadyFinalized` row never proceeds past that point either** — it never reaches
   the squash lookup (scoped to the shared branch NAME), the held check, or the cleanup-only/full-finalize
   gate, all of which would otherwise act on the CURRENT generation's branch state. Instead:
4. **Manager-directed gap-closer** (round 1 shape; CUT in round 2 — see "Round 2" below): a stale row may
   have its OWN outstanding landing (it genuinely filed its own `merge_request` before crash-orphaning).
   It always escalates ONCE rather than being attributed DB-only — see "Round 2" for why the original
   attribution attempt was removed.

`staleGenerationUnresolvedEscalated` is a counter on `reconcileOrchestrationOnBoot`'s return — per the
existing convention (`index.ts`'s own comment on `worktreesStaleRepoKey`), NOT folded into the condensed
boot summary line; Pass A emits its own dedicated log line for it, same as
`unreadableWatermarkSkipCount`/`unresolvableWatermarkRefSkipCount`.

## Round 2 (Code Review `620da79c`, 2026-10-03)

**Major #1/#2 — the round-1 DB-only attribution (item 4 above, `findLandedSquashCommitByTip`) was
REMOVED, never fixed in place:**

- #1: `merge_request.detail.tip` is the tip the worker's OWN review captured — it can diverge from the
  commit that actually lands whenever main moves between review and squash (a union merge), on a branch
  HELD past that point, and on EVERY batch landing (no `Loom-Landed-Tip` trailer at all). A stale row with
  a genuine landing could fail to match its own trailer and false-escalate; worse, nothing structurally
  prevented a WRONG match.
- #2: the DB-only `merge_done` it filed carried the SHARED branch name in its `detail`, which leaked a
  STALE row's bookkeeping into every reader keyed on that branch and blind to generation (`isBranchHeld`,
  `buildLatestEventSeqMap`) — `isBranchHeld` would release Y's (the current generation's) hold, and
  `buildLatestEventSeqMap` would make Y read `finalizedElsewhere` on a later boot, reintroducing the exact
  card-9ac3a739-class stranding this card exists to fix, just via a different mechanism.

There is no safe DB-only way to resolve a stale row's own landing without re-touching the shared branch/
worktree, which belong to the CURRENT generation — so `resolveStaleGenerationOwnLanding` now ONLY
escalates (once) or no-ops (no `merge_request` of its own); it never attributes, never calls git, never
appends a `merge_done`. `findLandedSquashCommitByTip` (`git/worktrees.ts`) and
`Db.clearStaleGenerationUnresolved` were deleted outright (both had exactly one caller, this one, now
gone) rather than left as dead code. The counter `staleGenerationOwnLandingsResolved` was removed from
`reconcileOrchestrationOnBoot`'s return for the same reason — the outcome it counted can no longer occur.
**Proper, generation-safe attribution (never keyed on the shared branch) is tracked separately as a
follow-up — card `e5458ccd`.**

**Major #3 — a FAILED recycle attempt regressed the round-1 core.** `recycleWorker`/`recycleManager`/
`recyclePlatformLead`'s own pre-spawn-failure catches, and `reconcileNeverStartedRecycleSuccessor` (the
successor-died-before-SessionStart path), all NULL the dead successor's `recycledFrom` once the spawn is
known to have failed (`@decision 4be56c33`/`f349f5cb`). That nulled row is then indistinguishable, by its
own columns alone, from a genuinely fresh re-task generation sharing the same worktreePath — and its
newer `createdAt` wins `currentGenerationIds`' head-selection tiebreak over the REAL predecessor, which
may still have its own outstanding landing. The predecessor gets wrongly treated as stale (escalated
instead of finalized); the dead successor gets wrongly treated as current and can run a genuine
`finalizeMerge` under its own, wrong id.

**Fix:** `Db.listFailedRecycleSuccessorIds()` — a bulk query over every `recycle_failed` event's
`detail.failedSuccessorId` — excludes every named id from a path's `rows` BEFORE head/lineage selection,
in `currentGenerationIds`'s own per-path loop. A path whose only non-excluded row is the real predecessor
collapses to the single-row case trivially; the dead successor is never even considered a candidate head.

**Round 3 correction:** "the one durable fact all four nulling sites set" (as this originally read) is
WRONG — `currentGenerationIds` only ever groups **worker** rows (`s.role !== "worker" || !s.worktreePath`
is skipped outright in its own per-path loop above), so only the **two WORKER nulling sites** — `recycleWorker`'s
pre-spawn catch, and `reconcileNeverStartedRecycleSuccessor`'s worker branch — actually feed this fix.
`recycleManager`/`recyclePlatformLead`'s own catches, and `reconcileNeverStartedRecycleSuccessor`'s
manager/platform branch, also file `recycle_failed.detail.failedSuccessorId` (so the literal claim "all
four" happened to be true of the DB rows), but those ids can never collide with a worker row's id in
`byPath`'s grouping, so they are inert for this fix — stating "all four" overclaimed this fix's actual
dependency and could mislead a future reader into thinking a manager/platform-lead recycle failure
matters here, when it does not.

**Tiebreak, documented (round 2's own DoD item):** on an EXACT `createdAt` tie between two distinct,
real heads, `heads.reduce(...)` keeps whichever appears FIRST in `rows` — i.e. row ITERATION ORDER from
`listAllSessionsIncludingArchived`'s `last_activity DESC` read, not a meaningful chronology. This is a
deterministic but arbitrary pick, never observed in practice (a real re-task/recycle always happens
strictly after its predecessor, so a millisecond-resolution tie would require an unrealistic race) — see
the inline comment at the `heads.reduce` call site.

**Minor #4 — fixture K's own checks asserted only END STATE**, which is identical whether X is correctly
skipped outright or (pre-round-1) X wrongly runs the sibling-cleanup-only path against Y's real artifacts
first (that wrong action files no new event either — X already has its own `merge_done`, so it's silent).
Added a `gitFactory` delete-attempt-count spy (same seam `pass-a-stuck-worktree-no-replay.mjs`'s own round
5 already proved out) — X's wrongful cleanup-only action is the ONLY path that threads `gitFactory` for
this scenario (Y's own genuine `finalizeMerge` never does), so a correctly-skipped X leaves zero recorded
attempts; RED-proofed against the pre-round-1 parent.

Round 2 also added fixture O (Major #3's own repro: a worker P lands + crash-orphans, a failed-recycle
successor F shares its exact path) and reworded fixtures M/N (M's attributable-landing scenario now
escalates too, exactly like N — Major #1/#2's cut removed the distinction between them).

## Round 3 (delta Code Review `c91dadb9`, 2026-10-03 — APPROVE-with-minors)

1. **Escalate predicate narrowed to a lifecycle-order check.** `resolveStaleGenerationOwnLanding` used to
   escalate on bare `eventPresence.hasMergeRequest` alone, even when this row's OWN `merge_request` had
   already been followed by its OWN `merge_rejected`/`merge_cancelled` — a DECIDED outcome, not a stuck
   landing. It now reads this worker's full chronological lifecycle trail
   (`db.listEventsForWorkerKinds(s.id, ["merge_request","merge_done","merge_rejected","merge_cancelled"])`)
   and only proceeds when the LATEST such event is the `merge_request` itself — mirroring Pass A2's own
   terminal-pairing shape (`hasTerminal`, just above in `service.ts`). Review-only (nobody ever
   re-confirmed after the rejection/cancel) stays indistinguishable from crashed-mid-confirm without a
   dedicated confirm-start signal — closing that gap is tracked separately as card `e5458ccd`; this only
   stops escalating a demonstrably decided outcome. Fixture P (`setupRealRetaskOwnLandingDecided`) is the
   regression guard: X's merge_request is followed by a real merge_cancelled, and must never be tracked
   in the one-shot store nor enqueue a nudge. RED-proofed by temporarily reverting the lifecycle-order
   guard (back to bare `hasMergeRequest`) and confirming fixture P's checks fail, before restoring it.
2. **Remedy text now discloses the branch is SHARED.** The nudge used to suggest `git log --grep
   "Loom-Worker-Branch: <branch>"` as if it uniquely identified this worker's own landing — but the
   branch NAME is shared with the current generation, so that grep also matches the CURRENT
   generation's own, later landing. The message now says so explicitly and includes this worker's own
   recorded `merge_request` tip (from the SAME lifecycle-order-checked event item 1 reads) plus its
   `createdAt`→`lastActivity` window, so a human has something to actually tell the two generations'
   landings apart with.
3. **The one-shot NUDGE is now verified as a real durable message, not just the app_meta flag.**
   `worktree-recycle-alias-protection.mjs`'s fixtures M/N now additionally assert
   `db.listUndeliveredQueuedMessages()` carries exactly one still-undelivered entry addressed to the
   manager, both right after the first reconcile pass and again after the second (idempotent) pass — the
   app_meta `escalated`/`attempts` bookkeeping checked already proved the INTENT not to re-send, but never
   proved a second message wasn't enqueued by some other path. RED-proofed by temporarily dropping the
   `enqueueDurableMessage` call and confirming the new assertions fail (count 0, not 1), before restoring it.
4. **Fixture K's own zero-delete-attempts check gained a positive control.** Fixture F's branch (the real
   sibling-cleanup-only delete) must record >=1 attempt on the SAME `branchDeleteSpyFactory` spy, proving
   the spy can see a genuine delete — so K's own zero-attempts assertion is a true negative, not a dead
   probe that would read 0 regardless of whether the spy actually works.

## Do not

- Do not key any worktree/branch-destroying decision, or a squash lookup scoped to a shared branch NAME,
  on `fs.existsSync(worktreePath)` alone — a re-task reuses a prior worker's exact path/branch with no
  recycle relationship, so that check can read a NEWER generation's live state as the stale row's own.
  Key on `currentGenerationIds` instead.
- Do not compare `createdAt` across rows WITHIN one recycle lineage to decide "current" — group by
  `recycledFrom` lineage FIRST; a tied `createdAt` inside one chain must never make a genuinely-current
  recycle successor read as stale. Only compare `createdAt` ACROSS distinct lineage groups.
- Do not let a stale generation reach the squash lookup, the held check, or the "already finalized"
  cleanup-only/full-finalize gate — all four are scoped to the shared branch NAME and belong solely to the
  current generation.
- Do not call the ordinary `finalizeMerge`/`retireWorkerSession`+`finalizeMerge` pair for a stale row's own
  landing — it touches the worktree/branch (which belong to the CURRENT generation) and runs task-column/
  reingest bookkeeping that could race with the current generation's own, more authoritative finalize.
- Do not reuse `MERGE_RECONCILE_WEDGED_KEY`'s grace-period escalation policy (`mergeReconcileEscalateAttempts`/
  `mergeReconcileEscalateMs`) for this condition — a stale generation's own unresolved `merge_request` is
  a deterministic fact; waiting several boots to escalate only delays a nudge that will never resolve on
  its own. Escalate on first detection, via the dedicated `STALE_GENERATION_UNRESOLVED_KEY` tracker.
- Do not fold `STALE_GENERATION_UNRESOLVED_KEY`'s tracking into `MERGE_RECONCILE_WEDGED_KEY` — the two
  conditions are unrelated (not every entry in one is the other's cause), and a future reader must not be
  misled into assuming a repoKey problem where there is none.
- **(Round 2) Do not ever file a `merge_done` for a stale generation under the SHARED branch — not by
  tip-matching, not by any other heuristic.** A stale row's own landing has no safe DB-only resolution
  (Majors #1/#2 above); escalate it to a human instead. A future, generation-safe attribution mechanism
  (card `e5458ccd`) must key its own `merge_done` on something that does NOT alias the current
  generation's bookkeeping readers — never resurrect the round-1 shape verbatim.
- **(Round 2) Do not trust `recycledFrom` to identify a failed recycle successor — it gets NULLED on
  failure by design** (`@decision 4be56c33`/`f349f5cb`, all four sites). Use
  `Db.listFailedRecycleSuccessorIds()` (keyed on `recycle_failed.detail.failedSuccessorId`) instead, and
  exclude those ids BEFORE `currentGenerationIds`' head/lineage grouping, never after.
- **(Round 2) Do not judge a re-task/recycle-failure regression test by its END STATE alone** when two
  code paths can reach the same end state by different, wrongly-attributed actions (fixture K's own
  near-miss) — add a call-count/seam-based discriminator and RED-prove it against the pre-fix parent.
- **(Round 3) A new worker-recycle nulling path MUST write `recycle_failed.detail.failedSuccessorId`.**
  `listFailedRecycleSuccessorIds()` is the ONLY thing excluding a dead successor from
  `currentGenerationIds`' head/lineage selection; a nulling path that doesn't file this field leaves that
  dead successor looking like a genuinely fresh generation (its newer `createdAt` wins the tiebreak), the
  exact Major #3 regression this card's round 2 fixed.
- **(Round 3) Do not escalate a stale row's own `merge_request` without checking what followed it.** A
  bare `eventPresence.hasMergeRequest` check cannot tell a genuinely stuck landing apart from one already
  DECIDED by a real `merge_rejected`/`merge_cancelled` on record — read the worker's own chronological
  lifecycle trail and escalate only when the merge_request is still the LATEST such event.

Tests: `packages/daemon/test/worktree-recycle-alias-protection.mjs` fixtures K/L (Tier A/B repro + fix),
M/N (round 2: both escalate-only now; round 3: both also assert the real durable undelivered-nudge count,
not just the app_meta flag), O (round 2 Major #3: failed-recycle path alias), P (round 3 item 1: a
decided merge_request — merge_request then merge_cancelled — must never escalate), and a recycle-chain-tie
control; see that file's own header for the full list.
