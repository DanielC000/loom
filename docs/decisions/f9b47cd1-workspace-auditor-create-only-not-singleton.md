# f9b47cd1 — `startWorkspaceAuditor` is CREATE-ONLY, not a singleton, and locks the session role explicitly

**Two unrelated decisions share this card id (`resolveRecord()` resolves an id to one file — see
`CLAUDE.md`'s "One record file per id" section) — see Decision B below for the second.**

## Decision A — `startWorkspaceAuditor` is CREATE-ONLY, not a singleton

## Narrative

Card f9b47cd1: `startWorkspaceAuditor` starts a new END-USER WORKSPACE-AUDITOR session in an agent (End-User Platform tier B5). It mirrors `startAuditor` exactly — including its CREATE-ONLY (NON-singleton) shape — but passes callerRole `"workspace-auditor"`, so the session role is LOCKED to `"workspace-auditor"` regardless of the agent's profile role (an EXPLICIT caller role always wins in `resolveAgentSpawn`). The locked role — not the profile role — drives the de-privileged `loom-user-audit` surface (`buildMcpServers`, B3): a workspace-auditor session gets `loom-tasks` + `loom-user-audit` ONLY and 404s on `/mcp-platform`, `/mcp-orch`, `/mcp-audit` and `/mcp-setup`, so a hostile transcript can never escape the read-and-suggest box.

CREATE-ONLY, NOT a singleton (design gotcha #9): each on-demand "Review my workspace" run is a fresh ephemeral read-and-file session, exactly like the dev Auditor (`startAuditor`).

HUMAN-REST only (gateway `POST /api/agents/:id/sessions {role:"workspace-auditor"}`) — no agent/MCP path mints one (`session_spawn` refuses everything but `manager|plain`; the role is absent from the mintable profile enum + `setupRoleError`). The Workspace Auditor agent lives in the reserved "Getting Started" home (B4).

`prompt` is an OPTIONAL per-schedule custom task description (mirrors `startManager`/`startAuditor`) — appended via `appendScheduledPrompt` AFTER the agent's own `startupPrompt`. Undefined/null ⇒ byte-identical to today.

## Do not

- Do not copy `startSetup`'s live-reuse guard into `startWorkspaceAuditor` — that would attach a repeated "Review my workspace" click to a stale, already-finished run; each click must start a fresh ephemeral session.
- Do not expose a `session_spawn`/agent-MCP path that can mint a `"workspace-auditor"` role session — it is HUMAN-REST only.

## Source (Decision A)

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `startWorkspaceAuditor`. Relocated by card `f05ca65c` (tranche 8); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.

## Decision B — (unrelated decision, same card id, `service.ts`): sibling-name collision detection is manager-scoped, not project-wide

### Narrative (this section only)

A separate, unrelated decision under the same card id `f9b47cd1`, in a different function
(`siblingWorkerSessionNames`, not `startWorkspaceAuditor`). It's part of the broader `-n <name>` session
naming feature this card id spans (see the many inline `// card f9b47cd1` citations across
`service.ts`/`pty/host.ts`/`pty/session-name.ts` for the feature's other sites, none of which carry
comment blocks long enough to need their own extraction).

`siblingWorkerSessionNames` computes the session names THIS manager's LIVE worker siblings would compute
to (RECOMPUTED fresh each call, never stored) — consulted ONLY to detect a naming collision before a
fresh/recycled worker's own `-n` name is finalized (if two live cards slugify identically, the collision
resolution appends the 4-char task id). Scoped to the SAME manager, not project-wide: the manager's own
fleet is where a same-agent, similarly-titled dispatch is most likely, and `listWorkers(managerSessionId)`
is the exact query `spawnWorker` already runs for its concurrency-cap check.

`excludeIds` MUST include the CALLER'S OWN fresh session id — `spawnWorker`/`recycleWorker` both insert +
flip their fresh row `live` BEFORE computing the collision set (that flip-live-before-pty ordering is
load-bearing elsewhere too), so `listWorkers` already returns that fresh row by the time this runs;
without excluding it explicitly, a worker always "collides with itself" and every worker gets a spurious
suffix — a real code-review finding on the first cut of this (the fresh id was left to be implicitly
excluded by insert-ordering, which insert-ordering doesn't actually guarantee). `recycleWorker`
additionally excludes the PREDECESSOR (its row can still show `live` mid-teardown) — its name must never
count as its own successor's collision either.

### Do not (this section only)

- Do not compute sibling-name collisions project-wide — scope to the SAME manager's own fleet
  (`listWorkers(managerSessionId)`), matching `spawnWorker`'s own concurrency-cap query.
- Do not rely on insert-ordering to implicitly exclude the caller's own fresh row from the collision set
  — `excludeIds` must name it explicitly, or every worker collides with itself and gets a spurious suffix.
- Do not forget to also exclude the PREDECESSOR on a recycle — its row can still show `live` mid-teardown
  and must never count as its own successor's collision.

### Source (this section only)

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `siblingWorkerSessionNames`: lines
5794-5811, as of main `1cbc0d74`. Relocated by card `61632c05` (tranche 15); no wording changed, wrapped
source lines joined into a flowing paragraph and the `*` comment markers stripped.
