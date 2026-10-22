# 967eb326 — locale-pin the detached-HEAD classification; an empty-but-resolved read is never "confirmed detached"

`detectStrandedWork` and `attemptCodexAutoCommit` (git/worktrees.ts) both need to tell a genuinely
DETACHED worktree HEAD apart from a genuine READ FAILURE, so a detached worktree with real stray commits
still gets caught by the stranded-work backstop (resp. still gets its auto-commit attempted) instead of
silently failing safe. Both classify by matching `NOT_A_SYMBOLIC_REF` (`/fatal:\s*ref\s.*\sis not a
symbolic ref/i`) against the message `git symbolic-ref HEAD` throws with on a detached checkout.

Code Review on commit `1466710a` (card `967eb326`) found two real gaps in that first pass:

1. **No locale pin.** Git's own fatal text is translated under a non-English locale — the exact
   scenario `resolveMainlineBranchState` already guards against for its own, analogous
   `NOT_A_SYMBOLIC_REF` check (pinning `LC_ALL`/`LANGUAGE=C` via `localReadGitEnv`, per the house rule
   documented at `bounded.ts:103-121` / `resolveGitIdentityFallbackArgs`'s own doc comment — git's
   locale negotiation consults `LANGUAGE` AHEAD of `LC_ALL`, so pinning only one is not enough). Without
   the SAME pin on these two sites, a translated git's fatal text would never match the regex, so a
   genuinely detached, genuinely stranded worktree would misclassify as "a genuine read failure" and
   silently fail safe to `stranded:false` (or, for `attemptCodexAutoCommit`, `{attempted:false,
   committed:false}`) — disarming the merge-gate backstop under exactly the condition it exists for.
2. **An empty-but-resolved read was wrongly treated as confirmed-detached.** `git symbolic-ref HEAD`
   can resolve SUCCESSFULLY with an EMPTY string when the underlying child is killed/interrupted before
   it can write anything at all (the same "a killed child can exit non-zero with empty stderr, which
   simple-git resolves as success" shape card `787dd2a7` already documents for a sibling call) — this is
   NOT the same thing as git running to completion and reporting "not a symbolic ref". The first pass's
   `wtBranchRef ? ... : "HEAD"` fallback collapsed BOTH cases onto the same "treat as detached" branch,
   so a transient/killed read could silently become a **false positive** stranded-work report (or a
   false `headMismatch`) — worse than the pre-967eb326 behavior, which fail-safed via a (now provably
   dead) `!wtBranch` guard on the empty string.

## The fix

- **Locale pin, baked in at construction, never via a later `.env()` mutation.** Both sites' default
  `gitFactory` now builds its instance with `localReadGitEnv(<baseEnv>, { LC_ALL: "C", LANGUAGE: "C" })`.
  For `detectStrandedWork`'s `wt` (read-only diagnostics, never mutates anything) this is the function's
  only instance, so pinning its whole env is unconditionally safe. For `attemptCodexAutoCommit`'s `git`
  (which DOES go on to `add`/`commit`), the SAME single instance is pinned at construction rather than
  spun up as a second, separate probe instance — unlike `resolveGitIdentityFallbackArgs`'s own dedicated
  probe (which exists specifically to avoid a LATER `.env()` MUTATION on a reused instance), there is no
  reuse-then-mutate hazard here: the pin is chosen once, at the one and only construction, for the whole
  function's lifetime. `LC_ALL`/`LANGUAGE` affect only git's own diagnostic text, never commit content,
  encoding, or any git object computation — safe for the real `add`/`commit` calls that follow.
- **Three-way classification, not two.** The symbolic-ref read now distinguishes:
  - *resolved, non-empty* → a real ref; compare it (qualified `refs/heads/<name>`) to the target branch.
  - *resolved, EMPTY* → an interrupted/killed read, structurally indistinguishable from "detached" at
    this layer — fail safe immediately (`stranded:false` / `{attempted:false,committed:false}`), the
    SAME outcome the old, now-dead `!wtBranch` guard produced for this exact input shape.
  - *threw, message matches `NOT_A_SYMBOLIC_REF`* → CONFIRMED detached: git ran to completion and said
    so. Only THIS branch reports `branch:"HEAD"` / `headMismatch:{head:"HEAD"}`.
  - *threw, message does not match* → a genuine, unrelated read failure; re-throw / fail safe, never
    treated as detached.

## Do not

- Do not collapse the "resolved-but-empty" case back into "confirmed detached" — they are
  STRUCTURALLY indistinguishable from each other at this call's own observable surface (both are a
  killed/interrupted-looking signal), and only the THROW path's message actually proves detachment.
- Do not drop the `LC_ALL`/`LANGUAGE=C` pin, and never apply it by calling `.env()` on an
  already-constructed instance — bake it into the factory's own construction call, matching
  `resolveMainlineBranchState`'s existing pattern.
- Do not widen this locale pin to any OTHER call site in this file as a "consistency" pass under this
  card — `detectStrandedWork`'s and `attemptCodexAutoCommit`'s own `wt`/`git` instances are pinned
  because THEY specifically classify git's English fatal text; a call site that never does so needs no
  pin.
