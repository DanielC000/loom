# e8d4fdc3 — detect an already-landed branch via a ledger fallback when trailers are off, in a table the mainline trust walk never reads

From 9a5d040c's Code Review (reviewer `2cff9dec`, 2026-11-02). With `orchestration.commitTrailers:"off"`,
`findLandedSquashCommit` (`git/worktrees.ts`) is purely a `git log --grep=Loom-Worker-Branch:` walk — no
trailer was ever written, so it always returns `null`. That broke the solo re-confirm path
(`confirmWorkerMerge`'s `preLanded` lookup, `sessions/service.ts`), boot-reconcile Pass A
(`findLandedSquashCommitViaMap` falling back to `findLandedSquashCommit`), and the batch path
(`landBranchCommitsIndividually`'s own `mergeBase === branchTip` branch, `git/batch-merge.ts`) — all three
misclassified a genuinely-already-landed branch as `STAGE_EMPTY_RETRY`, which (decision `1550eb87`) is a
HARD, cached `orphaned_zero_ahead` refusal with wrong cherry-pick advice for a worker that reported done.

## The fix

`findLandedSquashCommit` now falls back to a ledger lookup whenever its own trailer walk finds nothing:
resolve the branch's own LIVE tip (`git rev-parse --verify refs/heads/<branch>`; a gone branch has nothing
to look up, so this fails closed exactly as before), consult `deps.workerTipLedger.lookupByWorkerTip`, and
— on a hit — re-verify the returned sha is still an ancestor of `base` via a plain `merge-base` compare
(never `--is-ancestor`; see decision `0eaaa693`'s own "Do not": simple-git's `raw()` reads that
subcommand's non-zero exit as success with empty output). `findLandedSquashCommitViaMap`'s own
`scanComplete` shortcut (a confirmed-empty trailer scan) gets the identical fallback, so it is never
silently narrower than the function it wraps.

Fixing it inside `findLandedSquashCommit`/`findLandedSquashCommitViaMap` themselves means solo,
boot-reconcile Pass A, and the batch path's own call (`landBranchCommitsIndividually` already threads its
`deps` straight through) all share ONE fallback — "one helper, not two," per the card's own instruction —
with each caller only needing to thread a new `workerTipLedger` facts object alongside the existing
`goneBranchLedger` one.

## The trust-ledger constraint — a SEPARATE table, never `mainline_landed_commits`

`mainline_landed_commits`'s own `tip`/`base` chain is what `Db.isMainlineLedgerReachable` walks for
mainline-watermark TRUST (card `aa7677fa` rounds 19-21, `docs/decisions/2a6a292a-*.md`). That walk's whole
soundness rests on every row being a genuine, Loom-code-authored, real former state of the MAINLINE
branch's own tip — round 20's own "Do not" list is explicit that nothing may write a row there from a
retroactive, git-content-equivalence-based classification (exactly what a batch per-branch landing would
be: each branch's own cherry-picked sub-range is never literally checked out as mainline's own HEAD at any
real point — only the batch's single `baseMainSha -> batchHeadSha` fast-forward ever is).

So this card's own write for the BATCH side could not reuse that table for a per-branch row at all, and
needed a genuinely separate, trust-walk-inert store: `batch_landed_worker_tips` (`project_id, repo_key,
worker_landed_tip, landed_sha, landed_at`), written via `Db.recordBatchLandedWorkerTip` immediately after
`runBatchedMerge`'s own orchestration loop (`sessions/service.ts`) sees a GENUINELY fresh, non-noop landed
branch — never for a noop/already-merged classification, the same purity bar `mainline_landed_commits`'s
own `worker_landed_tip` column is held to for solo (card `5958c149`).

For SOLO, no new write was needed: `mainline_landed_commits.worker_landed_tip` already exists and is
already stamped unconditionally on every successful solo landing (card `5958c149`), independent of
`commitTrailers`, and the trust walk never reads that column (it only ever reads `tip`/`base`) — so adding
a REVERSE read of an EXISTING, already-safe column (`Db.getLandedCommitByWorkerTip`) needed no new write
and no new table at all. `Db.getWorkerTipLedgerFacts` is the one construction point that consults BOTH
sources (solo's column, batch's separate table) for the same worker tip, failing closed on a disagreement
between them — mirroring `Db.getGoneBranchLedgerFacts`'s own facts-bundle shape.

## Named residual — the kill-unconfirmed-then-retry race is NOT closed by this fix

The card's own body names three rare triggers: "a kill-unconfirmed commit plus a retry, a throw after the
commit, or a crash between commit and finalize." The ledger write (`recordMainlineLedgerEntryIfRepoUnchanged`,
`sessions/service.ts`) only runs AFTER `mergeBranchLocked`/`confirmWorkerMerge` observes `merge.ok === true`
— so a squash that may have silently succeeded underneath an unconfirmed-tree-kill quarantine (the catch
branch this card's own `retryOutcome` wording fix touches, `git/worktrees.ts`) never reaches that write
either, trailers on or off. For THAT specific race, neither the trailer walk nor this card's own ledger
fallback has anything to find — the retry's own `!staged` content check still prevents a duplicate commit,
but the CLASSIFICATION can still surface as the hard `orphaned_zero_ahead` refusal. The `retryOutcome` text
is corrected to say so plainly rather than promise a soft no-op this fix cannot deliver for that one race.

## Do not

- Do not write a per-branch row into `mainline_landed_commits` for a batch landing, ever — see "The
  trust-ledger constraint" above. A future reader proposing this needs to re-derive, and refute, the exact
  argument above (non-genuine mainline-tip states entering a chain the trust walk assumes is 100% real).
- Do not stamp `batch_landed_worker_tips` (or extend `mainline_landed_commits.worker_landed_tip`) from a
  retroactive/already-merged classification — only a GENUINE, just-executed, non-noop land may write
  either, the same bar card `aa7677fa` round 20 holds the mainline ledger to.
- Do not call `Db.isMainlineLedgerReachable`, `advanceMainlineWatermark`, or `advanceMainlineWatermarkForBatch`
  from anywhere in this fallback's own code path, and do not let a future refactor merge
  `batch_landed_worker_tips` into `mainline_landed_commits` on the theory that "it's the same shape" — the
  shared columns are coincidental, not a schema relationship.
- Do not widen `tryWorkerTipLedgerFallback`'s ancestry re-verify to `--is-ancestor` — see decision
  `0eaaa693`'s own "Do not" for why that silently never refuses under simple-git's `raw()`.
- Do not assume this fallback helps the kill-unconfirmed-then-retry race named in the card body — see
  "Named residual" above; it is a materially different gap this card does not close.
- Do not read `BatchLandedBranch` (the assembled result `runBatchedMerge`/`landBranchCommitsIndividually`'s
  caller sees) as carrying an `emptyKind` field — it doesn't; only the raw per-call `LandResult` does. A
  test asserting ALREADY_MERGED on the assembled result must check `sha` (set only on the ALREADY_MERGED
  arm) rather than a nonexistent `emptyKind` key — a real specimen of this exact mistake is in this card's
  own test-authoring history (scenario (5), `commit-trailers-batch-merge.mjs`), caught before merge by
  comparing the printed `got:` value against the assertion rather than trusting a clean exit code alone.

Related: `docs/decisions/5958c149-read-the-landed-tip-pin-from-the-producer-ledger-first.md`,
`docs/decisions/2a6a292a-mainline-watermark-branch-change-only-on-a-trusted-signal.md` (rounds 19-21),
`docs/decisions/0eaaa693-fork-point-ancestry-check.md`.

## Round 2 — CRITICAL: the fallback matched on worker TIP ALONE, never the BRANCH

From round 1's own Code Review (reviewer `2cff9dec`). `tryWorkerTipLedgerFallback`/`WorkerTipLedgerFacts.lookupByWorkerTip`
took only a worker tip, and `Db.getLandedCommitByWorkerTip`/`getBatchLandedWorkerTip` matched purely on
`(project_id, repo_key, worker_landed_tip)`. That's unsound regardless of `commitTrailers` — it runs
whenever `findLandedSquashCommit`'s own trailer walk finds no candidate FOR THIS BRANCH, trailers on or
off (**correcting round 1's own framing below**).

Production shape: a REVIEW FORK. `worker_spawn`'s `reviewOf*` cuts a fresh branch at the reviewed branch's
own `headSha`. When the reviewed branch lands (trailers ON), the ledger stamps `worker_landed_tip =
headSha`; the review fork's branch has that SAME tip, but is a genuinely different, still-unmerged branch.
Reproduced end to end (real `Db`, git, `SessionService`): boot Pass A finished the review fork's own card
as merged with the REVIEWED branch's sha, and deleted its worktree and branch. A worker can also forge
this directly — `git branch -f loom/<self> <any landed worker tip>` through the shared `.git` — and get
its own card finalized and its worktree deleted.

### The fix

Both `mainline_landed_commits` (migration `ADD COLUMN worker_branch`, nullable — a legacy row's NULL value
can never equality-match a real branch name, so it fails closed for free) and `batch_landed_worker_tips`
(added directly to the CREATE TABLE, `NOT NULL` — this table is new on this still-unreleased branch, so
every writer always has the branch in hand) now carry the worker's own branch alongside its tip.
`Db.getLandedCommitByWorkerTip`/`getBatchLandedWorkerTip`/`getWorkerTipLedgerFacts.lookupByWorkerTip` all
match on `(branch, workerTip)` TOGETHER; a tip match with the wrong branch is simply absent. Both write
sites (`recordMainlineLedgerEntryIfRepoUnchanged`'s solo call, `recordBatchLandedWorkerTip`'s batch call)
now thread the worker's own branch through. `mainline_landed_commits.tip`/`base`/`branch` (the MAINLINE
branch column) and the trust walk (`Db.isMainlineLedgerReachable`, `advanceMainlineWatermark{,ForBatch}`)
are UNCHANGED — verified by reading `isMainlineLedgerReachable` directly: it selects only `base` scoped by
`(project_id, repo_key, branch, tip)`, never touching `worker_landed_tip`/`worker_branch` at all, so a new
nullable column alongside it cannot alter that walk's behavior.

### Boot-cost fix (reviewer Minor)

`WorkerTipLedgerFacts` gained `hasAnyForBranch(branch)` — a cheap DB-only pre-check (no tip argument, no
git call) consulted FIRST in `tryWorkerTipLedgerFallback`, before its `rev-parse`. Only a branch with at
least one ledger row (solo or batch) now pays for the `rev-parse` + `merge-base` pair; the not-yet-landed
population — the overwhelming common case on every `findLandedSquashCommitViaMap` `scanComplete` miss, one
call per residual boot-reconcile Pass A session — costs zero git spawns, same as before this fallback
existed at all.

### Honesty correction — the batch-merge.ts:482 call site's fallback is UNREACHABLE in production

Round 1 claimed "fixed here" at `landBranchCommitsIndividually`'s own `mergeBase === branchTip` arm
(`git/batch-merge.ts`). That arm's ledger fallback is never actually exercised by a genuine landing: a real
cherry-pick always produces a NEW commit distinct from the worker branch's own pre-landing tip
(`branchTip`), so `mergeBase === branchTip` can only be true when `branchTip` was never cherry-picked at
all — not the shape a real re-submitted, already-landed branch leaves behind. Round 1's own test scenario
(5) (`commit-trailers-batch-merge.mjs`) proved only that the code PATH is reachable, not that production
can ever reach it: it seeded `baseMainSha` (main's own tip) as a fabricated `workerLandedTip` via a
throwaway branch ref pinned directly to it — a shape no real `recordBatchLandedWorkerTip` call ever
produces (the real call always records a worker branch's own pre-cherry-pick tip, via `lb.branch`/
`lb.assembledTip`). Scenario (5) is corrected to seed exactly what production writes and to exercise the
ledger fallback through `findLandedSquashCommit` directly, against a REAL batch-landed branch whose
finalize never ran (the branch and its worktree still live, as `findLandedSquashCommitViaMap`'s own Pass A
caller and the solo re-confirm path both see it) — the fallback's actual production coverage. The code
comment at `batch-merge.ts`'s own call site states this plainly; `deps.workerTipLedger` stays threaded
there only for call-site consistency with every other `findLandedSquashCommit` caller, not because that
line exercises it.

### Correcting the "trailers-ON is byte-identical" claim

Round 1's own body framed this fallback as a `commitTrailers:"off"` fix. That framing was never quite
right, and round 2's own production repro proves it: the fallback is reached whenever the trailer walk
finds no candidate FOR THIS BRANCH — which happens with trailers ON too, whenever a branch legitimately
carries no `Loom-Worker-Branch:` trailer of its own (a review fork that was never itself landed is exactly
this case). Before round 2, reaching the fallback with trailers ON was unsafe (the tip-only match let an
unrelated branch resolve as landed); after round 2's branch-keying, reaching it with trailers ON is SAFE —
a tip match now requires the SAME branch too. `commit-trailers-solo-merge.mjs`'s own scenario (C) is still
valid as written (its fixture branch carries a REAL trailer, so the trailer walk resolves it on the first
try and the fallback genuinely is never reached there) — but do not generalize that one scenario's result
into "trailers ON never reaches the fallback"; it can, and after round 2 it does so safely.

## Do not (round 2 additions)

- Do not match `getLandedCommitByWorkerTip`/`getBatchLandedWorkerTip`/`WorkerTipLedgerFacts.lookupByWorkerTip`
  on `workerTip` alone, ever again — see "The fix" above for the review-fork forgery this reopens.
- Do not skip `hasAnyForBranch`'s own pre-check inside `tryWorkerTipLedgerFallback` — see "Boot-cost fix"
  above; skipping it reopens the per-residual-session `rev-parse` spawn cost Pass A's own doc forbids.
- Do not describe `batch-merge.ts`'s `mergeBase === branchTip` arm as exercising the ledger fallback in
  production — see "Honesty correction" above; it is structurally unreachable there.
- Do not generalize `commit-trailers-solo-merge.mjs` scenario (C) into "trailers ON never reaches the
  ledger fallback" — see "Correcting the … claim" above; it can, and does so safely post-round-2.
