# 68155573 — a merge gate's retry CONTINUES its own admission; it never re-enters the queue

## Do not

- Do not run a retry/resume of the same merge op through a fresh `GateSemaphore.runExclusive` call — a failed attempt's `finally` releases the cap slot AND the per-repo guard, so a queued same-repo sibling is admitted in the same tick (specimen `ff93dce4` lost its slot to batch `abbc7bb9`; `36c08174`'s retry then waited 87 min).
- Do not hold the slot or guard ACROSS `runExclusive` calls (a "lease" a later call adopts) — a hold whose release depends on a caller reaching a matching call is exactly the leak class `c24dd48a` forbids. The continuation is a CHAIN of links inside ONE `runExclusive` (`next` returns the next `GateContinuation`), so its single `finally` is the only release on every exit path (throw in `fn`/`next`, abort, normal end).
- Do not call `grantEligible()`/release between links, and do not carry `holdRepoGuardOnExit` across links — the flag resets per link, so only the LAST link's hold survives into the squash phase.
- Do not restore a cancel-while-queued path for a retry: a retry is `running` from its first instant, `cancelQueued` cannot reach it, and a running merge gate is never cancellable (`cancelGateOp` refuses it). The `318ac7b2`/`518e7ff6` catches were deleted with it.

## What changed

`runExclusive(cap, descriptor, fn, priority, next?)`. After `fn` resolves, `next(result)` may return `{ descriptorPatch, fn, next? }`; the semaphore merges the patch into the live descriptor (`attempt`, `priorAttemptMs`), re-stamps `attemptStartedAt`, resets `lastOutputAt`/`extended`, gives the link a fresh `AbortController`, and runs it — slot, worktree and repo guard never released. `next` returning `null` (or omitted) is byte-identical to the old single-admission behaviour.

Solo `confirmWorkerMerge` (attempt 1 → single/multi-file retry → resume → transient-kill retry) and the batch path (attempt 1 → retry → resume) all use it. The transient-kill retry's settle wait (`gateRetry.settleMs`) and its post-timeout sweep now happen while the slot is held.

## Reporting consequences

- `gate_queue`/`gate_status` show a retry as `running` with `attempt:2|3`; `since`/`elapsedMs` keep the ORIGINAL admission time, and the new `attemptStartedAt` (ISO, null while queued) is the current link's start.
- The concurrency triple (`gateCap`/`concurrentGates`/`concurrentGatesMax`) now always describes the ONE admission — it no longer swaps to a "later retry admission" (amends `e2b6f900`, `39da2570`, `99a1cf6f`).
- `7ad12202`'s hold-only-when-nothing-remains rule and its self-deadlock note no longer apply (one admission); `b9e07a4a`'s "retry re-admits through `runExclusive`" is superseded — it is now a link of the same one.
- A retry no longer waits in the queue, so it no longer competes for the cap — it runs immediately on the already-held slot. That is the intent; it holds the lane longer by the retry's duration.
