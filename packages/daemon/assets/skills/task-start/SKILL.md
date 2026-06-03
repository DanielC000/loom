---
name: task-start
description: Use when starting a new task, feature, bugfix, or refactor in a Loom project — "let's start", "new task", "working on", "implement", "begin". Ensures a board task exists with a clear scope and a sharp definition of done, then loads context before any code changes.
---

# Task Start (Loom)

Make the work trackable on the board before diving in. The board is the source of truth — one task =
one focused, independently-mergeable change.

## Steps

1. **Find or create the task** — `tasks_list` (the `loom-tasks` MCP); if none matches, `tasks_create`
   with a clear, specific title.
2. **Scope it.** Put the scope **and a sharp definition of done** in the task body (`tasks_update`
   body). The DoD states what *proves* it works — a command that exits clean, a manual repro, a
   regression check. A task without a DoD isn't ready to work. Keep it to one logical change; if it's
   really several, split it.
3. **Move it** — set the task to the in-progress column (`tasks_update` columnKey).
4. **Load context before changing anything** — `git log --oneline -15`, read `CLAUDE.md`, and read
   the relevant code/notes so your change matches what's there. Reuse existing shapes over inventing
   new ones.

Then implement: keep the change small and matched to the surrounding code, meet the DoD, and build/
verify before reporting it done.
