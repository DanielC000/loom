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

## Round 5 (card 0dc09fab, 2026-10-04)

A real 6-worker-plus-builds host flaked round 4's own "promptly" per-step-budget bound (elapsedMs=9757
against a 9700ms bound — 57ms over), and surfaced two genuinely new defects in the same gen-397 run:

**The win32 exit-code race (a real product bug).** `TerminateProcess` on Windows is asynchronous — per
MSDN it initiates termination and returns immediately, without waiting for the target to actually finish
tearing down. Round 2 made the raw `process.kill(pid, "SIGKILL")` fallback run UNCONDITIONALLY after the
PowerShell custom-exit-code attempt, specifically because PowerShell exiting 0 didn't prove `OpenProcess`
got a valid handle. But that fallback, on win32, always re-invokes `TerminateProcess` itself (via libuv's
`uv_kill`, hardcoded to `TerminateProcess(handle, 1)` regardless of signal name) — so under light load the
first call's teardown finishes fast enough that the second call lands on an already-fully-dead process and
has no effect (exit 75 survives); under heavier load that teardown window widens enough for the second call
to land while the process is still mid-teardown, overwriting the already-set exit code before it's "locked
in" (gen 397 measured this losing exit 75). This matters because `daemon_restart`'s supervisor relaunch
keys on the literal numeric 75.

