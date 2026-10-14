# c30293ae — `recycleWorker` holds the same `inFlightSpawnTaskIds` claim `spawnWorker` does

## The gap

`docs/decisions/641cc62c-*.md` closed spawn-vs-merge/batch (both directions) and recycle-vs-merge/batch
(the recycle-INITIATES direction — `claimTaskWorktreeRefusal` refuses a `recycleWorker` call while a merge
is already in flight) but explicitly left one direction open as a known residual: a
`confirmWorkerMergeTracked`/`mergeBatchTracked` mint targeting a worker whose OWN `recycleWorker` call is
itself already in flight.

From the instant `recycleWorker`'s own `claimTaskWorktreeRefusal` pre-check passes, through the
predecessor's hard-stop + verify + `retireSiblingSessionsForTask`, until the fresh successor's row flips to
`'live'`, `recycleWorker` registered nothing in `inFlightSpawnTaskIds`/`claimedWorktreePaths`/
`inFlightMergeTaskIds` — unlike `spawnWorker`, which marks its own claim synchronously before its first
await. `spawnMintConflict` (the predicate `confirmWorkerMergeTracked`'s `onOpMinted` calls) therefore read
completely clean for the whole window, even though the predecessor was already confirmed dead and the
successor didn't exist yet — `liveSessionIdForTask(taskId)` was `undefined` on both sides. A confirm landing
in that window minted and ran its gate against the SAME worktree `recycleWorker` was mid-swap on. Reproduced
hermetically (no blind sleeps — a monkeypatched pause point + a polled gate-start marker) in
`packages/daemon/test/recycle-merge-reverse-race.mjs`: both the merge (task → `done`) and the recycle (a
fresh live successor on that same already-merged worktree) completed, uncoordinated.

## Round 1 fix (incomplete — see Round 2)

`recycleWorker` added `taskId` to `inFlightSpawnTaskIds` right after its own `claimTaskWorktreeRefusal`
pre-check passed, and released it in the method's existing outer `finally`. This closed the collision this
card set out to fix, but Code Review `4cae0fd4` found the add was positioned too early relative to the
`try`/`finally` that released it.

## Round 2 (Code Review `4cae0fd4`): one Major leak, one Minor race, a wording nit

**MAJOR — the claim leaked on a throw between the add and the `try`.** The round-1 add sat well ABOVE the
`try { ... } finally { ... }` block that released it — several statements (the project lookup, `!project`,
`resolveConfig`/`resolveAgentSpawn`, `appendEvent(recycle_begin)`, `listUnresolvedQueuedMessagesForWorker`
— card `2fd55955` explicitly designs for that one throwing — `flushPending`, `suppressCapQueueDrain`) ran
AFTER the claim was minted but BEFORE the `finally` that would ever release it. A throw from any of them left
the claim held in memory until a daemon restart: the task became unmergeable (every confirm refused "already
in flight") and unspawnable (every `worker_spawn` refused the same way) with no path to recover short of a
restart. **Fixed** by moving the add to directly above the `try {` line — verified (by reading the span, not
assumed) that no `await` sits between the `claimTaskWorktreeRefusal` check and `try {`, so moving the add
down to immediately precede `try` closes the leak without opening any new window: every one of those
intermediate calls now runs BEFORE the claim exists at all, so a throw from any of them has nothing to leak.

**MINOR — make it a real mutex.** Without a check paired with the add, a SECOND `recycleWorker` call for
the SAME predecessor, landing while the first is still mid-swap, would `.add()` the SAME `taskId` a second
time — harmless for the Set itself (idempotent), but it let the FIRST call's own `finally` release a claim
the SECOND call (now also past its own add, still mid-flight) still needed, reopening the exact race this
whole card closes. This duplicate-recycle window exists specifically because `hasSuccessor(workerSessionId)`
— the pre-existing anti-double-recycle guard at the top of the method — stays `false` until `insertSession`
runs, well after the claim is minted. **Fixed** by pairing the add with a `has()` check immediately before
it: `if (this.inFlightSpawnTaskIds.has(taskId)) throw ...` — a second concurrent recycle of the same
predecessor is now refused with a clear, retryable error, exactly mirroring `spawnWorker`'s own identical
mutex shape for the ordinary spawn case.

**NIT — refusal wording.** `spawnWorker`'s own refusal and `spawnMintConflict`'s conflict string both said
"a spawn" when the claim could now also be held by a recycle. Reworded to "a spawn or recycle ... is already
in flight" in both places. Two existing assertions in `merge-spawn-task-in-flight.mjs` (scenarios 9 and 10)
asserted the old exact wording and were updated to match; no other test in the repo referenced either exact
string (verified by a repo-wide grep before and after the change).

## The fix (current, Round 2)

`recycleWorker` holds the claim like this, read top to bottom:
1. `claimTaskWorktreeRefusal(taskId, old.id)` — unchanged, the pre-existing 641cc62c guard (merge-in-flight
   / live-elsewhere refusal).
2. Every side-effect-free lookup that can still legitimately throw (project/config/agent/workerSpawn
   resolution, `recycle_begin`'s `appendEvent`, the predecessor's queued-message read, its pending-queue
   flush) — unchanged in position, now entirely BEFORE the claim exists.
3. The mutex check + refusal throw FIRST (`if (taskId && this.inFlightSpawnTaskIds.has(taskId)) throw ...`),
   deliberately BEFORE `suppressCapQueueDrain` — a refused duplicate must never engage suppression it has
   no way to lift (it never reaches the `finally` that would). Then `suppressCapQueueDrain(managerSessionId)`,
   then the add (`if (taskId) this.inFlightSpawnTaskIds.add(taskId)`) immediately above `try {`, with
   nothing throw-capable between the add and the try.
4. The `try`/`finally` itself, unchanged from round 1: every exit through it (the early "predecessor might
   still be alive" throw, `reconcileFailedSpawn`'s catch-and-rethrow, the normal success path) releases the
   claim in the SAME `finally` that already clears `recycleTeardownInFlight` and calls
   `unsuppressCapQueueDrain`/`maybeDrainCapQueue` — released BEFORE `maybeDrainCapQueue`, not after, so a
   same-task cap-queued auto-fire never races the still-held claim.

No new predicate was needed: `spawnMintConflict`/`claimTaskWorktreeRefusal` both already read
`inFlightSpawnTaskIds` — reusing it is what the card asked for ("using the shared claim helper 641cc62c
introduced"). `claimedWorktreePaths` was deliberately NOT also claimed — the worktree is already keyed 1:1
to `taskId` (`createWorktree`'s own deterministic `taskKey`), so `inFlightSpawnTaskIds` alone fully closes
this race via the existing predicate.

## Do not

- Do not move the add back above the project/agent/appendEvent/queue-read/flush span, or anywhere other
  than directly above `try {` — that reopens the exact MAJOR leak Round 2 closed. Every statement between
  `claimTaskWorktreeRefusal` and the add must stay capable of throwing with NOTHING left to leak.
- Do not drop the `has()`-then-`add()` mutex check — a duplicate recycle of the SAME predecessor during the
  swap is a real, reachable window (`hasSuccessor` cannot see it yet), not a theoretical one.
- Do not narrow the release to "right when the successor goes live" — releasing in the existing outer
  `finally` is the safe direction (a superset, never a gap); narrowing it reopens a window between an
  early throw and whatever cleanup follows it.
- Do not release the claim AFTER `maybeDrainCapQueue` is invoked in the same `finally` — that call is
  fire-and-forget but synchronously INVOKED from this same block; an auto-fired cap-queued re-spawn for
  this SAME taskId must see the claim already cleared by the time it actually runs, or it is wrongly
  refused and dropped.
- Do not also add `claimedWorktreePaths` "for symmetry with `spawnWorker`" — `spawnWorker` needs it because
  a taskless spawn has no stable `taskId` to key on; `recycleWorker` always has a real `taskId` (it reuses
  an existing task's worktree), so `inFlightSpawnTaskIds` alone is sufficient and was the verified mechanism
  (see this card's positive-control test below).
- Do not assume this closes the window for a TASKLESS recycle target — `recycleWorker` guards the add with
  `if (taskId)`, matching every other `inFlightSpawnTaskIds` reader/writer's own `if (taskId)`/`?? randomUUID()`
  discipline; a taskless worker was never reachable by `confirmWorkerMergeTracked`'s own taskId-keyed check
  in the first place; there is nothing new to guard there.
- Do not claim "every exit path" releases the claim without having verified where the ADD sits relative to
  the `try`/`finally` — that was Round 1's own unqualified wording, and it was false: a release in a
  `finally` only covers exits that actually pass through the code it wraps.

## Verification

`packages/daemon/test/recycle-merge-reverse-race.mjs` (hermetic: real git + a real `SessionService`, fake
`createPty` seam, no live daemon; gated on a monkeypatched pause point + a polled gate-start file marker,
never a blind sleep):

- Scenario (A), pre-fix: confirmed RED — `spawnMintConflict`/`claimTaskWorktreeRefusal` both read clean
  mid-swap, the confirm's gate genuinely started running, and both the merge and the recycle completed.
  Post-fix: the SAME scenario is now GREEN — the confirm is refused ("already in flight"), its gate never
  starts (the marker file is never created), and `recycleWorker` completes normally with no collision.
- Scenario (B): an isolated sanity check, decomposing (A)'s mechanism from `recycleWorker`'s own machinery.
- Scenario (C): release-on-throw for the pre-existing "predecessor might still be alive" refusal (a throw
  INSIDE the `try` block).
- Scenario (D) (Round 2, the MAJOR fix): a throw from `listUnresolvedQueuedMessagesForWorker` — one of the
  two call sites Code Review `4cae0fd4` named as sitting inside the old leak span — now runs BEFORE the
  claim is ever minted, so the claim is never acquired at all; proven both by the thrown error and by
  `spawnMintConflict` reading clean immediately after.
- Scenario (E) (Round 2, the MINOR fix): a second, concurrent `recycleWorker` call for the SAME predecessor,
  landing while the first is still mid-swap (`hasSuccessor` confirmed still `false` at that point), is
  refused by the mutex; the first call is unaffected and completes normally; the claim is released exactly
  once (checked by excluding the NOW-live successor's id, not the stale predecessor id, which would
  otherwise read a conflict from the unrelated, expected `liveHolder` check instead).
- Scenario (F) (Round 2, test-gap fix): the claim is released after a plain, UNINTERRUPTED successful
  recycle, not only after a throw.

RED→GREEN proven via `node packages/daemon/scripts/negative-control.mjs --file
packages/daemon/src/sessions/service.ts --test packages/daemon/test/recycle-merge-reverse-race.mjs` for the
Round 1 fix (reverted the whole file to the pre-card HEAD, rebuilt, confirmed RED on scenario (A) only,
restored, rebuilt, confirmed GREEN). For the Round 2 MAJOR/test-gap fix, RED was proven by hand instead (not
via `negative-control.mjs`, which only swaps a whole file against a git ref, not a single line against an
uncommitted in-progress state): the single release line in the outer `finally` was temporarily commented
out and the daemon rebuilt — this did not merely fail scenario (F)'s own checks, it crashed the WHOLE script
on an uncaught rejection from scenario (C)'s own subsequent `confirmWorkerMergeTracked` call (that
scenario's claim leaked too, for the identical reason: there is only one release line, shared by every exit
through the `try`). Restoring the line and rebuilding made every scenario pass again.

Full `recycleWorker`-calling test sweep (the 57-file list `grep -l recycleWorker packages/daemon/test/*.mjs`
names, minus `_seam-host-fixture.mjs` — a non-executable factory module — and `recycle.mjs`, excluded
because it needs a live daemon) plus `merge-spawn-task-in-flight.mjs` plus `pnpm --filter @loom/daemon
guards`: all green, confirming the new claim doesn't regress any other `recycleWorker` caller or
`inFlightSpawnTaskIds` reader (`spawnWorker`'s own same-task refusal, the cap-queue auto-fire, and
`reviveWorker` — all go through `spawnWorker`'s own check, never `recycleWorker`'s own path, so none of them
can now self-refuse `recycleWorker`'s own successor spawn).
