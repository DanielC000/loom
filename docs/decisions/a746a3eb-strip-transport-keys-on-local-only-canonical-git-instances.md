# a746a3eb — strip transport keys on LOCAL-only canonical git instances; killableCanonicalRaw is immune

## Narrative

With an ambient `GIT_ASKPASS` (VS Code's integrated terminal sets one for its own Git extension, e.g.
`GIT_ASKPASS=C:/fake/askpass.exe`), the solo squash merge failed at "failed to inspect canonical repo
staged state before merge", and the codex auto-commit failed too (silently — `committed:false`, no
`error`), even with a configured identity — a PRE-EXISTING defect, not the separate per-role
identity-fallback class `2267e8fa`/`7b59e981` already cover.

**Root cause.** `nonInteractiveEnv()` (`git/writer.ts`) returns `{ ...scrubGitEnv(process.env),
...NONINTERACTIVE_ENV }` — `scrubGitEnv` strips only the editor/pager family
({@link GIT_ENV_STRIP_KEYS}), never the transport family (`GIT_ENV_TRANSPORT_KEYS`:
`GIT_ASKPASS`/`SSH_ASKPASS`/`GIT_SSH`/`GIT_SSH_COMMAND`/`GIT_PROXY_COMMAND`/`GIT_TEMPLATE_DIR`/
`GIT_CONFIG_COUNT`) — deliberately, so a call that CAN reach a remote (a push) still gets a loud refusal
rather than a silently-widened trust boundary. `boundedSimpleGit`/`canonicalGit` call `.env(scrubbedEnv)`
on the real `SimpleGit` instance whenever a non-empty explicit `env` is supplied; simple-git's own
`blockUnsafeOperationsPlugin` (`@simple-git/argv-parser`'s `vulnerabilityCheck`) then throws on ANY of a
fixed list of env keys present in that explicit env, including the transport family, unless the matching
`unsafe.allow*` flag is set. So any REAL `SimpleGit` instance built with `nonInteractiveEnv()` as its
explicit env fails under an ambient `GIT_ASKPASS` — even for an op that never touches a remote and never
actually invokes askpass — because the mere PRESENCE of the key in the explicit env is what the plugin
checks, not whether it's ever used.

## `killableCanonicalRaw` is structurally immune — this narrows the bug surface a lot

`killableCanonicalRaw` (`git/bounded.ts`) backs EVERY actual git mutation in this codebase (checkout,
checkout -b, add -A, commit, merge --squash/--ff-only/--no-edit/--quit/--abort, reset --merge/--hard,
cherry-pick/--abort). In production (no test-injected `gitFactory`) it routes through
`spawnCanonicalGitTree`, which dispatches to `rawViaWinJobLauncher`/`rawViaDirectSpawn` — a raw
`child_process.spawn()`, NOT a real `SimpleGit` instance. It never calls `.env()`, so
`blockUnsafeOperationsPlugin` NEVER arms against it, regardless of what `env` argument
`killableCanonicalRaw` itself is given (including a bare `nonInteractiveEnv()`). The ONLY path inside
`killableCanonicalRaw` that could reach simple-git is its own `gitFactory` TEST seam
(`if (gitFactory) return withTimeout(gitFactory(repoPath, timeoutMs).raw(args), ...)`), which production
never populates.

So the real bug surface is narrower than "every canonical/worktree call that passes an explicit env" — it
is exactly: a call that builds a REAL `SimpleGit` instance via `canonicalGit`/`boundedSimpleGit` with a
`nonInteractiveEnv()`-class explicit env, and then calls THAT instance's own method DIRECTLY
(`.raw()`/`.status()`/`.revparse()`/`.branchLocal()`/`.getConfig()`) — never through
`killableCanonicalRaw`.

## The fix

`localNonInteractiveEnv()` (`git/writer.ts`) = `localReadGitEnv(nonInteractiveEnv(), {})` — the LOCAL-only
sibling of `nonInteractiveEnv()`, additionally stripping the transport family via the existing
`localReadGitEnv` helper. Used at every real bug site found (enumerated by card `a746a3eb`'s own worker
report):
- `git/writer.ts`'s `resolveOperationalHomeToplevelRefusal` (gates every `GitWriter` write) and the new
  `GitWriter.gitLocal()` (backs `checkout()`/`commit()`'s own reads and mutations).
- `git/reader.ts`'s `GitReader` constructor (read-only project Log/Branches view).
- `git/batch-merge.ts`'s `boundedMergeGit` (the batch-landing worktree's own reads).
- `git/worktrees.ts`'s `boundedMergeGit` (the solo squash merge's own reads — the exact repro site) and
  `attemptCodexAutoCommit`'s `makeGit` (the codex auto-commit's own reads/writes).
