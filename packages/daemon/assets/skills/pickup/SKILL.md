---
name: pickup
description: Use when resuming work or getting up to speed on a Loom task — "pickup", "continue", "what were we doing", "get back to". Reads the project board, recent git history, and CLAUDE.md to brief the current state and a concrete next step.
---

# Pickup (Loom)

Get oriented in THIS project. The session is already bound to its repo and board — Loom's board is the source of truth for tasks; the vault holds prose.

## Steps
1. **Board** — call `tasks_list` (the loom-tasks MCP) to see tasks and their columns. The project is derived server-side; never pass a project id.
2. **Code** — `git log --oneline -20` and `git status` for recent and in-flight work.
3. **Conventions** — read `CLAUDE.md` at the repo root if present.
4. **Design notes** (optional) — if your context names the project's vault folder, skim the latest design/task notes there.

## Brief
Summarize concisely: what the project is, what was in progress (board + uncommitted work), and a concrete suggested next step. Only what's needed to resume — not an exhaustive report.
