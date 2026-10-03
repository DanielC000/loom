# 7e5b23e7 — kill-confirm `mergeMainIntoWorktree`'s two mutating merge calls, with a dedicated timeout floor and one bounded retry

Follow-up from the Code Review of `24c0bdba` (reviewer `1524daa5`). `24c0bdba`/`b801bad0` kill-confirmed
every mutating canonical/batch-merge git call on the LANDING path (`mergeBranchLocked`,
`fastForwardCanonicalMain`) — `mergeMainIntoWorktree` (`git/worktrees.ts`), the UNION-merge step that runs
BEFORE the gate on the WORKER's own worktree, was the one mutating-merge call left on a bare `withTimeout`.
A real specimen (op `d64d890e`, lead gen 389, 2026-10-02) showed exactly the predicted failure: under
five-worker build load, the union-merge was rejected with "exceeded 15000ms (hung git child?)", but the
worktree was found clean a moment later with a real, completed merge commit — the orphaned (un-killed)
child had finished writing it after Loom already reported failure.

## The fix

Both mutating calls — the plain union's `merge --no-edit` and the HELD-branch owed-landing's
`merge --ff-only` — now route through `killableCanonicalRaw` (`git/bounded.ts`), exactly like
`fastForwardCanonicalMain` already does for its own worktree, with `quarantineRepoPath` pinned to the
CANONICAL `repoPath`, never this worker worktree (the parameter's default): a linked worktree shares the
canonical repo's hooks directory and object database, so an orphaned hook child here can reach the same
shared state a batch worktree's own orphan already could — `merge-quarantine.ts`'s own header documents
exactly this reasoning for the batch case, and it applies unchanged here. The two conflict-cleanup
`merge --abort` calls in the plain-union path are routed the same way, for the same reason: leaving them on
a bare `withTimeout` would just move the orphan-child bug one call later.

On catch, every mutating call classifies the failure in this order:
1. `RepoQuarantinedError` (already quarantined) → `{ok:false, quarantined:true}`, no cleanup attempted —
   nothing was mutated.
2. `treeDeathUnconfirmed(e)` → per `24c0bdba`'s own rule, run **no further mutating cleanup** (this is
   exactly the race that rule exists to prevent) → `enterMergeQuarantine(repoPath, ...)` →
   `{ok:false, quarantined:true}`.
3. Otherwise (a CONFIRMED kill timeout, or an ordinary conflict/refusal) → fall through to the existing
   conflict-detection/cleanup logic, now with two additions (below).

## Verify-landed: catching the exact race the specimen hit

A CONFIRMED kill means the child is verified dead — but it may have finished writing the commit in the
instant before the kill signal landed (the specimen's own race, now closed structurally rather than merely
made less likely). Before treating a confirmed-kill timeout as a failure, both paths re-check the worktree:
the plain union checks `merge-base(HEAD, mainSha) === mainSha`; the owed-landing path checks
`HEAD === <the hand-built commit>`. A positive check returns `{ok:true, ...}` instead of a false failure —
mirroring `fastForwardCanonicalMain`'s own existing post-failure HEAD re-read verbatim.

**Deliberately NOT gated on `MERGE_HEAD` absence**, even though that reads as the obvious "is a merge still
in progress" signal. VERIFIED directly against real git (2.47): `MERGE_HEAD` stays present WHILE `post-merge`
itself is running, even though HEAD has already moved to the real merge commit — git only clears it once the
hook returns. Checking it here would misreport an already-landed merge as "still mid-merge" for exactly the
case this check exists to catch (a slow `post-merge` hook outliving the kill-timer). `merge-base(HEAD,
mainSha) === mainSha` alone is correct and sufficient: a genuinely unfinished or conflicted merge leaves HEAD
at its OLD tip, which this can never satisfy.

## The dedicated timeout floor and the one bounded retry

`UNION_MERGE_TIMEOUT_FLOOR_MS = 45_000` applies ONLY to these two mutating merge calls (`mergeTimeoutMs =
Math.max(timeoutMs, UNION_MERGE_TIMEOUT_FLOOR_MS)`), never to the cheap reads elsewhere in this function and
never to the shared per-call `gitOpMs` every other caller in this codebase still passes as `timeoutMs` —
`44c28799`'s file-wide 15s ceiling is deliberately untouched for every other call here. The floor alone
absorbs most of the specimen's load-driven slowness; on top of it, ONE bounded retry is allowed, gated on
ALL three conditions holding:
1. the failure is a CONFIRMED-kill timeout (`TIMEOUT_SHAPED_RE` matches, and it is neither
   `treeDeathUnconfirmed` nor an ordinary refusal/conflict — both already returned above);
