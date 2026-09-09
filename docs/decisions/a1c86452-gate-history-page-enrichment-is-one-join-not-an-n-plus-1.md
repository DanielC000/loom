# a1c86452 — the Gates page history read enriches via ONE join, never a per-row lookup

## Narrative

Card a1c86452 is the HISTORY half of the Gates page: a bounded, newest-first page of settled gate RUNS across every project (or one, when `projectId` is set), reconstructed from the gate-run orchestration_events (`GATE_HISTORY_KINDS`).

ENRICHMENT IS A JOIN, NOT AN N+1 LOOP: `orchestration_events` is session-keyed with no `project_id`, so the project name, agent name, worker branch, and task title are resolved in ONE query by joining the SUBJECT session — `COALESCE(worker_session_id, manager_session_id)` (a merge/worker gate keys the worker; a deploy keys only the manager) — out to sessions → projects/agents and the task. A per-row lookup loop on the synchronous in-process SQLite would block the event loop; this stays a single SELECT + a single COUNT, both paginated. LEFT JOINs so a gate whose session/task was since-removed still lists (with null enrichment) rather than vanishing.

`limit` is clamped into `[1, MAX_GATE_HISTORY_PAGE]` and returned as the EFFECTIVE page size so a "load more" client can detect a server cap (mirrors the archived-sessions pagination contract). Ordered by `seq DESC` (the never-reused monotonic sequence) so recency is stable across same-ts ties.

## Do not

- Do not resolve per-row enrichment (project/agent/branch/task) with a per-row query loop — on this synchronous in-process SQLite that blocks the event loop for the whole page; use one JOIN.
- Do not use an INNER JOIN for the enrichment — a gate whose session or task was since-removed must still list, with null enrichment, not vanish from the page.

## Source

Inline comment in `packages/daemon/src/db.ts` (`listGateEvents`): lines 5835-5864, as of this tranche's HEAD.
