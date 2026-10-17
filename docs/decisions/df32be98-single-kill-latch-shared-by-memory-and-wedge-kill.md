# df32be98 — one shared kill latch for the memory-ceiling, wedge, and drift-restart kills

## Narrative

Found by worker `be617210` on card `9c06fab1`: `checkMemoryCeiling`'s memory-ceiling kill could fire more
than once for the SAME still-dying child whenever more than one health-probe tick elapsed before its real
OS exit was observed. `probeHealth` serializes ticks (`probeInFlight`), so the race was never concurrent —
it was sequential: tick N's `checkMemoryCeiling` captures the live child (pid P, still over ceiling),
issues `kill()`, fires `onMemoryCeilingRecycleFn`, and returns. `wireDeathHandling`'s `onDeath` only sets
`this.child = null` / `this.alive = false` once the real OS `'exit'`/`'error'` event actually fires. If
that hasn't happened by tick N+1 (one `healthProbeIntervalMs` later — plausible under host contention,
where the parent's event loop can lag observing a child's real death), `this.child`/`getPid()` still
report the same pid, a repeat sample against the still-dying process still reads over ceiling, and
`checkMemoryCeiling` fires a SECOND `kill()` plus a SECOND `onMemoryCeilingRecycleFn` call against the
exact same child object. `memorySampleInFlight` only guards re-entrancy within one sample call — nothing
latched "a kill was already issued for this pid."

