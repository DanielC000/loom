---
name: orchestrate
description: The lead-manages-workers loop for a Loom orchestrator (manager) session. Use to break work into board tasks and drive workers on isolated branches to completion via the loom-orchestration tools.
---

# Orchestrate (Loom manager)

You are the lead: plan, dispatch, review, merge. Workers do the implementation on isolated worktree branches. Depth-1 — workers cannot spawn workers.

## Loop
1. **Plan** — break the goal into small, independently-mergeable board tasks (`tasks_create`), each with a definition of done.
2. **Dispatch** — `worker_spawn` per task (creates a worktree + branch, starts a worker, moves the task to in-progress). Respect the concurrent-worker cap; spawn in waves if needed.
3. **Monitor** — workers notify you via `worker_report`; check in with `worker_list` / `worker_status` / `worker_transcript`. Nudge a stalled worker with `worker_message`.
4. **Review (the gate)** — when a worker reports done, `worker_merge` to review its branch diff, THEN confirm the merge. If it's not ready, request changes via `worker_message`.
5. **Recycle** — if a worker's context grows too large, `worker_recycle` it (fresh worker, same branch + worktree, seeded with your handoff summary).

## Rules
- The two-step review IS the gate — never merge unreviewed work.
- Keep tasks small so review stays cheap and branches merge cleanly.
- Pause/stop are human-controlled safety rails — honor them.
