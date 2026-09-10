# bbc46336 — `questionId` tags a queued answer-push-nudge so a multi-answer batch purges its stale copies

## Narrative

Card bbc46336 (follow-up, decision-inbox answer push-nudge coalescing): `question_pull` consumes ALL of a
session's answered questions atomically in one call — so when the owner answers N pending questions in a
batch, the daemon enqueues N separate push-nudges (one per question), but only the FIRST of those N nudges
to actually drain is productive: it pulls every answered question at once, leaving the remaining N-1 queued
nudges with nothing left to find. Left alone, those N-1 would still drain as separate turns and each
discover an empty pull — wasted turns telling the recipient nothing new.

`questionId` is the tag that makes those stale copies findable: it OPTIONALLY marks a queued entry (set
ONLY by the answer-push route; every other `enqueueStdin` caller leaves it undefined) with the id of the
question it announces. `purgeQueuedByQuestionIds` uses this tag to find and drop a still-queued nudge for a
question that has already been consumed by an earlier pull, before it can drain as a redundant turn.

## Do not

- Do not rely on a queued answer-nudge for a question that a `question_pull` has already consumed — purge
  it via `purgeQueuedByQuestionIds` (keyed on `questionId`) rather than letting it drain and discover
  nothing.

## Source

Inline comment in `packages/daemon/src/pty/host.ts` (the `questionId` field doc on `QueuedMessage`), as of
commit `663bb1ba7398012ff4edb733f31b117712987ff4` (the coalesce/suppress-if-consumed fix). Relocated by
card `3f45b7d8` (tranche 6 on `pty/host.ts`).
