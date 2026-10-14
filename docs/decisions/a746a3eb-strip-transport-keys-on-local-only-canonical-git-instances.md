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

## Follow-up 23c74c62

Code Review `01e61841` of this card found a SECOND, independent bug surface: `prepareCanonicalEnv`
(`git/bounded.ts`) MATERIALIZES an explicit env — a `{...base}` copy of whatever base env it was given
(the caller's own `env` argument, or `process.env` for an otherwise env-less call) — whenever `GIT_CONFIG`
is present in that base (any casing). Before this follow-up, that materialize branch stripped only
`GIT_CONFIG` itself, then ran `scrubGitEnv` (editor/pager family only). So an AMBIENT `GIT_CONFIG` turned
an env-less `canonicalGit(repoPath, timeoutMs)` call into one with a real explicit env, arming simple-git's
`blockUnsafeOperationsPlugin` — and if `GIT_ASKPASS` (or any other `GIT_ENV_TRANSPORT_KEYS` member) was
ALSO ambient, every such call threw. `canonical-git-isolation.mjs`'s own `GIT_CONFIG`-casing block hit
exactly this at its env-less `config -z --list` read, which crashed as an unhandled rejection (no
surrounding `try`/`catch`) rather than failing a `check()`.

**`prepareCanonicalEnv` has TWO consumers, not one, and they need DIFFERENT treatment.** It is called by
`canonicalGit` (builds a real `SimpleGit` instance — the ONLY consumer `blockUnsafeOperationsPlugin` can
ever arm against), AND, separately, by the raw-spawn path (`rawViaDirectSpawn`/`rawViaWinJobLauncher`,
`git/bounded.ts:664`/`:752`, both reached via `spawnCanonicalGitTree` → `killableCanonicalRaw`) — a bare
`child_process.spawn()` that never touches simple-git at all, so the plugin never arms against it
regardless of what env it's given. A first version of this fix stripped `GIT_ENV_TRANSPORT_KEYS` inside
`prepareCanonicalEnv` itself, unconditionally on materialize — which fixed `canonicalGit` but ALSO silently
changed the raw-spawn path's env under the exact same ambient-`GIT_CONFIG` condition. That is a real
regression risk: `CANONICAL_GIT_CONFIG` disables merge drivers, not filters, so a canonical mutation
(`worktree add`, checkout) can still trigger an IMPLICIT fetch — an LFS smudge filter, a partial-clone
promisor fetch — that genuinely needs `GIT_ASKPASS`/`GIT_SSH_COMMAND` to succeed. (Neither the canonical
nor the raw-spawn path ever issues an EXPLICIT network verb — `push`/`fetch`/`clone` — itself; this implicit
case is why the raw-spawn path keeps its env regardless.)

**The fix, narrowed (Code Review round 2 of this follow-up):** `prepareCanonicalEnv` itself is UNCHANGED
from before this follow-up (strips only `GIT_CONFIG`, then `scrubGitEnv`) — byte-identical for the
raw-spawn path, in every case. `canonicalGit` ALONE now additionally strips `GIT_ENV_TRANSPORT_KEYS` from
whatever `prepareCanonicalEnv` returns, and ONLY when the caller itself passed no `env` (`env ===
undefined`) — i.e. only in the exact case where `prepareCanonicalEnv` just materialized a copy of ambient
`process.env` for what the caller intended to be an env-less call. An EXPLICIT caller env (even one that
happens to carry `GIT_CONFIG`) is left untouched and still refuses loudly under an ambient `GIT_ASKPASS` —
that stays the caller's own responsibility, exactly like every other explicit-env caller in this codebase
(`localNonInteractiveEnv()`/`localReadGitEnv()`).

`canonical-git-isolation.mjs`'s `GIT_CONFIG`-casing block, its "caller env" case in the earlier `MAJOR 2`
block, and its separate locale block (`(round 5)`, which forces a UTF-8 locale via its own `{...process.env}`
spread, unrelated to `GIT_CONFIG`) were all made hermetic: each now builds its explicit env via
`localReadGitEnv` instead of a raw `{...process.env}` spread, so none of them depends on whatever transport
var happens to be ambient on the host running the test (a vacuous pass otherwise: the call would refuse for
an unrelated reason and the assertion would pass regardless of whether the real fix works). The casing
block's env-less read is also wrapped in `try`/`catch` so a regression there is reported as a `FAIL`, never
an unhandled rejection that crashes the whole suite.

`test/git-askpass-explicit-env.mjs` gained three regression scenarios: (E) an env-less `canonicalGit(...)`
call succeeds under ambient `GIT_CONFIG` + `GIT_ASKPASS` (the bug this follow-up fixes); (F) an EXPLICIT env
carrying both still refuses (pins the narrow fix's boundary — this is what the first, too-broad fix shape
got wrong); (G) the raw-spawn path (`killableCanonicalRaw`) under the SAME ambient combination still
genuinely delivers `GIT_ASKPASS` to its child's own env, proven via a `-c alias` that shells out to a probe
script and writes what it actually saw to a marker file. (F) and (G) are RED against the first, too-broad
fix shape and GREEN against the narrowed one; (E) is RED against no fix at all and GREEN against either
shape — see that test file's own header comment for the full RED/GREEN matrix.

### Do not (follow-up)

- Do not strip `GIT_ENV_TRANSPORT_KEYS` inside `prepareCanonicalEnv` itself, even "just on materialize" —
  that function is shared by the raw-spawn path, which never arms `blockUnsafeOperationsPlugin` and may
  legitimately need the transport family for an implicit fetch during a canonical mutation. The strip
  belongs ONLY in `canonicalGit`'s own construction, gated on `env === undefined`.
- Do not gate the strip in `canonicalGit` on "is `GIT_CONFIG` present" instead of "did the caller pass no
  `env`" — that reintroduces the asymmetry Code Review round 2 rejected: an explicit env WITH `GIT_CONFIG`
  would silently lose its transport keys while one WITHOUT it keeps simple-git's loud refusal. Gate on
  `env === undefined`, full stop; an explicit env is always the caller's own responsibility.
- Do not strip `GIT_ENV_TRANSPORT_KEYS` only in the TEST, and leave `canonicalGit` itself unfixed — the
  test hermeticity fixes above are a SEPARATE belt-and-suspenders hardening, not a substitute for the
  production fix; the host ambient env is not something a worker/user can control.
- Do not add this strip inside `nonInteractiveEnv()`/`GIT_ENV_STRIP_KEYS`/`scrubGitEnv` — those are
  shared by `GitWriter.push()` (the main record's own exception) and must stay unaffected.
- Do not reintroduce a bare `{...process.env}` spread in a NEW `canonical-git-isolation.mjs` scenario
  that forces some OTHER ambient setting (a second locale pin, a config override, etc.) without routing it
  through `localReadGitEnv` first — any such scenario inherits this exact fragility to whatever transport
  var happens to be ambient on the host it runs on.
- Do not assume `killableCanonicalRaw`/`spawnCanonicalGitTree` are safe from THIS bug class just because
  they're immune to `blockUnsafeOperationsPlugin` (see the main record's own "structurally immune" section
  above, which is about THAT plugin specifically) — they still go through `prepareCanonicalEnv`, so any
  FUTURE change to that function's own `GIT_CONFIG`-materialize branch affects both consumers at once;
  re-verify scenario (G) (or add an equivalent) against any such change.

## Source

Card `a746a3eb`, discovered from Code Review `ff3eec9f` of card `7b59e981`. Follow-up from Code Review
`01e61841`, card `23c74c62` (round 1: too-broad strip inside `prepareCanonicalEnv`; round 2, same Code
Review: narrowed to `canonicalGit`'s own construction, gated on `env === undefined`).
