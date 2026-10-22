# 56c10535 — a branch identity read is always `refs/heads/`-qualified; a "pinned" tip is not an independent witness if it was captured the same bare way

Card `967eb326` (Code Review `c5ac1bd6`) fixed 5 sites in `git/worktrees.ts` that resolved a worker
branch via a BARE revision string (`rev-parse --abbrev-ref`, `${branch}` interpolated into a `rev-list`/
`merge-base`/`diff` range, `%(refname:short)`, `symbolic-ref --short`). **Two DIFFERENT mechanisms, both
plantable by any worker through the shared `.git` — do not conflate them (Round 2 correction below):**
- **String-shortening ambiguity** (`--abbrev-ref`, `%(refname:short)`, `--short`): these pick the
  SHORTEST name that still resolves UNAMBIGUOUSLY. A same-named TAG **or** a `refs/remotes/<name>/HEAD`
  ref both make git shorten to a disambiguated `"heads/<name>"` instead of `"<name>"` — breaking a
  STRING-EQUALITY check against the bare name, even while the real branch exists. This is what card
  `967eb326` actually fixed.
- **Revision-priority ambiguity** (`rev-parse --verify <ref>^{commit}`, `merge-base`, `diff` ranges —
  what THIS card, `56c10535`, is about): these pick WHICH COMMIT a bare name resolves to, by git's DWIM
  search order. While the real branch EXISTS, only `refs/tags/<name>` (confirmed real) and the rarer
  `refs/<name>`/`$GIT_DIR/<name>` outrank `refs/heads/<name>` — **`refs/remotes/<name>/HEAD` does NOT**;
  it sits BELOW `refs/heads/<name>` in this search order and can only matter once the branch is MISSING
  (see "Round 2" below for that separate, DWIM-reachable-decoy finding).

This card (`56c10535`) swept the remaining revision-priority-ambiguity sites across `git/worktrees.ts`,
`git/batch-merge.ts`, and 29 of the ~37 `resolveGitRef` call sites in `sessions/service.ts` that pass a
worker/loom branch name (the other 8 pass `"HEAD"` or an already-resolved sha and were left unchanged).

## The key finding: the "pin" is not an independent witness

`mergeBranchLocked`'s squash-target resolve (`rev-parse --verify <branch>^{commit}`) is checked against
`expectedBranchTip` (the solo path) or `BatchCandidate.tip` (the batch path) — a value the merge pipeline
treats as an independently-captured "what the gate actually ran on" proof. Tracing its production
provenance end-to-end: **every producer of that pin — `pinnedGateTip`/`squashTip` (solo),
`verifiedTip`/`reviewedTipVerdict`'s `live` (batch) — was itself derived via `resolveGitRef` with a BARE
branch name**, the identical unqualified `rev-parse --verify <ref>^{commit}` the squash target itself
used. A planted same-named tag therefore poisons BOTH sides of the `resolvedBranchHead !== expectedBranchTip`
comparison identically, so the guard never fires: real git proved a planted tag at an unrelated commit let
that commit's content land on main under the real task's subject and `Loom-Worker-Branch`/
`Loom-Landed-Tip` trailers, while the worker's real commit silently never landed (and a tag planted at
main's own tip made the merge misclassify as a no-op `ALREADY_MERGED`/`STAGE_EMPTY_RETRY`, dropping the
real commit just as silently). `recutStaleReusedBranch`'s ahead-count carried the same flaw independently:
a tag at main made a genuinely >0-ahead (real, unmerged) reused branch misclassify as 0-ahead, triggering
the `reset --hard` reserved for a provably-empty branch and destroying the real work.

## The rule

