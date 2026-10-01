
# 2fd55955 — `spawnWorker`/`recycleWorker`/`recycleManager`'s post-spawn-success bookkeeping is best-effort

Code Review of `40738f24` (reviewer `5d6b0561`) found that after a successful spawn, several bookkeeping
steps still ran unguarded: `spawnWorker` (the task's active-lane move, `appendEvent(spawn_worker)`, the
revive `appendEvent(worker_revived)`, the wasted-dispatch advisory); `recycleWorker`
(`appendEvent(recycle_complete)` and the reparent/carry steps); `recycleManager`
(`appendEvent(recycle_complete)` and its own reparent/carry steps). A DB error in any of these made
`worker_spawn`/`worker_recycle`/`recycle_me` throw and report FAILURE over a session that was already
live — risking a manager double-dispatching (a second worker on the same task, or a second recycle
successor), the exact class `72c58b1c`/`40738f24` closed for `discovery_block_injection` and `onBusy`.

## Round 1 — the fix, as it first landed (commit `9a0d06a6`)

Two small shared helpers (`bestEffortPostSpawn`/`bestEffortPostSpawnResult`, next to
`recordDiscoveryBlockInjection`) wrapped every one of these steps — in ALL THREE methods, including
`recycleManager`'s own reparent/carry calls — logging on throw, never rethrowing.

## Round 2 — Code Review of `9a0d06a6` (reviewer `6252dfd0`) REPRODUCED a Critical regression

**Round 1's blanket treatment of `recycleManager` was wrong.** A swallowed `reparentLiveWorkers` failure
let `settleRecycleHandoff` hard-stop the predecessor anyway — stranding its live workers under a now-dead
manager, SILENTLY: the successor's kickoff claimed they were re-parented, worker reports boarded to the
dead predecessor, resume/crash-recovery both refused (`hasSuccessor`), and `recycle_complete` recorded 0.
**On main (pre-Round-1), the same failure was LOUD instead**: `recycleManager` threw, the predecessor
stayed alive, nothing was stranded — worse-looking (a thrown error) but strictly safer than Round 1's
silent handoff.

**THE RULING, and why it's asymmetric across the three methods:**

- **`recycleManager`'s OWNERSHIP-TRANSFER steps** (`reparentLiveWorkers`/`Wakes`/`Questions`/
  `EventTriggerTargets`/`PollJobTargets`/`WebhookTargets`/`PendingOwnerMessage`, `capQueue.reparent`, the
  carry block) are reverted to throwing (unwrapped) — Round 1's wrapping is undone for these specifically.
  **The reason this one method is different**: `recycleManager`'s predecessor is stopped LATER, by
  `settleRecycleHandoff`, running ASYNCHRONOUSLY and INDEPENDENTLY of whether ownership transfer succeeded
  — so swallowing a transfer failure there doesn't prevent the predecessor's eventual death, it just makes
  that death silently take the un-reparented fleet down with it. Only `recycleManager`'s PURE BOOKKEEPING
  (`appendEvent(recycle_complete)`, `recordDiscoveryBlockInjection`) stays best-effort — this is the card's
  literal, original scope, and the ONLY part of `recycleManager` Round 1 should have touched.
- **`recycleWorker`'s own reparent/carry/event steps STAY best-effort** (the reviewer agreed this part of
  Round 1 is a strict improvement) — because `recycleWorker`'s predecessor is ALREADY hard-stopped,
  SYNCHRONOUSLY, before any of these steps run (`this.pty.stop(workerSessionId, "hard")` + a wait loop,
  near the top of the method). There is no later, independent death these steps could silently race —
  the predecessor's fate is already sealed either way, so best-effort there creates no new stranding risk.
  **Exception**: a failed `carryPendingToSuccessor` must not go fully silent — see below.
- **`spawnWorker`'s steps are unaffected by this correction** — nothing in `spawnWorker` stops a
  predecessor asynchronously; there is no equivalent risk. They stay best-effort as Round 1 shipped them.

