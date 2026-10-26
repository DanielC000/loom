# c0d0eac9 — pick the newest VERIFIED landing when strict and tolerant hits compete, with round 2's strict-first answer as a floor

From 45036494's second Code Review (reviewer `18858c9a`), the documented round-3 residual: ranking strict
unconditionally above tolerant means an OLDER strict landing hides a NEWER genuine tolerantly-readable
(hook-displaced) landing of the SAME branch name. Real-git repro: S1 = older strict landing of `loom/x`;
`loom/x` is re-cut from main; T2 = newer, genuinely-ledgered, hook-displaced squash (a trailer paragraph
followed by a `Signed-off-by:` paragraph). Branch-present (between S1 and T2) correctly fails safe to
`null` (the pre-existing RE-TASK GUARD, unaffected by this card). Branch-gone (after T2's own finalize):
`findLandedSquashCommit` returned S1 — the WRONG, older sha — and the merged-commit map's own table agreed.
Reproduced on real git in a scratch script reusing `tolerant-loom-trailer-discovery.mjs`'s own (SHADOW)
fixture pattern, before any `src` edit; the repro and its cost analysis were checkpointed via
`worker_report(blocked)` and approved by the manager before implementation, with one change (see "The
cap-floor correction" below).

## The fix

Both readers replace their old "strict always wins, regardless of recency" rule with **"newest verified
wins, with round 2's strict-first answer as a floor."**

### `findLandedSquashCommit` (git/worktrees.ts)

The single `git log --grep` scan (unchanged — no new git spawn) now collects EVERY matching candidate,
strict and tolerant alike, in the scan's own newest-first order, instead of breaking on the first strict
hit. The branch-present/branch-gone verifiers themselves (`branchContentLandedInCommit`/the ledger-gated
`verifyGoneBranchLanding`) are completely UNCHANGED — only which candidate(s) get a turn at them changed.

**PHASE 1 ("newest verified wins"):** walk the candidate list newest-first, verifying up to
`MIXED_VERIFY_CAP` (5) of them (strict or tolerant, whichever comes first in scan order), returning the
first that passes.

**PHASE 2 (fallback — the round-2 floor):** if phase 1 exhausts without a pass, keep trying STRICT-only
candidates specifically, past `MIXED_VERIFY_CAP`, up to `STRICT_FALLBACK_VERIFY_CAP` (8) TOTAL strict
attempts (counting phase 1's own strict attempts, never a second independent budget). Past that cap, fails
CLOSED to `null`, logged once — same posture as every other cap in this file (e.g.
`GONE_BRANCH_LEDGER_ROW_SPAWN_CAP`, which this cap is sized to match).

### The map path (`scanMergedCommitMap` / `resolveMergedCommitMapHitList` / `MergedMapEntry`)

`scanMergedCommitMap` now stores a bounded, newest-first LIST of candidates per branch
(`MAP_CANDIDATE_LIST_CAP = MIXED_VERIFY_CAP + STRICT_FALLBACK_VERIFY_CAP = 13`), each tagged `strict:
boolean`, instead of a single "ranked winner" entry — the old `tolerantMap`/`map` two-table shape is gone.
A new wrapper, `resolveMergedCommitMapHitList`, walks that list with the IDENTICAL two-phase algorithm
above, delegating each attempt to the UNCHANGED single-candidate `resolveMergedCommitMapHit`. Both
`findLandedSquashCommitViaMap` and `getTaskMergedInfo` now call the wrapper instead of a bare
`map.get(branch)` + single resolve; `getTaskMergedInfo`'s returned `date` comes from the WINNING entry
(`resolved.entry.date`), never `candidates[0]`, since the winner is not always the newest candidate once
the strict-fallback floor fires.

**Memory cost of widening the map from 1 to up to 13 entries per branch:** measured on this repo's own
`main` (2026-10-26, `git log main -F --grep="Loom-Worker-Branch:" --format=...`): 3696 distinct branch
trailer values across 3701 matching commits; at most 2 candidates were observed for any one branch. The
cap (13) is never reached in practice — the real-world cost of this widening is negligible (well under 1MB
across the whole map), dominated by the handful of branches that land twice, not by the cap itself.

## The cap-floor correction (manager review, before implementation)

The investigate-first checkpoint's own original proposal ("past `MIXED_VERIFY_CAP` attempts, fail closed
to `null`") was a REGRESSION on an attacker-shapeable input: planting several newer, never-ledgered,
STRICT-shaped commits ahead of a genuine older strict landing would make the new code return `null` where
a floor-preserving design would still find the genuine landing. The manager's correction added PHASE 2
above — continuing to try STRICT candidates specifically, past the mixed cap, up to a second, independent
bound — so the fix can only ever return the SAME OR A NEWER verified landing than round 2's own
strict-first answer, never less. Verified directly (`CAP-FLOOR`, `tolerant-loom-trailer-discovery.mjs`): 6
newer, never-ledgered, strict-shaped fakes planted ahead of a genuine older strict landing still resolve to
the genuine landing, via both `findLandedSquashCommit` and `findLandedSquashCommitViaMap`.

## Cost model

Verification is the expensive part (real git spawns, plus — for the branch-gone arm — the c13666c6 ledger
gate's own ~2-4 spawns); the scan itself stays unbounded exactly as before (unchanged cost). Ordinary case
(one strict hit, as every lookup before this card): costs exactly 1 verification attempt, same as before
— measured directly (`SPAWN BOUND`, `tolerant-loom-trailer-discovery.mjs`): a single-candidate branch-gone
lookup costs 5 total git spawns via a counting `gitFactory`, small and bounded, matching this file's
existing `(SPAWN COUNT)` scenario in `branch-gone-ledger-cutover-gate.mjs` for the same shape. Round-2's
own SHADOW case (a newer tolerant-only hand-authored commit hiding an older genuine strict landing) now
costs 2 attempts instead of 1 (one failed tolerant attempt, then the successful strict one) — still green,
verified directly. Worst case (several newer candidates all failing verification): bounded at
`MIXED_VERIFY_CAP + STRICT_FALLBACK_VERIFY_CAP` = 13 total verification attempts, each costing at most a
handful of git spawns — never unbounded, regardless of how many trailer-matching commits exist in history.

## Reader sweep: no other first-hit-wins reader shares this shape

Checked every `parseLoomTrailerBlock`/`tolerantFindLoomTrailerBlock` call site in `packages/daemon/src`:

- `findAllLandedTrailerCommits` already returns EVERY candidate (never picks one) — its one caller does
  its own ranking; unaffected.
- `findLaterBranchSquash` only answers a boolean existence question via `.some()` — no single candidate is
  ever selected, so there is no shadowing surface here at all.
- `findIntroducingSquashCommit` is attribution-only (decision `293d418e`'s own "Do not": never use for
  gating/verification/pinning), uses STRICT parsing only (no tolerant fallback), and takes the
  already-resolved landed sha as a GIVEN input rather than selecting it itself — not exposed to this bug
  class.

## Round 2 (Code Review 96b5b772) — three blocking regressions against the floor rule

Round 2's Code Review compared the committed round-1 code (`950526fa`) against the pre-card code
(`966182f2`, transpiled) on the same real-git scenarios and found 3 BLOCKING regressions against the
floor rule ("never worse than round 2's — i.e. 45036494's own round 2 — strict-first answer"), 1 MAJOR
cost finding, and 2 nits. All fixed in this round.

### (1) CRITICAL — the map's per-branch list cap counted tolerant entries too

`MAP_CANDIDATE_LIST_CAP` (13) was a single shared cap: once `MIXED_VERIFY_CAP`+ tolerant-shaped candidates
landed in a branch's retained list, they could evict the genuine strict landing from it ENTIRELY — measured
directly: k=12 newer tolerant fakes above a genuine strict, gone-branch landing still resolved correctly on
every reader; k=13 and k=20 made `findLandedSquashCommitViaMap`/`getTaskMergedInfo` return
`{hit:true, sha:null}`/`null` while `findLandedSquashCommit` itself (unbounded, re-scanned fresh per call)
still found it. Boot-reconcile Pass A treats `hit:true` as authoritative, so this was a real "a genuinely
merged task reads as unmerged" regression. **Fix:** `scanMergedCommitMap` now tracks two SEPARATE
per-branch counters while building the list — the first `MIXED_VERIFY_CAP` candidates of ANY kind, then
ONLY strict candidates past that, up to `STRICT_FALLBACK_VERIFY_CAP` — mirroring the live walk's own
two-phase shape AT STORAGE TIME, so a tolerant candidate past the mixed window can never occupy a slot a
strict one might still need. Test: `(MAP-LIST-FLOOR)`, k=13 and k=20, through both readers — this is the
TRUE floor test (see (5) below for why PART F/`(CAP-IMPROVEMENT)` isn't one).

### (2) MAJOR — a newer tolerant candidate could beat an older strict one on CONTENT alone, never authorship

"Newest verified wins" let a hand-authored commit that merely QUOTES a Loom block beat a genuine older
strict landing wherever its own verifier checks CONTENT rather than authorship: (a) the ledger's `"skip"`
verdict (a scope with literally zero ledger rows, `maxRowId` null) accepts EVERY branch-gone candidate
unconditionally — a never-landed forgery passes exactly as easily as a genuine first-ever landing; (b) on
the branch-present arm, a decoy whose TREE happens to equal the live branch's own content passes
`branchContentLandedInCommit` without being the branch's real author at all. **Correction to this card's
own round-1 framing:** the round-1 decision record and commit message both described round 2's (45036494's)
own SHADOW case as now costing "2 attempts instead of 1 — one failed tolerant attempt, then the successful
strict one" — true ONLY on the ledger-WITH-ROWS arm (where an unledgered forgery genuinely fails
verification). On the ledger-SKIP arm, or the branch-present content-match arm, round 1's code did not
"fail verification first" at all — it WRONGLY SUCCEEDED and returned the forgery. That framing is retracted;
this round's own fix is what actually closes it.

**Fix (the ruling):** a TOLERANT candidate may only win over a competing STRICT candidate in phase 1 with
POSITIVE PROOF of authorship — the ledger's own `"recorded"` verdict, or a PathSet trailer that verifies.
Neither the ledger's `"skip"`/`"pre-ledger"` verdicts nor a branch-present content match count. `verifyGoneBranchLanding`
and `resolveMergedCommitMapHit` now both return `{passed, positiveProof}` instead of a bare boolean (see
the "Do not" update below — this DOES touch the shared verifiers, deliberately, overriding round 1's own
"never change the verifiers" bullet for this one, named reason). A tolerant-only branch (no strict
candidate anywhere in the list) is completely unaffected — it still resolves tolerantly via its own
verifier, exactly as the hook-displaced case this card exists for requires. Tests: `(SHADOW-SKIP-ARM)` (the
ledger-skip arm) and `(SHADOW-PRESENT-ARM)` (the branch-present content-match arm), both RED on `950526fa`.

### (3) BLOCKING — an uncaught transient fault on one candidate aborted the whole lookup

`verify()`'s branch-present arm (the bare `merge-base` call) had no per-candidate try/catch — a throw on
ANY candidate (not just the newest) propagated to the function's own OUTER catch, returning `null` for the
ENTIRE call and abandoning every other candidate, including an older one that would have verified cleanly.
`resolveMergedCommitMapHit` already isolated this per-candidate (its own whole-function try/catch), so only
the live `findLandedSquashCommit` path had the gap. **Fix:** `verify()`'s body is now wrapped in its own
try/catch, treating a throw as `{passed:false, positiveProof:false}` for that ONE candidate — the walk
continues to the next. Test: `(TRANSIENT-FAULT)` — a `gitFactory` that throws on exactly one candidate's own
`merge-base` call; the walk still resolves an older, cleanly-verifying candidate.

### (4) Cost — worst-case spawn count, non-blocking but addressed

(a) Phase 2 never re-verifies a candidate phase 1 already tried — already true by construction (phase 2's
own loop starts at index `mixedAttempts`, strictly past everything phase 1 walked); unchanged, confirmed
still holds under the round-2 edits. (b) `resolveMergedCommitMapHit`'s own `git branch --list` call is now
HOISTED ONCE per lookup by `resolveMergedCommitMapHitList` (a new required `branchPresent: boolean` param,
replacing the per-candidate internal spawn) — previously every one of up to 13 candidates re-spawned this
identical check. Re-measured worst-case spawn count after both fixes, same adversarial inputs the review
costed: `findLandedSquashCommit` and the map path both stay within single-digit-per-candidate cost, bounded
by the same two caps as before — no unbounded growth introduced by this round's own changes (the review's
"7 → 65" / "7 → 77" figures were against the ROUND-1 code before hoisting; this round's fix is what brings
the map path's per-lookup branch-list cost back down to 1, matching `findLandedSquashCommit`'s own shape).

### (5) Test relabelling

PART F / `(CAP-FLOOR)` (round 1) is NOT a floor test — relabelled `(CAP-IMPROVEMENT)`: the PRE-card
("strict always wins") code ALSO returns `null` for 6 newer strict forgeries ahead of a genuine older
strict landing (it tries only the single newest strict candidate it finds and never retries), so this
card's own bounded fallback is an IMPROVEMENT over that baseline, not a floor it was already meeting. The
TRUE floor test is (1) above — `(MAP-LIST-FLOOR)` — where the pre-card code DOES get it right (for any k,
since it only ever looks at the first strict match, ignoring tolerant candidates entirely) and this card's
fix must not regress it. `(SPAWN BOUND)` tightened from `<=10` to an exact `=== 5`, re-measured against the
committed code.

### (6) Nit — `onPreFixTrailerNotice`'s log line

`sessions/service.ts`'s boot-reconcile log said "N worker(s) had a landed squash with no PathSet trailer" —
stale since round 1 widened this callback to fire per-candidate, not per-worker. Reworded to "N candidate(s)
examined had...".

## Round 3 (Code Review f894a151) — 3 blocking regressions, 1 major cost finding, 2 nits

Round 3's Code Review compared the committed round-2 code (`d3d82bc7`) against the pre-card code
(`966182f2`, transpiled) on the same real-git scenarios and found 3 BLOCKING regressions against the floor
rule, 1 MAJOR cost finding, and 2 nits. All fixed in this round.

### (1) CRITICAL — the hoisted `git branch --list` swallowed a failure into a false accept

`resolveMergedCommitMapHitList`'s own comment claimed its `branchPresent:false` degrade on a failed
`git branch --list` read was "never a false accept" — false. Measured: S1 (a genuine, ledgered landing) is
re-cut from main with new live work and stays PRESENT; the hoisted `branch --list` call is rejected (a
transient failure). The degrade routes the LIVE branch onto the branch-gone arm, which skips the re-task
guard entirely: `findLandedSquashCommitViaMap`/`getTaskMergedInfo` return `{hit:true, sha:S1}`/`S1` where
the correct answer (matching `findLandedSquashCommit`, and matching what the degrade's own comment
claimed) is `{hit:true, sha:null}`/`null`. Boot-reconcile Pass A trusts `viaMap.hit`, so a legacy squash
with no `Loom-Landed-Tip` trailer could finalize and delete a live re-task's branch and worktree — the
2026-06-05 data-loss class. **Fix:** a branch-list failure now makes `resolveMergedCommitMapHitList`
return `null` for the WHOLE lookup (matching `findLandedSquashCommit`, whose own branch-list call already
lived inside that function's single outer try and so already failed this way). Test: `(MAP-PATH-FAULT)`,
through both `findLandedSquashCommitViaMap` AND `getTaskMergedInfo`.

### (2) MAJOR — positiveProof via the PathSet leg was forgeable

Round 2's own `positiveProof: pathSetVerified || verdict === "recorded"` let a self-consistent PathSet
trailer alone count as positive proof — but `verifyPersistedPathSet` is SELF-consistent only (decision
`756a2cd8`: proves the file set, never authorship). A hand-authored, never-landed, zero-diff commit (its
own tree equal to its own parent's) carries an empty changed-path-set, so `Loom-Worker-PathSet:
sha256("")` trivially verifies against its own ancestry with no real landing behind it at all. Measured: a
newer tolerant fake carrying this self-forged trailer beats a genuine older strict landing on BOTH the
ledger-`"skip"` arm (ledger present, zero rows) and the complete NO-LEDGER case (`deps` carries no
`goneBranchLedger` key at all), on all readers. **Fix:** `positiveProof` is now the ledger's `"recorded"`
verdict ONLY — `verifyGoneBranchLanding`'s no-ledger branch returns `positiveProof: false`
unconditionally, and its ledger-gated branch drops `pathSetVerified` from the `positiveProof`
computation entirely. Test: `(SHADOW-SKIP-ARM-PATHSET)`, extending `(SHADOW-SKIP-ARM)` with a PathSet-
bearing fake on both the ledger-skip arm and the no-ledger variant.

### (3) BLOCKING — a transient ledger "error" verdict let the walk fall through to a stale candidate

`classifyAgainstLedger` can return `"error"` for a single candidate (a transient git failure, e.g. the
ledger's own pre-ledger boundary check failing) — card `c13666c6`'s own doc says this "fails closed like
unrecorded". But round 2's walk only ever checked `passed`, so an "error" on the NEWEST candidate (S2,
genuine and ledgered) was treated exactly like an ordinary fail, and the walk continued to an OLDER, STALE
candidate (S0, also genuine and ledgered) and returned it — where the pre-card code (which only ever tried
the single newest strict candidate) would have returned `null`. An "error" verdict means that candidate's
real status is UNKNOWN, not confirmed-absent, so falling through to an older candidate silently returns
LESS than round 2's own single-attempt floor. **Fix:** `verifyGoneBranchLanding` now also returns
`ledgerError: verdict === "error"`; on a STRICT candidate, both phases of the shared walk abort the WHOLE
lookup to `null` the moment they see it, rather than continuing. Test: `(ERROR-ABORT)` — S0 (older) and S2
(newer) both genuine and ledgered; S2's own pre-ledger `merge-base` call is fault-injected to throw,
producing `"error"` (never `"unrecorded"`) for S2 specifically; the fix returns `null`, never stale S0.

### (4) Suggestion, adopted — one shared walk

`findLandedSquashCommit`'s own PHASE 1/PHASE 2 loops and `resolveMergedCommitMapHitList`'s identical-
looking copy had already drifted once (finding 1 above is exactly such a drift: the map path hoisted
`branchPresent` with a different failure-handling shape than the live reader's inline call). Extracted a
single shared `walkCandidates` helper — the cap bookkeeping, the positive-proof gate, and the new
ledger-error abort now live in ONE place; each reader supplies only its own per-candidate `verify` (its own
I/O) and a `caller` label for the cap-exceeded log. `resolveMergedCommitMapHit` now returns the same four-
field shape (`{passed, positiveProof, ledgerError, resolved}`) as the live reader's own closure, always —
never a bare `null` on failure — so the shared walk can see `ledgerError` regardless of which reader called
it.

### (5) Cost — the per-lookup `git branch --list` rate-limit log

Unchanged from round 2 — the cap-exceeded `console.warn` already fires at most once per lookup; round 3's
only change here is routing it through the shared walk's own `caller` label (`"findLandedSquashCommit"` /
`"resolveMergedCommitMapHitList"`), preserving which reader logged it.

### (6) Test relabelling

`(TRANSIENT-FAULT)` (round 2) is reworded to make explicit that both its OLDER and DECOY fixtures are
deliberately-crafted, content-match STRICT forgeries on a live branch — a strict candidate's content match
is accepted regardless of authorship (a pre-existing, out-of-scope limitation; see "Reader sweep" below —
this is NOT something any round of this card fixes, unlike the tolerant-candidate case PART J tests). The
test's `found === olderSha` assertion isolates ONLY the try/catch gap (round 2 finding 3); it is not an
endorsement that OLDER's own forged acceptance is correct.

## Round 4 (Code Review 06825f63) — RETRACTS round 2's TRANSIENT-FAULT ruling; generalizes finding B1

Round 4's Code Review VERIFIED round 3's own findings 1-3 fixed on every reader (`findLandedSquashCommit`,
`findLandedSquashCommitViaMap`, `getTaskMergedInfo`; boot-reconcile Pass A fails closed). It found the
stale-fallthrough CLASS was still open — round 3 only ever aborted the walk on a LEDGER `"error"` verdict,
and only when the erroring candidate was STRICT.

### B1 MAJOR (blocking) — ANY non-definitive outcome on ANY candidate must abort the whole lookup

Measured scenario H: S0 and S2, both genuine, ledgered, carrying REAL (self-consistent, not forged)
`Loom-Worker-Base`/`Loom-Worker-PathSet` trailers. S2's own `verifyPersistedPathSet` diff call (NOT the
ledger) fails transiently ⇒ round 3's code returned the stale S0 on all 3 readers, where the pre-card
floor gives `null`. Measured scenario D: a TOLERANT-ONLY branch (no strict candidate anywhere in the
list), T0 and T2 both genuine and ledgered; a ledger error on T2 ⇒ round 3's own `candidate.strict &&
outcome.ledgerError` gate never fires (T2 isn't strict), so the walk fell through to stale T0.

**⭐ The LEAD's ruling, one rule:** ANY non-definitive outcome on ANY candidate the walk evaluates aborts
the WHOLE lookup to `null` (the map path reuses the SAME not-found/null shape round 3's own finding 1
uses for a branch-list failure) — whether the candidate is strict or tolerant. Non-definitive means: a
throw, a PathSet read/diff error, a ledger error, or a merge-base/content-check error. Only a DEFINITIVE
mismatch (the check ran and genuinely said no) lets the walk continue to an older candidate.

**This RETRACTS round 2's own TRANSIENT-FAULT ruling** ("a throw on one candidate must never abort the
whole lookup — the walk continues to an older candidate"). Reasoning: the pre-card floor returns `null` on
this exact shape. Continuing past a non-definitive outcome is an improvement over that floor ONLY when the
older candidate the walk falls back to happens to be the genuinely right one — and it is a below-floor
STALE SHA otherwise. The walk cannot tell those two cases apart from the inside (that is exactly what
"non-definitive" means), so it now takes the floor instead of gambling on the better-looking outcome.
Accepted cost: a transient git error anywhere in the walk now yields "not found" (matching the pre-card
behavior) instead of an older genuine sha that round 2/3's code might have happened to land on.

**Fix — tri-state verification, threaded through the one shared walk:**
- `verifyPersistedPathSet` and `branchContentLandedInCommit` now return a `CheckVerdict`
  (`"pass" | "fail" | "error"`) instead of a bare boolean — `"error"` on any of their own internal git
  calls failing, never collapsed into `"fail"`.
- `verifyGoneBranchLanding`'s own `error` field (renamed from round 3's `ledgerError`) is now true on
  EITHER a non-definitive PathSet check OR a ledger `"error"` verdict.
- Both readers' own `verify()` closures propagate `error:true` for an uncaught throw (their own outer
  catch, previously a bare `{passed:false}`) AND for a definitive-vs-non-definitive content-check result.
- `walkCandidates` aborts to `null` on `outcome.error` for ANY candidate, in BOTH phases — the
  `candidate.strict` conditioning round 3 had here is gone entirely.

Tests: `(STALE-FALLTHROUGH-PATHSET)` (scenario H, PART N) and `(TOLERANT-ERROR-ABORT)` (scenario D, PART
O), through `findLandedSquashCommit`, the map path, and (for H) `getTaskMergedInfo`. `(TRANSIENT-FAULT)`
(PART K) is updated to assert `null` instead of `olderSha`, reflecting the retraction above. All RED on
`b3e83d10`, GREEN after this round.

### N1 MAJOR doc (fix) — a stale, pre-round-3 copy of the Do-not bullets

This record's own `## Do not` section had accidentally grown a SECOND, stale copy of round 2's own
bullets, appended after round 3's corrected ones (an artifact of round 3's own edit: the replacement
ended exactly at the `## Do not` heading rather than consuming the bullets that followed it). The stale
copy re-taught "a tolerant candidate may win with the ledger's `"recorded"` verdict, OR a verified PathSet
trailer" (wrong since round 3) and never mentioned the branch-list-failure rule at all. Since every
`@decision c0d0eac9` anchor in source injects this record's ENTIRE `## Do not` section via the guard-
extract hook, a reader was handed both the correct and the stale version together. Deleted the stale
block; the `## Do not` section below is now the one, current copy.

### N2 Minor (fix) — the cap-exceeded warn needed rate-limiting, and the map path can't reach it

`walkCandidates`' own cap-exceeded `console.warn` fired on EVERY call that exhausted both phases, with no
rate limit — measured: 9 strict fakes planted ahead of a genuine landing ⇒ 10 `findLandedSquashCommit`
calls (the way `getTaskMergedInfo`/the Git tab's `getWorkerDiff` is UI-polled) emit 10/10 warns. Fixed:
`logWalkCapExceededRateLimited`, keyed by `(caller, branch)`, same shape as
`logGoneBranchLedgerErrorRateLimited`.

Separately: the MAP path's own copy of this warn is structurally UNREACHABLE. `scanMergedCommitMap` caps
a branch's STORED strict entries at `STRICT_FALLBACK_VERIFY_CAP` (8) — so `resolveMergedCommitMapHitList`'s
own call into `walkCandidates` can never present a 9th strict candidate for the cap-exceeded branch to
even consider; only `findLandedSquashCommit`'s own unbounded, fresh-per-call scan can genuinely exceed the
cap. This is a property of the TWO READERS' different candidate-gathering shapes (one bounded at storage
time, one unbounded and rescanned per call), not a bug in the shared walk — documented here rather than
"fixed", since there is nothing to fix: the map path's own candidate list structurally cannot overflow in
this specific way.

### N3 Minor test (fix) — SHADOW-SKIP-ARM-PATHSET under-asserted two reads

The reviewer's own probe B showed `getTaskMergedInfo` and the map path under the NO-LEDGER variant both
already correct on `b3e83d10` (round 3's own fix is global in `verifyGoneBranchLanding`, so both reads
were never actually broken) but UN-asserted by round 3's own test — only the ledger-skip arm's direct
reader and map-path reads were checked. Added both assertions to `(SHADOW-SKIP-ARM-PATHSET)`.

### Load-bearing dependency (record only, no code change)

The reviewer found that `positiveProof`'s `"recorded"` leg (round 3) now RELIES on the batch landing path
stripping reserved `Loom-*` trailer lines from each worker's own commit body before cherry-picking it
(`batch-merge.ts` ~:716, decision `95940402`) — a ledger row's own range covers every worker intermediate
commit VERBATIM, and `classifyAgainstLedgerUncached`'s RECORDED leg walks that range directly (`rev-list
--first-parent row.base..row.tip`, see this record's own earlier section). If a worker's own commit body
ever carried an un-stripped `Loom-Worker-Branch:`/`Loom-Worker-PathSet:` line that named a DIFFERENT
branch, the ledger's membership check would still correctly find `sha` inside the row's range (membership
by commit identity, not by trailer content) — but this is named here as a load-bearing dependency should
`batch-merge.ts`'s own stripping ever regress.

## Round 5 (Code Review 26278861) — a below-floor regression IN round 4's own fix, and the THE RULE

Round 4's own fix (above) collapsed every non-definitive outcome into `error:true` — but it did this by
simply letting a candidate-supplied value reach git UNVALIDATED and catching whatever came back. That
reopened a below-floor regression of exactly the shape round 4 exists to close, just one level down.

### 1. MAJOR (blocking) — a candidate's OWN bogus trailer value could abort the whole lookup

Measured on `findLandedSquashCommit` and `findLandedSquashCommitViaMap`: `Loom-Worker-Base` is parsed with
no shape validation at all (`/^\S+$/` in `parseTrailerParagraph`) and handed straight to `git diff
<base>..<sha>` inside `verifyPersistedPathSet`. A bogus value (`"deadbeef"`, 8 hex chars — not a real
object id) makes that `git diff` call throw ("fatal: bad revision" / "fatal: Invalid revision range"),
which round 4 classified as `error:true` and aborted the WHOLE lookup — even though NOTHING about this is
ambiguous: the candidate's own claimed Base simply doesn't name a real commit. Needs no forged STRICT
commit at all — a newer TOLERANT-only commit naming the branch, with a bogus Base + a PathSet + a trailing
`Claude-Session:` paragraph, is enough, and that exact shape fits an honest human docs commit that happens
to quote a Loom trailer block. Pre-card (`966182f2`) and round 3 (`b3e83d10`) both return the genuine
older sha correctly here — round 4 alone regressed it.

### ⭐⭐ THE RULE (read this before touching any check in this walk again)

> **A failure INDUCED BY THE CANDIDATE'S OWN CLAIMED DATA is DEFINITIVE (`"fail"`), never `"error"`. Only a
> failure of a git call on an object ALREADY KNOWN TO EXIST — a genuine spawn failure, a timeout, a
> corrupt repo — stays `"error"`.**

`"error"` exists to mean "this sub-check could not be COMPLETED, so its real answer is UNKNOWN." A
malformed or nonexistent value the candidate itself supplied is not unknown — it is a definite, checkable
fact about the candidate, and the correct response is to reject THAT CANDIDATE, not to treat the WHOLE
LOOKUP as unverifiable. Collapsing "I validated this claim and it's false" into the same bucket as "I
couldn't run the check at all" is the SAME mistake round 4 fixed one level up (collapsing a genuine git
error into a bare boolean `false`) — it just moved one level down, into validating the INPUT to that check
rather than the check's own OUTCOME.

**Fix — validate before using, never catch-and-classify after:**
- `verifyPersistedPathSet`'s `baseOverride` is now validated BEFORE it ever reaches a diff range: shape
  (`OBJECT_ID_SHAPE_RE`, `/^[0-9a-f]{40,64}$/` — matching `Loom-Landed-Tip`'s own existing shape check
  elsewhere in this file) AND existence (`git rev-parse --verify --quiet <id>^{commit}`, judged by whether
  its OUTPUT is non-empty). **Round 6 correction: the claim that this call "never throws regardless of
  input shape, including a flag-shaped string" was FALSE** — measured directly, it throws for an EXISTING
  non-commit object (a blob or a tree: "expected commit type", exit 1) and for a 40-hex string that is
  ALSO a real ref name. It is only genuinely stdout-only/exit-0 for a MISSING or malformed-shaped value —
  exactly the cases this round's own tests happened to cover, which is why the false claim shipped without
  an immediately-visible contradiction. See round 6's own section below for the real fix (two separate
  calls, `^{object}` then `cat-file -t`, neither of which ever discriminates by throwing).
- The SAME classification applies to the branch-present re-task guard's own `merge-base` call (CR4's
  reasoned point, not independently measured as a regression — see its own test's honest result below):
  `git merge-base` with NO common ancestor exits 1 with EMPTY output and, empirically (via `simple-git`'s
  `raw()`, on this card's own real-git probes), never throws at all. An empty `mergeBase` is now checked
  explicitly and short-circuits to a DEFINITIVE fail, rather than flowing into the content check below it.

### 2. Named, but NOT independently fixed here — a pre-existing `--output=` argument-injection finding

The reviewer separately found that `Loom-Worker-Base`'s complete absence of shape validation ALSO exposes
a `--output=` argument-injection into `changedPathsBetween`'s own `git diff` call (pre-existing since
decision `756a2cd8`, independent of this card's own abort-vs-continue bug) — a value like
`"--output=some/path"` makes git write its diff output to an attacker-chosen file instead of throwing.
**This is carded SEPARATELY by the reviewer, not fixed as part of this card.** It is, however, CLOSED for
this one call site as a side effect of finding 1's own shape validation above (a value that must match
`/^[0-9a-f]{40,64}$/` can never look like a flag) — verified directly: a `Loom-Worker-Base` value crafted
to look like an `--output=` flag is rejected at the shape check, before ever reaching a git argument, and
no file is written anywhere in the repo. The separately-carded finding covers whatever OTHER call sites
`changedPathsBetween`'s own base/ref arguments reach that this card's fix does not touch.

### Test honesty note — the merge-base "exit-1 shape" is a real false-ACCEPT, not the null regression

The first version of this round's own `(ORPHAN-NO-COMMON-ANCESTOR)` test fixture gave the live branch real
unmerged work of its own — and it PASSED on `dde5df39` with no fix at all. Tracing why: `git diff
--name-only "<empty>..<branchRef>"` was measured (round 6 correction below — including with a DIRTY
working tree, to rule out the on-disk-files theory) to diff against the repo's own **HEAD**, never the
working tree and never an empty tree — so it only reproduces `branchContentLandedInCommit`'s own "no
changes, vacuously landed" shortcut when the branch's own tree happens to be IDENTICAL to HEAD's. A branch
with real content of its own instead hits a DEFINITIVE mismatch on that function's own SECOND diff call
regardless of this fix, so the original fixture tested nothing about this specific classification. The
corrected fixture cuts the branch with ZERO commits of its own (tree identical to the fork point) —
reproducing a genuine, worse-than-abort FALSE ACCEPT pre-fix (the disconnected orphan candidate's own sha
is wrongly reported as landed), not merely a below-floor null. RED on `dde5df39` with the corrected
fixture, GREEN after. Recorded here because the wrong fixture would have shipped looking like a passing
regression test while proving nothing.

**Round 6 correction (Code Review b298e180):** the paragraph above originally said this diffs against the
repo's current ON-DISK WORKING TREE — WRONG. Measured directly with a genuinely DIRTY working tree
(an uncommitted edit to a tracked file): `"<empty>..<branchRef>"` still returned exactly what an explicit
`HEAD <branchRef>` diff returns, completely ignoring the uncommitted change. The correct mechanism is
`"<empty>..X"` means `HEAD..X` — never the working tree. In this file's own test fixtures the two happened
to coincide (nothing ever dirties the canonical repo's working directory), which is why the original,
imprecise claim never produced a wrong test result — but the CLAIM itself was false, and is corrected here
rather than left to rot.

## Round 6 (Code Review b298e180) — round 5's OWN fix still threw; the real rule is "stdout, exit 0"

Round 6's Code Review confirmed round 5's fix on `HEAD` for every case it was actually tested against
(deadbeef, `--output=injmark`, `--output=<abs path>`, a missing 40/50/64-hex, and a real commit with a
bogus PathSet) — and then found round 5's OWN existence check (`rev-parse --verify --quiet <id>^{commit}`)
still throws for shapes none of those cases exercised.

### 1. MAJOR (blocking) — the `^{commit}` peel is not stderr-free

`simple-git` does not classify by exit code — its `isTaskError` throws whenever `exitCode && stdErr.length`
are BOTH true, so a call that exits non-zero WITH stderr output throws regardless of what the exit code
numerically is, and a reader of `simple-git`'s public API cannot observe the exit code separately to judge
for itself. Measured: `rev-parse --verify --quiet <id>^{commit}` against an EXISTING non-commit object (a
blob — `HEAD:README.md`'s own sha — or a tree) prints `"error: … expected commit type, but the object
dereferences to <type> type"` and exits 1 — `simple-git` throws, round 5's catch classifies it `"error"`,
and the whole lookup aborts to `null` even though a genuine older landing exists. A second variant: a
40-hex string that is ALSO a real ref name triggers an "ambiguous" warning on stderr — **round 7
correction: the ambiguity warning itself never throws (it is an exit-0 warning); what throws here is that
git's ambiguity precedence resolves the string to the TREE object, which then fails the SAME "expected
commit type" way as the plain tree case above.** Anyone who can land a commit message (no forgery needed
beyond that) can shape either trigger.

**Fix — use a query whose definitive answer is stdout + exit 0, never exit-code-plus-stderr:**
`verifyPersistedPathSet`'s existence+type check is now TWO calls, each verified (real-git probes) to be
stdout-only/exit-0 for EVERY input tried (missing, blob, tree, commit, annotated tag, short garbage, a
flag-shaped string, empty string, an ambiguous ref-named-like-a-sha):
1. `rev-parse --verify --quiet <id>^{object}` — peels to ANY object type, never discriminating by type,
   so it answers ONLY existence. Empty output ⇒ `"fail"`.
2. `cat-file -t <id>` — now safe to call unconditionally, since step 1 already confirmed the object
   exists (its own documented throw case, "could not get object info", is existence-only and already
   ruled out). Returns the real type string. Anything other than `"commit"` ⇒ `"fail"` — this is also
   where this card settles the question CR4 raised but didn't require an answer to: a TAG object is
   NEVER peeled through to the commit it points at. The real writer always stamps a raw commit sha; a tag
   happening to share that exact id is not what a genuine `Loom-Worker-Base` trailer would ever carry.

Both calls are prefixed with `-c core.warnAmbiguousRefs=false` as defense-in-depth, though neither was
measured to need it given a ZERO exit code throughout testing.

Tests: extended `(BASE-TRAILER-FORGED)` (PART P) with four more Base shapes — an existing blob, an
existing tree, an existing tag, and the ambiguous-ref-name shape — through all 3 readers. **Honest result:
the TAG sub-case does NOT discriminate RED/GREEN** — round 5's own `^{commit}` peel already succeeds for
a tag pointing at a commit (peeling it through), so pre-fix it resolves to a committed-but-wrong digest
and fails definitively anyway (the made-up PathSet digest this test uses never matches); this card's own
"never peel a tag" POLICY choice is new and deliberate, but it happens to produce the same observable
pass/fail outcome as round 5's accidental peel-then-digest-mismatch for this exact fixture. Recorded
honestly rather than claimed as a regression it isn't — the other three sub-cases (blob, tree, ambiguous-
ref) ARE genuine RED-on-`50137acf`/GREEN-after regressions. **Round 7 correction: the ambiguous-ref
sub-case's Base value is literally the TREE sub-case's own sha text (now ALSO a real tag name) — it is
RED/GREEN for the identical "expected commit type" reason as the TREE sub-case, not because the
ambiguity warning itself throws (see round 6 finding 1's own round-7 correction above).**

### 2. MAJOR (fixed this round, same class) — the no-Base path's blind `${sha}^` peel

`verifyPersistedPathSet`'s ELSE branch (no `Loom-Worker-Base` trailer at all) computed the parent via
`rev-parse ${sha}^` unconditionally. Measured: a PARENTLESS tolerant candidate (a real `commit-tree` root
commit, no `-p`) carrying a PathSet but no Base, brought into main's history as a second parent via an
unrelated-history merge and newer in `git log` order than a genuine older strict landing, makes this call
throw `"fatal: ambiguous argument … unknown revision"` — `"error"`, abort, `null`, even though the genuine
older landing (S0) exists and would otherwise resolve.

**Fix:** read the parent list FIRST, via `git rev-list --parents -n1 <sha>` — a stdout-answer, exit-0-
always query (`sha` is always already-known-real here, since it came from the same `git log --grep` scan
that found the candidate in the first place). Output is `"<sha>"` alone for a root commit, or
`"<sha> <parent> […]"` otherwise. Fewer than two tokens ⇒ no parent ⇒ a DEFINITIVE `"fail"`, never an
`"error"` — the candidate genuinely has no base to diff against, which is a checkable fact, not ambiguity.

Test: `(PARENTLESS-NO-BASE)` (PART S), through all 3 readers. RED on `50137acf`, GREEN after.

### 3. Folded in (same class, attribution-only, trivial) — an unguarded merge-base in the attribution path

`findIntroducingSquashCommit`'s own FIRST `merge-base` call (computing `landedSha`'s own common ancestor
with the live branch, for its "does the branch have changes of its own" check) was interpolated directly
into a diff range with no empty-output guard — the SAME "no common ancestor ⇒ silently becomes
`..branchRef`" shape named in round 5's own Do-not bullets, just at a DIFFERENT call site this card hadn't
swept yet. Benign today (this function is attribution-only, decision `293d418e` — never used for gating),
but closed anyway so no `${a}..${b}` range on the verify path (gating OR attribution) can ever receive an
empty or otherwise-uncontrolled operand. The loop's OWN `mergeBase` a few lines below already had this
exact guard (`if (!mergeBase || mergeBase === older) break;`) — only the first call was missing it.

**Every range operand on the verify path now traces to either a known-real sha (from the `git log`
scan itself) or a value this card's own checks have validated — never an unchecked git-call result and
never raw candidate-supplied text.** The reviewer's own sweep found no further site.

### ⭐⭐ THE STANDING TECHNIQUE (generalizes past this card)

> **On this codebase's git wrapper (`simple-git`), a "no" answer must arrive on STDOUT with exit 0.
> Exit codes are not independently observable through `simple-git`'s public API — only throw-or-not is —
> and `simple-git` throws on `exitCode !== 0 && stderr.length > 0` together, never on exit code alone.
> A query whose failure case writes to stderr (even "just a warning") is unsafe for this purpose,
> REGARDLESS of how official-looking its quiet/verify flags are.**

This generalizes round 5's own rule ("a failure induced by the candidate's own claimed data is definitive,
never an error") one level further: it's not enough to decide WHAT a failure should mean — the CHECK
itself must be built so its failure case is observable without relying on `simple-git`'s own throw/no-
throw behavior for a stderr-bearing non-zero exit. `--quiet`/`--verify` flags suppress CERTAIN messages
(a missing object) but not others (a wrong-type peel, an ambiguous ref) — never assume a flag closes the
whole class without measuring every shape the candidate could supply. (Round 7 correction: the ambiguous-
ref WARNING itself is exit-0-only and never throws on its own — it is unsuppressed stderr NOISE riding
alongside whatever the string's resolved object actually fails on, per round 6 finding 1's own round-7
correction above.)

### Manager correction, verified — does the fix's own `-c core.warnAmbiguousRefs=false` get blocked?

A sibling card (`c7dc99bf` round 5) measured that `simple-git`'s `blockUnsafeOperationsPlugin` REJECTS a
raw `-c <key>=<val>` argument for certain keys unless the instance's own `unsafe` option set already
allows that SPECIFIC category — a real risk, since this card's own round-6 fix prefixes two calls with
exactly such an argument. If that rejection applied here, every lookup through those two calls would
throw ⇒ `"error"` ⇒ `null` on EVERY input, genuine or not, masquerading as a correctly-fail-closed result.

**Measured directly, both ways:**
- `blockUnsafeOperationsPlugin`'s blocking is KEY-SPECIFIC, not a blanket `-c` rejection: `core.fsmonitor`,
  `core.sshCommand`, `protocol.*.allow`, `core.pager`, and `core.hooksPath` are each gated behind their
  own named `allowUnsafe*` flag and DO throw on a bare instance — but `core.warnAmbiguousRefs` (this
  card's own choice), `safe.directory`, and `uploadpack.allowFilter` are NOT on that list and never throw,
  on a BARE `simpleGit()` instance with no `unsafe` options set at all (the exact shape this file's own
  fault-injection `gitFactory`s construct).
- `boundedGit`'s own default factory (`canonicalGit` → `boundedSimpleGit`, `git/bounded.ts`) sets
  `allowUnsafeConfigPaths: true` UNCONDITIONALLY — a second, independent layer of permission on the REAL
  production call path, on top of the key not being gated at all.
- `(GENUINE-PASS-THROUGH-DASH-C)` (PART T) is the test the manager asked for: a genuine candidate with a
  real, self-consistent Base+PathSet pair, the ONLY candidate in its repo (no older fallback to mask a
  broken `-c`), must resolve PASS. **Proven discriminating, not vacuous:** swapped `core.warnAmbiguousRefs`
  for `core.hooksPath` (a CONFIRMED-blocked key) as a deliberate sabotage, rebuilt, and confirmed this test
  (plus several others exercising the same two calls) correctly went RED — then reverted and confirmed
  GREEN again. The test genuinely distinguishes a working `-c` call from a blocked one.
- **The real trap, confirmed both directions:** a GLOBAL `-c key=val` must come BEFORE the subcommand in
  the argv array, or git reads it as a subcommand OPTION instead and fails. Measured directly with the
  `(AMBIGUOUS-REF)` fixture (a tag named exactly like a real tree's own 40-hex text) through BOTH calls in
  this fix's own exact argument order (`["-c", "core.warnAmbiguousRefs=false", "rev-parse", ...]` /
  `["-c", "core.warnAmbiguousRefs=false", "cat-file", "-t", ...]`): exit 0, clean stdout, ZERO stderr
  output either way — not merely "no throw", genuinely silent. For contrast, the SAME `-c` pair placed
  AFTER the subcommand (`["rev-parse", "-c", "core.warnAmbiguousRefs=false", "--verify", ...]`) throws
  `"fatal: ambiguous argument 'core.warnAmbiguousRefs=false'"` — confirming the trap is real, and that this
  card's own two call sites (checked directly against source) are NOT shaped that way.

## Round 7 (Lead review of CR6) — a racy test, a resolved-ref laundering hole, and a doc correction

The Lead's own review of round 6's Code Review (`5bba22f6`) found the fix code sound on every measured
shape, but raised four follow-ups: a flaky negative control, a real (if narrow) verification hole in the
round-6 fix itself, a NIT on the no-Base path's own fault classification, and the stale "ambiguous ref
throws the same way" framing corrected in place throughout round 6's own text above.

### 1. Test flake — `(PARENTLESS-NO-BASE)` (PART S) could pass vacuously depending on the clock

With the candidate and S0 committed at the SAME wall-clock second, `git log`'s default order ties by
PARENT ORDER (S0, `mergeSha`'s first parent, before the candidate, its second parent) — so the walk would
resolve S0 directly and never even try the candidate, passing regardless of whether round 6's own fix is
present. Measured: a same-second run passes trivially; a run where the clock ticks between the two
commits exercises the real mechanism. **Fix:** the candidate's own `GIT_COMMITTER_DATE`/`GIT_AUTHOR_DATE`
are now pinned to S0's own committer date + 5 seconds (read via `git show -s --format=%ct`), and a new
setup-control assertion confirms `git log --format=%H` genuinely lists the candidate BEFORE S0 — on any
clock, not just a lucky one. Swept the rest of the file for the same shape (a multi-parent merge presenting
two candidates that both match the branch's own `--grep`, with no strict ancestry between them): the only
other two-parent `commit-tree` call (`(ORPHAN-NO-COMMON-ANCESTOR)`, PART R) has exactly ONE candidate
matching the grep in its whole repo, so there is no second candidate for ordering to matter against; every
other "newer beats older" scenario in this file builds its fake as a single-parent (`-p <olderSha>`) child,
which `git log` traverses topologically with no timestamp-dependent tie to begin with.

### 2. MAJOR (fixed) — a 41-64-hex `Loom-Worker-Base` resolves as a REF NAME, not an object id, in a SHA-1
   repo, and the resolved identity was never checked against what the candidate claimed

SHA-1 object ids are exactly 40 hex characters — never an "abbreviated" LONGER form — so a 41-64-hex
`baseOverride` (still inside `OBJECT_ID_SHAPE_RE`'s `{40,64}` range, sized for a future SHA-256 repo) is
never interpreted as a raw object id at all; git resolves it purely as a REF NAME. Round 6's fix only
checked that `<baseOverride>^{object}` resolved to SOMETHING (existence) and that its type was `"commit"`
— never that the resolved object's identity matched what the candidate actually claimed. A planted ref
literally named with such a string, pointing at a real commit, passed both checks, and `parent` was then
set to the LITERAL REF-NAME TEXT (not the resolved sha) — which a THIRD, independent resolution (inside
the diff call) re-interpreted consistently in an ordinary single-threaded test, but is a real race surface
under a concurrently-writable shared `.git` (decision `356538ef`): the ref's target can move between any
of the three resolutions. Measured end-to-end (no race needed to demonstrate the acceptance itself): on a
TOLERANT-ONLY branch (no strict competitor — `walkCandidates`' positive-proof gate only fires when one
exists) with a zero-row ("skip") ledger, a never-landed forgery carrying this ref-name-shaped Base and a
genuinely-matching PathSet digest was accepted by `findLandedSquashCommit`/`findLandedSquashCommitViaMap`/
`getTaskMergedInfo` as a real landing.

**Fix:** `rev-parse --verify --quiet <baseOverride>^{object}` is resolved ONCE, and its stdout must equal
`baseOverride` EXACTLY (the full literal text) before anything proceeds — a ref-name value's resolution is
its TARGET, never its own name, so this can never pass for one. The single resolved value is then reused
for both `cat-file -t` and the diff (`parent = resolved`), closing the "same candidate-supplied value
re-resolved three separate times" race surface structurally, not just for this one shape. Test:
`(REF-NAME-BASE-SHAPE)` (PART U) — RED on `65d3d32e` (the forged sha wins on all 3 readers), GREEN after.

**What this closes, narrowly — and what it does NOT (round 8, Code Review `290a6a32`):** the fix above
closes exactly two things: (a) the IDENTITY MISMATCH, where a ref-name-shaped `baseOverride` resolves to
something other than its own literal text, and (b) the three-way RE-RESOLUTION RACE described above. **It
does NOT close end-to-end acceptance of a never-landed forgery at a zero-row ("skip") ledger on a
tolerant-only branch in general.** Measured: a PART-U-shaped forgery whose `Loom-Worker-Base` is the RAW
sha of an existing commit (never a ref-name), or which carries no Base trailer at all (falling to the
no-Base `${sha}^` path), still resolves PASS on all 3 readers under the identical zero-row-ledger,
tolerant-only-branch conditions — because `verifyPersistedPathSet`'s PathSet check is self-consistent only
(decision `756a2cd8`: proves the changed-file SET, never authorship), and `positiveProof` (round 2/3's own
gate) only ever fires to adjudicate a tolerant candidate AGAINST a competing STRICT one; a tolerant-only
branch has no such competitor for it to gate. That broader acceptance is open **BY DESIGN**, not a residual
of this round's own fix — the ledger's own "skip" verdict (a scope with zero rows) is built to accept any
candidate it cannot classify. See the "Named residual" section below, which predates this round and
already names the adjacent `STRICT_FALLBACK_VERIFY_CAP` gap in the same spirit.

### 3. NIT (fixed) — the no-Base path's empty/mismatched `rev-list --parents` output was classified `"fail"`

`sha` is already known-real here (it came from the same `git log --grep` scan that found the candidate),
so an EMPTY `rev-list --parents -n1 <sha>` output, or one whose first token doesn't echo `sha` back, is a
FAULT (a transient git failure, never a legitimate "no parent" answer) — round 6's own check only tested
`tokens.length < 2`, silently treating empty output the same as the genuine one-token (root commit) case.
**Fix:** `tokens.length === 0 || tokens[0] !== sha` now returns `"error"` before the root-commit check runs.
No dedicated regression test — this classification is not practically reachable without mocking git itself
(a known-real `sha`'s own `rev-list --parents` call failing to echo that same sha back), so it is verified
by reading, not by a RED/GREEN proof; flagged honestly as such here rather than claimed otherwise.

### 4. Doc correction — "an ambiguous ref throws the same way" was imprecise

Round 6's own text (several places above, corrected in place rather than left to accrete a second,
conflicting account) described a 40-hex-that's-also-a-ref-name as throwing "the same way" as a wrong-type
peel, via its own ambiguity warning. Measured: the ambiguity warning itself is exit-0-only and never
throws — what actually throws (pre-round-6-fix) is that git's ambiguity precedence resolves the string to
the WRONG-TYPED object (here, a tree — the `(AMBIGUOUS-REF)` fixture's own Base value is literally the
`(TREE)` fixture's own sha text, now also a planted tag name), which then fails the identical "expected
commit type" way the plain tree case does. The ambiguity warning is incidental stderr noise riding
alongside that failure, never its cause.

## Named residual (accepted, no change)

The reviewer found the STRICT bound (`STRICT_FALLBACK_VERIFY_CAP`) is fillable — strict parsing is trailer
TEXT only, so an attacker with `.git` write access can plant more strict-shaped candidates than the cap.
Past the cap, the walk fails closed to `null` — equal to the floor (the pre-card single-attempt behavior),
never worse. Accepted as-is; no change needed.

## Do not

- Do not revert to "strict always wins, regardless of recency" — that is round 2's now-superseded rule; it
  reopens this card's own round-3 residual (an older strict landing hiding a newer genuine tolerant one).
- Do not let PHASE 2's fallback return LESS than round 2's own strict-first answer — it must keep trying
  STRICT candidates specifically past `MIXED_VERIFY_CAP`, up to `STRICT_FALLBACK_VERIFY_CAP`, before failing
  closed. This is the load-bearing correction from manager review; removing it reopens a real regression on
  attacker-shapeable input (see "The cap-floor correction" above).
- Do not let `findLandedSquashCommit` and `resolveMergedCommitMapHitList` re-diverge into two separately-
  hand-maintained walks — round 3 extracted the shared `walkCandidates` helper specifically because they had
  already drifted once (round 3, finding 1); any future change to the walk's control flow belongs in that
  one function, never duplicated at each call site.
- Do not lower `MAP_CANDIDATE_LIST_CAP` below `MIXED_VERIFY_CAP + STRICT_FALLBACK_VERIFY_CAP` — the map
  path's own candidate list must retain at least as many entries as the live, unbounded-per-call
  `findLandedSquashCommit` scan could ever need to try, or the map path's fallback can run out of retained
  strict candidates before the live path would.
- Do not raise `MIXED_VERIFY_CAP`/`STRICT_FALLBACK_VERIFY_CAP` without re-measuring the worst-case spawn
  cost (each attempt can cost several real git spawns) — these caps exist specifically to bound how many
  verifications an attacker can force per lookup by planting newer candidates that all fail verification.
- Round 1's own bullet here said "do not change the verifier functions themselves... they are reused
  UNCHANGED." Rounds 2-4 all change `verifyGoneBranchLanding` and `resolveMergedCommitMapHit` (round 2:
  `{passed, positiveProof}` + a hoisted `branchPresent` param; round 3: adds `ledgerError`; round 4: renames
  it to `error` and widens it to cover a non-definitive PathSet check too — see the next bullet) — each for
  a specific, named reason. `branchContentLandedInCommit` and `verifyPersistedPathSet` ALSO change in round
  4 (bare boolean → `CheckVerdict` tri-state). Do not widen any of these further without an equally
  specific, named reason.
- **Superseded by round 3.** Round 2's own bullet here said a tolerant candidate may win with "the ledger's
  `"recorded"` verdict, OR a verified PathSet trailer." That is now WRONG and dangerous — a verified PathSet
  trailer is forgeable (round 3, finding 2; a zero-diff commit's own trailer self-verifies with no real
  landing behind it). `positiveProof` is now the ledger's `"recorded"` verdict ONLY. Do not reintroduce a
  verified PathSet trailer as an alternate path to `positiveProof` without a materially different proof
  mechanism than self-consistency.
- Do not let `scanMergedCommitMap`'s per-branch candidate list use a SINGLE shared cap for both strict and
  tolerant entries (round 2, finding 1, CRITICAL) — track two separate counters (mixed, strict) so a run of
  tolerant-shaped candidates can never evict a strict candidate the live, unbounded `findLandedSquashCommit`
  scan would still find.
- **Superseded by round 5 — read with the RETRACTED bullet THREE below, not in isolation.** Do not call
  `verify()` (or any future per-candidate verifier closure) without its own try/catch (round 2, finding
  3) — that structural requirement is UNCHANGED: an uncaught throw must still be caught right there, never
  left to propagate out of the per-candidate boundary. What changed is what the catch RETURNS and what
  the walk DOES with it: round 2 said the catch should "fail that candidate only" so the walk continues to
  an older one; round 4/5 retract that — the catch now returns `error:true`, and `walkCandidates` aborts
  the WHOLE lookup on it, for the reasons in the RETRACTED bullet below.
- Do not re-add a per-candidate `git branch --list` spawn inside `resolveMergedCommitMapHit` — it must stay
  a caller-hoisted `branchPresent` param, computed exactly ONCE by `resolveMergedCommitMapHitList` per
  lookup (round 2, finding 4b) — and do not let a failed read of that hoisted call degrade to
  `branchPresent:false` (round 3, finding 1, CRITICAL) — it must fail the whole lookup to `null` instead.
- **Superseded by round 4.** Round 3's own bullet here said `ledgerError` on a STRICT candidate aborts the
  walk. Round 4 (finding B1) GENERALIZES this past strict-only AND past the ledger: `outcome.error` on ANY
  candidate (strict or tolerant), from ANY non-definitive sub-check (a throw, a PathSet error, a content-
  check error, a ledger error), aborts the whole lookup to `null` in BOTH phases. Do not reintroduce a
  strict-only or ledger-only conditioning on this abort — scenarios H/D (round 4) are exactly the two
  shapes (a non-ledger error; a tolerant-only branch) round 3's narrower version missed.
- **RETRACTED by round 4, corrected round 5 (a doc fix, NOT the same "finding 2" as round 5's OWN
  numbered `--output=` injection note above or round 6's own numbered finding 2 — this bullet is about
  THIS record's own stale text, not a code regression; the bullet above was NOT removed, it was sitting
  right there — fixed in place instead, and this one is the correction; read them together).** Round 2's
  own bullet above said a transient
  throw on one candidate must never abort the whole lookup — the walk must continue to an older candidate.
  That is now WRONG: continuing past a non-definitive outcome can only ever return the right answer or a
  STALE sha, and the walk cannot tell which from the inside, so it takes the pre-card floor (`null`)
  instead. Do not reintroduce "continue past a throw" as a general rule for any sub-check in this walk.
- Do not let `verifyPersistedPathSet` or `branchContentLandedInCommit` collapse back to a bare boolean
  (round 4, finding B1) — a caller needs to distinguish a DEFINITIVE `"fail"` (safe to continue past) from
  a non-definitive `"error"` (must abort), and a boolean cannot carry that distinction.
- Do not let `walkCandidates`' own cap-exceeded warn go unrated-limited again (round 4, finding N2) — a
  UI-polled caller (`getTaskMergedInfo`, the Git tab's worker-diff read) can call this walk once per poll,
  and an unrated-limited warn logs once per poll too.
- Do not assume the map path's own cap-exceeded warn is reachable (round 4, finding N2) — `scanMergedCommitMap`
  caps a branch's stored strict entries at `STRICT_FALLBACK_VERIFY_CAP`, so `resolveMergedCommitMapHitList`
  can never present a (cap+1)th strict candidate for it to fire on; only `findLandedSquashCommit`'s own
  unbounded, fresh-per-call scan can.
- This record's own `## Do not` section must stay exactly ONE copy (round 4, finding N1) — every
  `@decision c0d0eac9` anchor in source injects this ENTIRE section via the guard-extract hook, so a second,
  stale copy (as existed between rounds 3 and 4) is handed to every future reader alongside the correct
  one, with no way for them to tell which is current. When editing this section, replace bullets in place;
  never prepend a new list ahead of the existing one and leave the old one trailing.
- Do not read `onPreFixTrailerNotice` (the `findLandedSquashCommit` no-pathSet-trailer callback) as firing
  at most once per call anymore — it can now fire once per branch-gone candidate actually verified across
  both phases (previously at most once, since only one candidate was ever tried). The one real caller
  (`sessions/service.ts`'s boot-reconcile pass) uses it only as an aggregated-per-pass diagnostic counter
  (worded "candidate(s)", not "worker(s)", since round 2's own nit fix), so this is a deliberate, accepted
  widening of its exact count, not a correctness concern — do not "fix" it back to firing once per call
  without checking whether a precise per-call count is actually needed by then.
- Do not cite round 1's own "the SHADOW case now costs 2 attempts — one failed tolerant, one successful
  strict" framing as a general description of how a tolerant candidate loses to a strict one — it was only
  ever true on the ledger-WITH-ROWS arm. On the ledger-`"skip"` arm or the branch-present content-match arm,
  a tolerant candidate could WRONGLY SUCCEED there pre-round-2 (findings 2a/2b) — what actually stops it is
  the positive-proof gate above, not "it fails verification first."
- **Superseded by round 4.** `(TRANSIENT-FAULT)` (PART K) used to assert `found === olderSha` (round 2)
  and this bullet used to say that assertion was not an endorsement of OLDER's own forged acceptance,
  merely a try/catch isolation proof. Round 4 retracts the underlying behavior itself, not just the
  framing: the test now asserts `found === null`. Do not revert this test's assertion back to `olderSha`
  without first re-reverting the B1 fix it exercises.
- Do not read the `(STALE-FALLTHROUGH-PATHSET)`/`(TOLERANT-ERROR-ABORT)` tests' own OLDER/decoy fixtures
  (both deliberately-crafted, genuine, ledgered landings — not forgeries, unlike PART K's own fixtures) as
  interchangeable with PART K's — PART K isolates the try/catch gap specifically via forged content-match
  decoys; PART N/O prove the GENERAL non-definitive-outcome rule via genuine landings with an injected
  fault. Keep the two test shapes distinct; they cover different claims.
- **THE RULE (round 5, finding 1) — do not let ANY candidate-supplied value reach a git argument before
  validating it, and do not classify a validation failure as `"error"`.** A malformed/nonexistent value
  the candidate itself claims is DEFINITIVE (`"fail"`) — it is a checkable fact about that one candidate,
  never evidence the whole lookup is unverifiable. Only a git call on an object ALREADY KNOWN TO EXIST
  (hence never catch-and-classify a value's OWN validity after the fact) may legitimately fail with
  `"error"`. Before adding any new sub-check to this walk, ask whether its input is candidate-supplied —
  if so, validate shape+existence BEFORE the git call, never infer definitiveness from what a thrown
  error happens to look like.
- Do not re-introduce a per-candidate git call on CANDIDATE-SUPPLIED data without first checking whether
  `changedPathsBetween`'s own `--output=` argument-injection surface (decision `756a2cd8`, carded
  separately by reviewer `26278861`) reaches it too — this card's shape validation closes that surface for
  `verifyPersistedPathSet`'s own call site ONLY, as a side effect, not as a general fix for every reader of
  a `Loom-Worker-Base`-shaped value.
- Do not treat `git merge-base`'s exit-1-with-empty-output ("no common ancestor") as equivalent to a throw
  — it is a DEFINITIVE answer (empirically, via `simple-git`'s `raw()`, it never throws for this shape at
  all) and must short-circuit to a `"fail"` before reaching `branchContentLandedInCommit`, which cannot
  sensibly diff against an empty base (and, worse, can vacuously "pass" if the candidate's unrelated tree
  happens to match HEAD's own tree — `"<empty>..X"` means `HEAD..X`, NEVER the working tree, round 6
  correction above — a genuine false ACCEPT, not merely a below-floor null).
- Do not trust a regression test's RED/GREEN result without tracing WHY it is red or green — round 5's own
  first cut at `(ORPHAN-NO-COMMON-ANCESTOR)` passed on BOTH the broken and fixed code, for a reason
  unrelated to the fix under test (see this round's own "Test honesty note"). A passing test that doesn't
  exercise the claimed mechanism is worse than no test, because it looks like coverage.
- **Superseded by round 6.** Round 5's own bullet claimed `rev-parse --verify --quiet <id>^{commit}`
  "never throws regardless of input shape, including a flag-shaped string." That is FALSE for an EXISTING
  non-commit object (a blob/tree — "expected commit type") and for a 40-hex-that's-also-a-ref-name, which
  throws for the SAME "expected commit type" reason once git's ambiguity precedence resolves it to the
  wrong-typed object — never because the ambiguity warning itself throws (round 7 correction; see round 6
  finding 1's own round-7 correction above). Do not judge a `simple-git` call's safety by exit code alone,
  or by having tested only the MISSING/malformed-shape cases — test every shape a candidate could supply:
  missing, blob, tree, commit, tag, short garbage, flag-shaped, empty, and ambiguous-ref.
- Do not use `<id>^{commit}` (or any OTHER type-specific peel — `^{tree}`, `^{blob}`) to answer "does this
  exist AND is it the right type" in one call — peeling to a SPECIFIC type is exactly what throws on a
  type mismatch. Use `^{object}` (never discriminates by type) to answer existence, THEN `cat-file -t` on
  the now-confirmed-existing id to answer type — the second call is safe precisely because the first one
  already ruled out its one throw case (non-existence).
- Do not peel a TAG object through to the commit it points at when validating a `Loom-Worker-Base`
  (or any other candidate-supplied commit-sha field) — this card's `cat-file -t` check accepts ONLY
  `"commit"` literally. The real writer always stamps a raw commit sha; a tag sharing that exact id is
  never what a genuine trailer would carry, and peeling it would accept data the candidate never actually
  claimed.
- Do not let `verifyPersistedPathSet`'s no-Base branch call `rev-parse ${sha}^` unguarded again (round 6,
  finding 2) — it throws for a PARENTLESS commit, a real reachable shape (a candidate merged on as a
  second parent). Read the parent list first (`git rev-list --parents -n1 <sha>`, stdout-answer, exit-0-
  always for an already-known-real `sha`) and treat fewer than two tokens as a DEFINITIVE fail.
- Do not add a new `${a}..${b}` git range anywhere on the verify OR attribution path without checking that
  BOTH operands trace to either an already-known-real sha or a value this card's own checks have
  validated — `findIntroducingSquashCommit`'s own first `merge-base` call (round 6, finding 3) went
  unguarded for exactly this reason, sitting a few lines above a twin call that already had the guard.
- Do not add a new `-c <key>=<val>` argument to a verify-path git call without MEASURING (on a BARE
  `simpleGit()` instance with no `unsafe` options — the shape this file's own fault-injection factories
  use, not just the production `canonicalGit` path) whether that SPECIFIC key is on
  `blockUnsafeOperationsPlugin`'s gated list (`core.fsmonitor`/`sshCommand`/`pager`/`hooksPath`/
  `protocol.*.allow` were all confirmed gated; `warnAmbiguousRefs`/`safe.directory`/`uploadpack.allowFilter`
  were not) — a gated key throws regardless of intent, turning a definitive check into a blanket
  `"error"` on every input. Pair any such addition with a `(GENUINE-PASS-THROUGH-DASH-C)`-shaped test
  (a genuine, sole candidate that must resolve PASS) and PROVE it discriminates by sabotaging the key to
  a confirmed-gated one and watching it go RED, not just watching it stay green.
- Do not place a GLOBAL `-c key=val` argument AFTER the subcommand in the argv array (`["cat-file", "-c",
  ...]`) — git reads it as a subcommand OPTION instead and fails with "fatal: ambiguous argument". It
  must come FIRST (`["-c", "key=val", "cat-file", ...]`), as both of this card's own call sites already
  do — confirmed directly, both orderings, same repo, same input.
- Do not accept a `baseOverride^{object}` existence check on its OWN (round 7, finding 2) — its resolved
  stdout must equal `baseOverride`'s own literal text EXACTLY before anything proceeds, or a 41-64-hex
  value (never a valid SHA-1 object id, only a valid REF NAME) is silently accepted as if it WERE the
  candidate's own claimed raw commit sha. Reuse that one resolved value for every later step (`cat-file
  -t`, the diff) — never re-pass `baseOverride` itself, which re-resolves the same candidate-supplied,
  possibly ref-shaped text again and reopens the race this fix closes.
- Do not build a real-git fixture with two candidates at the same wall-clock committer-date second when
  the test's own claim depends on `git log`'s DEFAULT ordering between them (round 7, finding 1) — ties
  break by PARENT ORDER, not recency, so the test can pass vacuously regardless of the fix. Pin
  `GIT_COMMITTER_DATE`/`GIT_AUTHOR_DATE` on whichever commit must sort newer, and add a setup-control
  assertion that `git log --format=%H` actually lists it first — on any clock, not a lucky one.
- Do not treat `rev-list --parents -n1 <sha>`'s output as trustworthy without checking its first token
  echoes `sha` back (round 7, finding 3) — empty or mismatched output for an already-known-real `sha` is a
  FAULT (`"error"`), never the legitimate one-token "no parent" answer.
