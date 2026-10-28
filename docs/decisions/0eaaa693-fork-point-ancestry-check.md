# 0eaaa693 — refuse a landing whose fork point is off the current mainline

## Narrative

Found by the `4fabafd1` Code Review (2026-10-20), reproduced in a scratch repo:
`mergeMainIntoWorktree` only ADDS the current mainline branch into a worker branch, so a worker cut from
branch A that lands after the canonical checkout has moved to branch B squashes every A-only commit (past
the fork point) into B. Any canonical-branch change under an unmerged worker can trigger this: a manager's
own checkout-switch tool, the Platform Lead's `git_checkout`, a human REST checkout, or a raw `git
checkout` by the owner.

The project's existing mainline-watermark tripwire/pin (`docs/decisions/2a6a292a-*.md`,
`787dd2a7-*.md`, `d69d4858-*.md`, `ba663984-*.md`) answers a DIFFERENT question — "is the canonical repo
currently checked out on the branch NAME we expect" — and ADVANCES to track any trusted, Loom-observed
switch. It is therefore satisfied even when a stale worker (cut before the switch) lands onto the new
branch; it was never designed to catch a per-worker-branch ancestry problem.

## The fix

A new, per-worker-branch check: `checkCutBaseAncestry` (`git/worktrees.ts`), run against the CANONICAL
repo, with the target tip read FRESH at landing time (inside the same lock/critical section as the
squash/cherry-pick, never earlier). It compares `git merge-base <session.cutBaseSha> <current target
tip>`'s OUTPUT to `cutBaseSha` directly — **never** `git merge-base --is-ancestor`'s exit status. A real
bug caught this live during testing: simple-git's `raw()` resolves that subcommand's non-zero "not an
ancestor" exit (exit 1, empty stderr) as a SUCCESS, so a naive `try { await git.raw(["merge-base",
"--is-ancestor", ...]) ; return {ok:true} } catch { return {ok:false} }` NEVER refuses anything — the
promise always resolves. This is a known, pre-existing gotcha in this exact codebase (`isAncestorCommit`,
`git/mainline-watch.ts`, decision `bc2240d7`; also worked around in `batch-merge.ts`'s
`landedTreeDivergesFromExpected`) that a first draft of this check re-derived the hard way instead of
checking for precedent first.

`cutBaseSha` is the canonical repo's HEAD at the moment a worker's worktree was cut/recut — captured ONCE,
before the worker's first commit and before any `mergeMainIntoWorktree` union merge ever runs. It is a
fixed, pre-existing commit, never re-derived from the branch's own (possibly union-merge-polluted)
ancestry. This is exactly why the check doesn't false-positive on a branch that has union-merged main any
number of times: a union merge only ever ADDS commits ahead of the branch's own tip; it cannot move or
rewrite `cutBaseSha`. The naive alternative — walking the branch's CURRENT history (e.g. the batch path's
pre-existing `git merge-base HEAD <branchTip>`, `batch-merge.ts`) — is unsafe for the opposite reason: a
union merge injects the then-current (possibly wrong-lineage) target's tip as a second parent, so a
merge-base against the branch's live history can trivially resolve to that injected tip and look "safe"
when it isn't.

## `WorktreeInfo.cutBaseAdvanced` (`git/worktrees.ts`)

`createWorktree` already computed `mainSha` (the fork point) at every call, but the ordinary spawn call
site discarded it. Going forward, every FRESH `-b` cut advances the cut base to `mainSha` unconditionally
(including a review spawn's `forkFrom` cut — `cutBaseSha` always means real mainline's HEAD at cut time,
independent of `forkFrom`; see `Session.cutBaseSha`'s own doc for why this must stay separate from
`reviewBaseSha`). A REUSE/reattach of an existing worktree/branch only advances it when
`recutStaleReusedBranch` actually ran its destructive `reset --hard` (the branch was provably 0 commits
ahead and got re-cut onto current main) — a retained RECOVERY branch (left untouched, or merge-forwarded
by `resolveStaleBase`/`autoForwardStaleBase`) never advances it, since forwarding only catches the SAME
lineage up to newer commits, it never changes the TRUE original fork point.

## Round 5 — two more null/unverifiable cases, named

Two further cases produce a `null` or forever-`probeFailed` outcome, distinct from the ordinary legacy
(predates this card) case the "Legacy branches" section below describes — named here so a future reader
doesn't mistake either for a transient condition or a true legacy worker:

- **A recorded `cutBaseSha` whose commit object is genuinely gone** (pruned by a `git gc`, or any other
  removal of the object) fails `checkCutBaseAncestry`'s `merge-base` probe with `probeFailed: true` —
  but unlike a real transient git/host hiccup, THIS probe failure never clears: every retry resolves the
  same unresolvable sha and throws again, so the landing is refused `forkPointUnverified` forever, with
  the "re-confirm to re-check" wording misleadingly implying the next attempt might succeed. There is no
  remedy that re-derives the lost sha (see "Do not attempt a best-effort backfill" below — the same
  reasoning applies to a GONE sha as to a never-recorded one). The real remedy is one of: (a) a manager
  calls `worker_restamp_cut_base` (card `cc788ae4`) to deliberately re-stamp this worker's cut base to the
  current mainline tip, once it verifies the branch was genuinely rebased/cherry-picked onto it (see
  `docs/decisions/cc788ae4-*.md`), or (b) re-dispatch the work on a fresh worker cut from the current
  mainline, same as the confirmed-divergence remedy.
- **`priorCutBaseShaForWorktree` (`sessions/service.ts`) returning `null` because every prior session row
  at that worktree path has since been deleted** (not because the lineage never had one) stamps the SAME
  `cutBaseUnknown: true` grandfathering outcome as a true legacy worker, even though this worktree's
  lineage genuinely once carried a real cut base — it was simply never persisted anywhere this lookup can
  still find. This is accepted, not a bug: the alternative (refusing a landing because its own bookkeeping
  rows were cleaned up) would punish ordinary GC, not a real divergence — but a reader auditing
  `cutBaseUnknown:true` events should not assume every one of them is a pre-card-0eaaa693 legacy branch.

## Legacy branches (grandfathering)

No tool switches the canonical branch under live workers today (the manager checkout-switch tool,
`4fabafd1`, is unmerged and will refuse while unmerged workers exist) — refusing every in-flight worker at
the next deploy, just because it predates `cutBaseSha` being recorded, would cost far more than it
protects. A `null`/absent `cutBaseSha` is therefore GRANDFATHERED: the landing proceeds exactly as it did
before this check existed, with `cutBaseUnknown: true` stamped on the SAME `merge_done` event mechanism
either way (solo: `confirmWorkerMerge`'s one `merge_done`; batch: each landed candidate's OWN
`merge_done`, via the same `finishAlreadyMerged` call) plus one log line — making the gap visible
without silently enforcing against data that was never captured. There is deliberately no best-effort
backfill for an existing branch: once a union merge has already run, the branch's own history is already
contaminated (see above), so a post-hoc derivation would be unreliable and would add a second, harder-to-
reason-about code path for no real safety gain.

## Insertion points

- Solo: `checkCutBaseAncestry` runs inside `mergeBranchLocked` (`git/worktrees.ts`), under
  `withCanonicalIndexLock`, against a freshly read canonical HEAD (its own `rev-parse HEAD`, read right
  there under the lock — NEVER the squash target, which is the WORKER branch's own tip, a different value
  entirely) — alongside the existing `expectedMainlineBranch`/`requireCanonicalHead` pins, never
  substituting for them (they check a different thing: checkout identity, not branch ancestry).
- Batch: `checkCutBaseAncestry` runs inside `landBranchCommitsIndividually` (`git/batch-merge.ts`), per
  candidate, BEFORE the pre-existing (now ancestry-safe only because this check gates it) `merge-base HEAD
  <branchTip>` cherry-pick-range computation. A failing candidate is DROPPED under the existing
  all-or-nothing-per-branch convention (`6801c0a1`) — never an abort of the whole batch — so it surfaces
  the SAME reason and the manager can route it into its own solo refusal.
- A cheap, advisory pre-gate check (at `confirmWorkerMerge`'s start / `mergeBatchTracked`'s candidate
  filtering) runs an UNLOCKED `checkCutBaseAncestry`, through the SAME hardened `canonicalGit` path the
  in-lock check uses (round 3 — a `this.boundedGit` read here was weaker than the canonical merge path's
  own CLAUDE.md-mandated hardening; `soloMergeGitFactory`/`batchFfGitFactory` still thread a test seam
  into it so a hermetic test can fault-inject either read), against a fresh-but-not-re-verified-at-
  squash-time read of the canonical target tip. An already-doomed worker is refused BEFORE a full
  build/DoD gate (solo) or before it occupies a batch slot / feeds its diff into gate-test-selection
  (batch) — a cost-saving addition only, never the authority; the canonical checkout's target can still
  move between that read and the lock, so only the locked re-check (above) is load-bearing. A read
  failure (the WHOLE advisory call throwing, OR `checkCutBaseAncestry` itself returning
  `probeFailed: true`) fails OPEN (falls through to the real gate/lock) — round 2 only handled the
  former; round 3's `probeFailed` split closes the gap where a probe that returned (never threw) a
  `{ok:false}` for a TRANSIENT reason was wrongly refused as a confirmed, unreachable-remedy divergence.

## Refusal shape

Never cached (same `NEVER_CACHED_OUTCOMES` membership as `branchDiverted`/`gateBaseInvalidated`), a
distinct outcome name (`forkPointDiverged`, never `branchDiverted` — that name is already the
project-identity signal and conflating the two would make the two causes indistinguishable to a later
reader), naming both the worker's recorded cut base and the current target in the message. Canonical repo
and worktree untouched on refusal, same posture as every other
`mergeBranchLocked`/`landBranchCommitsIndividually` early refusal.

**Round 3 — probe failure is a DIFFERENT outcome, `forkPointUnverified`, never `forkPointDiverged`.**
`checkCutBaseAncestry` (`git/worktrees.ts`) now returns `probeFailed: true` (plus `probeError`, the real
git message) when `git merge-base` ITSELF throws — a timeout, a transient git-child error — as opposed to
running successfully and resolving to a genuine non-ancestor. Both the in-lock checks (solo
`mergeBranchLocked`, batch `landBranchCommitsIndividually`) and the advisory checks branch on this BEFORE
treating `ok: false` as a confirmed divergence:
- The ADVISORY checks (solo + batch) treat `probeFailed` exactly like any other read failure — fall
  through silently, never refuse.
- The IN-LOCK checks still fail closed (nothing lands on an unverified check) but with a DISTINCT
  classification (`forkPointUnverified`/`"fork-point-unverified"`, also in `NEVER_CACHED_OUTCOMES`) and
  HONEST wording — "could not verify the fork point (git error: …) — re-confirm", never the
  recycling/fresh-worker remedy, since a plain re-confirm is genuinely the right next step for a transient
  hiccup. Conflating the two (what round 1/2 did) produced a real bug: a transient git timeout refused a
  perfectly healthy worker with the "this cannot be cleared by recycling" wording, AND (CR-found) a
  self-contradictory message quoting the same sha as both "cut from X" and "not an ancestor of … (X)" in
  the degenerate `cutBaseSha === targetTip` case.

**The remedy is NOT "recycle the worker onto the current branch"** — a recycle (or a rebase of this
worker's own branch) can never clear this: `recycleWorker` carries the SAME recorded `cutBaseSha` forward
(`Session.cutBaseSha`'s own doc — "SAME worktree ⇒ SAME cut base"), and nothing re-derives it on a rebase
either. The only two remedies that actually work: (a) switch the canonical checkout back to the branch
this worker was cut from, or (b) re-dispatch the work on a FRESH worker cut from the current mainline
(e.g. cherry-pick the commits there). Both refusal messages (solo and batch) say this explicitly.

## Round 4 — test coverage notes

Round 3's own in-lock-wiring test (`packages/daemon/test/cut-base-sha-confirm-in-lock-wiring-batch-extra.mjs`,
scenario (e) — split out of the original combined `cut-base-sha-confirm-in-lock-wiring.mjs` by card
d10f1f92) claimed to prove the batch in-lock wiring (`cutBaseSha: c.cutBaseSha` reaching
`batchCandidates`, `sessions/service.ts`) by moving canonical main mid-gate. A round-4 diagnosis (a
standalone harness reproducing the exact setup) showed this claim was false: the candidates' batch
worktree is cut from the pre-gate tip, so their cutBaseSha ancestry check passes cleanly inside assembly
regardless of the mid-gate move — what actually catches (e) is the batch's own, entirely unrelated,
pre-existing "forfeit" check (`fastForwardCanonicalMain`'s `currentMainSha !== expectedBaseSha` test,
`git/batch-merge.ts` ~line 972, documented at `FastForwardResult.forfeited` ~line 887 — the batch-side
analogue of solo's `gateBaseInvalidated`). Scenario (e)'s comment and assertions were corrected in round 4
to state this; a new scenario (g) (a real, pre-existing cross-lineage divergence, with the advisory's own
probe faulted to fail once so it falls through to assembly) is the one that actually discriminates this
wiring — reverting `cutBaseSha: c.cutBaseSha` to `undefined` makes scenario (g)'s stray candidate silently
land, proving the control.

Round 4 also closed two real gaps round 3 left untested (found by a round-3 negative control showing both
sites stayed vacuously green across the whole test corpus): the batch-side `probeFailed` fallthrough at
the advisory pre-filter (service.ts) and at the in-lock check (`landBranchCommitsIndividually`,
`git/batch-merge.ts`). New scenario (f) fault-injects `batchFfGitFactory` to fail every matching
`merge-base` call for one candidate's cutBaseSha (a value that IS a genuine ancestor), proving the
advisory falls through (never pulling it to stranded fallback on an inconclusive read) and the in-lock
check refuses it as `forkPointUnverified` (never `forkPointDiverged`).

**Round 4's "confirmed UNTESTABLE" claim about the `canonicalGit` vs `boundedGit` choice at the two
advisory call sites is REFUTED (round 5, Code Review ff5de408, item (xi)) — `CANONICAL_GIT_CONFIG`'s one
entry, `core.useReplaceRefs=false` (`git/bounded.ts`), is a REAL, constructible behavioral difference, not
only a "hardening posture that can't be observed":** a planted `git replace` object changes
`git merge-base`'s own answer depending on whether replace refs are honored. Scratch-repo proof: cut a
worker from `c1`; divert canonical to an unrelated `atlas` branch (cut from an earlier `base`, so `c1` is
genuinely NOT an ancestor of `atlasTip`); forge `forged = git commit-tree <atlasTip>^{tree} -p <c1>` and
`git replace <atlasTip> <forged>`. `git merge-base c1 atlasTip` (replace refs honored — `boundedGit`'s own
shape) now resolves to `c1` itself, wrongly reading as "c1 is an ancestor"; `git -c
core.useReplaceRefs=false merge-base c1 atlasTip` (canonicalGit's own config) still correctly resolves to
`base`. `cut-base-sha-confirm-and-batch.mjs` scenario (4) lands this as a real test: the POSITIVE case (no
factory override — production's real `canonicalGit`) refuses PRE-GATE (`gateCalls === 0`, the
`merge_rejected` event carries `phase:"advisory-pre-gate"`); the CONTROL (the SAME `soloMergeGitFactory`
seam swapped to a plain, replace-honoring `simpleGit` — `boundedGit`'s own shape) is fooled and falls
through to a real gate run (`gateCallsControl === 1`) — a genuine RED where the positive case was green.
Round 4's OWN observation (every existing fault-injection test substitutes its own factory, so those tests
alone can't discriminate; a HEALTHY, UNFORGED local `merge-base` read behaves identically either way)
stands correct as far as it went — it just stopped short of constructing the one condition (a forged
replace ref) that DOES discriminate, and wrongly generalized "no existing test can tell them apart" into
"nothing could ever tell them apart." The choice is both a hardening posture AND, as of this adversarial
condition, an observably load-bearing one.

## Round 5 — remaining gaps closed (Code Review ff5de408)

Besides the "untestable" refutation and the two null-case/wording fixes above:
- The in-lock `rev-parse HEAD` catch (`mergeBranchLocked`, reading the fresh canonical target tip right
  before `checkCutBaseAncestry` runs) now carries `forkPointUnverified: true` on a throw, matching the
  SAME honest "could not verify, re-confirm" outcome `checkCutBaseAncestry`'s own probe failure gets — it
  used to return a plain `{ok:false, reason}` that fell through to the generic merge-failed branch's
  "squash was attempted... Re-task a rebase" wording (both false and misdirecting here, since nothing was
  ever squashed and a rebase touches nothing relevant). Test:
  `cut-base-sha-confirm-in-lock-wiring-solo.mjs` scenario (h).
- The REATTACH spawn path (worktree dir removed via `git worktree remove`, branch retained) carries the
  prior worker's `cutBaseSha` forward too, through `createWorktree`'s OTHER `cutBaseAdvanced:false` route
  (`!branchExists || reattachRecut`) — previously tested only via the dir-still-present reuse route. Test:
  `cut-base-sha-spawn.mjs` scenario (4).
- The batch-assembly `cutBaseUnknown` stamp (`finishAlreadyMerged`'s call inside the per-candidate landing
  loop, `sessions/service.ts`) is now tested in BOTH directions — a legacy candidate's own `merge_done`
  carries it, an ordinary candidate's own `merge_done` landing alongside it does NOT. Test:
  `cut-base-sha-confirm-in-lock-wiring-batch-extra.mjs` scenario (i); `cut-base-sha-confirm-in-lock-wiring-batch.mjs`
  scenarios (f)/(g) also gained the "good candidate carries no stamp" negative assertion.
- `mergeBranch`/`mergeBranchLocked` (`git/worktrees.ts`) and `landBranchCommitsIndividually`/
  `BatchCandidate.cutBaseSha` (`git/batch-merge.ts`) all now type `cutBaseSha` as REQUIRED `string | null`
  (never `| undefined`) — a future caller can no longer silently omit the fork-point check just by
  dropping the argument. TypeScript forbids a required param after an optional one in this positional
  list, so each function param uses `= null` (a default, not a bare `?`) to exclude `undefined` from the
  type while staying callable positionally; an omitting caller now gets the SAME logged
  legacy/grandfathered path as an explicit `null`, never a silent, unsignalled skip.
- `fork-point-ancestry.mjs` scenario (E) (an unresolvable cutBaseSha) now also asserts `probeFailed: true`
  — it previously asserted only `ok:false`, which is also true of a genuine confirmed divergence and so
  under-specified which outcome shape the scenario was actually proving.
- `cut-base-sha-confirm-and-batch.mjs`'s scenario (1) worker (and every other real `spawnWorker`-spawned
  worker in that file) is now explicitly stopped (`host.stop(id, "hard")`, mirroring
  `merge-spawn-tracked.mjs`'s own `stopSeamPty`) right after its own scenario's assertions — the prior
  flake root cause was this worker's own ~20s `READY_FALLBACK_MS` background retry machinery firing
  mid-way through a LATER scenario in the same process. This closes that specific, identified mechanism;
  a SEPARATE, lower-frequency flake in the same file (scenario (2)'s real `mergeBatchTracked` occasionally
  returning `{settled:false}` because the real batch assembly exceeded the Tracked wrapper's own
  `syncAttachBudgetMs` under host load) was observed during verification and is NOT fixed by this round —
  it is a different mechanism (a client-side attach timeout, not a pty readiness timer) and is noted here
  rather than silently chased beyond this round's scope.

## Do not

- Do not implement `checkCutBaseAncestry` (or any future ancestry check) with `git merge-base
  --is-ancestor` and a bare try/catch on the exit status — simple-git's `raw()` resolves that
  subcommand's non-zero exit as a success with empty output, so the check silently never refuses.
  Compare `merge-base` OUTPUT to the ancestor sha directly, mirroring `isAncestorCommit`.
- Do not derive `cutBaseSha` from the branch's own current ancestry (a `merge-base` against the branch
  tip) — once a union merge has run, that ancestry is already contaminated by the injected target tip;
  only a value captured BEFORE any such merge is trustworthy.
- Do not let a REUSE/reattach that did NOT actually re-cut (a retained >0-ahead recovery branch) advance
  `cutBaseSha` to the reuse-time HEAD — only a genuine fresh cut/recut (`recutStaleReusedBranch` actually
  ran its reset) may advance it.
- Do not conflate `cutBaseSha` with `reviewBaseSha` — a review spawn's base is deliberately NOT mainline.
- Do not attempt a best-effort backfill for a legacy branch with no recorded `cutBaseSha` — grandfather it
  (`cutBaseUnknown: true`) instead; see "Legacy branches" above for why.
- Do not reuse the `branchDiverted` outcome name for this refusal — it is a different cause (worker-branch
  ancestry, not checkout identity) and needs its own name for an auditor to tell them apart.
- Do not run the authoritative check anywhere but inside the canonical lock, re-reading the target tip
  fresh at that point — an earlier-computed tip can be stale by the time the squash/cherry-pick actually
  runs.
- Do not word the refusal's remedy as "recycle the worker onto the current branch" — that was an
  UNREACHABLE remedy in round 1 (Code Review, 2026-10-20): `recycleWorker` copies `old.cutBaseSha`
  forward (`sessions/service.ts`), a `>0`-ahead respawn carries it back via `priorCutBaseShaForWorktree`,
  and a rebase never re-derives it either — so recycling/rebasing THIS worker can never clear this
  refusal on its own. State that explicitly and name the three remedies that actually work (switch the
  canonical checkout back, re-dispatch on a fresh worker cut from current mainline, or rebase/cherry-pick
  this worker's branch linearly onto the current mainline target and have a manager call
  `worker_restamp_cut_base` — card `cc788ae4` — to re-stamp the recorded cut base).
- Do not treat `checkCutBaseAncestry`'s `{ok: false}` as a confirmed divergence without checking
  `probeFailed` first (round 3, Code Review 2026-10-21) — a `git merge-base` call that THREW (timeout,
  transient error) is not a fact about the branch's lineage; refusing it with the divergence remedy told
  a manager to throw away good work for a passing git hiccup, and produced a self-contradictory message
  in the degenerate `cutBaseSha === targetTip` case.
- Do not use `this.boundedGit`/`boundedSimpleGit` for either advisory probe (round 3) — the canonical
  merge path's own git calls go through `canonicalGit` (CLAUDE.md); use `(testSeamFactory ?? canonicalGit)`
  so production stays on the hardened path while a test can still fault-inject.
