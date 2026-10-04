# 347b3584 — graceful teardown gets an off-main-thread hard-exit backstop

## Incident

2026-10-03/04: the owner had to restart Loom by hand because it "seemed stuck." The daemon log shows
`gracefulShutdown` ran (a clean SIGNAL stop marker, matching an OS SIGINT/SIGTERM/SIGHUP), logged
`[shutdown] snapshotted 12 live transcript(s)`, and then nothing — no `[shutdown] graceful stop (...)`
line, no exit — for ~4h23m, until the owner manually restarted the process.

## Elimination evidence (why the fix is a generic backstop, not a point fix)

`runGracefulTeardown`'s try/catch only ever caught a synchronous THROW inside `teardown()`, never a
BLOCK — so if any step inside `teardown()` hangs, `waitFn().finally(exit)` (the merge-danger-aware exit,
card 5a7692a4) never runs at all; the entire bounded-grace mechanism is bypassed by construction.

Read every step inside the real `teardown()` body and ruled most of them out directly, not probabilistically:
- `writeShutdownMarker` and `sessions.snapshotAllLive()` both completed — the snapshot's own log line printed.
- `CodescapeSupervisor.stop()`: clears two timers and calls `child.kill()` (async, no wait) — non-blocking.
- `CompanionController.stop()`'s call site: `return this.enqueue(() => this.teardownAll())` returns a
  Promise immediately without blocking, and is called as `void ...stop().catch()` — never awaited anyway.
- All 16 inline watcher `.stop()` calls (scheduler, rateLimitWatcher, usageStatus, updateCheck, wakes,
  polls, eventTriggers, contextWatcher, idleWatcher, busyWorkerWatcher, worktreeVanishedWatcher,
  resumeDocWatcher, usageSampler, crashRecoveryWatcher, dbBackupWatcher, vaultPushStatusWatcher): every
  single body is exactly `if (this.timer) { clearInterval/clearTimeout(this.timer); this.timer = null; }`.

The card's own prime hypothesis — `VaultVersioner.flushSync()`'s `execFileSync` calls hanging because a
grandchild process (a git hook, fsmonitor, credential helper) inherits and holds the stdio pipe open past
the configured `timeout` — was directly tested and REFUTED: reusing this repo's own
`packages/daemon/test/fixtures/_late-close-parent.mjs`/`_late-close-grandchild.mjs` fixtures (built for
card e26f3199's proof that the ASYNC `spawn`+`'close'`-event path hangs on exactly this shape), a direct
`execFileSync(parent, {timeout: 1000})` against a grandchild holding the stdout pipe open for 4000ms
returned `ETIMEDOUT` at ~1000-1013ms, 3/3 trials, on this real Windows host (Node v22.16.0) — the SYNC
`timeout` option correctly bounds the call even under the grandchild-holds-the-pipe shape that hangs the
async path. A companion run with no `timeout` set confirmed the pipe genuinely was held open (returned
only at ~3134ms, matching the grandchild's own 3000ms life) — the blocking mechanism is real, the SYNC
timeout option just isn't vulnerable to it. Separately, `VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS` (5 min) caps
each flush call's worst case at ~10 minutes per vault (two 5-minute calls plus a 15s status check) — this
owner's real vault layout is one shared root, so no plausible vault count stretches that to 4+ hours even
granting some other, untested grandchild shape defeats the sync timeout.

By elimination, the one completely UNBOUNDED step anywhere in the sequence is `console.log`/`console.warn`
itself — a synchronous write to a non-TTY (redirected/piped) stream with no timeout anywhere — plausibly
coinciding with the host sleeping across the observed 21:17Z→01:40Z gap, a known trigger for a blocked
Windows synchronous pipe write to hang for the sleep's own duration. This was NOT reproduced (would need a
stalled pipe or a real sleep/resume cycle) and is reported as the structurally-supported remainder, not a
confirmed mechanism.

## Round 2 (Code Review e222dbaa, 2026-10-04)

Round 1 shipped ONE flat deadline (`hardExitMs`, default 60s) for the whole teardown. Code Review caught
that this silently overrode decision `816f0056`'s deliberate multi-minute vault-flush bound: a healthy
`flushVaultsAndStopCodescape` step still legitimately running `git add`/`git commit` past 60s would be
`TerminateProcess`'d mid-write by THIS watchdog — a silently dropped commit (and a possibly stale
`.git/index.lock`) caused by the very backstop meant to prevent data loss from a hang, not a hang itself.

