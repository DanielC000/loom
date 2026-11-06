# bba7a8ec — one async deploy-staleness core; the sync spawn paths take a pre-read, never read git themselves

## Narrative

Card 93e70102 moved `served_status` onto an async twin that prefetched three history reads into a module-level string-keyed map and then ran the unchanged SYNC computation. Three problems followed, all fixed here:

1. The map was a silent-fallthrough hazard: a drifted argv missed the map and quietly ran `execFileSync` instead.
2. The "conditional" reads were not small: `merge-base --is-ancestor` (~85 ms) on every self-host call, and the ancestor-path behavioural check (a diff plus up to 2×25 `git show`, ~4 s) right after a daemon-src merge, all still blocked the loop.
3. Every other consumer — the manager kickoff, boot resume, the settle-nudge build stamp — kept the blocking read and degraded to `[loom:deploy-staleness-unknown] … ETIMEDOUT` (869–944 ms measured against a 1000 ms cap; see the c6e7ebe7 amendment).

Design:

- `stalenessSteps` (deploy-staleness.ts) is a generator that yields BATCHES of typed `GitRead`s and is resumed with their `GitReadResult`s. The logic exists exactly once. The async driver awaits each batch (concurrently within it); the sync driver is test/fixture-only.
- Spawn paths that must stay synchronous (`startNew`, `startManager`, `resume` → `resumeForcedRoleAsFreshClaude`, `resumeFleetOnBoot`) take an OPTIONAL pre-read staleness. Their async entry points pass it (gateway session-start/resume, boot resume in `index.ts`, `recycleManager`). A call with none renders the honest line `[loom:deploy-staleness-not-measured] …` (kickoff) / `[build: not measured]` (stamp) / a "NOT checked at boot" live-claim — it claims neither stale nor fresh and never blocks.
- NO caching (module DoD #4): each entry point reads fresh; nothing is kept between calls.

## Do not

- Do not reintroduce a prefetch map or any module-level state that lets a drifted argv fall through to a real read: the async driver must answer every read from its own seam.
- Do not make `composeManagerStartupPrompt` (or `resumeFleetOnBoot`) read git itself to "fill in" a missing pre-read: render the not-measured form instead.
- Do not cache a pre-read across spawns/entry points to save the ~1 s: `5e30c4bd` requires a fresh read, and a stale "current" is the exact defect this module exists to catch.
- Do not claim the not-measured form is "clean": it asserts nothing, and a manager must be able to tell it from a verified-current kickoff.
- Do not add a production caller of the sync driver; `test/deploy-staleness-sync-driver-test-only-guard.mjs` fails on one.

## Packaged installs render nothing; settle nudges are stamped BEFORE they settle

- `notApplicableDeployStaleness()` decides "no `.git` ⇒ not-applicable" synchronously (one `existsSync`, no git), so a sync spawn with no pre-read on a packaged install renders NOTHING (the d3d4d432 / DoD #4 promise). Only a checkout with a `.git` can render the `not-measured` line.
- A settle nudge (`merge_confirm`, `merge_batch`, `run_gate`) reads its build stamp INSIDE the op body, before the op settles, and carries it to the synchronous settle callback in a closure variable (`withSettleStamp` / `readStampSuffix`). Settle marks the `pending_gate_ops` row settled synchronously and boot only recovers `pending` rows, so a git await between settle and enqueue would lose the one-shot terminal nudge to a restart (ccb407eb). Do not move that read back after settle.

## Measured vs unmeasured manager-spawn paths

MEASURED (an async entry point pre-reads and passes the staleness down): gateway session-start (manager, and generic `startNew` for a manager-profile agent), gateway manual `/resume`, boot `resumeFleetOnBoot`, boot `reconcileOrphanedGateOps` sweep, `recycleManager`, the Scheduler's `startManager`, poll and event-trigger `startNew` (manager-profile agents), and `spawnSessionAsPlatform` (platform / setup / companion `session_spawn`).

UNMEASURED (render the not-measured line on a source checkout, nothing on a packaged install): webhook `startNew` (`webhooks/ingress.ts`, its `sessions` dep is a narrow `Pick`), the MCP `resumeSession` seam, the other `resume()` callers (rate-limit, wake, crash-recovery, companion revive; only the forced-claude re-spawn of a codex-pinned manager reaches the kickoff-composing resume branch, so that gap is rare). Automatic resumes (wake / poll / crash-recovery / rate-limit / companion revive) take no pre-read and therefore show "not measured". `escalateWedgedMergeReconcile` is MEASURED: its async caller (`reconcileOrchestrationOnBoot`) pre-reads and passes the staleness in, like its sibling `[loom:merge-orphaned]` escalations.

## Ordering constraints added in review round 2

- The settle-nudge stamp read (`readStampSuffix`) runs as the FIRST `.finally` after the op body, BEFORE the task claim is released (`clearMergeInFlightForTask`), so a spawn/recycle cannot cut the worktree during the read. It never throws, so the claim release after it cannot leak. It is bounded by an overall ~8 s race (`SETTLE_STAMP_READ_CAP_MS`; on timeout the stamp renders "not measured"); the served_status / kickoff reads carry no such cap.
- The Scheduler pre-reads staleness ONCE at tick start, only when a manager-kind schedule is due, and re-lists the due schedules after that single await; everything after (pause/usage gates, caps, per-schedule checks, claim, spawn) is synchronous. Do not put an await between a per-schedule check and its spawn: overlapping interval ticks could exceed `maxConcurrentManagers`, and a pause toggled mid-await would no longer stop the spawn.
