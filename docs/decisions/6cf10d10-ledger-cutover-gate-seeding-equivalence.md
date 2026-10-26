# 6cf10d10 — branch-gone-ledger-cutover-gate.mjs: the `seedLedgerLanding` equivalence, and which scenarios stay on real landings

`test/branch-gone-ledger-cutover-gate.mjs` (c13666c6) cost 618.7-716.9s solo. 21 of its 25 scenarios used
a real `confirmWorkerMergeTracked`/`mergeBatchTracked` landing (`createWorktree` + the full squash/batch
pipeline) purely as SETUP SCAFFOLDING to produce a believable "landed" `mainline_landed_commits` row —
not because the ledger-gate logic under test (`classifyAgainstLedgerUncached`/`findLandedSquashCommit`,
git/worktrees.ts) needs the real pipeline. 8 of the 25 scenarios already proved this by seeding rows
directly via hand-built `git commit-tree` chains + `Db.recordMainlineLandedCommit` (DEPTH, M2-REGRESSION,
SPAWN COUNT, CHAIN CAP, HORIZON, PRE-LEDGER-C, UNBOUNDED TIP, MANY UNRELATED ROWS) and passed identically.

## The equivalence

`seedLedgerLanding` (test file ~line 127) writes through the SAME `Db.recordMainlineLandedCommit`
chokepoint the real writer calls — `SessionService.recordMainlineLedgerEntryIfRepoUnchanged`
(`sessions/service.ts` ~24129), invoked from exactly two real call sites: the solo squash
(`service.ts` ~21386 — `base=merge.landedBase`, the VERIFIED pre-landing tip; `tip=merge.sha`, the
VERIFIED squash commit) and the batch fast-forward (`service.ts` ~23006 — `base=baseMainSha`, the
branch's pre-batch tip; `tip=result.batchHeadSha`, the chain's final landed commit). In both real cases
`base` is simply whatever tip was live before the landing, and `tip` is the real commit(s) chained on top
of it by ordinary first-parent commits — exactly what the helper builds.

A new EQUIVALENCE CHECK scenario (right after RECORDED) proves this rather than asserting it in a comment:
a real confirm landing and the helper landing a parallel candidate on the SAME history, reading both rows
back from `mainline_landed_commits`:
- **EQUAL**: `project_id`, `repo_key` — same scope. `branch` — ALSO equal, because that column records the
  MAINLINE branch landed onto ("main"), never the individual worker's own branch name (the worker's branch
  lives only in the commit's OWN trailer text, which `findLandedSquashCommit` greps for separately). This
  was the wrong assumption the scenario itself caught on its first run — it originally asserted `branch`
  must differ and went red, which is what surfaced the real column semantics.
- **DIFFERENT, asserted**: `tip`, `base`, `id` — distinct commit shas + autoincrement, deterministically
  guaranteed to differ.
- **NAMED, left unasserted either way**: `landed_at` — a wall-clock ms timestamp at insert, NOT guaranteed
  to differ for two inserts this close together (the scenario's second wrong assumption, also caught by a
  real red run), and never meaningfully comparable regardless.
- Independently of row equality, BOTH rows are verified via real git (never assumed) to satisfy the writer
  invariant the ledger-gate's own soundness rests on (c13666c6's own "Do not" section): `base` is `tip`'s
  own first-parent ancestor.
- Reader-level: `findLandedSquashCommit` resolves the seeded candidate exactly like a real one.

## Which scenarios stay on real landings, and why

Exactly 4 of the file's 26 scenarios still call `confirmWorkerMergeTracked`/`mergeBatchTracked`:
- **RECORDED** — the only scenario in the repo combining a real squash's PATHSET-PRESENT trailer with the
  ledger gate threaded against a gone branch. The pathset-present self-consistency check
  (`verifyPersistedPathSet`) has independent coverage elsewhere (`merge-pathset-deleted-branch.mjs`,
  `merge-precommit-trailer-stamp.mjs`, `merge-trailer-shadowing.mjs`, `batch-merge.mjs`,
  `batch-merge-robustness.mjs` — grepped, zero thread `goneBranchLedger`), so RECORDED is the ONE place
  that combination is pinned at all.
- **LAUNDER** — kept as the adversarial anchor (cheaper than WEDGED: 26.7s vs 47.0s measured solo), so the
  laundering shape is pinned once against genuinely Loom-made rows, not only seeded ones.
- **MERGEIN-BATCH** — the batch wiring anchor: proves `mergeBatchTracked` itself produces the real
  intermediate-row shape (one row spanning two candidate commits) the reader depends on.
- **EQUIVALENCE CHECK** — needs one real landing to compare against by definition.

Every other scenario's adversarial git topology (forged merges, laundering, wedges, rebind, non-linear
real merges, batch intermediates) is byte-identical to before this card — only the "produce a believable
landed row" mechanism changed, either to `seedLedgerLanding` (14 scenarios) or, for the 4 already-direct
but spawn-heavy scenarios, from N individual `git commit-tree` spawns to one `git fast-import` call via
`fastImportTrailerChain` (DEPTH, M2-REGRESSION, SPAWN COUNT, MANY UNRELATED ROWS).

