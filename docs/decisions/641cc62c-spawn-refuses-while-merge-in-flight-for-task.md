# 641cc62c — a task's worktree is claimed by at most one of {spawn, recycle, merge/batch} at a time

**Scope note:** this covers spawn-vs-merge/batch (both directions) and recycle-vs-merge/batch (the
recycle-initiates direction only). It deliberately does NOT cover the reverse of that last pair — a
confirm/batch mint targeting a worker whose `recycleWorker` call is itself still in flight (the successor
row exists but is still `"starting"`, the predecessor not yet fully torn down) — see "Known residual,
out of scope" near the end.

## The gap (round 1)

`confirmWorkerMerge`/`mergeBatchTracked` ordinarily run for a **NON-LIVE** worker — the ordinary shape is
a worker that has already exited, with its merge confirmed afterward. `spawnWorker`'s only pre-existing
same-task guard, `db.liveSessionIdForTask(taskId)` (service.ts, in the `if (taskId)` block before any
worktree/pty side effect), only ever sees a worker whose `process_state` is still `'live'` — so it never
fires once the merging worker has exited, which is exactly when a merge op is normally in flight.

Without a second guard, a concurrent `worker_spawn` for the SAME taskId reaches `createWorktree`, which
resolves a **deterministic** path keyed only on `taskId` (`taskKey`, git/worktrees.ts) — the identical
directory the in-flight confirm/batch op's own `mergeMainIntoWorktree` (union-merge) and gate command are
still reading/writing. Two actors then touch one worktree.

## Round 2 (Code Review `78c8505a`): one blocking leak, two partial-closure gaps

**BLOCKING — the eviction leak.** The round-1 fix released the per-task claim from `confirmWorkerMergeTracked`'s
`onSettle` option. `PendingOpRegistry.attach()` never fires `onSettle` for an entry `evictDeadOwner()`
force-removed — that op's late settle finds a DIFFERENT object installed under `key` and the identity-
guarded branch is skipped entirely (see `pending-ops.ts`'s own class doc, "DEAD-OWNER RECOVERY"). Eviction
happens with the orphaned `run()` still executing in the background (unreachable, uncancellable), so the
claim this card adds would never clear for that task until a daemon restart.

**Recycle bypass.** `recycleWorker` (service.ts) never goes through `spawnWorker` — it reuses the
predecessor's worktree IN PLACE, with no `createWorktree` call at all. Recycling an EXITED worker (a
legitimate, unguarded shape: `recycleWorker` has no liveness requirement on its target) whose confirm is
in flight reproduces the identical collision through a different entry point.

**Reverse ordering.** The round-1 fix only ever refused a `worker_spawn`; it never made `confirmWorkerMerge`/
`mergeBatchTracked` refuse when a `worker_spawn` had ALREADY claimed the task (or its worktree path, or
the task via a different live session) by the time the merge op minted.

## The fix

