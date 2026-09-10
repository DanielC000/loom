# 4d9f7471 — A recycle carry must not drop `questionId`/`kind`/`rootMsgId`/`chainDepth`

## Narrative

`carryPendingToSuccessor` (`packages/daemon/src/sessions/service.ts`) re-enqueues a session's
still-pending work onto a recycle successor, across two paths: the non-durable carry loop
(nudges/raw turns) and the durable-record re-mint loop (durable `QueuedMessage`/`OrchestrationEvent`
records). Card 4d9f7471 fixed two omissions in these paths, both the same shape: a field silently
dropped rather than carried forward.

Non-durable path: the loop carried `m.text`/`m.source`/`m.kind`/`m.senderId` but omitted
`m.questionId` — the ONLY carry site that did (the companion-upgrade re-pin/resume carries elsewhere
in this file already threaded `msg.questionId` through). A still-queued answered-question nudge that
survived to a recycle lost its tag here, so
`purgeAnsweredQuestionNudges`/`purgeQueuedByQuestionIds` could never match it on the successor.

Durable path: the re-mint loop carried `text`/`sender`/`taskId`/`reportEventId` out of `rec.detail`
but omitted `kind`/`rootMsgId`/`chainDepth` — the SAME fields the `session_message_gave_up` link event
a few lines below already reads off this exact `rec.detail` for its own audit trail (proof this was an
oversight, not a design choice: the read-back expressions already existed two lines away and simply
weren't reused here). Without carrying them, `enqueueDurableMessage` defaults every re-mint to
`kind:"agent"`/self-rooted/depth-0 — a still-unresolved `kind:"warning"` record (settle/watchdog/
give-up nudges — plenty live at any time) silently flips to one-per-turn "agent" delivery on the
successor, and the give-up chain's lineage is severed.

## Do not

- Do not add a new field to a `QueuedMessage`/durable-record carry path without checking whether
  `carryPendingToSuccessor` also needs to thread it through — this card's whole shape is fields that
  already existed elsewhere in the same struct and were simply never reused at this specific carry
  site.

## Source

Inline comments in `packages/daemon/src/sessions/service.ts` (`carryPendingToSuccessor`, both the
non-durable carry loop and the durable-record re-mint loop), as of main
`b89cafa49ad4490fc9081790fbcf8961b82a6457`.
