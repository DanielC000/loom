# 3564fd1e — per-branch consecutive gate-timeout streak breaks the fleet-wide timeout death spiral

## Narrative

Per-branch consecutive-gate-TIMEOUT streak — the circuit breaker for the fleet-wide gate-timeout death spiral: a genuinely hanging test can never pass no matter how many times the gate re-runs it, and each re-run risks leaking another process-tree survivor even with the tree-kill fix in `gate-runner.ts`. After `GATE_TIMEOUT_BREAKER_THRESHOLD` consecutive `timedOut` results on the same branch at the same commit, `confirmWorkerMerge`/`runWorkerGate` stop spawning the gate for it (see `checkGateTimeoutBreaker`) and report a distinct "likely hanging test" failure instead.

In-memory only, daemon-uptime-scoped: it only needs to survive long enough to break a live spiral. A restart resetting it is an acceptable cold-start cost, not a correctness gap (worst case: one extra timeout before it re-trips) — not worth a DB table for a transient host-load guard.

Keyed by branch, not workerSessionId: the failure is a property of the branch's CODE, so a worker resume/recycle on the same branch inherits the trip rather than getting a fresh budget for free. The tracked `sha` records the worktree HEAD the streak was last observed against; `checkGateTimeoutBreaker` clears the whole entry once that HEAD advances — a new commit is the plausible fix, so the breaker must give it a clean slate rather than locking the branch out for the rest of the daemon's uptime.

## Do not

- Do not persist this streak to the DB — it is deliberately in-memory, daemon-uptime-scoped; a restart resetting it (one extra timeout before re-trip) is an accepted cost, not a gap to fix.
- Do not key this streak by `workerSessionId` — it must stay keyed by branch, so a resume/recycle on the same failing branch inherits the trip instead of getting a fresh budget.
- Do not clear the streak on anything but the worktree HEAD advancing — a new commit is the plausible fix; nothing else should give the branch a clean slate.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (the `gateTimeoutStreak` field doc, `SessionService`): originally lines 1856-1873, as of this tranche's HEAD. Relocated by card `9f4f8e5a` (tranche 7); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