Fix: the PowerShell script now reports a genuine, checkable result via its OWN exit code — `exit 1` if
`OpenProcess` returns a null handle, or if `TerminateProcess` itself returns `false`; otherwise it falls
off the end (PowerShell's implicit exit 0). Node treats `execFileSync` NOT throwing as confirmation the
custom-exit-code kill is already in flight (`winCustomExitConfirmed = true`) and, in that case ONLY, SKIPS
the raw SIGKILL fallback entirely — removing the race by construction, since there is nothing left to race
against. The fallback still runs, exactly as round 2 intended, whenever the custom-code attempt is NOT
confirmed (null handle, `TerminateProcess` returning false, or `execFileSync` itself throwing/timing out).
POSIX is unaffected (`winCustomExitConfirmed` never gets set there, so the fallback still always runs).

**Named residual (round 2, card 0dc09fab, not closed by this fix):** the fix removes the race for every
case this PS script can itself REPORT, but one path through `execFileSync` still slips past it —
`TerminateProcess` returns `true` (the kill is genuinely in flight) and the PowerShell process then falls
off the end to report success, but `execFileSync` ITSELF throws for an unrelated reason before Node ever
observes that exit code (e.g. the 10s timeout). Node sees a throw, not a clean exit-0 observation, so
`winCustomExitConfirmed` stays `false` and the raw SIGKILL fallback still runs — reopening the exact same
race this round exists to close, against a kill that genuinely was already confirmed, just not confirmed
THROUGH THIS SIGNAL. This is narrower than the original bug (it needs `execFileSync` to fail AFTER the
real API call already succeeded, not merely under ordinary load) and has not been measured to occur in
practice; it is recorded here as a known gap in the fix's coverage, not a reason to distrust it.

Proven with a patch-based test: the compiled `dist/graceful-teardown.js`'s `const ps = ...;
execFileSync("powershell.exe", ...)` sequence is replaced wholesale with an inline stand-in that reports a
KNOWN, controlled outcome (confirmed or unconfirmed) without ever invoking powershell.exe or the real
Win32 API at all, making both paths deterministic. The patched text is written to a UNIQUE SIBLING FILE
under `dist/` (never the installed `graceful-teardown.js` in place) — mutating the shared file would race
any OTHER concurrently-running process/test importing from it (including this same test file running
concurrently with itself under the load-robustness proof below), and the sibling lives in the same
directory so its own relative imports still resolve to the real, unmutated siblings. The
`_graceful-teardown-sync-hang.mjs` fixture takes an optional 4th argv (a module path/URL) to import
`armHardShutdownWatchdog` from this sibling instead of the real dist path; every existing caller omits it
and is byte-identical.

**Round 2 revision (card 0dc09fab, 2026-10-04): the FIRST version of this patch still shelled out to a
real `powershell.exe` for its trivial stand-in script, and that version's "confirmed success" check went
3 FAIL / 2 PASS on PRE-FIX gating under load — where it must always FAIL.** Two compounding causes: (1)
under host load, the whole sequence (node startup + the watchdog's own `hardExitMs` + a COLD
`powershell.exe` spawn) could exceed the test's OWN external safety-kill window, making the process look
"hung" (the expected-PASS signal) even on buggy pre-fix code, for a reason unrelated to the fix; (2) with
no independent signal that the watchdog had fired AT ALL, that same "hung" result was also
indistinguishable from "the watchdog never fired," a different and more serious bug. Fixed by removing
the real `powershell.exe` spawn from the patch entirely — neither the "confirmed" nor "unconfirmed"
stand-in ever calls `execFileSync` again — and having the patched worker report its own decision-point
marker at the exact point the real code would have inspected `execFileSync`'s outcome. Each check now
asserts the marker was actually seen (ruling out "never fired") and THEN separately asserts what happens
in a short, bounded grace window after it, rather than racing one external timeout against the whole
sequence.

The marker itself is a DURABLE FILE WRITE (`fs.writeSync` on an explicitly-opened fd, a sibling of the
real watchdog record path), never `console.log`/`process.stdout.write` — confirmed directly that it has
to be: an interim version of this patch wrote the marker via `process.stdout.write()` from inside the
watchdog WORKER thread, and it was never observed, even on the "confirmed" path where the child survives
the whole grace window, because `process.stdout` in a worker thread is proxied back to the MAIN thread
over an internal message channel, and the main thread here is synchronously blocked on `Atomics.wait`
with no event-loop ticks at all — the proxied write can never flush. Re-verified RED/GREEN the same way
as the original fix: 5/5 FAIL against the pre-fix (unconditional-fallback) code, 12/12 PASS against the
real fix under a 12-way-concurrent run with 4 CPU-burner processes.

Also round 2: the structural check asserting this round's own gating contract used to assert the
SUPERSEDED round-2 contract (the OLD `killedWithCustomCode` short-circuit's absence) instead of this
round's real one — it stayed green only because nobody would reintroduce that exact dead name, never
because it verified `winCustomExitConfirmed`'s actual gating or the PS script's own `exit 1` branches.
Rewritten to assert both directly.

**Aside-path collision-proofing.** `timestampedAsidePath` derived its destination from `firedAt`'s
ISO-millisecond timestamp alone. `fs.renameSync` on Windows silently OVERWRITES an existing destination
(`MoveFileEx` with `MOVEFILE_REPLACE_EXISTING`) rather than erroring, so two firings whose `firedAt`
happens to collide to the millisecond would clobber each other's forensic record with no error and no
visible sign — directly contradicting this mechanism's "never deletes/loses a firing" guarantee. (gen
397's run C failure is a SEPARATE, already-explained effect — ordinary filesystem-listing lag under heavy
I/O, which the TEST side now tolerates with a brief poll — not evidence this collision itself fired that
day; no log or artifact from that run actually attributes it to a `firedAt` collision, so this record no
longer claims one did.) Fixed: `timestampedAsidePath` appends an in-process monotonic sequence number,
making every call's destination path provably distinct regardless of clock resolution WITHIN one process's
lifetime — **the sequence resets to 0 on every fresh boot (it's a plain module-scope `let`, not persisted
anywhere)**, so uniqueness here is an in-process guarantee, not a durable, cross-restart one: two firings
that collide on `firedAt` AND land on the same in-process sequence value ACROSS a restart (one right before
a crash/exit, the next right after reboot, both producing sequence `0`) are not provably distinct by this
mechanism alone. Narrower than the original bug (it needs a restart between the two firings, not just
rapid succession within one process) and not separately mitigated here. Proven directly: two records
written with the IDENTICAL `firedAt` and consumed back to back, within the SAME process, now produce two
distinct aside files (verified RED against the pre-fix code — the second call silently overwrote the
first, so the aside-file count never grew past 1; GREEN after the fix) — **this is a single observation
(n=1) of the overwrite mechanism firing, not a statistically-sampled rate; it demonstrates the mechanism
exists, not how often it would otherwise bite in practice.**

**Round 2 addition (card 0dc09fab, 2026-10-04): the "first firing survived" check above used to compare
aside-file NAMES, which this exact overwrite bug can never flip** — a collided destination (the round-3
shape this section exists to catch) keeps the SAME filename across both renames; only its CONTENT gets
clobbered. A regression that dropped the sequence suffix would still pass a name-presence check, because
the name never changes either way. Fixed: the check now re-reads the FIRST firing's own aside file
CONTENT, after the SECOND rename has happened, and asserts its `step` field still reads `"collision-test-
1"` (not the second firing's `"collision-test-2"`, which an overwrite would leave it holding). Verified
RED/GREEN directly: reverting `timestampedAsidePath` to the round-3 shape (dropping the sequence suffix,
so both firings' destinations collide to the same name) and running the file 5 times gave 5/5 FAIL on the
new content check; restoring the real fix and re-running 5 times gave 5/5 PASS.

Also round 5 (test-only, no production change): the per-step-budget "promptly" upper bound is now the
MIDPOINT between the expected-GREEN floor (`surviveBlockMs + defaultHardExitMs`) and the RED (missing-
notify) ceiling (`longBudgetMs`, raised 15000 → 30000) — a single named fraction
(`PROMPT_UPPER_BOUND_GAP_FRACTION = 0.5`) derived from the test's own constants, so raising `longBudgetMs`
alone widens the GREEN-side margin and the RED-side separation together, instead of needing two
independently-tuned absolute numbers to stay in proportion by hand (round 4's own hand-picked slack had
already rotted once, at only 57ms of margin). And the aside-file-count assertions now poll briefly (up to
3s) rather than checking instantaneously, tolerating a `fs.readdirSync()` not yet reflecting an
immediately-prior `fs.renameSync()` under heavy filesystem I/O — a genuine miss (the file never appears)
still fails exactly as before.

## Round 6 (card e34cb710, 2026-10-04)

Delta CR 126bc284 of round 3 flagged that the watchdog's deadline arithmetic was wall-clock (`Date.now()`
epoch `BigInt` in the shared buffer) at all 3 sites that touch it: the initial arm, every `step()` re-arm
(both on the main thread), and the watchdog worker's own `remaining = deadline - Date.now()` read. A
forward wall-clock step (an NTP correction, or the host sleeping/resuming into a later wall time) between a
write and the worker's later read makes `remaining` read smaller than real elapsed time → the watchdog
fires EARLY, potentially mid `git commit` inside `flushVaultsAndStopCodescape` — the exact "silently
dropped commit" harm round 2 already fixed once for a different reason. A backward step does the
opposite: `remaining` reads larger than real elapsed time → the watchdog fires LATE or never within any
practical bound, reintroducing the original 2026-10-03/04 unbounded-hang incident this whole backstop
exists to prevent. This was a real, live gap present in every round landed so far — none of them touched
the clock basis.

**The fix:** both the main-thread writes (arm, `step()`) and the worker's own read now compute the
deadline/`remaining` against `performance.timeOrigin + performance.now()` (`monotonicNowMs()`) instead of
`Date.now()`. `performance.now()` is backed by `uv_hrtime()` (libuv), which never reads the adjustable wall
clock — it is immune to an NTP correction, a manual clock change, DST, or leap seconds by construction.
`performance.timeOrigin` is fixed once per PROCESS, not per-thread — verified directly on this host (Node
v22.16.0): a `Worker` created 2 seconds after process start reports the IDENTICAL `timeOrigin` the main
thread does (delta 0ms), so the main thread's and the watchdog worker's independent
`performance.timeOrigin + performance.now()` readings are directly comparable with no cross-thread
reconciliation needed — this matches `perf_hooks`'s own documented wording ("the current node PROCESS
began"), not an undocumented implementation accident.

The persisted firing record's `firedAt` field (`HardShutdownWatchdogRecord`) is deliberately left as
`new Date().toISOString()` — it is forensic display only, never read back for arithmetic, so there is no
correctness reason to change it, and doing so would make the on-disk record harder for a human operator to
read at a glance.

### Delta Code Review (card e34cb710, same day)

The first version of this fix gave `armHardShutdownWatchdog` an optional `now?: () => number` DI seam
(defaulting to the real `monotonicNowMs`) so the main-thread arm/`step()` writes could be driven
deterministically by a test. **Removed.** It only ever skews the MAIN-thread write side while the real
worker always reads the real clock — a real caller has no legitimate reason to want the two sides to
disagree, and arming IN-PROCESS (not a real child) with a `now` skewed enough to read as already-elapsed
would genuinely `TerminateProcess`/`SIGKILL` the TEST RUNNER'S OWN process, since the worker shares
`process.pid` with whatever process armed it (the identical hazard this file's own "never forget
`.unref()`" note already names for a left-armed in-process watchdog). The seam was also never actually
exercised by anything in the test suite — it was dead code offering a real hazard with no benefit.

**Both the main-thread write side AND the worker's read side are instead proven via sibling-dist-file
source patches, never a runtime DI parameter** — extending the same technique the worker-read proof
already used:
- **Worker-read proof (unchanged):** regex-reverts the worker's one changed line back to a `Date.now()`
  read ("legacy"), with a constant offset applied to ONLY the worker's own `Date.now()` (never the main
  thread's), simulating a forward or backward wall-clock jump landing on the SUBTRAHEND of `remaining =
  deadline - workerClock`.
- **Main-thread-write proof (new):** regex-reverts BOTH the arm and `step()` deadline writes back to
  literal `Date.now()` ("legacy-main"), with the SYNC-HANG FIXTURE's own (parent) `Date.now()` skewed
  before arming — a worker thread's `Date` global is independent of its parent's, so this skew reaches
  only the write side, never the worker's own (always real, unskewed) read. This is the MINUEND of the
  same formula, so the polarity is the mirror of the read-side proof: a BACKWARD parent skew (parent
  thinks it's earlier) computes a deadline that already reads as elapsed relative to the real worker clock
  → fires early (RED); a FORWARD parent skew (parent thinks it's later) computes a deadline minutes away →
  does not fire within a bounded window (RED). Both proven against the real fixed code too (GREEN,
  unaffected either direction).

**Measurement switched from process-exit timing to the durable watchdog RECORD FILE's appearance time.**
The record is written synchronously inside the worker BEFORE any kill attempt is even made, so this signal
carries none of the win32 PowerShell/`TerminateProcess` variance that round 4 already measured growing
significantly under a loaded (e.g. 3-lane) gate — a hazard the original process-exit-timing version of
this test was directly exposed to (its own GREEN/RED margin was observed as tight as ~2.8s under load).
The spawned child is still reaped afterward for test hygiene (a RED "does not fire" case is left genuinely
alive until this test kills it), but that reap is never itself part of any assertion.

All 8 scenarios (2 clock directions × {worker-read, main-thread-write} × {legacy, fixed}) proven in
`graceful-teardown-hard-exit-backstop.mjs`.

**Residual, stated honestly rather than assumed (the card's own instruction): what does a monotonic clock
do across host sleep/hibernate, and does that differ by platform?** Checked against primary sources, not
memory:

- **Windows:** `QueryPerformanceCounter` (QPC) — what libuv's `uv__hrtime` calls directly on win32 (`src/
  win/util.c`) — is documented by Microsoft to return "the total number of ticks that have occurred since
  the Windows operating system was started, **including the time when the machine was in a sleep state
  such as standby, hibernate, or connected standby**," and separately, "QPC is completely independent of
  the system time and UTC" and "is the performance counter monotonic (non-decreasing)? Yes. QPC does not
  go backward." (Microsoft Learn, "Acquiring high-resolution time stamps.") So on this project's owner
  host (Windows), the fix's monotonic deadline correctly counts real elapsed time THROUGH a sleep/
  hibernate — a step's budget "spends" sleep time the same way a wall clock would, without the NTP-jump
  hazard this round exists to remove.
- **Linux (the CI target, `ubuntu-latest`):** libuv's `uv__hrtime` there (`src/unix/linux.c`) uses
  `clock_gettime(CLOCK_MONOTONIC, …)` (or `CLOCK_MONOTONIC_COARSE` for the separate "fast" clock type Node
  does not use for `performance.now()` — both are in the same monotonic family). Per the Linux
  `clock_gettime(2)` man page, `CLOCK_MONOTONIC` explicitly **does NOT count time that the system is
  suspended** — `CLOCK_BOOTTIME` is the separate, suspend-aware sibling clock, and libuv does not use it
  here. So on Linux, a host suspend occurring while the watchdog is armed effectively PAUSES its budget:
  the real wall-clock time until firing can exceed the configured `hardExitMs`/step budget by (up to) the
  suspended duration, since suspended time is never counted against it.
- **This is a genuine, accepted, platform-divergent residual, not a regression** — the OLD `Date.now()`-
  based code was unconditionally WORSE on both platforms (vulnerable to firing EARLY from a mere NTP
  correction, no suspend involved at all, which is the more dangerous direction: a mid-write kill). The
  fix removes that hazard uniformly. What it does NOT give is "the watchdog fires within `hardExitMs` of
  real wall-clock time no matter what," only "within `hardExitMs` of real elapsed PROCESSING time,
  excluding suspension on Linux" — a difference that only matters if the host suspends WHILE the watchdog
  is armed, a narrower window than "any NTP correction, anytime."

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
- Do not gate the win32 SIGKILL fallback behind the OLD, unreliable "did the PowerShell attempt appear to
  succeed" signal (round 2) — the script used to exit 0 unconditionally even when `OpenProcess` returned a
  null handle, so "appeared to succeed" proved nothing. THAT signal is still gated against: the fallback
  stays unconditional on anything UNCONFIRMED (round 5's PS script now `exit 1`s on a null handle or a
  `false` `TerminateProcess` return, and any `execFileSync` throw/timeout also counts as unconfirmed).
  ⛔ But (round 5) do NOT make the fallback unconditional on a GENUINE confirmation either — `TerminateProcess`
  is asynchronous (initiates termination, returns immediately, does not wait for the target to finish
  tearing down), so unconditionally re-invoking it via the raw SIGKILL fallback (which on win32 always
  calls `TerminateProcess(handle, 1)` through libuv's `uv_kill`) can land a SECOND call while the first
  confirmed one is still mid-teardown, overwriting the already-set exit code before it's "locked in" —
  measured losing exit 75 under a loaded host. Skip the fallback ONLY when the custom-code kill is
  CONFIRMED (PS script exits 0, meaning a non-null `OpenProcess` handle AND a `true` `TerminateProcess`
  return) — never on a mere "didn't throw" that doesn't actually verify both.
  ⛔ And do not read "didn't throw" as meaningful on its own, independent of the PS script's own text — it
  is `execFileSync` NOT throwing that Node treats as confirmation, but that signal is only trustworthy
  BECAUSE the PS script's own two `exit 1` branches (the null-handle check and the false-`TerminateProcess`
  check) turn every unconfirmed outcome into a non-zero exit, which `execFileSync` turns into a throw. A PS
  script with no such `exit 1` branches (the round-2 shape, which always fell off the end with an implicit
  exit 0 regardless of what `OpenProcess`/`TerminateProcess` actually returned) would make "didn't throw"
  true unconditionally, proving nothing — the gate's safety lives in the PS script's branches, not in the
  mere act of checking `execFileSync`'s outcome.
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
  ⛔ Round 4's own hand-picked absolute slack STILL flaked (9757ms against a 9700ms bound — 57ms of margin)
  on a heavier-loaded host. Do not go back to a hand-picked absolute slack at all (round 5) — express the
  upper bound as a FRACTION of the gap between the GREEN floor and `longBudgetMs`
  (`PROMPT_UPPER_BOUND_GAP_FRACTION`), so raising `longBudgetMs` alone widens both margins in lockstep.
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
  ⛔ But (round 5) a bare `firedAt` timestamp, even to millisecond resolution, is NOT provably unique on its
  own — `fs.renameSync` on Windows silently OVERWRITES an existing destination (`MoveFileEx` with
  `MOVEFILE_REPLACE_EXISTING`) rather than erroring, so a collided timestamp would clobber an older
  firing's record with no error and no visible sign. Always append the in-process monotonic
  `asidePathSequence` counter too — never drop it thinking the timestamp alone is "surely" unique.
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
- Do not try to test the win32 confirmed-success/confirmed-failure fallback gating (round 5) against REAL
  `TerminateProcess` timing — it's inherently racy (that race is the whole bug) and can't deterministically
  produce either outcome on demand. Patch the COMPILED `dist/graceful-teardown.js`'s embedded PowerShell
  script text to a trivial controlled stand-in (`"exit 0"` / `"exit 1"`) instead.
  ⛔ But do NOT write that patch to the installed `dist/graceful-teardown.js` IN PLACE the way the OTHER
  (manual, one-off, RED/GREEN-proof-then-restore) dist patches in this file's own history did — this patch
  runs as a PERMANENT part of every ordinary test run, not a one-off manual proof, so an in-place mutation
  would race any other concurrently-running process/test importing from the SAME shared file (including
  this test file running concurrently with itself under the load-robustness proof). Write it to a unique
  sibling file under `dist/` instead, and import it via the sync-hang fixture's optional module-override
  argv.
- Do not assert an aside-file count change instantaneously after a rename under load (round 5) — a
  `fs.readdirSync()` immediately following a prior process's `fs.renameSync()` can lag briefly under heavy
  filesystem I/O. Poll briefly (bounded, e.g. a few seconds) for the expected count instead of checking
  once; this doesn't weaken what's proven — a genuine miss (the file never appears at all) still fails.
- Do not let the win32 confirmed-success/confirmed-failure test (round 2, card 0dc09fab) race a single
  external timeout against the WHOLE sequence, and do not shell out to a real `powershell.exe` even for a
  trivial stand-in script — both reintroduce load-sensitive timing this patch exists to remove, and the
  "hung" result either produces is indistinguishable from "the watchdog never fired at all." Report a
  decision-point marker from inside the patched worker and assert it was seen BEFORE asserting what
  happens in a short, bounded grace window afterward.
- Do not report that decision-point marker (or ANY signal from inside the watchdog worker, while the main
  thread may be synchronously blocked) via `console.log`/`process.stdout.write`/`process.stderr.write`
  (round 2, card 0dc09fab) — a worker thread's `process.stdout` is proxied back to the MAIN thread over an
  internal message channel, which can never flush while that main thread is blocked on `Atomics.wait` with
  no event-loop ticks running at all. Confirmed directly: a stdout-based marker was never observed, even on
  the path where the child survives for the whole grace window. Use a durable, synchronous fs write
  instead (`fs.writeSync` on an explicitly-opened fd) — the same technique the REAL watchdog record already
  uses, for the identical reason.
- Do not assert a collision-proofing check (the aside-path "first firing survived" case) by aside-file
  NAME alone (round 2, card 0dc09fab) — `fs.renameSync`'s silent-overwrite bug clobbers the destination's
  CONTENT while leaving its NAME (and thus its presence in a `readdirSync` listing) completely unchanged, so
  a name-presence check can never fail even when a regression reintroduces the exact collision this section
  exists to catch. Re-read the file's own content after the second rename and assert the field that would
  actually be overwritten.
- Do not go back to `Date.now()` for ANY of the watchdog's deadline arithmetic (round 6, card e34cb710) —
  the main-thread arm/`step()` writes, or the worker's own `remaining` read. A forward wall-clock step
  fires it EARLY (mid-write); a backward step fires it LATE/never, reintroducing the original unbounded-
  hang incident. Use `performance.timeOrigin + performance.now()` (`monotonicNowMs()`) on both sides.
- Do not assume a monotonic clock's behavior across host sleep/hibernate is the same on every platform
  (round 6) — verified against primary sources, not memory: Windows' QPC (what `uv_hrtime` uses there)
  counts sleep/hibernate/standby time; Linux's `CLOCK_MONOTONIC` (what `uv_hrtime` uses there) does NOT.
  State this residual honestly rather than claiming blanket "immune to sleep" — see round 6's own section
  for the citations and why it's an accepted narrowing, not a regression, versus the old `Date.now()` code.
- Do not fold a test's own cleanup kill into the SAME "did it exit" flag used to assert a negative (round
  6, card e34cb710) — proving "the legacy worker does NOT fire within a bounded window" needs the test to
  forcibly kill the still-alive child once that window elapses (so the next sub-test isn't left with an
  orphaned process), but if that forced kill's own `exit` event sets the identical flag the assertion
  reads, the check passes VACUOUSLY — it was fired by the test's own cleanup, not the watchdog. Capture
  "exited naturally within the window" as a value BEFORE ever deciding whether to intervene, and never
  let the cleanup branch overwrite it. Caught directly: an early version of this round's own backward-
  jump test reported `exited:true` and only printing the elapsed time (just over the window's own bound,
  not anywhere near `hardExitMs`) revealed the exit was the test's own `SIGKILL`, not a real watchdog fire.
- Do not give `armHardShutdownWatchdog` a runtime `now?: () => number` test seam (delta Code Review, card
  e34cb710) — it only ever skews the main-thread write side while the real worker always reads the real
  clock, so a skewed `now` just makes the two sides disagree for no caller's benefit, and arming
  IN-PROCESS with it set to read as already-elapsed would genuinely `TerminateProcess`/`SIGKILL` the TEST
  RUNNER'S OWN process (the worker shares `process.pid` with its arming process). Prove BOTH the
  main-thread write side and the worker's read side via sibling-dist-file source patches instead.
- Do not measure this round's RED/GREEN proofs by process-EXIT timing (delta Code Review, card e34cb710)
  — the win32 kill path's PowerShell overhead can grow enough under a loaded gate to eat the margin
  between a GREEN (on-time) and a RED (early) result (observed as tight as ~2.8s under load on the
  original exit-timing version of this test). Measure the durable watchdog RECORD FILE's appearance time
  instead — it is written synchronously inside the worker BEFORE any kill attempt, so it carries none of
  that variance. Still reap the spawned child afterward for hygiene; never fold that cleanup into a check.