- `runs/snapshot.ts`'s `createRunSnapshot` — a DIFFERENT, independent site (never used `nonInteractiveEnv()`
  at all, just a bare `scrubGitEnv(process.env)`, same transport-key gap) — fixed by stripping
  `GIT_ENV_TRANSPORT_KEYS` directly on its own hand-built env rather than switching to the shared helper
  (its env also needs `GIT_INDEX_FILE` pinned, which `localNonInteractiveEnv()` doesn't carry).

## `GitWriter.push()` is the one deliberate exception — never give it the fix

`GitWriter`'s own `git(blockMs)` is shared between `push()` (network-reaching: `git push`/`git push -u`)
and, before this card, `checkout()`/`commit()`'s own local reads. `nonInteractiveEnv()`'s own doc comment
(L62-99) states the design intent explicitly: "We deliberately do NOT set GIT_ASKPASS/SSH_ASKPASS...
disabling that guard is the wrong trade for a trust-boundary surface." So this card does NOT touch `git()`
or `push()`/`identityWarning()` — it adds a SEPARATE `gitLocal(blockMs)` method
(`localNonInteractiveEnv()`) and moves ONLY `checkout()`/`commit()` (and their own `killableGitFactory()`
test-seam adapter) onto it. `push()` stays byte-identical, and still refuses under an ambient
`GIT_ASKPASS` — a regression test pins this (see below).

This is also why central-stripping inside `nonInteractiveEnv()` itself (the DoD's second named option) was
rejected: it would silently also strip the transport family from `push()`'s own instance, defeating the one
deliberate exception the card's own investigation found.

## Round 2 (Code Review `01e61841`) — test hardening, no production behavior change

- `pendingPushSummary()` (`GitWriter`) is a read-only preview (branch/ahead-count/latest-subject) that
  never pushes — it was still built on `git()` (the push-tainted factory); moved to `gitLocal()`.
  `nonInteractiveEnv()`'s own doc now says plainly that `push()` is its ONE remaining caller.
- `test/git-env-vulnerability-strip.mjs`'s section 2b (`GitWriter.push()` STILL refuses the transport
  family) could not actually fail: against a repo with no remote, a push fails EITHER WAY (`"'origin'
  does not appear to be a git repository"`), so the assertion passed whether or not the plugin ever ran.
  Fixed two ways at once: (1) the repo now has a REAL local bare remote the branch tracks (same recipe as
  `git-identity-warning.mjs`'s `makeRepo`), with a sanity CONTROL proving an unblocked push to it
  genuinely succeeds; (2) the refusal is also asserted by error TEXT (`/not permitted|allowUnsafe/` plus
  the literal key name), so a push failing for an unrelated reason can never masquerade as "still
  blocked". Verified RED by moving `push()` onto `gitLocal` in the compiled `dist/git/writer.js` directly
  (restored via a clean rebuild after clearing `tsconfig.tsbuildinfo`) — all 8 of the new assertions
  failed, confirming they discriminate.
- `batch-merge.ts`'s own `boundedMergeGit` (a SEPARATE instance from `worktrees.ts`'s) was gate-invisible:
  nothing in the suite exercised it under an ambient transport var at all, so a revert there would pass
  the gate/CI silently (neither sets one). `test/git-askpass-explicit-env.mjs` scenario (D) now calls the
  real `assembleBatchBranches` under `GIT_ASKPASS`, `GIT_SSH_COMMAND`, and `GIT_CONFIG_COUNT` in turn — the
  last two also pin the strip's BREADTH (every `GIT_ENV_TRANSPORT_KEYS` member, not just `GIT_ASKPASS`).

## Do not

- Do not strip the transport family inside `nonInteractiveEnv()` itself — `GitWriter.push()` shares an
  instance with `checkout()`/`commit()`'s local reads and deliberately needs `GIT_ASKPASS` to stay BLOCKED;
  central stripping would silently also unblock it for push.
- Do not assume a `killableCanonicalRaw(..., nonInteractiveEnv(), ...)` call is affected by this bug — in
  production it never reaches simple-git's `blockUnsafeOperationsPlugin` at all (see above); leave those
  calls as `nonInteractiveEnv()` unchanged.
- Do not route `runs/snapshot.ts`'s `createRunSnapshot` through `localNonInteractiveEnv()` as a drop-in
  replacement for its own hand-built env — that function also needs `GIT_INDEX_FILE` pinned and never used
  `NONINTERACTIVE_ENV`'s other keys (`GIT_TERMINAL_PROMPT`/`GCM_INTERACTIVE`/`LC_ALL`/`LANG`) before this
  card; stripping `GIT_ENV_TRANSPORT_KEYS` directly on its own env preserves that scope exactly.
- Do not add a NEW canonical/worktree call site with an explicit `nonInteractiveEnv()`-class env and a
  direct (non-`killableCanonicalRaw`) method call on the resulting instance without checking whether it can
  ever reach a remote — if it can't, use `localNonInteractiveEnv()`; if it can, keep `nonInteractiveEnv()`
  and document why, the same way `GitWriter.push()` does.

## Source

Card `a746a3eb`, discovered from Code Review `ff3eec9f` of card `7b59e981`.
