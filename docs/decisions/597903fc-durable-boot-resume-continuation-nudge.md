# 597903fc — a boot-time continuation nudge must survive give-up exhaustion, not just log a console line

## Narrative

Card 597903fc: `enqueueDurableNudge`'s durable post-resume continuation-nudge dispatch closes a real asymmetry a card audit found between `[loom:crash-recovered]` (routed through a bare role-gated defer, no durability) and its sibling `[loom:merge-orphaned]` (already routed through `enqueueDurableMessage`). Before this card, a boot-resume nudge sent via a bare `pty.enqueueStdin` (no `onGiveUpExhausted`) drops the message with nothing surviving but a console line once its one give-up requeue is exhausted (`host.ts`'s `submit()`: "non-durable entry, nothing further to preserve"). `enqueueDurableNudge` closes that gap the same way `enqueueDurableMessage` already does for the merge-orphaned sibling: on give-up exhaustion, its wired `onGiveUpExhausted` hook (`handleGiveUpExhausted`) re-mints the dispatch (self-healing under exactly the contention a whole-fleet boot resume creates) and, once truly exhausted past `GIVE_UP_REMINT_LIMIT`, appends a durable `session_message_gave_up` (`outcome:"parked"`) audit event unconditionally — never a silent loss, matching the bar every other daemon-originated settle nudge already meets.

The dispatch is role-gated via `waitForMcpSeen` for a role that mounts `loom-orchestration` (so the resume race guard `usesOrchestrationMcp` describes applies), and dispatches immediately for every other role. It always sends with `sender:"system"` (a daemon-generated notice, no originating session) — safe by the same reasoning `enqueueDurableMessage`'s own doc gives for every other sentinel-sender call site: `db.getSession("system")` returns `undefined`, so `handleGiveUpExhausted`'s sender-facing PARKED notice is skipped, never thrown.

## Do not

- Do not dispatch a boot-time continuation nudge via a bare `pty.enqueueStdin` with no `onGiveUpExhausted` — a give-up exhaustion then drops it with nothing surviving but a console line.
- Do not assume `sender:"system"` needs its own special-case handling in `handleGiveUpExhausted` — `db.getSession("system")` returning `undefined` already makes the sender-facing PARKED notice skip cleanly, matching every other sentinel-sender call site.

## Source

JSDoc comment in `packages/daemon/src/sessions/service.ts`, above `enqueueDurableNudge`: lines 4352-4369, as of this tranche's HEAD (tranche 10).
