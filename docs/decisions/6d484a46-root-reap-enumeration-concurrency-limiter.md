# 6d484a46 — a small concurrency limiter on the root-reap OS enumeration helper spawn

## Narrative

Card `2897acc4`'s own round 3 noted a known follow-up it did not build: every kill/exit path now pays its
own fresh OS-process enumeration (`checkRootSurvival`, via `verifyRootDeadOrForceKill`) ON TOP OF the
pre-existing descendant sweep's own enumeration (`reapOrphanedDescendants`) — "every exit now costs 2
enumerations where it used to cost 1... a hard stop... costs up to 3" (see that file's own
`verifyRootDeadOrForceKill` doc comment, "COST" paragraph). A mass stop (daemon shutdown, a fleet-wide
kill, a restart) can fan out an unbounded number of these concurrently.

**Measured, hermetically** (no real spawn — overriding `probeRootSurvival`/`sweepOrphanedDescendants`,
the exact PtyHost seams `pty-root-reap-call-site-wiring.mjs` already uses, with an artificial delay
standing in for the real OS spawn): a mass hard-stop of 20 fake sessions fires 40 concurrent
`probeRootSurvival` calls (20 exit-reap + 20 hard-stop verify) and 20 concurrent `sweepOrphanedDescendants`
calls — 60 total, fully unbounded, before this card.

## The fix

A small, private `EnumerationSemaphore` class in `pty/host.ts` — GateSemaphore-shaped (bounded
concurrency, async acquire/release, never a busy-wait) but deliberately far smaller: no priority tiers, no
live registry, no repo guards. One module-level singleton (`rootReapEnumerationSemaphore`) gates exactly
the two call sites the cost model above names:

- `checkRootSurvival`: one `acquire()` covers the WHOLE call, including any internal retry
  (`enumerateWithRetry`) — never acquired per attempt.
