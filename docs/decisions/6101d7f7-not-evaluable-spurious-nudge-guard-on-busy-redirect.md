# 6101d7f7 — `not-evaluable`: a busy-redirect's synchronous busy-clear-before-drain window is not a strand

## Narrative

`not-evaluable` — SPURIOUS-NUDGE GUARD (card 6101d7f7): `redirectWorker` on a BUSY worker enqueues its redirect into `live.pending` FIRST, then — in the SAME tick — clears busy and drains it. That clear fires the caller synchronously, BEFORE the drain hands the redirect over, so at this instant the worker looks stranded even though it has authoritative direction about to land as its very next turn. Also covers a non-worker/parentless/taskless session (nothing to classify).

## Do not

- Do not classify a worker as stranded during the synchronous window between `redirectWorker`'s busy-clear and its drain handing the queued redirect over — it has authoritative direction landing as its very next turn, not a strand.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`classifyIdleWorker`): lines 12725-12729, as of commit `a07c5092c871d47f25aeb2ec160958306294a043`. Relocated by card `3f40210c`; no wording changed, wrapped source lines joined into a flowing paragraph, the leading list-bullet marker and `*` comment markers stripped.
