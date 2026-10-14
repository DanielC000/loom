# 2267e8fa — the identity-fallback probe checks what git would ACTUALLY resolve, via `git var`, not a bare `user.name`/`user.email` config read

## Narrative

Every commit-creating path that falls back to a generic Loom identity when the host has none configured
(the solo squash in `mergeBranchLocked`, `mergeMainIntoWorktree`'s union merge, `batch-merge.ts`'s
cherry-pick-commit, and `vault/versioner.ts`'s `commitVault`/`flushSync`) used to decide "is an identity
configured?" by reading `git config user.name` and `git config user.email` directly and requiring BOTH to
come back non-empty from CONFIG specifically.

That is not the question that matters. `git commit` itself resolves an identity through a wider
precedence: a role-scoped `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` (or `GIT_COMMITTER_*`) env var first, then
`user.name`/`user.email` config, then the `EMAIL` env var (email only), then system auto-detect (GECOS
name + hostname). A bare `git config user.<key>` read sees none of the env-based layers, so it reports
"not configured" for a host whose identity `git` would actually resolve fine — and the fallback then
`-c`-overrides BOTH name and email, discarding the real one.

Found by Code Review of `fdc991be`/`b428d842` (CR `c4536f90`), reproduced with plain git under an
isolated HOME/`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_NOSYSTEM`:
- `user.name=RealName` in config, email ONLY via the `EMAIL` env var ⇒ `hasConfiguredGitIdentity` said NOT
  configured (email isn't in config) ⇒ the commit became `Loom <loom@localhost>` for BOTH author and
  committer, silently discarding the real configured name too.
- The same applies on a POSIX host that auto-detects an identity (no config, no env, GECOS + FQDN).
- Safe already: an identity set fully via `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env beats `-c user.*` on git's
  own precedence, so that case never broke — only a PARTIALLY-configured or auto-detected identity did.
- A transient probe failure (e.g. a block-timeout) also silently read as "not configured."

## The fix

`git var GIT_AUTHOR_IDENT` / `git var GIT_COMMITTER_IDENT` resolve identity by the SAME precedence
`git commit` itself uses, and fail with a specific fatal ("`<Role> identity unknown`" header, ending in
"`unable to auto-detect name/email address`" or "`empty ident name/email`") — verified against a real git
binary — ONLY when that role's identity is genuinely unresolvable by every layer. Probing this instead of
a bare config read is the fix.

**Checked separately per role, applied as ONE override.** `GIT_AUTHOR_IDENT` and `GIT_COMMITTER_IDENT`
are probed independently — a role-scoped env var can make one resolve while the other, having no
role-scoped env of its own, does not. The decision of WHETHER to apply the fallback is "either one
failed"; the fallback itself stays the single existing `-c user.name=/-c user.email=` pair (never two
role-specific override sets).

**CORRECTED (Code Review `4eb77ad0` round 2) — the original claim here, that this combined override is
ALWAYS safe for the mixed case, was FALSE.** `-c user.name=`/`-c user.email=` are CLI-supplied CONFIG,
which git's own precedence places BELOW a role-scoped `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env var — so
applying them never overrides a COMPONENT (name or email) that resolves via its own role-scoped env var.
But `user.email` CONFIG (a `-c` override included) ranks ABOVE the generic `EMAIL` env var and above
auto-detect for the email component specifically — verified directly: `GIT_AUTHOR_NAME=Alice` (role-env)
+ `EMAIL=alice@real.com` (no `GIT_AUTHOR_EMAIL`, no config) resolves the author as `Alice
<alice@real.com>` on its own, but forcing the SAME `-c user.email=loom@localhost` fallback onto that
commit instead lands `Alice <loom@localhost>` — a silently rewritten HYBRID, the real name kept but the
real, EMAIL-env-resolved address overwritten. The original argument's flaw: a role's two components
(name, email) resolve through INDEPENDENT chains, so a role can be fully resolvable through a MIX — one
component via its own role-env, the other via the non-role-specific `EMAIL`/auto-detect layer — while the
OTHER role simply has no role-env at all for that one component and genuinely fails. The combined
fallback is therefore safe ONLY when the resolving role's identity is covered ENTIRELY by its own
role-scoped env (both name AND email) — never when either component comes from `EMAIL` or auto-detect.
This is a PRE-EXISTING defect (the OLD config-read fallback carried the identical contamination risk
whenever it applied at all) — not a regression this card introduces, and NOT fixed by this card; see the
"Do not" bullet below for the deferred, per-role fix and its own card.

**Any OTHER probe error (a timeout, a spawn failure, a future git wording change) is treated as
RESOLVED, not unresolved** — a deliberate choice, not an oversight: fail toward the user's own identity
and let the real commit itself surface any genuine error, rather than silently re-authoring a real user's
commit as Loom on a transient probe hiccup. The one thing this *can't* do is distinguish "transient" from
"a git version whose fatal wording has changed" — both fall through to "treated as resolved," which is
the intentionally safer failure direction (a real commit failure is loud; a silently wrong author is not).

**Message-matched on the async path, `.status === 128` AND the matched message on the sync path.**
simple-git's `.raw()` exposes no real process exit code for a plain non-zero exit (`errorDetectionPlugin`
converts a task failure into a `GitError` whose `.message` is the concatenated stdout+stderr, with no
`.exitCode` carried) — so the async probe (`resolveGitIdentityFallbackArgs`, `git/bounded.ts`) matches
git's own fatal text, the same convention every other probe-failure classifier in that file already uses
(e.g. `isNotAGitRepositoryError`). The SYNCHRONOUS probe (`resolveGitIdentityFallbackArgsSync`,
`vault/versioner.ts`, for `flushSync`'s `execFileSync` path) gets a real numeric `.status` from a thrown
error — the more precise signal, used where it's actually available — but requires BOTH `.status === 128`
AND the same matched message (CR `7163d56a` round 2): `.status` alone also matches an unrelated git fatal
that happens to exit 128 for a different reason, so `.status` narrows the search and the message confirms it.

**ONE shared async helper, not five independent probes.** `resolveGitIdentityFallbackArgs`
(`git/bounded.ts`) is used by all four async commit-creating call sites (the solo squash, the union
merge, the batch cherry-pick commit, and `commitVault`) — superseding `c0aeb5b2`'s prior "do not share,
each commit-creating path decides its own identity policy" ruling. That ruling was about WHETHER a path
falls back AT ALL (`git/writer.ts` still deliberately commits with no override) — not about duplicating
the PROBE mechanism itself. Duplicating the probe three times (identical bodies in `worktrees.ts`,
`batch-merge.ts`, and `versioner.ts`) is exactly what let it drift undetected; sharing it is the fix.
`FALLBACK_GIT_IDENTITY` itself is also now a single exported constant (`git/bounded.ts`), not three
copies. The sync path (`flushSync`) can't literally share code with the async helper (a different
child-process API — `execFileSync`, not simple-git's `.raw()`), so it has its OWN implementation,
`resolveGitIdentityFallbackArgsSync` — but follows the identical rule (probe author/committer separately
via `git var`, fall back only when one is genuinely unresolvable).

**Out of scope, deliberately:** `computeOwedLanding` (`git/worktrees.ts`) ALSO references
`FALLBACK_GIT_IDENTITY`, but unconditionally — it builds THROWAWAY commit-tree objects for computing a
tree (nothing is checked out, no ref moves, as its own doc states), never a real landed, attributed
commit. It was never one of the four buggy sites this card named, and applying a conditional probe there
would add real cost to a purely internal computation with no identity-attribution consequence. Left
untouched.

## Do not

- Do not probe identity with a bare `git config user.name`/`user.email` read — it ignores
  `GIT_AUTHOR_*`/`GIT_COMMITTER_*` env and the `EMAIL` env var, both of which `git commit` itself honors;
  that mismatch is the whole bug this card fixes.
- Do not re-duplicate the async probe/fallback decision per call site — route every commit-creating path
  through `resolveGitIdentityFallbackArgs` (`git/bounded.ts`). Duplicating it before is what let the four
  copies drift (only the solo squash and the union merge ever got the config-read version fixed forward;
  the bug this card closes was present in ALL of them identically).
- Do not treat a probe error OTHER than git's own "cannot determine identity" fatal (exit 128 / the
  matched message) as "unresolved" — a timeout or spawn failure must fail toward the user's own identity,
  not toward silently re-authoring as Loom.
- ~~Do not build asymmetric, role-specific override args... the existing combined pair is already safe for
  the mixed case.~~ **RETRACTED (CR `4eb77ad0` round 2) — this is FALSE when the resolving role's email
  (or name) comes from `EMAIL`/auto-detect rather than its own role-scoped env; see the corrected
  paragraph above.** Per-role env injection (`GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL`/`GIT_COMMITTER_NAME`/
  `GIT_COMMITTER_EMAIL`, set only for the role that actually needs it, never the combined `-c` pair) IS
  the real fix for this residual — a KNOWN, DEFERRED gap, not implemented by this card. Filed as its own
  follow-up card, `7b59e981`; implement it there, not by reopening this one.
- (CR `7163d56a` round 2) Do not run the identity probe on the caller's REAL commit instance, and do not
  call `.env()` on that instance to pin the probe's locale — `.env()`'s single-object form REPLACES
  `_executor.env` wholesale (simple-git's own `Git2.prototype.env`), so it would permanently clobber
  whatever env the real commit needs afterward. The probe always runs on its OWN, DEDICATED instance,
  built via `makeProbeGit` with an env from `localReadGitEnv(baseEnv, {LC_ALL:"C", LANGUAGE:"C"})` — never
  the real instance, mutated or otherwise.
- Do not widen this card's scope to `computeOwedLanding`'s unconditional, throwaway-commit use of
  `FALLBACK_GIT_IDENTITY` — it is a different kind of use entirely (no real attribution consequence) and
  was never part of the reported bug.
- Do not move the solo squash's identity-probe call below the `c862f14c` pathset/base capture in
  `mergeBranchLocked` — the LOAD-BEARING ADJACENCY rule on that capture (no git call between it and the
  commit) still applies; the probe stays hoisted above it, exactly as before this card.

## Consequences

A host whose identity `git` can genuinely resolve — by ANY of its own rules, not just `user.name`/
`user.email` config — now commits under that real identity on every one of the four sites, instead of
having it silently discarded for the generic Loom fallback whenever the identity happens to be
partially-configured, EMAIL-env-completed, or auto-detected. A host with genuinely no resolvable identity
still gets the fallback, unchanged. **Residual, pre-existing, NOT closed by this card:** when the
fallback genuinely IS needed (one role unresolvable), the OTHER role's identity can still come out as a
silently rewritten hybrid if that role's own email (or name) resolved via `EMAIL`/auto-detect rather than
its own role-scoped env — see the corrected paragraph above and the deferred follow-up card, `7b59e981`.

## Source

Card `2267e8fa`, discovered from Code Review `c4536f90` of card `fdc991be` (commit `b428d842`).
