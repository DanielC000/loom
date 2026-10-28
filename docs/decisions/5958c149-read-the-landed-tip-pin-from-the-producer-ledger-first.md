# 5958c149 — read the landed-tip pin from Loom's own synchronously-verified ledger first, never by widening the trailer reader

`readLandedTipTrailer` (`git/worktrees.ts`) stays STRICT, per `cc9bce38`'s own "Do not" and `45036494`'s
"Deliberately left STRICT" list: it has no independent, non-trailer verifier on its result, so it is
never a safe site to call `tolerantFindLoomTrailerBlock` from. Widening it was considered and rejected —
see the investigation in this card's own worker_report history (two checkpoints, both delivered live to
the manager before any code was touched).

The residual this left: a genuinely hook-displaced solo landing (the trailer's VALUE is correct, just not
in the message's final paragraph — exactly the "displaced" classification `verifyLoomTrailersExactAndReadable`
already distinguishes from a real forgery) that is later RE-DISCOVERED by a separate call (crash-recovery,
boot-reconcile Pass A, an idempotent re-confirm, or the in-confirm ALREADY_MERGED finish) rather than
consumed synchronously by the original squash's own in-memory pin, falls through to a legacy stable-tip
read (or nothing at all), and the branch is HELD permanently — with refusal text that used to claim "a
late commit landed" even when nothing had. Measured cost: fail-closed (never a wrong merge or deletion),
but a misleadingly-worded, human-intervention-requiring stuck state, narrower and more precisely
characterized here than `cc9bce38`'s own "RESIDUAL" note (that note covers a squash with NO trailer at
all; this card's population is specifically a displaced-but-correct one).

## The fix: a producer-side durable record, consulted before the strict trailer read

`mergeBranchLocked`'s `verifyLandedAsOwnCommit` (`git/worktrees.ts` ~11000) already proves, synchronously
and in-process (using Loom's own in-memory `resolvedBranchHead`, never a later re-read of the commit
message), that a landing's `Loom-Landed-Tip` value is genuine whenever it classifies "ok" (no
`trailerAdvisory`) or "displaced" — a value-tampering hook can never earn either classification, since
`verifyLoomNamespaceExact`'s underlying scan (`reservedNamespaceExactlyMatches`) is POSITION-INDEPENDENT
and compares VALUES; any wrong value classifies "forged" regardless of position.

`mergeBranch`'s return already carries this proof on every call (`landedTip: resolvedBranchHead`,
`landedBase`, `landedVerify`, `trailerAdvisory`) — `sessions/service.ts`'s existing
`recordMainlineLedgerEntryIfRepoUnchanged` call (right after `mergeBranch` returns, ~line 21460) is
extended with an optional `workerLandedTip` parameter, computed from that SAME in-memory result at that
SAME synchronous call site, and persisted onto a new nullable `worker_landed_tip` column on
`mainline_landed_commits` (`Db.recordMainlineLandedCommit`) — extending card `2a6a292a`/`aa7677fa`'s
existing Loom-owned ledger rather than inventing a second mechanism, since its write point (right after a
solo squash/ff succeeds, independent of the mainline tripwire's own verdict) IS the same verified moment.

`heldRecordedTip` and `pinnedTipForLandedSquash` (`sessions/service.ts`) now consult
`Db.getVerifiedLandedTip(projectId, repoKey, branch, tip)` FIRST, matched on the FULL key — never "latest
row for branch" — before ever calling `readLandedTipTrailer`. A miss (no row, a NULL column, or a scope
whose rows were cleared by a rebind/project-delete) falls through to EXACTLY today's strict-trailer
behavior, byte-identical to before this card.

## Why the row-write gate and the new-column gate are deliberately DIFFERENT conditions