Production consequence: never an extra respawn (`wireDeathHandling`'s own `settled` flag means the real
exit, whenever it arrives, still only triggers `scheduleRestart` once) — but a real extra `kill()` call
against an already-signaled, not-yet-reaped child, and a doubled `code_graph_memory_recycled` durable
audit event (`index.ts`'s `onMemoryCeilingRecycle` wiring) for one real recycle.

pid-reuse hazard: `ChildProcess.kill()` dispatches by raw pid (`process.kill(this.pid, signal)`
internally; on win32 the no-signal-arg path goes through `TerminateProcess` by pid), not via an OS handle
exclusively bound to that object. Node's own docs warn that calling `kill()` on a process that has
already exited can signal a DIFFERENT process if the OS has since reused that pid. The dangerous window
is exactly between the real OS-level death (possibly already reaped at the OS level) and the parent's
event loop actually firing `'exit'` — which can lag under host contention. A second `kill()` issued
inside that window is therefore a real, documented pid-reuse risk, not merely redundant signaling.

CR follow-up (manager directive): the SAME hazard shape exists, independently, at `probeHealth`'s own
wedge-kill site (`consecutiveHealthFailures >= healthProbeFailureThreshold`) — a second, pre-existing
kill site with no latch of its own. Rather than two separate latches for one hazard (the two-path
asymmetry this codebase keeps getting bitten by), both kill sites now route through one shared choke
point, `issueChildKill(child, pid)`, guarded by one shared field, `childKillPid: number | null`. Checked
early in `checkMemoryCeiling` (before even sampling, so a latched pid skips the sampler call entirely —
no wasted `powershell.exe` spawn on win32 for a pid already known to be dying) and in `probeHealth` via
`isChildKillLatched()` (added right after the existing `checkMemoryCeiling()` early-return, before the
HTTP `/graph/health` round-trip). Set by `issueChildKill` at the moment a kill is actually issued; cleared
by `wireDeathHandling`'s `onDeath` the instant the real exit is observed (`this.child = null`); reset in
`start()`/`stop()` alongside every sibling kill-tracking field.

Deliberate choice: while latched, `probeHealth` does NOT increment `consecutiveHealthFailures` either —
the early return happens before that line is ever reached. A dying child's non-answer, once we already
know why it isn't answering, is not fresh wedge evidence; counting it anyway would (a) produce a
misleading "alive but unresponsive" log for a child we already decided to kill, and (b) climb/reset
`consecutiveHealthFailures` in a confusing way with no corresponding real kill (since the shared latch
would block it) once the threshold was crossed again.

## CR follow-up (review `51a78018`): a THIRD kill site, and the pristine-main flake question

Code Review found a THIRD "this child needs to die" site this card's first pass missed:
`checkBuildDrift`'s drift-restart kill (`supervisor.ts`, inside `probeHealth`'s success branch). Same
hazard, same fix — it now also routes through `issueChildKill`. The reviewer confirmed the call site is
safe (it only ever runs inside `probeHealth`'s own `probeInFlight` serialization, same as the other two).
`stop()`'s own direct `child.kill()` is legitimately NOT a fourth site to route — it resets the latch and
nulls `child` in the same call, so there is no "already dying" state left for anything to collide with.

The review also asked for the memory-ceiling file's own pristine-main flakes in scenarios (1)/(7) to be
reconsidered as plausibly THIS bug rather than dismissed as unrelated — fair, since scenario (8)'s own
header already frames (1)/(5)/(7) as reproducing this exact race by construction. Re-examined with that
framing in mind: across 8 pristine-`main` runs of `codescape-memory-ceiling.mjs` (before this card's fix
existed), scenario (1) failed 2/8 times and logged a SECOND kill-shaped line in 3/8 runs — but in EVERY
one of those 8 runs, `onMemoryCeilingRecycle` fired exactly once (the direct counter this bug would
inflate) and the extra kill line was always `[codescape] serve health probe failed 3x consecutively …`
(the WEDGE site's own distinct log line), never a second `[codescape] serve memory … exceeds ceiling …`
line. That is consistent with a genuinely different, pre-existing mechanism — scenario (1) leaves
`healthProbeWedgeKillEnabled` on at a tight `60/40` margin (scenario (7) explicitly disables it for
exactly this reason), and a freshly-respawned, healthy child can lose that race under host contention
independent of anything this card changes. This is NOT a confident "unrelated" verdict, though — n=8 is
small, I have not instrumented every tick to rule out a near-miss, and the reviewer's broader point (this
whole file's flakes are worth re-examining now that the fix exists) stands regardless of this one
mechanism. Treat scenarios (1)/(7)'s stability after this fix as EXPECTED TO IMPROVE, UNVERIFIED — re-run
and re-assess after this lands, rather than trusting either this record's mechanism finding or the
reviewer's hypothesis as settled.

## Follow-up (card bfce0891): identity guard, kill-delivery failure, SIGKILL escalation

Three pre-existing follow-ups from CR `51a78018`, fixed together in `supervisor.ts`.

**(1) `onDeath` now guards on `this.child === child`, not just `settled`.** Repro: `stop()` kills child A
but does NOT detach A's listeners; if `start()` spawns child B before A's real, async `'exit'`/`'error'`
arrives, A's belated event used to null `this.child`/`alive` out from under the now-live B (an untracked
orphan) and — since `this.stopped` is false again by then — schedule a bogus THIRD restart on top of it.
The identity check also stops a second, subtler bug: A's stale death used to clear `childKillPid` even
when it had since been re-latched for B's pid, un-latching a legitimate in-flight kill.

⛔ **Deliberately did NOT also detach A's listeners in `stop()`**, despite the card literally asking for
both. Node's `EventEmitter` treats `'error'` specially: emitting it with ZERO listeners attached THROWS
(uncaught). If `stop()`'s own `try { this.child.kill(); } catch {}` synchronously triggers a kill-failure
`'error'` (see (2) below) after the `'error'` listener had already been stripped, that becomes an
unhandled exception — strictly worse than the dangling-listener hygiene issue. The identity guard alone
fully closes the race (a stale child's late event becomes a safe, logged no-op) without this risk.

**(2) A kill-delivery failure is no longer treated as a death.** Verified Node's REAL internal
`ChildProcess.prototype.kill` source (`node --expose-internals`, v22.16.0): `err===0`→success; `err===
UV_ESRCH`→silently returns `false`, no event (already dead — the real `'exit'` is still pending, so the
latch must STAY held); `err===UV_EINVAL/ENOSYS`→throws synchronously; any OTHER error ("almost certainly
EPERM")→`this.emit('error', ...)` SYNCHRONOUSLY, inside the `kill()` call, before it returns. `sendSignal`
is the one place `issueChildKill`/`maybeEscalateStuckKill` route their own `child.kill(...)` call through
(flagging `issuingChildKill` for that synchronous window) — NOT the only place in the file that ever calls
`child.kill(...)` at all: `stop()`'s own direct kill and the self-reporting spawn's abandon-on-timeout kill
deliberately bypass it, since neither needs the suppression (their own call sites say why).
`wireDeathHandling`'s `'error'` listener checks that flag first — if set, it logs loudly via
`console.error` and returns WITHOUT calling `onDeath` (no death, no respawn). Only a genuine, non-ESRCH
failure releases the latch immediately (nothing is coming); the silent ESRCH case keeps it held (the
real, already-pending exit will clear it, same as before).

**(3) SIGKILL escalation when a child survives a delivered SIGTERM (POSIX only).** `maybeEscalateStuckKill`
(called from `probeHealth`'s `isChildKillLatched()` branch) sends ONE SIGKILL once the latch has been held
for `killEscalationProbeTicks` (default 3) full `healthProbeIntervalMs` ticks, logging one loud line. If
the latch is STILL held `killEscalationProbeTicks` ticks after that (a zombie/uninterruptible child, or
the SIGKILL itself failed to deliver), it logs exactly ONE more "still alive after SIGKILL — supervision
blind for this child" line and does nothing further — never a second SIGKILL, never a latch clear.
Does NOT reopen this card's own bug: that race was two INDEPENDENT call sites each separately deciding
"kill this pid" within about one health-probe-interval of each other, inside the short async window
between a real OS death and Node's own `'exit'` delivery (closed by libuv in low milliseconds under
normal load). This is a single, one-shot UPGRADE of the SAME still-open kill decision, gated on the latch
staying held for many FULL intervals — by then, if the OS had already reaped the child, Node's exit
watcher would essentially certainly have already fired `'exit'` and cleared the latch naturally, so a
latch still held after that long is strong evidence the process is genuinely still alive, not an
unobserved death.
Verified with a standalone POSIX mechanism probe under WSL/Ubuntu (real `node` on a real Linux kernel,
since this repo's own dev/CI hosts are win32): a real child trapping SIGTERM genuinely survives the first
signal, and the escalation logic's SIGKILL genuinely ends it (`signal:"SIGKILL"` observed on the real
`'exit'` event) — the probe does NOT exercise the actual shipped class (it transitively imports
`node-pty`, a native module with no Linux build in this worktree), only a standalone reimplementation of
the same state machine against a real OS process.

## CR follow-up (18f6a9ac, on card bfce0891)

Four more fixes before merge:

1. **Production log noise.** `onDeath`'s stale-child branch used to fire the "superseded by a newer
   spawn" warning on EVERY ordinary `stop()`, not just a genuine stop()+start() race — `stop()` nulls
   `this.child` before the killed child's real, belated exit arrives, so EVERY plain shutdown hit the
   stale-child branch with `this.child === null` (never superseded by anything). The CR counted 27 such
   false lines in one test run. Fixed: the "superseded" wording now fires ONLY when `this.child` is
   non-null AND a different object; the `this.child === null` case is silent (nothing to log — nothing
   superseded it, and there's no death to react to either). `test/codescape-supervisor.mjs` now asserts a
   plain `stop()` emits zero "superseded" lines across the real async window its killed child's exit can
   land in.
2. **A test that could not fail.** `(22-win32)` in `codescape-health-probe.mjs` originally used
   `killEscalationProbeTicks:1` against the SAME `healthProbeIntervalMs` the escalation age threshold is
   computed from — so the threshold could never be reached in a real run, and "win32 never escalates"
   passed vacuously (true even with the win32 guard removed). Fixed by fast-forwarding
   `childKillIssuedAt` (same technique `(22-zombie)` already used) so the age threshold is genuinely
   satisfied, calling `maybeEscalateStuckKill()` directly, and asserting via `childKillPid` rather than
   `getPid() !== null`. `healthProbeIntervalMs` itself stayed LONG (the real timer must never fire — an
   earlier attempt at this fix shortened it instead, which let the real timer race ahead of the explicit
   test call and clear the latch before the test ever observed it latched). Verified with a surgical
   control: removing the win32 guard line made this check go RED; restoring it made it GREEN again.
3. **Dedupe the persistent-EPERM log.** A pid that keeps failing to receive a signal gets re-issued a kill
   on every subsequent tick (each genuine failure releases the latch), which used to re-log the same
   `console.error` every time. `lastKillSignalFailurePid`/`lastKillSignalFailureReason` now gate it to
   once per distinct (pid, reason) pair — reset in `onDeath`/`start()`/`stop()` so a new pid's own
   failures still log fresh — matching this file's existing transition-deduped diagnostics
   (`lastMemorySampleFailureReason`, `lastHealthAnsweredErrorStatus`). The latch is still released exactly
   as designed; only the logging is deduped.
4. **Stale doc claims.** `sendSignal`'s doc claimed it was "the ONE place that ever calls `child.kill(...)`"
   — false: `stop()`'s own direct kill and the self-reporting spawn's abandon-on-timeout kill both call it
   directly too (deliberately, since neither needs the suppression). And `issueChildKill`'s doc claimed
   the callers' "post-kill bookkeeping ... should only run when this returns `true`" — also false: every
   real call site (`checkMemoryCeiling`, `probeHealth`'s wedge kill, `checkBuildDrift`) runs its own
   recycle-callback/logging bookkeeping UNCONDITIONALLY, before `issueChildKill` is even called, never
   gated on its return value. Both corrected in the source and here.

## Follow-up (card 7de21027): `stop()` gets its OWN bounded SIGTERM→SIGKILL escalation

Found by Code Review (`18f6a9ac`, on card `bfce0891`): `stop()` sent only SIGTERM, with no escalation,
and nulled `this.child` synchronously regardless of whether the real OS process ever actually died. On
POSIX, a `serve` that traps or ignores SIGTERM survived every `stop()` and every daemon shutdown as an
untracked orphan holding its port and memory — the same "survives SIGTERM" failure this card's item 3
(`maybeEscalateStuckKill`) already handles for the supervision path, on a SECOND path that item never
covered. Windows is unaffected (`TerminateProcess`).

**`stop()` is now `async`.** Every synchronous reset stays in the exact same order as before (including
`this.child = null`/`this.alive = false`/`this.port = null`) — a caller that doesn't need to know the
child has actually gone (every existing test call site) can keep calling it fire-and-forget. After the
synchronous resets, if a child was actually running, `stop()` captures it in a LOCAL variable (never
`this.child`, which is already null by then) and awaits a new private `terminateKilledChild(killed)`:
it sends SIGTERM via `sendSignal` (same choke point, same kill-delivery-failure suppression
`issueChildKill` gets), then races `killed`'s own real `'exit'` event against a bounded timer
(`stopKillEscalationMs`, default 3s, independent of `healthProbeIntervalMs` — that cadence is
minutes-scale and the wrong fit for a shutdown path that wants to stay fast). If the timer wins, it logs
once and issues ONE SIGKILL (same `sendSignal` choke point) and resolves immediately — never waiting a
second time for a confirmation, same one-shot posture `maybeEscalateStuckKill` already established.

**Deliberately NOT a 4th `issueChildKill` site** — this card's own earlier text (above) already ruled
`stop()`'s kill out of the shared `childKillPid` latch, since `stop()` nulls `this.child` and resets the
latch synchronously, leaving no "already dying, latched" state for anything else to agree on. The new
escalation machinery lives entirely in closure-local variables (the captured `killed`, a local `settled`
flag, the timer) — it never reads or writes `this.child`/`this.childKillPid` — so it cannot collide with
a `start()` that spawns a fresh child while an old one's escalation is still pending: that race is
already handled by `wireDeathHandling`'s existing identity guard (`this.child === child`), unchanged.

**Plumbing so the wait actually delays exit.** `stop()`'s bounded wait is useless unless the daemon's own
shutdown path awaits it instead of firing `exit()` the instant the (now-async) cleanup call returns.
`SessionService.setShutdownCleanup`'s `fn` param and the `shutdownCleanup.run` field both widen to
`() => void | Promise<void>`; `flushVaultsAndStopCodescape` (index.ts) is now `async` and `await`s the
supervisor's `stop()` call — its OWN vault-flush half stays fully synchronous and unchanged, since
`flushSync()` was never a promise to begin with. Both of `flushVaultsAndStopCodescape`'s callers now
propagate the wait: `runGracefulTeardown`'s `teardown` callback type widens to allow a promise, and the
function wraps its body in an async IIFE that `await`s `teardown(...)` (catching a REJECTION the same way
a synchronous throw was always caught) before unconditionally proceeding to the merge-danger-aware exit;
`requestDaemonRestart`'s own analogous `setTimeout` cleanup (which does NOT go through
`runGracefulTeardown` — see this file's existing note) wraps its body in an async IIFE too, with
`watchdog.disarm()`/`exit(RESTART_EXIT_CODE)` moved into a `finally` so they still run even if `await
cleanup?.run()` ever rejected (it shouldn't — `stop()`/`terminateKilledChild` are designed to never
reject — but the `finally` makes "restart exit still happens" true by construction, not by the callee's
good behavior).

**Never blocks shutdown indefinitely, by two independent bounds.** `terminateKilledChild`'s own fixed
`setTimeout(stopKillEscalationMs)` is a hard ceiling by construction — the promise resolves via EITHER
the real `'exit'` event OR the timer firing and immediately issuing SIGKILL without waiting again.
Underneath that, the pre-existing, independent-OS-thread `armHardShutdownWatchdog` step budget (≥30s
margin via `FLUSH_VAULTS_STEP_BUDGET_MARGIN_MS`, untouched by this card) remains armed as a structural
backstop regardless of any bug in the new code.

**`stopKillEscalationSupported` test seam.** Production defaults this to `process.platform !== "win32"`
— the same reasoning `maybeEscalateStuckKill` already uses. ⚠️ CORRECTED (CR `b05bf612`): this is NOT
the pid-reuse hazard this record's Narrative section documents — `ChildProcess.kill()` signals through
Node's own internal libuv process handle (held open by the `ChildProcess` object itself), which no-ops
once the process has already been reaped, and a Windows `HANDLE` cannot be reused for an unrelated
process while it's still open; a second call is simply redundant, never dangerous, by that mechanism. The
REAL, sufficient reason is that win32's `child.kill()` is unconditionally `TerminateProcess`, which
cannot be trapped or survived — so the original "SIGTERM" already ended the process unconditionally, and
there is nothing left to escalate to by the time the timer could fire. A platform-independent test needs
to exercise the REAL SIGKILL branch deterministically on any host (including a win32 dev/CI machine) via
a fake child that never really dies — this boolean test seam lets it do that without weakening the real
platform guard in production.

## Do not

- Never issue a second `kill()` on a child pid before its exit is observed — route every "this child
  needs to die" decision through `issueChildKill`, never a bare `child.kill()` call.
- Do not give the memory-ceiling, wedge, and drift-restart kills separate latches — one shared
  `childKillPid` field is the point: every kill site for one child must agree on whether a kill is
  already in flight.
- Do not increment `consecutiveHealthFailures` (or otherwise treat a dying, already-latched child's
  non-answer as new wedge evidence) while `childKillPid` is latched for the current pid.
- Do not guard `onDeath` on `settled` alone — also guard on child IDENTITY (`this.child === child`), or a
  superseded child's belated death can clobber a newer child's state.
- Do not detach a child's `'error'` listener in `stop()` (or anywhere) as a "fix" for the identity-guard
  gap above — Node throws on an `'error'` emitted with no listener attached, which is worse than the
  dangling-listener hygiene issue it would be solving.
- Do not treat a kill-delivery failure (an `'error'` emitted synchronously during `sendSignal`'s own
  `child.kill()` call) as a death — check `issuingChildKill` first; only a genuine (non-ESRCH) failure
  releases the latch, never the silent ESRCH "already dead" case.
- Do not let `maybeEscalateStuckKill` send more than one SIGKILL per latch, and do not let it clear the
  latch on its own for any reason — a second kill or an unconditional clear reopens exactly the hazard
  this card's original fix closed.
- Do not log the "superseded by a newer spawn" line when `this.child === null` in `onDeath`'s stale-child
  branch — that is an ORDINARY `stop()`, not a race; logging it there spams every daemon shutdown.
- Do not re-log the kill-signal-failure `console.error` on every tick for a persistently-failing pid —
  dedupe on (pid, reason), same as this file's other transition-deduped diagnostics.
- Do not shorten `healthProbeIntervalMs` to make a test's escalation age threshold reachable — the real
  health-probe timer must stay too slow to ever fire during a test driven by direct `probeHealth`/
  `runOneHealthProbeForTest()` calls; fast-forward `childKillIssuedAt`/`childKillEscalatedAt` instead.
- Do not route `stop()`'s own kill through `issueChildKill`/`childKillPid` — `stop()` already nulls that
  latch synchronously, so there is no "already dying, latched" state for a 4th site to agree on.
- Do not remove `stopKillEscalationSupported`'s win32 default guard, and do not run the real SIGKILL
  branch unconditionally on every platform — win32's `child.kill()` is unconditionally `TerminateProcess`,
  untrappable, so a genuine timer-fire there means there is nothing left to escalate to (NOT a pid-reuse
  risk — `ChildProcess.kill()` signals through Node's own held-open process handle, which simply no-ops
  once reaped). Use the boolean test seam to exercise the branch on a win32 host instead.
- Do not let `terminateKilledChild` wait a second time after issuing its own SIGKILL — resolve
  immediately once it's issued, same one-shot posture as `maybeEscalateStuckKill`.
- Do not forget to `await` `flushVaultsAndStopCodescape()`/`cleanup?.run()` at either call site — an
  un-awaited call makes `stop()`'s bounded wait pointless, since `exit()` fires before it ever settles.
- Do not mention codescape by name in `graceful-teardown.ts`'s own comments — that file is generic
  shutdown infrastructure, not on the compiled-output codescape-privacy allowlist (`codescape-privacy-
  guard.mjs`), and a mention there is a real, guard-caught leak of a private product name into shipped
  `dist/`.

## Source

`packages/daemon/src/codescape/supervisor.ts`: the `childKillPid` field doc, `issueChildKill`,
`isChildKillLatched`, the early-return in `checkMemoryCeiling`, the early-return + kill-site change in
`probeHealth`, the kill-site change in `checkBuildDrift`, and the `onDeath`/`start()`/`stop()` latch
resets inside `wireDeathHandling`/`start`/`stop`.

Card bfce0891 follow-up: the identity guard in `wireDeathHandling`'s `onDeath`, the new `sendSignal` choke
point, the kill-delivery-failure handling in `issueChildKill` and the `'error'` listener, the new
`maybeEscalateStuckKill` + its call site in `probeHealth`, the `childKillIssuedAt`/`childKillEscalated`/
`childKillEscalatedAt`/`childKillZombieWarned`/`issuingChildKill`/`childKillSignalFailed` fields, the
`killEscalationProbeTicks` opt, and the `getChildForTest()` test seam.

CR follow-up (18f6a9ac): the null-child branch in `onDeath`'s stale-child guard, the
`lastKillSignalFailurePid`/`lastKillSignalFailureReason` dedupe fields + their resets in
`onDeath`/`start()`/`stop()`, `test/codescape-supervisor.mjs`'s new `captureWarnings` helper + the plain-
`stop()`-is-silent assertion in section (c), and `test/codescape-health-probe.mjs`'s rewritten
`(22-win32)` scenario.

Card 7de21027 follow-up: `supervisor.ts`'s now-`async` `stop()`, the new `terminateKilledChild` method,
the `stopKillEscalationMs`/`stopKillEscalationSupported` opts + their defaults, and
`DEFAULT_STOP_KILL_ESCALATION_MS`. The shutdown-plumbing half: `index.ts`'s now-`async`
`flushVaultsAndStopCodescape`, `sessions/service.ts`'s `setShutdownCleanup`/`shutdownCleanup.run` type
widening and `requestDaemonRestart`'s now-async `setTimeout` callback (disarm/exit moved into a
`finally`), and `graceful-teardown.ts`'s `runGracefulTeardown` (the `teardown` param now allows a
promise, awaited inside a new async IIFE). Tests: `test/codescape-supervisor.mjs`'s
`(df32be98-stop-timeout)`/`(df32be98-stop-exit)` platform-independent fake-child scenarios and the
`(df32be98-stop-posix)` real-spawn POSIX scenario (SKIP on win32, CI-ubuntu-only), plus
`test/graceful-teardown-hard-exit-backstop.mjs`'s `[async teardown]`/`[async teardown rejects]`
scenarios.
