# ea648f89 — Dedupe resume-time memory/notes reinjection by a digest persisted on the session row

## Narrative

Companion memory RECALL (resume half, companion/memory-recall.ts) — a DELIBERATE, DOCUMENTED exception to "resume injects no prompt" above: an assistant session's own durable memory (memory_write) would otherwise stay mute on every resume forever, since a long-lived companion may not see a fresh spawn again for months. Enqueued via the ordinary enqueueStdin turn-injection primitive — ready-gated in host.ts, so it becomes the companion's FIRST turn once the resumed engine is ready, ahead of anything queued below (the redelivered messages) or by a caller after resume() returns (e.g. a wake's own note). Empty memory ⇒ buildFramedMemoryRecall returns null ⇒ no enqueue — a companion with no memory, and every non-assistant resume (this whole block is role-gated), stay byte-identical to today. The frame itself tells the model to stay SILENT (never chat_reply just because this turn arrived) — see memory-recall.ts.

Dedup gate (card ea648f89, hardened by finding 0e08c0b7 — see the shared doc comment on stampProjectMemoryDigest/stampCompanionMemoryDigest above): resume() re-retrieves on EVERY resume (idle-nudge resumes, wakes, crash/restart recovery all call it) with no change-detection otherwise — this call site used to re-inject the IDENTICAL framed block verbatim every time (observed live as 25+ consecutive identical injections into one companion). Hash the framed block and compare against the digest PERSISTED on the session row (survives a daemon restart, unlike an in-memory cache); the compare runs BEFORE enqueueStdin, so an unchanged digest never mints a standalone turn.

Project memory (card 2fd9abf9, resume half) — a DELIBERATE, DOCUMENTED exception to "resume injects no prompt", exactly like the companion recall above but generalized to EVERY role (not assistant-only): a long-lived worker/manager resumed after a restart would otherwise never see project notes written since its last fresh spawn. Enqueued via the SAME ordinary enqueueStdin turn-injection primitive — kind defaults to "warning" (operational/coalescible, never direction). Search text is the resumed session's own task (title+body) when it has one bound (the richest match source), else the agent's own startup prompt; both empty ⇒ pinned-only. null (no project memory notes match) ⇒ no enqueue, byte-identical to today.

Dedup gate (card ea648f89, hardened by finding 0e08c0b7): same shape as the companion-recall gate above — hash the framed block and compare against the digest persisted on the session row (see stampProjectMemoryDigest's doc comment for why this moved off an in-memory Map); skip the enqueue when unchanged. This still preserves the "sees notes written since last spawn" intent — a genuinely new/edited note changes the digest and is injected — it just stops re-blasting identical content, including across a daemon restart.

## Do not

- Do not re-enqueue the companion-memory-recall or project-memory block unconditionally on every resume — hash it and compare against the digest persisted on the session row; skip when unchanged.
- Do not move this dedup state to an in-memory cache — it must survive a daemon restart, so it lives on the session row.

## Source

Two inline comments in `packages/daemon/src/sessions/service.ts` (`resume()`): lines 3996-4013 and 4022-4036, both as of commit `9818aa2627c6f58c26aaaec6fc33d70c468c3943`. Relocated by card `3c50eae9`; no wording changed. Both sites anchor to this one record — same mechanism, two call sites.
