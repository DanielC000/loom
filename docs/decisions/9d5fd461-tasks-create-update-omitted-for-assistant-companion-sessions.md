# sha:9d5fd461 — `tasks_create`/`tasks_update` are omitted for an "assistant" (Companion) session

## Narrative

An "assistant" (Companion) session used to get `tasks_create`/`tasks_update` like any other role. Those
two tools always write to THIS session's own project, with no grant check at all — unlike the
Companion's separately grant-checked `board_create`/`board_update` (`companion/capabilities.ts`, mounted
on `loom-orchestration`), which take an EXPLICIT `project` param and are checked against a real
`board-reach` act-mode grant.

For the Companion, "always write to this session's own project" silently meant "your own bound board":
a Companion asked (via chat) to file a card to a NAMED project would reach for `tasks_create`/
`tasks_update` instead of `board_create`/`board_update`, and the call would succeed — silently misfiling
to the Companion's own home board instead of the project the human actually named. No error, no wrong-
project signal, nothing to notice.

The fix is conditional TOOL REGISTRATION, not a new grant check bolted onto `tasks_create`/`tasks_update`:
`mcp/server.ts`'s `buildServer` registers those two tools only when `session?.role !== "assistant"`, so an
omitted tool never reaches `tools/list` for a Companion session at all — the same pattern already used for
`authenticated_request`/`vault_write` on the same router. Every other role is unaffected.

The same commit also touched `companion/capabilities.ts` (widened `board_create`/`board_update` test
coverage) and `sessions/assistant-prompt.ts` (composed-prompt wording for the narrowed tool set) — kept
here as provenance only; this record's decision is the `mcp/server.ts` exclusion above.

## Do not

- Do not add a runtime grant check to `tasks_create`/`tasks_update` as the fix for this — the chosen
  remedy is exclusion via conditional tool registration, so a Companion session never even sees the tool
  in `tools/list`, mirroring `authenticated_request`/`vault_write`.
- Do not re-admit `tasks_create`/`tasks_update` to an "assistant" session without also giving them the
  same explicit-`project` + `board-reach` grant check `board_create`/`board_update` already have — the gap
  this closed was exactly that those two tools have no such check.

## Source

Inline comment in `packages/daemon/src/mcp/server.ts` (`buildServer`, lines 272-288 as of this tranche's
HEAD). No board card cited anywhere in the block or the file; keyed to the introducing commit per the
extraction program's sha-grammar carve-out. Sourced via `git blame`, then `git rev-parse --verify
9d5fd4614e9a81ef8127d95d0dd2197d84aac10b` (`fix(companion): remove the silent wrong-board card-create
path`) — a genuine feature/fix commit, not a bulk move.
