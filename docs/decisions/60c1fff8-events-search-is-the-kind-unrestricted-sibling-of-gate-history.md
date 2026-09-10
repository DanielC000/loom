# 60c1fff8 — `events_search` is the kind-unrestricted sibling of `gate_history`, reusing the Platform surface's own query path

## Narrative

Card 60c1fff8: the general, kind-unrestricted sibling of `gate_history` — that tool only ever surfaces settled GATE runs; a manager investigating a fleet-down incident may need `kill_switch`/`recycle_begin`/`merge_rejected`/`platform_escalate`/etc, none of which `gate_history` can return no matter how it's queried. The real registration already existed on the `LOOM_DEV`-gated Platform surface (`mcp/platform.ts`) — this is the SAME query path (`eventsSearchQuery`, shared via `./eventsSearch.js`), including the SAME card-`39f79291` unknown-`kind` rejection, never a hand-copied predicate that could drift from it.

PROJECT-SCOPED SERVER-SIDE, NOT BY ARGUMENT — identical posture to `gate_history`: there is no `projectId` parameter, the project is always the CALLER's own, resolved from this session. A manager cannot request another project's rows through any input this tool accepts, and a foreign-project row is never returned at all (not merely redacted).

The KNOWN GAP this tool's underlying join once had — `listOrchestrationEventsBounded` missing a row entirely because an emitter stamped `""` instead of a real session id — is fixed at the join and tracked separately; see card `ab1d1129`'s own record for that mechanism.

## Do not

- Do not hand-copy the unknown-`kind` rejection predicate here — reuse `eventsSearchQuery` (`./eventsSearch.js`) verbatim, the SAME query path the Platform surface's own `events_search` registration already uses, so the two can never drift apart.
- Do not add a `projectId` parameter to this tool — the project is always the caller's own, resolved server-side from the session, identical to `gate_history`'s posture.

## Source

Inline comment in `packages/daemon/src/mcp/orchestration.ts` (above the `events_search` tool registration): lines 4423-4438 (pre-tranche-2 numbering), as of commit `f81f9c1108773e559efe78b7166cbf78b6201480`. Relocated by card `a2278b09` (tranche 2).