**A branch identity read is always `refs/heads/`-qualified, never a bare revision string** — whether it
decides what content lands (a squash/cherry-pick target), what gets destroyed (a re-cut's ahead-count),
what a human reviews (the manager's pre-merge diff), or what metadata is composed (a subject/commit-log
body). A value that already carries this protection (a sha, `"HEAD"`, an already-qualified ref) needs no
further qualification; a caller holding only a branch NAME must either call `resolveBranchTip` (see below)
or qualify inline as `refs/heads/<branch>` in the same git-revision argument.

## `resolveBranchTip` vs `resolveGitRef`

`resolveGitRef` (`git/worktrees.ts`) is a GENERIC ref resolver — some of its 37 callers pass a sha,
`"HEAD"`, a mainline branch name, or an already-qualified ref, none of which should be blanket-prefixed
with `refs/heads/`. `resolveBranchTip` is the new, BRANCH-qualified sibling. Every `resolveGitRef`
caller that was passing a worker/loom branch NAME was migrated to `resolveBranchTip`; every caller
passing `"HEAD"` or an already-resolved sha (e.g. `${base}^{commit}` where `base` is itself a sha) was
left on `resolveGitRef` unchanged.

**Round 2 correction (Code Review `9483d176`): `resolveBranchTip` no longer resolves via
`refs/heads/<branch>^{commit}` at all.** That form is NOT exact — confirmed with real git: when the real
branch is missing, git's own DWIM re-applies its FULL search order to the STRING `refs/heads/<branch>`
itself (not just to a bare `<branch>`), and resolves a PLANTED `refs/refs/heads/<branch>`,
`refs/tags/refs/heads/<branch>`, or `refs/heads/refs/heads/<branch>` ref in its place — `rev-parse`/
`merge-base`/`diff` can never fail closed this way. `resolveBranchTip` now resolves via
`git for-each-ref --format=%(refname)%00%(objectname) -- refs/heads/<branch>`, filtered to the line
whose `%(refname)` is EXACTLY `refs/heads/<branch>` (never a prefix/startsWith check — `for-each-ref`
also pattern-matches a ref's own sub-paths, e.g. `refs/heads/<branch>/x`). `for-each-ref` does no DWIM at
all, so this is genuinely exact: `null` when the branch is missing, the real sha otherwise, never a
decoy. ⚠️ Card `59e53710`'s own finding applies here too — never resolve a ref's existence by EXIT CODE
alone (`show-ref --verify --quiet` is NOT reliably rejected by simple-git's `raw()`); the verdict here is
read from for-each-ref's OUTPUT CONTENT (the exact-refname filter), never from whether the call threw.

## Sites fixed

**Tier 1 — resolve via `resolveBranchTip` and use the returned SHA (fully exact, never a revision
string at all):** `mergeBranchLocked`'s squash-target resolve — a FAILED/missing resolve now REFUSES
(zero side effects) rather than falling back to squashing the bare branch NAME, superseding `7efc2bff`'s
old "never a hard failure" rule, which was itself the identical bare-revision hazard (see that record's
own updated "Narrative"/"Do not") — `recutStaleReusedBranch`'s ahead-count (a failed/missing resolve is
treated the same as an unparseable count — never re-cut),
`landBranchCommitsIndividually`'s (`git/batch-merge.ts`) `${pinnedTip ?? branch}` fallback (now
`pinnedTip ?? resolveBranchTip(...)`, used only when no already-resolved `pinnedTip` sha exists),
`diffBranch`'s 3-dot range (the manager's `worker_merge` review diff — **Round 3 correction: round 2
left this on the `refs/heads/`-qualified STRING form (Tier 2); the record previously overclaimed this
was already fixed. Round 3 is what actually switched it to the exact resolver**, throwing when
unresolvable rather than silently diffing a DWIM-reachable decoy), `worktreeHasWork`'s ahead-count
(same Round 3 correction — a missing/unreadable resolve fails SAFE to `true`, never the reverse).
`sessions/service.ts`'s two `computeEmitCompareGate` call sites now pass the
ALREADY-RESOLVED tip (`emitComparePreWaitBranchHead` / `postWaitBranchHead`, both `resolveBranchTip`
products), never the bare branch name — `computeEmitCompareGate`'s own `ref` param widened to
`string | undefined` with a `notApplicableHere` fail-closed guard, mirroring `isInertMergeDiff`'s own
established `ref: string | undefined` contract (never a branch NAME, always a SHA the caller resolved).

