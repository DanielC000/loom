# 166ba5d9 — `lastOutputAt`'s null-while-running window is proven bounded by `gitOpMs`, and separately measured at sub-2s

## Narrative

Card 166ba5d9: `GateSnapshotEntry.lastOutputAt` is null while `queued`, and also for a caller with real async work between admission and its own `runGateSequential` call (e.g. `run_gate`'s pre-flight git-stamp read in `runWorkerGate`, or a merge gate's `reunionAtAdmission`) — that window is genuinely `phase:"running"` with nothing yet to report, which is why `null` (not a fabricated `0`) is correct there too.

PROVEN BOUNDED, not merely assumed brief: every git op inside that pre-flight window (`computeWorktreeGateStamp`/`resolveGitRef`/`mergeMainIntoWorktree`, `git/worktrees.ts`) is raced against a real `setTimeout` via that file's own `withTimeout`, bounded by `gitOpMs` (`GIT_OP_TIMEOUT_MS = 15_000` default, human-configurable up to a hard `max(120_000)` in `mcp/platform.ts`'s `gitOpMs` schema). `computeWorktreeGateStamp`'s own outer try/catch means the FIRST git call to hit that bound ends the function immediately (never sums indefinitely across retries) — so this window is capped at roughly one `gitOpMs` budget, ≤120s even under a maximally raised config and 15s by default, ORDERS OF MAGNITUDE under `GATE_EXTEND_IDLE_MS` (60s) and `BACKGROUND_PARK_STALE_MINUTES` (20min) — the two preconditions `classifyIdleWorker`'s `parked-gate-stale` branch needs before it would ever read this field. By the time `minutesSinceStart >= BACKGROUND_PARK_STALE_MINUTES` could hold, `lastOutputAt` is GUARANTEED already non-null: `runGateStep` (`gate-runner.ts`) stamps it as its very first synchronous statement, before the gate's child process is even spawned, so a hung/never-spawning child can never reproduce this null window either.

Directly MEASURED too, not just bounded in theory: card 33aa0291's own note (see that record) instrumented a real `runWorkerGate` run and clocked this exact gap at max 209ms (quiet host, n=15) / max 1717ms (host under 15 concurrent CPU-saturating children, n=12), 27/27 trials ≥140ms — sub-2-second in practice, nowhere near the theoretical ceiling above.

## Do not

- Do not treat a large elapsed time (`since`) alone as evidence of a hung gate — a gate still producing output gets its timeout extended (`GATE_EXTEND_IDLE_MS`); idle time (`Date.now() - lastOutputAt`), not elapsed time, is what distinguishes "working hard" from "hung".
- Do not assume the pre-flight null-`lastOutputAt` window could ever explain a `parked-gate-stale` classification — it's bounded by one `gitOpMs` budget (≤120s worst case, 15s default), orders of magnitude under the 20-minute `BACKGROUND_PARK_STALE_MINUTES` threshold.

## Source

Inline comment in `packages/daemon/src/orchestration/gate-semaphore.ts` (`GateSnapshotEntry.lastOutputAt`): lines 293-328, as of commit `5f6d9fd981336bfafd530fada633b229677aa081`. Relocated by card `9641742e`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
