# 8882e2ca — the kickoff plausible-confirm window governs ANNOUNCEMENT only, never delivery-ladder timing

cdbfa311 + fd4704bc made the give-up/re-mint/requeue delivery ladder's OWN timing safe for a large
turn-1 kickoff and it is deployed. But the ladder's own scaled hold (`giveUpHoldExtraMs`, capped at 90s
extra per cycle) still parks well before the real engine confirms a large kickoff under host load — a
~69K-char kickoff's own PARK fired at ~97s in production while the real confirmation landed at
~340-346s (this card's own investigation, read-only against `daemon-output.log`). The manager-facing
`[loom:worker-spawn-broken]` notice (both emission paths — the periodic idle-watchdog's flat
`BROKEN_SPAWN_HOLDOFF_MS` holdoff, and `handleKickoffGiveUpExhausted`'s terminal PARK) was asserting
"broken" roughly a quarter to a third of the way into the real confirm tail. A second, independent
defect: a late confirming hook can land AFTER the manager's own `worker_stop` call (a real race — a
specimen in this card's own investigation landed ~487ms after the stop), and the `[loom:redelivery-
confirmed]` notice read as an ordinary confirmation with no indication of that.

Code Review `f3fa9002` (round 2) found the first implementation incomplete: nothing ever escalated a
softened notice back to the terminal one for a TASKLESS worker (`tickIdleWorkers` skips `!taskId`
entirely), and for a TASKED worker escalation only ever arrived via the unrelated `idleWorkerMinutes`
periodic cadence (default 45min), not at the moment the window actually ended. It also found `kickoff
ConfirmPending`/the `worker_stop` warning never expired (size+turnSeq only, no elapsed-time check), three
independent re-derivations of the same size/elapsed read, and a bare "a `worker_retired` event exists in
history" check that would stay true forever past a later resume.

## The fix

`withinKickoffConfirmWindow(pty, sessionId, turnSeq)` (`pty/host.ts`) is now THE one shared predicate —
every consumer calls this, never re-derives the size/elapsed-time read on its own:
- EXPIRES (returns `null`) the instant `turnSeq` is past 0 — checked FIRST, before any
  `composerDirtyLen`/`liveStartedAt` read, so a lagging `composerDirtyLen` (card c148f118's own
  documented staleness) can never keep it non-null past the point the kickoff actually confirmed.
- Also `null` when unmeasurable (`liveStartedAt` absent).
- Also `null` once `sinceMs` (elapsed since `liveStartedAt`) clears `windowMs`
  (`BROKEN_SPAWN_HOLDOFF_MS` + `kickoffConfirmWindowMs(composerDirtyLen)`) — the genuine elapsed-time
  expiry that was missing before.

Consumed identically by:
- `pastBrokenSpawnHoldoff` (`sessions/service.ts`) — `=== null` means "past the holdoff."
- `handleKickoffGiveUpExhausted`'s terminal PARK branch — non-null sends the distinct
  `[loom:kickoff-confirm-pending]` notice instead of the terminal one; `null` (including a PARK that
  happens to land already past its own window under heavy host load) sends the unchanged terminal
  wording. This is also what eliminates the "Path-1-terminal-then-Path-2-pending contradiction" Code
  Review Minor 3 flagged: both paths now read the exact same predicate, so they can never disagree.
- `kickoffConfirmPendingFor` (`mcp/orchestration.ts`, `worker_list`/`worker_status`'s
  `kickoffConfirmPending` field) and `describeKickoffConfirmPendingForStop` (`worker_stop`'s own advisory
  `kickoffConfirmPendingWarning`) — both now expire on the same two axes as everything else.

**Major 1 — the one-shot escalation timer.** The instant `handleKickoffGiveUpExhausted` sends the softer
notice, it arms a one-shot `setTimeout` (`SessionService.armKickoffConfirmRecheck`, tracked in
`kickoffConfirmRecheckTimers`) for exactly `windowMs - sinceMs` — the remaining time until THIS worker's
own window ends. When it fires, it calls `notifyManagerOfIdleWorker` directly — the SAME entry point
every other escalation path already uses, so the eventual terminal notice (if the kickoff still hasn't
confirmed) is never a second, divergently-worded copy. This covers a TASKLESS worker (no periodic
coverage exists for one at all) exactly the same way as a tasked one, and fires exactly when the window
ends rather than on some unrelated cadence. Cleared at every point the kickoff can resolve or the worker
can stop existing: a genuine confirm (`handleGiveUpConfirmed`), stop/auto-retire/merge_confirm
(`retireWorkerSession`, the one shared chokepoint all three route through), recycle (`recycleWorker`'s
own predecessor stop — never `worker_retired`-marked, card 4ee527d1, so this is its only clear site), and
exit (`archiveOnExit`). The fired callback also re-checks the session isn't archived before calling in,
on top of those explicit clears.

**Minor 4 — `handleGiveUpConfirmed`'s stopped-session wording is EPOCH-aware.** It calls
`db.isWorkerRetirementActive(sessionId)` (compared by the never-reused `orchestration_events.seq`, card
4ee527d1) rather than a bare "has a `worker_retired` event ever fired" check — a worker stopped and then
later RESUMED (`worker_retirement_lifted`) reads as an ordinary confirmation again, not permanently
"SINCE BEEN STOPPED."

**Minor 5 — `purgeQueuedWorkerIdleNudges`** (`pty/host.ts`) now also purges a still-queued
`[loom:kickoff-confirm-pending]` nudge on the worker's own busy re-engage edge, alongside its two
terminal siblings — a stale "still pending" read is just as wrong as a stale "broken" one.

## Round 2 (Code Review 6a497b53)

**Major 1 — the content-matched confirm is not the only way a turn starts.** A mismatch/fusion echo, an
ambiguous multi-batch match (deliberately left unresolved, `onGiveUpConfirmed`'s own doc), or a plain
manager message/human Enter freeing the composer can all start a real turn WITHOUT
`handleGiveUpConfirmed` ever firing — the explicit clear sites alone missed every one of these, and the
fired callback fired a stale notice into a now-busy or already-reporting worker (the CR reproduced a
false `[loom:worker-idle] ... did NOT call worker_report` for a tasked worker and a false
`neverCompletedTurn` for a taskless one). Fixed two ways: (1) the fired callback re-checks live state
itself (`hasFirstTurnStarted`/`busy`/`turnSeq>0`) and stands down if any is true, regardless of whether
an explicit clear ever ran; (2) `purgeStaleIdleNudgeForReengagedWorker` (the worker's own busy
re-engage edge — the ONE clean site that covers every way a turn can start, since starting one always
sets busy) also clears the timer. If the predicate still reads pending at fire time (composerDirtyLen
grew via a re-mint, or an early fire), the callback RE-ARMS for the remaining time instead of silently
dropping the only coverage a taskless worker has.

**Major 2 — `turnSeq===0` means "no completed turn", not "kickoff unconfirmed".** A worker deep in a
healthy, long first turn also reads `turnSeq:0`, so the shared predicate used to read every such worker
as "pending" for its own first 60s (and up to ~420s with a stale large `composerDirtyLen`).
`withinKickoffConfirmWindow` now also returns `null` when `pty.hasFirstTurnStarted(sessionId)` is true —
a no-op for `pastBrokenSpawnHoldoff`/`handleKickoffGiveUpExhausted` (both already know this is false by
the time they call it) but load-bearing for the field/warning/one-shot re-check, none of which pre-check
it. **Owner decision, matching worker_list's own doc:** the `kickoffConfirmPending` field and the
`worker_stop` warning are non-null ONLY when the kickoff's own size earned an EXTENDED window
(`kickoffConfirmWindowMs(composerDirtyLen) > 0`) — an ordinary-sized kickoff reads `null` throughout,
even inside its own flat-floor window. This is a filter layered on top of the shared predicate at those
two consumers specifically, not a change to the predicate's own floor+extra computation (which
`pastBrokenSpawnHoldoff`/the PARK notice choice still need unchanged).

**Minors:** `handleGiveUpConfirmed`'s stopped-session wording check, `pastBrokenSpawnHoldoff`'s own
verdicts, and the terminal-vs-pending notice choice are otherwise unaffected by this round. The softer
notice's own escalation claim used to be hedged here (the one-shot check was in-memory only and lost
across a daemon restart) — card `b03e636c` (see Follow-up, below) now re-arms it at boot, so the hedge
was reverted out of the notice text.

## Do not

- Do not re-add a bare "has the window passed" check without ALSO checking `hasFirstTurnStarted`/`busy`/
  `turnSeq>0` at the one-shot callback's own fire time — the explicit clear sites are necessary but not
  sufficient; a turn can start without ever running through one of them.
- Do not apply the "extended window only" filter to `withinKickoffConfirmWindow` itself, or to
  `pastBrokenSpawnHoldoff`/`handleKickoffGiveUpExhausted`'s own notice choice — it is scoped to the
  field/warning only; the flat-floor behavior those other two consumers rely on must stay unchanged.
- Do not let the one-shot callback silently drop a still-pending taskless worker when it fires early or
  the window grew — re-arm for the remaining time instead.
- Do not fold `kickoffConfirmWindowMs`/`withinKickoffConfirmWindow` into `GIVE_UP_HOLD_MS`,
  `GIVE_UP_REQUEUE_LIMIT`, or `GIVE_UP_REMINT_LIMIT` — cdbfa311 + fd4704bc already made that
  delivery-ladder timing safe; this card changes wording/surfacing only, never ladder mechanics.
- Do not give `kickoffConfirmWindowMs` its own size threshold distinct from
  `GIVE_UP_HOLD_SCALE_ABOVE_CHARS` — reusing the SAME threshold `giveUpHoldExtraMs` already uses is what
  makes an ordinary-sized kickoff's behavior byte-identical to pre-card by construction.
- Do not re-derive the size/elapsed-time read at any new call site — add it to
  `withinKickoffConfirmWindow` and consume that, or a fourth independent copy reintroduces exactly the
  contradiction-risk Minor 3 closed.
- Do not add a second, independent timer or periodic mechanism for "has the window passed yet" —
  `armKickoffConfirmRecheck` is the one escalation path; a second one is a divergent copy that can
  disagree with the first.
- Do not skip clearing the one-shot timer at any of the four sites named above (confirm/stop-family/
  recycle/exit) — a timer left armed into a dead or retired session is exactly the "fire into a retired
  session" hazard Major 1 was filed to prevent, even though the fired callback's own archivedAt
  re-check is a second, defensive layer on top.
- Do not go back to a bare "`worker_retired` event exists in history" check for the stopped-session
  wording — it would stay true forever past a later resume; use `isWorkerRetirementActive`.

## Follow-up (card `b03e636c`)

Closes the in-memory/restart residual this record's Round 2 flagged: `armKickoffConfirmRecheck`'s
one-shot timer is re-armed at boot-reconcile for a TASKLESS worker whose kickoff reached terminal PARK
just before an unrelated restart. Mechanism, in `sessions/service.ts` unless noted:

- `handleKickoffGiveUpExhausted`'s `session_message_gave_up` events (both `outcome:"reminted"` and
  `outcome:"parked"`) now carry an additive `detail.origin:"kickoff"` — the discriminator that tells
  this chain apart from an ordinary message's identically-shaped give-up event (`handleGiveUpExhausted`
  never sets it). A PRE-UPGRADE parked event has no marker and gets no re-arm — that is today's
  (pre-this-card) behavior, left as-is rather than backfilled.
- A new durable event, `kickoff_confirm_escalated` (`detail:{rootMsgId, source:"timer"|"boot"}`), is
  appended whenever the "broken" escalation actually fires — from the original timer
  (`armKickoffConfirmRecheck`'s callback, via `recordKickoffConfirmEscalated`) or the new boot path.
  Before this card, that escalation was a bare `pty.enqueueStdin` with no durable record of having
  fired at all; this is also what lets boot-reconcile skip a root that was already escalated, by this
  boot, an earlier boot, or the live timer, rather than re-sending the same notice on every subsequent
  restart.
- `resumeFleetOnBoot`'s worker branch calls the new `escalateParkedKickoffAtBoot` BEFORE composing any
  continuation nudge, for a taskless (`taskId === null`) worker whose PERSISTED `turnSeq` is still 0 with
  an unresolved, kickoff-origin parked chain. This ordering is load-bearing, not cosmetic: the
  continuation nudge below it (or even a replayed pending entry) can itself start the worker's first
  turn once the resumed pty drains, flipping `turnSeq`/`hasFirstTurnStarted` true — which would
  permanently stand down the ordinary fire-time safety check every other consumer of this escalation
  relies on, even though the ORIGINAL kickoff never landed. A worker this fires for gets the escalation
  IN PLACE OF the normal continuation nudge, never alongside it — it never received its kickoff, so
  there is nothing for it to "continue."
- The boot escalation deliberately does NOT go through `notifyManagerOfIdleWorker`/
  `pastBrokenSpawnHoldoff` — both key their holdoff off the LIVE pty's `liveStartedAt`, which a fresh
  resume just reset to "now," so calling them here would almost always read as "not past the holdoff
  yet" and silently suppress the notice. The pre-restart give-up ladder already proved the kickoff dead
  with more confidence than that live heuristic supplies. It reuses the exact terminal wording instead,
  factored out as `buildKickoffNeverConfirmedBrokenMsg` and shared with
  `handleKickoffGiveUpExhausted`'s own immediate-park branch, so the two can never read as a divergent
  second notice for the same fact.
- Tasked workers are excluded (`taskId !== null` → no re-arm): `tickIdleWorkers` (idle-watcher.ts)
  re-registers fresh every boot, independent of the lost in-memory timer, and already catches a
  never-started tasked worker on its own periodic cadence — re-arming here too would risk a genuine
  double notice with no coordination between the two mechanisms.
- **Known residual, deliberately out of scope here:** `recoverCrashOrphanedWorkers` (the OTHER,
  mutually-exclusive boot-reconcile path, taken on a genuine crash with no captured `RestartIntent`) is
  untouched. Its own candidate derivation (`deriveCrashOrphanedWorkers`,
  `orchestration/crash-orphaned-workers.ts`) structurally excludes every taskless worker
  (`!w.taskId → continue`, the same filter `tickIdleWorkers` uses) — so a taskless worker is never
  resumed live on that path at all, and there is nothing for it to re-arm. If a future card ever widens
  crash recovery to resume taskless workers too, it will need its own call to
  `escalateParkedKickoffAtBoot` at that path's own worker-resume site.
