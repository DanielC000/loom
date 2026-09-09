# e955b5d8 — `rate_limit_bailed` is an event-trigger-eligible kind; its siblings are not

## Narrative

Card e955b5d8 (2026-08-05) added `rate_limit_bailed` to `EVENT_TRIGGER_EVENT_KINDS`, alone among the usage-limit kinds card 33d5aef1 introduced. `session_rate_limited` (the park) was already eligible — a park is self-healing (the watcher resumes it) — while a bail is the terminal failure where auto-resume was abandoned past its give-up deadline and the fleet silently stops recovering: the single most invisible/consequential case the card names. If the park is worth an automation waking someone for, the bail is worth it more.

Its siblings — `rate_limit_resumed`, `rate_limit_recovered`, `usage_latch_armed`/`usage_latch_cleared`, `worker_spawn_usage_blocked` — stay OUT of the allowlist: they are episode MECHANICS (routine resume/latch bookkeeping an operator doesn't need paged for), not attention-worthy signals.

## Do not

- Do not add `rate_limit_resumed`, `rate_limit_recovered`, `usage_latch_armed`/`usage_latch_cleared`, or `worker_spawn_usage_blocked` to `EVENT_TRIGGER_EVENT_KINDS` without a fresh case — they were deliberately excluded as routine bookkeeping, not attention-worthy signals.

## Source

JSDoc comment in `packages/shared/src/types.ts` (`EVENT_TRIGGER_EVENT_KINDS`'s own doc, the "DECISION (card e955b5d8, 2026-08-05)" paragraph). Extracted by card 04705438 (tranche 2 on `packages/shared/src/types.ts`); wrapped source lines joined into flowing prose, wording otherwise unchanged.
