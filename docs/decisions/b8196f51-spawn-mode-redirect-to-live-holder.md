# b8196f51 — a refused SPAWN-mode delivery redirects to the live holder instead of dropping/stalling

## Narrative

`0368c784`/`af165ec7` made `startNew`/`startManager` throw `SecondLiveManagerError` (naming
`holderSessionId`) whenever a spawn would mint a second live-or-starting manager for the same agent.
`af165ec7` closed the WAKE-mode doors (`resolveWakeDeliveryTarget` redirects a stale `resume()` target to
the live holder instead of resuming — and now being refused for — it). It deliberately left the three
wake/spawn `fire()` sites' SPAWN-mode branch unaddressed: each just calls `startNew(agentId, …)` directly,
with no redirect counterpart, so a spawn-mode automation aimed at an agent that already has a live manager
now throws instead of minting a duplicate.

Verified per-caller consequence BEFORE this card, each caused by a different pre-existing mechanism:

- **Webhook** (`webhooks/ingress.ts`'s `fireWebhookTarget`): `startNew` throws → `fireWebhookTarget`
  rejects → the route's `fireWebhookTarget(...).catch()` logs the error and `deleteWebhookDelivery`s the
  dedupe row it had just recorded (card `72c58b1c`'s own "undo on provable no-effect" rule) — the payload
  is silently DROPPED (the HTTP response was already a 200, sent before the fire).
- **Poll** (`orchestration/poll.ts`'s `tick()`): `fire()` throws → caught by `tick()`'s per-job try/catch
  → `markPollFailed` applies the capped-backoff path, and — because delivery is attempted BEFORE the
  cursor commit (`tick()`'s own "deliver before committing the cursor" ordering) — the cursor never
  advances past the fresh item(s). The SAME fresh item(s) are re-detected and re-attempted every
  subsequent due tick, forever, until the target manager is stopped/recycled: a STALL, not a loss.
- **Event trigger** (`orchestration/event-triggers.ts`'s `tick()`): `fire()` throws → caught by `tick()`'s
  per-trigger try/catch, logged. Unlike poll, the watermark (`advanceEventTriggerSeq`) and `lastFiredAt`
  are stamped BEFORE `fire()` is even called (`tick()`'s own "ADVANCE-BEFORE-FIRE" anti-loop ordering) —
  so the matched event(s) are already consumed and can never be re-scanned. The event is DROPPED, same
  user-visible outcome as webhook, via a different mechanism (advance-before-fire vs. a dedupe-row undo).

## The fix

Each of the three spawn-mode branches now wraps its `startNew`/`spawn()` call in a try/catch. A caught
`SecondLiveManagerError` is NOT rethrown — instead the event/item/payload is delivered to
`e.holderSessionId` as a MESSAGE, through the exact same path each caller's own wake-mode branch already
uses to message an existing live session:

- Webhook: `deps.sessions.enqueueDurableNudge(holderSessionId, role, kickoff, null, { kind: "agent",
  onOutcome })` — the SAME MCP-seen-gated call and `dispatched`-based success/failure contract the
  wake-mode branch above it uses (card `a21f5c9e`). `dispatched:false` rethrows (so the dedupe-row undo
  still fires for a genuine total loss); `dispatched:true` returns normally, so the delivery counts as a
  SUCCESSFUL fire — the dedupe row is kept, exactly as if `startNew` had succeeded.
- Poll: `enqueueDurableNudge` when wired (prod), else the required `enqueueDurable` fallback — mirroring
  the wake-mode branch's own `if (enqueueDurableNudge) {…} else {…}` shape. Returning normally from
  `fire()` lets `tick()` proceed to its normal post-delivery cursor commit, so the cursor ADVANCES.
- Event trigger: `enqueueDurableNudge` when wired, else the raw `pty.enqueueStdin(..., "agent")` fallback
  — mirroring that caller's own wake-mode branch. Returning normally lets `tick()` file its ordinary
  `event_trigger_fired` event (mode:"spawn") under the holder's id — the watermark had already advanced
  (unaffected either way), but the event is now genuinely DELIVERED instead of silently dropped.

Any OTHER thrown error (a real spawn failure, unrelated to a live-holder refusal) is rethrown unchanged —
each caller's existing drop/stall/backoff behavior for a genuine failure is untouched.

A new audit-only `spawn_target_redirected` event (`detail: { source: "event-trigger" | "webhook" |
"poll", agentId }`) is filed under the holder's session id on every redirect — mirrors
`wake_target_redirected`'s own "file under the row that matters now" posture, and is likewise deliberately
excluded from `EVENT_TRIGGER_EVENT_KINDS`/`GATE_HISTORY_KINDS`/`ORCH_ACTIVITY_KINDS`/
`REPORT_RESOLVED_EVENT_KINDS`: the delivery itself already files its own ordinary
`event_trigger_fired`/`poll_fired`/wake-nudge activity record at the (redirected) holder id, so no
orchestration decision or activity tally needs a second one.

## Why a message, not a resume/second spawn

The holder named by `SecondLiveManagerError` is, by construction, ALREADY live or starting for this exact
agent — there is nothing to resume and nothing to spawn. Delivering the event as a message is the only
action that doesn't either duplicate the manager (the bug `0368c784` exists to prevent) or lose the event.

## Do not

- Do not rethrow `SecondLiveManagerError` unconditionally in any of the three spawn branches — that
  reopens exactly the drop (webhook/event-trigger) or stall (poll) this card closes.
- Do not treat a caught `SecondLiveManagerError` as license to skip the caller's own existing
  success/failure contract — webhook's `onOutcome.dispatched:false` must still rethrow so the dedupe-row
  undo fires for a genuine total loss; poll/event-trigger's `enqueueDurableNudge`/fallback calls are
  fire-and-forget on the daemon side (same as their own wake-mode branches), not a second place to invent
  a new failure path.
- Do not invent a second redirect primitive — reuse each caller's OWN wake-mode `enqueueDurableNudge`/
  fallback call verbatim; there is exactly one way each caller already knows how to message a live session.
- Do not add `spawn_target_redirected` to `EVENT_TRIGGER_EVENT_KINDS`/`GATE_HISTORY_KINDS`/
  `ORCH_ACTIVITY_KINDS`/`REPORT_RESOLVED_EVENT_KINDS` — same reasoning as `wake_target_redirected`'s own
  exclusion: the delivery's own ordinary activity event already covers it.
- Do not confuse this card's redirect with `af165ec7`'s wake-mode redirect — they share the same
  `SecondLiveManagerError`/`holderSessionId` shape and the same "file under the holder" posture, but
  `af165ec7` redirects a `resume()` call before it happens; this card redirects AFTER a `startNew` call has
  already thrown. Never merge the two into one helper — one caller never resumes, the other never spawns.

## Source

`packages/daemon/src/webhooks/ingress.ts` (`fireWebhookTarget`'s spawn-mode branch),
`packages/daemon/src/orchestration/poll.ts` (`PollService.fire`'s spawn-mode branch),
`packages/daemon/src/orchestration/event-triggers.ts` (`EventTriggerService.fire`'s spawn-mode branch).
`packages/shared/src/types.ts` (`spawn_target_redirected`). Tests: `packages/daemon/test/spawn-redirect.mjs`.
See also `docs/decisions/0368c784-second-live-manager-refusal.md`,
`docs/decisions/af165ec7-resume-fork-second-live-manager.md`.
