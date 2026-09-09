# 8e0bd254 — `parked-gate`: check the daemon-owned `run_gate` op, never a worker self-report

## Narrative

`parked-gate` — card 8e0bd254, the STRUCTURAL replacement for a worker having to self-report `awaiting:"background"` while parked on its OWN `run_gate` call: a pending `run_gate` is a DAEMON-OWNED op, directly observable via `PendingOpRegistry.peek(\`gate:${workerSessionId}\`)` — no self-report needed at all, so this is checked BEFORE the report-derived branches below and fires even for a worker that went idle with NO `worker_report` in between (the exact self-report-reliance gap that produced ~4-5 false `[loom:worker-idle]` "awaiting your reply" nudges per gate-running worker per the origin finding — prior patches ab21da21/1c95a89b/cf94e19 only fixed the self-report wording, not this). More trustworthy than a wake or a self-attributed `awaiting` flag: the daemon itself started and is tracking this exact op, not merely a claim about it. Fresh (op still running, started under `BACKGROUND_PARK_STALE_MINUTES` ago) → no reply owed, no manager turn. `peek()` never consumes, so repeated ticks see the SAME running entry until it genuinely settles (evicted the instant it does — see PendingOpRegistry's class doc), at which point this branch simply stops matching and classification falls through to whatever the worker's own report (if any) says.

## Do not

- Do not rely on a worker's self-reported `awaiting` flag for a parked `run_gate` call (card 8e0bd254) — check `PendingOpRegistry.peek` for the daemon-owned op directly, BEFORE the report-derived branches, since the daemon itself is tracking it rather than merely being told about it.
- Do not repeat the self-report-reliance gap prior patches (`ab21da21`/`1c95a89b`/`cf94e19`) only papered over by fixing the self-report wording — that gap produced ~4-5 false `[loom:worker-idle]` "awaiting your reply" nudges per gate-running worker.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`classifyIdleWorker`): lines 12801-12813, as of commit `a07c5092c871d47f25aeb2ec160958306294a043`. Relocated by card `3f40210c`; no wording changed, wrapped source lines joined into a flowing paragraph, the leading list-bullet marker and `*` comment markers stripped.