A row is written (unchanged from before this card) whenever `merge.landedBase` is truthy — this covers
"ok", "displaced", AND "unreadable" (see `verifyLandedAsOwnCommit`'s own three non-forged outcomes).
`worker_landed_tip` is gated STRICTER: only "ok" or "displaced", explicitly excluding "unreadable" (per
manager ruling, gen 451) — an "unreadable" landing still gets an ordinary ledger row, just with this one
column NULL, and so still falls through to the strict trailer read exactly as before. "Unreadable" means
the reserved-namespace SCAN found the right values with nothing wrong structurally, yet the real reader
(`parseLoomTrailerBlock`) still can't round-trip them — a subtly different, less-understood corruption
shape than a hook simply appending a paragraph, and deliberately not trusted here.

## projectId threading — a mechanical plumbing change, not a new capability

`isBranchHeld`, `heldRecordedTip`, `resolveOwedRange`, `reviewedTipVerdict`, `tipAcrossLandedCheck`, and
`pinnedTipForLandedSquash` each gained an optional `projectId` (and, for the latter two, `repoKey`)
parameter, threaded from the single real `projectId` already in scope at every caller that invokes them
for a SPECIFIC project/worker (review, confirm, finalize, boot-reconcile Pass A, `mergeBatchTracked`'s
assembly). One call site deliberately did NOT get it: boot-reconcile Pass C's cross-project branch-ref
reclamation sweep (`sessions/service.ts`, the `heldBranches`/`isBranchHeld(b, repoPath, key)` loop) — it
iterates by repoPath, which can be shared by TWO projects, with no single correct `projectId` to pass at
that point. `isBranchHeld`'s own existing `inScope` filter never needed `projectId` either (branch names
are already globally unique via `sha256(taskId)`), so omitting it there leaves Pass C's behavior exactly
as it was before this card — no new capability lost, since that sweep never had the fast path to begin
with.

## Migration

`mainline_landed_commits` gains `worker_landed_tip TEXT` (nullable, no DEFAULT) via a new, idempotent
`Db.migrateMainlineLandedCommits()` (the same `PRAGMA table_info` + `ALTER TABLE ADD COLUMN` pattern every
other `migrateXxx()` in `db.ts` already uses), called from the constructor after `exec(SCHEMA)`. The
static SCHEMA's own `CREATE TABLE IF NOT EXISTS` text also carries the column (a no-op on an existing
table — purely for a fresh install's own single-step creation). No new index is added for this column:
every lookup matches the table's EXISTING `(project_id, repo_key, branch, tip)` index
(`idx_mainline_landed_commits_tip`) — load-bearing, because `exec(SCHEMA)` (and so every `CREATE INDEX IF
NOT EXISTS` it carries) runs BEFORE any `migrateXxx()`, so an index referencing a migration-added column
would throw on every existing install's very next boot, before the migration ever got a chance to add it.

A legacy row (written before this card, or by a batch landing, or by a solo landing that didn't reach
"ok"/"displaced") reads this column back as NULL — `Db.getVerifiedLandedTip` returns `null` uniformly for
"no row" and "row present, column NULL", and every reader already treats `null` as "fall through to the
strict trailer read." No special-cased backfill is needed or attempted.

`recordMainlineLedgerEntryIfRepoUnchanged`'s existing repoPath-changed-mid-flight skip (card `26c12fac`)
drops the WHOLE row, `worker_landed_tip` included, never a partial write — a skipped write reads back
ABSENT later, same as `26c12fac`'s own "only ever makes a future lookup more conservative" rule; never a
stale value from a different sha. Likewise, any future deletion of ledger rows (rebind, project delete —
both already exist today) leaves the same ABSENT-on-miss behavior; nothing added by this card changes
that.

## Wording

Three refusal sites distinguished "the landed tip is ABSENT" from "a late commit is POSITIVELY
identified" only implicitly, or not at all:

- `finishAlreadyMerged`'s `heldAtFinish` (`sessions/service.ts`) had ONE "else" branch covering BOTH a
  genuinely mismatching recorded tip (real evidence of a late commit) AND a null `recorded.tip` (nothing
  known either way) — now split: the null-tip case says the landed tip could not be verified from Loom's
  own record or a strict trailer, so nothing is known to be owed, and names the honest (inspect by hand)
  remedy, rather than asserting commits "landed on it after that merge... were never gated or landed."
