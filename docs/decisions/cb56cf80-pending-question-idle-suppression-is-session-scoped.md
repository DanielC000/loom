# cb56cf80 — pending-question idle suppression is SESSION-scoped, not agent-lineage

## Narrative

Card cb56cf80: `hasPendingQuestionForSession` is the idle-watcher's session-level suppression predicate — a manager/Lead correctly parked on its own open owner-facing Request should not be idle-nudged, regardless of whether that Request carries a `taskId` (owner Requests are often filed with `taskId:null`, invisible to the per-card `listQuestionsForTask` discount).

CORRECTED (card 8e87f3b5, a real incident): scoping was originally by `sessions.agent_id` — the same ownership join `pullAnsweredQuestionsForAgent` uses to recover a predecessor's ANSWERED Request for a fresh successor. But a PENDING (still-unanswered) Request has no answer to recover, so joining by `agent_id` here let ONE unanswered Request permanently silence idle-nudging for the agent's entire lineage, including a fresh successor that never filed it and knows nothing about it. Scoping to `session_id = ?` fixes this: only the session that actually filed the pending Request is suppressed — or, on either recycle path (`recycleManager`/`recyclePlatformLead`), was reparented onto it via `reparentQuestions` (card bb4ff73e closed the gap where `recyclePlatformLead` didn't call it — a recycled Lead's successor is now suppressed by its predecessor's still-pending Request exactly like a recycled manager's successor).

## Do not

- Do not join this predicate by `sessions.agent_id` — a pending (unanswered) Request has no answer for a fresh successor to "inherit," so an agent-lineage join lets one stale pending Request silence idle-nudging forever, for every future session on that agent.

## Source

Inline comment in `packages/daemon/src/db.ts` (`hasPendingQuestionForSession`'s doc comment). Relocated by card 4044e834 (tranche 2 on `db.ts`); no wording changed beyond joining wrapped lines.
