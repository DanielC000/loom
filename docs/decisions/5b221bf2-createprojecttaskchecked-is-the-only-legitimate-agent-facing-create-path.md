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

## Cross-project write (Platform Lead `project_task_create`, addendum)

PL Auditor finding #4: the Lead stands ABOVE all boards, so it can board a card DIRECTLY onto ANOTHER
project's board instead of spawn-and-narrate (~24 cards + ~40 reconcile calls for a 12-fix batch). Uses
`createProjectTaskChecked` (card `0ef0270b`, Code Review M1) — NOT the raw `createProjectTask` every
other automated boarding path reuses — because the Lead is itself an AGENT reading a tool result: it can
act on a refusal (retry with `allowDuplicate`/`supersedes`/`relatedTo`, or drop it), exactly this fence's
own criterion. This closes the one gap left in this card's original fence: it deduped the agent-facing
in-project `tasks_create` but left the Lead's OWN cross-project filing tool unchecked, so whichever side
(a peer manager via `tasks_create`, or the Lead via this tool) filed a duplicate SECOND was only ever
caught if it happened to be the peer manager — `project_task_create` is how the founding duplicate pairs
on this very board were actually filed. Checked against the DESTINATION project's board (the resolved
`project.id`), never the Lead's own — a corpus mismatch here would be a silent no-op that looks like it
works. TRUST: cross-project WRITE is inherently a PLATFORM (cross-project admin) capability — it lives
ONLY on this platform-role-gated router. It is deliberately ABSENT from the agent-facing surfaces
(loom-orchestration manager/worker, loom-setup operator): a project orchestrator/worker/setup-operator
stays confined to its OWN board (those surfaces resolve the projectId SERVER-SIDE and never take one), so
none can gain cross-project write.

- Do not add cross-project write reachability to the manager/worker/setup surfaces — projectId there is
  resolved server-side by design; cross-project write is a PLATFORM-only capability.
- Do not check the Lead's cross-project boarding duplicate against the Lead's OWN project — check it
  against the DESTINATION project's board, or the dedup check silently becomes a no-op.

## Source

Inline JSDoc in `packages/daemon/src/mcp/tasks.ts` (`createProjectTaskChecked`'s own doc, lines 911-924
as of this tranche's HEAD).

Cross-project addendum: inline comment in `packages/daemon/src/mcp/platform.ts` (`project_task_create`'s
preceding block, lines 2213-2230 as of this tranche's HEAD, prior to compression). Relocated by card
`b721401b` (tranche 1 on `mcp/platform.ts`).
