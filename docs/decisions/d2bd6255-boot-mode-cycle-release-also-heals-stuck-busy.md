# d2bd6255 — `releaseBootModeCycle` also calls `healIfStuck`, not only `drainPending`

## What was wrong

`releaseBootModeCycle` is the direct-drain path off a boot permission-mode cycle's own `onDone` (see
`850eb55c`) — it is supposed to deliver a held kickoff promptly once the cycle converges, without ever
depending on `reconcile()`'s periodic tick. But it called `drainPending` alone, and `drainPending` refuses
to run while `live.busy` is true.

For a session whose real first turn never started (the readiness-fallback / dialog-held path this whole
mechanism exists for), the ONLY thing that ever clears that stuck `busy` is `healIfStuck`
(`FIRST_TURN_STALE_MS`-gated), and the only call site reachable without `reconcile()` is the one inside
`enqueueStdin` — triggered once, by `scheduleKickoffGuarantee`, right when it decides to queue the kickoff
instead of writing it directly (i.e. near the START of the boot mode cycle, before a single Shift+Tab has
been pressed). Whether that single check clears `busy` depends entirely on whether `FIRST_TURN_STALE_MS`
had ALREADY elapsed by that early moment — pure incidental timing, unrelated to the cycle that follows.
Nothing else ever re-checks staleness afterward. So if `busy` was still "fresh" at that one early check, it
stays stuck true forever, even though the cycle itself (settle + press + poll, by design hundreds of ms)
has long since made it genuinely stale by the time `releaseBootModeCycle` actually runs.

Measured directly (card `d2bd6255`): on native Windows, enough wall-clock elapses before that early check
that it reliably self-heals (`afterMs=182` observed) and the kickoff delivers. On Linux (both GitHub
Actions `ubuntu-latest` and a real WSL Ubuntu-22.04 host), the same early check consistently lands before
`FIRST_TURN_STALE_MS` has elapsed, `busy` never clears, and `kickoff-readiness-fallback.mjs`'s scenario
(4e) hangs — `waitUntil` timed out at 5x its budget (10s), not a marginal flake. This is a genuine,
deterministic product race, not a CI-only timing fluke — it was reproduced 1-for-1 across every WSL run.

## The fix

`releaseBootModeCycle` now calls `this.healIfStuck(live, sessionId)` immediately before
`this.drainPending(sessionId)`, mirroring the exact pairing `reconcile()` already uses. By the time the
boot mode cycle has actually converged, real wall-clock time has elapsed since spawn — so this check, run
at the right moment instead of relying on an earlier, incidental one, reliably observes the session as
stale and heals it.

## Do not

- Do not assume `enqueueStdin`'s own `healIfStuck` call (fired when `scheduleKickoffGuarantee` queues
  instead of writing directly) is sufficient to heal a stuck `busy` for the boot-mode-cycle path — it
  fires too early (before the cycle itself runs) to reliably observe staleness.
- Do not reintroduce a drain call that skips `healIfStuck` on this path on the theory that `reconcile()`
  will eventually catch it — the whole point of `releaseBootModeCycle`'s direct-drain design (`850eb55c`)
  is to deliver WITHOUT depending on `reconcile()`'s periodic tick.
