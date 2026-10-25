# 45036494 — keep batch landings working under a commit-msg hook, and make a displaced trailer DISCOVERABLE

Found by `c13666c6`'s investigation, confirmed with real-git repros (a repo with an unscoped, realistic
`commit-msg` hook that appends a `Signed-off-by:`-shaped paragraph after whatever message git was about to
commit).

## The two bugs

**BATCH hard-fail.** `landBranchCommitsIndividually`'s two tip-trailer checks (`batch-merge.ts`) folded
BOTH `"displaced"` and `"unreadable"` kinds into `headMoved:true`. `assembleBatchBranches` returns on the
FIRST `headMoved` for the WHOLE batch assembly — so in a repo whose hook fires on every commit, the very
first candidate aborts every batch, permanently, with a reported cause ("this worktree's HEAD... may have
been tampered with") that is actively wrong, and whose suggested remedy ("re-firing merge_batch is safe")
actively does not help: the hook fires identically on every retry.

**SOLO trailer-reader invisibility, STILL PRESENT after `c13666c6`.** `f224632d` (round 2) kept a
displaced/unreadable solo landing VERIFIED (ledger row written, trust stamped) — but every trailer
READER (`findLandedSquashCommit`, `scanMergedCommitMap`, `findAllLandedTrailerCommits`, the merged-commit
map) discovers a candidate ONLY via `git log --grep` + `parseLoomTrailerBlock`, and that discovery step
itself requires the trailer to be parseable — which it structurally is not for a displaced/unreadable
commit. `c13666c6` added a ledger-based VERIFICATION gate for the branch-gone arm, but that gate is only
ever consulted AFTER a candidate sha is found — it never widened discovery itself, so it never actually
reaches this population. Confirmed via real repro: a genuinely ledgered, c13666c6-eligible landing still
resolves `findLandedSquashCommit`/`getTaskMergedInfo` to `null`.

The ONE unaffected call site is `finalizeMerge`'s direct confirm-time persist (`mergedSha: merge.sha`) —
it reads the merge's own return value directly, never re-discovering anything, so the board's immediate
`mergedSha`/`merged` state is correct right after confirm. Every other reader (crash-recovery, a
re-spawn's ALREADY_MERGED check, boot-reconcile's periodic sweep, the Git tab) remains exposed exactly as
badly as before `c13666c6`.

## The fix

### (1) Batch: mirror the solo M1 ruling (f224632d)

`landBranchCommitsIndividually`'s two trailer checks ("plain", at the per-commit tip; "final", after the
Base/PathSet amend) now only abort (`headMoved:true`) on a genuine `"forged"` namespace mismatch.
`"displaced"`/`"unreadable"` fall through kept VERIFIED. The "plain" check's classification is
PROVISIONAL — the Base/PathSet amend rebuilds the message from Loom's own clean internal state
(`finalMessage`), re-triggering the hook fresh, so the "final" check (which reads the message AFTER that
amend) is authoritative and is what sets `LandResult.trailerAdvisory`, threaded through
`BatchLandedBranch.trailerAdvisory` → `RunBatchedMergeResult.landed[].trailerAdvisory`.
`mergeBatchTracked` (`sessions/service.ts`) calls the SAME `fileTrailerDisplacedAdvisory` method the solo
path already uses — generalized to both callers, never a second copy — once per landed candidate that
carries one; the method's own in-process `(projectId, repoKey)` dedup makes this safe even when several
candidates in one batch all carry an advisory.

Non-tip commits can never produce `"displaced"` at all: their own `expected` set is `{}`, and
`loomTrailerBlockDisplaced` explicitly returns `false` whenever `expectedKeys.length === 0` — so this fix
is correctly scoped to the two TIP-commit checks only.

### (2) The `batch_merge_head_moved` fallback tail is now accurate by construction

The fixed-string "...may have been tampered with; re-firing merge_batch is safe..." tail
(`sessions/service.ts`, the `batchHeadMoved` handler) is no longer reachable via a hook diagnosis at all
— after (1), every remaining cause that still sets `headMoved` genuinely IS a worker-writable-ref fact (a
HEAD mismatch, or a real `"forged"` value mismatch), so the tail's claim is now true for every case that
reaches it. A comment at the call site states this invariant explicitly, so a future change that
reintroduces a non-tamper `headMoved` cause is flagged to re-examine the tail before trusting it.

### (3) Readability: a bounded, DISCOVERY-ONLY tolerant reader (`tolerantFindLoomTrailerBlock`)

