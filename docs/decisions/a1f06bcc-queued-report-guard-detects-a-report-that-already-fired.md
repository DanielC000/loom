# a1f06bcc — Queued-report guard: the task-column state is a proxy for "did the worker report", not proof

## Narrative

QUEUED-REPORT GUARD (card a1f06bcc) — the task-column check above is a PROXY for "did the worker report", blind to two real gaps: a board missing the active/review role mapping (workerReport's move is a no-op, so the task never leaves `active` even though the report fired), and a report whose manager-facing framed message is still sitting UNDELIVERED in the manager's own pending FIFO (deliveryStatus "queued", manager mid-turn). Either way the report is REAL. Detected directly off the manager's OWN pending queue — the exact `[loom:worker-report] worker <id> …` text workerReport() enqueues (prefixed with THIS worker's id, so it can only match its own report).

## Do not

- Do not trust the task-column (active/review) state alone as proof a worker did or didn't report — a board missing the active/review role mapping, or a report whose framed message is still undelivered in the manager's pending FIFO, both leave the task in `active` despite a real report having fired.
- Do not detect this any way other than off the manager's OWN pending queue, matching the exact `[loom:worker-report] worker <id> …` text prefixed with THIS worker's id — so it can only ever match its own report.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`classifyIdleWorker`): lines 12736-12743, as of commit `a07c5092c871d47f25aeb2ec160958306294a043`. Relocated by card `3f40210c`; no wording changed, wrapped source lines joined into a flowing paragraph, the leading list-bullet marker and `*` comment markers stripped.
