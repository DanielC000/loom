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

## Do not

- Do not convert RECORDED, LAUNDER, MERGEIN-BATCH, or EQUIVALENCE CHECK to seeded rows — each is the one
  place pinning a specific real-pipeline combination (pathset-present + ledger on a gone branch; the
  laundering anchor against genuinely Loom-made rows; batch wiring; the equivalence proof itself). Doing so
  would leave nothing in this file exercising the real writer at all.
- Do not write a `mainline_landed_commits` row for a new scenario except through `seedLedgerLanding` (or a
  real landing, for the four above) — a hand-rolled insert would drift from the writer's own (tip, base)
  semantics silently.
- Do not trust `comment-anchor-lint.mjs`'s "zero orphan anchors" result for a file under `test/`/`tests/`/
  `e2e/` as proof an anchor in it resolves — `EXCLUDE_SEGMENTS` (that script, ~line 412) skips those
  directories by default (test fixtures commonly plant synthetic ids), so it never scans them at all. A
  clean sweep there is a vacuous negative, not a verified one; this card's own first report made exactly
  that mistake. Verify an anchor under `test/` by reading the file at the anchor line directly, or by
  running `decision-records.mjs`'s resolver against it.