`parseLoomTrailerBlock` is UNCHANGED — its "final paragraph only" semantics stay exactly as every other
caller (hold-release, `readLandedTipTrailer`, `pinnedTipForLandedSquash`, the solo identity-recovery
check, `verifyLoomTrailersExactAndReadable`'s own round-trip) already relies on, per `95940402`'s own "Do
not". Internally refactored (behavior-preserving) to share a `parseTrailerParagraph` per-paragraph helper
with the new function, rather than duplicating the field-extraction regex a second time.

`tolerantFindLoomTrailerBlock` (`git/worktrees.ts`) accepts a Loom trailer block that is NOT the
message's final paragraph only when:

1. Exactly ONE paragraph (never the subject) parses as a self-contained Loom block on its own
   (`parseTrailerParagraph`). More than one is ambiguous and refuses — never guess which is real.
2. Every paragraph AFTER that block is itself a well-formed `Key: value`-only block (the same shape
   `loomTrailerBlockDisplaced` already treats as an honest hook) — bounded at
   `TOLERANT_TRAILER_MAX_TRAILING_PARAGRAPHS` (3) and `TOLERANT_TRAILER_MAX_TRAILING_LINES` (12). A
   single prose line, or exceeding either bound, refuses.
3. The identified block's own parse is turned into a CANONICAL-case `expected` set (round 2 — see below;
   never built from the raw scan), and the reserved-namespace scan of the WHOLE message must exactly
   equal that set — reused from the SAME `reservedNamespaceExactlyMatches` core `verifyLoomNamespaceExact`/
   `loomTrailerBlockDisplaced` already apply, never a second copy. This accepts the tolerant reader's
   discovery ONLY when the landing path itself would classify the same message `"displaced"` (or
   `"verified"`) — never anything it would call `"forged"`.

**`"unreadable"` discovery is explicitly OUT OF SCOPE.** That kind is foreign content folded into the SAME
paragraph as Loom's own trailer, with no blank-line boundary at all — there is no boundary this function
could walk past. The batch landing path still treats an `"unreadable"` LANDING as advisory (never a hard
failure, per (1) above); this function just can never DISCOVER one after the fact. A displaced/unreadable
solo OR batch landing is still visible immediately via the direct confirm-time persist either way.

### Round 2 (Code Review 04cfeb36)

**(1) BLOCKING, reviewer's own words (Code Review 04cfeb36):** "does not refuse a LONE case-variant
reserved key, nor an UNKNOWN reserved key — only a DUPLICATE (L4479 `seenKeys`). The round-trip at
L4507-4510 compares only the 4 canonical-case keys, so any other scanned key is silently ignored." Repro,
also verbatim: `s\n\nLoom-Worker-Branch: loom/x\nloom-worker-pathset: <64d>\n\nSigned-off-by: a` gives
tolerant `{branch:"loom/x", pathSet:null}`, and `...Loom-Worker-Extra: zzz\n\nSigned-off-by:...` is
accepted; `verifyLoomTrailersExactAndReadable` classifies BOTH as `"forged"`. **Fix:** a new shared core, `reservedNamespaceExactlyMatches(message, expected)`,
factored out of `verifyLoomNamespaceExact`'s and `loomTrailerBlockDisplaced`'s own previously-duplicated
dedup/size/value loop (verified behaviorally equivalent to both for every input — dedup, missing-key,
extra-key, value-mismatch — before replacing their inline copies). `tolerantFindLoomTrailerBlock`'s own
round-trip now builds `expected` from the PARSED block's own canonical-case fields (never the raw scan)
and calls this same shared core against the whole message — a scanned key that isn't one of the four
exact canonical names (wrong case or unknown) now fails immediately, exactly like it would for
`verifyLoomNamespaceExact`. A property-style test (`tolerant-loom-trailer-discovery.mjs`) pins the
invariant directly: for every ACCEPT fixture, `verifyLoomTrailersExactAndReadable` on the same message
must say `"displaced"` or `ok:true`, never `"forged"`.

**(2) Minor (introduced by this card), reviewer's own words:** shadowing at worktrees.ts ~7666-7670
(break on first match) and ~8233 (first map hit wins) — "a NEWER tolerant-only-found candidate that then
FAILS verification now HIDES an older genuine landing (null instead of the real sha)." "The honest
trigger is a hand-authored commit quoting a Loom block followed by a Claude-Session/Signed-off-by
paragraph." **Fix chosen: rank strict above tolerant, never fall back to re-scanning past a failed
verification.** `findLandedSquashCommit` now keeps
scanning (without breaking) once it has only a tolerant hit, remembering the FIRST such hit, until either
a strict match is found (which wins unconditionally, breaking immediately) or the scan ends (the
remembered tolerant hit is then used). `scanMergedCommitMap` tracks tolerant-only hits in a SEPARATE map,
merged into the real map per-branch only where no strict hit exists for that branch. **Why this option
over "verify-then-retry-older-candidate":** it touches no new control flow around verification itself (the
branch-present/branch-gone logic after the loop, and `resolveMergedCommitMapHit`, are both completely
unchanged) — only the DISCOVERY step's own candidate-selection priority changes, which is strictly less
shared state than threading a retry loop through the verification logic too. `findAllLandedTrailerCommits`
needs no equivalent fix — it already returns EVERY candidate (never "first wins"), so its caller does its
own ranking.

