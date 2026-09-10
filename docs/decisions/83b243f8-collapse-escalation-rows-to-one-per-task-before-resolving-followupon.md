# 83b243f8 — collapse escalation rows to one per task before resolving `followUpOn`

## Narrative

`listEscalationsForProject` returns one ROW per escalation EVENT, never per distinct task — a thread
with N follow-ups filed against the same task pushes that task N times into whatever candidate list
resolves `followUpOn`'s id prefix. `getByIdPrefix`'s generic ambiguity check (correctly, for its own
purpose) can't tell "N identical candidates for the same task" apart from "N genuinely distinct tasks",
so every follow-up filed on a thread made that thread's own id-prefix progressively harder to resolve —
eventually reporting a false ambiguity for what is really a single legitimate target.

Fix: build a `Map<taskId, Task>` from the event rows before resolving `followUpOn`'s id-prefix. This
collapses the row-shaped list back to one entry per task — and, as a side effect, skips the redundant
`getTask` calls a repeat id would otherwise cause — without touching `getByIdPrefix`/`resolveIdPrefix`
themselves, which stay correct for reporting genuine ambiguity across genuinely distinct task ids
elsewhere.

## Do not

- Do not resolve `followUpOn` directly against the raw per-event escalation list — collapse to one entry
  per `taskId` first, or a thread with multiple follow-ups will falsely report as ambiguous.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`platformEscalate`'s DEDUPE BY TASK ID
block, as of this tranche's HEAD).