## RED proof (verbatim), against the committed file (b8af7382)

Three mutations to `git/worktrees.ts`, each applied alone, built, run against the full file, then
reverted via `git checkout HEAD --` and rebuilt clean before the next:

**Mutation A** — `classifyAgainstLedger` forced to return `"recorded"` unconditionally:
```
FAIL  (LAUNDER) THE FIX: the forged commit reads NOT landed under the actual half-open-range rule
FAIL  (WEDGED) a commit wedged between two rows (never itself a row's base) reads NOT landed
FAIL  (CHAIN CAP) a candidate whose own chain to HEAD exceeds the scan cap reads NOT landed — fails closed, never walked
FAIL  (M2-REGRESSION) the wedged forgery stays refused after 300 further real landings pile up on top of it
FAIL  (MERGEFORGE) THE FIX: F reads NOT landed — it sits off refTip's own first-parent line
FAIL  (BOUNDARY MISSING) a corrupted boundary fails closed (not landed)
FAIL  (TRANSIENT) the injected failure fails closed (not landed) on the first attempt
FAIL  (ERROR RATE LIMIT) both flaky attempts fail closed (not landed)
FAIL  (MANY UNRELATED ROWS) the wedged, never-recorded candidate still correctly reads NOT landed
FAIL  (DUP ROW) THE CAP: 9 genuinely-containing duplicate rows overflow the spawn cap — a real landing reads NOT landed (the cap's own, accepted availability cost on this pathological shape)
```

**Mutation B** — `verifyGoneBranchLanding`'s `ledger` forced `undefined` (pre-c13666c6 self-referential-only trust):
```
FAIL  (LAUNDER) THE FIX: the forged commit reads NOT landed under the actual half-open-range rule
FAIL  (WEDGED) a commit wedged between two rows (never itself a row's base) reads NOT landed
FAIL  (CHAIN CAP) a candidate whose own chain to HEAD exceeds the scan cap reads NOT landed — fails closed, never walked
FAIL  (M2-REGRESSION) the wedged forgery stays refused after 300 further real landings pile up on top of it
FAIL  (MERGEFORGE) THE FIX: F reads NOT landed — it sits off refTip's own first-parent line
FAIL  (BOUNDARY MISSING) a corrupted boundary fails closed (not landed)
FAIL  (BOUNDARY MISSING) a DISTINCT log line names the boundary as the cause
FAIL  (TRANSIENT) the injected failure fails closed (not landed) on the first attempt
FAIL  (ERROR RATE LIMIT) both flaky attempts fail closed (not landed)
FAIL  (ERROR RATE LIMIT) the error is logged only ONCE across two back-to-back identical failures (rate-limited)
FAIL  (MANY UNRELATED ROWS) the wedged, never-recorded candidate still correctly reads NOT landed
FAIL  (DUP ROW) THE CAP: 9 genuinely-containing duplicate rows overflow the spawn cap — a real landing reads NOT landed (the cap's own, accepted availability cost on this pathological shape)
FAIL  (DUP ROW) the overflow is logged exactly ONCE across two back-to-back identical lookups (got 0) — proving BOTH "logged once" and "memoized" together
```

**Mutation C** (CR5/round-6 control) — the row-spawn prune's filter replaced with `rows.filter(() => true)`:
```
FAIL  (INT ABOVE CAP) THE FIX: the genuine intermediate candidate still reads landed with 8 unrelated rows piled on top of it
```
Nothing else regressed — re-confirming round 6's own isolated prune-dependence finding still holds after
the conversion. No converted scenario stayed GREEN under a gate-defeat it should have caught.

## Timing basis

3 solo, foreground, single-lane runs on the committed file: 152.9s / 174.7s / 183.9s, all 0 failures.
`TEST_TIMEOUT_OVERRIDES["branch-gone-ledger-cutover-gate"]` resized 1,750,000ms → 450,000ms (~2.45x the
183.9s max). The discovering card's premise that DEPTH/M2-REGRESSION/SPAWN-COUNT/MANY-UNRELATED-ROWS drove
"300 sequential real landings" was itself wrong — measured directly, none of the four ever called
`confirmWorkerMergeTracked`.

## Round 2 — Code Review 18e5e030 (HEALTHY, no blockers)

Confirmed round 1's RED-proof independently (its own mutation — `classifyAgainstLedgerUncached` forced to
return `"recorded"` whenever a boundary exists, placed differently from round 1's own mutation A but
reaching the same conclusion — reddened all 13 negative-claim checks, none else); per-scenario `check()`
counts matched exactly (91 → 101, the +10 being EQUIVALENCE CHECK); the fast-import rewrites reproduce the
real branch names and (tip, base) pairs exactly. Found one minor + several cheap nits, all fixed here.

