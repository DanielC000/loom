# b9d479b0 — Single-source idle-worker classification, never two independently-drifting copies

## Narrative

SINGLE-SOURCED idle-worker classification (CR fold-in on board card b9d479b0/99efaab3): both notifyManagerOfIdleWorker (the busy→false edge nudge) AND IdleWatcher's periodic caller + manager-loop message (via isWorkerGenuinelyStranded below) key off this ONE reconciliation — a second, drifted copy is exactly how 99efaab3's false-alarm class reappears (a rate-limited worker re-nagged for the length of its cap; a message asserting "unreported" for a worker that's actually done-awaiting-merge or parked awaiting an ack).

## Do not

- Do not give `notifyManagerOfIdleWorker`'s busy→false edge nudge and `IdleWatcher`'s periodic/manager-loop check (`isWorkerGenuinelyStranded`) independently-maintained copies of idle-worker classification — both must key off the ONE `classifyIdleWorker` reconciliation, or the false-alarm class card `99efaab3` fixed (a rate-limited worker re-nagged for its whole cap window; a worker already done-awaiting-merge or parked-awaiting-ack reported as "unreported") reappears.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`classifyIdleWorker`): lines 12718-12723, as of commit `a07c5092c871d47f25aeb2ec160958306294a043`. Relocated by card `3f40210c`; no wording changed, wrapped source lines joined into a flowing paragraph and the `*` comment markers stripped.