- `resolveOwedRange`'s own ABSENT refusal text was reworded to the same phrasing for consistency.
- `describeSoloRetained`'s own ABSENT branch (the `tipUnverifiable`/`!liveTip-or-!landedTip` arms) was
  ALREADY correctly worded ("could not verify... landed unknown") — read and left unchanged; the
  positively-identified-mismatch branch there ("advanced after this merge landed... the later commit(s)
  are NOT on main") is correct where it fires and was also left unchanged.

## Correction — the ledger's own `branch` column is NOT the worker's branch

A real end-to-end test (`solo-landed-tip-ledger-fast-path.mjs`, scenario A) caught this immediately: the
original design matched `Db.getVerifiedLandedTip` on a 4-column `(project_id, repo_key, branch, tip)` key,
passing the WORKER's own branch at every reader call site (`heldRecordedTip`/`pinnedTipForLandedSquash`,
both only ever have the worker branch in scope). But `mainline_landed_commits.branch` was ALWAYS the
MAINLINE branch the landing went onto (`expectedMainlineBranch`, resolved from the project's stored
watermark) — the table's pre-existing purpose (`2a6a292a`/`aa7677fa`'s mainline-reachability walk) never
needed the worker's branch at all. Matching on the wrong value made the lookup miss on every real call,
silently falling through to the (unaffected, still-correct) strict trailer read — not a data-loss bug, but
it meant the whole fast path was dead code in production.

**Fixed by dropping `branch` from the match key entirely** — `Db.getVerifiedLandedTip(projectId, repoKey,
tip)`. This is not a weakening: `tip` is a content-addressed git object sha, written by exactly ONE
`recordMainlineLandedCommit` call per real landing (within a `(project_id, repo_key)` scope) — two
genuinely different landings cannot share one, so `tip` alone is already a sound, sufficient discriminator
for this lookup's purpose. Reusing the mainline branch as a 4th key column would have worked too, but
every reader call site would need `expectedMainlineBranch` threaded in alongside `projectId`/`repoKey` —
extra plumbing with no added safety.

## Lesson: a DB-level round-trip test cannot prove the real wiring

The migration test (`mainline-ledger-landed-tip-migration.mjs`) was written FIRST and passed cleanly
against the original (wrong) 4-column key — it calls `Db.recordMainlineLandedCommit`/`getVerifiedLandedTip`
directly, so it only ever exercised the exact key shape the test itself constructed, never the real
production call sites. Only the end-to-end test (`solo-landed-tip-ledger-fast-path.mjs`), which drives a
real `confirmWorkerMergeTracked` landing and inspects what the PRODUCTION code actually wrote and read,
caught the mismatch — because it is the only one of the two that exercises `heldRecordedTip`/
`pinnedTipForLandedSquash`'s own call, not a hand-constructed one. A DB-level round-trip test proves the
mechanism works in isolation; it says nothing about whether the real wiring ever reaches it correctly.
Keep both kinds for this reason, not as redundant coverage of the same thing.

## Multiple rows for one `(project_id, repo_key, tip)`

Investigated per manager ruling (gen 451, round 2): can a tip legitimately get more than one ledger row?
No DB constraint prevents it (no `UNIQUE` on `(project_id, repo_key, tip)`), so this is a write-path
property, not a schema one. There are exactly TWO call sites that ever write a row —
`sessions/service.ts`'s solo write (`recordMainlineLedgerEntryIfRepoUnchanged` call inside
`confirmWorkerMerge`, keyed off `merge.sha`) and its batch sibling (keyed off `result.batchHeadSha`) — and
both are gated on having JUST produced a verified NEW commit via `verifyLandedAsOwnCommit`/
`verifyCommitParentAndTree` against a FRESH `preCommitHead`/`stagedTree` capture taken immediately before
that exact commit. A retry of an already-landed confirm takes the ALREADY_MERGED/idempotent path instead
(no new commit is ever attempted — an already-matching tree stages empty), which never re-invokes either
write call site. `project_checkout_branch` and a rebind each only change WHICH scope/branch future
landings associate with; neither causes a past tip to be rewritten. The one theoretical collision
(a replayed commit with byte-identical parent+tree+author/committer identity+timestamp, which git would
genuinely treat as the same object) requires main to have been reset backward to an exact prior tip AND a
byte-identical re-commit within the same wall-clock second — not reachable through any path this card
touches, but not provably impossible given the lack of a DB constraint either.

**Decision: defend anyway, cheaply.** `Db.getVerifiedLandedTip` now fetches every matching row (never
`LIMIT 1`) and fails closed: every non-null value present must agree (vacuously true for zero or one
distinct value) to return it; any genuine disagreement returns `null` (exactly as if absent). Regression
test: `mainline-ledger-landed-tip-migration.mjs` scenario (f), seeding equal/conflicting/null+value/
all-null row pairs directly.

## Fix round (Code Review `8f8291c5`) — the CAS-pin reader's own test gap, and two wording/display fixes

