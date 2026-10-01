# b801bad0 — the batch fast-forward pins the checked-out branch, and re-verifies it after landing

## Narrative

`fastForwardCanonicalMain` (`git/batch-merge.ts`) already took `withCanonicalIndexLock` around its HEAD
check + `git merge --ff-only` (round 6 of card `24c0bdba`), so a `GitWriter.checkout`/`createBranch`/
`commit` call can no longer INTERLEAVE with the fast-forward itself. That closed the concurrency race, but
left a narrower gap: the forfeit check before this card compared only `currentMainSha` to `expectedBaseSha`
— a `git checkout -b <name>` run entirely BEFORE this function ever acquires the lock (e.g. during the
batch's own gate run, which can take many minutes and does NOT hold the lock) moves canonical HEAD to a
brand-new branch pointing at the SAME commit. The sha-only check cannot see this: `currentMainSha` still
reads as `expectedBaseSha`, so the forfeit check passes, and `git merge --ff-only targetSha` then succeeds
— on the DIVERTED branch, not mainline. `fastForwardCanonicalMain` would report `{ok:true}` while the
batch's landed content sits on a stray branch, unreachable from mainline, with mainline's own ref
untouched forever.

The fix pins the branch identity too: `BatchGitDeps.expectedBaseBranch` carries the branch canonical HEAD
was checked out on when `baseMainSha` was resolved (service.ts, right before the batch's gate runs), via
`readMainlineHead`. `fastForwardCanonicalMain` checks it TWICE — once before the `--ff-only` merge (refusing
without ever mutating canonical, the cheap and safe place to catch a pre-existing divert) and once after an
apparently-successful merge (`verifyLanded`, re-reading both HEAD's sha and the checked-out branch) — so a
divert that somehow still landed content on the wrong branch is caught before being reported `ok:true`,
not just a divert that was already in place. Both refusals are typed `branchDiverted: true`, distinct from
`forfeited` (a real main sha advance) and `quarantined`.

`expectedBaseBranch` is OPTIONAL, mirroring `mergeBranchLocked`'s own optional `expectedBranchTip`: a
caller (or test) that passes none keeps the pre-card sha-only behavior unchanged. `verifyLanded` itself is
gated the same way — `deps.expectedBaseBranch === undefined` short-circuits to `{ok:true}` before any extra
git call, so a caller that doesn't pin a branch pays NOTHING for this card.

## Round 2 — spawn-count measurement and reduction

Round 1 shipped with a separate `rev-parse HEAD` and `symbolic-ref HEAD` call at each of three sites
(service.ts's `baseMainSha` resolution, the pre-check, `verifyLanded`'s post-check) — +4 git subprocess
spawns per successful batch landing versus pre-card code, whenever a branch is pinned (which production's
`mergeBatchTracked` always does). Measured directly (`batch-guard-release-on-throw.mjs`, which drives the
REAL `mergeBatchTracked` path, 3 paired runs, same host, sequential, same session): base (pre-card,
718b47ce) mean 44826ms; round-1 branch mean 55760ms — every branch run slower than every base run,
+24.4%. A sibling file with the same shape, `batch-merge-branch-advanced-during-gate.mjs`, showed no
consistent difference (within noise) — confirming the cost was specific to branch-pinned call sites, not
general host variance. Not lock contention — the lock's own hold duration is unchanged; it is real
subprocess spawn cost (Windows git.exe spawn overhead through simple-git), ~310ms/call at the measured
scale.

Fix: `git/mainline-watch.ts`'s `readHeadShaAndBranch`/`parseHeadShaAndBranch` combine the sha and branch
reads into ONE spawn: `git rev-parse HEAD --symbolic-full-name HEAD` — line 1 the sha, line 2
`refs/heads/<branch>` or the literal `HEAD` (detached). **Verified directly, and this matters**: a flag
like `--symbolic-full-name` applies to ALL subsequent rev args, not just the next one — `git rev-parse
--symbolic-full-name HEAD HEAD` (flag FIRST) prints the symbolic form TWICE, not sha-then-ref. Putting the
flag AFTER the first arg (`git rev-parse HEAD --symbolic-full-name HEAD`) is what actually yields
sha-then-ref, confirmed in both attached and detached states. `readMainlineHead` itself now calls this same
helper (one spawn, down from two) — a free win everywhere it's used, not just this card.
`fastForwardCanonicalMain`'s forfeit-sha-check and the branch pre-check now share ONE call (down from two);
`verifyLanded`'s post-check is similarly one call (down from two). Net: +1 spawn per landing versus pre-card
code, not +4.

## A branch-level fast-forward refusal runs NO per-candidate fallback

A real `branchDiverted` refusal must NOT fall into the ordinary per-candidate solo fallback
(`confirmWorkerMergeTracked`): the solo path (`mergeBranchLocked`, `git/worktrees.ts`) pins only the SHA via
its own `expectedBranchTip`, never the checked-out branch — so a fallback squash here would land onto the
SAME stray branch `fastForwardCanonicalMain` just refused to advance onto, and (via
`findLandedSquashCommit`'s own ALREADY_MERGED detection) a later confirm could even find this batch's own
content already sitting there and finalize the card as merged, though mainline never got it.
`mergeBatchTracked` (`sessions/service.ts`) treats `result.branchDiverted` exactly like `quarantined`/
`cancelled`: no per-candidate fallback runs at all (`runFallback`'s no-start mode), every candidate reports
`started:false`, and a durable `batch_merge_branch_diverted` event is filed naming the expected and observed
branch.

A failed POST-ff re-read (the `--ff-only` itself did not throw, so the landing most likely DID happen, only
`verifyLanded`'s own confirmation read failed — e.g. a transient timeout) is typed distinctly, `unverified:
true`, never `branchDiverted: true` — a confirmed divert implies something is actively wrong with the
checkout, while an unverified one implies only that THIS read failed. `mergeBatchTracked` treats it the
SAME way as `branchDiverted` for the no-fallback decision (a per-candidate fallback here risks a second,
divergent landing on top of content that's probably already on main), but records and surfaces it as a
DISTINCT, less alarming outcome: a durable `batch_merge_ff_unverified` event, and a human confirms with a
plain `git log` rather than treating it as a confirmed security-relevant divert.

## Round 3 (fix round) — the watermark-preferred pin, caching, and manager guidance

A prior fix round (Code Review MINOR 4) made the branch half of the pin prefer the STORED mainline
watermark over the live read taken at batch-cut time, to catch a divert that PREDATES the cut (a live read
alone would capture the already-diverted branch as "expected" and silently agree with itself). That
preference is now **REVERTED**: `checkMainlineMove` (`sessions/service.ts`) re-stamps the watermark to
WHATEVER branch is currently checked out on any branch CHANGE, silently, on "first sight" of that branch —
including the very stray branch a batch's own divert refusal just correctly caught, since that check runs
mid-batch (after the gate closure, before the fast-forward) while canonical is still diverted. A
watermark-preferred pin therefore lasted exactly ONE batch: the NEXT batch's cut read the now-corrupted
watermark and either spuriously refused (canonical back on mainline, the stale pin still said stray) or
fast-forwarded onto the stray branch (canonical still diverted, the stale pin now agreed with it). The pin
is back to a pure live read (`readMainlineHead` at cut time, logged — never silently degraded — when
unavailable); card `2a6a292a` owns closing the re-stamp gap, after which the watermark preference can be
reintroduced.

`branchDiverted`/`unverified` are classified distinctly in `mergeBatchTracked`'s `classifyOutcome`
(`"branch-diverted"`/`"ff-unverified"`, never a bare `"rejected"`) and added to `NEVER_CACHED_OUTCOMES`
(`orchestration/pending-ops.ts`) — both are facts about the CANONICAL CHECKOUT at fast-forward time, not
about the resolved candidate branches, so a cached replay would be stale the moment a human restores the
checkout (the same reasoning `"squash-refused"` already carries for the solo path).

The manager-facing text for both outcomes now names the actual next step instead of a generic "not
started" tail: `runFallback`'s `noStart` parameter accepts a STRING (the outcome-specific tail) in place of
a boolean, and the async settle nudge (`[loom:merge-batch-diverted]`/`[loom:merge-batch-unverified]`) is a
dedicated branch rather than falling into the generic `[loom:merge-batch-failed]` wording. A divert says to
restore the canonical checkout BEFORE any `worker_merge_confirm`; an unverified ff says to check `git log`
on the mainline branch, after which `worker_merge_confirm` finalizes each candidate via ALREADY_MERGED.
`fastForwardCanonicalMain`'s own `branchDiverted` reason string no longer claims "falling back to a
per-branch re-gate" — that phrase is true of an ordinary forfeit, never of a divert (see the section above).

`batchLanded` (the tombstone verdict's own later-fact field, stamped once `runBatchedMerge` returns) is
`undefined`, not `false`, when the outcome is `unverified` — mirroring `postGateThrow`'s own `landedKnown
=== undefined` ("can't tell"): `false` would be a false negative claim, since the `--ff-only` itself did not
throw and the landing most likely happened.

A `mergeBatchTracked`-level test (`batch-merge-ff-unverified-no-fallback.mjs`) proves the `unverified`
outcome end-to-end through the real service stack, via a new, narrow test seam —
`SessionService`'s `batchFfGitFactory` opt, threaded into `runBatchedMerge`'s own `deps` — that fails ONLY
the second (post-ff) combined `rev-parse --symbolic-full-name` read, mirroring
`batch-merge-canonical-branch-divert.mjs`'s own `scenarioPostReadFailureIsUnverified` at the lower level.
Verified falsifiable directly: temporarily disabling `mergeBatchTracked`'s `if (result.unverified)` block
turns the no-fallback/distinct-event checks RED (the generic fallback then runs a real solo confirm and
finalizes the branch).

## Do not

- Do not treat a sha-only forfeit check as sufficient proof that canonical main is untouched — a same-commit
  branch divert (`checkout -b` with no new commit) passes it trivially. Pin and re-check the branch name too.
- Do not skip the POST-ff re-verification on the theory that the pre-ff check already proved it safe — the
  pre-check and the merge both run inside the SAME lock, so in the ordinary case the post-check is cheap
  insurance, but it is the only thing that can catch a divert that somehow still occurred after the pre-check
  (e.g. a non-canonical-git-bound process bypassing the lock entirely) rather than silently reporting success.
- Do not make `expectedBaseBranch` mandatory — every existing direct caller/test of `fastForwardCanonicalMain`
  that passes no branch must keep working unchanged, exactly like `expectedBranchTip` on the solo path.
- Do not put a `rev-parse` output-mode flag (`--symbolic-full-name`, `--abbrev-ref`, etc.) BEFORE every rev
  arg expecting only later args to be affected — it governs ALL of them. `--symbolic-full-name HEAD HEAD`
  prints the symbolic form twice, not sha-then-ref; put the flag AFTER the arg that should stay the raw sha.
- Do not drop the sha re-read from `verifyLanded` even when the branch is pinned (a prior version of this
  round considered it) — the DoD asks for both, and `git merge --ff-only`'s own throw-or-succeed contract is
  not a substitute for re-reading what's actually there.
- Do not route a `branchDiverted` or `unverified` refusal through the ordinary per-candidate solo fallback —
  treat both exactly like `quarantined`/`cancelled` (no-start mode): the solo path pins only a sha, never a
  branch, and a fallback squash risks landing onto the same stray branch, or a second divergent landing on
  top of content that's probably already on main.
- Do not cache or replay a `branchDiverted`/`unverified` verdict — both are in `NEVER_CACHED_OUTCOMES`
  (`orchestration/pending-ops.ts`); they describe the CANONICAL CHECKOUT, not the resolved candidate
  branches, so a branch-keyed cache key can't see a restored checkout and a cached replay would be stale.
- Do not reintroduce the watermark-preferred branch pin (preferring the stored mainline watermark over a
  live read at cut time) until card `2a6a292a` closes `checkMainlineMove`'s silent re-stamp of that same
  watermark on a stray checkout — reintroducing it first reopens the one-batch-lifetime corruption this
  round reverted.