Fix: `step(name, budgetMs?)` now rewrites an ABSOLUTE deadline (a `BigInt64` epoch-ms slot in the shared
buffer, since Int32 overflows) and `Atomics.notify`s the watchdog worker, which re-derives "remaining"
from the CURRENT deadline on every wake rather than waiting once against a value captured at arm time.
The `flushVaultsAndStopCodescape` step's own budget is `computeFlushVaultsStepBudgetMs` (graceful-teardown.ts):
`versionerCount * (VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS * 2 + VAULT_GIT_OP_TIMEOUT_MS) + margin`, importing
both constants from `vault/versioner.ts` (now exported) rather than copying either number — one `git add`
plus one `git commit` at `VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS` each, plus one `git status --porcelain` at
`VAULT_GIT_OP_TIMEOUT_MS`, per vault, run serially. Every other step keeps the 60s default.

Also round 2: a fired watchdog now persists `{firedAt, step, intendedExitCode, label}` to
`LOOM_HOME/logs/shutdown-watchdog.json` (via `fs.writeSync` on an explicitly opened fd — never fd 2/stderr)
BEFORE the kill, since the `[shutdown] HARD BACKSTOP ...` stderr line may never be observed (a detached
supervisor, a closed terminal). `reportAndConsumeHardShutdownWatchdogRecord()` reports it loudly exactly
once on the NEXT boot, then renames it aside (never deletes — kept for forensics). And the win32 kill path
no longer short-circuits: it now ALWAYS falls through to a direct `process.kill(pid, "SIGKILL")` after the
PowerShell `TerminateProcess` attempt, win or lose — a PowerShell script exiting 0 does not prove
`TerminateProcess` actually ran (`OpenProcess` can silently return a null handle), so the old
`killedWithCustomCode` short-circuit could skip the SIGKILL backstop on exactly the case it exists for.

## Round 3 (delta Code Review 91ef0b45, 2026-10-04)

Round 2's per-step-budget test could not actually detect a missing wake-up: its upper-bound assertion
(`elapsedMs < surviveBlockMs + longBudgetMs`) was loose enough that even a COMPLETELY MISSING `step()`
notify would still pass, because a step with no override falls back to the stale LONG deadline from the
prior override and dies near `longBudgetMs` — comfortably inside that bound. Fixed by tightening the
upper-bound check to `surviveBlockMs + defaultHardExitMs + a generous-but-tight slack`, with `longBudgetMs`
raised to keep a wide separation between the two — confirmed by deleting the compiled watchdog's
generation-bump/notify call in `dist/graceful-teardown.js` and re-running the test: the per-step-budget
checks go RED (the process survives to ~`longBudgetMs`, past the tightened bound) with the notify present
restored, GREEN again.

