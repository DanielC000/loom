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
**Card `7b59e981` extended this to a synchronous `makeProbeGit` CONSTRUCT failure too** (e.g. a worktree
vanishing mid-flight) — previously unguarded and able to throw past a caller with no try/catch
(`attemptCodexAutoCommit`); now wrapped and degrading to "resolvable" the same way.

**Card `7b59e981` also extended the matched fatal set**: `user.useConfigOnly=true` makes `git var` emit a
DIFFERENT fatal ("no email/name was given and auto-detection is disabled") than the ordinary auto-detect
failure this card originally matched — verified against real git 2.47.0. A host with that config set used
to read as "resolvable" and the fallback never engaged at all; `isGitIdentityUnresolvedError` now matches
both shapes.

## Superseded by `7b59e981` — the fallback is now PER-ROLE env, never a shared `-c user.*` pair

The "Checked separately per role, applied as ONE override" section above, and the "CORRECTED" paragraph
right after it, describe the ORIGINAL mechanism: probe each role independently, but apply a single,
SHARED `-c user.name=`/`-c user.email=` override when either role fails. That round-2 correction already
identified the residual contamination (a `-c user.email=` override reaching an already-resolvable role
whose email came from `EMAIL`/auto-detect rather than its own role-scoped env) and deferred the real fix
to a follow-up card — this is that card.

**The fix:** `resolveGitIdentityFallbackArgs`/`resolveGitIdentityFallbackArgsSync` now return a PER-ROLE
env override (`buildGitIdentityFallbackEnv`, `git/bounded.ts`) — `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` only
when the AUTHOR probe failed, `GIT_COMMITTER_NAME`/`GIT_COMMITTER_EMAIL` only when the COMMITTER probe
failed, never both pairs for one role resolving and the other not. A role-scoped env var ALWAYS outranks
`-c`/config on git's own precedence (see the "CORRECTED" paragraph above), so the injected override for
the failing role always wins, and — the structural property the old mechanism lacked — a role-scoped env
var for one role has ZERO effect on the OTHER role's resolution. This isn't a narrower patch of one repro;
it removes the shared mutable surface (global `-c user.*` config) the whole contamination class lived in.

Every call site merges the returned record into the REAL commit's own already-explicit `env` object (a
fresh plain-object spread built at the call site, e.g. `{ ...nonInteractiveEnv(), ...identityEnv }`) —
never `.env()` on an existing instance, which stays exactly as unsafe as this card's own "Do not" below
already says. The one call site with no existing per-call env hook (`mergeMainIntoWorktree`'s `owedBase`
branch, `commit-tree`) builds a dedicated one-off `canonicalGit(worktreePath, timeoutMs, mergedEnv)`
instance — same factory, same hardening, same `timeoutMs` bound — used for that ONE call only, never
shared or reused, and never constructed at all when no fallback is needed or a test `gitFactory` is
active (byte-identical to before in both cases).

