# a1c86452 — the Gates page history read enriches via ONE join, never a per-row lookup

## Narrative

Card a1c86452 is the HISTORY half of the Gates page: a bounded, newest-first page of settled gate RUNS across every project (or one, when `projectId` is set), reconstructed from the gate-run orchestration_events (`GATE_HISTORY_KINDS`).

ENRICHMENT IS A JOIN, NOT AN N+1 LOOP: `orchestration_events` is session-keyed with no `project_id`, so the project name, agent name, worker branch, and task title are resolved in ONE query by joining the SUBJECT session — `COALESCE(worker_session_id, manager_session_id)` (a merge/worker gate keys the worker; a deploy keys only the manager) — out to sessions → projects/agents and the task. A per-row lookup loop on the synchronous in-process SQLite would block the event loop; this stays a single SELECT + a single COUNT, both paginated. LEFT JOINs so a gate whose session/task was since-removed still lists (with null enrichment) rather than vanishing.

`limit` is clamped into `[1, MAX_GATE_HISTORY_PAGE]` and returned as the EFFECTIVE page size so a "load more" client can detect a server cap (mirrors the archived-sessions pagination contract). Ordered by `seq DESC` (the never-reused monotonic sequence) so recency is stable across same-ts ties.

## The LIVE half needs its own metadata registry entry, not just a counter (unrelated decision, same card id, `orchestration/gate-semaphore.ts`)

Card a1c86452 is also the LIVE half of the Gates page (the active lane-hero, distinct from the HISTORY half above): alongside `GateSemaphore`'s counting/blocking machinery, every in-flight run also records a small metadata `RegistryEntry` so the daemon can enumerate what is currently RUNNING and QUEUED (`SessionService.snapshotGates` reads this). Each `runExclusive` call REQUIRES a `GateDescriptor` — a required param, so the compiler forces every call site to supply one, closing off a silent gap — and the registry entry is added before acquisition and removed in a `finally` that fires on EVERY exit path (admission-then-settle, a `fn` that throws, a `fn` that times out), so a leaked "phantom active gate" can never accumulate.

## Do not

- Do not resolve per-row enrichment (project/agent/branch/task) with a per-row query loop — on this synchronous in-process SQLite that blocks the event loop for the whole page; use one JOIN.
- Do not use an INNER JOIN for the enrichment — a gate whose session or task was since-removed must still list, with null enrichment, not vanish from the page.
- Do not make `GateDescriptor` optional on `runExclusive` — requiring it is what forces every call site to supply the identity the live registry needs, at compile time, instead of leaving a silent gap.
- Do not remove a `RegistryEntry` anywhere but the `finally` — it must fire on every exit path (settle, throw, timeout) or a phantom active gate can accumulate in the live view.

## Source

Inline comment in `packages/daemon/src/db.ts` (`listGateEvents`): lines 5835-5864, as of this tranche's HEAD.

Also `packages/daemon/src/orchestration/gate-semaphore.ts` (module-level doc, lines 26-33), commit `252d25bb51`, as of `beeeb7c2`. Relocated by card `772735d2` (tranche 2); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
