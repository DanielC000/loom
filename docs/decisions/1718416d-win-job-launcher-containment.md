# 1718416d — a Windows Job Object launcher closes the taskkill `/T` escape, with a mandatory fallback

## Narrative

`docs/decisions/b966962b-unconfirmed-kill-windows-msys-hook-guidance.md` established that an ordinary,
un-engineered `#!/bin/sh` git hook — not just a deliberately double-forked one — is reproducibly
unconfirmable on Windows: `taskkill /T /F` reports success and names the pids it killed, but the real
MSYS-forked descendant (`sh`, `sleep`, whatever the hook backgrounds) is never among them and survives.
Card `24c0bdba`'s own fail-closed quarantine exists precisely because this process cannot positively
confirm either way. This card asked: can the escape itself be closed, rather than only detected?

### STEP 0 — why `taskkill /T` loses the descendant, and why "just add a Job Object" isn't enough on its own

libuv's own Windows process code (`src/win/process.c`) creates ONE process-wide job
(`uv_global_job_handle_`) the first time a non-detached child is spawned, with
`JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_DIE_ON_UNHANDLED_EXCEPTION
| JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`, and assigns every such child to it. The comment states the intent
plainly: SILENT_BREAKAWAY_OK is there "so only explicitly added processes are affected, not their
children." Every canonical git call (`spawnCanonicalGitTree`, `detached:false` on win32) is therefore
already a member of this permissive job before any Loom code ever touches it.

Measured directly (19 real `git commit` trials, a fixture hook double-forking a `sleep 25` tail):
`AssignProcessToJobObject` against a FRESH job, called immediately after `spawn("git", …)` returns,
succeeded 17/19 — the 2/19 `ERROR_ACCESS_DENIED` failures are not explained by Windows' own documented
exception ("the job must be empty or in the process's existing job hierarchy" — ours was always empty)
and were never root-caused; they look like a timing-sensitive kernel race, not a policy violation. Worse:
in every ONE of 10 cleanly-scoped trials where the assign DID succeed, the direct chain (git.exe → its
immediate `sh.exe`) was reliably contained and killed, but the double-forked `sleep.exe` tail ESCAPED
every single time — `AssignProcessToJobObject` succeeding is not sufficient; libuv's own job, with its
own silent-breakaway permission, still governs what the deepest descendant inherits.

