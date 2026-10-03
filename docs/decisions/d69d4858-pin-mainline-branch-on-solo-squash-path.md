# d69d4858 — pin the checked-out mainline branch on the solo squash-merge path, from the stored watermark

## Narrative

From the `b801bad0` merge-path review (reviewer `f3e6d4ac`). `b801bad0` pins and re-verifies the
checked-out mainline BRANCH around the batch fast-forward (`fastForwardCanonicalMain`,
`git/batch-merge.ts`). The SOLO path never had an equivalent: `mergeBranchLocked`'s own
`requireCanonicalHead` check (`git/worktrees.ts`) compared only a sha, never which branch canonical HEAD
was checked out on, and `confirmWorkerMerge`'s `gateBaseMainHead` captures (`sessions/service.ts`) were
all plain `resolveGitRef(repoPath, "HEAD", …)` reads — sha only. The existing `checkMainlineMove`
tripwire (card `4fa36502`) can detect and alert on a branch divert, but is explicitly fail-open and never
refuses (`4fa36502`'s own "Do not turn this alert into a refusal"). Net effect before this card: a
same-commit branch divert (`GitWriter.checkout`/`createBranch`, the Platform Lead's own git tools, or a
stray manual checkout) sailed through both checks, and `worker_merge_confirm` squashed onto the stray
branch while reporting success — work landed off mainline, reported ok.

**Source of truth, and a correction caught before this landed:** the kickoff for this card described the
watermark as "the same source b801bad0's batch pin uses." That is not accurate as implemented —
`b801bad0` round 3 explicitly REVERTED preferring the stored watermark for the batch pin, in favor of a
LIVE read (`readMainlineHead` at batch-cut time), because `checkMainlineMove` used to silently re-stamp
the watermark onto a stray branch on first sight of it. Card `2a6a292a` closed that re-stamp gap and
states independently and explicitly: "the configured mainline branch is the watermark's OWN `branch`
field, once first established — not a live git read, not a per-call guess." Reintroducing the
watermark-preferred pin for the BATCH path is deliberately deferred to a separate sibling card (`ba663984`,
filed the same day, still open) — `2a6a292a`'s own Do-not list forbids doing so as part of that card. This
card (the SOLO path) uses the stored watermark anyway, per its own DoD and per `2a6a292a`'s definitive
statement of what "the configured mainline branch" means project-wide — independent of what the batch pin
happens to do today.

## Design

- **Resolved ONCE, in `confirmWorkerMerge`, never a live read:** `expectedMainlineBranch =
  parseMainlineWatermark(this.db.getMeta(mainlineWatermarkKey(project.id, repoKey)))?.branch`, computed
  right after `repoPath`/`targetRepo` are resolved — the SAME store `checkMainlineMove` reads, via the
  SAME helpers (`mainlineWatermarkKey`, `parseMainlineWatermark`), never a second independent mechanism.
  `undefined` when no watermark has ever been stamped for this `(project, repoKey)` — true first sight,
  mirroring `checkMainlineMove`'s own "nothing to compare yet" semantics — and every check below becomes
  a no-op in that case, unchanged from before this card.
- **Threaded as a new, optional `expectedMainlineBranch?: string` parameter** through `mergeBranch` →
  `mergeBranchLocked` (`git/worktrees.ts`), mirroring exactly how `requireCanonicalHead`/
  `gateBaseBranchHead`/`expectedBranchTip` are already threaded — `git/worktrees.ts` has no DB access by
  design, so the branch value must be captured by the caller and passed in as a plain value, the same
  shape `BatchGitDeps.expectedBaseBranch` already uses on the batch side.
- **Pre-squash check** (`mergeBranchLocked`, right after the existing `requireCanonicalHead` sha check):
  when `expectedMainlineBranch` is set, one extra read via the SAME shared helper `b801bad0` already
  introduced for this identical purpose, `readHeadShaAndBranch` (`git/mainline-watch.ts`) — refuses
  (`branchDiverted:true, observedBranch`) on a mismatch, mirroring `fastForwardCanonicalMain`'s pre-ff
  check almost verbatim. Runs UNCONDITIONALLY when set, never folded into the `!branchStableSinceGateBase`
  gate the sha check uses — a same-sha divert is exactly the shape that sha-only check cannot see. A
  read error/timeout fails CLOSED (`unverified:true`), never silently proceeding — the read failing is not
  proof of anything either way.
- **Post-squash re-verification** (`verifyLandedOnMainline`, a local helper defined once, called from both
  success-return points in `mergeBranchLocked` — the ordinary post-commit read and the "recovered as our
  own commit after an apparent commit failure" path): re-reads branch+sha together and refuses unless
  both match, mirroring `fastForwardCanonicalMain`'s own `verifyLanded`. A commit MAY already exist at this
  point — this can never undo that, only stop a false `ok:true`. `divertedSha` carries the landed-but-
  unreachable commit's sha so a human can recover it. A failed re-read gets its own `unverified:true`
  (whether the squash landed on mainline is unconfirmed either way, only the confirmation read failed),
  distinct from a confirmed `branchDiverted:true` — same distinction `b801bad0` already draws for the
  batch path.
- **`findLandedSquashCommit`'s `base` argument** is `expectedMainlineRef ?? "HEAD"` (fallback "HEAD"
  unchanged when no watermark yet) at every already-landed lookup on the solo squash-merge path: the
  dedupe/suppress check (`shouldSuppressMergeReject`), both `reviewedTipVerdict` pre-checks
  (confirm-start and pre-squash), the `priorLanding` and `preLanded` captures in `confirmWorkerMerge`,
  `finishSoloAlreadyLanded`'s own lookup (shared by `confirmWorkerMerge`'s worktree-gone/task-terminal
  early exit AND its clean-worktree `preLanded` shortcut — threaded as a NEW `expectedMainlineRef` field
  on that method's own param object, since it is a separate method one level removed from
  `confirmWorkerMerge`'s local, not a direct call site), `confirmWorkerMergeTracked`'s OWN catch path
  (card `479f449f` — round 2 item 2, see below), and the ALREADY_MERGED/STAGE_EMPTY_RETRY classification
  inside `mergeBranchLocked` itself. `expectedMainlineRef` is a SEPARATE, fully-qualified
  (`refs/heads/<branch>`) value from `expectedMainlineBranch` (round 2 item 1, see below) — the bare
  `expectedMainlineBranch` stays reserved for the PIN comparison (`readHeadShaAndBranch`'s own `.branch`
  field is always a bare name) and human-facing messages; only the REF ever reaches `git log <base>`.
  These call sites run BEFORE the canonical index lock is ever acquired — if canonical is already
  diverted when `worker_merge_confirm` is called, scanning bare `HEAD` there could see (or fail to see) a
  landed-squash trailer that only lives on the stray branch. The lookup inside `mergeBranchLocked` itself
  runs strictly after the new pre-squash branch check, so by the time it runs a divert has already been
  refused — this one is defense in depth, not independently load-bearing. TWO call sites stay on `"HEAD"`
  deliberately: `workerDiff` (a diff-reconstruction helper, not gating) and `finishSoloAlreadyLanded`'s own
  sibling `findIntroducingSquashCommit` attribution call (ATTRIBUTION ONLY per `293d418e`, never gating).
  The periodic orphan sweep and `findLandedSquashCommitViaMap` also scan `"HEAD"` and are OUT OF SCOPE,
  carded separately as `eb58b8bd`.
- **Refusal handling in `confirmWorkerMerge`:** a new `if (merge.branchDiverted || merge.unverified)`
  block, checked right after the existing `gateBaseInvalidated` handling and before the generic
  conflict/merge-failed fallthrough — files a `merge_rejected` durable event naming
  `expectedMainlineBranch`, `observedBranch`, and (post-squash only) `divertedSha`, relays `merge.reason`'s
  already-actionable text verbatim via the standard `rejectNotify` push, and returns `merged:false`. The
  mainline watermark is never advanced on this path (`advanceMainlineWatermark`'s only caller already
  gates on `merge.ok`), and the worktree/branch are retained exactly like every other pre-squash refusal
  in this method.
- **`ConfirmMergeResult.branchDiverted`/`unverified`/`observedBranch`/`divertedSha`** mirror
  `MergeBatchResult`'s identical fields byte-for-byte in name and intent. `confirmWorkerMergeTracked`'s own
  `classifyOutcome` now maps them to the SAME outcome strings `mergeBatchTracked`'s `classifyOutcome`
  already uses — `"branch-diverted"`/`"ff-unverified"` — which were already present in
  `NEVER_CACHED_OUTCOMES` (`orchestration/pending-ops.ts`) from the batch side; the solo path simply
  starts producing them too. Both describe the state of the CANONICAL CHECKOUT, never the branch, so a
  cached replay would be stale the instant a human restores the checkout — same reasoning
  `gateBaseInvalidated`/`squashRefused` already carry for their own, adjacent refusal classes.

## Round 2 (Code Review `dd36012a`, REQUEST CHANGES on `61439adb`)

1. **BLOCKING — a bare branch name is ambiguous.** `git log <base>` with a bare short name (e.g. `main`)
   fails `fatal: ambiguous argument 'main': both revision and filename` against a same-named top-level
   file/dir (reproduced directly: `findLandedSquashCommit` fails SAFE to `null`, i.e. "not landed" — a
   false negative), or silently scans a same-named TAG's history instead (a false positive risk). Fixed by
   building `expectedMainlineRef = refs/heads/${expectedMainlineBranch}` ONCE in `confirmWorkerMerge`
   (and, for the tracked catch path, inline at that call site) and threading THAT, never the bare name, to
   every `findLandedSquashCommit` call — `git log refs/heads/<branch>` is unambiguous regardless of
   same-named files/dirs/tags.
2. **MAJOR — `confirmWorkerMergeTracked`'s OWN catch path (card `479f449f`) also scanned bare `HEAD`, and
   FINALIZES on a hit** (worktree removed, branch deleted, task marked merged) — a DIFFERENT, higher-stakes
   call site than any of the six above: a post-squash divert followed by an unrelated throw (e.g. a dead-
   owner race) would have re-derived "landed" from whatever canonical happens to be sitting on and
   finalized the task, with mainline never actually getting the work. This card had mis-filed this exact
   site as one of the "two resume/reporting helpers... out of scope" in round 1 — it is not a reporting
   helper, it gates a real finalize. Fixed the same way: resolve the watermark ref inline in that catch
   block (the same store, same helpers) and scan it instead of `"HEAD"`.
3. **Wording.** The post-squash refusal's `detailText` unconditionally claimed "canonical repo and
   worktree are untouched" even when a real commit had landed (just unreachable from mainline, or
   unconfirmed which branch). Now keyed on `merge.divertedSha`: present ⇒ "a commit landed (sha)… worktree
   retained"; absent (the pre-squash case, genuinely nothing squashed) ⇒ the original "untouched" wording.
