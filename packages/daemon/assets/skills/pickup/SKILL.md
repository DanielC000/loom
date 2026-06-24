---
name: pickup
description: Use when resuming work or getting up to speed on a Loom task — "pickup", "continue", "what were we doing", "get back to". Reads the project board, recent git history, CLAUDE.md, and (if relevant) your living resume doc to brief the current state and a concrete next step.
---

# Pickup (Loom)

Get oriented in THIS project, then state a concrete next step. The session is already bound to its
repo and board — the **board is the source of truth for tasks**; the vault holds prose. Don't pass a
project id anywhere; it's derived server-side.

## Steps

1. **Board** — `tasks_list` (the `loom-tasks` MCP) to see tasks and their columns. Note what's
   in-progress, in review, and waiting.
2. **Code** — `git log --oneline -20` and `git status` for recent and in-flight work.
3. **Conventions** — read `CLAUDE.md` at the repo root if present.
4. **Your role's anchor** (whichever applies):
   - *Lead / orchestrator:* read your **living resume doc** — it's the "you are here + what's next"
     source of truth. Your session's **"Where things live"** context block gives your project's
     absolute **vault root**; your resume doc is `<vaultRoot>/Projects/<Project>/Orchestrator Log.md`
     (substitute your project's name). **Read it by that ABSOLUTE path — never Glob for it** (a broad
     Glob from your home directory hits the search timeout). Cross-check it against the board.
   - *Worker:* your scope is your assigned board task / kickoff — orient narrowly to it, not the whole
     project.
5. **Design notes** (optional) — the **vault root** is the one in your "Where things live" context
   block; skim the latest design/task notes under `<vaultRoot>/Projects/<Project>/` (by absolute path,
   never Glob) for decisions and rationale.

## Brief

Summarize concisely — only what's needed to resume, not an exhaustive report:
- **What** the project is (one line).
- **In progress** — board state + any uncommitted work.
- **Decisions / gotchas** that bear on what's next (from the resume doc or notes).
- **Suggested next step** — one concrete action.
