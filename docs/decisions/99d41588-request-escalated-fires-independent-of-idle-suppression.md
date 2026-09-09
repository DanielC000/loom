# 99d41588 — `request_escalated` fires on request age, independent of any session's idle/suppression state

## Narrative

Card 99d41588: fires when a PENDING `question_ask` Request (any type) has sat unanswered past `orchestration.staleRequestMinutes` — the request-AGE twin of `idle_escalated`/`context_escalated`, but keyed on `questions.created_at` (the request's own clock) rather than any session's idle/suppression state.

Deliberately independent of cards `cb56cf80`/`8e87f3b5`'s own-Request idle-nudge suppression: a manager can be correctly suppressed (blocked ONLY on this Request, nothing else actionable) and STILL never see an `idle_escalated` (its unanswered-nudge counter never increments because it's never nudged) — `request_escalated` is what gives that case a path to alert a human at all. Also fires for a Request whose asking session is busy/live doing unrelated work (idle-state-independent by design), e.g. an input-type Request that only the owner can act on.

Emitted EXACTLY ONCE per request — `idle-watcher.ts`'s `tickStaleRequests` stamps `questions.escalated_at` in the same write that appends this event, and only ever scans `escalated_at IS NULL` rows, so a later tick can never re-fire for the same request. An answered/consumed/cancelled Request simply drops out of the stale-scan's `state = 'pending'` filter — no separate clear event exists (mirrors `context_escalated`'s "no `context_report` to clear it" shape).

## Do not

- Do not assume a suppressed manager (blocked only on a pending Request) will eventually get an `idle_escalated` — its unanswered-nudge counter never increments because it's never nudged; `request_escalated` is the only path to alert a human in that case.
- Do not expect a "cleared" event when a Request is answered — none exists; a reader must re-check `state = 'pending'` rather than wait for a clearing event.

## Source

Inline comment in `packages/shared/src/types.ts` (`OrchestrationEventKind`'s `request_escalated` case doc). Relocated by card 35d90c4e (tranche 1 on `packages/shared/src/types.ts`); no wording changed, wrapped source lines joined into a flowing paragraph and the `//` comment markers stripped.
