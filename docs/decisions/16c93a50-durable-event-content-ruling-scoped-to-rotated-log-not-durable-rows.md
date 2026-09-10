# 16c93a50 — the content-in-logs redaction ruling is scoped to the rotated log, not a durable row

## Narrative

Card 16c93a50 (the content-in-durable-logs redaction policy — `LOOM_LOG_MESSAGE_CONTENT`, default OFF) left one question deliberately OPEN rather than silently extending its own ruling to cover it: request `0eb43216`'s ruling and card 16c93a50's own DoD are both scoped, in their own terms, to "the rotated daemon log" — the `console.*` stream `daemon-output.log` tees, a bounded, 60MB-capped file shared across every tenant on the host. A durable `orchestration_events` row (`sessions/service.ts`'s `db.appendEvent`) is a STRUCTURALLY DIFFERENT artifact: it never rotates away and stays queryable indefinitely via `events_search` and friends. Extending the rotated-log ruling to cover a durable row too would have been INFERRING an owner decision nobody actually made, not applying one already made — see card `a419a7e6` for where that separate question was actually decided, and `0eb43216`'s own record for the ruling this one is distinguished from.

## Do not

- Do not assume the `16c93a50`/`0eb43216` rotated-log content ruling also covers a durable `orchestration_events` row — that population was left deliberately open; see card `a419a7e6`'s own separate ruling.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`handlePromptMismatchUnresolved`'s method doc), as of `main` `59b443f3`.