4. **`ConfirmMergeResult.divertedSha` was declared but never actually returned** from the refusal's final
   `return` statement — a caller reading the typed field always saw `undefined`. Added.
5. **Post-squash path had NO test at all** — the file's own "before AND after" banner claim was false
   until scenarios (E)/(F) existed. Added via `soloMergeGitFactory` faking ONLY the post-commit combined
   read (mirrors `batch-merge-ff-unverified-no-fallback.mjs`'s technique): (E) a fabricated different
   branch name ⇒ `branchDiverted`+`divertedSha`, the real commit landed on mainline's own ref (the fake
   only lied to the read), watermark never advanced; (F) the read throws instead ⇒ `unverified`+
   `divertedSha`, same non-advance guarantee.
6. **(D)'s own `notified` assertion didn't exercise the suppress lookup** — reverting only that ONE call
   site stayed green. Root cause, now recorded in (D)'s own header comment: a `branchDiverted` refusal and
   a scan-target-dependent `findLandedSquashCommit` result are structurally close to mutually exclusive
   (the union-merge that always precedes a squash attempt neutralizes a persistent divert's own trailer
   commit via the re-task guard, and a divert introduced DURING the gate instead trips the pre-existing,
   broader sha-only `requireCanonicalHead` check first). Fixed by triggering the refusal through the EARLY
   `reviewedTipVerdict` "confirm-start" call site instead, which runs before the union-merge ever touches
   anything — verified directly: reverting only the suppress call site's base-arg flips this exact
   assertion to FAIL, restoring it returns to PASS.

