# 89bc3b86 — a missing worktree refuses early on every remaining path, not just the one `c30952c1` closed

Round-2 Code Review follow-up on `c30952c1`
(`docs/decisions/c30952c1-worktree-gone-landing-unconfirmed.md`). That card closed the pre-gate
lookup-null crash and the `if (preLanded)` finalize shortcut's own mislabel. This card closes three more
sites that share the exact same ambiguity — "the worktree is gone, and a landing/merge-base fact about it
could not be confirmed" — but were still mapping it to the WRONG outcome, or not catching it at all.

## 1. The inert-reclassify re-union (`confirmWorkerMerge`, the `isInertMergeDiff`/`acquireRepoGuardOnly`
re-derivation path)

When a merge is classified inert (docs-only) before the repo-guard-only wait, and main OR the branch
moves during that wait, the code re-unions main into the worktree to re-check inertness against the new
tip. `mergeMainIntoWorktree` can return `{ok:false, worktreeMissing:true}` here exactly like it can at the
later, full-admission re-union (`reunionAtAdmission`) — but this earlier site folded that result into the
ordinary `reunionFailed = true` branch, which either burns a full gate lane once admitted (the main-moved
leg) or crashes/mislabels one call later as a generic `gate_worktree_dirty` refusal (the branch-only-moved
leg, `db413510`'s own trigger — `postWaitHead` can still be truthy, and therefore still enter the re-union
branch, even when only the branch moved and main stayed put).

**The fix.** Mirrors the quarantine early-return immediately below it in the same `if/else if` chain:
check `reunion.worktreeMissing` and refuse IMMEDIATELY, before `reunionFailed` is ever set, reusing the
SAME never-cached classification (`worktree_missing_at_admission` / `worktreeMissingAtAdmission`) the
full-admission site already uses for the identical fact — both describe "the worktree vanished while this
merge waited", discovered at two different re-derivation checkpoints, not two different facts.