2. the verify-landed check (above) said the merge did NOT land;
3. the worktree is independently re-verified back at its own pre-attempt state — for the plain union,
   `HEAD` equals the sha read immediately before the FIRST attempt, no `MERGE_HEAD`, and a clean
   `status --porcelain`; for owed-landing, `HEAD` equals the pre-attempt tip and a clean `status --porcelain`
   (a plain `--ff-only` never leaves `MERGE_HEAD` behind).

If any of the three can't be verified, there is no retry — the function fails exactly as it did before this
card. A retry is logged with its reason (`[union-merge] ... retrying once (<worktreePath>)`).

**A real finding from building the test suite, worth recording so nobody re-derives it by surprise:** for
the PLAIN union path specifically, a kill that lands DURING `pre-merge-commit` (before the hook returns an
exit code) means git never reaches EITHER of its own two post-hook branches — "hook succeeded, commit it" or
"hook failed, write `MERGE_HEAD`/`MERGE_MSG` so a human can finish it by hand" — so `MERGE_HEAD` is never
written at all, and `merge --abort` (which needs `MERGE_HEAD` to have anything to act on) is a genuine no-op
against the merge's own already-staged content. Condition 3 above therefore reliably fails for THIS specific
failure shape, and the retry correctly never fires for it (confirmed empirically — see
`test/union-merge-kill-confirm.mjs`'s own GREEN-1 case). The retry DOES fire for the shape it actually
targets: a timeout where git itself is still genuinely computing the merge (the union-merge's OWN main-
vs-branch diff under host load, BEFORE it has staged anything) — the live specimen's actual root cause — or
any other kill landing before the worktree is touched at all. The committed test proves the retry fires via
`deps.gitFactory` (a deterministic "hangs, touches nothing" simulation) for exactly this reason: a real hook
can't deterministically reproduce the "nothing touched yet" state on the plain-union path.

### Worst-case latency this implies

`killableCanonicalRaw` bounds a single call at `timeoutMs` (here, `mergeTimeoutMs = 45_000`) plus a kill
grace window that defaults to the SAME value (`killGraceMs = ms` in `withTimeoutKillingChild`, since
`killableCanonicalRaw` never overrides it) — so one call's absolute worst-case time-to-settle, via the
give-up path, is `45_000 + 45_000 = 90_000`ms. With the one bounded retry above, the WHOLE union-merge
step's worst case is therefore approximately **2 × 90s = 180s** (two attempts, each bounded at up to
timeout+grace) before this step gives up and reports failure. Nothing in this function holds
`withCanonicalIndexLock` (only the later squash, `mergeBranchLocked`, does), but a manager is expected to
never run two merge GATES concurrently on the same repo (project memory: `merge-gate-queueing-is-safe-
contention-is-the-hazard`) — this union-merge step runs BEFORE gate admission, so this 180s worst case is
how long it can hold up THIS confirm's own progress (and, by the same convention, a human or manager
choosing to serialize merges on this repo) before either landing or failing closed.

## Do not

- Do not raise `44c28799`'s file-wide `GIT_OP_TIMEOUT_MS` (15s) to absorb this — that would loosen the
  ceiling for every OTHER git call in this file, most of which should still fail a genuinely wedged op
  fast. Use `UNION_MERGE_TIMEOUT_FLOOR_MS`, scoped to only these two calls, instead.
- Do not retry on `treeDeathUnconfirmed` — the first child may still be alive; a second attempt would race
  it. Quarantine and fail closed instead, exactly like `24c0bdba`'s own rule for every other mutating call.
- Do not retry more than once, and do not retry without re-verifying the worktree is back at its own
  pre-attempt state first — a retry against a worktree whose true state is unknown (an unverifiable clean
  check) risks compounding whatever the first attempt left behind.
- Do not skip the verify-landed check before running the conflict-cleanup/abort path on a confirmed-kill
  timeout — a merge that already landed must never be aborted out from under itself.
- Do not omit `quarantineRepoPath` (leaving it default to the worktree) for any mutating call in this
  function — this worktree shares the canonical repo's hooks dir and object database, so the default
  would leave the canonical repo unprotected from an orphan here, exactly as `merge-quarantine.ts`'s own
  header already documents for the batch-worktree case.
- Do not treat `attemptCodexAutoCommit`'s own `killableCanonicalRaw` call (which omits the
  `quarantineRepoPath` override) as a counter-example — that call's own factory sets
  `core.hooksPath=devNull` (`@decision bde5d1fe`), so it has no hook-escape vector to close.
  `mergeMainIntoWorktree`'s `wtGit` does not disable hooks.

