# 008f33f1 — `gatePhase` disambiguates a minted-but-not-yet-admitted `pendingMerge` from one actually executing

## Narrative

Card 008f33f1: `pendingMerge.state:"running"` is `PendingOpRegistry`'s own coarse in-flight bit, set the instant the merge op is minted — well before it's ever submitted to `GateSemaphore` for admission. It does NOT mean the gate is actually executing, and a manager who reads it that way can watch a merge sit QUEUED behind a same-repo sibling for minutes and reasonably conclude it's wedged. `gatePhase` closes that WITHOUT a second call: it folds in the SAME live `GateSemaphore.findByOpId` lookup `gate_status(opId)`/`gate_queue` already read, so it can never disagree with either. Only ever attached while `state` is `"running"` — a settled row's outcome already answers the question unambiguously (see `sessions.gatePhaseForOpId`'s own doc for the full reading guide, including why `null` here is a normal, non-alarming reading, not an error state).

## Do not

- Do not read `pendingMerge.state:"running"` alone as "the gate is executing" — check `gatePhase` (queued vs running) instead of concluding a merge is wedged just because it's been `"running"` for a while.

## Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts` (the fleet-view builder, `withGatePhase`): lines 2666-2674 (with a forward pointer at line 2597), as of commit `f81f9c1108773e559efe78b7166cbf78b6201480`. Relocated by card `a2278b09` (tranche 2).

## `gatePhaseForOpId`'s own reading guide — the three return values

This reads the SAME live `GateSemaphore.findByOpId` lookup `gate_status(opId)`/`gate_queue` already use,
so it can never disagree with either: `"queued"` (admitted-pending, waiting on a semaphore slot or a
same-repo sibling), `"running"` (actually admitted and executing), or `null` while the op hasn't reached
gate admission yet (worktree prep / union-merge still in progress) or has already left the live registry
(gate step finished, squash/finalize still running — or a gateless project, which never registers with
the semaphore at all). `null` is NOT an error state — it just means this particular disambiguation has
nothing to add right now; `pendingMerge.state` alone still tells the caller the op overall is in flight.

### Do not (2)

- Do not read a `null` `gatePhase` as an error or as "the op is not in flight" — it just means the op
  hasn't reached gate admission yet, or has already left the live semaphore registry; `pendingMerge.state`
  is what tells the caller the op overall is in flight.

### Source (2)

Inline comment in `packages/daemon/src/sessions/service.ts`, above `gatePhaseForOpId`: lines 6306-6322,
as of main `1cbc0d74`. Relocated by card `61632c05` (tranche 15); no wording changed, wrapped source
lines joined into a flowing paragraph and the `*` comment markers stripped.
