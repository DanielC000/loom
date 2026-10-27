# e8e98d43 — a batch `finishAlreadyMerged` refusal is surfaced, never silently treated as landed

From card `f2b4d684`'s CR7 (session `47e028fa`): `mergeBatchTracked`'s per-candidate finalize loop
(`sessions/service.ts`) called `await this.finishAlreadyMerged({...})` without capturing the result, so a
`heldAtFinish` refusal (the method's ONLY `merged:false` return — verified by reading the whole method
body) was unconditionally followed by `landed.push({...})` regardless of outcome. The branch's content
genuinely WAS on main (the batch's own fast-forward put it there), but Loom-side finalize never ran (no
`finalizeMerge`, no `pty.stop`, no task move) — and nobody was told. Fails closed (nothing deleted), but
the card stayed silently not-done.

## Caller trace (why the fix lives only at the batch call site)

`finishAlreadyMerged` has FOUR real call sites in `sessions/service.ts` (verified directly — a repo-wide
grep for `this\.finishAlreadyMerged\(` found a fourth site this card's own worker initially missed by
reading only its first few grep hits; always enumerate the full hit list, not a prefix of it). Three
`return` the result directly out of a method whose own caller already has refusal-handling built in (a
sync result plus the generic `[loom:merge-failed]` onSettle echo): `confirmWorkerMerge`'s own ALREADY_MERGED
branch, `confirmWorkerMergeTracked`'s thrown-error recovery branch, and the shared `finishSoloAlreadyLanded`
helper (`@decision 293d418e` — the ONE place the lookup→tip-guard→finish sequence lives, itself called
from two further sites, both of which consume ITS result via `const finished = await ...`). Only the
FOURTH, `mergeBatchTracked`'s own per-candidate loop, calls it directly (with `suppressNotify:true`, to
avoid one `[loom:already-merged]` push per landed branch — card `c35b60c4`) and bypasses that machinery
entirely, so it is the one caller that must do its own capturing and surfacing.

## The fix

- `MergeBatchResult.finishRefused?: {workerSessionId, taskId, branch, sha, reason, heldRangeUnverifiable?}[]`
  — a refused candidate is pushed here instead of `landed`. `landedCount` (the batch's own git-verified
  fast-forward count) is UNCHANGED and still counts it — the content really did land; `landedCount` and
  `landed.length` already diverge for a hard-deleted session row (card `553ea58c`), and this is a second,
  documented cause of the same divergence.
- The aggregate `[loom:merge-batch-*]` settle nudge names every `finishRefused` entry inline (mirroring how
  `branchAdvancedDuringGate`/`worktreeRetainedDirty` are already surfaced there) — there is no separate
  per-candidate push, since `finishAlreadyMerged`'s refusal branch returns before `announce()` regardless
  of `suppressNotify`.
- `classifyOutcome`: a batch carrying a `finishRefused` entry — either cause — stays plain `"landed"`
  (cacheable), same as `branchAdvancedDuringGate`/`worktreeRetainedDirty`. See the "CR correction" section
  below for why (an earlier version of this fix classified the transient cause as the never-cached
  `"landed-tip-unverifiable"`, and that was wrong, measured).
- M1: `finalizeMerge`'s own, LATER, separate held check (distinct from the `heldAtFinish` refusal above —
  see `docs/decisions/f2b4d684-*.md`'s "Named residual") already threads a `causeUnverifiable` 4th arg into
  `onBranchRetained`; the batch's own callback dropped it. Now forwarded into `BranchAdvancedDuringGate` and
  worded via a new, standalone `describeBranchRetainedCauseUnverifiableSuffix` helper — appended as a
  suffix rather than folded into `describeBranchRetained` itself, so that function's signature and its
  three other (pre-assembly `heldReason`) call sites stay untouched.

## Do not

- Do not call `finishAlreadyMerged(` anywhere without genuinely consuming its result — a `return`, an
  arrow-implicit-return, a destructure that INCLUDES `merged`, or a binding later READ via `.merged` — see
  `packages/daemon/test/finish-already-merged-result-consumed-guard.mjs`, an AST-based guard (CR-hardened,
  session `20d9173d`: an earlier text-based version both false-RED on a call split across lines and could
  be flipped by an inline comment). Deliberately NOT in `STATIC_GUARD_REPO_PATHS` or
  `CHANGED_TS_TEXT_SCANNER_REPO_PATHS` — see the guard's own header for which exclusion ground applies to
  each list and why the AST design makes it genuinely comment-immune, not merely claimed.
- Do not push a `finishRefused` candidate into `landed` — no finalize ran for it (no `merge_done`, no
  worktree/branch cleanup, no task move); `landed` entries are finalized candidates.
- Do not classify a `finishRefused` candidate (either cause) as anything OTHER than plain `"landed"` —
  see "CR correction" below. The batch verdict is a historical record; recovery is `worker_merge_confirm`
  on that one candidate (or boot Pass A), never a `merge_batch` re-fire, so never-caching the batch over
  this buys nothing and actively regresses (measured).
- Do not tell a manager to "re-run merge_batch" as the remedy for a finalize-time refusal/retain
  (`finishRefused`, or a `branchAdvancedDuringGate` entry with `causeUnverifiable`) — re-firing never
  re-evaluates an already-landed candidate's own retain/refusal; every such remedy text says
  `worker_merge_confirm on <workerSessionId>` instead.
- Do not add a new DB audit event for this refusal "for parity with other retains" without checking first —
  the SOLO path's own identical `heldAtFinish` refusal (the two callers that already `return` it directly)
  files NO event either; this fix deliberately matches that, not `noteRetained`'s own `batch_merge_branch_retained`
  event (a DIFFERENT, milder retain shape where `finalizeMerge` does still run).

