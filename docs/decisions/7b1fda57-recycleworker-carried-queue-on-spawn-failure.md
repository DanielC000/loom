# 7b1fda57 — on a pre-spawn recycleWorker failure, hand the carried non-durable queue to the manager as ONE framed, blockquoted notice

## Narrative

Code Reviewer finding on card `4be56c33`/`08320d02`'s branch: `recycleWorker` flushes the old worker's
in-memory queue (`flushPending`) BEFORE its successor's spawn, and only re-enqueues it (via
`carryPendingToSuccessor`) AFTER that spawn succeeds. On a pre-spawn throw, the flushed array was
abandoned in the catch: every NON-durable entry (no `onDeliver`) — a raw human turn, a watchdog nudge —
was silently lost. The DURABLE half was already safe (retired by the boot-scan redrive once the worker is
archived) but not DELIVERED — see the ruling below.

## Rejected alternatives

1. **Re-enqueue onto the dead predecessor** — its pty is already hard-stopped by the time the catch
   fires; nothing would ever drain a re-enqueue, and `hasSuccessor(old)` is unlinked in this same catch.
2. **Flush after the spawn succeeds** — impossible without breaking worktree-exclusivity: the flush needs
   the old pty alive, but the old pty must be fully dead before the fresh one spawns into the same
   worktree. No ordering satisfies both.
3. **Persist non-durable entries durably, addressed to `old`** (mirroring the durable half) — `old` never
   resumes, so only a future daemon BOOT (`recoverUndeliveredMessagesOnBoot`, the sole global scan) would
   ever look at it, and that scan only RETIRES it, never delivers it.
4. **Re-enqueue raw text onto the manager's own turn** (the first implementation, before Code Review) —
   these entries were addressed TO THE WORKER; raw re-delivery reads as the manager's own instruction
   (role confusion), and a worker-bound watchdog nudge reads as addressed to the manager.

## The actual fix

Filter `carried` to non-durable entries, split by `kind`: `"agent"` (human/authored content) is FORWARDED,
quoted in ONE notice; `"warning"` (Loom's own worker-targeted nudges — e.g. worktree-vanished /
crash-recovery continuation, NOT idle/context watchdogs, which target managers) is moot and COUNTED, never
quoted. Delivered via `enqueueDurableNudge` — the same mechanism every other `[loom:*]`-to-manager notice
uses (boot-resume, crash-recovery, wake/poll/event-trigger). Called, not changed — no caller-grep owed.

**Quoting (CR finding 2):** every quoted line is blockquote-prefixed (`"> "`) so worker-authored text can
never spoof a `[loom:*]` tag or the notice's own label/closing lines; closes with a literal unprefixed
`--- end of quoted worker messages ---`. Verified against an adversarial entry carrying a fake
`[loom:from-manager]` tag and fake separator lines — both survive only blockquoted.

**Three disjoint per-entry outcomes (finding 3):** FULLY forwarded (`carriedForwarded`), CONTENT-CUT
(shown but truncated once the 4000-char bound — mirrors `gate_status`'s bounded tail convention — is hit,
`carriedContentCut`), or fully OMITTED (`carriedTruncated`) — no room for the label, OR a cut would leave
ZERO quoted chars once the truncation marker's REAL, measured length is reserved. Zero-content counts as
omitted, never a hollow "forwarded". Join separators between blocks count toward the bound.

**Wording (finding 4):** "authored by a person or agent", not "addressed to a person"; the dropped-warning
example now names the real worker-targeted population (worktree-vanished / crash-recovery continuation).

**Durable half (finding 5):** "already safe" means safe from deletion, NOT delivered. Its count
(`carriedDurableUndelivered`) is now stated in both the notice and `recycle_failed.detail`.

`recycle_failed.detail` carries `carriedForwarded`/`carriedDropped`/`carriedContentCut`/`carriedTruncated`/
`carriedDurableUndelivered` — counts only, never content.

## Durable-content ruling (finding 1) — corrects this record's prior wording

This record previously said "a durable-event-row content question is separately decided; this card does
not widen it." True only of `recycle_failed.detail`. FALSE of the notice: `enqueueDurableNudge` persists a
`session_message_queued` row whose `detail.text` is the notice's FULL text, including quoted `"agent"`
content — chiefly a worker-bound human composer turn never durably written before this fix. Findable via
`events_search`.

**Ruling: ACCEPTED, not gated.** Card `a419a7e6` gates a DIAGNOSTIC excerpt
(`handlePromptMismatchUnresolved`'s `messageExcerpt`) behind `isLogMessageContentEnabled` — a debugging
breadcrumb. This notice is a DELIVERY PAYLOAD instead: the durable message queue has always persisted
payload text (that's what makes manager→worker direction and worker→manager reports crash-survivable —
`enqueueDurableMessage`'s own mechanics). Gating a payload behind the diagnostic flag would strip the
content the manager needs. Card `16c93a50` separately scopes the content-in-logs redaction policy to the
ROTATED daemon log, not a durable row — a different population. NEW population added to durable storage:
a worker's non-durable `"agent"` entries (chiefly human composer turns) whose recycle failed pre-spawn.

## Do not

- Do not re-enqueue a carried entry's raw text as the manager's own turn — role confusion.
- Do not forward a `kind:"warning"` entry verbatim — count it, don't quote it.
- Do not leave a quoted line unprefixed — worker-authored text must never spoof a `[loom:*]` tag or this
  notice's own separator/closing lines.
- Do not count a content-cut or zero-content entry as `carriedForwarded`.
- Do not put message content into `recycle_failed.detail` — counts only.
- Do not gate this notice's durable content behind `isLogMessageContentEnabled` — it's a payload, not a
  diagnostic excerpt.

## Source

`packages/daemon/src/sessions/service.ts`, `recycleWorker`'s catch block, anchored `@decision 7b1fda57`.
