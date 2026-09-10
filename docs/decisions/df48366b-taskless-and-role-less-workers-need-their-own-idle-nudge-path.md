# df48366b — a taskless or role-less worker needs its OWN idle-nudge path; `classifyIdleWorker` can't reconcile either

## Narrative

`notifyManagerOfIdleWorker` is the only channel a worker's manager ever gets for "this worker is idle" —
a worker only reaches its manager via `worker_report`'s push, so a worker that ends its turn WITHOUT
reporting goes idle silently and the manager, which has no other idle/exit signal for its children, waits
forever. Card `df48366b` fixed two DISTINCT gaps in that channel, both of the same shape: a worker that
falls outside `classifyIdleWorker`'s task-lane reconciliation got NO nudge at all, not even a degraded one.

TASKLESS (CR-flagged asymmetry on card `2514e6e1`'s taskless `worker_spawn` — see
`docs/decisions/2514e6e1-worker-spawn-taskless-opt-in-not-a-hijacked-card.md` for that card's own origin
fix): a taskless worker (an ad-hoc spike, or a read-only Code Reviewer with no vehicle card) has no board
card for `classifyIdleWorker`'s column-based reconciliation (`parked-ack`/queued-report need a task's
active/review lane) — that classifier stays entry-gated on `taskId` and out of scope for a taskless
worker entirely. But two things need NO board state at all and are exactly as safety-critical for a
taskless worker as a tasked one: (1) "did the engine ever start a turn at all" (`broken-spawn`) and (2)
"did it finish a turn and go idle without EVER calling `worker_report`" (silent-finish). Before this fix,
a taskless worker that engaged, ran, and went idle got NEITHER signal — the taskless branch returned
unconditionally once past the broken-spawn check, leaving it just as silently stranded as the role-less
case below. Both checks are handled DIRECTLY inside `notifyManagerOfIdleWorker`'s own taskless branch,
BEFORE ever delegating to `classifyIdleWorker` — with the SAME pending-direction race guard that
classifier applies (card `6101d7f7`) and the `busy-worker-watcher.ts` `w.taskId ? ... : ""`
taskId-optional message shape.

Reconciliation beyond "ever reported at all" (`parked-ack` wording, re-ack tracking) is DELIBERATELY NOT
extended to a taskless worker — once nudged, the manager that spawned it is expected to actively await it
and `worker_stop` it directly rather than get the same parked/re-ack detail a tasked worker's classifier
provides.

ROLE-LESS CHILDREN: a session with `role: null` parented to a manager (e.g. a role-less consultation
worker) is exactly as much that manager's responsibility as a `role: 'worker'` child — but the entry gate
used to hard-require `role === "worker"`, so a role-less child got NO nudge whatsoever, tasked or not (the
ONLY signal that could ever reach its manager on a silent finish). Widened to accept `role === "worker"
|| role === null`, everywhere this entry gate is checked (`notifyManagerOfIdleWorker`,
`classifyIdleWorker`, and `purgeStaleIdleNudgeForReengagedWorker`'s matching re-engage purge) — only an
unrelated role (manager/platform/etc., which never has this manager as its parent in practice) stays
excluded.

## Do not

- Do not let a taskless worker (no board card) fall through with zero idle/broken-spawn signal just
  because `classifyIdleWorker`'s column-based reconciliation doesn't apply to it — the broken-spawn and
  silent-finish checks need no board state and must still run.
- Do not hard-require `role === "worker"` on any of this channel's entry gates — a role-less child
  (`role: null`) parented to a manager is exactly as much that manager's responsibility, and excluding it
  silences its ONLY idle signal.
- Do not extend `parked-ack`-style reconciliation (re-ack tracking, wording keyed to a reply owed) to a
  taskless worker — that's deliberately out of scope; the spawning manager is expected to actively await
  and `worker_stop` it directly once nudged, not get the same parked detail a tasked worker gets.

## Source

Inline comment in `packages/daemon/src/sessions/service.ts` (`notifyManagerOfIdleWorker`'s top-of-function
JSDoc, the "TASKLESS" and "ROLE-LESS CHILDREN" paragraphs): lines 9714-9732, as of main `c51b7bc2`
(introducing commit `b15783096ae642d09ed78cae0177d6a35e5cf0bc`, `fix(orchestration): a finished
role-less/taskless consultation worker shows stale busy:true and never emits [loom:worker-idle]`).
Extraction tranche 35.

## Also cited (not extracted this tranche)

The same card id is cited, briefly and without further narrative, at two other sites this record does not
cover: `classifyIdleWorker`'s own role-less entry gate (`packages/daemon/src/sessions/service.ts` ~line
9574) and `purgeStaleIdleNudgeForReengagedWorker`'s matching re-engage purge (~line 9861) — both are the
same widened `role === "worker" || role === null` gate described above, not a distinct decision.
