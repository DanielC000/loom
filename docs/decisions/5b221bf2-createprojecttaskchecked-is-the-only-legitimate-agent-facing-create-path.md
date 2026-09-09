# 5b221bf2 — `createProjectTaskChecked`, never the raw `createProjectTask`, is the agent-facing create path

## Narrative

`createProjectTaskChecked` wraps `createProjectTask` with a cross-channel duplicate check, and is called
from EXACTLY TWO places: the agent-facing `tasks_create` MCP tool (mcp/server.ts) and the Platform Lead's
cross-project `project_task_create` (mcp/platform.ts). Both satisfy this fence's own criterion — the
caller is an AGENT reading a tool result and can ACT on a refusal (retry with
`allowDuplicate`/`supersedes`/`relatedTo`, or drop it) — unlike every OTHER path that reaches
`createProjectTask`, which must NEVER be substituted for the raw helper.

`createProjectTask` itself is a SHARED helper — reached not only from those two callers but also from the
companion's `board_create` (companion/capabilities.ts) — and, transitively through it, from every
automated BOARDING path that calls `db.insertTask` directly with a delivery guarantee (`peer_message`
boarding, platform-escalation landing, workspace-audit suggestions, project seeding, human REST card
creation). A refusal on any of those silently drops a message instead of failing an agent call an agent
can read and retry.

Do not "simplify" this by moving the duplicate check into `createProjectTask` or `db.insertTask`; that
would be exactly the regression DoD 8 (`5b221bf2`) / M1-regression (`0ef0270b`) tests guard against.

## Do not

- Do not move the duplicate-detection check down into `createProjectTask` or `db.insertTask` — every
  automated boarding path (peer_message, platform-escalation, workspace-audit, project seeding, human
  REST) reaches those directly with a delivery guarantee, and a refusal there silently drops a message
  instead of failing a retryable agent call.
- Do not call the raw `createProjectTask` from a new agent-facing surface — route it through
  `createProjectTaskChecked` instead, or the duplicate check is silently bypassed.

## Source

Inline JSDoc in `packages/daemon/src/mcp/tasks.ts` (`createProjectTaskChecked`'s own doc, lines 911-924
as of this tranche's HEAD).
