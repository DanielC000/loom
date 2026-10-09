# 21f6175c — bounding readdir("/proc") and the /proc/uptime read, the two non-per-pid hangs 2b7df434 left open

## Narrative

Follow-up to `2b7df434` (landed `c9b5c501`), which bounded `enumerateProcessesPosix`'s PER-PID `/proc`
reads against a hung-read-pins-a-thread-per-enumeration hazard but deliberately left its two non-per-pid
reads out of scope (see that card's own "Do not" list): `readdir("/proc")` (lists every pid to enumerate)
and `readFile("/proc/uptime")` (feeds only the best-effort `creationTime` field). Neither has a pid key,
so the per-pid `posixInFlightPidReads` Map doesn't cover them — a hang in either still pins a fresh libuv
thread on EVERY overlapping enumeration call, same class of hazard, rarer in practice (one directory
listing / one file, not one per live pid) but worse in kind (it can exhaust the whole threadpool faster,
since there's no per-pid dilution).

## The fix — two new SINGLETON guards, deliberately asymmetric in how they fail

`joinSingletonPosixRead<T>(slot, startRead, deadline)` is the non-per-pid counterpart to
`readPosixPidRecordDeduped`: a single shared resource (no pid key — there is exactly one `/proc`
directory and one `/proc/uptime` file), joined by every caller, each racing the REMAINING time to its own
`deadline` (the SAME `deadline` already computed once at entry to `enumerateProcessesPosix`, reused here
rather than a fresh per-read budget — stacking independent fresh budgets for readdir + uptime + per-pid
would reopen a smaller version of `2b7df434` round 2's own regression). Unlike the pid-keyed version, it
returns a THREE-way outcome (`resolved` / `rejected` / `timeout`) because the two call sites react
differently to a confirmed failure vs. a still-pending one — the pid-keyed version never needed this
distinction, since both collapsed to the same `readUnverified` shape there.

**Readdir is STRUCTURAL** — it's the list every pid comes from; no list means nothing to report, a
genuinely incomplete enumeration, not a best-effort field.
- `rejected` (unchanged pre-existing behavior): falls back to `enumerateProcessesPosixViaPs(timeoutMs)`,
  exactly as before this card.
- `timeout` (new): throws a `timedOut:true`-tagged `Error` — the SAME tagging convention
  `enumerateProcessesWin32`'s own self-timeout already uses, so `enumerateWithRetry`'s classification
  (`pty/host.ts`, the `const timedOut = (err as {timedOut?:boolean}|null)?.timedOut === true` check)
  treats it exactly like any other timeout-class enumeration failure, including the fact that a RETRY's
  fresh `enumerateProcessesPosix` call computes a NEW `deadline` but still finds the SAME still-pending
  shared slot (never cleared, since the original read never settled) and JOINS it rather than starting a
  second real read — the dedup property holds across retries, not just within one call. Deliberately NOT
  falling back to ps on a timeout (unlike a confirmed rejection): the real read might still resolve fine a
  moment later for some other caller, and falling back now would be guessing. This needs zero new code in
  any of the three consumers (`checkRootSurvival`/`reapProcessesRootedInWorktree`/
  `attributeProcessesToWorktree`) — a rejection from `enumerateProcessesPosix` flows through the EXISTING
  `enumerateWithRetry` → `withReapTimeout` chain into each consumer's own, already-reviewed
  `enumerationFailed:true` catch block, unchanged since before `2b7df434` even existed.

**Uptime is COSMETIC** — it feeds only the best-effort `creationTime` field, already nullable and already
silently degraded today on a plain rejection (its own internal try/catch resolves `null`, never throws).
- Both `rejected` and `timeout` degrade `bootTimeMs` to `null`; the enumeration proceeds and resolves
  normally. No failure propagates, no new row shape — identical observable effect to the pre-existing
  internal-catch-to-null behavior, now also covering a genuine hang.

## The ordering bug caught before landing (re-CR, round 2)

The first draft of this fix KICKED OFF the uptime read and AWAITED it immediately, before the per-pid
loop, racing the shared `deadline`. That is wrong: a hung/slow uptime read would then consume the ENTIRE
deadline before the per-pid loop even started, leaving every per-pid race with `remainingMs≈1` and
turning this one best-effort field's own failure into every row coming back `readUnverified` — a
regression against today's behavior (plain `creationTime: null`), even though it's still "fail-closed" in
the letter.

**Fixed**: the uptime read is kicked off FIRST (before `readdir`, at the very top of the function) but
NEVER awaited until AFTER the per-pid loop has been dispatched — it runs CONCURRENTLY with every per-pid
race, sharing the same `deadline` rather than consuming it sequentially. `creationTime` is computed in a
cheap, synchronous backfill pass over `procs` only once BOTH the per-pid loop and the uptime read have
settled (`Promise.all([uptimeOutcomePromise, perPidWork])`). `readdir`, by contrast, genuinely IS awaited
before the per-pid loop — there is nothing to read pids FROM until it resolves, so it has no equivalent
concurrency opportunity.

RED-proofed directly: reverting to the sequential ordering (await uptime before the per-pid loop) flips
exactly the "every row has `readUnverified` absent, real `exePath`/`cwd`/`commandLine`, only
`creationTime` null" assertions in the test's uptime-hang scenario to FAIL — nothing else in the suite
regresses under that specific mutation, confirming the test isolates exactly this ordering concern. (The
test's injected per-pid reader needed a small REAL delay (`setTimeout`, not an instantly-resolving fake)
to make this discriminate at all — a microtask-fast fake wins even a ~1ms starved race before any timer
fires, silently masking the regression on the first attempt at this RED proof.)

## Test seam and coverage

`packages/daemon/test/pty-posix-enumeration-readdir-uptime-guard.mjs`, run alone. No real
filesystem/process access; every scenario drives `PosixEnumerationDeps`. No real pid is ever passed to a
real kill/reaper (this card's consumers are read-only or injected with a fake `kill`, matching
`2b7df434`'s own convention). Covers: a confirmed (non-hanging) readdir rejection still falls back to the
ps enumerator; a hung readdir rejects every caller `timedOut:true` with the reader invoked exactly once
across 5 calls (dedup bound), plus a negative control (the abandoned read eventually resolves, a later
call reads fresh); a hung uptime degrades every row's `creationTime` to `null` while keeping real
`exePath`/`cwd`/`commandLine` and `readUnverified` absent, reader invoked exactly once across 5 calls,
plus its own negative control. **Scenario order is load-bearing** (stated in the file's own header) —
unlike the pid-keyed card's test, these two guards have no key at all, so a scenario that permanently
hangs a resource poisons it for every later scenario in the same file; the two "permanent hang" scenarios
run last, ordered readdir-after-uptime (since readdir is also a prerequisite for every other scenario's
own pid listing). Round 2 added: the `POSIX_LISTING_JOINED_STALE` marker's own correctness (set on a
joiner's result, absent from an owner's); `checkRootSurvival`'s consumption of it plus a negative
control; a confirmed uptime rejection; a synchronous-throw scenario (with an `unhandledRejection`
listener); and the end-to-end `reapProcessesRootedInWorktree` scenario folded into the final
readdir-permanent-hang scenario.

## Round 2 (re-CR 483b6e0f)

**1. BLOCKER (Linux CI) — a platform-dependent test assertion.** Scenario 1 asserted
`settled === "rejected"` for a rejecting `listProcPids`, which only held because the dev host (win32) has
no real `ps`; on `ubuntu-latest` the `rejected` branch's `enumerateProcessesPosixViaPs(timeoutMs)` fallback
spawns a REAL `ps -axwwo ...` and RESOLVES there (verified by the CR under WSL Ubuntu, `rc=0`), so the
assertion would go RED on Linux CI — the `4e762baf` class of failure the Windows-hosted gate structurally
cannot see. **Fixed**: added `psFallback?: (timeoutMs: number) => Promise<WorktreeProcess[]>` to
`PosixEnumerationDeps` (default: the real `enumerateProcessesPosixViaPs`), and the rejected branch now
calls `(deps.psFallback ?? enumerateProcessesPosixViaPs)(timeoutMs)`. Scenario 1 injects a fake
`psFallback` and asserts it (not the real one) was invoked — deterministic and platform-agnostic, no real
`ps` ever spawns from this test on any OS. Also corrected the file's own header, which claimed "no real
filesystem/process access" while every scenario except the uptime-under-test ones relied on the REAL
default `readBootTimeMs` (a real `/proc/uptime` read on Linux, a quick ENOENT on win32) — every scenario
now injects `readBootTimeMs` explicitly, making the header's claim actually true.

**2. The stale-joined-listing fail-open hazard (manager ruling).** A call that JOINS an in-flight readdir
gets a listing that was a snapshot taken BEFORE its own entry — if the queried root is absent from that
listing, `checkRootSurvival` (pre-fix) returned `{foundAlive:false, enumerationFailed:false}`, i.e.
"confirmed gone." But "absent from a snapshot that predates this call" is NOT proof "gone as of now" — a
root spawned between the snapshot and this call's own entry would be legitimately alive and still read as
gone. That is the FAIL-OPEN direction a kill/recycle decision must never take (the accepted cost of fixing
it closed instead: one refused-then-retried recycle). **Fixed**: `joinSingletonPosixRead` now also
returns `joined: boolean` (was `slot.current` already set when this call checked?). `enumerateProcessesPosix`
marks its returned array with a module-level `Symbol` (`POSIX_LISTING_JOINED_STALE`, exported) when its
OWN readdir call joined rather than started fresh — a symbol key, invisible to `for...in`/`Object.keys`/
`JSON.stringify`/array iteration, so the public `WorktreeProcess[]` shape is untouched. `checkRootSurvival`
alone reads it: an absent root under that flag now reports the byte-identical shape as a real enumeration
failure (`enumerationFailed:true`), never a confident "gone." `reapProcessesRootedInWorktree`/
`attributeProcessesToWorktree` need no equivalent change — for them, an absent pid already means the safe
"don't kill"/"don't match" answer regardless of whether the listing is stale, so adding the check there
would be inert, not merely unnecessary. RED-proofed by disabling the new check in `checkRootSurvival`
(`if (false)` in place of the real condition): exactly the "absent root in a stale listing" assertion
flipped to FAIL, with its own negative control (the same absence in a FRESH, non-stale listing) staying
GREEN throughout — proving the fix is scoped to the stale flag alone.

**3. Test gaps closed**: (a) a confirmed (non-hanging) uptime REJECTION — rows come back with
`creationTime: null` and the enumeration itself resolves, never rejects (mirrors the existing readdir-
rejection coverage, for the cosmetic field); (b) one true end-to-end scenario — a hung readdir driven
through `reapProcessesRootedInWorktree` (via an `enumerate` that wraps the REAL `enumerateProcessesPosix`
with injected `PosixEnumerationDeps`, never the bare `ProcessEnumerator` seam) with a FAKE `kill`, asserting
`enumerationFailed:true`, nothing killed, and — the actual point of the scenario — that `enumerateWithRetry`'s
own second attempt JOINS the same still-pending readdir rather than re-invoking `listProcPids` (invocation
count stays 1 across BOTH attempts). This scenario is folded into the existing readdir-permanent-hang
scenario rather than kept separate, since a second independent permanent hang could never be isolated
from the first in a file with no pid key to disambiguate resources (see the ordering note below).

**4. Nitpick — a synchronous throw from `startRead()`.** `joinSingletonPosixRead` now wraps the FIRST call
to `startRead()` in a `try/catch`, mapping a synchronous throw to the same `{outcome:"rejected"}` shape a
rejected promise already produces — previously, a synchronous (non-`async`) throw would propagate as a
rejection of `joinSingletonPosixRead`'s OWN returned promise, and since the uptime call site
(`enumerateProcessesPosix`) deliberately does not await that promise until after the per-pid loop (see
"The ordering bug" above), that rejection could sit without a handler attached for a real stretch of wall
time. RED-proofed by removing the `try/catch`: a new scenario injecting a plain (non-`async`)
synchronously-throwing `readBootTimeMs` showed the WHOLE enumeration incorrectly reject (rather than
degrade `creationTime` to `null` as it must) once the guard was removed — the more direct and reliable
signature of this bug in practice than the `unhandledRejection` listener this scenario also carries
(which did not independently discriminate in this exact test's timing, since `Promise.all` ends up
subscribing to the promise quickly enough regardless — kept anyway as a documented expectation, not
removed, since it is not a false assertion, just not uniquely diagnostic here).

## Do not

- Do not go back to a per-pid-shaped mechanism for either of these two reads — they have no pid key; a
  single shared slot per resource (`posixReaddirSlot`/`posixUptimeSlot`) is the correct shape, not a Map.
- Do not fall back to `enumerateProcessesPosixViaPs` on a readdir TIMEOUT (only on a CONFIRMED rejection)
  — the real read might still resolve fine a moment later for another caller; falling back on a mere
  timeout would be guessing, not failing closed.
- Do not write a test assertion that depends on whether THIS host has a real `ps` binary — a rejecting
  readdir's ps-fallback RESOLVES on a host that has one (ubuntu-latest) and REJECTS on one that doesn't
  (the win32 dev host), so `settled === "rejected"` is not a platform-agnostic assertion. Inject
  `psFallback` and assert the INJECTED fallback was called instead.
- Do not let `checkRootSurvival` treat an absent root in a JOINED (possibly stale) listing as "confirmed
  gone" — a listing joined from an already-in-flight readdir may predate this call's own entry, so absence
  in it proves nothing about right now. Check `POSIX_LISTING_JOINED_STALE` and report it like any other
  enumeration failure instead. Do not add the equivalent check to `reapProcessesRootedInWorktree`/
  `attributeProcessesToWorktree` — an absent pid there already gets the safe answer regardless.
- Do not call `startRead()` outside a `try/catch` inside `joinSingletonPosixRead` — a synchronous
  (non-`async`) throw must map to `{outcome:"rejected"}`, or it escapes as a rejection of a promise this
  function's own callers (the uptime call site, deliberately) may not await for a real stretch of time.
- Do not AWAIT the uptime read before the per-pid loop — that was a real regression caught before this
  card landed (see "The ordering bug" above): it lets a hung/slow uptime read consume the whole shared
  deadline, turning a best-effort field's failure into every row reading `readUnverified`. Kick it off
  early, join it only after the per-pid loop, and backfill `creationTime` afterward.
- Do not tag the uptime guard's timeout as `timedOut:true` or let it reject — it must degrade to
  `bootTimeMs: null` exactly like the pre-existing internal-catch path, never propagate a failure.
- Do not test the uptime-ordering regression with an instantly-resolving (microtask-fast) fake per-pid
  reader — it wins even a ~1ms starved race before any timer fires, silently masking the regression. Use
  a real (if tiny) `setTimeout` delay in that specific scenario's injected reader.
- Do not reorder this test file's scenarios without re-deriving the ordering constraint stated in its own
  header — the two "permanently hangs a resource" scenarios must stay last, since there is no pid key to
  give a later scenario its own isolated resource instance.
