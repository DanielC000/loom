# 1e7d6956 — classify candidate-discovery and chain-check failures the way `05915fc7` classified the content checks

## Narrative

Found by `05915fc7`'s own Code Review (reviewer `7b1fc7f6`) while reviewing that card's content-check
fix: `attributeStaleGenerationOwnLanding`'s candidate DISCOVERY (`findAllLandedTrailerCommits`,
`git/worktrees.ts`) catches everything — a `CanonicalGitRefusal`, a timeout, a spawn-level failure, a
genuine "the base doesn't resolve" — identically, and returns `[]`. The caller's own
`candidates.length === 0` check then returns `{kind:"no-match", checked:false}` — a DEFINITIVE escalation,
even when the underlying cause was a transient git/host read failure that would likely clear on a later
boot. The same CR found the identical asymmetry in `verifyReviewedTipChain` (`git/worktrees.ts`): it
catches every exception reaching its own outer `try` — refusal, timeout, spawn failure, or any other git
error — into one `{ok:false, reason}` shape, with no way for a caller to tell a transient read failure
apart from a definitive, never-changing miss.

This card extends `05915fc7`'s own classification one level up: a `CanonicalGitRefusal` stays definitive
(as it must — a refusal is a trust-boundary fact, never a host hiccup); a timeout
({@link isWithTimeoutExpiry}) or a process-level spawn failure ({@link isSpawnLevelFailure}) — the same
two, empirically-verified, locale-independent host-condition shapes `05915fc7` already established — are
transient; everything else stays definitive, mirroring `resolveObjectKind`'s own "any other non-timeout
failure ⇒ definitive" convention (the safe direction: fail toward the alarm on an unclassified anomaly,
never toward silent-forever-retry).

## `findAllLandedTrailerCommits` (worktrees.ts)

Classified exactly like `resolveObjectKind`'s own catch: `CanonicalGitRefusal` → `[]` (definitive, checked
explicitly via `instanceof`, not folded into the generic fallback); `isWithTimeoutExpiry`/
`isSpawnLevelFailure` → throws `GitTransientReadFailure` (the SAME class `05915fc7` introduced for
`fullTreeEntries`, reused here rather than a second marker); any other failure → `[]` (definitive,
unchanged). The last bucket is load-bearing for `worktree-add-and-log-argv-injection.mjs` SECTION D, which
passes a deliberately-malformed `base="--all"` (forced to a literal, nonexistent revision by
`--end-of-options`) and asserts the result is EMPTY, not a thrown error — that is a genuine, deterministic
git failure (an unresolvable revision), not a host condition, so it must keep collapsing to `[]`.

The caller (`attributeStaleGenerationOwnLanding`, sessions/service.ts) wraps this one call in its own
try/catch, mirroring the existing `fullTreeEntries(reviewedTip)` pattern immediately below it: a
`CanonicalGitRefusal` (never actually thrown by `findAllLandedTrailerCommits` today, since it's caught
internally — checked here anyway for the same explicit-over-implicit reason `05915fc7` itself follows) →
`{kind:"no-match", checked:false}`; a `GitTransientReadFailure` → `{kind:"transient", candidateShas:[]}`
(no shas to report — discovery itself never produced a list). This reuses the EXISTING
`kind:"transient"`/`candidateShas` return shape the function already has; no new variant.

## `verifyReviewedTipChain` (worktrees.ts)

Every non-throwing return in this function (an unresolvable trailer-derived object, "not a merge of
main", "merges a commit not on main", "not a clean union", the hop-limit) is already a genuine structural
fact about pre-resolved git objects — confirmed by directly tracing each one, and independently verified
that `git rev-parse --verify --quiet <ref>^{object}` on a nonexistent object resolves (empty string, no
throw) rather than rejecting, because simple-git's default error detection is "nonzero exit AND non-empty
stderr ⇒ reject" and `--quiet` suppresses the stderr text entirely (verified directly against this repo's
pinned `simple-git@3.36.0`, in a real repo, comparing that call against `git cat-file -t <bad-sha>`, which
DOES write to stderr and DOES reject). So every one of those non-throwing branches is unaffected by this
card.

