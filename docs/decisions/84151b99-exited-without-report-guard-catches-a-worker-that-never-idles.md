# 84151b99 — the exited-without-report guard catches a worker that exits before ever going idle

## Narrative

Board card 84151b99: a worker's ONLY channel up is `worker_report`'s push, and the idle-worker nudge
(`notifyManagerOfIdleWorker`) fires on a `busy(true→false)` EDGE — but a fast/first worker can EXIT
BEFORE that edge ever lands: a pty exit routes through the `onExit` hook, NOT the `onBusy` callback, so
`notifyManagerOfIdleWorker` is never called on exit. The manager — which has no other idle/exit signal
for its children — would then see a silent idle (or nothing at all) and have to self-rescue via
`worker_transcript` (real incident: a manager session had to do exactly this across several of its own
turns). This is a recurrence of the strand family but a DISTINCT mechanism from
`worker_report_undelivered` (where a report fired but reached an exited manager): here, no report fires
AT ALL.

FIX: `notifyManagerOfExitedWorker`, called from the pty `onExit` hook (`index.ts`), AFTER the row is
marked `exited`. If an UNEXPECTEDLY-exited worker (`intended===false` — NOT a manager-issued
`worker_stop`/recycle/merge stop, which sets the pty's `stopping` flag) left its task STILL
`in_progress` (`worker_report` would have moved it to review/waiting), it records a DISTINCT, DURABLE
`worker_exited_without_report` event AND pushes a `[loom:worker-exited]` nudge to the manager — the
worker is GONE and will never report, so the manager must review its branch or re-dispatch. No-op for:
a non-worker, a parentless/taskless session, an intended stop, a recycled/superseded worker (its
successor took over the task), or a worker that already reported (its task moved out of the active
lane).

## Do not

- Do not rely on `notifyManagerOfIdleWorker`'s busy-edge nudge to cover an exit — a fast/first worker
  can exit before that edge ever fires, leaving the manager with no signal at all unless this separate,
  onExit-driven guard also runs.
- Do not skip the durable event even when the manager isn't live to receive the nudge — record it
  first, so it's auditable and not lost if the manager is mid-turn or momentarily down.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`notifyManagerOfExitedWorker`'s JSDoc,
the lead paragraph through "reached an exited manager)"): lines 9827-9844, as of main `a4fdccf6`
(introducing commit `e8940fddb2b4f2ff421b55ec2c3a237ffec4388f`, `fix(sessions): guarantee terminal
worker-report on fast worker exit`). Extraction tranche 36.

## Also cited, not extracted this tranche

The same card id is cited, briefly and without further narrative, at three other sites this record
does not cover: `packages/daemon/src/index.ts` (~line 541, the `onExit` hook call site), the shared
`Session` event-kind doc in `packages/shared/src/types.ts` (~line 1081), and
`packages/daemon/test/worker-exited-without-report.mjs` — all describing the same guard, not a distinct
decision. All three fall outside this tranche's file fence (`sessions/service.ts` only).
