# sha:0db42b7f — the pause-scope registry is in-memory because a daemon restart is already the safe failure

Source: commit `0db42b7f`, no board card ("daemon: orchestration safety rails — pause/kill + concurrency cap (PR #17a)"). Condensed, not verbatim.

## Narrative

`OrchestrationControl`'s pause-scope registry is in-memory by design, not an oversight: it is a kill/pause switch, and a switch that resets to "not paused" on daemon restart is the SAFE failure — a restart means nothing is spawning yet, so there is no in-flight loop left to keep bounded. Persisting pause across restarts was considered a possible later refinement, but judged unnecessary for the rail to do its job of bounding an unattended loop within one daemon's lifetime.

## Source

Inline comment in `packages/daemon/src/orchestration/control.ts`, above `OrchestrationControl`, as of main `db57bdc4`. Relocated by card `f7552bf6` (runtime-subsystem residue, closing sweep). Condensed and reworded, not verbatim.
