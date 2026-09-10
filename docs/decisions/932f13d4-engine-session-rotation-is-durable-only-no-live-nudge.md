# 932f13d4 — engine-session-id rotation is recorded durable-only, deliberately no live nudge

## Narrative

`handleEngineSessionRotated` (`sessions/service.ts`) consumes `PtyHostEvents.onEngineSessionId`'s
`previousEngineId` param: a genuine engine-session-id ROTATION (a second `SessionStart` reporting a
different `session_id` for the SAME live pty — see `pty/host.ts`'s `SessionStart` handler doc / card
7c1fc117) just landed for a session. By the time this fires, `db.setEngineSessionId` has already
overwritten the tracked id — this is the ONLY durable record of the OLD id (card 8a5bd0d0's own
finding: nothing downstream can reconstruct it).

Unlike its sibling handlers (see [[b68d1f5b-window-sizing-and-calibration]]'s "Consumption" section
for the established two-recipient shape), this one is durable-ONLY, deliberately with NO live nudge: a
single rotation is not a decision point for anyone in the moment — it's audit trail for two triggers
named on card 932f13d4 itself (a transcript read that comes back shorter than expected; a future
revisit of cross-rotation stitching). `managerSessionId` falls back to the session's own id when it
has no parent (a manager/plain/setup session rotating its own engine id) — the same not-null-column
convention `handlePasteLengthLoss` uses.

To read the accumulated rotation history: `db.appendEvent`'s rows are queryable via `SELECT id, ts,
worker_session_id, detail_json FROM orchestration_events WHERE kind = 'engine_session_rotated' ORDER
BY ts` — the row count is the lifetime rotation count SINCE this shipped (starts at ZERO on deploy,
never back-filled). Do not difference it against card 8a5bd0d0's own pre-existing "4 in the retained
log window" figure — that is a different, retention-bounded instrument (a log window, not a durable
table), and the two counts are not comparable.

## Do not

- Do not add a live nudge to this handler — a single rotation is deliberately not a decision point for
  anyone in the moment; it's audit trail only.
- Do not diff this event's lifetime row count against card 8a5bd0d0's own "4 in the retained log
  window" figure — that figure comes from a different, retention-bounded instrument.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`handleEngineSessionRotated`'s own
JSDoc), as of `main` `b4721fd1`. Extracted by card `da28e0a5` (tranche 22 on `sessions/service.ts`).