**Three narrower fixes alongside the ruling:**

1. **`recycleWorker`'s failed carry is surfaced, not swallowed.** A failed `carryPendingToSuccessor` can
   leave the predecessor's queued messages partially or wholly undelivered to the successor — the manager
   is now notified via a durable nudge (`enqueueDurableNudge`, counts only, mirroring `7b1fda57`'s own
   carried-queue notice shape but without reproducing its full quoted-content apparatus, since here the
   failure mode is "maybe lost", not "definitely queued and now orphaned").
2. **The carry block's two reads are reordered in BOTH `recycleWorker` and `recycleManager`**:
   `db.listUnresolvedQueuedMessagesForWorker` now runs BEFORE `pty.flushPending`, not after — so a DB-read
   failure can never leave the in-memory queue already destructively drained with nothing captured from it.
   This applies regardless of whether the surrounding step throws or swallows.
3. **`spawnWorker`'s capacity fallback is `null`, never an all-zero object.** An all-zero `{cap:0,live:0,
   inFlight:0,free:0}` on a transient read failure is FALSE DATA — indistinguishable from "the fleet is
   genuinely full" and could make a manager wrongly stop dispatching. `null` means "unavailable right now";
   every reader (there is exactly one production consumer, the `worker_spawn`/`worker_revive` MCP
   handlers, which just spread the field through) handles it as a plain nullable JSON value. Also: this
   step uses a new SYNCHRONOUS best-effort helper (`bestEffortPostSpawnResultSync`), since
   `getWorkerCapacity` is itself synchronous — wrapping it in the async variant added a needless
   event-loop yield to what should stay an atomic tail.

## ⛔ CORRECTED — the two bullets below were FALSE as originally written

The original "Do not" section claimed a failed reparent/ownership-transfer step is harmless to swallow,
and that reverting any of these steps to throwing would be a regression. **Both claims are false for
`recycleManager`'s ownership-transfer steps specifically** — see Round 2 above. They were true, and remain
true, for every OTHER step this card covers (every `spawnWorker`/`recycleWorker` step, and
`recycleManager`'s own `appendEvent(recycle_complete)`/`recordDiscoveryBlockInjection`).

## Do not

- Do not make `recycleManager`'s OWNERSHIP-TRANSFER steps (reparentLiveWorkers/Wakes/Questions/
  EventTriggerTargets/PollJobTargets/WebhookTargets/PendingOwnerMessage, capQueue.reparent, the carry
  block) best-effort again — `settleRecycleHandoff` stops that predecessor independently of whether
  transfer succeeded, so swallowing a failure there silently strands live workers under a dead manager.
  Only its pure bookkeeping (`appendEvent(recycle_complete)`, `recordDiscoveryBlockInjection`) is
  best-effort.
- Do not roll back a spawn/recycle (kill the session, mark it exited, report failure) for a failure in any
  step that IS best-effort per this record — that reopens the orphan-pty defect `40738f24` closed.
- Do not let `recycleWorker`'s `carryPendingToSuccessor` fail silently — notify the manager via
  `enqueueDurableNudge` (counts only, never message content) when it does.
- Do not reorder the carry block's two reads back to flush-before-DB-read in either `recycleWorker` or
  `recycleManager` — the DB read must run first so a failure there can't leave the in-memory queue
  destructively drained with nothing captured.
- Do not revert `spawnWorker`'s capacity fallback back to an all-zero object — that is false data
  indistinguishable from a genuinely full fleet; use `null` and the synchronous best-effort helper.
- Do not add a NEW post-spawn-success step to `spawnWorker`/`recycleWorker` without routing it through
  `bestEffortPostSpawn`/`bestEffortPostSpawnResult`/`bestEffortPostSpawnResultSync` — an unguarded addition
  is a regression of this card. For a NEW step in `recycleManager`, first ask whether it's pure bookkeeping
  (best-effort) or an ownership-transfer step the predecessor's eventual stop depends on (must throw) —
  do not assume best-effort by default there.