Code Review `8f8291c5` found that `solo-landed-tip-ledger-fast-path.mjs`'s own scenario (E) — disabling
`pinnedTipForLandedSquash`'s ledger check reproduced the pre-fix stuck refusal — exercised only
`heldRecordedTip` (inside `isBranchHeld`), never `pinnedTipForLandedSquash` itself: (E)'s synthetic
`merge_branch_retained` event makes `isBranchHeld` return HELD before `finishAlreadyMerged` ever consumes
the `guard.expectedBranchTip`/`onBranchRetained` pair `pinnedTipForLandedSquash`'s own result feeds. The
reviewer confirmed this by disabling ONLY `pinnedTipForLandedSquash`'s ledger-check site
(`if (projectId && squashSha) {`) and observing (E) stay all-green.

**Fix: scenario (G).** Built with NO synthetic retain event at all, so `isBranchHeld` cannot short-circuit:
a displaced landing (the same DCO hook as scenario B), then a re-cut of the SAME branch at the TRUE
preSquashTip, then a LATE commit that reverts the file back to exactly main's content — a confirm against
this tip finds an EMPTY diff (ALREADY_MERGED), with `mergeBranch`'s own `landedTip` (the legacy fallback)
sitting at the POST-REVERT tip, never the tip actually landed. This is the `cc9bce38` late-revert hazard
by construction: GREEN (real ledger) pins the TRUE preSquashTip, which mismatches the live tip, so the
branch is correctly RETAINED; RED (ledger disabled, same monkeypatch style as (E)/(F)) falls through the
STRICT trailer read — ABSENT for a displaced commit, same as (B) — to the frozen legacy tip, which now
matches the live tip, so the CAS wrongly succeeds and the branch is silently DELETED, discarding the late
commit. Built TWICE (own repo per run, like (F)) so the GREEN run's own `merge_branch_retained` event (a
real side effect of its own retain firing) can never leak into the RED run and route IT into
`heldRecordedTip`'s path too.

Verified the test genuinely exercises this site (not just the DB-level mutation already in the committed
test): a throwaway source edit at `pinnedTipForLandedSquash`'s ledger-check condition (temporarily
`if (projectId && squashSha && (false as boolean))`, with non-null assertions to satisfy the compiler)
flipped exactly scenario (G)'s own GREEN checks to FAIL — nothing else in the suite — then reverted and
re-verified GREEN. This was a manual verification step only, never committed.

**Two secondary fixes found while closing this gap**, both in `mergeBatchTracked`'s `heldReason` (the
batch-side held-candidate wording): the THIRD arm (the final, non-transient, non-`ref-kept-after-finalize`
branch) used to append "its unreviewed commit(s) were never gated" unconditionally, even when
`h.assembledTip` is null (ABSENT) — asserting a late commit as a known fact when nothing is actually
known. Split the same way `finishAlreadyMerged`'s `heldAtFinish` already splits (see "Wording" above):
ABSENT now says "the landed tip could not be verified from Loom's own record or a strict trailer, so
nothing is known to be owed" with the honest by-hand remedy; a positively-identified tip keeps the
original wording. Separately, `retainedOutstanding`'s own `assembledTip` field now falls back to
`heldC.recorded.tip` (the SAME ledger/trailer-resolved value `isBranchHeld`'s own `heldRecordedTip` already
computed) when the retain event itself recorded neither `assembledTip` nor `landedTip` — so a
ledger-resolved solo hold displays the real tip instead of "landed unknown" purely because its ORIGINAL
retain event predates this card or never captured a tip at filing time. Regression: `batch-merge-retain-
hold.mjs`'s new `(absent)` case (a synthetic retain with no recorded tip at all, live phase) proves the
wording split; the `assembledTip` threading is a thin pass-through of an already-tested value
(`heldRecordedTip`'s own ledger-read path is covered by `mainline-ledger-landed-tip-migration.mjs` and
`solo-landed-tip-ledger-fast-path.mjs`) and was not given its own dedicated batch-level test — display/
wording only for that part.

Also fixed: `db.ts`'s `mainline_landed_commits` schema comment still said a reader "must match the FULL
key (project_id, repo_key, branch, tip)" — stale since the "Correction" section above dropped `branch`
from the match key. Reworded to `(project_id, repo_key, tip)` with an explicit pointer to that section.

