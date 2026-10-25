# b4cc7114 — a redirected sibling worktree's commondir must never hide its work from GC or from the stranded-work merge backstop

Follow-up from Code Review of `3a5c5d4a` (finding S3, flagged as NOT measured end to end): `detectStrandedWork`
and `worktreeHasWork` run worktree-scoped git reads that skip `checkCommondirTrust`'s FILE-shape check via
the `BOUNDED_GIT_ADVISORY_READ` opt-out — unconditionally, regardless of whether `deps.trustedMainRoot` was
ever supplied. The shared `.git` is worker-writable (`docs/decisions/356538ef-canonical-git-isolation.md`'s
threat model), so a worker could rewrite a worktree's own private `.git/worktrees/<name>/commondir` pointer
so that worktree's work reads as absent. This card investigates the claim empirically, corrects its framing,
and fixes the two real findings. Read `docs/decisions/3a5c5d4a-canonical-git-commondir-trust.md` first —
same trust boundary, same hijack mechanism.

## Do not

- Do not assume a BLIND redirect (just rewriting the commondir pointer to point anywhere, with no attempt to
  make the decoy resemble the victim) defeats `worktreeHasWork`'s own dirty-tree check or its branch-ahead
  check — MEASURED that it does not, for two different reasons: the branch-ahead check never touches the
  worktree's own git handle at all (it reads `boundedGit(repoPath, deps)` — the MAIN repo's own
  DIRECTORY-shaped `.git`, untouched by any worktree's private commondir), and a blind, unrelated decoy's
  own tree for an untouched file (e.g. a repo's own `f.txt`) diverges from the worktree's real checked-out
  content, which `git status` itself then reports as an (unintended, but still correctly dirty) extra
  change — masking whether the targeted file's own suppression "worked." A believable decoy (a `git clone`
  of the victim, which shares every blob the victim's real checkout has) is required to isolate the real
  defeat; test it that way, or the result is uninformative in the SAFE direction, which looks like a false
  reassurance.
- Do not treat `detectStrandedWork` as a GC gate. It is NOT called from boot-reconcile Pass B or the wedge
  sweep — `worktreeHasWork` is the ONLY actual GC-destruction gate (`sessions/service.ts`'s boot-reconcile
  Pass B, ~line 27951; its `false` result falls straight through `gcWorktreeDir` to a real `removeWorktree`
  with no second check, since Pass B never sets `opts.retainIfUncommitted`). `detectStrandedWork` is a
  MERGE-ADMISSION refusal backstop (`confirmWorkerMerge`, `mergeBatchTracked`'s candidate filter, and
  `workerMerge`'s review warning) — correcting S3's own framing. Its false negative still causes real data
  loss, just via a different path: an empty merge of the assigned (0-ahead) branch "succeeds," and the real
  stranded commits are destroyed afterward by `finalizeMerge`'s own worktree teardown — which uses ONLY
  `readWorktreeUncommittedState` (a genuinely-clean check, since the lost work is COMMITTED, not dirty; it
  was never designed to catch a divergent-branch strand). State which gate a finding actually reaches before
  proposing a fix location — the two gates have different owners, different call sites, and (as found here)
  different required fixes.
- Do not fix `detectStrandedWork`'s commondir-trust gap by threading `trustedMainRoot` alone. Its OUTER
  catch (`catch { return {stranded:false}; }`) fails safe in the WRONG direction for a classified
  `CanonicalGit*Refusal` — a genuine, DETECTED tampering attempt must not produce the same visible result as
  an ordinary transient git failure. Split on `e instanceof CanonicalGitRefusal` (the established classifier
  this file already uses elsewhere, e.g. `squashRefusalDetail`) before falling through to the permissive
  default.
- Do not assume `worktreeHasWork`'s or `readWorktreeUncommittedState`'s existing catch-all needs the same
  polarity fix. Both already fail safe toward the SAFE direction on ANY error (`worktreeHasWork`: `catch {
  return true; }` — assume work, keep the dir; `readWorktreeUncommittedState`: `catch (e) { return {
  state: "unknown", ... }; }`, and its own ONE real caller, `gcWorktreeDir`'s `retainIfUncommitted` branch,
  already retains on `state !== "clean"` per `docs/decisions/6796c9ea-*.md`'s own "Do not remove on
  unknown" rule). Threading `trustedMainRoot` alone is sufficient for these two — a genuine refusal lands in
  the existing, already-correct catch.
- Do not default a NEW advisory-read call site's `trustedMainRoot` to the worktree path itself, or leave it
  undefined — both are the exact `3a5c5d4a`-documented self-referential/omitted-verification mistakes. Use
  `deps.trustedMainRoot ?? defaultTrustedMainRoot(repoPath)` where `repoPath` is the function's OWN
  main-checkout parameter (never the worktree path these functions pass to their inner `wt` factory) — the
  same pattern `diffBranch`'s own worktree-scoped read (`workerDiff`'s uncommitted-diff branch) already
  established as the real fix for this class.
- Do not add `repoPath` to `readWorktreeUncommittedState`'s signature without updating BOTH of its real
  callers — the production one (`sessions/service.ts`'s `gcWorktreeDir`, which already has `repoPath` in
  scope) and the one direct test call (`codex-doctrine-injection.mjs`, which already has the real main
  checkout path (`mainCwd`) in scope under a different local name).
- Do not re-verify `mergeMainIntoWorktree`'s own advisory-read sites (the early-return merge-base shortcut,
  the owed-landing `commit-tree` write) as part of this card. Confirmed, by reading (not separately
  re-measured — the investigating kickoff's own framing already said so and this agrees): NOT a landing
  bypass. Both calls that actually MOVE refs (`merge --ff-only`, `merge --no-edit`) already thread
  `repoPath` as `killableCanonicalRaw`'s `quarantineRepoPath`, whose own `trustedMainRoot` DEFAULT is
  `defaultTrustedMainRoot(quarantineRepoPath)` (per `3a5c5d4a` round 4) — already real-verified. A
  redirected commondir here can at worst make the early-return wrongly skip a union-forward (a correctness
  miss, not a security bypass) or land a dangling `commit-tree` object in the wrong store (harmless — the
  protected `--ff-only` then fails loudly on a missing object). DEFERRED, deliberately, as a known
  consistency nit — see "Deferred" below, not silently dropped.

## Measured: the real GC case (throwaway repos, real `git worktree add`, real dist functions)

Setup: repo A (trusted main, one commit). A real `git worktree add` worktree cut from A, given genuine work
(a committed-ahead branch / staged-dirty files / a commit on a self-created divergent branch — the real
worker-`712fd5aa` incident shape this project already has a backstop for). Confirmed the check reports the
work correctly, THEN rewrote that worktree's own PRIVATE `A/.git/worktrees/<name>/commondir` file to point
at a decoy, and re-ran the SAME check against the SAME worktree/work.

| check | construction | pre-fix result | post-fix result |
|---|---|---|---|
| `worktreeHasWork`, branch-ahead | blind redirect | correctly `true` (immune — never touches `wt`) | unchanged |
| `worktreeHasWork`, dirty-tree | blind redirect (unrelated decoy) | correctly `true` (an unrelated decoy's own divergence on an untouched file masks the real question) | unchanged |
| `worktreeHasWork`, dirty-tree | **believable** decoy (`git clone` of A + a pre-baked commit matching the victim's CURRENT dirty content on the same branch name) | **`false` — DEFEATED** | `true` (fixed) |
| `detectStrandedWork` | believable decoy (`git clone` of A + a same-named branch pointing AT mainSha — no content-matching needed) | **`{stranded:false}` — DEFEATED** | `{stranded:true, verificationRefused:true}` (fixed) |
| `readWorktreeUncommittedState` | same believable/crafted decoy as the `worktreeHasWork` row | **`{state:"clean"}` — DEFEATED** | `{state:"dirty"}` or `{state:"unknown"}` depending on exactly where the refusal lands (fixed either way — both non-"clean" states are retained by the one real caller) |

The dirty-tree defeat needs the STRONGER "attacker can read the victim worktree's files directly" capability
(to pre-bake a matching blob) — not merely redirect blindly. This is still within the project's own
not-a-sandbox threat model (same user, same host, already-accepted shared-`.git`-write-access posture;
`docs/decisions/356538ef-*.md`'s own "Threat model" section). The `detectStrandedWork` defeat needs only a
BLIND redirect (a same-named branch at/behind mainSha) — no content knowledge of the victim at all, since
it only needs to control a REF VALUE in the attacker's own decoy, not match a BLOB. `detectStrandedWork` is
therefore the cheaper, more realistic exploit of the two.

## The fix

Three sites in `git/worktrees.ts`, each previously constructing its worktree-scoped `wt` handle via
`canonicalGit(p, ms, ..., undefined, BOUNDED_GIT_ADVISORY_READ)` (the FILE-shape, no-`trustedMainRoot`
opt-out) — now instead `canonicalGit(p, ms, ..., deps.trustedMainRoot ?? defaultTrustedMainRoot(repoPath))`,
with the opt-out dropped entirely:

1. `worktreeHasWork`'s dirty-tree `wt` factory.
2. `detectStrandedWork`'s `wt` factory — PLUS its catch now returns `{stranded:true,
   verificationRefused:true}` for a classified `e instanceof CanonicalGitRefusal`, keeping the original
   `{stranded:false}` fail-safe only for an ordinary transient error/timeout. `StrandedWork` gained an
   optional `verificationRefused?: boolean` field so a caller can word its refusal around VERIFICATION
   FAILURE rather than a fabricated branch/commit/ahead (both left `undefined` on this path — there was
   nothing readable to report). **Round 2 refined this — see "Round 2" below**: the single try/catch was
   split so this mapping applies ONLY to the worktree-scoped `wt` reads, and the caching gap it opened is
   fixed separately (`strandedVerificationRefused`/`NEVER_CACHED_OUTCOMES`).
3. `readWorktreeUncommittedState`, which gained a required `repoPath` parameter (its own signature didn't
   carry one before — it previously verified nothing at all). Its existing catch-all
   (`{state:"unknown",reason}`) already covers a classified refusal correctly; no catch-polarity change
   needed. Both real callers updated: `sessions/service.ts`'s `gcWorktreeDir` (already had `repoPath` in
   scope) and the one direct test call in `codex-doctrine-injection.mjs` (passes its existing `mainCwd`).

None of these three call sites qualify for the `3a5c5d4a`-documented advisory-read exemption ("reserve it
for sites where a forged commondir costs nothing beyond a misleading READ") — each steers a real
destructive or merge-admission decision, not a read whose only consequence is a stale display.

## Round 2 (Code Review `a87d8a1e`) — M1 BLOCKING (cache), m1 (scoping), m3 (test)

**M1 (BLOCKING).** Round 1's solo-confirm `verificationRefused` refusal (`confirmWorkerMerge`, before the
gate) returned a plain `{merged:false, reason, detailText}` with no distinguishing flag. `classifyOutcome`
(`confirmWorkerMergeTracked`'s own classifier) had no branch for it, so it fell to the generic `"rejected"`
fallthrough — which **IS** cached/replayed by `retainVerdictUntilSuperseded` (`orchestration/pending-ops.ts`),
keyed on the branch's HEAD. Repairing the shared `.git` (the documented remedy: "escalate to the Platform
Lead, then re-confirm") never moves that HEAD, so every re-confirm after the fix would replay the SAME stale
refusal forever — the documented way out dead-ended. Fixed: `ConfirmMergeResult.strandedVerificationRefused`
(a new result field, set on BOTH the worktree-probe refusal and the repo-level-refusal branch below) is
checked by `classifyOutcome` BEFORE the `"rejected"` fallthrough, classifying to a new outcome string
`"stranded-verification-refused"` — added to `NEVER_CACHED_OUTCOMES`, mirroring `canonicalRepoShallow`/
`quarantined`/`canonical-index-lock-present`'s own entries there.

**m1 (scoping).** Round 1's single try/catch around `detectStrandedWork`'s whole body mapped a refusal from
EITHER the REPO-level `git` handle (the `rev-parse HEAD` / assigned-branch `rev-list` reads) OR the
WORKTREE-level `wt` probe to the identical `verificationRefused:true` + "this worktree's own commondir could
not be verified" wording — misdescribing the repo-level case (e.g. a durable commondir-trust PIN mismatch on
`repoPath` itself) and shadowing its own remedy (a repin, never "inspect the worktree's commondir"). Fixed by
splitting the function into TWO try blocks: the repo-level reads (phase 1: `mainSha` + the assigned-branch
ahead-count) now classify their OWN refusal via `describeGitFailure`/`canonicalFailureMessage` into a NEW
`StrandedWork.refusalText?: string` field — the real classified message, never the worktree-commondir
sentence; the worktree-level reads (phase 2, unchanged in shape) keep `verificationRefused:true` scoped to
themselves. Both still return `stranded:true` (a repo-level refusal must still refuse the merge — the
question just couldn't be resolved either way) and both are wired into `strandedVerificationRefused` for the
M1 caching fix above, since repairing EITHER object (the worktree's private commondir, or the repo's own pin)
equally fails to move the branch's HEAD.

**nit.** Two stale comments (`confirmWorkerMerge`'s own backstop comment, and `workerMerge`'s review-warning
comment) claimed unconditionally that "a check failure fails safe to NOT stranded" — true only for an
ORDINARY error now that a classified refusal fails the OTHER way; corrected in place.

**m3 (test).** `test/merge-confirm-verdict-cache-stranded-verification.mjs` (new) exercises M1 end to end
through the REAL `confirmWorkerMergeTracked` (the cached/tracked entry point — `confirmWorkerMerge` itself has
no cache to defeat): a genuinely-stranded real worktree (the worker-`712fd5aa` incident shape) whose PRIVATE
commondir is redirected (the SAME real construction as `worktree-commondir-redirect-gc.mjs`'s scenario 2, not
a stubbed throw) so `detectStrandedWork`'s `wt` probe throws for real, mid-confirm. Confirms: the op settles
BEFORE any gate lane (`gateCalls === 0`), the RESULT and the `merge_rejected` event both carry
`strandedVerificationRefused:true`; a repeat call while still redirected refuses again identically (isolating
"the redirect persists" from "the cache replays"); after repairing the commondir, the re-call's own
`cacheHit` is `undefined` (a genuine re-evaluation, not a replay) and it now reaches the REAL stranded
refusal (naming the real divergent branch, `strandedVerificationRefused` absent) — proving `detectStrandedWork`
actually ran again rather than replaying the old verdict. `m1`'s repo-level/`refusalText` split is covered as
a focused UNIT test instead (scenario 4, added to `worktree-commondir-redirect-gc.mjs`): a `commondir` file
planted directly inside the MAIN repo's own DIRECTORY-shaped `.git` (refused unconditionally, no pin needed)
produces `refusalText` set and `verificationRefused` absent, with wording that does not borrow "worktree's own
commondir". RED/GREEN + clean-tree re-proven via `pnpm --filter @loom/daemon negative-control --ref c0f57460
--file packages/daemon/src/git/worktrees.ts --file packages/daemon/src/sessions/service.ts --file
packages/daemon/src/orchestration/pending-ops.ts --test packages/daemon/test/worktree-commondir-redirect-gc.mjs
--test packages/daemon/test/merge-confirm-verdict-cache-stranded-verification.mjs` (reverting to the round-1
commit): RED genuinely fails scenario 4b and every M1-specific assertion (not a build break — the round-1
code still builds and runs, it's just behaviorally wrong); GREEN restores all; tree byte-identical.

## Round 3 — a full-gate rejection on `worktree-removal-never-reaches-repo.mjs` (card e21cfd5f), not a regression

The full merge gate (op `0ca3a327`) rejected on `worktree-removal-never-reaches-repo.mjs`'s own check (2):
`the reconcile result COUNTS refused paths (A, B, H ⇒ ≥ 3)` — `res.worktreesPathRefused` had dropped below 3.
Investigated by running the file directly (not a broad gate) and tracing fixture (H): a session row whose
project's OWN resolved `repoPath` (`"h-live-repo"`) is **deliberately never created on disk**, while its
`worktreePath` field is set to `repoH` — a **different project's** real, archived, registered repo — a
corrupted-fixture shape engineered specifically to drive `gcWorktreeDir`'s own repo-registry refusal
(card `e21cfd5f`'s whole point), never a realistic production pairing (a session's `worktreePath` is always
created via `createWorktree(repoPath, ...)`, so the two always genuinely agree there).

`worktreeHasWork`'s fix (this card, round 1) now threads `defaultTrustedMainRoot(repoPath)` into its `wt`
probe — for row (H), that resolves against the NONEXISTENT `"h-live-repo"` (falling back to the bare,
unresolvable path per `defaultTrustedMainRoot`'s own contract), which can never equal `repoH`. The DIRECTORY-
shape mismatch check in `checkCommondirTrust` fires BEFORE the probe's `git status` would otherwise have run
against `repoH` directly — classified `CanonicalGitCommondirRefusal`, caught by `worktreeHasWork`'s own
already-correct fail-safe (`catch { return true; }`) — so Pass B now takes the `worktreesKept` branch for
(H) instead of ever reaching `gcWorktreeDir`'s `worktreeRemovalRefusal` check at all. (A) and (B) are
unaffected: (A)'s own `repoPath`/`worktreePath` genuinely agree (both are the real primary repo), and (B) has
no `.git` at all so the Pass B loop's dead-leftover branch routes it to `gcWorktreeDir` directly, bypassing
`worktreeHasWork` entirely either way.

**Verdict: the test's hardcoded count was stale, not a real regression.** `repoH` is never touched in either
code path — the test's own content-survival assertion for (H) (line ~126) passed both before and after this
card, unexamined by the rejected count check alone. The reclassification is actually a STRICTLY STRONGER
posture: a worktree whose claimed lineage (session `repoPath` → `worktreePath`) cannot be verified now fails
safe to "assume work, never touch it" ONE LAYER EARLIER than the pre-existing registry-membership guard,
rather than relying solely on that later guard. Fixed by asserting the COMBINED protection signal
(`worktreesPathRefused + worktreesKept >= 3`) plus two narrower checks pinning WHICH bucket each case lands
in ((A)+(B) still `>= 2` path-refused; (H) specifically `>= 1` kept) — so a future change that moves a case
between the two buckets again is still caught as a SHAPE change, not silently absorbed by a single loose
sum. See `test/worktree-removal-never-reaches-repo.mjs`'s own inline comment at check (2) for the full
per-case trace.

## Deferred (named, not silently dropped)

`mergeMainIntoWorktree`'s own early-return merge-base shortcut and its owed-landing `commit-tree` write
still construct their advisory-read `wt`/`commitTreeGit` handles the same way — left untouched in this card
(manager ruling: a correctness-only nit, not security-bearing, since the two calls that actually MOVE refs
are already protected). A future card threading `trustedMainRoot` into these too would close the remaining
inconsistency (a wrongly-skipped union-forward on a redirected worktree) but is not required for this card's
own DoD.

## Tests

- `test/worktree-commondir-redirect-gc.mjs` — real scratch repos, real `git worktree add`, real dist
  functions: (1) `worktreeHasWork` + a believable crafted decoy (control: no-redirect baseline unaffected;
  fixed: still reports work). (2) `detectStrandedWork` + a blind decoy (control: no-redirect baseline
  unaffected; fixed: `stranded:true, verificationRefused:true`, with `branch`/`commit` left unfabricated).
  (3) `readWorktreeUncommittedState` + the same crafted decoy (control: no-redirect baseline unaffected;
  fixed: no longer reports `"clean"`). (4), round 2: `detectStrandedWork` + a REPO-level refusal — see
  "Round 2" below. RED/GREEN + clean-tree proven via `pnpm --filter @loom/daemon
  negative-control --file packages/daemon/src/git/worktrees.ts --test
  packages/daemon/test/worktree-commondir-redirect-gc.mjs` — RED phase genuinely fails all three fixed
  assertions (not merely a build break: the build DOES also fail, on the reverted 2-arg
  `readWorktreeUncommittedState` signature mismatch in `sessions/service.ts`, but the test run independently
  reproduces each real behavioral regression). GREEN restores all three; tree restored byte-identical.
- `test/merge-confirm-verdict-cache-stranded-verification.mjs` (round 2, new) — see "Round 2" below for the
  M1/m1/m3 findings this proves.
- Existing suite re-run clean against the fix: `canonical-git-helper-guard.mjs`,
  `canonical-git-isolation.mjs` (both `LOOM_DEV` states — this code path does not itself branch on
  `isLoomDev()`/`isSupervised()`, but the neighbouring canonical-git suite was re-run under both anyway per
  this project's own ambient-env discipline), `codex-doctrine-injection.mjs` (its own direct
  `readWorktreeUncommittedState` call updated to the new signature), `batch-merge-dirty-worktree-retained.mjs`
  (exercises the REAL `finalizeMerge` → `gcWorktreeDir` → `readWorktreeUncommittedState` integration — a
  genuine broken-gitdir-pointer fixture in this suite already produces a live `CanonicalGitRefusal` through
  the newly-threaded path and is correctly retained, `unverified:true`), `pass-a-stuck-worktree-no-replay.mjs`.
