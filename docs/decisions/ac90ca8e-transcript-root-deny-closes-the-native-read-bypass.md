# ac90ca8e — the role-scoped transcript-root deny closes the native Read/Glob/Grep bypass of the MCP-mediated read gates

## Narrative

Card ac90ca8e (extended by `44fa586a` to `auditor`/`workspace-auditor`, and by `d78f8217` to `manager`/`platform`/`setup` BLANKET + `worker` PROJECT-SCOPED — see card `31613c1e`'s own record for that split; moved to the single spawn chokepoint by card `3388be4d`): closes the native-Read/Glob/Grep bypass of the MCP-mediated read gates (companion `transcript_read`: owner-turn + DM-scope + project-scope; auditor/workspace-auditor `repo_read_*`; manager `worker_transcript`; platform `session_transcript`) by denying these roles native read access to the engine transcript root (`~/.claude/projects/**`) via a role-scoped `permissions.deny` entry — see `TRANSCRIPT_ROOT_READ_DENY_RULE`'s own doc (`claude-transcript.ts`) for why that literal is owned there, not here.

PRE-`3388be4d` this was applied inside `resolveAgentSpawn` (`sessions/service.ts`) — exactly ONE of the (at the time) ten `pty.spawn` call sites, so `startRun`, resume/fork/recycleWorker/recycleManager/recycleLead's agent-row-MISSING fallback (`agent ? resolveAgentSpawn(...).permission : config.permission`) all silently dropped the deny. Keying off `opts.role` at `createPty` instead fixes every path structurally in one place: `role` is the session's PINNED value (the DB row's own `role` column, carried across every resume/fork/recycle regardless of whether the agent row still exists), never re-derived from the agent, so this is immune to the exact class of defect that made the old call site droppable. Mirrors `disallowedToolsForRole`'s own chokepoint shape (computed from the pinned role at the single `createPty` boundary, not per-caller).

`run` is DELIBERATELY excluded (`runs/prompt.ts` — it ingests untrusted input by design, and never reached the old call site either) — `3388be4d` is a MOVE of the existing rule, not a widening; `run`'s exclusion is decided there and is NOT reopened by card `d78f8217`.

UNIONS the rule into `.deny` rather than replacing it — a per-project `permission.deny` override REPLACES the default wholesale (`shared/config.ts`), unlike `allow` (which unions), so without this union-at-the-spawn-boundary step a project's own custom deny would silently strip this protection. Byte-identical (same reference) for every role outside `TRANSCRIPT_ROOT_DENY_ROLES`, and a no-op (same reference) when the rule is already present — no duplicate entries.

## Do not

- Do not revert to applying this deny at a per-call-site level (e.g. only `resolveAgentSpawn`) — that structurally drops the deny on any path that doesn't run agent re-resolution (resume/fork/recycle with a missing agent row). Key it off the pinned `opts.role` at the single `createPty` chokepoint.
- Do not let a per-project custom `permission.deny` override silently strip this protection — union the rule in at the spawn boundary; never assume the project default already includes it.
- Do not add `run` to `TRANSCRIPT_ROOT_DENY_ROLES` — its exclusion is deliberate (`runs/prompt.ts` ingests untrusted input by design) and was never reopened by the later role-split card.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (above `TRANSCRIPT_ROOT_DENY_ROLES`), as of `main` `8d9fe59d`. Extracted by card `a2a6b2ad` (tranche 11 on `pty/host.ts`); wording unchanged beyond joining wrapped lines and stripping `*`/`{@link}` markup.
