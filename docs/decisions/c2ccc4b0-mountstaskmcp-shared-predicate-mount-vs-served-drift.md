# c2ccc4b0 — `mountsTaskMcp` is the ONE shared copy of "which role gets loom-tasks", for BOTH the mount side and the served side

## Narrative

Full review lane 4 (card 486d4238) found that `TaskMcpRouter.resolveProject` (`packages/daemon/src/mcp/server.ts`) admitted any session with a stored row and a `projectId`, with no role check at all — including a `role === "run"` Agent Runs R2 session. The only thing stopping a `run` session from reaching the full loom-tasks surface (`tasks_create`/`tasks_update`/`tasks_get`/`tasks_list`/etc.) was that `pty/host.ts`'s `buildMcpServers` never mounts loom-tasks for `role === "run"` — a client-side omission (the spawned CLI is never configured with an MCP client pointed at `/mcp/<sessionId>`), not a server-side gate. The gateway's per-route `/mcp*` auth guard (card 280b1e44) is identity+liveness-only by design and deliberately defers all role-gating to each router (see `mcp-auth-guard.mjs`'s own comment (G)); a `run` session is issued a real, live per-session `mcpToken` on its own spawned env, so nothing server-side stopped a raw authenticated loopback call (bypassing the configured tool list) from reaching the full board.

Rather than add a second, independently-maintained `role === "run"` check directly inside `resolveProject` — which would let the MOUNTED surface (`buildMcpServers`) and the SERVED surface (`resolveProject`) drift apart again, the same hazard `usesOrchestrationMcp` (card 95f40ee0) was created to close for the loom-orchestration surface — `mountsTaskMcp(role)` is the single shared predicate both sides call: `pty/host.ts`'s `buildMcpServers` early-returns the run-only `loom-run` mount when `!mountsTaskMcp(o.role ?? null)`, and `mcp/server.ts`'s `TaskMcpRouter.resolveProject` returns `null` (→ 404 "unknown or expired session", unchanged shape) under the same condition. Deliberately a DENYLIST (`role !== "run"`), not a positive enumeration of every other `SessionRole` — the documented contract (`buildMcpServers`'s own "every other role layers ON TOP of [loom-tasks]" comment; `mcp/run.ts`'s "not even loom-tasks") frames `run` as the one exception, so a future new role gets loom-tasks by default without needing to be added to an allowlist.

## Do not

- Do not re-add an independent `role === "run"` (or equivalent) comparison directly in `resolveProject` or in `buildMcpServers`'s early-return condition — call `mountsTaskMcp` from both, or the mounted and served surfaces can drift apart exactly the way `usesOrchestrationMcp` (card 95f40ee0) was created to prevent for loom-orchestration.
- Do not turn `mountsTaskMcp` into a positive enumeration of every `SessionRole` that gets loom-tasks — it is a denylist of exactly `"run"` by design, matching the documented "run is the one exception" contract; an allowlist would silently withhold loom-tasks from a future new role unless someone remembered to add it.
- Do not fold `mountsTaskMcp` into a daemon-side class — like `usesOrchestrationMcp`, it lives in `packages/shared` because `PtyHost` has no access to `SessionService`/`mcp/server.ts`'s `Db`, and a shared function is the layering-safe way to give every consumer one source.

## Source

Inline comment in `packages/shared/src/types.ts` (`mountsTaskMcp`'s function doc).
