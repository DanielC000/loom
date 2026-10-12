# 3d5fcd00 — companion attention-push's idle-episode dedupe is POSITIONAL, never the web's current-run derivation

## Do not

- Do not derive the chat suppression decision for an `idle_report(done)` event from the manager's
  CURRENT state as of now (i.e. by reusing the web's `idleDoneEpisodeStarts`, which replays the whole
  event history and asks "is a run active, and since when"). Code Review `10713b51` of `c2655f88` found
  this MAJOR: the tail-poll scanner can classify an event meaningfully later than its own timestamp (a
  digest's not-yet-due re-scan, a no-stacking/rate-limit defer holding the watermark, or simply two
  events landing in one `EVENT_TAIL_LIMIT` window) — if a run-breaking event (`idle_report`
  `working`/`waiting`, or `idle_escalated`) for the SAME manager already landed durably by the time the
  real `done` is classified, a current-run read reports no active run at all, so the `done`'s own id
  never matches "the current starter" and it is SILENTLY DROPPED — a real drain never reaches chat, with
  no sign anything went wrong.
- Do not key the "what came immediately before this event" lookup (`getLatestIdleEpisodeEventBefore`,
  db.ts) on sqlite's own rowid. Use `seq` — the same never-reused, monotonic column
  `listEventsSince`/`getMaxEventSeq` already key the watermark on, for the identical hard-delete-reuse
  hazard (see `orchestration_events`'s own `seq` doc in SCHEMA, and
  `companion-attention-push.mjs`'s test 14).
- Do not port this positional rule to the web's QUEUE DRAINED dismiss key, or try to make the two
  mechanisms share one derivation. They answer genuinely different questions — see below.

## Why chat and web need DIFFERENT rules for the SAME episode concept

Both surfaces are deduping the same underlying fact (`idle_report` is agent-filed, so a manager that
stays drained re-files `state:"done"` on every nudge cycle), but they're asking different questions of
it:

- **The web** (`idleDoneEpisodeStarts`, `@loom/shared`, decision `611e76ba`) needs, AT RENDER TIME, "what
  is the stable identity of the CURRENTLY ACTIVE drained episode, if any" — a level-triggered question.
  There is always a real "now" to ask it against, and if no run is active right now, "nothing to show" is
  the genuinely correct answer. Replaying the whole history to answer "what's true as of this instant" is
  exactly right here.
- **Companion attention-push** needs, AT THE MOMENT ONE SPECIFIC EVENT `e` IS CLASSIFIED, "does pushing
  `e` duplicate something already pushed for this same drained stretch" — an edge-triggered question
  about `e`'s own fixed position in the timeline, independent of anything that happens afterward. Reusing
  the web's current-run read here was the MAJOR: a tail-poll watcher's "now" (when it finally gets around
  to classifying `e`) can be arbitrarily later than `e`'s own timestamp, and the run-breaking event that
  makes the current-run read go empty may itself have already landed in that gap — through no fault of
  `e`.

## The fix

`Db.getLatestIdleEpisodeEventBefore(managerSessionId, beforeSeq)` (db.ts) — an indexed
(`idx_orch_events_mgr`), manager-scoped point lookup: the most recent `idle_report`/`idle_escalated`
event for `managerSessionId` with `seq` strictly less than `beforeSeq`, or `undefined` if none exists.
`attention-push.ts`'s classify loop pushes a qualifying `idle_report(done)` event `e` unless that answer
is itself an `idle_report(done)` — a continuation of a run already surfaced. Because the lookup only ever
looks BACKWARD from `e`'s own fixed `seq`, it can never be invalidated by anything landing after `e`, so a
since-ended drain still pages exactly once instead of silently vanishing. This fails toward VISIBLE
(a late/duplicate-looking page) rather than toward silence, which is the correct direction for an owner
attention surface — losing a real alert is worse than one arriving a beat late.

`idle_escalated` is excluded from this check by `kind` (not by `cls`, same discipline as the
`platform_escalate`/`claude_boot_dialog_stuck` split elsewhere in this file) — it already fires at most
once per episode at its own source, so it is never suppressed here and always pushes on its own.

## Coverage

`packages/daemon/test/companion-attention-push.mjs` section 36 (36a–36i): the original repeat-push /
restart-safety / burst-and-digest-don't-count-suppressed-rows cases (36a–36e), plus the MAJOR's own
repro shapes (36f–36i): a `done` immediately followed by a same-window run-breaking event (both durable
before the first tick), the identical shape under digest buffering (broken before the flush, must still
survive into it), a `done`→`idle_escalated` pair landing in one window, and two managers' idle timelines
interleaved in one scanned window.
