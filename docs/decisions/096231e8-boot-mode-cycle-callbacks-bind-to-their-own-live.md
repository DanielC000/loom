# 096231e8 — boot mode-cycle callbacks compare the Live by IDENTITY, not just by `sessionId` lookup

## Context

Found by Code Review `c0d13943` as a round-2 delta on `850eb55c` (pre-existing before that card, not
reproduced live): the boot cycle's `onDone` (passed to `cycleToMode` from `deliverHook`'s `SessionStart`
case) and `runCycleToMode`'s `decide`/`awaitChange`/`awaitReadable` closures all resolved "the session" via
a fresh `this.live.get(sessionId)` at the moment each fired, instead of holding the specific `Live` the
cycle actually started on.

`sessionId` stays stable across a same-id respawn (resume/fork/recycle) — `spawn()` overwrites the map
entry for that key with a brand-new `Live`, but an in-flight async chain tied to the old key keeps running
regardless (unlike `readyFallbackTimer`/`dialogStuckTimer`, it has no single stored handle `spawn()` can
clear). A respawn landing within ~one poll tick of an in-flight boot cycle could let the OLD generation's
cycle read the NEW generation's footer, press Shift+Tab into it, and — via `releaseBootModeCycle` —
`markReady` it before its OWN cycle converged.

## Decision

Capture the `Live` a cycle actually started on, once, and compare every subsequent lookup against it by
**identity** (`===`), never merely checking that `this.live.get(sessionId)` returns something truthy:

- `runCycleToMode` takes `startLive: Live` as a PARAMETER, bound by its caller `cycleToMode` at QUEUE time
  (the `live` `cycleToMode` already holds, before queueing onto `Live.modeCycleChain`) — never re-derived
  via `this.live.get(sessionId)` when the queued link actually RUNS (see Round 2 for why queue-time, not
  run-time, binding matters). Its `decide`/`awaitChange`/`awaitReadable` closures still re-derive `live`
  fresh (they need the current ring/footer state), but check `live !== startLive` right after the existing
  `alive`/`killed` checks, finishing with reason `"respawned"` instead of acting on a generation this cycle
  was never driving.
- The boot cycle's own `onDone` closes over the `live` it already set `startupCycleInFlight = true` on, and
  checks `this.live.get(sessionId) === live` before clearing that flag or calling `releaseBootModeCycle` —
  a mismatch is a silent no-op, leaving the NEW generation's own boot-cycle lifecycle untouched.

## Round 2 (Code Review b607eccf) — queue-time binding, retry, kickoff-delivery gaps

Round 1 still re-derived identity in three further places, each independently reachable by a respawn:

1. **`runCycleToMode`'s `startLive`** was captured at ENTRY (run time), not queue time. A link queued
   behind an in-flight cycle on the SAME `modeCycleChain` (e.g. a manual `setPermissionMode` override
   queued behind the boot cycle) only runs once its predecessor settles — a respawn can land in between,
   silently REBINDING the link to the NEW generation (reproduced live: landed 2 real Shift+Tabs on gen2,
   unserialized against its own boot cycle). Fixed: `cycleToMode` passes its OWN already-captured `live`
   into `runCycleToMode` as `startLive`.
2. **`cycleToModeWithRetries`** re-read `this.live.get(sessionId)` in its `onDone` with no identity check,
   so a "respawned" miss looked like an ordinary dropped-keystroke miss and triggered a RETRY against the
   new generation. Lead ruling: a mode request bound to one generation never carries over to a respawn — it
   boots to its own resolved target instead. Fixed: an optional `boundLive` threads through the retry
   recursion, identity-checked before each `cycleToMode` call and in `onDone`; a mismatch resolves
   `"unknown"` with NO retry.
3. **`logLandedMode`** (post-ready read + plan auto-heal) and its `onSettled` → `scheduleKickoffGuarantee`
   both re-derived `this.live.get(sessionId)` independently of the `Live` `markReady` ran on — a respawn
   mid-read could heal-cycle the new generation, or deliver the OLD generation's captured kickoff text into
   the NEW one (`onSettled` unconditionally fires `scheduleKickoffGuarantee`). Fixed: both now take the
   `live` `markReady` captured, re-checking identity before reading/healing and before any write.

## Do not

- Do not compare only `this.live.get(sessionId)` for *existence* — a same-id respawn makes that pass while
  returning a different generation's `Live`. Compare by identity against the Live the cycle started on.
- Do not add a cancellable timer/handle instead of the identity check — `runCycleToMode` is a chain of ad
  hoc `setTimeout`s, not a single timer; a handle would need re-threading through every step.
- Do not remove the identity check on the theory that `Live.modeCycleChain` already serializes cycles per
  session — that chain only prevents two cycles racing EACH OTHER, not a cycle outliving the Live it was
  queued on.
- Do not conflate this with `850eb55c`'s `startupCycleInFlight` gate — that stops OTHER write paths
  interleaving with an in-flight cycle's writes; this stops the cycle writing into the wrong generation at
  all. Both are needed.
- Do not let `runCycleToMode` re-derive `startLive` at run time — bind it at QUEUE time (the caller
  `cycleToMode`'s own `live`), or a queued link silently rebinds to whatever generation is current once its
  turn comes up.
- Do not let `cycleToModeWithRetries` retry a mode request onto a respawned generation — a "respawned" miss
  is not a dropped-keystroke miss; bind the retry chain to the generation it started on, resolve `"unknown"`
  with no retry on a mismatch.
- Do not let `logLandedMode` or `scheduleKickoffGuarantee` re-derive `this.live.get(sessionId)`
  independently of `markReady` — bind both to the SAME Live `markReady` ran on, or a respawn mid-read can
  heal-cycle, or deliver a stale kickoff into, the wrong generation.
