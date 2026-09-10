# a305669e — a `--resume` is a NEW engine process on a NEW pty; the OLD pty's process tree (background shells + file-read tracking) dies with it

## Narrative

Filed as a Platform Auditor finding (investigate card `a305669e`, "PL Auditor finding #11" umbrella), boarded 2026-07-10 on owner directive after a cross-project daemon restart (one project's owner-authorized deploy) tore down other, unrelated live managers' in-flight background shells with no checkpoint or drain — surfacing only a bare `<status>killed</status>` the manager had to notice and diagnose, forcing multi-minute work to be re-run. Two independent projects hit the same restart the same way (DevToolbox Orchestrator's backgrounded lint+test gate; PDF Tools Orchestrator's background merge-wait timer) — the restart also reset both managers' file-read tracking.

Root cause: `claude --resume` starts a NEW engine process attached to a NEW pty. The OLD pty — and everything node-pty's orphan-free containment (its conpty kill path walking `_getConsoleProcessList()` on Windows, a process-group kill on POSIX; NOT a Job Object, node-pty@1.1.0 has none) was keeping alive under it, including any `run_in_background` shells the agent had started — dies with it. This is OS-level process-tree teardown, not a Loom choice, and applies to EVERY live session torn down by a restart or crash, not just the one that caused it. The engine's per-session "you have Read this file" set is separate in-memory state that a `--resume` equally does not restore (confirmed first-hand: a post-resume `Edit` reports "File has not been read yet").

There is no daemon API into either the engine's background-task registry or its file-read-tracking state, so checkpointing or restoring either across the gap is infeasible. The accepted fallback for both is to NOTE the loss in the resume nudge (`RESUME_NUDGE_TAIL`, `orchestration/resume-nudge.ts`) — so the resumed agent re-Reads intentionally before editing, and expects a bare `<status>killed</status>` on its next background-task poll and re-launches what it still needs, instead of spending a turn diagnosing either as a fresh failure.

## Do not

- Do not assume a background shell (or file-read tracking) survives a restart/crash-resume of its own session, or of any OTHER live session on the same restart — the teardown is host-wide per boot, not scoped to the initiating project.
- Do not attempt to checkpoint/drain arbitrary background shells, or restore file-read tracking, across a restart — no daemon API into either exists; the accepted mitigation is disclosure via the resume nudge, not recovery.
- See `0edda303` for the one load-bearing exception the background-shells claim needed: a DELIBERATELY DETACHED child (e.g. the tracked dev-server helper) is NOT part of the torn-down process tree and can survive.

## Source

JSDoc comment above `RESUME_NUDGE_TAIL` in `packages/daemon/src/orchestration/resume-nudge.ts`, lines 1-23 as of this tranche's HEAD (tranche 1). Card merged as commit `67ccac1b`.
