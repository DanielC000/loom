# 2968815c — route the remaining raw-message batch-merge refusals through the canonical guidance template

Follow-up to `26084115`/`a3a632fa`, whose own "Do not" lists named three gaps explicitly rather than claim
them already covered: the batch post-mutation cherry-pick loop, `mergeBranchLocked`'s PRE-probe entry reads,
and the cut-base ancestry probe's own raw render. The investigate-first checkpoint (manager, gen 451, see
the card body's own 2026-10-28 triage note) confirmed the second of those three was ALREADY fully closed by
`c395b4fb` (all 8 pre-squash catch blocks in `mergeBranchLocked` now call its `trustRefusalResult(e)`
first) — this card's actual scope narrowed to the remaining two, both in `batch-merge.ts`.

## What changed

**`landBranchCommitsIndividually`'s cut-base-ancestry probe** (PRE-mutation — runs before any cherry-pick
this call): before this card, `ancestry.probeFailed` unconditionally rendered "...this looks like a
transient git/host condition... re-confirm to re-check" from `ancestry.probeError` (a raw string) even
when the underlying error was a structural `CanonicalGitRefusal` — the opposite of the template.
`checkCutBaseAncestry` (`worktrees.ts`) already unconditionally captures `probeErrorObject: e` (added by
`c395b4fb`), but this call site never read it. Fixed by classifying `describeGitFailure(ancestry.probeErrorObject)`
first: a genuine refusal now short-circuits to `canonicalFailureMessage`, mirroring `mergeBranchLocked`'s
own identical pattern at `worktrees.ts` (the sibling solo-path check, immediately above the batch one in
that file); an ordinary probe failure keeps the existing, correct "transient... re-confirm" wording
unchanged.

**Five POST-mutation cherry-pick-loop catches** (the empty-stage probe, the original-commit-metadata read,
the pre-commit `write-tree` capture, the post-commit HEAD verify, and the final post-loop HEAD read): each
rendered a bare `${(e as Error).message}`. Fixed by routing each through
`canonicalFailureMessage(describeGitFailure(e), describeGitFailure(e).text)`, same prefix text as before,
no other logic change. Four of the five already call `rollback()` before composing their `fail({...})`
reason; the fifth (the final post-loop read) does not call `rollback()` at all — see "Known residual"
below.

**`mergeMainIntoWorktree`'s main-tip read `transient` flag** (a sibling function, NOT the merge path, but
flagged as cheap-and-same-class by the manager): the flag was computed from the raw `e`
(`TIMEOUT_SHAPED_RE`/`isTransientSpawnErrorCode`) BEFORE `describeGitFailure(e)` existed, so unlike this
function's own siblings (the owed-landing commit-tree/fast-forward catches, which already gate on
`!d.refusal`), it was never gated — a `CanonicalGitRefusal` whose own message happened to look
timeout-shaped could have been wrongly marked `transient:true`. Fixed by computing `describeGitFailure(e)`
first and gating `transient` on `!mainTipFailure.refusal`.

## Why `describeGitFailure`/`canonicalFailureMessage` directly, not `trustRefusalResult`

`worktrees.ts`'s `trustRefusalResult` helper (added by `c395b4fb`) is private (not exported) and used only
within `mergeBranchLocked`. Per the manager's explicit ruling, this card does NOT export it — `batch-merge.ts`
already has its own established idiom for this exact decision (`describeGitFailure(e).refusal` branching,
used repeatedly: the identity-probe catch, the cherry-pick-failure catch, the commit-failure catch, all
pre-dating this card), so the cut-base-probe fix reuses that same idiom rather than introducing a
cross-file export for one new call site.

## Round 2 (Code Review follow-up): the landed-tree content-check and the rollback's own verify-probe

Code Review on round 1 found two further raw-message render sites in `landBranchCommitsIndividually` that
round 1's own scope (the cut-base-ancestry probe and the five post-mutation cherry-pick-loop catches) did
not reach:

**`landedTreeDivergesFromExpected`'s own three catches** (the content-check helper this function calls
after a branch's commit(s) have already landed, comparing the landed tree against a 3-way merge of the
branch's reviewed tip) used to return `{ error: (e as Error).message }` from each of its three `git.raw()`
catches (`merge-tree --write-tree`, `rev-parse --verify ...^{tree}`, `diff --name-only`), and the one call
site (the content-check block in `landBranchCommitsIndividually`) rendered that string raw. Fixed two ways:
the helper's return type now carries a `describeGitFailure(e)` result instead of a bare string, and the
call site renders it through `canonicalFailureMessage(divergence.error, divergence.error.text)`.

**`rollback()`'s own POST-reset verification probe** (the HEAD/`status --porcelain`/`CHERRY_PICK_HEAD`
reads that confirm the batch worktree actually landed back at `batchHeadBefore`) had a stale comment
claiming "Both probes are pure reads (never refused)" — false: any `git.raw()` call through the canonical
git wrapper can surface a `CanonicalGitRefusal`, not only a mutating one. Its own catch rendered a bare
`(e as Error).message` the same way the content-check did. Fixed by routing through
`describeGitFailure(e)`/`canonicalFailureMessage` and correcting the comment.

**Test-design pitfall recurred, same shape as round 1's own.** The first versions of scenarios (J)/(K)
(added for these two sites) used the long pinMismatch `rawReason`/`CanonicalGitPinMismatchRefusal` shape —
and both passed even against the UNFIXED code, because a bare `(e as Error).message` render is not
truncated at all (unlike `describeGitFailure(e).text`'s 400-char cap), so the guidance clauses baked into
`rawReason` itself survived regardless of whether the fix was applied. Confirmed via `negative-control`:
the RED phase passed cleanly before this was caught. Fixed by switching both to the same short,
guidance-free `redirectRawReason`/`CanonicalGitCommondirRefusal` shape scenarios (C)/(G) already use for
exactly this reason — re-measured via `negative-control`: RED phase now fails on exactly the 6 new checks
(3 guidance-clause checks each, for (J) and (K)), GREEN phase passes, tree restored clean.

## Known residual: `forkPointUnverified`/`canonicalTrustRefusal` are not observable on `BatchDroppedBranch`

Per the manager's explicit ruling, this card is wording-only — no typed flag was added to `BatchDroppedBranch`.
Confirmed at source: `assembleBatchBranches`'s own `dropped.push({ ...c, reason: r.reason ?? "batch land failed",
conflict: !!r.conflict })` (the ONLY place a `LandResult` becomes a `BatchDroppedBranch`) carries forward
ONLY `reason` and `conflict` — every other typed field on `LandResult` (`forkPointUnverified`,
`forkPointDiverged`, and the solo path's own `canonicalTrustRefusal`, which the batch path has no
equivalent of at all) is silently dropped. So unlike the solo path (`sessions/service.ts`'s
`confirmWorkerMergeTracked`, which branches on `merge.canonicalTrustRefusal`/`merge.forkPointUnverified`
explicitly), a batch drop's REASON TEXT is the ONLY guidance channel a human or a future reader ever sees —
there is no typed signal to special-case downstream. This card's own test suite (scenario H) asserts on the
reason text for exactly this reason; it cannot assert the typed flag, because nothing propagates it to
where a black-box test could observe it. A future card wanting typed-flag parity with the solo path would
need to widen `BatchDroppedBranch` and its one producer — out of this card's wording-only scope.

## Known residual: the final post-loop HEAD read never calls `rollback()`

`landBranchCommitsIndividually`'s very last catch (`landed but failed to read the result`) returns directly
without calling `rollback()`, unlike every other catch in the per-commit loop. This is PRE-EXISTING
behavior, not introduced or touched by this card — left as-is per the manager's explicit ruling (record it
here, not fix it). At the point this catch fires, every commit in the branch has already landed
successfully (the loop has completed); whether an unrolled-back state here is actually a problem (and if
so, what the correct remedy is) is a separate, unscoped investigation.

## Test-design pitfall found and fixed during this card's own verification

The FIRST version of scenario (G) (the five cherry-pick-loop sites) faulted with the SAME long
`CanonicalGitPinMismatchRefusal(rawReason, ...)` scenarios (A)/(B)/(D) use — and every one of its five
sub-checks PASSED even against the UNFIXED, pre-this-card code, measured directly via `negative-control`
(18 failures dropped to 0 once the fault shape below was corrected — the other three, non-G scenarios'
failures were genuine both times). Root cause: `rawReason`'s guidance clauses (`"verify on disk"`,
`"Platform Lead"`, `"commondir-trust-pin/repin"`) are part of the raw string ITSELF (mirroring production's
real pinMismatch template), and only `describeGitFailure(e).text` truncates at 400 chars — a bare,
unclassified `(e as Error).message` render is NOT capped at all, so the guidance survived the raw render
trivially, with or without this card's fix. Fixed by reusing the SAME short, guidance-free
`CanonicalGitCommondirRefusal(redirectRawReason)` shape scenario (C) already uses correctly for exactly
this reason (hoisted `shortWorktreePath`/`redirectRawReason`/`redirectGuidance` to module scope so both
scenarios can share them) — re-measured via `negative-control`: all 5 sites now genuinely RED pre-fix (3
guidance-clause checks each = 15 failures) and GREEN post-fix.

## Do not

- Do not fault a bare-`.message`-render regression test with the long pinMismatch `rawReason`/
  `CanonicalGitPinMismatchRefusal`/`liveToplevel` shape (defined near this test file's own preconditions) —
  its guidance clauses are part of the raw string itself and survive an unclassified render regardless of
  whether a fix is applied, so a check built on it does not discriminate. Use the short, guidance-free
  `redirectRawReason`/`CanonicalGitCommondirRefusal`/`redirectGuidance` shape instead — ALWAYS verify a new
  check like this via `negative-control` before trusting its own green.
- Do not export `trustRefusalResult` from `worktrees.ts` to reuse it in `batch-merge.ts` — the manager
  ruled this out explicitly; `batch-merge.ts` has its own established `describeGitFailure(e).refusal`
  idiom for this exact decision shape.
- Do not add a typed `canonicalTrustRefusal`/`forkPointUnverified`-propagating field to `BatchDroppedBranch`
  as part of "finishing" this card — it was ruled explicitly out of scope (wording-only); see the residual
  section above for what such a change would actually require.
- Do not add a `rollback()` call to the final post-loop HEAD read's catch as part of "finishing" this card —
  that is a separate, pre-existing, unscoped behavior; record it, do not fix it here.
- Do not conflate this card's `mergeMainIntoWorktree` fix with the merge path itself — that function is the
  worker's own PRE-GATE union-merge step, a sibling to `mergeBranchLocked`, not part of it; it was folded
  into this card only because it is the same misclassification class and the manager judged it cheap.
- Do not add a NEW bare-`.message`-render regression test with the long pinMismatch `rawReason` shape,
  even for a site that "looks like" it should discriminate — round 2's own (J)/(K) scenarios repeated
  round 1's exact mistake (see "Test-design pitfall recurred" above) before being caught by
  `negative-control`. Use the short `redirectRawReason`/`CanonicalGitCommondirRefusal` shape for any new
  bare-render regression check in this file, and always verify via `negative-control` before trusting a
  new check's own green.
- Do not treat `landedTreeDivergesFromExpected`'s return type change (`error: string` →
  `error: ReturnType<typeof describeGitFailure>`) as a reason to re-add a second `describeGitFailure(e)`
  call at the render site — the helper already classifies internally; the call site renders the already-
  classified result directly (`divergence.error`/`divergence.error.text`).