The function's own outer `catch` — previously one shape for every thrown failure — now classifies the
same way `resolveObjectKind` does: `CanonicalGitRefusal` → `{ok:false, reason}` (unchanged, still
definitive); `isWithTimeoutExpiry`/`isSpawnLevelFailure` → `{ok:false, reason, transient:true}`; anything
else → `{ok:false, reason}` (definitive, unchanged — the same "fail toward the alarm" convention as
`findAllLandedTrailerCommits`'s own last bucket above). The return type widens ADDITIVELY
(`transient?: true` on the `ok:false` variant only) — verified safe against all 3 production callers
(service.ts ~20324 ungated-landing-check re-verify, ~22048 `reviewedTipVerdict`/`confirmWorkerMerge`,
~27706 this card's own `attributeStaleGenerationOwnLanding` landedTip arm) and the 2 test files that call
it directly (`canonical-git-graft-shallow-neutralization.mjs`, `canonical-git-isolation.mjs`) — every one
of them reads only `.ok`/`.reason`, so an additional optional field on the `ok:false` shape is invisible
to them.

**The two merge-confirm callers (~20324, ~22048) deliberately ignore `chain.transient` and keep refusing
on ANY chain failure** — per `bbccf470` ("a commit after review must not land unreviewed"), refusing is
the correct, conservative behavior there regardless of whether the underlying cause was transient; there
is no retry/escalation machinery on that synchronous confirm path, and there shouldn't be one. Only
`attributeStaleGenerationOwnLanding`'s own landedTip arm reads `chain.transient`, folding it into the SAME
`sawTransient`/`transientShas` accumulation the content-check arms already use — closing, as a side
effect, `05915fc7` round 3's own S2(b) finding that a chain-check failure could reach `checked:true`
("Loom checked every landed commit...") while nothing of that candidate was ever actually examined.

## The generic outer catch in `attributeStaleGenerationOwnLanding` (service.ts)

Re-audited the whole `try` block against current source (not assumed from `05915fc7`'s own round-3 audit):
`findAllLandedTrailerCommits` now has its own dedicated try/catch (added by this card, see above); the
hoisted `fullTreeEntries(reviewedTip)` read already has its own (round 2); `recordedTipContentLanded`/
`stampedPathsPlausible` each have their own internal try/catch and never throw outward; `verifyReviewedTipChain`
never throws outward (confirmed above). The only remaining code inside this try that can reach the
generic outer `catch { return {kind:"no-match", checked:false}; }` is the two `_exhaustive: never`
construct-throws — reachable only by a genuine type-system violation at runtime, never a classified
git/host condition.

**Ruling: the generic outer catch keeps escalating loudly, unchanged.** Folding an unclassified
programming-bug throw into the bounded-transient give-up machinery would let a real defect retry silently
for up to `staleGenerationTransientEscalateAttempts` boots / `staleGenerationTransientEscalateMs` before a
human ever sees it — strictly worse than an immediate alert, and contrary to this whole card family's own
"fail toward the alarm, never toward silence" principle. This reaffirms `05915fc7` round 3's own ruling
for this identical code (its "NITs addressed" section) rather than deciding fresh — this card's own
changes add no new way to reach this catch via a real git condition.

## The `e5458ccd` watermark path — deliberately NOT touched here

`resolveMainlineWatermarkRef`/`readBaseSha` failing (`"watermark-unresolved"`,
`resolveStaleGenerationOwnLanding`'s own `if (attribution.kind === "watermark-unresolved")` branch,
service.ts) is a bare `console.warn` + no-op today — genuinely unbounded, no escalation mechanism at all.
This is a real, separate defect the same CR flagged, but it is a different code path with its own design
question (does it reuse the SAME `staleGenerationTransientEscalateAttempts`/`_Ms` counters on the same
row, or get its own — mixing "a candidate read failed" and "a watermark read failed" into one row's
bookkeeping would conflate two distinct causes in one nudge). Deliberately carded separately rather than
folded into this diff, to keep this one logical fix scoped to discovery + chain-check classification.

## Tests

`stale-generation-landedtip-content-check.mjs`:
- `DISCOVERY_SPAWN_FAIL_RETRIES` (RENAMED from round 1's `DISCOVERY_TIMEOUT_ESCALATES` — round 2, item 2:
  that name was wrong on both halves, since this fixture exercises a SPAWN-level failure, never a
  timeout, and does NOT escalate on boot 1): a discovery-only spawn failure reads `kind:"transient"` (not
  an immediate definitive escalation) on the first boot, via the `staleGenerationDiscoveryGitFactory` test
  seam (SessionService constructor option, mirroring the file's own established per-purpose gitFactory
  pattern — `heldProbeGitFactory`/`batchFfGitFactory`/`soloMergeGitFactory`/`unionMergeGitFactory`/
  `alreadyLandedGitFactory`/`preLandedLookupGitFactory`) threaded ONLY into
  `attributeStaleGenerationOwnLanding`'s own `findAllLandedTrailerCommits` call — never a global
  `gitOpMs` override, which `05915fc7` itself found bleeds across every row a shared SessionService
  instance tracks.
- A sibling, already-tracked worker row in the SAME boot/DB is asserted bit-for-bit unchanged, proving the
  injected fault stays scoped to the ONE targeted worker's discovery call.
- A second boot, with the fault cleared, proves retry-then-success.
- `CHAIN_TRANSIENT` exercises the landedTip arm specifically (a `verifyReviewedTipChain` chain walk forced
  transient via the same kind of targeted spawn fault), proving it folds into `sawTransient` rather than
  being silently skipped.
- `DISCOVERY_BOUND_ATTEMPTS` drives a persistent (never-clearing) discovery-level spawn fault through
  multiple boots to prove the EXISTING `staleGenerationTransientEscalateAttempts`/`_Ms` bounded give-up
  still escalates at the threshold — proving reuse of the existing machinery, not a parallel path.
- `worktree-add-and-log-argv-injection.mjs` SECTION D re-run to confirm the argv-injection regression
  (`base="--all"` ⇒ empty, never thrown) is unaffected.

### Round 2 (Code Review, `4f3de53b`) — two untested classification arms, a dead `instanceof` check, and dishonest wording

Both gaps below were found by the SAME method: a throwaway mutation applied to the real classification
code, rebuilt, re-run — every pre-round-2 stale-generation check still passed either way, proving neither
arm had a live test. Both are now closed, and both mutations are re-proven as a standing regression (see
each new test's own RED proof below — applied as a temporary source edit, rebuilt, confirmed RED, then
`git checkout HEAD --` to restore, rebuilt again, confirmed GREEN).

**Finding 1 (Minor): the DEFINITIVE branch of both functions' catch (`CanonicalGitRefusal` aside) was
never tested.** A mutation making EVERY non-refusal failure classify transient (removing the
`isWithTimeoutExpiry`/`isSpawnLevelFailure` distinction entirely, in both `findAllLandedTrailerCommits`
and `verifyReviewedTipChain`) left every existing scenario green. Two new isolated-pair fixtures close
this, each via a REAL (never crafted) git fatal on an object the pre-check / discovery walk had no reason
to expect would fail:
- `DISCOVERY_DEFINITIVE`: an intermediate ancestor commit's own object is deleted from the ODB
  (`corruptCommitObject`) — `git log --grep <base>`'s unbounded walk hits it mid-traversal and genuinely
  fails (`fatal: Failed to traverse parents of commit ...`, exit 128, real stderr — confirmed via
  simple-git directly rejects on non-empty stderr, never resolves). Classifies DEFINITIVE, escalates on
  boot 1. RED under the mutation above (confirmed: 2 failures, exactly `DISCOVERY_DEFINITIVE` and
  `CHAIN_DEFINITIVE`, nothing else).
- `CHAIN_DEFINITIVE`: a genuine worktree-side union commit's own TOP-LEVEL TREE object is deleted
  (`corruptCommitTree`, applied only AFTER every other git operation in that repo — including the
  re-task's own second worktree creation — is done) — `rev-parse --verify <cur>^{tree}` genuinely fails
  (`fatal: Needed a single revision`, confirmed directly). The union commit lives only on its own
  branch ref, never on main's ancestry, so this never touches discovery's own history walk.

**Finding 2 (Minor): the `isWithTimeoutExpiry` arm specifically was never tested either**, even after
Finding 1's own fixtures (both of which exercise the OTHER branch — definitive — not the transient
timeout branch). A mutation neutering `isWithTimeoutExpiry` to always return `false` left every
pre-round-2 stale-generation check green too (it DOES turn the pre-existing, unrelated `(B1 e control)`
fixture in this same file red — that one already covered `fullTreeEntries`'s own use of the SAME shared
helper — confirming the helper itself is shared and this mutation disables it everywhere, not just at the
discovery call site). `DISCOVERY_TIMEOUT_TRANSIENT` closes the stale-generation-specific gap: a NEW
`scopedNeverSettleGitFactory` test seam returns a promise that NEVER settles for the targeted discovery
call, so the OUTER `withTimeout` race (never simple-git's own command-level timeout) is what actually
fires, producing the exact `"exceeded Nms (hung git child?)"` shape `isWithTimeoutExpiry` matches. Scoped
to its own isolated pair with `gitOpMs:1000` (the service's own floor) — confined to this one fixture,
never a shared/global override. RED under the mutation above (confirmed: 2 failures, exactly
`DISCOVERY_TIMEOUT_TRANSIENT` and the pre-existing `(B1 e control)`).

**Finding 3 (nit): the caller's own `instanceof CanonicalGitRefusal` check around the discovery call was
dead code.** `findAllLandedTrailerCommits` never lets a `CanonicalGitRefusal` escape (it swallows one
internally to `[]`) and never throws anything else — so the only exception that can ever reach the
caller's own try/catch is `GitTransientReadFailure`. Simplified to
`if (e instanceof GitTransientReadFailure) return {kind:"transient", candidateShas:[]}; throw e;` —
matching the record's own stated mechanism exactly, and making an unexpected rethrow explicit rather than
silently swallowed by a dead branch. Traced the rethrow's own path: it is caught by
`attributeStaleGenerationOwnLanding`'s generic outer `catch { return {kind:"no-match", checked:false}; }`
(unchanged — see "The generic outer catch" section above), which `resolveStaleGenerationOwnLanding` then
treats as a genuine `kind:"definitive"` miss — escalating immediately, no attempts/age grace, exactly the
"fail toward the alarm" behavior this card already established for an unexpected throw.

**Finding 4 (nit): the transient reason/nudge text was misleading when `candidateShas` is empty.**
`attribution.candidateShas.map(...).join(", ")` on an EMPTY array (the discovery-failure case) produced
"...verifying candidate(s) [] against this worker's own recorded tip" — implying candidates were checked
and simply not found, when in truth discovery itself never produced a list to check. Both the per-boot
reason/warn text and the escalation nudge now branch on `attribution.candidateShas.length > 0`: non-empty
keeps the original wording unchanged; empty instead says discovery itself failed (`"candidate discovery
(git log --grep) failed with a transient git read failure"` / `"...trying to run candidate discovery (git
log --grep) — never a definitive content mismatch..."`).

## Do not

- Do not widen `findAllLandedTrailerCommits`'s transient classification beyond `isWithTimeoutExpiry`/
  `isSpawnLevelFailure` — any other failure (including a genuinely unresolvable `base`) must stay
  definitive (`[]`), or the `worktree-add-and-log-argv-injection.mjs` SECTION D regression stops being
  proven.
- Do not let a `CanonicalGitRefusal` fall through to the generic fallback in either function — check it
  explicitly via `instanceof`, mirroring the `fullTreeEntries`/`resolveObjectKind` idiom.
- Do not read `verifyReviewedTipChain`'s new `transient` field at either merge-confirm call site
  (~20324, ~22048) — refusing on ANY chain failure, transient included, is the correct, conservative
  behavior there per `bbccf470`; only `attributeStaleGenerationOwnLanding`'s own landedTip arm reads it.
- Do not fold the generic outer catch in `attributeStaleGenerationOwnLanding` into the bounded-transient
  give-up machinery — it is reachable only by a genuine programming bug (the two `_exhaustive: never`
  construct-throws), and must keep escalating loudly, immediately, with no attempts/age grace.
- Do not fold the `e5458ccd` watermark-unresolved path's own unbounded-retry problem into this card — it
  is a separate, differently-shaped defect, carded on its own.
- Do not re-derive `isWithTimeoutExpiry`/`isSpawnLevelFailure`'s own detection mechanism from memory —
  both match only strings NODE/`withTimeout` itself authors, never git's own locale-dependent stderr; see
  `05915fc7`'s own record for the full empirically-verified mechanism.
- Do not reintroduce the `instanceof CanonicalGitRefusal` check around the `findAllLandedTrailerCommits`
  call in `attributeStaleGenerationOwnLanding` — it is dead code (round 2, Finding 3): that function never
  lets a refusal escape, and the correct, simplified shape is
  `if (e instanceof GitTransientReadFailure) return transient; throw e;`.
- Do not let the transient reason/nudge text say "verifying candidate(s) []" when `candidateShas` is
  empty (round 2, Finding 4) — branch on `candidateShas.length > 0` and say candidate discovery itself
  failed when it is empty.
- Do not corrupt an object that's actually needed BEFORE the targeted call in a new DEFINITIVE-classification
  fixture (round 2, Finding 1) — `corruptCommitObject`/`corruptCommitTree` must run AFTER every other git
  operation the fixture's own setup needs, mirroring `corruptOneSubtree`'s own ordering discipline.
