
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

## Source

Card `5b50eede`; round 2 found in Code Review `792785cb`. Tests:
`test/win-job-launcher-absolute-git-path.mjs` (round 1: launcher refusal + real hijack resistance; round 2
§4: `isAbsoluteWindowsExePath` unit checks, a relative-PATH-entry + planted-file case proven to resolve
pre-fix and `null` post-fix, a `"."` entry, a `git.cmd`-before-`git.exe` PATH); `-fidelity.mjs` /
`-event-collision.mjs` (round 1 argv shape); `-fallback-branches.mjs` (round 1: `makeFakeSpawn`'s fixed
`cmd === "git"` match broke once the fallback target became a resolved path, fixed to discriminate
"anything that isn't the launcher path"); `scripts/smoke-win-job-launcher.mjs` (both rounds).