Two methodology findings from this pass, each costly enough to name: (1) MSYS's self-reported `$$` is
**not** the real Windows PID — `sh -c 'echo $$'` reported `1679` while the only live `sleep.exe` on the
host at that moment had real PID `26016`; any survivor check keyed off a hook's own `$$` output is
measuring nothing. (2) this host is shared and live — a bare image-name scan for `sh.exe`/`sleep.exe`
picked up an unrelated concurrent session's own `sh.exe "...pnpm" --filter @loom/daemon negative-control
... merge-quarantine.ts ...` process; a real survivor check must scope by `ParentProcessId` (reliable for
the direct git→sh edge per b966962b's own finding) or by time window, never by name alone.

### STEP 0b — create-suspended-then-assign closes it; a stdin-sharing hang almost sank the whole approach

Ruling, after STEP 0's measurement: assign-after-spawn is dead. The structurally correct shape is to
create git **suspended**, via a raw `CreateProcessW`, **outside** libuv's job entirely (Node never
spawns git directly — it spawns a tiny launcher, which spawns git itself), assign it to a fresh job
(`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` only — no breakaway flags), THEN resume it. Verified directly: 6/6
trials, `AssignProcessToJobObject` succeeded every time (no more racing libuv's own auto-assign),
`TerminateJobObject` + a bounded `ActiveProcesses==0` poll confirmed the WHOLE tree dead every time,
cross-checked against an independent, unscoped, system-wide `Win32_Process` sweep for `sh.exe`/`sleep.exe`
finding zero results.

Wiring this through Node (`spawn(launcherPath, args, {...})`, the exact shape `spawnCanonicalGitTree`
already uses) immediately hung — indefinitely, past 70+ seconds, until the launcher was force-killed. The
hang reproduced with the SIMPLEST possible hook (`sleep 1; exit 0`, no backgrounding at all), ruling out
the escape/containment question itself as the cause. Three plausible causes were tested and ruled out:
over-broad handle inheritance into the grandchild (rebuilt with an explicit `STARTUPINFOEX`/
`PROC_THREAD_ATTRIBUTE_HANDLE_LIST` naming only stdin/stdout/stderr — no change), a failed `ResumeThread`
(diagnostics showed it succeeding identically in both the working direct-invocation case and the hung
Node case), and the double-forked tail holding Node's own pipe open (redirecting the tail's stdio to
`/dev/null` in the hook made no difference, and was moot anyway since the hang reproduced with zero
backgrounding).

The actual cause, diagnosed by inspection rather than further guessing: the launcher's own abort-signal
design used a blocking, synchronous `ReadLine` on its OWN inherited **stdin** — the SAME underlying pipe
object git.exe also inherits. A pending synchronous `ReadFile` on a Windows pipe serializes every OTHER
I/O call on that file object, including the MSYS runtime's own startup-time `GetFileType`/
`NtQueryInformationFile` probes against stdin — so git blocked forever behind the launcher's own read, at
0% CPU. Fix: git's own stdin is `NUL` (`CreateFileW("NUL", ...)`), never the launcher's inherited stdin;
the abort channel moved entirely off stdin onto a named Win32 event, with the launcher's main loop doing
`WaitForMultipleObjects` on the git process handle and the event instead of a blocking stdin read. Re-run
through Node with the exact `spawnCanonicalGitTree` shape: 12/12 double-fork-hook normal completions, 10/10
double-fork-hook aborts (confirmed, zero survivors both ways), 5/5 simple-hook, 5/5 no-hook, 3/3
failing-hook (exit code + stderr matching bare git exactly) — all clean, no hang anywhere.

## Fix

- `packages/daemon/native/win-job-launcher/launcher.cs` — a small, self-contained Windows C# console app
  (no external dependencies), two modes selected by `argv[0]`:
  - `launcher.exe run <nonce> <git-args...>` — creates a job (`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` only),
    creates a nonce-derived named event (`Local\LoomWinJobAbort_<nonce>`) BEFORE spawning anything (a
    collision — `ERROR_ALREADY_EXISTS` — refuses the whole call, git is NEVER spawned), creates git
    `CREATE_SUSPENDED` with its own `NUL` stdin and inherited stdout/stderr via an explicit handle list,
    assigns it to the job, resumes it, then `WaitForMultipleObjects` on (git's process handle, the abort
    event). On natural exit, git's own real exit code passes through unmodified. On the event firing,
    `TerminateJobObject` + a bounded `ActiveProcesses==0` poll (5s, 200ms ticks — the same budget STEP 0b
    measured as reliable) decides CONFIRMED or UNCONFIRMED (see "round 2" below for the current exit-code
    values — moved out of 0-255 since this record was first written).
  - `launcher.exe --signal <nonce>` — opens the SAME nonce-derived event and sets it, then exits. Fast
    startup (no .NET JIT-heavy hosting, a tiny console app), reusing the one artifact rather than adding a
    second.
  - `launcher.exe --probe <nonce>` (round 2) — a pure existence check: opens the SAME event WITHOUT
    setting it, then exits 0 (exists) or 1 (doesn't). Exists so a test can wait for a real readiness
    signal instead of a fixed sleep.
  - The Windows command-line is rebuilt from the launcher's own `argv` using the documented
    `CommandLineToArgvW`-inverse quoting algorithm (backslash-run doubling before a quote or at an
    argument's end) — NOT the naive "wrap in quotes, escape embedded quotes" approach, which is wrong for
    exactly those two cases. Verified: a deliberate reversion to the naive algorithm turns
    `test/win-job-launcher-fidelity.mjs` red on precisely the backslash-adjacent cases it covers, and green
    again once reverted back.
- `packages/daemon/src/git/bounded.ts` — `spawnCanonicalGitTree`'s `raw()` dispatches to a NEW
  `rawViaWinJobLauncher` on win32 when `isWinJobLauncherAvailable()` (memoized `fs.existsSync` at a FIXED,
  package-relative path — never `LOOM_HOME`, never a `PATH` lookup), else to `rawViaDirectSpawn` — the
  pre-card code, extracted verbatim, unedited. POSIX is completely untouched. See `@decision 1718416d`
  anchors at both the dispatch site and `rawViaWinJobLauncher`'s own doc for the verdict-protocol detail.
- `packages/daemon/scripts/build-native-launcher.mjs` + `pnpm --filter @loom/daemon build:native` —
  compiles the launcher via the in-box .NET Framework `csc.exe` (verified present and working at
  `C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe` on a real Windows 11 host; NOT guaranteed
  elsewhere by this card, hence the existence check). Deliberately OUTSIDE the default `pnpm build`
  pipeline (owner ruling): a loud no-op on non-win32 or when `csc.exe` can't be found, never a hard
  dependency. Output lands at `packages/daemon/assets/native/win-job-launcher.exe` — inside the EXISTING,
  already-packaged `assets/` tree (no change needed to `scripts/build-npm-package.mjs`), but gitignored
  (`packages/daemon/assets/native/`) since it's a build artifact, never committed.
- Release distribution (owner ruling, ruled out a first-use-compile design explicitly for its NEW
  writable-path-exec trust surface): a `windows-latest` CI job builds the exe via the in-box **.NET
  Framework** `csc` (the SAME compiler `build-native-launcher.mjs` uses in dev — never the .NET SDK's own
  `csc`), load-smokes it (`scripts/smoke-win-job-launcher.mjs`, round 2: spawn, a confirmed abort, and
  git's own exit-code passthrough) before upload, and HARD-FAILS the release if any of that fails — never
  ships a `loomctl` silently missing the launcher.

## Verdict protocol (do not weaken)

The CONFIRMED exit code means "confirmed" ONLY when the Node-side call itself requested the abort (its
own `aborted` flag) — see "round 2" below for why git itself can no longer collide with that value at
all. Any other code while aborted (a natural exit that merely raced the abort, the launcher dying some
other way) is `markUnconfirmedKill` — fail closed, exactly like today's taskkill path. A launcher-side
refusal (event-name collision, `CreateProcessW`/job-setup failure) means git was NEVER spawned: the call
transparently falls back to the direct-spawn path for itself only, logged once per occurrence — never
permanently disabling the launcher for later calls (round 2, MAJOR 3 extends this same posture to a REAL
spawn error against the launcher itself, which DOES flip the memoized availability for later calls —
see below).

### Round 2 (Code Review 7bba383c) — exit codes, refusal/spawn-error handling, test coverage

Four MAJOR fixes, applied after a review of round 1 (commit `60a4564b`/`153c8bb6`):

1. **`SetInformationJobObject`/`AssignProcessToJobObject`'s results were ignored.** An assign failure
   left git resumed OUTSIDE the job — a later abort's `ActiveProcesses==0` would read true (the job was
   always empty) and wrongly report CONFIRMED while git's real tree stayed alive. Both results are now
   checked; on failure the (still-suspended, so zero-instruction) git is `TerminateProcess`'d and the
   call refuses rather than resuming an uncontained child. `WaitForMultipleObjects`'s `WAIT_FAILED` is
   now handled too (it previously fell through to an infinite spin), and `GetExitCodeProcess`'s own
   return is checked before trusting its output.
2. **Every launcher-originated exit code moved out of 0-255** (git's own exit-code range) into distinct
   32-bit values — `0x4C4F0001` (CONFIRMED), `0x4C4F0002` (UNCONFIRMED), `0x4C4F0003` (REFUSED, collapsing
   the former 216/250/251 refusal reasons into one, since the caller only ever needed "fall back for this
   call"). All three are well under `Int32.MaxValue`, so a Windows DWORD exit code never arrives
   sign-flipped to Node. Before this, a git that itself happened to exit 214/215/216/250 was
   indistinguishable from a launcher verdict.
3. **A real launcher SPAWN error** (exe present per `isWinJobLauncherAvailable()` but blocked — Smart App
   Control, AppLocker/WDAC, antivirus, or a corrupt binary — or git never spawned once
   `CreateProcessW`/job setup failed) now falls back to the direct-spawn path for THAT call (git never ran
   either way) and flips the memoized availability to `false` so later calls skip straight to the
   fallback instead of repeatedly re-attempting a spawn already shown to fail. Previously this rejected
   the call outright, as if git itself had failed.
4. **`win-job-launcher-spawn.mjs`'s survivor check scanned the WHOLE HOST by image name** (false-FAIL
   AND false-PASS prone on this shared, live host). It now scopes to THIS call's own real Win32 pids: the
   hook reports its own and the double-forked tail's MSYS pid to a file, resolved via
   `/proc/<msys-pid>/winpid`.

Minor fixes: a missed/failed `--signal` now kills the main launcher process directly rather than doing
nothing (its job handle closing on exit still contains the whole tree, reported UNCONFIRMED); a new
`--probe` mode (see above) replaces a fixed 150ms head start in `win-job-launcher-event-collision.mjs`
with a real readiness wait; `win-job-launcher-fallback.mjs`'s deliberately-uncontainable `sleep 25` is
now cleaned up by its own real pid at the end; the release smoke moved from inline PowerShell to
`scripts/smoke-win-job-launcher.mjs` (a PowerShell `Start-Process` object needs its own `.Handle` read
before `.ExitCode` can be trusted, which the old step didn't do; a plain Node `ChildProcess` has no such
gotcha); new `win-job-launcher-fallback-branches.mjs` adds Node-level coverage (no `build:native` needed)
for the refusal-code fallback, the aborted-but-not-confirmed branch, and a real spawn error against a
genuine non-executable file.

**Two further defects were found only by actually RUNNING these fixes against the real binary** (neither
was visible from code review alone — both are a reason to distrust a simulated `spawnImpl` test as the
sole verification for anything touching real OS process semantics):

- **POSIX `$$` does not change inside a `( ... )` subshell under bash** (confirmed Git for Windows' own
  `sh.exe` is bash) — it is defined as the pid of the INVOKING shell, not the actual forked descendant.
  `win-job-launcher-spawn.mjs`'s own pid-reporting hook used `$$` inside the double-forked tail's
  subshell, so its "tail" pid file silently recorded the SAME pid as the direct child's — the checks
  "passed" by checking one real process twice, never actually observing the double-forked descendant
  this whole card exists to contain. `$BASHPID` correctly tracks each subshell's own real pid (verified:
  outer=819, one level deep=820, two levels deep=821, in a throwaway repro) and is what the hook now uses.
  The test now also asserts the two resolved pids differ, so this exact class of bug can't silently
  recur.
- **`spawn()` can throw SYNCHRONOUSLY on Windows for a bad-executable-format target**, instead of
  returning a child that later emits an async `"error"` event — observed directly against a genuine
  non-executable file standing in for the launcher path. `rawViaWinJobLauncher`'s `child.on("error", ...)`
  handler (MAJOR 3) was therefore never reached in this case — there was no `child` yet to attach it to —
  and the throw escaped as an outright rejection of the whole call, skipping the fallback entirely. Fixed
  by wrapping the spawn call itself in `try/catch` and routing a synchronous throw through the identical
  fallback + availability-flip path as the async handler.

## Do not

- Do not infer "confirmed" from seeing the CONFIRMED exit code alone — gate it on this call's own
  `aborted` flag (see `rawViaWinJobLauncher`'s own doc in `git/bounded.ts`).
- Do not share the launcher's own stdin with git's — this is the exact mechanism that hung every Node-
  spawned call in STEP 0b, reproducing with zero backgrounding. Any future abort-channel redesign must
  stay off stdin (and off any handle git itself inherits) entirely.
- Do not route the abort signal back through a slow-starting host process (PowerShell's `Add-Type`/JIT
  cost — measured 300-500ms+ per invocation — made an early signaler design miss the hook's own ~1s
  window entirely). The `--signal` mode exists specifically because it needs to be fast.
- Do not set `JOB_OBJECT_LIMIT_BREAKAWAY_OK`/`SILENT_BREAKAWAY_OK` on the launcher's own job "to match
  libuv" — the whole point is that this job is STRICTER than libuv's; STEP 0 measured that the escape
  happens regardless of this job's own flags, so there is nothing to gain and a real containment property
  to lose.
- Do not assume `csc.exe`'s presence is guaranteed off this card's own verification — it was confirmed
  present and working on ONE real host; `build:native`'s existence check (and its loud no-op) is the
  actual safety net, not an assumption.
- Do not resolve git via an absolute, build-time-baked path inside the launcher — a bare `"git.exe"` token
  with `lpApplicationName=null` is resolved via `CreateProcessW`'s own documented search sequence
  (ending in `PATH`), using the SAME `PATH` Node already passed the launcher — this is what keeps the
  resolved binary identical to today's bare `spawn("git", …)`.
- Do not assume a historical repro test (`merge-commit-kill-confirm.mjs` scenario 5,
  `git-writer-kill-confirm.mjs`, `union-merge-kill-confirm.mjs`'s GREEN 2) still produces an unconfirmed
  kill once this launcher is built — it doesn't; that's the fix working. Each of those forces the
  pre-card taskkill path for its own scenario via `setWinJobLauncherOverrideForTest(null)`, restored
  with `setWinJobLauncherOverrideForTest(undefined)` in `finally`, so they keep testing what they were
  written to test regardless of whether a given host has the launcher built.
- Do not rename/unlink/overwrite the REAL `win-job-launcher.exe` from a test to force the fallback —
  that file backs the self-hosting daemon live from this SAME canonical checkout's package path; the
  merge gate runs test files concurrently (a parallel lane silently loses it mid-run); and a gate-timeout
  SIGKILL skips both `try/finally` and a `process.on("exit")` hook, leaving it permanently renamed with
  the daemon silently on the fallback forever. Use `setWinJobLauncherOverrideForTest` (`git/bounded.ts`)
  instead — `null` forces unavailable, a path forces that specific exe, `undefined` clears it. Every test
  that uses it asserts, at the end, that the real exe's existence and content hash are unchanged.
- Do not use a synchronous process-listing call (`execFileSync`, or an unfiltered `tasklist`) inside a
  tight concurrent poll loop in a test — it blocks the whole event loop per tick (measured: this silently
  starved `win-job-launcher-spawn.mjs`'s own poll to zero candidates every run) and, separately, an
  UNFILTERED `tasklist` on a busy host was measured at 1-2.4s per call vs. a `/FI`-filtered call at a
  steady ~270-285ms — use async `execFile`, filtered, run concurrently per image name.
- Do not guard a negative assertion ("zero survivors") with a fixed sleep — `treeDeathConfirmed(e)`
  becoming true on the awaited call IS the observable event (the launcher's own internal confirmation
  already happened, synchronously, before it rejected); there is nothing left to wait for. Caught directly
  by `fixed-wait-negative-guard.mjs` during this card's own build.

## Residuals (accepted)

- The 2/19 intermittent `ERROR_ACCESS_DENIED` on assign-after-spawn (STEP 0) is moot for the SHIPPED
  design (create-suspended-then-assign never races libuv's own auto-assign at all — 0/6 in STEP 0b), but
  the root cause of that specific failure was never identified. Not a risk to the current design; noted
  for completeness only.
- `csc.exe`'s presence is verified on one host, not broadly surveyed; Microsoft's own docs state .NET
  Framework ships in-box on all current Windows 10/11 releases, but no official source was found
  separately guaranteeing `csc.exe` ships with every such install. `build:native`'s existence check +
  loud no-op is the actual mitigation.
- A Job Object assign/suspend sequence this specific has not been tested on Windows builds older than
  the one used for this investigation, nor against non-Git-for-Windows MSYS distributions.

## Source

Card `1718416d`. Prior investigation (worker `b4502732`, no code — see the card's own 2026-10-09T16:07
triage note) first measured a real double-forked `sh` + `sleep.exe` job showing `ActiveProcesses=2` and
`TerminateJobObject` leaving zero survivors, and that a baseline `taskkill /T` missed `sleep.exe` 1 time in
6 — the finding that chartered this card. STEP 0/0b (this record's own Narrative) is the investigation that
followed: the libuv-job/silent-breakaway mechanism, the create-suspended-then-assign fix, and the stdin-
sharing hang + its fix. Tests: `test/win-job-launcher-spawn.mjs` (the real-spawn matrix through the real
`git/bounded.ts` integration), `test/win-job-launcher-fidelity.mjs` (argv/env/cwd fidelity against bare
git, with a verified negative control), `test/win-job-launcher-fallback.mjs` (launcher forced unavailable
⇒ the pre-card taskkill/quarantine path, unchanged), `test/win-job-launcher-event-collision.mjs` (the
nonce-collision refusal), plus the three existing kill-confirm tests updated to force the pre-card path for
their own now-fixed scenario (see "Do not" above).