**CORRECTED (CR `ff3eec9f`) — that one-off instance's `mergedEnv` must be `localReadGitEnv(nonInteractiveEnv(),
identityEnv)`, never a bare `{ ...nonInteractiveEnv(), ...identityEnv }` spread.** `wtGit` (the instance
this one-off replaces for that ONE call) never carried an explicit env at all, so simple-git's
`blockUnsafeOperationsPlugin` never ran against it; passing ANY explicit env arms that plugin, and
`nonInteractiveEnv()` alone doesn't satisfy it (it scrubs the editor/pager family only, never the
transport family) — an ambient `GIT_ASKPASS` (e.g. VS Code's own terminal sets it) made this call throw
"not permitted without enabling allowUnsafeAskPass" on a call that used to be silent about it entirely.
`localReadGitEnv` strips the transport family before merging in the fallback, which is safe here because
`commit-tree` never touches a remote. So this one call site DOES now carry an explicit env where it
never did before — a narrow, deliberate exception to "byte-identical to before when no fallback is
needed," confined to this one call.

**Residual, accepted — corrected (CR `ff3eec9f`): the limit is the PROBE, not git's own resolution.**
`git` itself resolves name and email as two fully independent components regardless of source — e.g.
`EMAIL=real@user` + `GIT_COMMITTER_NAME=OnlyName` (no `GIT_COMMITTER_EMAIL`) resolves cleanly as
`OnlyName <real@user>`; there is no git-level obstacle to overriding just one component. The actual limit
is `git var GIT_<ROLE>_IDENT` itself: it dies with ONE combined fatal the moment either component is
missing, so the probe's own `resolvable: boolean` signal per role cannot distinguish "name failed" from
"email failed" — `buildGitIdentityFallbackEnv` sets BOTH of a failing role's components because that's
all the probe tells it. A FINER fix is possible: the fatal TEXT itself already distinguishes the two
("empty ident name" vs "empty ident email", "unable to auto-detect name" vs "...email address", "no name
was given..." vs "no email was given...") — a probe that parsed which specific wording matched could
inject only the genuinely-missing component and leave an already-resolvable sibling component (e.g. a
real auto-detected name next to a failing email) untouched. Not implemented here — deferred as a real,
nameable finer-grained improvement, not a claimed-impossible limitation.

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

**Out of scope, deliberately:** `computeOwedLanding` (`git/worktrees.ts` ~7745) ALSO references
`FALLBACK_GIT_IDENTITY`, but unconditionally, via the ORIGINAL shared `-c user.name=`/`-c user.email=`
pair — it builds THROWAWAY commit-tree objects for computing a tree (nothing is checked out, no ref moves,
as its own doc states), never a real landed, attributed commit. It was never one of the four buggy sites
this card named, and applying a conditional probe there would add real cost to a purely internal
computation with no identity-attribution consequence. Left untouched, still unconditional, still the
shared `-c` pair — **this is NOT a violation of the "Do not reintroduce a shared `-c user.*` pair" bullet
below**, which scopes to the per-role fallback card `7b59e981` fixed (the four real, landed-commit sites);
`computeOwedLanding`'s own throwaway, never-attributed use was carved out of that card's scope from the
start and stays carved out here.

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
  the mixed case.~~ **RETIRED — implemented by `7b59e981`, see "Superseded by `7b59e981`" above.** This
  bullet used to defer the per-role fix as a known gap; it is no longer deferred, so the prohibition it
  stated (against building asymmetric per-role args) no longer applies — per-role env IS now the mechanism.
- **(card `7b59e981`) Do not reintroduce a shared `-c user.name=`/`-c user.email=` fallback pair for any of
  the FOUR real, landed-commit sites this card and `7b59e981` cover** — that is precisely the
  contamination surface this card's own round-2 correction identified and `7b59e981` closed; a shared
  override can never discriminate roles, so it will always carry the same residual risk regardless of how
  carefully its call sites are reviewed. Use `buildGitIdentityFallbackEnv`. (`computeOwedLanding`'s own
  unconditional, throwaway-commit use of the shared pair is a SEPARATE, pre-existing, deliberately
  out-of-scope exception — see that bullet above; it does not violate this one.)
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
still gets the fallback, unchanged. **The hybrid residual this card originally left open IS now closed, by
`7b59e981`** (see "Superseded by `7b59e981`" above): when the fallback genuinely IS needed (one role
unresolvable), the OTHER, already-resolvable role's identity is never touched, regardless of whether that
role's email/name resolved via its own role-scoped env, `EMAIL`, or auto-detect. The narrower residual
`7b59e981` itself accepts — a role needing the fallback gets BOTH its name and email replaced, even if
only one component was the real problem, because the PROBE's per-role signal can't tell which component
failed (git's own resolution has no such limit) — is named in that same section, along with the
finer-grained fix (parsing the fatal's own distinguishing wording) that remains possible but unimplemented.

## Source

Card `2267e8fa`, discovered from Code Review `c4536f90` of card `fdc991be` (commit `b428d842`).
