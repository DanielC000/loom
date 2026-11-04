# 6745e4bc — let a human re-pin profile grants on a live manager/worker/platform-lead session, row-write only

## The problem

A session's capability-grant surface (`browserTesting`, `documentConversion`, `capabilities`,
`restrictedTools`, `noCommit`, `skills`, `connections`, `vaultWrite`) is resolved once by
`resolveAgentSpawn` and pinned on the session row (`packages/shared/src/types.ts` ~890-966). Every
respawn path (resume/fork/recycle/boot) carries it forward unchanged — by design (card `298b826e`). The
only existing live re-pin was `upgradeCompanionCapabilities`, human-REST-only and `role:"assistant"`
only. A human binding a new connection (or revoking an old grant) to a manager/worker/platform-lead's
Profile had no way to reach an already-spawned lineage short of a fresh spawn.

## The design

`resolveAgentSpawn`'s role gate (`session.role !== "assistant"` in the old `upgradeCompanionCapabilities`)
was the only role-specific line in that whole method; everything else — resolve the fresh capability
surface (`skipGrantCarryoverCheck:true`, since this re-pins an EXISTING role, never a different one),
refuse the codex+restrictedTools combination (card `b94fcb72`), write the row via
`Db.setSessionCapabilitySurface` — is role-general already. Extracted that sequence into
`SessionService.repinCapabilitySurface` (shared core), with two callers:

- `upgradeCompanionCapabilities` (unchanged behavior) — assistant-only, still forces an immediate
  stop/resume to make the change live NOW, because the companion's REST "Save" UX promises synchronous
  effect.
- `SessionService.repinSessionGrants` (new) — refuses `role==="assistant"` (points the caller at the
  companion route instead, so there is never a second, divergent path for that role) and refuses any role
  other than `manager`/`worker`/`platform`. Writes the row via the shared core, records the skills-dropped
  advisory, diffs old vs new (`diffCapabilitySurfaceFields`), appends a `grants_repinned` orchestration
  event, and **stops — no pty touch at all.**

Exposed as `POST /api/sessions/:id/repin-grants` (`packages/daemon/src/gateway/server.ts`) — HUMAN-ONLY
loopback REST, Tier-0 (loopback-only, never exposable over an authenticated remote connection) — the
SAME tier as the companion upgrade route and `/merge` above it, but STRICTER than `/stop`, which IS
Tier-1 (`gateway/trust-tier.ts`'s `TIER_1_ROUTES`; verified: `/api/sessions/:id/stop` is listed there,
`/api/sessions/:id/merge` and `/api/companion/:sessionId/upgrade` are not). **No MCP tool anywhere**
(manager/worker/platform/setup/auditor surfaces) calls this.

## Why row-write only — no forced live-now respawn

