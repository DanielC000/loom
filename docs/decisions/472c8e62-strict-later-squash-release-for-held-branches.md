# 472c8e62 — `findLaterBranchSquash` stays strict; the held-branch late-squash release gap is accepted, not fixed

Follow-up to `45036494`'s Code Review (reviewer `04cfeb36`), which flagged `findLaterBranchSquash`
(`git/worktrees.ts`) as the one `isBranchHeld` release check left with no independent, non-trailer
verifier (see that record's "Deliberately left STRICT" list). This card investigated whether that is a
real, reachable gap and, if so, whether it can be closed the same way `45036494`/`c13666c6` widened every
other trailer-reading call site: verifier-backed tolerant discovery. **Ruling: the gap is real and
reachable, but cannot be closed that way with today's ledger schema. Documented as accepted. No
production code changed.**

## 1. The reachable stuck shape

`isBranchHeld` (`sessions/service.ts:22038-22064`) has three ways to release a held branch, in order:
(1) an unreconciled `merge_done` event for the branch (line 22046); (2) the branch's current tip equals
the retain's own recorded tip (line 22059); (3) `findLaterBranchSquash(repoPath, branch, landedSha, ...)`
(line 22061) — a STRICT scan of `landedSha..HEAD` that only accepts a commit whose `Loom-Worker-Branch:
<branch>` trailer parses via `parseLoomTrailerBlock` (`git/worktrees.ts:582`), which only recognizes the
trailer block as the message's FINAL paragraph.

`mergeBatchTracked` routes EVERY batch-landed candidate — not just a stale retry — through
`finishAlreadyMerged` (`sessions/service.ts:23665`; the comment at 23620-23623 states this is
deliberate: "every landed branch here resolves ALREADY_MERGED by construction... none of them is a stale
retry"). The ONLY refusal `finishAlreadyMerged` can produce is `heldAtFinish` (service.ts:22317,
23683-23688: "the ONLY finishAlreadyMerged refusal is heldAtFinish... never push this candidate into
landed" — it lands in `finishRefused` instead), and `isBranchHeld` is the very first thing it calls
(service.ts:22317), BEFORE any finalize or `merge_done` write.

Concrete chain:

1. Branch B is retained once — e.g. the "pre-stop" tip-advanced retention (service.ts:23655-23658), which
   files a `batch_merge_branch_retained` event (`noteRetained`, service.ts:23642-23654) and `continue`s
   WITHOUT ever calling `finishAlreadyMerged` for that run. No `merge_done` is written for B at this point.
2. The worker keeps committing on B. A LATER landing attempt (another `merge_batch` run landing B, or a
   solo confirm resolving ALREADY_MERGED at service.ts:21826-21833) lands B's new content as a fresh
   squash/fast-forward commit on HEAD. Card `45036494` M1 established that both the solo and batch landing
   code deliberately keep a hook-displaced landing VERIFIED (not hard-failed) — the batch wiring is at
   service.ts:23616-23619 (`fileTrailerDisplacedAdvisory`). So this later landing genuinely succeeds at the
   git level even when a commit-msg hook moves its trailer out of the final paragraph.
3. At finalize time, `isBranchHeld` runs for B: check (1) finds nothing (finalize — the thing that would
   write `merge_done` — hasn't run yet; it's gated on this very check passing). Check (2) fails (B's tip
   has moved past the old retain's recorded tip, since more work landed). Check (3), `findLaterBranchSquash`,
   scans `landedSha..HEAD` for B's trailer — `afterSha` IS an ancestor of HEAD (the later landing descends
   from it), so the scan returns `"none"`, not `"error"`: the commit exists and is in range, the strict
   parser just can't see its displaced trailer.
4. `isBranchHeld` reports HELD. `finishAlreadyMerged` refuses the candidate that main has just, verifiably,
   actually landed. The worktree/branch are never cleaned up, the task never moves, and — since the SAME
   hook displaces every later landing attempt's trailer the same way — this is a durable stuck state, not
   a one-shot glitch.

## 2. Fail-closed: this is a liveness gap, never a correctness one

A held branch is never WRONGLY released by this gap — the failure mode is staying held when it should
have released. Main's content, and every other call site's forgery protection, are untouched. The cost is
a human-visible stuck card requiring manual attention, not a wrongful merge or a lost commit.

## 3. Why verifier-backed tolerant discovery (the fix every other site got) does not apply here

The natural fix — mirroring `45036494`/`c13666c6` — would widen `findLaterBranchSquash` to also try
`tolerantFindLoomTrailerBlock`'s discovery (via `findAllLandedTrailerCommits`, `git/worktrees.ts:8241`,
already tolerant per `45036494`), gating any tolerant-only match on Loom's own `mainline_landed_commits`
ledger instead of trusting the trailer text alone. This was the shape the manager approved after the
original checkpoint. It does not work, for a reason specific to this call site:

- **The ledger has no column that identifies the WORKER branch.** `mainline_landed_commits`
  (`db.ts:1553-1562`) carries `branch`, `tip`, `base`, `worker_landed_tip`. `branch` is documented (schema
  comment `db.ts:1548-1549`; `getVerifiedLandedTip`'s own doc, `db.ts:4141-4143`) to be the MAINLINE
  branch landed ONTO, not the worker's branch — confirmed at both write sites (`recordMainlineLedgerEntryIfRepoUnchanged`'s
  callers): service.ts:21526 passes `expectedMainlineBranch`, service.ts:23337 passes `expectedBaseBranch`.
  It is effectively a repo-wide constant, with no discriminating power between worker branches.
  `worker_landed_tip` is a SHA, not a name, and is NULL for every batch row (`db.ts:4125-4126`: "Omitted
  (batch, or a solo landing short of that) writes NULL") — exactly the case this card's repro exercises.
  A batch also writes ONE ledger row per `merge_batch` op (`tip` = the batch's own final fast-forwarded
  head, service.ts:23337), not one row per candidate branch, so even sha-identity alone cannot say which
  of several batched candidate branches a given intermediate commit belongs to.
- **The other existing ledger verifier is branch-independent by design.** `classifyAgainstLedgerUncached`/
  `verifyGoneBranchLanding` (`c13666c6`) proves a candidate sha is a genuine first-parent member of SOME
  real Loom-landed row's range — never that it belongs to a landing of branch B specifically. `c13666c6`'s
  own "Do not" rules out keying any branch-gone decision on a branch-qualified walk
  (`Db.isMainlineLedgerReachable`) for exactly this reason: "an intra-batch intermediate commit never is"
  a recorded tip.
- **The decisive finding (manager's own correction during review of this card):** the commits inside a
  ledger row's own `(base, tip]` range, for a BATCH landing, are the workers' OWN commits, landed
  verbatim — their messages are worker-AUTHORED text, not text Loom's merge code constructed. A genuine
  row member can therefore itself carry a self-consistent `Loom-Worker-Branch: B` block in a non-final
  paragraph — exactly where the tolerant parser looks, and not necessarily the paragraph
  `stripReservedLoomTrailerLines` strips. The writer invariant (`verifyCommitParentAndTree`, checked at
  write time by both landing paths — `c13666c6`'s "Do not" #2) proves a candidate commit is genuinely
  Loom-LANDED (a real member of a verified row); it does NOT prove the commit's own TRAILER TEXT is
  Loom-AUTHORED. A worker's own commit, landed verbatim as part of a real batch, can carry text naming a
  DIFFERENT branch than the one it actually belongs to, and the ledger's range-membership check has no way
  to catch that — it is pure git ancestry, never trailer content. (This closes a gap in this card's own
  earlier investigation, which had assumed Loom's merge code always constructs the trailer itself — true
  only for the squash/assembly commit itself, not for a worker's own pre-existing commits landed verbatim
  into a batch's range.)

### Options considered and rejected

- **Accept the branch-independent ledger proof as sufficient anyway.** Rejected — see the decisive
  finding above: it would accept a forged-looking (but genuinely worker-authored) trailer naming the wrong
  branch, landed verbatim as part of someone else's real batch.
- **Add a `worker_branch` column to `mainline_landed_commits`, written by the same trusted in-process call
  sites, plus restructure batch's ledger write from one row per `merge_batch` op to one row per landed
  candidate branch.** This is the only sound fix route — it would let a reader positively tie a candidate
  sha to the specific worker branch it landed, closing the gap for real. Rejected FOR NOW: it is a schema
  migration plus a batch-write-path redesign, for a liveness-only, fail-closed gap with no observed
  incident. A future card can pick this up if the gap is ever actually hit in production — see "Do not"
  below for what such a card must preserve.
- **Narrow the fix to the solo case only** (where `worker_landed_tip` is at least sometimes non-null).
  Rejected — it still accepts on sha plus worker-authored (therefore forgeable-in-effect) trailer text,
  just with a smaller blast radius; the same decisive finding applies to a solo landing's own worker
  commits whenever more than one commit lands (the pathset/trailer-only tiers already distinguish
  single-commit squashes from a worker's own history being carried through).

## 4. Human recovery path today (read from the code, not guessed)

The exact refusal a manager sees in this situation is `finishAlreadyMerged`'s own `heldAtFinish` text
(`sessions/service.ts:22325-22333`). For the specific case this card investigated — `recorded.tip` present,
`findLaterBranchSquash` returns `"none"` (not a transient `"error"`) — the refusal reads:

> "branch \<branch\> is HELD: a merge (a merge_batch or a solo worker_merge_confirm) retained it because
> commit(s) landed on it after that merge fixed its tip, and main carries no later Loom-Worker-Branch
> commit for it, so those were never gated or landed. Nothing was finalized or deleted. Review it with
> worker_merge (its `lateRange` shows the commits added after the landing), then land it with
> worker_merge_confirm, which lands exactly that late range (a real landing releases the hold). You reach
> THIS refusal instead when the finish found the branch's work already on main without landing the late
> range (a card sitting in the terminal column, or a late range that nets to nothing against main):
> inspect the branch and cherry-pick what is still owed onto a follow-up card's worker. The branch stays
> held until a real merge_done, a later Loom-Worker-Branch squash on main, or the branch tip returning to
> the tip that landed."

This card's own repro is exactly the "late range nets to nothing against main" case named in that text
(the content is already, genuinely on main) — so the documented remedy is: inspect the branch by hand,
confirm nothing is genuinely owed, and close it out manually (cherry-pick anything that IS still owed onto
a follow-up card's worker; otherwise delete the stale branch/worktree and close the task by hand). The
one thing that WOULD release it automatically is a worker committing genuinely NEW content on the branch —
that routes through the ordinary GREEN confirm path (`sessions/service.ts:21836-21869`), which calls
`finalizeMerge` directly and never consults `isBranchHeld` at all, so it is immune to this gap and writes
a real `merge_done` on success, which then also releases the OLD hold via `isBranchHeld` check (1).

## 5. `BatchLandedBranch.pathSetStamped` (also raised by `45036494`'s Code Review)

Checked, no code change. `lb.pathSetStamped` (from `runBatchedMerge`'s `result.landed[]`,
`git/batch-merge.ts:147,222,654,987,1030,1089,1276`) is read exactly ONCE, at
`sessions/service.ts:23632`, to derive the local `mergedVerification` tier (`"pathset"` /
`"trailer-only"` / `null`). It is never copied onto the `landed.push({...})` entries at service.ts:23657
or 23693, and is not part of the `landed` array's declared shape (service.ts:23608) — grepped
`packages/daemon/src` for every reader of `.pathSetStamped` and found only its two writers in
`batch-merge.ts` and this one reader. Only the derived `mergedVerification` ever reaches a caller
(persisted onto the task's ship-state via `finalizeMerge`/`finishAlreadyMerged`); the raw field itself
never does. No behavioral gap: `mergedVerification` already carries the signal any real consumer needs.
No action taken.

## Do not

- Do not widen `findLaterBranchSquash` to accept a tolerant-only match verified solely by
  `classifyAgainstLedgerUncached`/`verifyGoneBranchLanding`'s branch-independent range-membership check —
  see §3's decisive finding: a genuine row member's own trailer text is worker-authored for a batch
  landing (and can be, for a solo landing carrying more than one commit), not Loom-authored, so
  range-membership alone does not prove the trailer names the right branch.
- Do not match `mainline_landed_commits.branch` against a worker branch name to "tie" a row to it — that
  column is the MAINLINE branch landed onto (see `db.ts:1548-1549`, `db.ts:4141-4143`), not the worker's;
  matching it against a worker branch name makes the lookup miss always (the same rule `5958c149`
  established for `getVerifiedLandedTip`).
- Do not treat `worker_landed_tip` as branch-identifying on its own — it is a sha (the worker branch's own
  head at squash time), it is NULL for every batch row, and even where present, tying it to a specific
  branch name needs an independent ancestry check against that branch's own git history (a content check,
  not a ledger-only decision).
- If a future card implements option A (a `worker_branch` column + per-candidate batch ledger rows): do
  not write it from anything but the SAME trusted, in-process call sites that already write
  `worker_landed_tip`/`branch` today (`recordMainlineLedgerEntryIfRepoUnchanged`'s callers,
  service.ts:21526/23337) — never derived from trailer text, or it reopens the exact self-referential
  forgery surface `c13666c6` closed for the branch-gone arm. Restructuring the batch write to one row per
  landed candidate branch is required for the column to mean anything in the batch case; a single
  batch-wide row with a single `worker_branch` value would be just as wrong as today's branch-independent
  check.
- Do not read this record as saying `findLaterBranchSquash`'s gap was fixed — it was investigated and
  explicitly left strict. See `docs/decisions/45036494-batch-landing-and-displaced-trailer-discovery.md`'s
  own "Round 7" section (added by this card) for the pointer back the other way.