Tests `worktree-gone-landing-unconfirmed.mjs` scenarios (I) [main moved] and (J) [branch-only moved,
mirroring `merge-gate-inert-diff.mjs` scenario (J)'s own setup] pin both legs.

## 2. The scenario (H) never-cached test gap

`worktree-gone-landing-unconfirmed.mjs` scenario (H) asserted "never cached" by re-confirming on a FRESH
`SessionService` — but `PendingOpRegistry` (and its `untilSupersededVerdicts` cache) is per-instance,
in-memory, so a fresh instance has no cache to hit regardless of whether `worktree-missing-at-admission`
is actually in `NEVER_CACHED_OUTCOMES`. A negative control (removing that string from the set) left the
test green. Fixed by adding a SAME-instance re-confirm (same `SessionService`, same fault factory still
armed) asserting no `cacheHit` and a fresh `opId`, keeping the original fresh-instance recovery check
alongside it.

## 3. The preLanded-truthy / `finishSoloAlreadyLanded`-returns-null mislabel

`c30952c1`'s own fix to the `if (preLanded)` finalize shortcut skips the worktree-gate-stamp read when the
worktree is gone and calls `finishSoloAlreadyLanded` directly. But that helper does its OWN internal
re-lookup (`tipAcrossLandedCheck` → `findLandedSquashCommit`), and can itself return `null` — a `preLanded`
that was truthy a moment ago (from the outer lookup or its one retry) is no longer confirmable, with no
worktree left to fall back to. The pre-fix code let this fall through into the ordinary
freshStamp/reuse-refusal logic, which reads a gone worktree as "unreadable" and mislabels the eventual
refusal as `gate_worktree_dirty` ("uncommitted changes") about a worktree that has none — stranding the
task `in_progress`.

**The fix.** When `worktreeGone` is true and `finishSoloAlreadyLanded` returns `null`, refuse immediately
with the SAME `worktree_gone_landing_unconfirmed` refusal the pre-gate lookup's own null case uses — both
share one helper (`refuseWorktreeGoneLandingUnconfirmed`) now, parameterized only by which specific check
came back ambiguous.

## 4. `mergeMainIntoWorktree`'s wtGit-construction catch mislabelled ANY throw as `worktreeMissing`

The catch around `makeGit(worktreePath, timeoutMs)` (`git/worktrees.ts`) treated every constructor throw
as proof the worktree is gone. A constructor can also throw for an unrelated reason (a transient
git-binary/fs error) while the path still exists on disk — every caller of this function maps
`worktreeMissing:true` to a distinct, never-cached "worktree is gone" refusal, so mislabelling it here
would misreport the real cause as something it isn't.

**The fix.** Check `fs.existsSync(worktreePath)` inside the catch. Only a genuinely missing path gets
`worktreeMissing:true`; a still-present path gets a generic `{ok:false, reason: ...}` instead — no
`worktreeMissing`, and (per this function's own standing contract) never a re-thrown exception either.

## Lesson 198 — grep sweep of every caller

Grepped every caller of `mergeMainIntoWorktree` and every `finishSoloAlreadyLanded`/`finishAlreadyMerged`
call site after the above fixes landed. The first pass of this sweep under-counted both (3 and 2 sites
respectively, instead of the real 4 and 4) — re-verified by grep, not by re-reading the first pass:

- `mergeMainIntoWorktree` callers (4): the pre-gate union-merge (`service.ts` ~17937), the
  inert-reclassify re-union (fixed here, ~18409), `reunionAtAdmission`'s own re-union (already correctly
  mapped by `c30952c1`, ~18825) — all three in `confirmWorkerMerge`'s own call chain — **and a fourth,
  outside it:** `git/worktrees.ts`'s own `autoForwardStaleBase` (~919), called from `createWorktree`'s
  reuse/reattach path (card `5150fdc2`), not from any merge-confirm flow. Verified out of scope: it runs
  while the worktree indisputably exists (we are inside `createWorktree`, operating on the path it just
  reused), and its own failure handling already returns the original `info` unchanged on ANY failure
  including `worktreeMissing` — it never constructs a dirty/gate refusal from the result, so a
  `worktreeMissing` here (an anomaly, not a routine "vanished during a wait") cannot be mislabelled.
- `finishSoloAlreadyLanded` callers (2, unchanged from the first pass): the early
  `!fs.existsSync || taskAlreadyTerminal` short-circuit (`864e79fe`'s early-idempotency path) and the
  `if (preLanded)` finalize shortcut (fixed here). Both now handle a `null` return from a gone worktree
  correctly — the early short-circuit already fell through to the ordinary pre-gate lookup (which itself
  retries once and refuses per `c30952c1`), and the finalize shortcut now refuses directly per fix 3 above.
- `finishAlreadyMerged` callers (4, not 2): `finishSoloAlreadyLanded`'s own call (above, ~20180); the
  POST-GATE `ALREADY_MERGED` finish inside `confirmWorkerMerge` itself (~19863) — reached only after
  `mergeBranchLocked`'s own real squash attempt staged empty and classified it, using `merge.sha` (an
  already-resolved VALUE from that attempt, not a re-queried lookup that can independently go null, so no
  ambiguity of this shape); the batch green-path's direct call (`mergeBatchTracked`, ~21453) for a
  candidate whose gate already passed, same reasoning; and `confirmWorkerMergeTracked`'s own §479f449f
  catch-recovery wrapper (~23095, fires only when the `attach()` run callback THREW) — it only calls
  `finishAlreadyMerged` when its OWN `tipAcrossLandedCheck` lookup found a `landedSha`, so it never has a
  "was truthy, now null" moment to mislabel either.

No remaining caller routes a missing worktree into a worktree-assuming call or a mislabelled refusal.

## Round 2 Code Review — a MAJOR this record's own title overclaimed, plus smaller items

**MAJOR.** Finding 1's own fix only covers a worktree discovered gone AT the inert-reclassify re-union
(docs-only merges) or AT `reunionAtAdmission` (a real gate, but only when MAIN moved during the
gate-queue wait — `reunionAtAdmission` skips its own re-union entirely when the heads are equal). A
worktree that vanishes during the gate-queue wait with main UNCHANGED — the ordinary case for a real,
non-inert branch whose own late worktree removal (or a sibling's unrelated contention) never touches
main — was still unhandled: flow reaches `captureGatedTip` (called right before every real gate spawn),
whose own `computeWorktreeGateStamp` read returns `head:null`, throwing `GateWorktreeDirtyError` —
caught as an ordinary `gate_worktree_dirty` mislabel, the EXACT bug finding 1 (round 1) fixed at a
different call site. The gate-OFF/interval-skip `heldStamp` check (reached post-guard-wait, pre-gate,
when `gateDisabled`) has the identical shape, independent of `captureGatedTip`.

**The fix.** `GateWorktreeDirtyError` now carries an optional `worktreeMissing` flag, set by
`captureGatedTip` via the same `fs.existsSync` disambiguation finding 4 uses. The catch site
(`!gateHasRun`) checks it before falling into the generic dirty-tree refusal. The `heldStamp` check gets
the identical `fs.existsSync`-gated early return. Both now route through a NEW shared helper,
`refuseWorktreeMissingAtAdmission(phaseText)`, which ALSO replaces finding 1's own inline refusal and
`rejectAdmissionReunionFailure`'s own `worktree_missing_at_admission` branch — four call sites, one
helper, one fixed `reason` string (never the raw `GitConstructError` text finding 1's own first draft
leaked through `reunion.reason`).

Tests: scenario (L) — the queued-wait-no-main-move leg, a REAL (non-inert) branch holding the repo guard
directly (the SAME `activeMergeRepos` registry `runExclusive`'s own `mergeRepoFree` admission check
reads — `acquireRepoGuardOnly` writes to it too) to block this confirm's real-gate admission, the
reviewer's own repro. Scenario (M) — the `heldStamp` leg, same hold-then-remove technique as (I)/(J) but
with `orchestration.mergeGate:"off"` (a gateCommand must still be CONFIGURED, or `gate` itself is false
and `if (gate)` — and therefore the whole inert-skip/heldStamp block — is never entered at all; verified
by a direct repro before writing the scenario).

**Finding 2 (test gap).** Nothing in this file went RED without finding 4's own `fs.existsSync`-in-the-
catch fix. Scenario (N) exercises `mergeMainIntoWorktree` directly (no `confirmWorkerMerge` machinery): a
factory throws on the worktree-path construction while the real directory genuinely still exists, and
the result must NOT carry `worktreeMissing` and must name the construction failure, never claim a vanish.

**Finding 3.** Scenario (K)'s own "never cached" proof had the SAME gap finding 2 (round 1) closed for
scenario (H) — it re-confirmed on a FRESH `SessionService`. Fixed the same way: re-confirm on the SAME
instance (its own early short-circuit, unfaulted this time, correctly recovers to `merged:true` — a
replayed cache hit could never flip the verdict).

**Finding 5 (doc nits).** The `preLandedLookupGitFactory` seam's own doc comments (two sites) didn't
mention it now also reaches `finishSoloAlreadyLanded`, which itself serves the early short-circuit, not
just the `if (preLanded)` finalize shortcut. And this file's own top-of-file header still described
scenario (H)'s fault factory as "the real worktree is never touched" — stale since round 1's own (H)
rework (a prior pass in this same card) made it genuinely rename the worktree away.

## Do not

- Do not fold `reunion.worktreeMissing` into the inert-reclassify re-union's `reunionFailed` branch, at
  this site or any future one that calls `mergeMainIntoWorktree` — always check it first, mirroring
  whichever quarantine/error early-return sits beside it.
- Do not treat `finishSoloAlreadyLanded` returning `null` as "nothing to do, fall through" when the
  worktree is gone — its own internal re-lookup can genuinely come back null even though an earlier lookup
  in this same call found a landing; refuse via `refuseWorktreeGoneLandingUnconfirmed`, never fall through
  into the freshStamp/reuse logic that follows.
- Do not label a `mergeMainIntoWorktree` wtGit-construction throw `worktreeMissing` without checking
  `fs.existsSync(worktreePath)` first — a still-present path threw for a different reason.
- Do not prove "never cached" with a fresh `SessionService` alone — `PendingOpRegistry`'s cache is
  per-instance; a fresh instance has nothing to hit regardless of classification. Re-confirm on the SAME
  instance too.
- Do not duplicate the worktree-gone-landing-unconfirmed refusal text/event sequence a third time — route
  every site through `refuseWorktreeGoneLandingUnconfirmed`.
- Do not assume `reunionAtAdmission`'s own re-union covers every worktree-vanishes-during-the-wait shape —
  it only runs when MAIN moved. A worktree gone with main unchanged is discovered later, at
  `captureGatedTip` (real gate) or the `heldStamp` check (gate-off/interval-skip) — both need their OWN
  `fs.existsSync` disambiguation, and both route through `refuseWorktreeMissingAtAdmission`, never a
  second hand-rolled copy of the refusal.
- Do not put `reunion.reason`/any other raw underlying-error text into a `worktree_missing_at_admission`
  refusal's `reason` field — it is always the SAME fixed string, via `refuseWorktreeMissingAtAdmission`.
- Do not test "no gateCommand" as if it were the same condition as `orchestration.mergeGate:"off"` — a
  project with NO gateCommand at all never enters `if (gate)`, so `gateDisabled`/`inertSkip`/`heldStamp`
  are never reached; a gate-off/interval-skip test needs a REAL gateCommand configured, just disabled.