All six verified RED on `61439adb` (items 1/2/3/4/5 via new scenarios E/F/G/H; item 6 via a targeted
single-line revert of the one call site it names, isolated from the rest of the fix) before being fixed.

## Round 3 (delta Code Review `b39e8972` of `61439adb..f84255d3`, REQUEST CHANGES)

1. **MAJOR — round 2's wording keyed on `merge.divertedSha` ALONE, so the post-squash `unverified` case
   (which also carries `divertedSha`) wrongly borrowed the branch-diverted "Canonical main was NOT
   advanced" phrasing — self-contradicting against its OWN `why` text ("could not be confirmed"), and
   risking a human cherry-picking the squash a second time. Fixed with THREE wordings keyed on
   `branchDiverted`/`unverified` themselves (`service.ts`'s post-divert refusal branch): untouched
   (neither flag carries a `divertedSha` — nothing landed), branch-diverted-with-sha ("Canonical main was
   NOT advanced…", unchanged from round 2), and a NEW unverified-with-sha wording — "A commit landed
   (`<sha>`); whether it is on mainline is UNCONFIRMED — check `git log <branch>` before recovering." Also
   dropped `verifyLandedOnMainline`'s own confident "the commit most likely landed correctly" clause
   (`worktrees.ts`) — that phrase was the other half of the self-contradiction. Scenario (F) now asserts
   the EXACT text, not just the absence of "untouched" — verified RED (asserted the old ternary) then
   GREEN by reverting only `service.ts`'s wording to the round-2 ternary and back.
2. **MAJOR (test coverage) — `mainline-watch-branch-divert.mjs`'s (D5) stopped discriminating
   `checkMainlineMove`'s own null-on-branch-mismatch guard (card `2a6a292a` round 2) the moment this
   card's OWN solo branch-pin refusal landed in round 2**: both guards now make `rd5.merged === false`
   true for the SAME divert, so (D5)'s existing assertions pass regardless of what `checkMainlineMove`
   itself returns — they only ever proved `mergeBranchLocked`'s refusal, never `checkMainlineMove`'s.
   Verified by reverting ONLY `checkMainlineMove`'s branch-mismatch `return null` to `return head.tip`:
   every (D5) assertion stayed GREEN. Fixed by adding (D5b), which calls `checkMainlineMove` DIRECTLY
   (it's a plain instance method, not a TS `#`-private field, so a test can call it straight off the
   `SessionService` instance) with canonical still diverted on the same stray branch, asserting its
   return is `null` in isolation from the unrelated refusal — RED under the same revert, GREEN restored.
   (D5)'s stale banner/check-label text (described the pre-round-2 "no refusal, squash lands on the
   stray branch" bug as still current) was also corrected to describe what (D5) now actually proves.

Both verified RED (item 1 via a service.ts wording revert; item 2 via the `checkMainlineMove` single-line
revert above) before being fixed, each isolated to just the one call site/line named.

## Actionable refusal text

The pre-squash divert message and the `mainlineMovedNudgeText`-style text both name the concrete remedy:
check out `expectedMainlineBranch` again in the canonical repo and re-confirm, or, if the observed branch
is actually a deliberate mainline rename, ask the owner to reset the project's mainline baseline via
`POST /api/projects/:id/mainline-watermark/reset` (loopback, human-only — the route `2a6a292a` added). The
post-squash message additionally names the stray commit's sha and the recovery recipe (`git branch
rescue/<id>-<sha> <sha>`, check out the real mainline branch, cherry-pick it on).

## Do not

- Do not derive "which branch is mainline" by any means other than the stored watermark
  (`mainlineWatermarkKey`/`parseMainlineWatermark`) — not a live git read, not a per-call guess (see
  `2a6a292a`'s own "configured mainline branch" definition). The batch path's current live-read pin is a
  known, deliberately scoped exception (reverted by `b801bad0` round 3), not a pattern to copy here.
- Do not gate the pre-squash branch check on `!branchStableSinceGateBase` — a same-sha divert is exactly
  the shape the sha-only `requireCanonicalHead` check cannot see, so the branch check must run
  unconditionally whenever `expectedMainlineBranch` is set.
- Do not skip the POST-squash re-verification on the theory that the pre-squash check already proved it
  safe — both run inside the SAME lock, so the post-check is cheap insurance in the ordinary case, but it
  is the only thing that can catch a divert that somehow still occurred after the pre-check.
- Do not make `expectedMainlineBranch` mandatory on `mergeBranch`/`mergeBranchLocked` — every existing
  direct caller/test that passes none must keep working unchanged, exactly like `expectedBranchTip`.
- Do not route a `branchDiverted`/`unverified` refusal through the generic conflict/merge-failed
  fallthrough, and do not let `advanceMainlineWatermark` run on this path — both are already guaranteed
  by this refusal returning before that fallthrough and by `merge.ok` gating the advance call.
- Do not widen the `findLandedSquashCommit` base-arg fix to `workerDiff` or `finishIntroducingSquashCommit`
  (attribution-only, `293d418e`) as part of this card, and do not fold in the periodic orphan sweep /
  `findLandedSquashCommitViaMap` (carded separately, `eb58b8bd`) — flagged, not touched.
- Do not pass a BARE branch name to `findLandedSquashCommit`'s `base` anywhere on this path — always the
  fully-qualified `expectedMainlineRef` (`refs/heads/<branch>`); a bare name is ambiguous against a
  same-named top-level file/dir/tag (round 2 item 1).
- Do not assume `confirmWorkerMergeTracked`'s own catch path (card `479f449f`) is a "reporting helper" —
  it FINALIZES on a hit (worktree removed, branch deleted, task merged), so it needs the SAME watermark-ref
  scan as every other already-landed lookup on this path (round 2 item 2).
- Do not claim "canonical repo and worktree are untouched" in a refusal's wording without checking
  `merge.divertedSha` first — a POST-squash divert/unverified means a real commit DID land (round 2 item 3).
- Do not key a refusal's wording on `merge.divertedSha` ALONE — a POST-squash `unverified` also carries
  `divertedSha` but is NOT a confirmed divert, so it needs its OWN wording, never the branch-diverted
  "Canonical main was NOT advanced" phrasing (round 3 item 1; that conflation was self-contradicting
  against its own `why` text).
- Do not trust `mainline-watch-branch-divert.mjs`'s (D5) scenario-level assertions (`rd5.merged`, the
  watermark staying untouched) as proof of `checkMainlineMove`'s OWN null-on-branch-mismatch guard — this
  card's own solo branch-pin refusal makes those same assertions pass regardless of what
  `checkMainlineMove` returns. Only (D5b)'s direct call to `checkMainlineMove` (isolated from this card's
  refusal) discriminates that guard (round 3 item 2).
- Do not cache a `branch_diverted`/`branch_divert_unverified` refusal — both are in `NEVER_CACHED_OUTCOMES`
  under the SAME `"branch-diverted"`/`"ff-unverified"` strings the batch path already uses.

## Tests

`packages/daemon/test/solo-merge-watermark-branch-pin.mjs` (real git), scenarios (A)-(H):
(A) a transient same-commit divert refuses `branchDiverted:true` and lands nothing; (B) a no-watermark
control proves behavior is byte-identical to before this card; (C) a forced PRE-squash read-error proves
the fail-closed `unverified:true` path; (D) a same-commit divert with a stray trailer commit, triggered via
the EARLY `reviewedTipVerdict` check (see its own header for why), proves the already-landed lookup scans
the mainline ref — not bare `HEAD` — specifically for the suppress-notification decision; (E)/(F) POST-squash
divert/unverified, faked via `soloMergeGitFactory`, prove `verifyLandedOnMainline`'s own ref-scan, wording,
and `divertedSha` return; (G) a repo with a top-level directory named exactly like the mainline branch
proves the fully-qualified-ref fix against a genuinely ambiguous `git log` argument; (H) a forced throw
(a `getPid` that throws) with canonical diverted onto a stray-only trailer commit proves
`confirmWorkerMergeTracked`'s own catch path does not finalize.
