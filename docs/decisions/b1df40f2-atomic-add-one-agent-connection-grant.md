# b1df40f2 — an atomic server-side add-one for agent connection grants

Follow-up to `afe1bc90` Code Review #2 (minor 3). The pending-bindings "Review & grant" refetched the agent and then
posted the whole `connections` list to `POST /api/agents/:id`, which REPLACES the list. A write landing between that
GET and the POST (a second tab, the agent editor) was silently reverted, revoking a grant.

## The mechanism

- `POST /api/agents/:id/connections` with `{connectionId}` — human-only loopback REST, no MCP tool, no MCP source
  reference (`test/agent-connection-add-one.mjs` section 4 scans `src/mcp/*.ts`).
- `Db.addAgentConnection` is ONE `UPDATE` statement (`json_insert(connections,'$[#]',?)` guarded by a
  `json_each` membership test), so there is no read-then-write gap for another writer to land in. A corrupt or
  non-array column reads as `[]`, as `toAgent` does. An id already present writes nothing (`added:false`, 200).
- ONE shared validator, `agentCredentialGrantWriteError` (`agents/validate.ts`): the cross-project scope refusal,
  the oauth2/ssh capability-binding refusal and the codex-capabilities refusal. The whole-list route calls it
  (behaviour-preserving extraction: same refusals, order, status codes, error text); the add-one calls it with
  `patch = {connections: [...existing, id]}`, so it inherits exactly what the whole-list path checks.
- "Keeps the role-change rules" means the add-one does not BYPASS anything the whole-list route enforces. The
  role-change refusals (`boundAgentCredentialGrantRoleChangeError` and friends) fire on profile edits, rebinds and
  explicit-role spawns, never on this route, and none was added here.
- Asymmetry, deliberate: an UNKNOWN new connection id is 404 on the add-one; the whole-list route still tolerates
  unknown ids (they fail closed at use time). The add-one grants exactly one id, so it can afford to require it exist.
- The same effects as the whole-list route on a real add: `markBindingsAppliedForAgent` and the fresh-spawn note.

## Residual (not closed)

The add-one never loses another writer's change, but the converse still holds: a whole-list write built from a STALE
client read can clobber an add-one that landed after that read. That is inherent to whole-list replace. Any client
that only wants to add a grant must use the add-one route; the agent editor still writes the whole list on purpose.

## Do not

- Do not reimplement the add as a JS read of the list followed by a write of the list (in `Db`, the route, or the
  web client) — that is the exact race this card closes; `test/agent-connection-add-one.mjs` section 3 interleaves a
  whole-list write between the read and the write and fails it.
- Do not give the add-one its own copy of the grant refusals; call `agentCredentialGrantWriteError`.
- Do not expose this route, or `addAgentConnection`, as an MCP tool on any router: agent credential grants are
  human-only.
- Do not make the whole-list route 404 on unknown ids, or the add-one tolerate them, to "match" the other.
- Do not claim the whole-list route is now race-free: see the residual above.
