# c395b4fb — carry `residuePossible` on every cleanup path, and extend `canonicalTrustRefusal` to every
# pre-squash canonicalGit call site in `mergeBranchLocked`

Follow-up to `08c36dae` (`fix(sessions): flag trust-refused and unverified squash merge refusals`), found
by worker `f708b0ae` during that card's own investigation. Reuses 08c36dae's own vocabulary
(`canonicalTrustRefusal`, `NEVER_CACHED_OUTCOMES`) rather than duplicating it — read that record first.

## Part 1 — `cleanupResidueFlags`: `resetOrSkip` has TWO unflagged paths, not one

The card's own premise was that a **skipped** `resetOrSkip` cleanup (pre-existing unstaged dirt,
`hadUnstagedDirtAtEntry`) silently dropped `residuePossible`. Confirmed at source: `resetOrSkip`'s skip
branch returns `{message}` with no `quarantined`/`transient`, and its own message says the next merge
"will refuse loudly on any staged residue this left behind" — i.e. the squash's staged diff is left in
the canonical index.

**But `resetOrSkip` has a SECOND unflagged path**: its `attemptReset`'s final, first-attempt, ordinary
failure (neither `RepoQuarantinedError`, nor a confirmed/unconfirmed kill) ALSO returns `{message}` with
no `quarantined`/`transient` — and its own message also says "canonical repo may have residue". The
existing (pre-fix) spread `...(cleanup?.transient ? {transient:true, residuePossible:true} : {})` missed
this exactly like it missed skip.

