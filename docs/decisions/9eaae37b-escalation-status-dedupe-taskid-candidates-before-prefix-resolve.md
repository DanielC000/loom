# 9eaae37b — `escalation_status` dedupes taskId candidates to ONE per id before `resolveIdPrefix`

## Narrative

`resolveIdPrefix`'s contract is one candidate per entity, but `escalationStatus`'s single-`taskId`
lookup was feeding it the raw `platform_escalate` event list. A re-escalated card contributes one
`platform_escalate` event per escalation, so the event list can hold several entries sharing the
same `taskId` — which made an otherwise-UNAMBIGUOUS prefix resolve as `ambiguous` against its own
repeated id.

**Fix:** dedupe to ONE candidate per DISTINCT `taskId` before resolving, keeping the LATEST event per
`taskId` (highest `ts`) — the freshest filed title/state for that card.

## Source

`packages/daemon/src/sessions/service.ts` — `escalationStatus` (extraction tranche 32).