**Tier 2 — qualified as `refs/heads/<branch>` inline (NOT re-resolved to a sha via the exact lookup) —
see "Round 2 — the branch-missing residual" below for why each is safe as-is:** `countCommitsBehind`,
`precheckWorkerDone`'s ahead-count, `detectStaleBase`'s merge-base, `detectCanonicalDirtyOverlap` and
`detectCanonicalUntrackedOverlap` (merge-base + the `changedPathsBetween` calls + the `cat-file -e`
existence check), `branchContentLandedInCommit`, `findLandedSquashCommit`'s re-task-guard merge-base,
`findIntroducingSquashCommit`'s merge-base/diff-range sites, `workerDiff`'s merge-base,
`resolveMergedCommitMapHit`'s merge-base, `deriveTasklessSubject`, `deriveWorkerCommitLogBody`,
`deriveOwnNonTipCommitSubjects`, `mergeBranchLocked`'s own `mergeBaseForSquashMeta`, and
`earliestAuthorDateMs`'s (`git/batch-merge.ts`) rev-parse (display/ordering-only — it decides which
branch lands FIRST in a batch, never what content lands; `pinnedTip` is not threaded through it).
`sessions/service.ts`: every OTHER `resolveGitRef` call site passing a worker/loom branch name
(review-spawn tip validation, gate-base/reconcile/reclassify/held-range/already-landed reads) migrated
to `resolveBranchTip` — all Tier 1 by construction, since they call the exact resolver directly.

## Do not

- Do not blanket-prefix `refs/heads/` inside `resolveGitRef` itself — some of its callers pass a sha,
  `"HEAD"`, a mainline branch name, or an already-qualified ref; qualify at the call site (or via
  `resolveBranchTip`) instead.
- Do not treat a "pinned"/"verified" branch tip as an independent witness without checking how it was
  itself captured — if the capture used a bare revision, the pin inherits the identical ambiguity and a
  comparison against it proves nothing against a planted same-named tag.
- Do not qualify `findLaterBranchSquash`'s (or `findLandedSquashCommit`'s/`findIntroducingSquashCommit`'s/
  `findAllLandedTrailerCommits`'s) `--grep=Loom-Worker-Branch: <branch>` pattern — that is a literal TEXT
  match against commit message content, never a ref resolution, and is not part of this bug class.
- Do not qualify a `git branch --list <branch>`/`git branch -D <branch>` call — `branch --list` only
  lists LOCAL branches (never tags) and `branch -D` only removes `refs/heads/<name>` if present; neither
  does ambiguity-prone revision resolution.
