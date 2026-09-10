# 280309d9 — `pendingWrittenAt` is captured at classification time, not at the later timer's own fire

## Narrative

Card `280309d9`: the REAL Enter-write instant for the pending mismatch's generation — the same field `writeWallClockAt` (this identical generation's own notice text, see card `3ff61275`) already reads from `live.currentGenFirstWrittenAt` — is captured HERE, at detection time, because by the time `checkPromptMismatchUnresolved`'s own event is stamped (`PROMPT_MISMATCH_RESOLVE_WINDOW_MS` later), that event's own `ts` is the GIVE-UP instant, not the original write instant, and nothing downstream could otherwise recover which instant this was without an external, manual `[prompt-echo]` log join.

`null` only in the defensive case this generation's own write was never recorded (mirrors `writeWallClockAt`'s "an unrecorded time" prose sentinel) — but as a real `null` here, since this value travels into a structured `detail` object, not human-facing notice text, so a prose sentinel would be wrong for its consumer.

## Do not

- Do not read `writtenAt` off the later `checkPromptMismatchUnresolved` timer's own fire-time — that event's timestamp is the GIVE-UP instant, not the write instant; capture at classification time into a closure local instead.
- Do not use a prose sentinel ("an unrecorded time") for the structured `detail` field the way the human-facing notice text does — this field is consumed as data, not read as prose, so the "not recorded" case must be a real `null`.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (`deliverHook`'s `UserPromptSubmit` case, the `checkPromptMismatchUnresolved` timer-arming block). Extracted by card `96bf8f32` (tranche 22 on `pty/host.ts`); wording condensed, content preserved.
