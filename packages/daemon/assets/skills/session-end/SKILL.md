---
name: session-end
description: Use when wrapping up work — "done for now", "wrapping up", "end session", "log this", "save progress". Records progress + decisions on the board task and leaves the work clean and resumable by the next session.
---

# Session End (Loom)

Leave the work picked-up-able by the next session. The board is the source of truth; the vault holds
prose. The daemon auto-commits the vault — never run manual vault git.

## Steps

1. **Update the board task** (`tasks_update`): note what was completed in the body, record decisions +
   their rationale, and add items for what remains. Move the task to its correct column (review / done
   / waiting). Only mark **done** if it's actually true — scoped work outstanding means it isn't done.
2. **Code state** — ensure the build/gate passes; commit only if asked. Report any uncommitted changes
   plainly.
3. **Prose** — if you changed design/architecture notes in the project's vault, apply `/doc-hygiene`
   (rewrite in place, no contradictions, bounded).
4. **Living resume doc** (leads) — if you keep one, make sure it's current: what's merged, the
   prioritized backlog, key decisions, where things stand. A successor should be able to read it cold.
5. **Summary** — a short, factual wrap-up: what shipped, what's verified, what's left.

## Vault preflight (Obsidian auto-start)

If a step uses the `obsidian` CLI (it needs the Obsidian DESKTOP app running) and the env var
**`LOOM_OBSIDIAN_PREFLIGHT`** is set, run it FIRST — `node "$LOOM_OBSIDIAN_PREFLIGHT"` — to self-heal a
down Obsidian (launch + poll-until-ready, bounded). Opt-in (set only when the project enabled
`obsidian.autoStart`) and **default-safe**: on disabled/headless/not-installed/timeout it reports a
non-`ready` status and you fall back to **direct filesystem** writes of the vault — never block on it.

## By role

- **Worker:** finish with `worker_report` — `done` (one-line summary + key decisions) or `blocked`
  (with `needs`). Don't merge; your manager reviews and gates. See `/worker`.
- **Manager near your context window:** hand off via `worker_recycle` / your recycle flow, seeding the
  successor from your living resume doc. See `/orchestrate`.
