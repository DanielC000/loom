
# 5b50eede — the win-job-launcher (and its direct-spawn fallback) run git via an absolute, PATH-only path

Found during Code Review `7bba383c` of `1718416d`. That record's "Do not" justified a bare `"git.exe"`
token (`lpApplicationName=null`) with "the SAME PATH Node already passed the launcher — keeps the
resolved binary identical to bare `spawn("git", …)`." FALSE: `CreateProcessW`'s documented bare-name
search is (1) the launcher's OWN directory, (2) cwd, (3) system dirs, (4) PATH; libuv's own
`search_path()` (what Node's bare `spawn("git")` uses) only ever checks (1) cwd, (2) PATH. The
launcher's-own-directory stage has no analogue in Node's resolution and is attacker-reachable
(`assets/native/` is writable by anything that can write into the daemon's install tree).

## Round 1

**Empirically verified (Windows 11, Git for Windows 2.47.0):** a non-executable `git.exe` planted BESIDE
the launcher's own copy, against the UNFIXED launcher invoked directly, returned `0x4C4F0003`
(`EXIT_REFUSED`) instead of real git. Fixed: git resolved ONCE per call (then via `resolveExecutable()`,
`pty/resolve-bin.ts`) to an absolute `.exe`, threaded as a new launcher argv slot AND as
`rawViaDirectSpawn`'s own spawn target (point 3); `launcher.cs`'s `IsAbsoluteGitExePath` refuses anything
non-drive/UNC-rooted via the EXISTING `EXIT_REFUSED` code; `lpApplicationName` set to that path (was `null`).

⚠️ **Round 1's record originally claimed the SAME planted file in the cwd "did not reproduce on this
host" and called cwd-hardening merely "accepted defense-in-depth."** That claim is WRONG, corrected by
round 2 below — a different, real cwd-reachable hijack existed in round 1's own fix the whole time; it
was simply never tested for.

## Round 2 (CR `792785cb`) — a relative PATH entry is a confirmed, different cwd-reachable hijack

Round 1 resolved git via `resolveExecutable()` (the generic PATH+PATHEXT walker, also used by the
claude/node-pty spawn recipe), filtered only by `result !== "git" && /\.exe$/.test(result)`. That walker
does **not** require a PATH entry to be absolute: a relative entry (`"bin"`, `"."`, or a current-drive-
relative `"\tools"`) still gets `fs.existsSync`-checked (against the CALLING PROCESS's cwd) and, on a hit,
returns a **relative string** — which round 1's own filter accepted as "resolved." `rawViaDirectSpawn`
then spawns it with `cwd: repoPath` — Node resolves it RELATIVE TO THE WORKTREE: a `bin\git.exe` planted
INSIDE a repo is executed. **Confirmed: `PATH="bin"` + `bin/git.exe` planted relative to the daemon's own
cwd ⇒ round 1's resolver returned `"bin\\git.EXE"`** — exactly the hijack round 1's text said hadn't
reproduced.

## Fix (round 2)

- A DEDICATED walker, `resolveAbsoluteGitExePath()` (`git/bounded.ts`) — never `resolveExecutable()`,
  left untouched (it also feeds the claude spawn recipe; not this card's blast radius to widen). It SKIPS
  any PATH entry failing `isAbsoluteWindowsExePath` (drive-rooted or UNC ONLY — never `path.isAbsolute`,
  which is also `true` for `"\foo"`, the SAME predicate `launcher.cs` already used), and inside a
  qualifying entry tests ONLY `<dir>\git.exe` — never PATHEXT order, so an earlier `git.cmd` can never
  mask a later real `git.exe`. Resolution is retried on every call, nothing cached beyond one call's walk.
- Re-checked against the SAME predicate at the USE site too (`spawnCanonicalGitTree`'s `raw()`), on BOTH
  the launcher argv and the direct-spawn target — never trust the walker alone.
- `scripts/smoke-win-job-launcher.mjs` (the release-CI gate, standalone — can't import bounded.ts's
  compiled output) duplicates the SAME two rules rather than a looser copy.
- Log wording fixed: "skipped for THIS call … resolution is retried on every call" (was worded as if
  permanently skipped for the rest of the process, which it never was).

## Round 3 (card `cf9a32cf`) — the simple-git-based canonical calls were still a bare `"git"`

Rounds 1-2 only closed the hazard for `spawnCanonicalGitTree`'s two raw-spawn paths
(`rawViaWinJobLauncher`/`rawViaDirectSpawn`) — the ones `killableCanonicalRaw` reaches. But every
NON-killable canonical call (ordinary reads/writes through `canonicalGit(...).raw(...)`, which runs on
simple-git's own spawn, not `spawnCanonicalGitTree`) still constructed `boundedSimpleGit` with no binary
override, so simple-git resolved a bare `"git"` through Node's own PATH search — the identical
cwd/PATH-entry hijack surface rounds 1-2 closed for the other half of the canonical path.

**Fix:** `canonicalGit` resolves the SAME `resolveAbsoluteGitExePath()` on win32 (never a second resolver)
and threads the result into `boundedSimpleGit`'s new optional `binary` parameter; unresolved stays
`undefined`, giving simple-git's own default `"git"` — identical to today. POSIX never calls the resolver
(binary stays `undefined`, byte-identical).

**simple-git validates (and this card had to work around it):** `customBinaryPlugin`'s `isBadArgument`
regex (`/^([a-z]:)?([a-z0-9/.\\_~-]+)$/i`) rejects any character outside that class — a space included.
A real installed git on Windows commonly resolves to `C:\Program Files\Git\cmd\git.exe` (verified on the
dev host via `where git`), which fails that regex on the space in "Program Files" alone. Left unaddressed,
passing that path as `binary` would THROW `GitPluginError` at construction (the plugin's default
`allowUnsafe=false`) instead of silently falling back — worse than the pre-fix bare `"git"`, not better.
`boundedSimpleGit` auto-sets `unsafe.allowUnsafeCustomBinary: true` whenever `binary` is supplied: the
value itself is never caller-supplied free text, only ever the resolver's own drive/UNC-rooted,
`fs.existsSync`-checked result, so bypassing simple-git's generic string-shape check here is the same
defense-in-depth posture as round 2's own site-level re-check, not a widening of what can reach `binary`.
Checked once with `GitExecutorChain`'s real spawn call (`child_process.spawn(command, args, spawnOptions)`,
no `shell: true`): a space in `command` needs no shell-quoting at all on this path, so the regex rejection
is simple-git's OWN conservatism, not a real spawn hazard.

**Test trap avoided:** a planted `git.exe` in the canonical repo's own cwd must be asserted against the
binary simple-git was actually CONFIGURED with (`git.raw` doesn't expose the resolved spawn target
directly — assert via a `gitFactory`/spawn-impl seam, or on `resolveAbsoluteGitExePath`'s own return
value plus `isAbsoluteWindowsExePath`), never merely that some git ran successfully — a resilient
fallback absorbing a hijack would still "pass" a test that only checks the command's exit status.
`git._executor._plugins.exec("spawn.binary", "", { method: "", commands: [] })` reads back the exact
configured binary without spawning anything — the SAME internal hook `GitExecutorChain.attemptRemoteTask`
itself calls before every real spawn, verified directly against the live library at `node_modules/
.pnpm/simple-git@3.36.0/.../dist/cjs/index.js`.

**Residual noise, filtered (round 3, CR `18aac4c9`):** `customBinaryPlugin`'s `toBinaryConfig` still
`console.warn`s on a regex-failing `binary` even with `allowUnsafeCustomBinary` set — the warn and the
throw are gated by the SAME flag, but the warn fires either way. Left alone, that would print "Invalid
value supplied for custom binary…" on every single canonical git call on an ordinary Windows install (the
common case — the self-hosting daemon itself runs on Windows), reading as a real problem when it is the
expected, benign echo of our own deliberate opt-in. `boundedSimpleGit` wraps `console.warn` around the
synchronous `simpleGit(...)` construction call ONLY, and ONLY when `binary` is supplied, dropping ONLY a
message containing `SIMPLE_GIT_CUSTOM_BINARY_WARNING` (a substring of simple-git's own `WRONG_CHARS_ERR`)
— anything else still reaches the real `console.warn` unchanged, so an unrelated future
construction-time warning (from simple-git or anything else) is never swallowed. The window has no
`await` in it, so nothing else in the (single-threaded) process can log through the swapped reference
before it's restored.

## Round 4 (card `b5416a46`, Code Review `18aac4c9` of round 3) — one chokepoint, not a per-caller opt-in

Round 3 made `canonicalGit` resolve-and-pass `binary` to `boundedSimpleGit` itself — an opt-in every
OTHER `boundedSimpleGit` caller (`GitWriter`, `GitReader`, `runs/snapshot.ts`, `setup/bootstrap.ts`,
`sessions/service.ts`, `orchestration/restart.ts`, `vault/versioner.ts`'s ordinary-vault construction)
had to remember and didn't — each still constructed with no `binary`, so simple-git resolved a bare
`"git"` for every one of them on win32. Separately, a repo-wide re-grep (never trust the card's own
caller list as a fence) found two more bare `spawn("git", [...CANONICAL_GIT_CONFIG_ARGS, ...])` sites on
the canonical merge path itself (`git/worktrees.ts`'s `repoTreeHasJsTsSourceFile`/
`repoTreeReferencesInertPrefix`, cwd: the canonical repo) plus several raw `execFileSync`/`spawn("git", …)`
sites off it (`deploy-staleness.ts`, `skills/assets-git-status.ts`, `mcp/decisions.ts`,
`vault/versioner.ts`'s `flushSync`).

**Fix:** `resolveWin32GitBinary()` (`git/bounded.ts`) is now the ONE resolver every path funnels through.
`boundedSimpleGit` calls it ITSELF, unconditionally, when its caller doesn't pass an explicit `binary`
override — so every simple-git-based caller gets the resolved absolute git.exe automatically, with no
opt-in. `canonicalGit` no longer resolves or passes `binary` at all (double-resolution removed); it
relies on `boundedSimpleGit`'s own auto-resolution, byte-identical outcome. `spawnCanonicalGitTree`'s
`raw()` closure now calls the same shared resolver instead of its own duplicated resolve-and-re-check
lines. For a raw child-process spawn that cannot go through simple-git, `resolveGitBinaryForSpawn()` (the
same resolve-or-fall-back-to-bare-`"git"` rule, as a ready-to-spawn string) replaces every literal `"git"`
command argument across the daemon.

Unresolved still falls back to the literal `"git"` everywhere, exactly as before this card; POSIX never
calls either resolver (both return the POSIX/unresolved-win32 value unconditionally).

## Do not

- Do not revert to bare `"git.exe"`/`null` `lpApplicationName` "to match bare spawn" — the two search
  orders are genuinely different; that was round 1's defect.
- Do not reuse `resolveExecutable()`'s raw result for git with only an `.exe$` filter — a relative-PATH-
  entry hit is real and reproducible (round 2 above); the drive/UNC absoluteness check is load-bearing.
- Do not use `path.isAbsolute` as that check, here OR in `launcher.cs` — `true` for a current-drive-
  relative `"\foo"`, not what "absolute" means for this card.
- Do not fail an ordinary merge when git can't be resolved — skip the launcher for that call and let
  direct-spawn's literal `"git"` fallback run, exactly as before this card.
- Do not test a launcher-level hijack via `killableCanonicalRaw` — its resilient fallback-to-direct-spawn
  silently absorbs a launcher refusal; test the launcher directly (its own exit code).
- Do not assert a cwd-reachable hijack "didn't reproduce" without checking every path a resolved value
  travels through afterward (here: `rawViaDirectSpawn`'s `cwd: repoPath`) — round 1's "accepted
  defense-in-depth" framing was exactly the trap: a real exploit existed the whole time, via a different
  resolver defect than the one round 1 tested for.
- Do not write a second absolute-git resolver for simple-git calls — `canonicalGit` (round 3) reuses
  `resolveAbsoluteGitExePath()` verbatim; a second copy is exactly how the two paths drift again.
- Do not pass a resolved absolute path as simple-git's `binary` option without also setting
  `unsafe.allowUnsafeCustomBinary` — simple-git's own regex throws on the space in a real
  `C:\Program Files\...` install path, turning a silent hazard into a loud construction-time crash.
- Do not widen `allowUnsafeCustomBinary` to any OTHER `boundedSimpleGit` caller's `extraUnsafe` — it is
  derived automatically and only from `binary` being set, never passed in free-form by a caller.
- Do not widen the `console.warn` filter beyond the single synchronous `simpleGit(...)` construction call
  (no `await` inside that window, and it must stay that way) or beyond matching
  `SIMPLE_GIT_CUSTOM_BINARY_WARNING` specifically — a blanket no-op swallows every OTHER future
  construction-time warning too, not just the one this card knows is benign.
- Do not let `canonicalGit`'s returned instance forward a real `.customBinary(` call (CR `18aac4c9`) —
  the win32+resolved case's `allowUnsafeCustomBinary: true` is scoped at construction to OUR OWN resolved
  path, but `customBinaryPlugin`'s `allowUnsafe` flag is captured once and reused for every LATER
  `.customBinary()` call too; forwarding it would let any future caller silently swap in an unvalidated
  binary on an already-constructed canonical instance. The Proxy refuses it outright instead (nothing
  calls it today — grep-confirmed); if a genuine need ever appears, construct a fresh `canonicalGit(...)`
  with a different resolved binary rather than mutating an existing instance.
- Do not require a `boundedSimpleGit` caller to resolve-and-pass `binary` itself (round 4) — that's
  exactly the per-caller opt-in that left every non-`canonicalGit` caller on a bare `"git"`. Let
  `boundedSimpleGit`'s own auto-resolution handle it; pass `binary` explicitly only to pin a specific
  value (a test seam).
- Do not hand-roll a literal `"git"` as a raw child-process command argument anywhere in the daemon
  (round 4) — call `resolveGitBinaryForSpawn()` (`git/bounded.ts`) instead. `canonical-git-helper-guard.
  mjs`'s global check (widened by Code Review `201f0c7e`) catches this CALLEE-AGNOSTICALLY for the
  array-argument shape (`fn("git", [...])`, whatever `fn` is named or aliased to) and for the
  shell-string shape SPECIFICALLY when spawned via `exec`/`execSync` by those exact names
  (`execSync("git ...")`) — it does NOT catch a RENAMED/aliased `exec`/`execSync` import, nor a command
  built as a variable/template-literal/`cmd /c git ...` shape; see that guard's own header for the full,
  honestly-named gap list. Never read "the guard is green" as "no bare-git-literal risk remains."

## Source

Card `5b50eede`; round 2 found in Code Review `792785cb`. Tests:
`test/win-job-launcher-absolute-git-path.mjs` (round 1: launcher refusal + real hijack resistance; round 2
§4: `isAbsoluteWindowsExePath` unit checks, a relative-PATH-entry + planted-file case proven to resolve
pre-fix and `null` post-fix, a `"."` entry, a `git.cmd`-before-`git.exe` PATH); `-fidelity.mjs` /
`-event-collision.mjs` (round 1 argv shape); `-fallback-branches.mjs` (round 1: `makeFakeSpawn`'s fixed
`cmd === "git"` match broke once the fallback target became a resolved path, fixed to discriminate
"anything that isn't the launcher path"); `scripts/smoke-win-job-launcher.mjs` (both rounds).
