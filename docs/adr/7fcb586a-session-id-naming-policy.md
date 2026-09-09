# 7fcb586a — Session-id naming policy for every MCP surface returning a session id to an agent

## Narrative

Card 7fcb586a establishes the settled rule for every MCP surface that returns a session id to an agent. It is hosted in `packages/shared/src/types.ts` (not a daemon-side leaf) because it governs surfaces across both packages — `my_context`, `events_search`, `auditRequestItem`, and every input param — not just the `packages/daemon/src/mcp/sessionView.ts` list-projection surface it used to live in; that file now references this record rather than owning it.

Every id reachable from INSIDE a session (its own scratchpad/transcript/tool-results paths) is ENGINE-namespaced UNLESS it was read off Loom's own scratch dir (`sessionScratchDir` in the daemon — Loom-keyed, exposed as `LOOM_SCRATCH_DIR`/spill file paths — a legitimate exception, not a trap); every id the DAEMON stamps into a durable row, an event, or a peer frame is LOOM-namespaced. Both are well-formed v4 uuids that look identical by shape, so the FIELD NAME is the only thing that can tell a reader which one they're holding.

## Do not

1. Do not name a NEW or RENAMED output field carrying a Loom session id anything but `loomSessionId` — never a bare `sessionId` (e.g. `my_context`'s `loomSessionId`/`engineSessionId`, `events_search`'s per-event `loomSessionId`, `auditRequestItem`'s `loomSessionId`). This governs NEW/RENAMED fields, not every existing one — see the KNOWN LEGACY EXCEPTIONS below for pre-existing sites this does not reach.
2. Do not rename a ROLE-PREFIXED name (`workerSessionId`, `managerSessionId`, `parentSessionId`, `targetSessionId`, `newWorkerSessionId`, `recycledFrom`, …) — these are Loom-namespaced BY CONVENTION and stay as-is: every one resolves to a Loom id today, the role prefix already disambiguates it from an engine id in practice, and renaming the whole family buys no live ambiguity fix for a wide, disruptive blast radius (dozens of `inputSchema` call sites across `worker_report_get`, `worker_stop`, `worker_message`, and siblings).
3. Do not rename a record's own PRIMARY KEY away from a bare `id` (see `Session.id`'s own doc) — the same convention every other Loom record type (task, project, agent) uses. Renaming it for session rows alone would break that convention to fix an ambiguity `engineSessionId` sitting right beside it under `full:true` already resolves.
4. Do not rename an INPUT param (even a bare `sessionId`) to fix this — instead name its namespace IN THE TOOL DESCRIPTION. Renaming an input is a call-site-breaking change (agents already invoke the tool by that param name, and existing tests assert against it), where an output rename is not.

## Known legacy exceptions to rule 1

Known examples, NOT an exhaustive list; other pre-existing sites may carry a bare `sessionId` this enumeration did not find:

- `GateHistoryRow.sessionId` — `gate_history`'s output. Deliberately UNCHANGED: it's test-pinned by `packages/daemon/test/gate-history.mjs`, and renaming a settled, widely-consumed history feed for a naming-only fix wasn't judged worth the churn.
- The peer-relay frames `[loom:from-manager · <name> · projectId:<id> · sessionId:<id>]` (`packages/daemon/src/sessions/service.ts:8881`) and `[loom:from-assistant · <name> · sessionId:<id>]` (`packages/daemon/src/sessions/service.ts:9056`) — prose an agent reads, not a JSON key; both carry a Loom id under a bare `sessionId` label. Left untouched by this card (that file is outside this card's edit scope) and flagged for separate sequencing.

## Source

Inline comment in `packages/shared/src/types.ts` (the SESSION-ID NAMING POLICY block, immediately above `Session`). Relocated by card 35d90c4e (tranche 1 on `packages/shared/src/types.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
