# df32be98 — one shared kill latch for both the memory-ceiling kill and the wedge kill

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

## Do not

- Never issue a second `kill()` on a child pid before its exit is observed — route every "this child
  needs to die" decision through `issueChildKill`, never a bare `child.kill()` call.
- Do not give the memory-ceiling kill and the wedge kill separate latches — one shared `childKillPid`
  field is the point: two kill sites for one child must agree on whether a kill is already in flight.
- Do not increment `consecutiveHealthFailures` (or otherwise treat a dying, already-latched child's
  non-answer as new wedge evidence) while `childKillPid` is latched for the current pid.

## Source

`packages/daemon/src/codescape/supervisor.ts`: the `childKillPid` field doc, `issueChildKill`,
`isChildKillLatched`, the early-return in `checkMemoryCeiling`, the early-return + kill-site change in
`probeHealth`, and the `onDeath`/`start()`/`stop()` latch resets inside `wireDeathHandling`/`start`/`stop`.