This was the owner-approved fork in the design (card `6745e4bc`'s own `worker_report` history). A
companion's `upgradeCompanionCapabilities` Ctrl-C's a BUSY session after a short bounded wait
(`UPGRADE_BUSY_WAIT_MS`, `@decision d88163b7`) — safe there because a companion turn is typically a short
chat reply; the same interrupt on a manager/worker/platform-lead can land mid-build, mid-git-operation, or
mid-`run_gate` — exactly the shape `d88163b7`'s own narrative warns "loses that turn outright: nothing
recaptures it." Forcing that is a materially bigger risk here than for a companion, for no stated need:
the card's own wording ("applied at the next resume/recycle") already anticipated the lower-risk design.

None of this actually blocks the field from taking effect promptly, but the two Tier-1 fields below are
NOT uniformly "live on the very next call" — a FIRST-TIME grant of either is the one case that still
waits for a respawn (round 2 correction, below):
- `noCommit` (read fresh off the row at `workerReport` time, never threaded into spawn argv) goes live on
  the session's very next `worker_report` call — no respawn needed, for any role, unconditionally.
- `connections`/`vaultWrite` (`@decision 1a048349`) are live on the very next MCP call for a REVOCATION
  or a non-empty→non-empty / true→true change — `mcp/server.ts`'s `TaskMcpRouter` re-resolves them fresh
  off the row on every request, so the row write alone is enough. **A FIRST-TIME grant is different**:
  `authenticated_request`/`vault_write` are each registered CONDITIONALLY (`mcp/server.ts` ~:866/~:914 —
  only when the resolved list/flag is already non-empty/true), and the daemon never sends MCP's
  `tools/list_changed` (verified: zero occurrences of `listChanged`/`list_changed`/`sendToolListChanged`
  in `packages/daemon/src`), so a live engine that already listed its tools has no signal that one of
  these now exists. Whether the real claude/codex engine independently re-lists tools at some later point
  (and would then pick it up anyway) is UNVERIFIED here. Treat a first-time grant of either field as
  needing this session's next resume/fork/recycle before the newly-registered tool is actually callable
  — same timing as the Tier-2 fields below, not "the very next call."
- `skills`/`capabilities`/`browserTesting`/`documentConversion`/`restrictedTools` take effect at this
  session's NEXT resume/fork/recycle/boot-reconcile — the same row-carry-forward machinery that already
  exists; this card only adds a way to change what that machinery reads BEFORE the next natural one of
  those fires.

## Do not

- Do not add a force-live-now (stop/resume) option to `repinSessionGrants` without a fresh owner
  decision — this is a DELIBERATE scope cut (see "Why row-write only" above), not an unfinished TODO. If
  real demand shows up, it needs its own card and its own risk analysis for the worker/manager/
  platform-lead turn-interruption case specifically; it cannot be justified by analogy to the companion
  route alone.
- Do not let `repinSessionGrants` touch `harness` — it stays pinned forever (multi-harness/codex-isolation
  invariants; even `upgradeCompanionCapabilities` refuses rather than changes it, card `b94fcb72`).
  Re-pinning harness is a different, much bigger subsystem (`recycleHarness`/`harnessDrainStatus`).
- Do not let `repinSessionGrants` touch `permission`/`model`/`allowDelta` — they are ALREADY correctly
  re-resolved on every recycle today (verified: `recycleWorker`'s `workerSpawn?.permission`/
  `workerSpawn?.model`, both explicitly commented "re-resolved"); there is no bug there to fix, and
  folding them into this surface would re-derive logic that already works.
- Do not widen `repinSessionGrants` to any role beyond `manager`/`worker`/`platform` without a fresh
  scoping decision — `setup`/`auditor`/`workspace-auditor`/`operator`/`run`/plain sessions were
  deliberately left out of this card's approved scope.
- Do not change `recycleManager`/`recycleWorker`/`recyclePlatformLead`'s own `old.X ?? default`
  carry-forward to "fix" the asymmetry this card's revocation semantics create — `repinSessionGrants`
  writes the row BEFORE whatever resume/recycle happens next; it never runs INSIDE one, and
  `recycle_me`/every agent-triggered recycle must keep carrying the row forward exactly as `298b826e`
  ruled.
- Do not read a no-diff `repinSessionGrants` call as a no-op that skips the audit event — it still files
  `grants_repinned` with `diff: {}` (mirrors `profile_grant_reach`'s own "filed on every widening,
  `agentCount:0` included" precedent) so an absent row always means "never re-pinned," never "re-pinned
  but detail lost."
- Do not assume revoking a Tier-2 field (e.g. `browserTesting`) retroactively unmounts an already-live
  MCP server from a currently-running process — it only takes effect at the next respawn, same
  asymmetry `d88163b7` already documents for newly-GRANTED levers (this just adds the mirror case for
  revoked ones). Not a new hazard; disclose it in UI copy if one is ever built, don't try to "fix" it here.
- Do not call `repinSessionGrants` on a STALE id without a refusal (round 2, Code Review) — a session row
  with `archivedAt` set has no live process to re-pin grants on, and a row that has been superseded by a
  recycle successor (`Db.getSuccessor`, some row with `recycledFrom` pointing at it) is no longer the
  lineage's current owner. Both refuse, the successor case naming the successor id so the caller can
  redirect to it instead of guessing which row is now live.

## Relationship to `547d5fc4`

`resolveAgentSpawn` re-resolves the bound profile's CURRENT `skills` subset on every call it makes,
including the one `repinCapabilitySurface` makes here. `547d5fc4`'s own rule ("never re-resolve the
profile's skills subset on resume/fork/recycle/boot — read the PINNED value off the row") does not
apply to this card: that rule protects the carry-forward paths, where the row's already-pinned value
must survive untouched across an ordinary respawn. `repinSessionGrants`/`upgradeCompanionCapabilities`
are the opposite — a DELIBERATE, human-authorized re-pin of an existing row, the one place outside a
fresh spawn where re-reading the live profile (skills included) is the entire point. This is a scoped,
intentional exception to `547d5fc4`, not a violation of it.

## Source

`packages/daemon/src/sessions/service.ts`: `repinCapabilitySurface`, `repinSessionGrants`,
`diffCapabilitySurfaceFields` (module-level, right before the `SessionService` class).
`packages/daemon/src/gateway/server.ts`: `POST /api/sessions/:id/repin-grants`.
`packages/shared/src/types.ts`: `OrchestrationEventKind`'s `"grants_repinned"` member.
`packages/daemon/src/db.ts`: `DURABLE_AUDIT_EVENT_KINDS` membership.

Board card `6745e4bc`, discovered from `298b826e`'s investigation (`docs/decisions/
298b826e-connections-recycle-freeze-kept.md`).
