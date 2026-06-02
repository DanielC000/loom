---
name: session-end
description: Use when wrapping up work — "done for now", "wrapping up", "end session", "log this", "save progress". Records progress + decisions on the board task and leaves the work clean and resumable.
---

# Session End (Loom)

Leave the work picked-up-able by the next session.

## Steps
1. **Update the board task** (`tasks_update`): note what was completed in the body, record decisions + their rationale, and add items for what remains. Move the task to its correct column (review / done / waiting).
2. **Code state** — ensure the build passes; commit only if asked. Report any uncommitted changes plainly.
3. **Prose** — if you changed design/architecture notes in the project's vault, apply doc-hygiene (rewrite in place, no contradictions, bounded). The daemon auto-commits the vault — no manual vault git.
4. **Summary** — a short, factual wrap-up: what shipped, what's verified, what's left.

If you're a worker, finish with `worker_report` (done / blocked / progress). If you're a manager near your context window, hand off per your recycle flow.
