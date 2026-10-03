# 39b0e9b7 — one shared helper builds the kickoff's give-up ids + hook for both scheduleKickoffGuarantee branches

## Defect

`scheduleKickoffGuarantee` (`pty/host.ts`) delivers a fresh session's turn-1 kickoff one of two ways:
a direct `submit()` when it's safe to write right now, or a deferred `enqueueStdin(...)` push (kind:
"agent") when it isn't (`submitOutstanding`/`stopping`/`drainHeld`/`rateLimited`/a boot dialog/an
in-flight mode cycle). Only the direct branch minted `kickoffMsgId`/`kickoffLogicalId` and wired
`onGiveUpExhausted` (card a8f8a8f2/7772176d's re-mint-then-park-and-notify hook) into the synthetic
`QueuedMessage` origin it hands to `submit()`. The deferred branch's bare `enqueueStdin(kickoff, …)`
call carried none of that — so a queued kickoff that then gave up twice (GIVE_UP_REQUEUE_LIMIT=1,
exceeded on the second unconfirmed attempt) took `requeueGiveUpOrigin`'s residual bare-drop path
(console.error only), silently losing the whole task dispatch with nothing durable or visible
surfacing it except the generic idle watchdog eventually noticing the idle, never-started session.

## Fix

`buildKickoffGiveUpOptions(sessionId, kickoff)` mints the msgId/logicalId pair and the
`onGiveUpExhausted` closure ONCE, before either branch runs. The direct branch uses
`kickoffMsgId`/`kickoffLogicalId` as the synthetic origin entry's `id`/`logicalId`; the deferred
branch passes `{ onGiveUpExhausted, logicalId: kickoffLogicalId }` as `enqueueStdin`'s tail —
`enqueueStdin`'s own held-entry construction already splices `onGiveUpExhausted`/`logicalId` onto the
`QueuedMessage` it pushes (see its own doc, card ccb407eb/3f09f9ce), so this reuses existing, already-
correct generic machinery rather than adding a second give-up path. `enqueueStdin` mints its own
internal `id` for the held entry (its tail has no custom-id field) — only `logicalId` is shared/
carried between the two branches, which is what `requeueGiveUpOrigin`'s content-match/re-mint
machinery actually keys on.

## Do not

- Do not let either `scheduleKickoffGuarantee` branch build its own `onGiveUpExhausted`/id pair
  independently of `buildKickoffGiveUpOptions` — that's exactly how the deferred branch silently fell
  behind the direct one before this card; one helper, two call sites, same wiring forever.
- Do not expect the deferred branch's `enqueueStdin`-minted `QueuedMessage.id` to equal
  `kickoffMsgId` — `EnqueueStdinTail` has no custom-id field, so only `logicalId` (the stable root
  identity `requeueGiveUpOrigin`/content-match dedup actually uses) is shared between the two
  branches; `kickoffMsgId` is reported to `onKickoffGiveUpExhausted` purely for logging/identification,
  not as the literal queued entry's id.
