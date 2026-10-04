# 44b7774a — `mcp-scope.mjs` rewritten to build `TaskMcpRouter` in-process, never a live daemon

## Narrative

`packages/daemon/test/mcp-scope.mjs` (the §6 MCP auto-scoping test) used to spawn a REAL daemon over
`LOOM_PORT` and drive it with a real HTTP MCP client (`StreamableHTTPClientTransport` + a minted auth
token) purely to exercise `TaskMcpRouter`'s own session->project scoping. That carried the exact risk
class `test/_guard.mjs` exists to fence off: the card body for `44b7774a` (`tasks_get`) records two prior
incidents of this shape launching a REAL `claude` process against an un-stamped throwaway daemon home.
Because of that live-daemon dependency, the file was also listed in `test-daemon.mjs`'s `NOT_HERMETIC`
set — excluded from every automated gate — which is exactly why its hand-authored expected-tool-list
(`expectedTaskTools`) went stale (missing `decisions_for`) with nothing to catch it.

The fix: `TaskMcpRouter`'s "private" `buildServer(projectId, sessionId)` method is just an ordinary method
on the compiled JS (same trick `agent-prompt-lint-surface-drift.mjs` already relies on) — it can be called
directly against a real `Db` instance seeded with real projects/sessions/tasks in a throwaway temp
`LOOM_HOME`, and driven over an in-process `InMemoryTransport`. This exercises the exact same production
handler code (`tasks_list`/`tasks_create`/the project-scoping logic) that the live-daemon version did,
minus only the HTTP transport + auth layer — which `mcp-auth-guard.mjs` already covers separately. The
expected tool list is now derived from `agents/promptLint.ts`'s `TASKS_UNIVERSAL_TOOLS` (itself
drift-tested against this same router by `agent-prompt-lint-surface-drift.mjs`) instead of hand-listed a
second time, so it cannot go stale independently again. The file was removed from `NOT_HERMETIC` since it
no longer touches a live daemon at all.

## Do not

- Do not reintroduce a live-daemon/`LOOM_PORT` spawn (or a real HTTP MCP client) in `mcp-scope.mjs` to test
  `TaskMcpRouter`'s scoping — build the router directly (`new TaskMcpRouter(db, {})`, call its `buildServer`
  method off the compiled JS) and drive it over `InMemoryTransport`, exactly as
  `agent-prompt-lint-surface-drift.mjs` already does.
- Do not re-add a hand-listed expected tool array in `mcp-scope.mjs` — derive it from
  `agents/promptLint.ts`'s `TASKS_UNIVERSAL_TOOLS` (or an equivalent single source), so a new/removed tool
  on the router only ever needs updating in one place.
- Do not re-add `"mcp-scope"` to `test-daemon.mjs`'s `NOT_HERMETIC` set without re-introducing a genuine
  live-daemon dependency first — it is hermetic precisely because it no longer has one.

## Source

`packages/daemon/test/mcp-scope.mjs`, `packages/daemon/scripts/test-daemon.mjs`'s `NOT_HERMETIC` set —
fixed on card `44b7774a` (`tasks_get`).
