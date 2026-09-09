# dfa87343 — Wake guard: a worker self-parked on a pending `wake_me` is not a strand

## Narrative

WAKE GUARD (card dfa87343) — a worker that self-parked via `wake_me` (its task stays in the `active` lane, no fresh `worker_report`) looks identical to a genuine strand. `listWakesForSession` only ever returns wakes that are PENDING — a fired or cancelled wake is deleted (claim-first tick, `wake_cancel`) — so any row present means a not-yet-fired wake will resume this worker on its own; it never failed to report, it's deliberately waiting. Narrow by construction: a worker with no pending wake falls straight through to the stranded check below.

## Do not

- Do not classify a self-parked worker (a pending `wake_me` with no fresh `worker_report`) as stranded — `listWakesForSession` only ever returns PENDING wakes (a fired or cancelled one is deleted), so any row present proves it will resume itself; only a worker with no pending wake falls through to the stranded check.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`classifyIdleWorker`): lines 12744-12749, as of commit `a07c5092c871d47f25aeb2ec160958306294a043`. Relocated by card `3f40210c`; no wording changed, wrapped source lines joined into a flowing paragraph, the leading list-bullet marker and `*` comment markers stripped.
