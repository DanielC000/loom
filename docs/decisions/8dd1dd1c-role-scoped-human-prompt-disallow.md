# 8dd1dd1c — role-scoped human-prompt disallow: which roles are Loom-driven and must never block on a human

## Narrative

Card 8dd1dd1c (`disallowedToolsForRole`, `pty/host.ts`): the set of roles whose stdin is Loom-driven and which must NEVER block on a human spawn with `HUMAN_PROMPT_TOOLS` disallowed:

- `worker` — driven by its manager (worker_message/redirect); channel up is worker_report.
- `setup` — the user-facing "Platform" operator; acts on the user's behalf, never blocks.
- `auditor` — the Platform Auditor (scheduled, read-mostly transcript reviewer).
- `workspace-auditor` — the Workspace Auditor (read-mostly reviewer of the user's own workspace).
- `run` — a fully autonomous, human-LESS, Loom-driven session; nobody can answer a prompt, so a model that called one would block until the hard run-timeout reaped it (a wasted full-timeout window + a `timed_out` run).
- `assistant` — the long-lived Loom Companion; its "human" reaches it over a CHAT channel and it answers via `chat_reply`, so its stdin is never a live TUI human — an interactive prompt would block on input that never comes.

DELIBERATELY EXCLUDED (left byte-identical): `manager`/orchestrator + `platform` (the human-driven Platform Lead) legitimately surface decisions to the human; a plain (role-less) session is out of scope.

Task-tracking-tools split (card 33f9f181): SEPARATELY, the set of BOARD-DRIVEN roles — `manager`/orchestrator, `platform`, `auditor` — spawn with `TASK_TRACKING_TOOLS` disallowed (a disjoint concern from the human-prompt disallow above; `auditor` gets BOTH sets, unioned). `workspace-auditor`/`setup`/`worker`/`run`/`assistant`/plain are left byte-identical on this dimension: their real task surface isn't the loom-tasks board the same way, and scoping narrowly avoids suppressing a signal a role might still find useful.

`disallowedToolsForRole` is pure + exported so the spawn-args test asserts the per-role mapping with no real claude.

## Do not

- Do not add `manager`/orchestrator or `platform` (Platform Lead) to the human-prompt disallow set — they legitimately surface decisions to the human; only Loom-driven roles that can never get a human answer belong here.
- Do not widen the task-tracking-tools disallow (card 33f9f181) beyond `manager`/`platform`/`auditor` without checking whether the target role's task surface actually maps to the loom-tasks board the same way — a role like `workspace-auditor` is deliberately left with that signal available.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (above `disallowedToolsForRole`), as of `main` `8d9fe59d`. Extracted by card `a2a6b2ad` (tranche 11 on `pty/host.ts`); wording unchanged beyond joining wrapped lines and stripping `*`/`//` markers; the role-by-role bullet list preserved verbatim.