Full worst-case arithmetic re-derivation: `UNION_MERGE_TIMEOUT_FLOOR_MS` and `killGraceMs`'s default
(`= ms`) are both read live from `git/bounded.ts`/`git/worktrees.ts` — recompute rather than trust the
180s figure above if either changes.

## Round 2 (Code Review `8cd5e832`) — the success path still left MERGE_HEAD behind

The `verify-landed` check above (`merge-base(HEAD, mainSha) === mainSha`) only proves the merge commit
landed — it says nothing about MERGE_HEAD/MERGE_MSG/MERGE_MODE/AUTO_MERGE, which git 2.47 writes BEFORE
`post-merge` runs and clears only once the (now-killed) hook returns. A live specimen reproduced the
consequence: `ok:true, merged:true`, then the NEXT `mergeMainIntoWorktree` call on that same worktree
failed "You have not concluded your merge (MERGE_HEAD exists)" — inside `reunionAtAdmission`, holding a
gate slot. Confirmed owed-landing (`--ff-only`) is unaffected: a fast-forward never sets MERGE_HEAD.

**The fix**: on the plain-union success path, before returning `ok:true`, read MERGE_HEAD. If absent
(the common case), return immediately — no extra git calls. If MERGE_HEAD equals `mainSha` AND `HEAD^2`
(the second parent) also equals `mainSha` — i.e. MERGE_HEAD and HEAD are both provably this exact merge,
never some other, unrelated in-progress one — run `git merge --quit` via `killableCanonicalRaw` (plain
`timeoutMs`, not the 45s floor, matching the existing `--abort` cleanup calls' precedent; same canonical
`quarantineRepoPath` pin; same `RepoQuarantinedError`/`treeDeathUnconfirmed` classification as every other
mutating call in this function). Whether `--quit` was attempted (and failed for a non-quarantine reason)
or never attempted (the precondition didn't match), MERGE_HEAD is re-read one final time: present ⇒
`{ok:false, reason:"union merge landed but its in-progress merge state (MERGE_HEAD) could not be
cleared: ..."}` — a loud, accurate failure; absent ⇒ the original `{ok:true, merged:true, mainSha}`.

**Deliberately NOT swallowing a non-quarantine `--quit` failure** (Code Review `8cd5e832`, round 2):
the post-failure `merge --abort` cleanup elsewhere in this function swallows a non-quarantine error
because that call's surrounding context is ALREADY reporting the union merge as failed — the abort is
pure best-effort on top of an already-bad outcome. Here the union merge already succeeded; swallowing a
`--quit` failure would silently reinstate this exact bug (`ok:true` with MERGE_HEAD still present). The
final re-check is what makes the two cases converge on the same honest signal regardless of which path
got there.

## Round 2 — the admission-site retry is skipped, not merely bounded

`reunionAtAdmission`'s own call to `mergeMainIntoWorktree` runs INSIDE `runExclusive`, holding a scarce,
fleet-shared `GateSemaphore` slot (`maxConcurrentGates`) — every other project's queued merge is blocked
behind it. Recomputed worst case **per attempt** of the plain-union failure path (not just the mutating
call's own give-up): `killableCanonicalRaw`'s give-up (`mergeTimeoutMs` 45s + `killGraceMs` 45s = 90s) +
verify-landed's `merge-base` read (15s) + `ls-files --unmerged` (15s) + the post-failure `merge --abort`'s
own give-up (`timeoutMs` 15s + `killGraceMs` 15s = 30s) + the retry-eligibility clean-check (MERGE_HEAD +
HEAD + `status --porcelain`, 15s each = 45s) = **195s/attempt**. With the one bounded retry this function
otherwise allows, that is **390s** held inside the slot for two attempts — double the fleet-wide blocking
cost for a failure a plain top-level re-confirm recovers from more cheaply (it re-queues this op; it does
not hold the slot).

**Decision: skip the retry at the admission site only.** `BoundedGitDeps.allowRetry` (`git/worktrees.ts`)
defaults to `true`; `reunionAtAdmission`'s own call passes `allowRetry:false`, capping ITS worst case at
one attempt — **150s, not 195s: `allowRetry:false` short-circuits the retry-eligibility clean-check's own
45s of reads too, not just the retry itself (see Round 3 below).** The pre-admission union-merge call (no
slot held yet) and the inert-reclassification re-union (`db413510`/`ac7aad04`'s own call — a repo-guard-
only hold, not a semaphore slot) both keep the retry unchanged, at the original up-to-390s worst case.

The comment above `reunionAtAdmission` (under `@decision b798e706`) previously stated this call's window
was bounded by "nothing more than ... one rev-parse, and ... one merge" and told a `gate_queue`/`idleMs`
reader to expect it to stay small ("non-growing-past-a-couple-seconds"). That predates this card's
kill-confirm wiring entirely and is now corrected in place: the window can reach the ~150s bound above
(this call's own, `allowRetry:false` figure — see Round 3 below) before the gate itself ever starts, and
a manager reading `idleMs` on this phase should expect it to possibly reach the low minutes, not treat
growth past a couple of seconds alone as a stall.

## Round 2 — quarantine refusals are never cached, including the inert-reclassification re-union

Three sites could return a quarantine-class rejection from a solo `confirmWorkerMergeTracked`: the
pre-gate union-merge (`union.quarantined`), `reunionAtAdmission` (`AdmissionReunionFailedError`'s
`quarantined` flag), and the entry-time `assertRepoNotQuarantined` backstop — but `classifyOutcome`
never checked `outcome.value.quarantined` at all, so all three fell through to the plain `"merged" :
"rejected"` fallback and got cached/replayed exactly like an ordinary rejection. After a human clears the
quarantine, a plain re-confirm within the cache's TTL replayed the stale refusal instead of trying again.
Fixed in one place: `classifyOutcome` now checks `outcome.value.quarantined` before the fallback, and
`"quarantined"` is in `NEVER_CACHED_OUTCOMES` (`orchestration/pending-ops.ts`) — covering all three sites
without three separate patches. The entry-time backstop return was also missing `quarantined:true`
entirely (not merely uncached) — added so it participates in the same classification.

A fourth site had a worse problem than caching: the inert-reclassification re-union (triggered when main
or the branch moves during the admission queue wait) called `mergeMainIntoWorktree` and treated ANY
non-ok result — quarantine included — as an ordinary `reunionFailed`, routing the op into the real gate
(`inertSkip = false; gateRan = true`) instead of refusing immediately. That burns a full gate lane (often
minutes) before `mergeBranchLocked`'s own entry check refuses on the quarantine anyway. Fixed by checking
`reunion.quarantined` there too and returning the same quarantined-rejection shape the pre-gate union-merge
uses, before ever reaching the real gate.

### Do not (round 2)

- Do not swallow a non-quarantine `--quit` failure on the success path — always re-verify MERGE_HEAD
  absence before returning `ok:true`; a silent swallow there reinstates the Major this round fixes.
- Do not run `--quit` when MERGE_HEAD doesn't equal `mainSha`, or `HEAD^2` doesn't equal `mainSha` — that
  MERGE_HEAD belongs to some other, unrelated in-progress merge this function has no business touching.
- Do not extend `allowRetry:false` to the pre-admission union-merge call or the inert-reclassification
  re-union — only `reunionAtAdmission` holds a fleet-shared gate slot; the other two sites' retry is
  unaffected.
- Do not let the inert-reclassification re-union treat a quarantine as an ordinary `reunionFailed` — it
  must return the quarantined rejection immediately, never route into the real gate first.
- Do not patch the three quarantine-caching call sites individually — fix `classifyOutcome` and
  `NEVER_CACHED_OUTCOMES` once; a per-site patch drifts the next time a fourth site is added.

## Round 3 — the admission site's own per-call worst case is 150s, not 195s

Round 2's "Worst-case latency" section above states a single **195s/attempt** figure for the plain-union
failure path and applies it unchanged to `reunionAtAdmission`'s own capped-at-one-attempt case ("capping
ITS worst case at one attempt (195s)"). That over-states it: `allowRetry:false` is checked as the FIRST
operand of the retry condition's `&&` chain
(`deps.allowRetry !== false && isConfirmedKillTimeout && attempt === 1 && preAttemptHead !== undefined &&
(await verifyWorktreeCleanAt(preAttemptHead))`), so when it is `false` the retry-eligibility clean-check
call (`verifyWorktreeCleanAt` — MERGE_HEAD read + HEAD read + `status --porcelain`, 15s each = 45s) is
**never evaluated at all**, not merely its `continue` outcome skipped. `reunionAtAdmission`'s own call
therefore never pays that 45s: its real one-attempt worst case is `90s (merge give-up) + 15s (verify-
landed merge-base) + 15s (ls-files --unmerged) + 30s (merge --abort give-up) = 150s`, not 195s. The
pre-admission union-merge call and the inert-reclassification re-union (`allowRetry` left at its default
`true`) are unaffected and keep paying the full 195s/attempt (390s with the one retry) — this correction is
scoped to the admission site alone.