The correct predicate isn't "detect skip specifically" — it's exactly what `landedContentDiverged`
(decision `24c22912` round 2) already used: `cleanup && !cleanup.quarantined && !cleanup.transient ⇒
residuePossible:true`. Every `resetOrSkip` branch that returns a non-null, non-quarantined, non-transient
result is a case where the reset either never ran (skip) or failed ordinarily — never a case where
cleanup silently succeeded (that's the `null` return). Extracted as the shared `cleanupResidueFlags`
helper and applied at all 9 spreads (the 8 that were missing it, plus `landedContentDiverged` itself, for
one single source of this logic instead of two).

## Part 2 (fold-in 2) — `preSquashResidueUnclearable`

The residue-clear block's `git reset --merge HEAD` call exists to clear AFFIRMATIVE pre-existing
in-progress-merge residue (a real `MERGE_HEAD`/unmerged state left by an earlier, unrelated process) —
entirely BEFORE `git merge --squash` ever runs. Its own ordinary-failure catch (distinct from the
`RepoQuarantinedError`/confirmed-kill/unconfirmed-kill branches already handled) fell through to the
generic fallthrough's "squash was attempted but never committed … canonical repo untouched … Re-task a
rebase" — wrong on all three counts: no squash was ever attempted, the canonical repo is NOT untouched
(the real residue is still there — that's the whole reason this block ran), and a rebase of the worker's
branch cannot touch the canonical checkout.

Classified `preSquashResidueUnclearable: true` + `residuePossible: true` (manager-approved wording, lead
gen 451):

> no squash was attempted; pre-existing in-progress-merge residue in the canonical checkout could not be
> cleared, so residue is present; a human must clear it (`git merge --abort` / inspect `git status`)
> before any merge on this repo; a rebase will not help

Added to `classifyOutcome` (service.ts) AND `NEVER_CACHED_OUTCOMES` (orchestration/pending-ops.ts), with
its own early-return branch in `confirmWorkerMergeTracked`, checked before the generic fallthrough —
mirroring 08c36dae's own `canonicalTrustRefusal`/`headMovedUnverified`/`squashLandedUnread` branches.

## Part 3 (fold-in 3) — `canonicalTrustRefusal` at every other pre-squash canonicalGit call site

`canonicalRaw` (`git/bounded.ts`) calls `checkCommondirTrust` FIRST on EVERY call, before any git process
runs — so a persistent commondir/pin/unpinned/merge-driver condition throws `CanonicalGitRefusal` on
EVERY canonicalGit call, not only the squash's own trust check. `boundedMergeGit`'s `git` instance (used
throughout `mergeBranchLocked`) is `canonicalGit(...)`-backed, so every `git.raw()` call in the function
is exposed to this. Measured, in execution order, which pre-squash call sites had NO
`instanceof CanonicalGitRefusal` check at all before this card:

1. The gate-base HEAD re-check (`requireCanonicalHead && !branchStableSinceGateBase`) — a direct
   `git.raw(["rev-parse","HEAD"])` in its own try/catch.
2. The mainline-branch pre-check (`expectedMainlineBranch` set) — via the SHARED `readHeadShaAndBranch`
   (`git/mainline-watch.ts`), which swallows every error to `null` by design ("never throws"). Closed by
   adding an OPTIONAL `onRawError` callback parameter — additive only; every existing caller (two in
   `batch-merge.ts`, and this file's OWN post-commit mainline-branch verify) omits it and is byte-
   identical. Only the ONE call site this card touches passes it.
3. The cut-base ancestry check's own canonical-target-tip read (`cutBaseSha` set) — a direct
   `git.raw(["rev-parse","HEAD"])` in its own try/catch.
4. `checkCutBaseAncestry`'s own `merge-base` probe — swallows its error to a string (`probeError`) only.
   Closed by adding an OPTIONAL `probeErrorObject` field to `CutBaseAncestryCheck` — additive only; its
   other 3 call sites (`batch-merge.ts`, and TWO advisory pre-gate reads in `service.ts`) ignore the new
   field.
5. The residue-clear block's `ls-files --unmerged` probe (its OUTER catch — see Part 4) and the
   `reset --merge HEAD` call (shared with fold-in 2's own catch — checked FIRST, before the
   quarantine/kill branches, since `CanonicalGitRefusal` is a disjoint error type from either).
6. The staged-at-entry (`git diff --cached --name-only`) and status-at-entry
   (`git status --porcelain --untracked-files=no`) checks — direct try/catches.

All six now call ONE shared `trustRefusalResult(e)` helper first in their catch, returning
`{ok:false, canonicalTrustRefusal:true, reason}` (reusing `describeGitFailure`/`canonicalFailureMessage`,
the exact shape the squash's own trust check and the identity-fallback probe already produce) or `null`
for any other error, in which case the existing classification is unchanged.

### Consumer-safety check (manager-required before relabeling sites 2-4)

Sites 2-4 previously fell through to `unverified: true` (site 2) or `forkPointUnverified: true` (sites 3
and 4) for a `CanonicalGitRefusal` specifically (since no `instanceof` check existed). Grepped every
consumer of both flags before relabeling:

- `merge.unverified` (the SOLO path's field, distinct from `FastForwardResult.unverified` / batch-merge's
  own post-ff `unverified` / `DirtyWorktreeRetained.unverified` — all unrelated, same-named fields):
  consumed ONLY at `confirmWorkerMergeTracked`'s `if (merge.branchDiverted || merge.unverified)` branch
  (service.ts) and `classifyOutcome`'s `"ff-unverified"` mapping. No mainline-tripwire, alerting, webhook,
  or MCP-surface code reads it.
- `merge.forkPointUnverified` (the SOLO path's field — `batch-merge.ts`'s OWN `forkPointUnverified` is a
  SEPARATE field on `assembleBatchBranches`'s result, untouched by this card): consumed ONLY at
  `confirmWorkerMergeTracked`'s dedicated `if (merge.forkPointUnverified)` branch and
  `classifyOutcome`'s `"fork-point-unverified"` mapping.

Both consumers read the flag unconditionally (no secondary classification of WHY it was set), and since
`trustRefusalResult`'s result carries ONLY `canonicalTrustRefusal` (never `unverified`/`forkPointUnverified`
too), a relabeled result now routes to the `canonicalTrustRefusal` branch instead, skipping the old branch
entirely — no dual-flag collision, nothing silently double-classified. Safe.

## Part 4 — the residue-clear block's outer catch, narrowed from a catch-all (manager-required, in scope)

`git blame` on the comment (`0c880acd`, "fix(orchestration): reorder mergeBranch residue probe for full
unmerged-index auto-recovery") shows the outer catch's ORIGINAL intent, before the reorder: catching
`rev-parse -q --verify MERGE_HEAD`'s EXPECTED non-zero exit when no `MERGE_HEAD` exists. That commit moved
`ls-files --unmerged` to run FIRST and unconditionally — its own commit message states `ls-files
--unmerged` "exits 0 on a clean repo (never throws)" — and isolated the `MERGE_HEAD` check into its own
NESTED try/catch, but left the OUTER catch's comment saying "ls-files failed (e.g. not a repo / no HEAD)
⇒ no residue to clear", silently swallowing ANY error from `ls-files` itself — including a genuine
`CanonicalGitRefusal`, which would let a redirected/unpinned commondir proceed toward the squash as if the
repo were trustworthy.

Narrowed to the ACTUAL only condition under which `ls-files --unmerged` genuinely has nothing to report:
there is no git repository here at all (`isNotAGitRepositoryError`, `git/bounded.ts`). **Correction**: this
is a MESSAGE-TEXT predicate (`/not a git repository/i.test(e.message)`), NOT structural — unlike
`trustRefusalResult`'s `instanceof CanonicalGitRefusal` check, which it is NOT a substitute for and is
checked FIRST, before this one, for exactly that reason. It's the same predicate `createWorktree`'s own
operational-home guard uses for the identical question, which keeps this from being a second, independently-
drifting copy — but it is message-matched there too, not structural; nothing in this codebase has a typed
"not a git repository" marker. Outcome-safe regardless: ONLY the `ls-files --unmerged` probe reaches this
narrowed catch (the nested `MERGE_HEAD` catch, left untouched — see its own "Do not" entry below — and
every OTHER site this card touches has its own direct try/catch), and a worker-plantable message that
happens to match `/not a git repository/i` while the repo genuinely IS one just means execution falls
through to the very next check (`stagedAtEntry`'s own `git diff --cached` probe) — which runs its OWN
fresh `trustRefusalResult`/fail-closed logic and refuses on its own terms rather than silently proceeding
to the squash. A false match here can at most mis-attribute "no residue" for ONE extra probe's width; it
can never let an untrusted or genuinely-failing repo reach `git merge --squash`.
any OTHER, unclassified failure (a timeout, a permission error) now fails closed too —
`{ok:false, residuePossible:true, reason: "failed to inspect canonical repo for in-progress-merge residue
before squashing: …"}` — never silently proceeding toward the squash.

## Test design

Three new test files, each carrying only a short `@decision c395b4fb` CONTRACT comment (what it proves,
≤~12 lines) — the narrative behind each lives here, not duplicated in the test files themselves.

### `merge-pre-squash-canonical-trust-refusal.mjs` (Part 3 — the 7 newly-flagged sites)

Drives `mergeBranch` directly (same function-level scope as `merge-prelanded-content-diverged.mjs` /
`fork-point-ancestry.mjs`) with a REAL `CanonicalGitRefusal`, via the same `registerCommondirTrustPinLookup`
seam `merge-confirm-canonical-trust-refusal.mjs` uses — never a message-text fake. A custom `gitFactory`
flips a shared `untrusted` flag to `true` the FIRST time a call matching that scenario's own targeted git
command is seen, then delegates to the REAL `canonicalGit` (which re-checks trust on every call) — so
everything BEFORE the targeted call stays genuinely trusted, and the targeted call itself is what throws.
Each of the 7 scenarios (A-G) isolates its OWN targeted site as the first canonicalGit call reached, by
choosing which optional `mergeBranch` param (`requireCanonicalHead`/`expectedMainlineBranch`/`cutBaseSha`)
is set:

- (A) the gate-base HEAD re-check (`requireCanonicalHead` set, branch not stable since gate-base) — flip
  on a bare `rev-parse HEAD`.
- (B) the mainline-branch pre-check (`expectedMainlineBranch` set) — via `readHeadShaAndBranch`'s new
  `onRawError` hook; flip on `rev-parse ... --symbolic-full-name`.
- (C) the cut-base ancestry check's own canonical-target-tip read (`cutBaseSha` set) — flip on the same
  bare `rev-parse HEAD` shape (isolated from (A) since `requireCanonicalHead` is unset here).
- (D) `checkCutBaseAncestry`'s own `merge-base` probe — via its new `probeErrorObject` field; flip on
  `merge-base`.
- (E) the residue-clear block's `ls-files --unmerged` probe (its outer catch, narrowed from a catch-all
  — Part 4) — flip on `ls-files`.
- (F) the staged-at-entry check (`git diff --cached --name-only`) — flip on `diff ... --cached
  ... --name-only`.
- (G) the status-at-entry check (`git status --porcelain --untracked-files=no`) — flip on `status
  ... --porcelain`.

### `merge-pre-squash-residue-unclearable.mjs` (Part 2 — fold-in 2, plus its paired trust refusal)

A real, UNRESOLVED merge conflict directly in the canonical checkout (MERGE_HEAD set, unmerged entries
present — same recipe as `merge-mergehead-residue-preserves-unstaged.mjs`'s own scenario (A) setup, left
deliberately unresolved). Scenario (1) uses a custom `gitFactory` that delegates every call to the real
`canonicalGit` EXCEPT the targeted `git reset --merge HEAD` call, which throws a PLAIN ordinary `Error`
(never trust/kill/quarantine-shaped) — proving `preSquashResidueUnclearable` + the exact wording, and that
the real MERGE_HEAD/unmerged residue is left genuinely unchanged (the fake factory's throw means the real
`reset --merge` never ran at all). Scenario (2) reuses the SAME conflicted-repo fixture with a
`trustFlipOnResetMergeFactory` (same flip-then-delegate shape as the sibling test file) targeting the
SAME `reset --merge` call, proving the two causes at one call site classify distinctly
(`canonicalTrustRefusal`, never `preSquashResidueUnclearable`). Scenario (3) drives the SAME ordinary-
failure fault through the real `confirmWorkerMerge`/`SessionService` plumbing (mirrors
`merge-confirm-canonical-trust-refusal.mjs`'s own DB/session setup) to prove the new service.ts branch's
wording at that layer.

### `merge-cleanup-residue-flags.mjs` (Part 1 — `cleanupResidueFlags`)

Three site-classes (per the checkpoint's own grouping, approved by the manager), one SKIP scenario each,
plus one ORDINARY-FAILURE scenario proving `resetOrSkip`'s SECOND unflagged path is fixed too, not just
skip:

- (A) probe-failure class — the post-squash staged-diff probe itself throws (a counter-based `gitFactory`
  that lets the FIRST occurrence of `diff --cached --name-only` — the pre-squash entry check — succeed,
  and throws on the SECOND — the post-squash check).
- (B) conflict/rawError class — a genuine squash conflict (the worker branch and canonical main both edit
  the same file differently).
- (C) subject/commit class — a title containing an HTML entity (`&lt;...&gt;`), driving a clean,
  non-conflicting squash into the `title-html-entity` cleanup site.
- (D) ORDINARY FAILURE — the SAME conflict site as (B), but with NO pre-existing unstaged dirt (so
  `resetOrSkip` actually ATTEMPTS the reset rather than skipping): a `gitFactory` makes the FIRST
  `reset --hard` call throw a plain ordinary `Error`.

Every SKIP scenario also asserts the pre-existing unstaged edit (a DIFFERENT, unrelated tracked file for
(B)/(D); the same file being merged for (A)/(C), since those sites have no conflicting content of their
own) survives byte-for-byte — mirroring `merge-prelanded-content-diverged.mjs`'s own scenario (5)
assertion style.

## Do not

- Do not re-derive `cleanupResidueFlags`'s predicate as "detect skip specifically" — it is
  `cleanup && !quarantined && !transient`, which also covers `resetOrSkip`'s own ordinary first-attempt
  reset failure (see Part 1). A test that only exercises the skip path does not prove the second path.
- Do not add a SEVENTH hand-patched spread at a future cleanup site — call `cleanupResidueFlags(cleanup)`.
- Do not classify a canonical-git trust refusal by matching `reason`/message text at any of the six sites
  this card touched — always `trustRefusalResult(e)`, called first in the catch, which itself is
  `instanceof CanonicalGitRefusal`-gated (never a message match).
- Do not widen `readHeadShaAndBranch`'s `onRawError` hook, or `CutBaseAncestryCheck.probeErrorObject`,
  into a general "now this function can leak errors" contract — both are narrow, additive, single-purpose
  escape hatches for this card's own two call sites; every OTHER caller of either function is
  byte-identical (the parameter/field is simply absent).
- **Do not touch the residue-clear block's NESTED `MERGE_HEAD` catch** (`try { ... rev-parse -q --verify
  MERGE_HEAD ... } catch { /* no MERGE_HEAD ⇒ that signal is simply false */ }`) as part of this card. It
  mirrors the SAME catch-everything pattern at 3+ other sites in this codebase (e.g. the admission-time
  dirty-overlap preflight's own `mergeHeadAtEntry` probe), and the manager's ruling named the OUTER
  `ls-files` catch (Part 4) specifically, not this one. Narrowing it is a separate, wider-scoped
  investigation (it would need to characterize "benign quiet-verify miss" vs. "real other failure" for a
  `-q --verify` call, which this card never needed to solve) — file it separately if it matters.
- Do not assume `checkCutBaseAncestry`'s `probeErrorObject` is populated for its OTHER (non-mergeBranchLocked)
  call sites' own error handling — only the in-lock `mergeBranchLocked` call site reads it; the batch path
  and the two advisory pre-gate reads in `service.ts` never did and still don't.
- Do not read this card as having closed the mainline trust-freeze exposure 08c36dae's own record names as
  "not yet closed" — `preSquashResidueUnclearable` and the newly-flagged `canonicalTrustRefusal` sites are
  ALL pre-squash refusals where `merge.ok` is `false`, so none of them ever reaches
  `recordMainlineLedgerEntryIfRepoUnchanged`/`advanceMainlineWatermark` in the first place — nothing here
  changes that gap one way or the other.
