# 2349d90c — `peer_message` is the owner-gated manager↔manager cross-project channel

## Narrative

Board card 2349d90c: the manager's OTHER structured cross-project write, alongside `platform_escalate`. Unlike that hardcoded-target escalation, `targetProjectId` here is caller-chosen but gated server-side on `project_links` — an owner-declared, HUMAN-only table with NO MCP path (an agent can never create a link itself, only use one the owner already made). Delivers ONLY to the target project's LIVE manager session (never a worker/platform/auditor); when none is live, the message is durably boarded on the target project's own board instead of dropped. Reuses the same framed, `kind:"agent"`, one-per-turn delivery channel as `worker_message`/`session_message` — a data message only, no privilege travels with it. Rate-limited per calling manager session.

Both `peer_message` and `peer_list` are registered ONLY when this project has ≥1 `project_links` row (`hasPeerLinks`, `db.listProjectLinks()` read directly — a deliberate SUPERSET of what `sessions.listPeerProjects`/`peer_list` actually returns, which ALSO drops an archived/missing peer via `.filter(p => !p.archivedAt)`). Safe either way: `hasPeerLinks:false` means NO link touches this project at all, so `peer_list` is guaranteed empty and `peer_message` would always reject "not linked" — a working peer tool is never hidden. It's only slightly over-inclusive when this project's SOLE link points to an archived/missing peer: both tools stay registered but `peer_list` still reports zero peers and `peer_message` still rejects "not linked" — the exact pre-trim always-registered behavior, just no longer the common case. So most projects (linking is an owner-only, opt-in action) never need either tool in their floor. A link added later appears on the manager's very next tool call (`buildServer` is rebuilt fresh per request).

## Trust invariants enforced at send (`messagePeerManager`)

- LINK gate (`db.areProjectsLinked`): an unlinked or nonexistent target project is rejected.
- Self/same-project target rejected — use your own project's board instead.
- A soft-archived target (`project.archivedAt`) is rejected — `getProject` returns archived rows too, so without this check a linked-but-archived target would fall through to the board fallback below and dead-letter a card onto a board nobody watches.
- Manager↔manager ONLY: resolves the target project's LIVE session with `role==="manager"` — a live worker/platform/auditor session in that project is never matched, mirroring `session_spawn`'s manager|plain-only invariant, so the message can never land on the wrong kind of session.
- No privilege travels: delivered via the SAME `enqueueDurableMessage` channel `worker_message`/`session_message` use — a framed, `kind:"agent"` data message (one-per-turn) that grants the recipient nothing beyond an inbound turn it acts on WITHIN ITS OWN project.
- Rate-limited per ORIGIN manager session (`checkPeerMessageRateLimit`) so a compromised/confused manager can't turn this into a cross-project spam/probe vector.
- Reply-able: the frame stamps the ORIGIN `projectId` + sending manager's `sessionId` alongside its human-readable name — without this a recipient manager sees only a project NAME (`peer_message` requires an id, and nothing else exposes a linked project's id), so it could never reply without a full human relay, defeating this channel's whole no-human-relay premise (board gap, fixed by this commit).

When the target project has NO live manager, mirrors `deliverSessionMessage`'s offline path: rather than dropping the message or erroring, it boards a durable card on the target project's OWN board — the message is never lost, the peer's manager picks it up as a normal task on its next boot/attach. Audited both directions via a single `cross_project_message` event (this method's caller is the ONLY place that appends it, so origin/target are always recorded together).

## Do not

- Do not give an agent an MCP path to create or modify a `project_links` row — links are owner-declared, human-only, by design; a manager can only USE a link the owner already made.
- Do not narrow the `hasPeerLinks` registration check to exactly match `peer_list`'s own archived-peer filtering — the deliberate superset means a working peer tool is never hidden, at the small cost of staying registered (and correctly rejecting) for a project whose sole link is archived/missing.

## Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts` (above the `peer_message`/`peer_list` registration): lines 5381-5402 (pre-tranche-2 numbering), as of commit `f81f9c1108773e559efe78b7166cbf78b6201480`. Relocated by card `a2278b09` (tranche 2).