- `reapOrphanedDescendants`: one `acquire()` gates entry to EITHER branch — the real
  `spawnProcess(...)` path AND the test-only `deps.enumerate()` path (gating the test path too costs
  existing sequential-call tests nothing — the acquire resolves same-tick whenever the pool isn't
  saturated — and is what makes the real branch's bound testable via that same seam, with no real spawn).

Defaults: `ROOT_REAP_ENUMERATION_CONCURRENCY` = 4 (env `LOOM_ROOT_REAP_ENUMERATION_CONCURRENCY`),
`ROOT_REAP_ENUMERATION_QUEUE_TIMEOUT_MS` = 30\_000 (env `LOOM_ROOT_REAP_ENUMERATION_QUEUE_TIMEOUT_MS`).
4 is small enough to kill the fork-storm while a typical real win32 CIM query (~560-630ms, measured in
`85ae7768`'s own record) still drains a mass-stop in a few seconds rather than fully serializing. 30s is
generous relative to each slot's own internal enumeration timeout (5-10s), so only a genuine, extreme
overload ever trips it.

## Fail-closed mapping — no new states

A queue-wait timeout makes `acquire()` reject. This is NOT a new result shape:

- In `checkRootSurvival`, the rejection is caught by the EXISTING try/catch, which already returns
  `{foundAlive:false, enumerationFailed:true, ...}` on any enumeration failure. `verifyRootDeadOrForceKill`
  already maps `check.enumerationFailed` to an early `return` with `identity:"unreadable"`
  (`checkFailed:true`) — see "Verified: never escalates" below.
- In `reapOrphanedDescendants`, a queue-timeout rejection hits the SAME `.then(..., onError)` catch every
  other enumeration failure (spawn error, helper timeout, a rejected injected `deps.enumerate()`) already
  goes through — logged, `sweep(...)` never called, nothing killed.

## Verified: `verifyRootDeadOrForceKill` never escalates to a kill on `identity:"unreadable"`

Read every branch of `verifyRootDeadOrForceKill` (`pty/host.ts`) top to bottom. EVERY path that produces
`identity:"unreadable"` is an early `return` STRICTLY BEFORE the `killRoot(rootPid)` call at the bottom of
the function:

- bad `rootPid` guard (not a reapable root pid)
- `check.enumerationFailed` (covers a queue-wait rejection, same as any other enumeration failure)
- `!owner` (no `expectedOwner`, no live/codexLive entry)
- win32 `check.creationTime == null` (CIM enumeration anomaly)
- linux ticks unavailable on either side
- win32 `owner.creationTime == null || check.creationTime == null`

The kill is reached ONLY by falling through every guard to the bottom, which requires `check.foundAlive
=== true` AND `check.identityConfirmed === true` AND no respawn (`findLiveEntryByPid`) AND `owner`
resolved AND a POSITIVE platform-specific creation-time match. `enumerationFailed` (a queue-timeout's own
shape) short-circuits at the SECOND check in the function, before identity confirmation is even attempted
— it can never reach the positive-confirmation state the kill requires. A queue timeout under load
therefore newly reaches `identity:"unreadable"` (an early, no-kill return), never the kill.

The ONE place a failed enumeration can follow an ALREADY-ISSUED kill is the POST-KILL recheck (the second
`probeRootSurvival` call, after `killRoot` has already fired on a POSITIVELY-confirmed identity match —
unaffected by this card, since that confirmation already happened before any queue wait could matter). If
THAT recheck's own queue wait times out, `recheck.enumerationFailed` is `true`, so `dead = !recheck.foundAlive
&& !recheck.enumerationFailed` evaluates `false` — reported as `"force-kill-unconfirmed"`, never a false
"confirmed dead". This is pre-existing behavior (the same path an ordinary post-kill enumeration failure
already took) — this card does not change it, only adds one more reason that failure can occur.

## Verified: a delayed sweep still can't kill a stranger (85ae7768's filters are time-independent)

Queueing delays WHEN the sweep's enumeration snapshot is taken, never WHAT `rootCreationTime` the sweep
compares against — that value is captured earlier (at spawn, via `armWin32RootCreationTime`, or by the
first probe before any kill) and threaded through as a parameter, unaffected by queueing. `computeOrphanSweepPlan`'s
two guards (`85ae7768`/round 5-6 of `2897acc4`) key off each row's own OS-reported `creationTime`/`ppid` —
absolute facts about that row, independent of when the query that produced them ran:

- **`abortedRootPidLive`**: a live, non-self-referential row at `rootPid` that doesn't provably match
  our recorded root creation time aborts the WHOLE sweep.
- **stale-pid filter**: a child whose own `creationTime` predates `rootCreationTime` is skipped, never
  killed, never walked.

A longer queue wait widens the WINDOW during which the OS could have reassigned the pid — it does not
weaken either guard's own correctness, since both guards classify a reassigned pid correctly NO MATTER
WHEN the snapshot was taken. New regression test (`pty-root-reap-enumeration-concurrency.mjs`, scenario G)
proves this directly: force the pool full (cap=1, one slow holder), queue a second sweep with a fabricated
stale-ppid row, and assert it is still `skippedStale`, never killed, once its (delayed) turn comes.

## Verified: a mass stop can't stall daemon shutdown or the emergency kill switch

- **Daemon shutdown** (`gracefulShutdown`/`runGracefulTeardown`, `index.ts`): the teardown sequence
  (`writeShutdownMarker` → `snapshotAllLive` → `flushVaultsAndStopCodescape` → `companionStop` →
  `watchersStop` → `finalLog` → `process.exit(0)`) never calls `pty.stop()` on a live session and never
  awaits `verifyRootDeadOrForceKill`/`reapOrphanedDescendants` at all. There is no await-chain from
  shutdown into this limiter — it cannot add latency to the exit path, regardless of queue depth.
- **Emergency kill switch** (`killAllWorkers`, `sessions/service.ts`): `for (const w of live)
  this.pty.stop(w.id, "hard")` is a synchronous, fire-and-forget loop (unaffected by this card — `stop()`
  never awaits the enumeration it schedules); the method's own `await Promise.all(...)` afterward covers
  `retireWorkerSession`/`cancelWorkerGateThenSweep` — gate cancellation and a WORKTREE-scoped stray sweep
  (`reapProcessesRootedInWorktree`), a different enumerator this card does not touch. `killAllWorkers`'s
  own completion is therefore unaffected by this limiter's queue depth.
- **The one GENUINE await**: `recycleWorker` (`sessions/service.ts:13165`) `await`s
  `verifyRootDeadOrForceKill` directly, per-worker (not a fleet-wide loop). **Corrected worst case (CR
  `ab171b39`, MINOR 3 — the original figure below undercounted it): `recycleWorker` first runs its OWN
  `for (i<50) await sleep(100)` `isAlive` poll (`sessions/service.ts:13153`, a flat 5s, unrelated to this
  limiter) BEFORE ever calling `verifyRootDeadOrForceKill` — and THAT function, if it reaches the
  "confirmed alive, force-killing" branch, calls `probeRootSurvival`/`checkRootSurvival` TWICE (the
  pre-kill check, then the post-kill recheck), each independently paying this limiter's own worst case:
  `ROOT_REAP_ENUMERATION_QUEUE_TIMEOUT_MS` (30s) plus the per-call `totalBudgetMs` the MAJOR fix below adds
  (`REAP_ENUMERATE_MAX_ATTEMPTS(2) * 5000 + 1 * 500` = 10.5s for the default `timeoutMs`) ≈ 40.5s each.
  Total: `5s + 2 × 40.5s ≈ 86s`.** Still bounded, never unbounded, and still fails toward REFUSING the
  recycle (the existing `identity==="unreadable"` gate) rather than toward a wrong "predecessor confirmed
  gone" proceed — the fail-closed CLAIM is unchanged, only the earlier, undercounted number.

## Round 2 (Code Review `ab171b39`): an unbounded slot hold on a hung POSIX read, and a sync-throw leak

**MAJOR — `checkRootSurvival` held its semaphore slot across a BARE `enumerateWithRetry` call.** The win32
enumerator self-bounds (its own `setTimeout`+`cmd.kill()`), but POSIX's `/proc` read has no timer of its
own — a hung read (a wedged filesystem, an unresponsive container mount) would hold the slot FOREVER, since
the `finally { release() }` guarding it can never run until the `await` it wraps actually settles. On the
small default pool (cap 4), as few as 4 concurrently-hung POSIX reads locks the WHOLE pool daemon-wide —
every other kill/exit path queues forever behind them, the exact failure mode this card exists to prevent,
just relocated one layer down. **Fixed:** wrapped the call in `withReapTimeout(enumerateWithRetry(...),
totalBudgetMs)` — the SAME `totalBudgetMs` arithmetic `reapProcessesRootedInWorktree` already uses
(`REAP_ENUMERATE_MAX_ATTEMPTS * timeoutMs + (REAP_ENUMERATE_MAX_ATTEMPTS - 1) * REAP_ENUMERATE_RETRY_DELAY_MS`)
— so a hung enumerator now rejects at a bounded time, the `finally` runs, and the slot frees regardless of
what the underlying (now-orphaned, best-effort-abandoned) enumerator call eventually does. Test
(`pty-root-reap-enumeration-concurrency.mjs`, scenario H): an injected enumerator that NEVER settles —
`checkRootSurvival` still resolves `enumerationFailed:true` within the budget, and a FOLLOWING call is
granted the freed slot, proving the slot genuinely came back.

**Same review — the queue array leaked a cancelled-but-never-removed entry.** `EnumerationSemaphore`'s
timeout branch used to only set `waiter.cancelled = true`, relying on a FUTURE `release()` to eventually
skip over it — a queue with no further activity after a timeout would accumulate dead entries forever
instead of shrinking back down. **Fixed:** the timeout handler now `splice`s the waiter out of `this.queue`
outright at the moment it fires; `release()`'s own cancelled-skip check stays as a defensive backstop for
the (never actually reachable, given JS's single-threaded ordering) window between a `release()` already
having shifted the waiter and the timer firing.

**MINOR — a synchronous throw inside `reapOrphanedDescendants`'s `acquire().then(onFulfilled, ...)` body
leaked the slot AND crashed the process.** An ENOMEM-class synchronous throw from `spawnProcess`, or a
sync-throwing `deps.enumerate` REFERENCE (never even reaching its own `.then()`), escaped the `onFulfilled`
callback entirely — with no `.catch` anywhere in this fire-and-forget chain, Node treats that as an
unhandled rejection and exits the WHOLE process by default. This is a regression specifically on the
POST-KILL sweep path (`verifyRootDeadOrForceKill`'s own `this.sweepOrphanedDescendants(...)` call after a
confirmed kill) — a crash there takes down every other live session along with it. **Fixed:** the entire
`onFulfilled` body is now wrapped in try/catch, and every release point (the two `deps.enumerate()`
outcomes, the real spawn's three settle points, and the new catch) funnels through one `releaseOnce()`
guard, so a slot is freed exactly once regardless of which path fires, and the exception is logged
("found/killed NOTHING") and swallowed, never rethrown. Test (scenario I): a synchronously-throwing
`deps.enumerate` — no unhandled rejection reaches the process, and the slot is released (a following call
is granted).

**Nitpicks:** scenario G is relabeled — it does not itself exercise the limiter's queueing (proven false
in round 1's own RED proof: it stayed green with the limiter fully bypassed); it now also asserts, via
completion order, that the sweep's own enumeration genuinely ran only after a holder released, so it's an
honest "delayed sweep, filter still correct" proof rather than an implied limiter test. The three
`sleep(10)` calls between dispatching holders and a following call were removed — `acquire()`'s fast path
increments `running` SYNCHRONOUSLY the instant it's called (no microtask/macrotask gap to wait out), so
those sleeps asserted a false precondition and did nothing a correctly-ordered dispatch didn't already
guarantee. `ROOT_REAP_ENUMERATION_CONCURRENCY` is now clamped to `>= 1` — the prior `Number(...) || 4` only
caught a FALSY raw value (0/NaN/unset); a negative override would make `running < this.max` permanently
false, so nothing would ever take the fast path and every `acquire()` would queue forever.

## Do not

- Do not acquire a NEW concurrency slot per `enumerateWithRetry` attempt inside `checkRootSurvival` — one
  `acquire()` covers the whole call (including any internal retry), or a retrying caller would consume
  more than its fair share of the shared pool under exactly the contention this limiter exists to bound.
- Do not gate `reapProcessesRootedInWorktree`'s own enumeration (worktree teardown) through this same
  semaphore — it is a DIFFERENT trigger (worktree removal, not session exit) with its own existing
  timeout/retry shape; this card's measured cost model is scoped to `checkRootSurvival`/
  `reapOrphanedDescendants` only.
- Do not skip gating `reapOrphanedDescendants`'s `deps.enumerate()` test-only branch on the theory that it
  never spawns a real process — gating it too is what makes the REAL branch's bound hermetically testable
  through the same seam, and it costs an existing sequential-call test nothing.
- Do not read a queue-wait rejection as license to invent a new caller-facing state — every existing
  caller already treats an enumeration failure as fail-closed; route a queue-timeout through that SAME
  plumbing (`enumerationFailed:true` / the best-effort `.then(sweep, onError)` catch), never a new one.
- Do not `.unref()` `EnumerationSemaphore.acquire`'s bound-wait timer — same posture as
  `verifyRootDeadOrForceKill`'s own bounded-wait timer (`2897acc4`, round 8, item 1b): `clearTimeout` once
  the race settles is what avoids a dangling handle without risking a stranded `Promise.race`.
- Do not assume `killAllWorkers`/daemon shutdown need any direct awareness of this limiter's queue depth
  — neither awaits the gated functions; if a future change makes either path AWAIT
  `verifyRootDeadOrForceKill`/`reapOrphanedDescendants` directly (not fire-and-forget), re-derive this
  section's "can't stall" conclusion rather than assuming it still holds.
- (Round 2) Do not hold `EnumerationSemaphore`'s slot across a BARE `enumerateWithRetry(...)` call inside
  `checkRootSurvival` — POSIX's `/proc` enumerator has no timer of its own, so a hung read would hold the
  slot forever (the `finally{release()}` can't run until the await it wraps settles). Always wrap it in
  `withReapTimeout(..., totalBudgetMs)`, the same arithmetic `reapProcessesRootedInWorktree` uses.
- (Round 2) Do not leave a timed-out `EnumerationSemaphore` waiter merely marked `cancelled` for a future
  `release()` to skip over — `splice` it out of `this.queue` outright at timeout time, or a queue with no
  further activity afterward accumulates dead entries forever.
- (Round 2) Do not let `reapOrphanedDescendants`'s `acquire().then(onFulfilled, ...)` body run unguarded —
  a synchronous throw (ENOMEM-class `spawnProcess`, a sync-throwing `deps.enumerate` reference) escapes as
  an unhandled rejection with no `.catch` in this fire-and-forget chain, crashing the whole process by
  default — a regression specifically on the post-kill sweep path. Wrap the whole body in try/catch and
  funnel every release point through one `releaseOnce()` guard.
- (Round 2) Do not use `Number(process.env...) || <default>` alone for `ROOT_REAP_ENUMERATION_CONCURRENCY`
  — that only catches a falsy raw value, never a negative one; a negative `max` makes `running < this.max`
  permanently false, deadlocking every future `acquire()`. Clamp with `Math.max(1, ...)`.
- (Round 2) Do not claim the three `sleep(10)` pacing waits (between dispatching holders and a following
  call in the test) are needed for an `acquire()` to "land" — the fast path increments `running`
  SYNCHRONOUSLY the instant it's called; there is no async gap to wait out when dispatch has no yield
  point in between. Removed, not just re-worded, once this was understood.
- (Round 2) Do not read scenario G as a proof that the limiter itself forced the sweep's delay — round 1's
  own RED proof showed it stays green with the limiter fully bypassed. It proves the stale-ppid filter's
  correctness under a delayed snapshot; it must independently assert (via completion order, not a timing
  threshold) that the sweep actually queued, or the label overclaims what the scenario shows.
