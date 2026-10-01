
# 40738f24 — `reconcileFailedSpawn` hard-kills a still-alive pty instead of marking the row 'exited' over it

Round-2 Code Review of `72c58b1c` (reviewer `aeae8525`) found two follow-ups that card's own Round 3
deliberately left open, each its own card:

1. **ORPHAN**: when `PtyHost.spawn` throws AFTER `createPty` has already registered a genuinely live
   process (e.g. a future post-spawn step that throws, the same shape `72c58b1c` fixed for the one known
   trigger — `onBusy` persistence, via `persistBusy`), `SessionService`'s catch calls
   `reconcileFailedSpawn`, which used to mark the session row `exited` unconditionally — with no regard
   for whether `this.pty` still had a real, running process behind that row. That stranded an orphan live
   pty under a dead row on EVERY spawn site that reaches `reconcileFailedSpawn`.
2. **TWO-PATH ASYMMETRY**: `72c58b1c` guarded only `startNew`'s own `discovery_block_injection`
   `appendEvent` call (best-effort try/catch). The four siblings — `startManager`, `spawnWorker`,
   `recycleWorker` (`recycle`), `recycleManager` — were still unguarded: a DB failure recording that
   purely-informational event could make a genuinely successful spawn look like a failed one.

## The fix

**Item 1 — kill, don't just mark.** `reconcileFailedSpawn(sessionId, e)` now checks
`this.pty.isAlive(sessionId)` first and, if true, hard-kills it (`this.pty.stop(sessionId, "hard")`,
wrapped in its own try/catch so a kill failure can never mask the original spawn error) BEFORE writing
`processState:"exited"`.

**Decision: kill the live pty, never "keep the row live and stop rethrowing."** The alternative the card
posed — leave the row live, treat the spawn as having succeeded — would require this catch to stop
rethrowing, which breaks `live-flip-reconcile-guard.mjs`'s structural invariant: every live-flip call
site's catch must reconcile-then-throw, and every caller in `sessions/service.ts` (`startNew`,
`startManager`, `spawnWorker`, `recycleWorker`, `recycleManager`, `resume`, `fork`, boot-reconcile — all
14+ live-flip sites) depends on "a spawn call throws ⟺ no live session resulted", including webhook
ingress's own dedupe-undo rule (`72c58b1c`'s own "Do not"). Killing preserves that invariant
unconditionally, for every caller, without special-casing any one of them — because `reconcileFailedSpawn`
is the ONE shared helper every one of those sites already funnels through.

**Item 2 — one shared writer.** Extracted `recordDiscoveryBlockInjection(event, codescapeStatus)`, ONE
best-effort writer (try/catch, logs on failure, never throws), and folded all five sites that compute a
`codescapeStatus` onto it — `startNew`'s own call site included, so there is exactly one copy of this
shape, not five.

## Safety precondition (Code Review `5d6b0561`)

`reconcileFailedSpawn` may only ever be called with an id that (a) THIS spawn attempt itself just
minted/live-flipped, or (b) one that `isAlive`-short-circuited BEFORE the live-flip — `resume()`'s
`if (this.pty.isAlive(session.id)) return session;` returns with no throw possible on that path, so this
helper is never actually reached for an already-alive id resume() was asked to resume. The reviewer
confirmed, across all 14+ real call sites in the file, that the kill can never hit a PRE-EXISTING pty
belonging to a different attempt: 13 sites mint a fresh UUID before ever reaching the try/catch, and
`resume()`'s liveness check runs synchronously before its own live-flip. Never call this helper with an id
whose live pty might belong to a DIFFERENT, unrelated attempt — the kill has no way to distinguish "my own
just-spawned orphan" from "someone else's live session" and would kill either indiscriminately.

## Scope: which throws this actually covers

The fix holds for any throw occurring once `pty.onExit(cb)` has already been registered inside
`PtyHost.spawn()` — true for every realistic post-spawn step (they all run after that registration,
several statements later in the same method) — but NOT for a throw in the narrow window between
`this.live.set(...)` and that registration. A `kill()` issued in that window still terminates the real
process (`pty.kill()` doesn't depend on a JS-level listener being attached), but `PtyHost`'s own exit
bookkeeping (`events.onExit` — archiving, transcript snapshot, etc.) may not run for it, since that
callback is wired through the very `pty.onExit(cb)` registration that never completed. The row still ends
up `exited` either way (`reconcileFailedSpawn`'s own `db.setProcessState` write is unconditional), so the
DB is never wrong — only the downstream `events.onExit` side effects are the part this fix doesn't
guarantee for that one narrow window.

## `onRunSessionExit` interaction (MINOR-1)

`startRun`'s catch calls `reconcileFailedSpawn(session.id, e)` BEFORE its own
`this.db.failRun(runId, "run spawn failed before it could start: ...")`. If `reconcileFailedSpawn`'s new
kill path fires (pty was genuinely alive), the kill's `onExit` can invoke `onRunSessionExit` — synchronously
on the test seam's fake pty, asynchronously on a real one — landing on a run whose status may or may not
yet be `"failed"` depending on that ordering. `onRunSessionExit` now early-returns when `run.status ===
"failed"`, so it can never overwrite `startRun`'s precise error with the generic "run session exited
before submit_result" message, and never re-runs the usage-capture/webhook-fire teardown for a run that
never had a real engine session.

## Do not

- Do not revert `reconcileFailedSpawn` to an unconditional `db.setProcessState(id, "exited")` — that
  reopens the orphan-pty defect this card exists to close.
- Do not call `reconcileFailedSpawn` with an id whose live pty might belong to a different, unrelated spawn
  attempt — see the safety precondition above; verified only for the shapes the real corpus uses today.
- Do not claim this fix holds for a throw in the window before `pty.onExit(cb)` is registered inside
  `PtyHost.spawn()` — it does not, for the reason stated above; state that scope explicitly if this is ever
  revisited, don't round it up to "any post-spawn throw."
- Do not widen `onRunSessionExit`'s early return beyond `run.status === "failed"` without re-checking
  whether a `completed`/`cancelled`/`timed_out` run can still legitimately reach this method afterward (it
  can, for the ordinary pty-exit-after-terminal-run case) — the existing guard already excludes those three;
  this fix adds exactly the one status it was missing.
- Do not re-derive the "which of the 14+ spawn sites can this hit" answer by hand next time — the invariant
  is structural (`live-flip-reconcile-guard.mjs`), not a manually-maintained list.
