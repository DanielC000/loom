<!-- title: recyclePlatformLead — fresh-successor mechanics, no worker re-parenting -->

# recyclePlatformLead — fresh-successor mechanics, no worker re-parenting

Source: commit b346f2c8, no board card.

## Decision

`recyclePlatformLead` (`packages/daemon/src/sessions/service.ts`) is the platform-surface
`recycle_me` flow for a Platform Lead nearing its context limit — the platform analogue of
`recycleManager`. The Lead has already run its session-end skill and written a
`continuationPrompt`.

- Loom boots a **FRESH** successor Lead — seeded with the agent warm-up plus that
  `continuationPrompt` — rather than `--resume`. This is a deliberate choice: fresh context,
  intent carried forward explicitly through the continuation text instead of replaying the
  predecessor's full transcript.
- The successor carries the predecessor's **scheduled wakes** and **in-flight inbound queue**
  (durable cross-tree platform messages + held human turns) onto it.
- The predecessor is closed only **after a short deferred delay**, so the `recycle_me` tool
  response (the old Lead's own MCP call) flushes before its pty is killed.
- `gen` increments by one; `recycledFrom` points at the old session id.
- There is **NO worker re-parenting** here, unlike `recycleManager`: a platform Lead's spawned
  sessions are independent of it (not parented to it), so nothing needs to be re-pointed at the
  successor besides the wakes/queue above.

## Sanctioned platform-spawn paths

`recyclePlatformLead` is one of exactly two sanctioned paths that can mint a platform session
(the other is the human-REST `startPlatformLead`):

- It is reachable **only** by an existing platform Lead — the platform MCP router gates
  `role === "platform"`, and the method itself re-asserts `old.role === "platform"`.
- It mints exactly **one** successor of the same role.
- `session_spawn` still refuses `role: "platform"` unconditionally — no general agent/MCP-facing
  platform-spawn path is ever opened by this method.