## CR correction (2026-10-27, session `20d9173d`) — the original caching design was wrong, measured

The first version of this fix classified a TRANSIENT `finishRefused` (`heldRangeUnverifiable:true`) as the
never-cached `"landed-tip-unverifiable"`, reasoning that a cached `"landed"` replay would resurface a
stale refusal forever because clearing it changes the candidate's branch TIP, busting `verdictIdentity`.
**Both halves of that reasoning are false, measured directly** (real `isBranchHeld` path, no stub — see
"Tests" below):

1. **`verdictIdentity` is often never even computed for this batch.** Once every candidate is
   finished-or-held, `batchAlreadyFinished` sets `identityOptional:true` on the `attach()` call — the
   identity check is skipped entirely, so there is nothing for a tip-move to "bust" in the first place.
2. **Clearing a hold does not require the branch tip to move at all.** `isBranchHeld`'s release arms are a
   later real `merge_done`, or the task reaching a terminal column — neither touches the branch ref.

**The never-cached classification made things WORSE, not safer.** A re-fire with the SAME candidates
while the fault still persisted did NOT reuse anything — it re-assembled the batch from scratch, found the
ALREADY-FINALIZED sibling's branch ref gone (it was deleted on the first landing), dropped it, and routed
it through the per-branch SOLO fallback — which, finding the sibling's content already on main, finalized
it AGAIN: a duplicate `merge_done` event (and, in production, a duplicate alert-webhook POST). The call
after THAT then cache-hit the resulting all-dropped verdict and would keep doing so forever, even once the
original fault cleared — looping on "nothing landed, re-run merge_batch" for a batch that can never
usefully be re-fired again.

**The corrected design:** every `finishRefused` candidate, either cause, classifies as plain `"landed"`
(cacheable) — the batch verdict is a HISTORICAL record of what that one batch run did, same as
`branchAdvancedDuringGate`/`worktreeRetainedDirty` already are (decision `42daa283`'s own retained-verdict
replay semantics: a replay naming a candidate that is STILL retained, or whose retain has SINCE cleared, is
not wrong — it is a replay of a true fact about that run). Recovery for the ONE refused candidate is
`worker_merge_confirm` on it directly (its own, separately-keyed solo verdict cache re-evaluates fresh
every time — see "Tests" below) or boot Pass A; never a `merge_batch` re-fire on the whole set. Every
user-facing remedy text for this shape (the nudge, the sync-path `note`, `describeBranchRetainedCauseUnverifiableSuffix`)
was corrected to say so explicitly, naming the specific `workerSessionId`.

## Tests

`packages/daemon/test/mergebatch-finishalreadymerged-refusal.mjs` drives a REAL batch landing through the
GENUINE `isBranchHeld` path (NO stub, as of the CR correction below) to a real `heldAtFinish` refusal for
both causes — (T) transient, via an injected `heldProbeGitFactory` git-read fault that only arms once
THIS batch's own fast-forward has moved main past its pre-batch tip (so the pre-assembly selection check
sees the candidate released, and only the later `heldAtFinish` check inside `finishAlreadyMerged` faults);
(P) permanent, via a `batch_merge_branch_retained` event planted from inside the injected gate callback,
with no later squash on main to release it. Asserts `finishRefused`, exclusion from `landed`, and —
post-CR-correction — that a re-fire while the cause still persists (T) or has just been released without
moving the branch tip (P) is a genuine CACHE REPLAY (`cacheHit` present; no re-assembly; the sibling's
`merge_done` count stays unchanged; `finishRefused` still names the same candidate), and that
`worker_merge_confirm` called DIRECTLY on that candidate (`confirmWorkerMergeTracked`, never a
`merge_batch` re-fire) is what actually finalizes it. The `classifyOutcome` reversion itself is proved RED
by a standalone, uncommitted negative-control script that re-adds the removed never-cached arm to compiled
`dist/sessions/service.js`, re-runs this committed test against the mutated build, confirms exactly the
three cache-replay assertions above go RED (and only those — the permanent-cause scenario is unaffected,
since the removed arm never touched it), then restores the known-good `dist` from a backup and triggers a
clean rebuild — never a committed test that mutates `dist` itself.

### Evolution of this test (why it is no longer a `finishAlreadyMerged` stub)

Two earlier, discarded designs, in order:

1. **Stubbed `isBranchHeld` by call ORDINAL** on the target branch (call #1 = pre-assembly selection, call
   #2 = the finalize-time `heldAtFinish` check). EMPIRICALLY WRONG: the batch's own candidate resolution
   calls `isBranchHeld`-reaching code (via `reviewedTipVerdict`) for the SAME branch an EXTRA time before
   assembly, so ordinal #2 fired during SELECTION instead, excluding the candidate from the batch entirely
   and routing it through the SOLO fallback path — this card's own fix was never exercised at all, despite
   some assertions appearing to "pass" by accident. Same lesson `docs/decisions/f2b4d684-*.md` states
   generally ("Do not design a regression test for a multi-read confirm with a PLAIN boolean toggle").
2. **Stubbed `finishAlreadyMerged` itself**, forging its return value directly for the target branch — a
   simpler, more precisely-scoped fix for (1)'s problem (it tests how `mergeBatchTracked` surfaces the
   result, not how the hold is detected), and what this record originally shipped with.

The CR (session `20d9173d`) supplied its own REAL, unstubbed repro (`heldProbeGitFactory` for the
transient cause; a planted retain event for the permanent one) and asked for it to be adopted where cheap
— it was, and is what the committed test now runs. The stub approach is no longer in this file at all.