Separately, a genuine (if narrow) lost-wakeup race existed in the waiting mechanism itself: the watchdog
worker waited on the DONE-flag index, which only ever changes at `disarm()`. A `step()` call landing
between the worker reading the current deadline and actually entering `Atomics.wait` had its `notify`
delivered to nobody (the worker hadn't called `Atomics.wait` yet), so the worker slept against the STALE
deadline it had already read — potentially minutes long — even though `step()` had just replaced it with a
much shorter one, killing the process LATE instead of promptly. Fixed with an `Int32` GENERATION counter
in the shared buffer (`HEADER_GEN_INDEX`): `step()`/`disarm()` now increment it and `Atomics.notify` on
THAT index, and the worker waits via `Atomics.wait(header, HEADER_GEN_INDEX, observedGen, remaining)` — an
atomic compare-and-block, so a generation bump that already happened before the worker's wait call makes
that call return immediately instead of blocking on the stale value. The header grew from 2 Int32 slots to
4 (DONE, step-name-length, GENERATION, reserved/padding — the 4th exists only to keep the BigInt64 deadline
8-byte aligned). A dedicated, deterministic reproduction of the exact race window was not attempted (it is
a few-microsecond ordering race, impractical to force hermetically without injecting test-only delays into
production code) — the fix is verified by code-review-grade reasoning about the atomic compare-and-block
semantics plus a full regression run of every existing sync-hang/clean/per-step-budget/structural check in
`graceful-teardown-hard-exit-backstop.mjs`, all unaffected.

The `flushVaultsAndStopCodescape` step's own derived budget (`computeFlushVaultsStepBudgetMs`) under-counted
by a full `VAULT_GIT_OP_TIMEOUT_MS` (15s) per vault: `VaultVersioner.flushSync()` also calls
`hasConfiguredGitIdentitySync()` — two SEQUENTIAL `git config` reads (`user.name`, `user.email`), each
independently bounded at `VAULT_GIT_OP_TIMEOUT_MS` — before the commit, which round 2's formula never
counted. Fixed: the formula is now `versionerCount * (VAULT_FLUSH_WORKING_TREE_TIMEOUT_MS * 2 +
VAULT_GIT_OP_TIMEOUT_MS * 3) + margin` (2 working-tree-scale calls — add, commit — plus 3 plumbing-tier
calls — status, and the two identity-check git-config reads).

The fired-watchdog record's rename-aside used a single fixed `.handled` suffix, which forced an
`unlinkSync` of any PRIOR aside file before a later `renameSync` could reuse that same name — silently
deleting an OLDER firing's forensic record, directly contradicting this mechanism's own "never deletes"
guarantee. Fixed: every aside name is now stamped with its own `firedAt` (sanitized for Windows filename
rules) or, lacking that, the current epoch ms — no two firings' aside files ever collide, so nothing is
ever unlinked.

An unparseable (corrupt) record file used to fall into the function's single catch-all and return `null`
silently, with no rename and no log line — every future boot would re-attempt and re-fail the same parse
forever, invisibly. Fixed: a corrupt record is now reported with its own loud `console.error` and renamed
aside (same timestamped scheme, `firedAtIso: null` falling back to epoch ms) so it stops blocking the
check on every subsequent boot.

Also round 3: every `test/fixtures/_graceful-teardown-*.mjs` fixture now calls `requireHermeticEnv()`
(`test/_guard.mjs`) itself, before ever arming the real watchdog — closing a real incident where a reviewer
ran one of these fixtures directly (`node test/fixtures/_graceful-teardown-sync-hang.mjs ...`) without first
setting `LOOM_HOME`, which wrote a stray record into the REAL `~/.loom/logs/shutdown-watchdog.json` (since
`HARD_SHUTDOWN_WATCHDOG_RECORD_PATH` resolves from `LOOM_HOME`, which defaults to the real `~/.loom` when
unset). Relying on the PARENT test file's own `useOwnLoomHome()` call was not enough, since nothing stopped
a fixture from being invoked standalone.

## Round 4 (delta Code Review 126bc284, 2026-10-04)

Test (B) ("clean path, real process") exited the fixture immediately after calling `disarm()`, so a
BROKEN (no-op) `disarm()` was indistinguishable from a genuinely working one: the watchdog's `Worker` is
always `.unref()`'d, so a trivial process with nothing else to do exits near-instantly either way — exactly
the same shape test (C)'s own "unref honest" case proves for the never-disarmed path. Fixed:
`_graceful-teardown-disarm-then-exit.mjs` now stays alive PAST `hardExitMs` on its own (a plain
`setTimeout`, which genuinely holds the event loop open, unlike the unref'd watchdog `Worker`) before
exiting, and the test now also asserts no watchdog record file was written. A genuinely-disarmed watchdog
never fires during that window; a no-op `disarm()` leaves the real watchdog live, so it fires at
`hardExitMs`, writes the record file, and kills the process before the fixture's own timer ever completes
it cleanly. Confirmed by temporarily making `disarm()` a no-op in `dist/graceful-teardown.js` and
re-running the test: exactly the "survived past hardExitMs" and "no watchdog record file" checks went RED
(the process died near `hardExitMs` with a record file present); restoring the real build
(`pnpm --filter @loom/daemon build`) made them GREEN again, with every other check in the file unaffected.

Test (D)'s round-3 margin (`longBudgetMs=9000`, slack=3000, giving a GREEN-path upper bound of 6700ms) left
only ~2.1s of real headroom on Windows, since the win32 kill path's PowerShell `Add-Type` cost grows under
a loaded (e.g. 3-lane) gate — close enough to flake the GREEN check without the underlying bug ever
recurring. Widened: `longBudgetMs` raised to 15000 and the slack to 6000, giving a GREEN-path upper bound
of 9700ms with ~5.3s of separation below the RED (missing-notify) death point near `longBudgetMs` — a wider
margin than round 3's, not a narrower one, despite the larger absolute numbers. Re-proved RED the same way
as round 3 (deleting the compiled generation-bump/notify call and re-running the file; restoring the build
made it pass again).

## Do not

- Do not assume the try/catch around `teardown()` in `runGracefulTeardown` protects against a hang — it
  only catches a synchronous throw; a synchronous BLOCK (a console write to a stalled pipe, a future
  `execFileSync` call, anything) bypasses it entirely and skips the merge-danger-aware exit below it.
- Do not remove the `armHardShutdownWatchdog` arm from the FIRST statement of `runGracefulTeardown` (or
  from `requestDaemonRestart`'s own analogous cleanup+exit sequence in `sessions/service.ts`, which does
  NOT go through `runGracefulTeardown` at all — it has its own `setTimeout(() => { cleanup?.(); exit(75); }, 300)`
  call, sharing only the `flushVaultsAndStopCodescape` cleanup function, not the wrapper). Both call sites
  share the identical hang-prone cleanup call and need the same protection.
- Do not replace the `worker_threads` + `Atomics.wait` mechanism with a plain main-thread `setTimeout` —
  a main-thread timer cannot fire while the main thread is itself blocked synchronously, which is exactly
  the failure mode observed in this incident. Verified directly: a main thread spinning in a true
  busy-loop (zero event-loop activity) still has its whole process terminated by the worker-thread
  watchdog, because `Atomics.wait` blocks the WORKER's own OS thread, independent of the main thread.
- Do not reach for a bare `process.kill(pid, <signal>)` on Windows when `intendedExitCode` matters. Measured
  directly (3/3 trials, every signal name tried — SIGTERM/SIGKILL/SIGINT): `libuv`'s `uv_kill` on Windows
  always calls `TerminateProcess(handle, 1)`, hardcoded, regardless of which signal name is passed — the
  exit code is NEVER the one you asked for. This would silently defeat `daemon_restart`'s restart sentinel
  (`RESTART_EXIT_CODE = 75`), which `scripts/daemon-supervisor.mjs` relies on verbatim to decide whether to
  relaunch — a backstop-fired restart would otherwise leave the supervisor NOT relaunching, by design
  ("any other exit... stops the loop"), stranding the fleet down instead of recovering it.
- Do not drop the PowerShell `kernel32!TerminateProcess` P/Invoke fallback path thinking a plain
  `process.kill` is equivalent. Measured directly against a genuinely wedged (busy-loop) child process: a
  PowerShell script that calls `OpenProcess`/`TerminateProcess(handle, <custom code>)` directly preserves
  the EXACT requested exit code (verified with code 75) even though the target process never cooperates.
  This is the only verified way to combine "force-terminate a hung process" with "choose its exit code" on
  Windows from this codebase, short of a native addon.
- Do not assume this is portable to POSIX as written. POSIX has no "kill this other process with a chosen
  exit code" syscall — the only non-cooperative lever is a bare signal (SIGKILL), whose death is reported
  to a waiting parent as a signal, never a numeric code. The fallback there (`SIGKILL`) guarantees
  termination but cannot preserve `intendedExitCode` — an accepted, platform-inherent limitation.
- Do not forget `.unref()` on the watchdog's `Worker` handle, and do not skip calling `disarm()` on every
  exit from `runGracefulTeardown` (including the normal fast path). A real `Worker` not `.unref()`'d (or a
  `SharedArrayBuffer` DONE flag never signalled) can itself hold a process open — or, worse, a left-armed
  watchdog in a test that imports this module in-process (rather than spawning a real child) would
  genuinely attempt to `TerminateProcess` the TEST RUNNER'S OWN process after `hardExitMs`, since the
  worker reads the real `process.pid`, identical in every thread of one OS process.
- Do not pass `step()` an over-long name expecting it to be preserved verbatim — it is silently truncated
  to `MAX_STEP_NAME_BYTES` (64). This is diagnostic-only; never gate real behavior on a step name.
- Do not apply one flat budget to every step (round 2) — a healthy `flushVaultsAndStopCodescape` flush can
  legitimately run minutes past the 60s default; give it its own derived budget via
  `computeFlushVaultsStepBudgetMs`, never a copied number.
- Do not gate the win32 SIGKILL fallback behind "did the PowerShell attempt appear to succeed" (round 2) —
  a null `OpenProcess` handle lets the script exit 0 without actually terminating anything; always fall
  through to `process.kill(pid, "SIGKILL")` afterward regardless.
- Do not write the fired-watchdog record to fd 2 (stderr) or skip writing it before the kill (round 2) —
  the stderr line itself may never be observed; the durable file under `LOOM_HOME/logs/` is the only
  guaranteed operator-visible trace of a firing.
- Do not let the per-step-budget test's upper-bound assertion compare elapsed time against anything near
  `longBudgetMs` (round 3) — that bound is wide enough that a COMPLETELY MISSING step() notify still
  passes it (the process dies near the stale long deadline instead of the short one, and that's still
  comfortably under a `longBudgetMs`-scaled bound). Keep the bound tight, near `surviveBlockMs +
  defaultHardExitMs + slack`, with real separation from `longBudgetMs` — AND (round 4) don't make that
  separation so narrow that ordinary win32 kill-path overhead under a loaded gate can flake the GREEN
  check; widen BOTH `longBudgetMs` and the slack together (round 4 raised them to 15000/6000) rather than
  tightening the slack to buy back margin, which would shrink headroom on the side that actually flakes.
- Do not have the watchdog worker wait on the DONE-flag index for the per-step deadline race (round 3) —
  it only changes once, at disarm, so it can't distinguish "nothing changed" from "step() just moved the
  deadline." Wait on the GENERATION index (`HEADER_GEN_INDEX`) instead, incremented by both `step()` and
  `disarm()` before their `Atomics.notify` call — this is what makes the wait's compare-and-block atomic
  against a race, not merely "mostly works."
- Do not under-count `computeFlushVaultsStepBudgetMs` as 2×working-tree + 1×git-op (round 3) —
  `flushSync()`'s `hasConfiguredGitIdentitySync()` call adds two MORE `VAULT_GIT_OP_TIMEOUT_MS`-bounded
  `git config` reads ahead of the commit; the real worst case is 2×working-tree + 3×git-op per vault.
- Do not go back to a single fixed `.handled` rename-aside suffix (round 3) — it forces an `unlinkSync` of
  any prior aside file before reuse, destroying an OLDER firing's forensic record. Stamp every aside name
  with its own `firedAt` (or an epoch-ms fallback) so no two firings' aside files ever collide.
- Do not let an unparseable record file fall into the generic catch-all silently (round 3) — it would sit
  on disk forever, with every future boot re-attempting and re-failing the same parse invisibly. Report it
  loudly and rename it aside, same as a genuine firing.
- Do not rely on a fixture's PARENT test file to set `LOOM_HOME` on its behalf (round 3) — every
  `test/fixtures/_graceful-teardown-*.mjs` fixture calls `requireHermeticEnv()` itself, since a fixture run
  standalone (bypassing the parent test) has previously written a stray record into the real `~/.loom`.
- Do not let test (B) exit the fixture process right after `disarm()` (round 4) — the watchdog's `Worker`
  is always `.unref()`'d, so a trivial process exits near-instantly whether `disarm()` genuinely ran or is
  a no-op, making the check unable to catch a broken `disarm()`. The fixture must stay alive PAST
  `hardExitMs` on its own (a plain `setTimeout`, which holds the event loop open) so only a genuinely
  suppressed watchdog lets it reach that point cleanly with no record file written.
