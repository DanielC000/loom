# fc53ea74 — the codex real-spawn lock's wait budget scales with the daemon's own gate cap, fed via a new required env stamp

## Narrative

Investigation card `fc53ea74` found that `test/_codex-real-spawn-lock.mjs`'s `WAIT_TIMEOUT_MS` (180s) was sized against a single other holder's worst observed real runtime (~120s, with margin) — correct for the ONE case card `e4701333` left reachable (a merge gate racing a worker's `run_gate` on the SAME repo was closed by `e4701333`'s own `gate-semaphore.ts` fix, deferred further widening to its own card), but never re-derived for the general case: at most `orchestration.maxConcurrentGates` (the daemon-global cap) gate-executing processes can exist on one host at once, and EVERY one of them schedules the codex-real-spawn family on the SAME single OS-wide lock file (`os.tmpdir()/loom-codex-real-spawn.lock`, not scoped to project/repo). A waiter can, in the worst realistic case, have to wait behind `cap - 1` OTHER processes' own codex-family holders, not just one.

Rather than touching `gate-semaphore.ts` (explicitly out of scope for this card — that's the deferred `mergeRepoFree`-narrowing card), this card makes the lock's own wait budget correctly reflect the live cap. `gateOpIdEnvOverride` (`sessions/service.ts`) now ALSO stamps `LOOM_GATE_CONCURRENT_CAP` onto every gate child — merge, worker self-check (`run_gate`), and deploy alike — carrying the resolved `orchestration.maxConcurrentGates` value each was admitted under, the same way `LOOM_GATE_TEST_CONCURRENCY` already pins the worker self-gate's own lane pool. `_codex-real-spawn-lock.mjs` reads it to derive `WAIT_TIMEOUT_MS = Math.max(1, cap - 1) * BASE_WAIT_TIMEOUT_MS` (`BASE_WAIT_TIMEOUT_MS` is the original 180s, now read as "one other holder's worst observed runtime, plus margin" rather than a fixed ceiling). At `cap <= 2` this is unchanged from today's flat 180s (`cap - 1` floors at 1); it scales linearly above that. A bare/manual run with no gate-child env (`LOOM_GATE_CONCURRENT_CAP` absent) falls back to `cap = 2`'s value — the behavior every caller observed before this card.

## Amendment: the outer per-file ceiling must scale with the SAME cap, or the wait budget is a no-op

Code Review of the first landing (29f31e5d) caught a BLOCKING gap: every `CODEX_REAL_SPAWN_BASENAMES`
member runs inside `scripts/test-daemon.mjs`'s own per-file harness timeout (`spawnWithTimeout`), which
SIGTERM-kills the file at a fixed ceiling — `TEST_TIMEOUT_MS` (120_000) for 6 of 7 members, and 300_000
for `codex-doctrine-real-spawn` (`@decision 3791b14e`). `acquireCodexRealSpawnLock()` is called near the
top of each file, so a file BLOCKED waiting on this lock is bounded by whichever of the two timeouts is
SMALLER — and the outer harness ceiling was computed with zero knowledge of this lock's own
`WAIT_TIMEOUT_MS`. At the owner-set cap=2, `WAIT_TIMEOUT_MS` is 180_000, already ABOVE the 120_000 outer
ceiling for 6 of 7 members — the harness kills a legitimately-waiting file 60s before its own lock wait
budget would ever expire, making the whole cap-scaling fix above a NO-OP in practice. At cap=3 it is
worse: `WAIT_TIMEOUT_MS` reaches 360_000, exceeding even `codex-doctrine-real-spawn`'s 300_000 override.

Fixed by `computeCodexFileCeilingMs(ownWorkBudgetMs, cap)`: the outer ceiling scripts/test-daemon.mjs now
actually uses for a codex-family member is `ownWorkBudgetMs + computeCodexLockWaitTimeoutMs(cap)` — its
own real work allowance (`CODEX_OWN_WORK_BUDGET_MS`, defaulting to `DEFAULT_CODEX_OWN_WORK_BUDGET_MS` =
120_000, with `codex-doctrine-real-spawn`'s prior 300_000 override moved there unchanged) PLUS the exact
same function the lock's own `WAIT_TIMEOUT_MS` is built from, so the two can never drift apart. Resolved
per-run in `scripts/test-daemon.mjs`'s `resolveEffectiveTimeoutMs(name, cap?)`, which `runOne` calls for
every file (a no-op for non-codex members — they keep their existing `TEST_TIMEOUT_OVERRIDES`/
`TEST_TIMEOUT_MS` lookup unchanged).

## Honest caveat: WAIT_TIMEOUT_MS can now reach/exceed STALE_MS

The lock's own header previously claimed the 180s figure stays "well below STALE_MS (5 min)" — true only
at the UNSCALED value. The scaled `WAIT_TIMEOUT_MS` already equals STALE_MS at cap=3 (both read as a
number, 300_000 vs 300_000) and exceeds it above that. `tryAcquireOnce`'s force-reap fires on
`age > STALE_MS` REGARDLESS of `isRecordedHolderDead`'s own verdict — so at a high enough cap, a waiter
could in principle force-reap a still-alive, still-legitimately-running holder, the exact double-hold
hazard this lock exists to prevent. This is NOT fixed by this card: the cap is owner-controlled and sits
at 2 today (`gate-cap-is-2-by-owner-decision-never-change-silently`), where `WAIT_TIMEOUT_MS` (180_000)
stays safely under `STALE_MS` (300_000). Re-derive this relationship — and reconsider `STALE_MS` itself —
before ever raising the cap past 2.

## Port-scheme fix: real-collision exposure, not merely theoretical

Code Review of 29f31e5d corrected a related false claim in `scripts/test-daemon.mjs`'s own comment (card
`d39db2db`'s census claimed "no hermetic test binds a real listener on this port today") — it was false
even at the time. `mgmt-surface.mjs`, `platform-scope.mjs`, `profiles-rest.mjs` and `scheduler.mjs` each
read `process.env.LOOM_PORT` (falling back to their own `4318 + pid%900` only when it's unset) and spawn a
REAL `dist/index.js` daemon child that genuinely `.listen()`s on it — `reserveLanePort`'s real-collision
exposure (the whole reason it replaced the old `4400 + lane` literal) was always real, not merely
theoretical, which makes the fix MORE valuable than first scoped, not less.

A residual TOCTOU window remains between `reserveLanePort`'s own port reservation and that spawned child's
own `.listen()` call (disclosed in `reserveHermeticPort`'s own doc, `test/_hermetic-port.mjs`) — during
that window another process could in principle grab the same port. `profiles-rest.mjs` boots its child
with `stdio:"ignore"`, so even a silent `EADDRINUSE` there would produce no diagnostic, and none of these
files' own hand-rolled `waitReady()` verifies it's actually talking to the daemon IT spawned, as opposed to
any other process that happens to be listening on that port. Not fixed here — carded separately as
`2365cc22` (low priority: the window is real but narrow, and the OLD `4400+lane` scheme's risk was
arguably WORSE — a *guaranteed* repeat port across concurrent invocations, not just a timing window).

## Do not

- Do not make `cap` optional on `gateOpIdEnvOverride` — an absent cap on some gate children and present on others would leave the lock unable to tell "no cap info" from "cap is 1" (the same ambiguity `batchSize`'s own required-ness, card `720bb7ad`, already guards against).
- Do not hardcode a raised cap's resulting wait-budget number into `_codex-real-spawn-lock.mjs` instead of deriving it from `LOOM_GATE_CONCURRENT_CAP` — the cap is a human-tunable, owner-set daemon-global setting (project memory `gate-cap-is-2-by-owner-decision-never-change-silently`), and a hardcoded multiple would silently go stale the moment it's raised.
- Do not confuse `LOOM_GATE_CONCURRENT_CAP` (the daemon-global `maxConcurrentGates` admission cap across ALL concurrent gate-executing processes) with `LOOM_GATE_TEST_CONCURRENCY` (the per-gate-child test-lane POOL SIZE within ONE `test-daemon.mjs` invocation) — they are different axes and both are read by different consumers for different reasons.
- Do not treat this as closing the broader hazard `e4701333` found — the `gate-semaphore.ts` `mergeRepoFree` repo guard for merge-vs-worker on the same repo is untouched by this card, deliberately; narrowing it is a separate, deferred card.
- Do not compute a codex-family member's outer per-file ceiling by any formula other than `computeCodexFileCeilingMs` — a second, hand-derived "own work + wait" sum can silently drift from what the lock itself actually waits.
- Do not raise `orchestration.maxConcurrentGates` past 2 without re-deriving the `WAIT_TIMEOUT_MS` vs. `STALE_MS` relationship (see the honest-caveat section above) — past cap=2 the scaled wait budget can reach or exceed `STALE_MS`, which risks a waiter force-reaping a still-alive legitimate holder.

## Source

`packages/daemon/src/sessions/service.ts` (`gateOpIdEnvOverride` and its call sites in `confirmWorkerMerge`/`mergeBatch`/`deployOwnProject`/`runWorkerGate`), `packages/daemon/test/_codex-real-spawn-lock.mjs` (`BASE_WAIT_TIMEOUT_MS`/`RESOLVED_GATE_CAP`/`WAIT_TIMEOUT_MS`).