**Merge-conflict note:** this round merged `main` forward (one conflict, in `reviewedTipVerdict`'s
`resolveOwedRange(...)` call — kept both this card's `projectId` argument and main's own `@decision
1e7d6956` comment immediately below it, from card `1e7d6956`'s unrelated chain-failure classification
work landing on `main` in the meantime). No `const owed` duplication; build + both of this card's own test
files passed before continuing.

## Do not

- Do not reuse scenario (E)/(F)'s synthetic-`merge_branch_retained`-event construction to test
  `pinnedTipForLandedSquash` itself — that construction makes `isBranchHeld` short-circuit
  `finishAlreadyMerged` before the reader's own result is ever consumed (exactly how (E) stayed all-green
  with the reader's own ledger check disabled). A test that means to exercise `pinnedTipForLandedSquash`
  needs a REAL ALREADY_MERGED finish with no pre-existing retain — see scenario (G)'s own construction.
- Do not run a GREEN-then-RED pair of this shape against the SAME branch/repo — a GREEN run's own
  `onBranchRetained` files a real `merge_branch_retained` event, which then holds that branch for every
  later confirm (`isBranchHeld` keys on branch NAME, not on which specific scenario build produced it),
  routing a later RED attempt back into `heldRecordedTip`'s path instead. Build each polarity in its own
  repo/project, like (F) and (G) both do.
- Do not append "its unreviewed commit(s) were never gated" (or any other positively-identified-mismatch
  wording) in `mergeBatchTracked`'s `heldReason` without checking `h.assembledTip !== null` first — an
  ABSENT tip is not evidence of anything, and the split exists exactly to avoid asserting it as a fact.
- Do not ever stamp `worker_landed_tip` from anything but `verifyLandedAsOwnCommit`'s synchronous,
  in-process result (`merge.landedTip`/`merge.landedBase`/`merge.trailerAdvisory`, read at the SAME call
  as the squash itself) — never from a later re-read or re-parse of the commit message, and never from
  `tolerantFindLoomTrailerBlock` or any other tolerant reader.
- Do not widen `readLandedTipTrailer` itself to accept a tolerant/displaced read. It stays strict, per
  `cc9bce38`'s own "Do not" and `45036494`'s "Deliberately left STRICT" list — this card's whole point is
  to close the gap WITHOUT reopening that question.
- Do not relax the `worker_landed_tip` write gate to also cover "unreadable" — that classification is
  explicitly excluded; widening it needs its own decision, not a silent loosening here.
- Do not add an index on `worker_landed_tip` inside the static SCHEMA string, or anywhere that would run
  before `migrateMainlineLandedCommits()` — see "Migration" above for exactly why that throws on every
  existing install.
- Do not read `Db.getVerifiedLandedTip`'s `null` as anything but "fall through to the strict trailer
  read" — never as a confirmed-absent landing, and never cache it as a terminal answer; a later call
  (after a future landing of the same branch) may find a row.
- Do not pass the WORKER's own branch to `Db.getVerifiedLandedTip`, and do not re-add `branch` to its
  match key — see "Correction" above for exactly why that column means something else entirely and
  silently makes the lookup miss always. Match on `(project_id, repo_key, tip)` only; never "latest row
  for a scope" (the query's own `ORDER BY id DESC LIMIT 1` exists only to pick deterministically between
  theoretical duplicate rows for the SAME tip, not to substitute for matching the exact tip asked about).
- Do not thread `projectId` into Pass C's cross-project branch-ref sweep without first widening
  `sweptRepoKeys` to carry a `(projectId, repoKey)` pair instead of a bare repoKey set — a single
  `projectId` is not meaningful there today; see "projectId threading" above.
- Do not change `Db.getVerifiedLandedTip` back to `LIMIT 1`/first-row-wins, and do not add a `UNIQUE`
  constraint as a substitute for the fail-closed read — the constraint would need a migration of its own
  and still wouldn't protect a pre-existing duplicate on an already-upgraded store; the read-side
  fail-closed check covers both without one.

Related: `docs/decisions/cc9bce38-solo-finalize-deletes-the-branch-only-at-the-landed-tip.md`,
`docs/decisions/45036494-batch-landing-and-displaced-trailer-discovery.md`,
`docs/decisions/f2b4d684-validate-landed-tip-trailer-at-producer.md`.