**Eviction leak** — the per-task claim now releases on the real RUN's own completion, chained via
`.finally()` directly off the promise `run()` returns (both the solo `confirmWorkerMergeTracked` call and
the batch's own `runBatchBody` are wrapped this way), never from `onSettle`. This fires for an orphaned
(evicted) run exactly as it does for an ordinary one, because it is attached to the real promise chain,
not gated behind the registry's own identity check. The round-1 decision record's own "Do not add a second
try/finally" guidance is RETRACTED — this is precisely the shape the fix needed; see the round-1 text's own
replacement below.

**One shared predicate, both spawn-side callers.** `claimTaskWorktreeRefusal(taskId, excludeSessionId?)` is
the ONE "may I claim this task's worktree right now?" check — `spawnWorker` and `recycleWorker` both call
it, before any side effect, so the two paths can never diverge. It checks `liveSessionIdForTask` (excluding
`excludeSessionId` — `recycleWorker` passes its own target's id, since `old` legitimately IS the live
worker being recycled) and `mergeInFlightOpIdForTask`.

**One shared predicate, both merge-side callers.** `spawnMintConflict(taskId, worktreePath, excludeSessionId?)`
is the REVERSE-direction check — `confirmWorkerMergeTracked`'s `onOpMinted` (solo) and `mergeBatchTracked`'s
own pre-assembly candidate filter (batch) both call it. It checks `inFlightSpawnTaskIds`, `claimedWorktreePaths`,
and `liveSessionIdForTask` (excluding the worker the merge op itself targets). For solo, a conflict throws
from `onOpMinted` — `PendingOpRegistry.attach()` rolls back the just-minted entry and RETHROWS (see
`docs/decisions/396d6602-*.md`'s own "Do not" section), so `confirmWorkerMergeTracked`'s call REJECTS
directly with a clear, named reason — a real exception, not a `{settled:true,ok:false}` AttachResult (that
shape is reserved for a throw reached from INSIDE the real `run()` callback, e.g. the pre-existing
"worker has no branch" case). For batch, a conflicting candidate is filtered OUT before `batchable`/`K`/
`liveChosen` are ever computed (the same shape `strandedFallback`/`retainedOutstanding`/`reviewMoved`
already use) and routed to its own fallback/drop reason — the batch itself is never failed over one
candidate's conflict.

## Do not

- Do not key either direction's check on `GateSemaphore`'s live/queued snapshot (`gate_queue`'s own
  `running`/`queued` arrays) as a substitute — it only covers the GATE phase. A confirm/batch op is "in
  flight" from mint through worktree prep, union-merge, the queue wait, the gate, the squash, and finalize;
  the semaphore entry for a merge op doesn't exist yet during worktree prep/union-merge and is already gone
  (settled) once the gate step itself finishes, well before finalize's worktree removal actually runs.
- Do not release the per-task claim from `onSettle` — that was round 1's bug. Release it ONLY by chaining
  `.finally()` off the real `run()` promise, for both the solo and batch callers; see the round-2 fix above.
- Do not mark a batch's held / review-moved / overflow candidates with the per-task "merge in flight" claim
  — this run never touches their worktrees at all (they are explicitly excluded from `liveChosen`), so
  marking them would wrongly refuse a legitimate, unrelated respawn.
- Do not read a refusal from either predicate as proof the refused call mutated anything — `spawnWorker`'s
  check runs BEFORE `createWorktree`, `recycleWorker`'s runs before any teardown, and `onOpMinted`'s check
  runs before the durable tombstone row is even written (and before the batch's own worktree is cut) — a
  refused call creates nothing.
- Do not assume `spawnMintConflict`'s refusal needs a corresponding change on the cap-queue auto-fire path
  (`maybeDrainCapQueue`) — a plain `Error` thrown by a replayed `spawnWorker` (both predicates' own shape,
  never `CapQueueRejectedError`/`UsageLimitError`) already falls into the EXISTING "genuine failure" branch,
  which drops the entry (never retries it forever) and sends a durable `[loom:cap-queue-autofire-failed]`
  notification naming the opId/task/agent — proven directly in
  `packages/daemon/test/merge-spawn-task-in-flight.mjs` scenario (6).
- Do not claim the per-task claim "never" leaves a lingering lock as an unqualified absolute in any reader-
  facing text (the `worker_spawn`/`worker_recycle` tool descriptions, this record) — state instead that it
  releases on the real run's own completion, INCLUDING an orphaned run a dead-owner sweep evicted out from
  under a now-gone manager; that is the specific, falsifiable claim the round-2 fix actually proves, and
  round 1 shipped the unqualified wording before the eviction case was even covered.
- Do not override `deadOwnerEvictionCeilingMs`/`isDeadOwnerOpStuck`'s formula in a test meant to prove that
  formula itself correct (see `docs/decisions/47a22d40-*.md`'s own "Do not") — a tiny override is fine ONLY
  to decouple an unrelated timing claim (proving the release-on-eviction fix) from waiting out the real
  ceiling, exactly as `merge-spawn-task-in-flight.mjs` scenario (7) does.

## Round 3 (Code Review `6741c4d5`): the round-2 eviction test couldn't fail, and a second atomicity gap

**Scenario (7) was unfalsifiable as written.** It used a PASSING gate, so the orphaned confirm genuinely
LANDS — the task reaches its terminal column, and the final respawn is then refused by the pre-existing,
unrelated TERMINAL-COLUMN guard in `spawnWorker`, before the per-task claim check is ever reached. The
reviewer proved this by manually stripping the solo `.finally()` release out of compiled `dist` and
re-running (7): it stayed GREEN, while a direct probe of `mergeInFlightOpIdForTask` showed the claim had
genuinely leaked. The round-2 text above ("judged not worth the duplication") was itself the mistake —
asserting a test's sufficiency without having tried to falsify it.

**Fixed** by switching (7) to a FAILING gate (the orphan settles via rejection, the task stays
non-terminal, so the terminal-column guard can never mask anything) and by asserting
`mergeInFlightOpIdForTask(taskId)` DIRECTLY, both while the evicted orphan is still live (non-empty) and
after it settles (empty) — never relying solely on the indirect spawn-refusal signal. Added (7b), the
batch equivalent — `runBatchBody`'s own `.finally()` had no test at all before round 3.

**The batch reverse check was not atomic with its mark.** `spawnMintConflict` ran once in the pre-assembly
loop (service.ts, building `candidates`/`strandedFallback`), well BEFORE this op's real mint — with real
awaits in between (`detectStrandedWork`'s own await per candidate, the `reviewedTipVerdict` loop earlier
still) during which a `worker_spawn` could land, pass the (now-stale) earlier check, and still get merged
into the batch. Fixed by re-running the SAME check synchronously at the top of `runBatchBody`, in the same
tick as marking each candidate — building `liveChosenAtMint` (filtering `liveChosen`) and using THAT for
the real assembly (`batchCandidates`) and the per-candidate-count audit fields, not the outer `liveChosen`.
A candidate that newly conflicts at this exact instant is routed to its own fallback/drop entry (via a new
`lateSpawnConflictFallback` list, spread into every one of the SAME 12 `runFallback([...])` call sites the
round-1 `spawnConflictFallback` list already reaches) — never failing the whole batch.

**Two MINOR findings, also fixed:** a stale duplicate release call still sat in the solo `onSettle` hook
(harmless for the ORDINARY settle case, since `.finally()` already released it first, but a direct
contradiction of this record's own "release ONLY via `.finally()`" rule) — deleted. The `"confirmWorkerMerge
refused: taskId '<id>' <conflict>"` reason text was constructed independently at three call sites (solo's
throw, batch's pre-amble push, batch's late-recheck push) — factored into one shared
`spawnMintConflictReason(taskId, conflict)` formatter.

## Residual CLOSED by card `c30293ae`

The REVERSE of the recycle direction — a `worker_merge_confirm`/`merge_batch` mint targeting a worker whose
own `recycleWorker` call is itself still in flight — was left open here as a known residual and is now
closed. See `docs/decisions/c30293ae-recycleworker-holds-the-in-flight-claim-too.md`: `recycleWorker` now
holds the same `inFlightSpawnTaskIds` claim `spawnWorker` does, for the duration of its own swap.

## Verification

`packages/daemon/test/merge-spawn-task-in-flight.mjs` — hermetic (real git + a real `SessionService`, fake
`createPty` seam, no live daemon), gate-marker-file-polled (never a blind fixed sleep). RED pre-fix / GREEN
post-fix proven via `scripts/negative-control.mjs` for round 1. Round 2/3 scenarios (7)-(10) are each
proven RED via a real, by-hand source strip (stripping exactly the mechanism each scenario targets,
rebuilding, confirming the specific scenario fails, then restoring and rebuilding) rather than asserted
sufficient by inspection alone — the round-3 lesson above is precisely why that step is no longer skipped.

Scenarios (1)-(6) cover round 1 (solo/batch collision refused, claim released on settle/throw, cap-queue
composition). Round 2/3 add:
- (7) EVICTION LEAK: mint → dead owner → `reconcileDeadOwnerMergeOps()` evicts it → a same-task spawn is
  STILL refused while the orphaned run is live (asserted directly via `mergeInFlightOpIdForTask`, not just
  indirectly) → the orphan settles via a genuine REJECTION (failing gate — task stays non-terminal) → a
  same-task spawn now genuinely succeeds.
- (7b) BATCH EVICTION: the same shape as (7), for `mergeBatchTracked`/`runBatchBody`.
- (8) RECYCLE BYPASS: `recycleWorker` on an exited worker is refused while that SAME task's merge is
  mid-flight, and succeeds once it settles.
- (9) REVERSE ORDERING (solo): a `worker_spawn` that has already claimed a task (via the synchronous
  `inFlightSpawnTaskIds` claim, before its own first await) makes a concurrent `confirmWorkerMergeTracked`
  mint for that SAME task reject outright.
- (10) REVERSE ORDERING (batch) / ATOMICITY: a conflict introduced in the real gap between the pre-amble
  check and the real mint (simulated deterministically by monkey-patching `spawnMintConflict` to poke
  `inFlightSpawnTaskIds` right after its own first, clean call — the same white-box test-poke convention
  this suite already uses elsewhere, e.g. `sessions.claimedWorktreePaths.add(...)`) is caught by the LATE
  re-check and routed to fallback, without failing the sibling candidate's own landing.
