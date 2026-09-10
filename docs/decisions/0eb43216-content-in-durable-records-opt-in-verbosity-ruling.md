# 0eb43216 — content-in-durable-records ruling: opt-in verbosity, explicit env flag, default OFF

## Narrative

Request `0eb43216` answered the open "should a durable record ever carry raw message content" question that cards `38d68b8d` (the `onPromptMismatchUnmatched` push notice) and `handlePromptMismatchUnresolved`'s own `messageExcerpt` field (card `a419a7e6`) had both deliberately left pending: opt-in verbosity — content only under an explicit env flag (`LOOM_LOG_MESSAGE_CONTENT`, default OFF). This is the SAME flag every other raw-text diagnostic in `sessions/service.ts` already gates on (`isLogMessageContentEnabled`), not a new one minted for this population.

The ruling's own scope is stated in terms of "the rotated daemon log" (the `console.*` stream `daemon-output.log` tees) — see card `a419a7e6` for why that scope does not automatically extend to a durable `orchestration_events` row, and card `16c93a50` for the same distinction cited from a second, independent site.

## Do not

- Do not assume this ruling's "rotated daemon log" scoping automatically covers a durable `orchestration_events` row — see card `a419a7e6`'s own separate ruling for that population.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`handlePromptMismatchUnmatched`'s method doc), as of `main` `59b443f3`.
