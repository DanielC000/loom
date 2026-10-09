# 49186d90 — a loud (but NOT durable) signal when a POSIX singleton `/proc` read stays stuck

## Narrative

Follow-up to `21f6175c`/`2b7df434`: a pending `readdir("/proc")` or `/proc/uptime` read is NEVER evicted
by design — a later call simply JOINS it. So one permanently-stuck read makes every later POSIX
enumeration fail closed (`timedOut`) or silently degrade `creationTime` to `null`, with the only trace
being a per-call "possibly hung" log line at whichever consumer's own catch block happened to be looking.
Nothing names "this is the SAME resource, still stuck, for a while now."

## The fix — a per-episode counter inside `joinSingletonPosixRead`

Each slot (`posixReaddirSlot`/`posixUptimeSlot`) now carries an `episode: {startedAt, timeoutHits,
signaled} | null` alongside `current`. An episode is created only when a fresh read starts, and cleared
(together with `current`) the instant that read settles — the clear IS the re-arm: a later, different
stuck read always gets a brand-new, unsignaled episode. Every call that joins the pending read and times
out against its own deadline increments `episode.timeoutHits`; once that crosses
`POSIX_SINGLETON_STUCK_SIGNAL_THRESHOLD` (3) and the episode hasn't already signaled, exactly one
`console.error` fires naming the resource (`label`) and how long it's been pending
(`Date.now() - episode.startedAt`). `signaled` then stays `true` for the rest of that episode's life, so
it never fires twice for the same stuck read — only a genuinely later, different stuck read (a fresh
episode) can signal again.

This is a pure side-channel: it never evicts the pending read, never starts a second one, and the
function's returned `{outcome, value?, joined}` shape is byte-identical to before this card.

## Log-only, deliberately — NOT a durable event

`joinSingletonPosixRead`/`enumerateProcessesPosix` and the three consumers
(`checkRootSurvival`/`reapProcessesRootedInWorktree`/`attributeProcessesToWorktree`) are module-level free
functions, not `PtyHost` methods — they have no `this.events` (`PtyHostEvents`) and no db handle. The only
existing durable-event mechanism in this file is reached several layers above these functions, from
`PtyHost` instance methods; threading an event emitter down through `joinSingletonPosixRead` →
`enumerateProcessesPosix` → `enumerateWithRetry` → `withReapTimeout` → the three consumers would mean new
parameters on multiple shared, kill-path-adjacent exported function signatures — real scope creep for this
fix, and exactly the kind of widening the `21f6175c`/`2b7df434` "Do not" lists are defending against.

**The signal this card adds is a `console.error` daemon-log line ONLY.** It is not recorded as an
orchestration event, written to any table, or queryable after the fact — a human watching the daemon's
log is the only consumer. Do not read "card 49186d90 shipped" as "a durable signal exists" — it does not,
and a future card wanting a durable version needs to actually thread an event sink through the chain
above, which this card deliberately did not do.

## The threshold is asymmetric across the two slots — measured, not inferred

`POSIX_SINGLETON_STUCK_SIGNAL_THRESHOLD` is one shared constant (3) for both slots, but it is NOT crossed
by the same number of *consumer* calls for both, because `enumerateWithRetry` (`REAP_ENUMERATE_MAX_ATTEMPTS
= 2`) retries ONLY a `timedOut:true` rejection, and only readdir's timeout branch throws one —
`enumerateProcessesPosix` never throws for a stuck uptime read; it degrades `creationTime` to `null` and
returns normally (see `21f6175c`'s own doc). So:

- **A stuck READDIR** crosses the threshold within its SECOND consumer call: call 1's own attempt races
  the slot and times out (hit 1), `enumerateWithRetry` retries once in-call and times out again (hit 2),
  then call 2's first attempt is the 3rd hit — the signal fires mid-way through call 2, not after it.
- **A stuck UPTIME** never triggers a retry (no throw), so it takes exactly ONE join per consumer call —
  a full THIRD separate consumer call is needed to cross the threshold.

This was measured empirically, not inferred from reading the retry loop alone: both permanent-hang
scenarios in `packages/daemon/test/pty-posix-enumeration-stuck-signal.mjs` drive the real
`reapProcessesRootedInWorktree` → `enumerateWithRetry` → `enumerateProcessesPosix` path (fake `kill`,
injected `PosixEnumerationDeps`, never the bare `ProcessEnumerator` seam — same pattern `21f6175c`'s own
test uses for its end-to-end scenario) and assert the exact call at which the signal first appears for
each resource, confirming the counts above.

## Test seam and coverage

`packages/daemon/test/pty-posix-enumeration-stuck-signal.mjs`, run alone, no real `/proc`/`ps`/kill
access. Scenario order is load-bearing for the same reason `21f6175c`'s own test states: these are
process-wide singleton slots with no key, so a scenario that permanently hangs a resource poisons it for
every later scenario in the file. Order: (1) readdir slow-then-settling below threshold — no signal, (2)
uptime slow-then-settling below threshold — no signal, (3) uptime permanent hang via the real
`reapProcessesRootedInWorktree` path — no signal after call 1 or 2, exactly one signal after call 3, still
exactly one after a 4th call (once-only), (4) readdir permanent hang via the same real path, run LAST
(readdir is also a prerequisite for scenario 2's own listing) — no signal after call 1 (2 hits), exactly
one signal during call 2 (3rd hit), still exactly one after a 3rd call.

RED-proofed via a stricter mutation, never an early return: temporarily removing the `!episode.signaled`
guard made the "signals exactly once" assertions in scenarios 3 and 4 fail (the signal fired on every
subsequent timed-out join past the threshold instead of once), then the guard was restored.

## Do not

- Do not thread a `PtyHostEvents`/db-backed event through `joinSingletonPosixRead` or
  `enumerateProcessesPosix` as a quick way to make this "durable" — see the "Log-only, deliberately"
  section above; that needs its own card that actually plumbs an event sink through the shared consumer
  signatures, not a bolt-on here.
- Do not read this card's signal as covering the per-pid dedup slot (`posixInFlightPidReads`, `2b7df434`)
  — explicitly out of scope; no equivalent stuck-signal exists there.
- Do not assume `POSIX_SINGLETON_STUCK_SIGNAL_THRESHOLD` means "3 consumer calls" for both slots — it is
  ~2 consumer calls for readdir (the in-call retry doubles its join count) and exactly 3 for uptime (no
  retry ever fires for it). Re-measure via the real consumer path if this constant, or
  `REAP_ENUMERATE_MAX_ATTEMPTS`, ever changes.
- Do not let two different pending reads share one `episode` object — the settle-triggered clear is what
  re-arms the signal for a later, different stuck read; skipping it would leave a `signaled:true` from a
  past episode permanently silencing a future one.
- Do not widen this to change `joinSingletonPosixRead`'s returned outcome shape, evict a pending read, or
  start a second read for an already-pending resource — this card is a pure side-channel log line, nothing
  else about the `21f6175c`/`2b7df434` behavior changes.
