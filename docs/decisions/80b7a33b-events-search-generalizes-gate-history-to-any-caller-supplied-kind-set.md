# 80b7a33b — generalize the gate-history page shape to an arbitrary, caller-supplied event-kind set

## Narrative

Card 80b7a33b: `listOrchestrationEventsBounded` is a BOUNDED, kind-filterable, newest-first page of `orchestration_events` across the whole platform (or scoped to one project/session/task), plus the total matching count. It generalizes `listGateEvents`'s own bounded/paginated/JOIN-enriched shape (same project/agent/branch/task-title enrichment, same clamp-and-report-effective-limit contract) to an ARBITRARY caller-supplied `kind` set instead of the hardcoded `GATE_HISTORY_KINDS` — the read that closes the gap a Lead's forensics repeatedly fell back to raw sqlite for: a fleet-down incident isn't limited to gate-run kinds (it may need `kill_switch`/`recycle_begin`/`merge_rejected`/`platform_escalate`/etc.).

The SHARED `eventsSearchQuery` helper (`mcp/eventsSearch.ts`, card `39f79291`, widened to a second caller by card `60c1fff8`) validates `kind` against the real `OrchestrationEventKind` set BEFORE it ever reaches this function, rejecting an unrecognized value with an explicit error instead of letting it fall through to a silent empty page — shared verbatim by BOTH the `events_search` MCP tool on the platform surface (`mcp/platform.ts`) and its manager-surface sibling (`mcp/orchestration.ts`), so neither can drift from the other's validation.

## Do not

- Do not read this function's own zero-rows-on-a-bad-kind behavior as "`events_search` returns `[]` on a bad kind" — that gap is closed one layer up, in the shared `eventsSearchQuery` validator, not here.
- Do not let the platform-surface and manager-surface `events_search` tools validate `kind` independently — both must share `eventsSearchQuery` (card `39f79291`/`60c1fff8`), or the two can silently drift apart.

## Source

Inline comment in `packages/daemon/src/db.ts` (`listOrchestrationEventsBounded`, minus the class-A parameter-binding safety guard left inline): lines 5897-5918, as of this tranche's HEAD.
