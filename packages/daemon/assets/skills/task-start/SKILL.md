---
name: task-start
description: Use when starting a new task, feature, bugfix, or refactor in a Loom project — "let's start", "new task", "working on", "implement", "begin". Ensures a board task exists with a clear scope and definition of done, then loads context.
---

# Task Start (Loom)

Make the work trackable on the board before diving in.

## Steps
1. **Find or create the task** — `tasks_list` (loom-tasks MCP); if none matches, `tasks_create` with a clear title.
2. **Scope it** — put the scope + a sharp **definition of done** in the task body (`tasks_update` body). One task = one focused change.
3. **Move it** — set the task to the in-progress column (`tasks_update` columnKey).
4. **Context** — `git log --oneline -15`, read `CLAUDE.md`, and skim the relevant code before changing it.

Then implement: keep the change small and matched to the surrounding code; build before reporting.
