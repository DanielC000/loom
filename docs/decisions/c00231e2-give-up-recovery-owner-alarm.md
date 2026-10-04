# c00231e2 — alert the owner on repeated manager submit give-up recovery

## Why

A MANAGER/platform-lead session's own submit GIVE-UP RECOVERY (`pty/host.ts`'s `fireEnterAndVerify` give-up branch — an Enter write that never confirmed after `SUBMIT_MAX_ATTEMPTS`) used to show up ONLY as `[submit] ... GIVE-UP RECOVERY ...` console lines. A real production session fired dozens of these over ~4h and the owner learned of the chronic pattern only once the fleet went visibly quiet (card `347b3584`'s investigation).

Workers are excluded: their owning manager already sees `composerDirtyLen`, so a worker give-up already has a natural reader. A manager/platform-lead's own give-up has nobody above it but the owner — the same "nobody left to tell but the human" shape as `context_escalated`/`idle_escalated` (ContextWatcher/IdleWatcher). This event is filed the same way: no nudge is enqueued, and `attention.ts` (web)/`AlertWebhookEmitter` both derive the human-facing alert from the event alone.

PtyHost has no DB access (the same layering boundary as `onKickoffGiveUpExhausted`/`onCodexSubmitUnconfirmed`), so the counting/windowing lives entirely in PtyHost (`Live.giveUpRecoveryFiredAt`/`giveUpRecoveryAlarmed`, `maybeFireGiveUpRecoveryAlarm`) and the event itself is appended by the implementer (`SessionService.handleGiveUpRecoveryAlarm`, wired in `index.ts` via the optional `PtyHostEvents.onGiveUpRecoveryAlarm` hook) — mirroring every other PtyHost-has-no-DB signal in this file.

## Episode / latch mechanics

- `Live.giveUpRecoveryFiredAt: number[]` is a rolling, in-memory timestamp list, per session, pushed to ONLY for a manager/platform-lead session (gated at the one call site before any counting starts — a worker's entry stays permanently empty).
- On every qualifying fire: prune entries older than `GIVE_UP_RECOVERY_ALARM_WINDOW_MS` FIRST, then push the new timestamp.
- If pruning left the array EMPTY *before* the new timestamp was pushed, that means a quiet gap of at least the window, with zero fires, just elapsed — this is what resets `Live.giveUpRecoveryAlarmed` to `false` and starts a fresh episode.
- Once pruned+pushed, a count at or past `GIVE_UP_RECOVERY_ALARM_THRESHOLD` fires `PtyHostEvents.onGiveUpRecoveryAlarm` IF `giveUpRecoveryAlarmed` is still `false` for this episode, then immediately sets it `true` — this is the one-alarm-per-episode latch. A quiet gap is the ONLY thing that resets it.
- This mirrors `worker_stuck`'s own "emitted once per episode, re-arms on progress" shape, just keyed on a quiet gap instead of forward progress (there's no natural "progress" signal for a give-up the way there is for a long-running worker turn).

## No-nudge rationale

`SessionService.handleGiveUpRecoveryAlarm` appends ONLY the durable `give_up_recovery_escalated` orchestration event — no `enqueueSystemNudge` to the session itself. This matches `context_escalated`/`idle_escalated` exactly: the session experiencing the give-ups IS the top of its own hierarchy (no parent to notify, unlike `handleRepeatedToolCall`/`handleCodexSubmitUnconfirmed`, which nudge BOTH the session and its parent). A nudge to the session itself would tell it something it's already structurally aware of (it's the one giving up); the owner is the only party who doesn't yet know.

## No-content rule

`detail` carries `{ count, windowMs }` only — counts and a duration, never message text. The alarm's whole point is to surface a PATTERN (repeated failure), not any one message's content, so there is nothing here that needs `redactedExcerpt`'s content-bearing chokepoint at all. `log-message-content-gate.mjs`'s exact-count census (section 4) is unaffected by this feature — confirmed by running it: the new `console.log`/`console.error` lines in `maybeFireGiveUpRecoveryAlarm` never call `redactedExcerpt(`, so the census's site count is unchanged.

## Do not

- Do not count a WORKER's give-ups toward this alarm, or let one reach `maybeFireGiveUpRecoveryAlarm`'s counting logic at all — they are gated out at the source (`live.role !== "manager" && live.role !== "platform"` returns immediately), not merely filtered later, so a worker's `Live.giveUpRecoveryFiredAt` stays permanently empty. Their owning manager already has `composerDirtyLen` for this.
- Do not re-arm (reset `giveUpRecoveryAlarmed`) on the alarm callback's own delivery outcome, success or failure — only a quiet gap of at least `GIVE_UP_RECOVERY_ALARM_WINDOW_MS` with zero further fires may reset the latch. An undeliverable or throwing `onGiveUpRecoveryAlarm` handler must not cause this episode to re-fire and spam the same burst again; `maybeFireGiveUpRecoveryAlarm` wraps the call in try/catch specifically so a handler fault can never feed back into the latch.
- Do not put message/command text into `detail` — this event is a pattern signal, never a content-bearing diagnostic. If a future need arises to carry content here, route it through the `redactedExcerpt` chokepoint like every other content-bearing line in this file, and update `log-message-content-gate.mjs`'s exact-count census accordingly.
- Do not infer `GIVE_UP_RECOVERY_ALARM_THRESHOLD`/`WINDOW_MS` crossing from anything other than `Live.giveUpRecoveryFiredAt`'s own length after pruning — do not, for instance, derive a count from log lines or from `requeueGiveUpOrigin`'s separate per-message `giveUpRequeues` budget tracking, which answers a different, stricter question (one message's own retry budget, not this session's overall give-up rate).