**(3) Minor — types.** `trailerAdvisory?: "displaced" | "unreadable"` added to `MergeBatchResult.landed`
and to `mergeBatchTracked`'s own local `landed` rebuild array (`sessions/service.ts`) — both were carrying
the field via an untyped object-literal spread.

**(4) Minor — comment/record accuracy, `findAllLandedTrailerCommits`, reviewer's own words:** worktrees.ts
~7772 and this record's "Widened call sites" claim its caller runs `recordedTipContentLanded` on every
candidate. "a candidate carrying `Loom-Landed-Tip` goes to `verifyReviewedTipChain(reviewedTip,
candidate.trailers.landedTip)` (service.ts ~27329-27336) — a chain check of the trailer VALUE, never
`candidate.sha`'s content." Corrected both to name that arm honestly: no new capability (a strict-shaped
plant already reaches it), but the precondition does not hold as written. The arm itself is NOT fixed
here; carded separately.

**(5) Nit.** `batch-merge-head-moved-commit-identity.mjs`'s own ALL-PASS summary banner still said hook
paragraphs refuse — corrected to describe the kept-VERIFIED outcome.

### Corrected finding: a re-spawn on the SAME branch name never reaches ALREADY_MERGED either way

The investigate-first checkpoint flagged a risk, not independently reproduced at the time: a worker
re-spawned on the same branch name after a displaced landing might fail its own ALREADY_MERGED check and
attempt to re-land. Writing the test for this (`(HOOK-DISPLACED-RESPAWN)`,
`mainline-watch-own-commit-verify.mjs`) found the real shape is different, and is **unrelated to
displacement at all**: `findLandedSquashCommit`'s own RE-TASK GUARD ("if the trailer commit is an
ANCESTOR of the branch tip, the branch was re-cut onto it... NOT an orphaned squash-merge") fires for ANY
freshly re-cut branch — a re-cut branch's own tip always descends from the prior landing, so
`merge-base(sha, branchRef) === sha` unconditionally, independent of trailer shape. Verified directly: the
SAME lookup that resolved the landing moments earlier (branch gone) returns `null` again the instant a
branch of that name exists again. `mergeBranch`'s `!staged` arm then falls through to
`STAGE_EMPTY_RETRY`, never `ALREADY_MERGED` — but since `!staged` is genuinely true (the content really is
identical), **no new commit is ever created either way** — the only real-world cost is a less-helpful
"re-task or close by hand" message instead of a clean ALREADY_MERGED one. No duplicate-landing or
data-loss risk exists here, displaced or not.

### Widened call sites, each with its own independent, non-trailer verifier

- `findLandedSquashCommit` — branch-present arm: `branchContentLandedInCommit` (content equality).
  Branch-gone arm: `verifyGoneBranchLanding` (`c13666c6`'s ledger gate).
- `scanMergedCommitMap` (feeds `resolveMergedCommitMapHit`, and so `getTaskMergedInfo`,
  `findLandedSquashCommitViaMap`, the Git tab's `resolveWorkerBranchInfo`) — same two verifiers as above,
  via `resolveMergedCommitMapHit`'s own two arms.
- `findAllLandedTrailerCommits` — **correction (round 2, Code Review 04cfeb36):** its one caller
  (`sessions/service.ts`'s review-moved resolution) does NOT content-check every candidate. Only a
  candidate WITHOUT a `landedTip` is content-checked (`recordedTipContentLanded(candidate.sha, ...)`); a
  candidate WITH one instead chain-checks the TRAILER VALUE itself (`verifyReviewedTipChain`), never
  `candidate.sha`'s own content. This widening adds no NEW capability — a strict-shaped plant already
  reaches that arm unverified today — but the original "every candidate is content-checked" framing here
  was wrong. The arm itself is not fixed by this card; tracked separately.

### Deliberately left STRICT (no verifier runs on the candidate before it's trusted, or it IS the trust
decision itself)

- `findIntroducingSquashCommit` — attribution-only (`293d418e`); never used for gating/verification.
- `readLandedTipTrailer` (feeds the solo finalize CAS pin) — `cc9bce38`'s own "Do not": "read the trailer
  from anywhere but the final trailer block."
- `landBranchCommitsIndividually`'s own amend-failure identity-recovery check (`batch-merge.ts` ~855) —
  verifying a just-attempted commit's OWN identity, not discovering a historical landing; no independent
  verifier follows it, it IS the check.
- `verifyLoomTrailersExactAndReadable`'s own round-trip — the TRUST-layer check itself; widening it would
  remove the very thing every other site relies on being strict.
- `findLaterBranchSquash` — found, but NOT in the manager's enumeration and genuinely has no accompanying
  verifier (callers treat "found" as sufficient on its own, with no content/ledger check after). Flagged
  here as a residual rather than silently widened; a future card can decide whether it needs the same
  treatment.

## Found but out of scope (not fixed here)

While wiring `trailerAdvisory` through `mergeBatchTracked`'s own settled-result rebuild (`sessions/service.ts`,
the two `landed.push({...})` call sites that re-derive the settle value from `result.landed` rather than
returning it directly), found that `BatchLandedBranch.pathSetStamped` itself has never been copied into
either rebuild — only `mergedVerification` (derived FROM it, persisted onto the task) ever reaches
production code; the field is simply absent from every settled `landed[]` entry a caller reads. Pre-existing,
unrelated to this card's own trailer-advisory fix; flagged here rather than fixed, since widening this
card's own diff to also thread an unrelated field risks obscuring the actual fix in review.

`findLaterBranchSquash` staying strict (no accompanying verifier — flagged round 1, left alone) and the
`findAllLandedTrailerCommits` `landedTip` arm's own content-check gap (round 2, item 4 above) are each
tracked by the manager as their own follow-up cards — neither is fixed in this card.

## Do not

- Do not change `parseLoomTrailerBlock`'s own semantics to be tolerant — every other existing caller
  relies on its current "final paragraph only" strictness; widen discovery via `tolerantFindLoomTrailerBlock`
  instead, never by loosening the strict reader itself.
- Do not call `tolerantFindLoomTrailerBlock` from any site that has no independent, non-trailer verifier
  on its result — see the "Deliberately left STRICT" list above before adding a new call site.
- Do not accept a tolerant match on `blockCandidates.length !== 1` — more than one well-formed Loom block
  anywhere in the message is ambiguous; never guess which is real.
- Do not widen `TOLERANT_TRAILER_MAX_TRAILING_PARAGRAPHS`/`TOLERANT_TRAILER_MAX_TRAILING_LINES` without
  re-checking the bounded-refusal tests that pin them — a hook that does something stranger than append a
  few trailer-shaped lines must still refuse, never silently widen.
- Do not attempt "unreadable" discovery — there is no paragraph boundary to walk past; this is a named,
  deliberate residual, not an oversight.
- Do not fold a genuine `"forged"` namespace mismatch into the kept-verified path on either the batch or
  solo side — only `"displaced"`/`"unreadable"` are what a repo's own legitimate hook produces.
- Do not write a second `fileTrailerDisplacedAdvisory`-shaped method for the batch path — both callers
  share the one method; its own in-process dedup already makes a per-candidate call site safe.
- Do not read the `batch_merge_head_moved` fallback's "may have been tampered with" tail as safe by
  accident — it is safe BECAUSE a hook diagnosis no longer reaches `headMoved` at all (see (2) above); a
  future change reintroducing a non-tamper `headMoved` cause must re-examine that tail.
- Do not build `tolerantFindLoomTrailerBlock`'s round-trip `expected` set from the raw namespace scan —
  build it from the PARSED block's own canonical-case fields (round 2 fix). A raw-scan-derived set agrees
  with itself trivially and never catches a lone case-variant or unknown reserved key.
- Do not write a third copy of the reserved-namespace exact-match loop — `reservedNamespaceExactlyMatches`
  is the ONE shared core `verifyLoomNamespaceExact`, `loomTrailerBlockDisplaced`, and
  `tolerantFindLoomTrailerBlock`'s own round-trip all call; a new caller needing this rule reuses it too.
- Do not let `findLandedSquashCommit`/`scanMergedCommitMap` break/keep on the FIRST tolerant-only match
  without first checking for a strict one — strict ALWAYS wins regardless of recency (round 2 fix), or a
  newer tolerant-only candidate that fails its downstream verifier can hide an older genuine landing.
- Do not re-derive the `findAllLandedTrailerCommits` caller's verification coverage from memory — re-read
  its own two arms (`landedTip` present vs. `base` present) before restating which one content-checks
  `sha`; round 1's own comment here was wrong once already.
