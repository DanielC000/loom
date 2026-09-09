# aa4e24ff — the `worker_redirect` advisory triggers on observable hold time, never on message text

## Narrative

Card aa4e24ff, §TRIGGER DECISION: how long a `worker_message` must have sat held behind a busy worker's mid-turn before `messageWorker` appends an advisory pointing the manager at `worker_redirect`. Gated on the observable `busyForMs` the hold already carries — never on the message's own text (a stop/hold phrase list is lexically unbounded and, worse, fires on an immediate delivery to an idle worker where nothing is actually landing late) — so this constant is the entire trigger surface; there is no companion phrase list anywhere in this file.

5 minutes: below it, an ordinary worker turn (a build/test cycle, a routine multi-file edit) can plausibly still end and drain the message soon on its own, so advising interruption would be noise more often than not. Above it, the hold is long enough that a manager who wants the message to land sooner should be told the interrupting alternative exists before they assume it already landed. Trade: a hold of a few minutes never gets the advisory even when a manager would have wanted it — deliberate, so a routine short hold doesn't teach managers to tune the advisory out (the same failure mode a text-trigger would have hit on every single message, per the card's reason 1).

## Do not

- Do not gate the `worker_redirect` advisory on the message's own text (a stop/hold phrase list) — it is lexically unbounded and fires falsely on an immediate delivery to an idle worker.
- Do not lower the 5-minute threshold casually — it is deliberately set so a routine short hold never triggers the advisory, avoiding the "manager tunes it out" failure mode a text-trigger would hit on every message.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (the `worker_redirect` advisory hold-time constant's top-of-block doc): lines 1630-1644, as of this tranche's HEAD. Relocated by card 5dcc1e98 (tranche 6); no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
