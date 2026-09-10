# 107b595b — `escalation_status` list mode defaults to OPEN escalations only

## Narrative

A manager checking in on `escalation_status` in list mode (no `taskId` given) used to get every
`platform_escalate` event ever filed for its project — most of it days-stale `resolved`/`closed`
history it didn't ask for. Measured incident: a manager paid roughly 44KB of stale history, twice,
when it only needed the open ones.

**Fix:** list mode is bounded to OPEN escalations by default — `pending`/`in_progress` only. Pass
`includeResolved:true` to opt back into the full, unfiltered history. The single-`taskId` lookup is
unaffected either way — it was already cheap and never carried the bulk cost.

## Source

`packages/daemon/src/sessions/service.ts` — `escalationStatus` (extraction tranche 32).