- Do not qualify a `git worktree add <path> <branch>` re-attach call (no `-b`) — confirmed with real git
  that `worktree add` prefers an existing `refs/heads/<name>` over a same-named tag even when both exist
  (unlike `rev-parse`/`merge-base`/`diff`'s own bare-revision priority order); this is a DIFFERENT,
  already-safe resolution path.
- **Superseded (Round 2, item 8, card `46addc1a` folded in):** the review-spawn `createWorktree(...,
  forkFrom)` path was initially left out of scope — `forkFrom` as a bare branch NAME passed straight to
  `git worktree add -b <new> <path> <forkFrom>` makes real git REFUSE outright ("fatal: ambiguous object
  name") under a same-named tag, fail-LOUD not silently-wrong, which read as lower-severity. It was fixed
  anyway: the real caller (`spawnWorker`) now passes `reviewForkFrom.headSha` (already resolved), never
  `.branch` — not for the tag-refusal case, but because passing the NAME meant the cut worktree's content
  and the stamped `reviewBaseSha` (also derived from the SAME `headSha`) were two independent reads of
  one logical value, able to diverge even with no attack at all. See `docs/decisions/46addc1a-*.md`.
- Do not re-derive `expectedBranchTip`'s production provenance by inspecting ONE call site — the pin is
  threaded through several producers (`pinnedGateTip`, `squashTip`, `verifiedTip`/`reviewedTipVerdict`)
  across both the solo and batch paths; trace all of them before trusting a comparison against it means
  anything.
- Do not treat `refs/heads/<branch>` (qualified but not resolved via `resolveBranchTip`) as equivalent to
  an exact resolve — it is still git's own DWIM-search STRING when the branch is missing (see "Round 2"
  below), just one fewer candidate tier than a bare `<branch>`. Qualifying closes the tag/same-name
  ambiguity (Round 1's own finding); it does NOT close the branch-missing DWIM-decoy class (Round 2's).
- Do not resolve a ref's existence by EXIT CODE alone (e.g. `show-ref --verify --quiet`) — card
  `59e53710` measured that simple-git's `raw()` does not reliably reject on that call's exit-code-only
  failure. `resolveBranchTip`'s own verdict comes from `for-each-ref`'s OUTPUT CONTENT.
- Do not widen `computeEmitCompareGate`'s `ref: string | undefined` guard's `notApplicableHere` kind
  beyond `"git-operation-failed"` without checking `fd0d34da`'s own "Do not" list first — every kind is a
  cross-project-visible CATEGORY, never a path or message.

## Round 2 (Code Review `9483d176`) — the branch-missing residual, and why Tier 2 sites are safe as-is

Three findings, all closed above except where noted:

1. **BLOCKING — two source-text guards broke:** `emit-compare-branch-capture-order-guard.mjs` and
   `inert-skip-branch-capture-order-guard.mjs` pin `= await resolveGitRef(` on the `emitComparePreWaitBranchHead`/
   `preWaitBranchHead` capture lines; both now pin `= await resolveBranchTip(` instead (plus every
   illustrative fixture string in both files). **Neither guard is in `STATIC_GUARD_REPO_PATHS`** — that is
   why `pnpm --filter @loom/daemon guards` stayed green through this card's whole first round despite
   both being broken; they must be run directly. A broader sweep of `test/*.mjs` for any OTHER
   source-text scanner pinning `resolveGitRef` or the old bare-argv shape found only one more hit
   (`merge-confirm-squash-refusal-recall.mjs`), which turned out to be a prose COMMENT, not a regex — not
   affected.
2. **MAJOR — `computeEmitCompareGate` still took the bare branch NAME** at both `sessions/service.ts`
   call sites — a planted same-named tag could pick the REDUCED-gate classification while the squash
   landed the real branch's (differently-shaped) content. Fixed: both sites now pass the
   already-resolved tip (`emitComparePreWaitBranchHead` / `postWaitBranchHead`); `computeEmitCompareGate`
   itself widened to `ref: string | undefined` and fails closed (`notApplicableHere`) on an unresolvable
   ref, mirroring `isInertMergeDiff`'s own established contract.
3. **MAJOR — `refs/heads/<branch>^{commit}` is not exact.** Closed by rewriting `resolveBranchTip` to use
   `for-each-ref` + exact-refname filtering (see above). Real-git-confirmed: a bare shell `git rev-parse
   --verify refs/heads/<b>^{commit}` against this exact scenario can go EITHER way depending on the
   invocation context — on this host, an interactive-shell git invocation threw "fatal: Needed a single
   revision" (ambiguous — fails LOUD) while the IDENTICAL scenario through `simple-git`/`canonicalGit`
   (the mechanism PRODUCTION actually uses) silently resolved the PLANTED decoy's sha (fails WRONG). A
   test proving this attack surface is real must use the SAME invocation mechanism production code uses
   (`resolveGitRef`/`canonicalGit`), never a bare shell `execSync` — the two are NOT interchangeable
   evidence here; see `branch-identity-ambiguity-2.mjs` Section 7's own comment for this gotcha.

**Why the Tier 2 sites (qualified as `refs/heads/<branch>`, not resolved to a sha) are safe to leave
as-is** — the DoD's own "or justify" alternative, applied per site rather than uniformly re-deriving a
sha everywhere:

- **`branchContentLandedInCommit`, `findLandedSquashCommit`'s merge-base, `findIntroducingSquashCommit`,
  `resolveMergedCommitMapHit`'s merge-base — STRUCTURALLY UNREACHABLE when the branch is missing.** Every
  one of these is called ONLY after the SAME function has already confirmed `branchPresent` via its own
  `git branch --list <branch>` check (an exact, non-DWIM, LOCAL-namespace-only lookup — see the "Do not"
  item above on `branch --list`) — when the branch is genuinely missing, each of these takes its OWN
  separate "branch gone → verify against the persisted path-set trailer" path instead, never reaching the
  `refs/heads/<branch>` merge-base call at all. The branch-missing DWIM class cannot occur here.
- **`detectCanonicalDirtyOverlap` / `detectCanonicalUntrackedOverlap` — explicitly fail-open BY DESIGN.**
  Both functions' own decision records (`4b7ff996`, `98d6264d`) mandate "a probe failure must never block
  a legitimate merge" — a branch-missing+decoy misread degrades to the SAME already-accepted risk class
  as an ordinary probe error/timeout (a false `overlap:false`), not a new exposure. The actual SQUASH
  these preflights gate is independently protected by the Tier 1 fix regardless of what either preflight
  concludes.
- **`workerDiff`'s merge-base — bounded to a display-only diff.** Gated on `fs.existsSync(worktreePath)`
  (not the stronger `branch --list` guarantee the already-landed family has), but wrapped in a try/catch
  that falls through to the next lifecycle case on ANY error — worst case under this residual is a wrong
  *displayed* diff for the live-worktree case, never a destructive action; the orchestration view's own
  diff is advisory, read by a human, not consumed by the squash.
- **`countCommitsBehind`, `precheckWorkerDone`'s ahead-count, `detectStaleBase`'s merge-base —
  documented advisory-only.** Each function's own doc comment states the result "must never block or
  alter a spawn or a review" (card `5150fdc2`/`907b9f50`). A branch-missing+decoy misread here degrades
  an advisory number, never a destructive or content-deciding action.
- **`deriveTasklessSubject`, `deriveWorkerCommitLogBody`, `deriveOwnNonTipCommitSubjects`,
  `mergeBranchLocked`'s `mergeBaseForSquashMeta` — cosmetic metadata, not content.** Worst case is a
  misleading commit SUBJECT or BODY string (the squash's own trailer already records the real
  `Loom-Landed-Tip`); the file CONTENT that actually lands is decided solely by the Tier 1 squash-target
  fix, independent of what these compose as the commit's prose.
- **`earliestAuthorDateMs` (`git/batch-merge.ts`) — ordering-only, already noted in "Sites fixed."**

## Round 3 (Code Review `a9e8a86b`) — the overclaim, a misleading refusal, and a regression gap

Four findings:

1. **Record/test overclaim.** This record's own "Sites fixed" (Tier 1) and
   `branch-identity-ambiguity-2.mjs`'s final summary line both claimed `diffBranch` and `worktreeHasWork`
   already used the exact resolver — false; Round 2 left both on the `refs/heads/<branch>`-qualified
   STRING form (Tier 2), confirmed real with the branch missing plus a decoy: `diffBranch` showed
   `filesChanged:0` (a wrong review diff) and the merge itself refused separately. Fixed: both now
   resolve via `resolveBranchTip` and diff/count against the returned sha — `diffBranch` throws (fail
   LOUD) on an unresolvable branch rather than silently diffing a decoy; `worktreeHasWork` fails SAFE to
   `true` (assume work) on the same, per decision `9cb0287a`'s own "Do not" on this function's default.
2. **Misleading refusal.** `mergeBranchLocked`'s missing-tip refusal fell into `confirmWorkerMerge`'s
   GENERIC `merge_failed` branch, which tells the manager "squash was attempted but never committed …
   Re-task a rebase" — both false: nothing was attempted, and no rebase fixes a branch that's genuinely
   gone or ambiguous. Fixed: a new, distinct `branchTipUnresolvable` flag (mirroring
   `gateBaseInvalidated`/`branchTipMoved`'s own pattern) threads from `mergeBranchLocked` through
   `mergeBranch`'s return type to a dedicated `ConfirmMergeResult.branchTipUnresolvable` field, checked
   in `confirmWorkerMerge` BEFORE the generic fallthrough, classified `"branch-tip-unresolvable"` in
   `NEVER_CACHED_OUTCOMES` (`orchestration/pending-ops.ts`) and `classifyOutcome` (both
   `confirmWorkerMergeTracked`'s own and `mergeBatchTracked`'s sibling), with its own honest wording:
   re-confirm if transient, a human branch-level fix (re-cut/re-point) if the branch is genuinely gone or
   ambiguous — never "re-task a rebase."
3. **Regression gap.** Nothing caught a regression of item 2's own Round-2 fix (`computeEmitCompareGate`
   passing the resolved tip, never `branch`) — `branch-identity-ambiguity-2.mjs` Section 8 passes the tip
   itself and runs against `97fdfff7` (pre-fix), and `emit-compare-branch-capture-order-guard.mjs`'s
   `CLASSIFY_RE` deliberately stops at the call's opening paren, never inspecting arguments (see that
   file's own header). Fixed: a new section (F) in that guard pins BOTH `computeEmitCompareGate` call
   sites' THIRD argument (`emitComparePreWaitBranchHead` / `postWaitBranchHead`, never `branch`), proven
   RED by temporarily reverting the pre-wait call site (source-level) to pass `branch` and rebuilding —
   the real-repo check in (F) failed exactly as expected — then restored and re-verified GREEN.
4. **Nitpicks.** `sessions/service.ts`'s pre-classification capture comment and
   `emit-compare-branch-capture-order-guard.mjs`'s own header both still said the capture was "via
   `resolveGitRef`" and that classify "resolves branch BY NAME internally" — both reworded to describe
   the current `resolveBranchTip`/already-resolved-tip contract. `git/unanchored-comment-blocks.ts`'s own
   `${base}...${branch}` range and `git show ${branch}:${file}` read (a SEPARATE, advisory-only
   comment-anchor-lint consumer of `diffBranch`'s own diffstat, with its own direct `git diff`/`git show`
   calls) now resolve via `resolveBranchTip` too, failing safe to `EMPTY_RESULT` on an unresolvable tip —
   matching that function's own established never-blocking contract. `service.ts`'s review-spawn
   `reviewDiffNeedsBuild` call (~`:9554`) now passes `reviewForkFrom.headSha` via `DiffBranchDeps`' new
   `resolvedTip` field (added to `diffBranch`'s own deps bag, since the two values it was choosing
   between — a branch NAME vs. an already-resolved SHA — are not interchangeable positional-argument
   shapes) rather than re-resolving `reviewForkFrom.branch` by name, closing the identical
   two-independent-reads-of-one-value hazard `46addc1a` closed one level up.

## Tests

`packages/daemon/test/branch-identity-ambiguity-2.mjs` — real git, no claude, no live daemon. Six
sections: the squash target landing the tag's content under the real task's subject/trailer (and the
real worker commit never landing), the tag-at-mainSha false-noop variant, `recutStaleReusedBranch`
destroying a genuinely-unmerged reused branch, the batch path (`assembleBatchBranches`, no `pinnedTip`)
landing the tag's content, `diffBranch` showing the tag's diff instead of the real one, and
`worktreeHasWork` misreporting a genuinely-ahead branch as having no work. Round 2 added a 7th section:
`resolveBranchTip`'s own DWIM-exactness (3 planted decoys, real branch missing, resolve fails closed to
`null`, never the decoy's sha) plus `computeEmitCompareGate`'s own fail-closed contract on an
unresolvable ref, and an 8th: `computeEmitCompareGate` diffing the real branch's resolved tip, never the
tag's, under a spied gitFactory. Round 3 added Sections 5b/6b: `diffBranch`/`worktreeHasWork`, branch
MISSING plus the SAME DWIM-reachable decoy shape Section 7 uses (never a plain same-named tag, which
`refs/heads/<branch>`'s own qualification already defeats on its own and proves nothing about this
card's actual fix — confirmed by hand: a plain-tag decoy passed even against the pre-Round-3 code,
while the DWIM-shaped decoy correctly went RED) — plus extended Section 7's own refusal assertions with
`branchTipUnresolvable`/wording checks. Every scenario proven RED — Sections 1-6 against commit
`f2a64819` (this card's own base), Section 7/8 against the Round-1-only commit `97fdfff7`, Sections
5b/6b and Section 7's new assertions against the Round-2-only commit `958f481b` (the Round-3 fix had not
yet landed) — by reverting `git/worktrees.ts` + `git/batch-merge.ts` + `sessions/service.ts` to the
relevant revision, rebuilding, and re-running — then restored and re-verified GREEN.
`branch-identity-ambiguity.mjs` (card `967eb326`'s own 5 sites) re-run clean, no regression, all rounds.

`emit-compare-branch-capture-order-guard.mjs` and `inert-skip-branch-capture-order-guard.mjs` (the two
Round-2-fixed source-text guards) re-run clean after their `resolveBranchTip` matcher update. Round 3
added section (F) to `emit-compare-branch-capture-order-guard.mjs` (the third-argument pin on both
`computeEmitCompareGate` call sites — see "Round 3" above for its own RED/GREEN proof).

`merge-confirm-branch-tip-unresolvable.mjs` (new, Round 3) — a real `SessionService` confirm, with
`soloMergeGitFactory` making mergeBranchLocked's own squash-target `for-each-ref` lookup come back
empty (the branch is REAL and untouched throughout; only this one call is faked, via the shared
`squashTargetUnresolvable` helper in `_late-commit-seam.mjs`): (A) proves the distinct flag + the
expected wording, never the generic "squash was attempted"/"Re-task a rebase" framing; (B) proves the
refusal is never cached — removing the fault and re-confirming the SAME op genuinely re-attempts and
lands, with no `cacheHit`. (B)'s own never-cached assertions proven RED by temporarily removing
`"branch-tip-unresolvable"` from `NEVER_CACHED_OUTCOMES` (`orchestration/pending-ops.ts`) and
rebuilding, then restored and re-verified GREEN.