**Minor — the equivalence proof covers only the SOLO shape.** EQUIVALENCE CHECK compares a real solo
landing's row against `seedLedgerLanding`'s single-candidate shape (`base = tip^`). Neither real BATCH
test asserted its own row's shape before this round (MERGEIN-BATCH asserted nothing about the row itself;
`batch-intermediate-candidates-ledger-recorded.mjs:76` asserts only `maxRowId !== null`), so the
multi-candidate seeded shape (`base = tip~N`, relied on by GENUINE INTERMEDIATE ABOVE CAP and DUPLICATE
ROW OVERFLOW) was never pinned against a real batch row at all. Fixed by adding 5 assertions to
MERGEIN-BATCH itself, right after the batch lands: exactly ONE new ledger row, `branch === "feat"`,
`base === mainTipBeforeFeat`, `tip === feat`'s own post-batch tip, and `git rev-parse <tip>~2 === base` —
pinning the real writer's own 2-candidate row shape directly, at zero added runtime (the batch already ran
for an existing assertion).

`seedLedgerLanding`'s own doc comment now also states explicitly that its one-commit-per-candidate shape
is a REACHABLE SUBSET of the real batch writer, never the general case: `landBranchCommitsIndividually`
(`batch-merge.ts` ~706) trailers only each candidate's own LAST commit, and a single candidate can land
SEVERAL commits (a multi-commit worker branch cherry-picked whole) — the helper matches the common case
exactly but cannot produce that wider shape; a scenario needing it must build the chain by hand.

**Nits, all applied:** the eight `check(label, true)` setup checks (WEDGED, MERGEFORGE, TRANSIENT,
NONLINEAR ×2, MERGEIN-A ×2, ERROR RATE LIMIT) now assert something real — the ref actually moved to the
seeded landing's own `finalTip` (or, for MERGEFORGE, that the forged merge `M` is a genuine ancestor of the
result). FINDING-5's "the watermark is genuinely stale" check relabelled — the test SETS it that way via
`setMeta`, not a real confirm's own side effect, so "genuinely stale" overclaimed what the scenario proves.
`seedLedgerLanding` gained a one-line guard that `onto` is actually `refBranch`'s current tip (catches a
caller passing a stale base). `fastImportTrailerChain` gained a `shas.length === count` assertion (catches
the walk silently resolving fewer/more commits than were actually built). The trivially-true
"NAMED-DIFFERENT tip/base/id differ" check in EQUIVALENCE CHECK was dropped — the seeded row is, by
construction, a NEW row chained onto the real row's own tip, so those fields differ whether the writer is
sound or not; the naming/documentation of which fields are compared how is kept, just not asserted. DUP
ROW's own comment and local variable (`realRow` → `seededRow`) corrected — that scenario was converted off
real landings in round 1, so "the REAL row this batch just wrote" was stale.

**Re-measurement**, one host, solo/foreground/single-lane, round 2: 202.4s (1 run), 0 failures. Combined
with round 1's own 152.9s/174.7s/183.9s and the reviewer's own 245.0s solo run (host load unmeasured) —
the largest of all five is the reviewer's 245.0s. `TEST_TIMEOUT_OVERRIDES` resized 450,000ms → 600,000ms
(~2.45x of 245,000ms), per the a9119abf 2-2.5x-of-max-solo band sized off the LARGEST observed run, not
just this seat's own.

## Do not

- Do not convert RECORDED, LAUNDER, MERGEIN-BATCH, or EQUIVALENCE CHECK to seeded rows — each is the one
  place pinning a specific real-pipeline combination (pathset-present + ledger on a gone branch; the
  laundering anchor against genuinely Loom-made rows; batch wiring; the equivalence proof itself). Doing so
  would leave nothing in this file exercising the real writer at all.
- Do not write a `mainline_landed_commits` row for a new scenario except through `seedLedgerLanding` (or a
  real landing, for the four above) — a hand-rolled insert would drift from the writer's own (tip, base)
  semantics silently.
- UPDATED by card f9ccdcb1 (docs/decisions/f9ccdcb1-orphan-anchors-extend-into-test-comment-scoped.md):
  the superseded version of this bullet said a `test/`/`tests/`/`e2e/` file's "zero orphan anchors" was
  always vacuous, since `EXCLUDE_SEGMENTS` skipped those directories outright — the gap this card's own
  anchor (6cf10d10) fell into. `orphanAnchors`/`orphanRecords` now DO scan those directories (comment-
  scoped: a real `@decision <id>` written in an actual comment counts, a synthetic fixture id in a quoted
  string/template literal never does), so a clean `orphanAnchors` sweep there is now a verified negative
  for THAT check specifically. It is still vacuous for every OTHER check in the file (`unanchoredLongBlocks`,
  `brokenAnchors`, `overlongAnchorIds`, `sigilSpaceAnchors`, `bareCommitAnchors`, `pointerAnchors`,
  `overlongAnchorParagraphs`, `midSentenceAnchors`, `embeddedAnchors`, `splitAnchorParagraphs`) — those
  stay excluded from test/ entirely, by design (see f9ccdcb1's own record for the measured reason).
- Do not treat `seedLedgerLanding`'s multi-candidate shape (one commit per candidate, each trailered) as
  the GENERAL real-batch shape — it's a reachable subset. The real writer
  (`landBranchCommitsIndividually`, `batch-merge.ts` ~706) trailers only each candidate's own LAST commit
  and can land several commits per candidate; a scenario that needs that wider shape must build it by
  hand, not via this helper.
