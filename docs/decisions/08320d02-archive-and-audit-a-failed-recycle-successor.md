# 08320d02 — archive + audit a failed recycle successor; cancel only the hard-killed worker's own wakes

## Narrative

Code Review pass 1 + pass 2 on card `4be56c33` (unlinked a failed recycle successor's `recycled_from` so
`hasSuccessor(predecessor)` stops lying `true` forever) found two follow-on gaps in the same three
pre-spawn-failure catches (`recycleWorker`/`recycleManager`/`recyclePlatformLead`): the failed `fresh`
row was never archived, and no event recorded the attempt.

**1. Archive.** `reconcileFailedSpawn` leaves `fresh` `exited` but never archived (no pty, so
`onExit → archiveOnExit` never runs). `listAllSessions`/`db.listWorkers` filter `archived_at IS NULL`, so
an un-archived failed successor lingered as a phantom exited row on the rail/global grid, every role, not
just `worker`. Fixed: `this.db.archiveSession(fresh.id)` in all three catches, after the existing unlink.
A retried recycle now mints a fresh successor sharing the SAME `gen` as the archived orphan — accepted,
not fixed: `gen` is a display hint, never a unique key, and the archived+unlinked row is unreachable from
any lineage walk or rail listing.

**Scope of what "archived" hides:** only the LIVE rail (`db.listWorkers`/`listAllSessions`). MCP
`worker_list`'s own dangling-worker pool (`getDanglingWorkers`) still surfaces it as
`processState:"dangling"` — it keeps its `taskId`+`branch`, and its worktree stays on disk (reused from
the predecessor). Left as-is: a separate card covers de-duplicating this "failed-recycle phantom" shape
from a genuinely-abandoned one.

**2. Audit event.** A `recycle_begin` with no matching `recycle_complete` is ambiguous ("still running" vs
"failed"). New `recycle_failed` kind (`detail: {recycledFrom, failedSuccessorId, cancelledWakes?,
error}`, `cancelledWakes` worker-only), appended in each catch. **Filed under whichever identity survives
the failure and stays queryable — NOT always `recycle_complete`'s own convention:** `recycleWorker` —
`managerSessionId` (real, still-live) + `workerSessionId: fresh.id`, mirroring `recycle_complete` (the
manager is discoverable via `taskId`/`parentSessionId` regardless). `recycleManager`/
`recyclePlatformLead` — `managerSessionId: oldManagerId`/`oldLeadId` (the PREDECESSOR), the OPPOSITE of
`recycle_complete` (files under `fresh.id`) — no task/parent to rebuild the link from here, and `fresh`
never became a real queryable identity (archived + unlinked); filing under it would be discoverable only
by timestamp proximity, the exact gap this event closes.

**Event surface checked, nothing else needed:** added to `OrchestrationEventKind` +
`ORCHESTRATION_EVENT_KIND_MEMBERSHIP` (TS-enforced exhaustive map). NOT added to
`EVENT_TRIGGER_EVENT_KINDS`/`GATE_HISTORY_KINDS` (siblings `recycle_begin`/`recycle_complete` aren't
members either) or to `ORCH_ACTIVITY_KINDS`/`REPORT_RESOLVED_EVENT_KINDS` (both already treat the
earlier `recycle_begin` in the SAME attempt as sufficient proof; redundant to add this too).

**3. The hard-killed worker's own pending wakes.** After `4be56c33`'s unlink, `hasSuccessor(predecessor)`
is false and `resume()`'s only resurrection guard is that flag — no `archivedAt` gate. `recycleWorker`
hard-kills the predecessor's pty BEFORE the spawn attempt (genuinely dead on a failed retry, per
`4be56c33`'s own record), so a due `wake_me` would find `!pty.isAlive`, `hasSuccessor === false`, and
auto-`resume()` it — reviving the worker the manager just tried to retire. Decision: **cancel** the
predecessor's wakes in the catch (`cancelWakesForSession(workerSessionId)`; its return captured as
`cancelledWakes`, folded into `recycle_failed.detail` — an audited count, not a silent drop, the
count-shaped equivalent of the per-wake `wake_dropped` event `4be56c33` predates). **NOT** "consistent
with the SUCCESS path" — that path does the OPPOSITE: it KEEPS the wakes, re-pointing them onto the live
successor (`reparentWakes`, right after the catch). Honest reason: on FAILURE there is no live successor
to carry them to, and re-pointing onto the MANAGER (the only other live party in scope) would deliver a
worker's self-note to the wrong agent — worse than dropping it. **Cost:** a recycle that fails then is
retried successfully loses every wake a first-try success would have carried over.

**Scoped to `recycleWorker` ONLY** — `recycleManager`/`recyclePlatformLead`'s predecessor is genuinely
still alive after a failed recycle (never flipped off `live`, or restored to it), so `wake.tick()`'s
`!pty.isAlive` check is false and wakes deliver normally: no bug in those two catches.

## Do not

- Do not port the wake-cancel to `recycleManager`'s or `recyclePlatformLead`'s catch — their predecessor
  is genuinely still alive after a failed recycle (verified above); cancelling its wakes there would drop
  real reminders from a live session, not prevent a resurrection.
- Do not file `recycle_failed` under the failed successor's own id for manager/Lead — it is archived and
  unlinked, undiscoverable except by direct event id or timestamp guessing.
- Do not add `recycle_failed` to `EVENT_TRIGGER_EVENT_KINDS`/`GATE_HISTORY_KINDS`/`ORCH_ACTIVITY_KINDS`/
  `REPORT_RESOLVED_EVENT_KINDS` without a fresh case; checked against all four, none apply.
- Do not "fix" the duplicate-`gen` a retried recycle produces — a display hint, never a unique key; the
  archived+unlinked prior attempt is unreachable from any lineage walk or listing.
- Do not claim `archiveSession` hides the failed row from MCP `worker_list` — only from
  `db.listWorkers`/`listAllSessions`; `getDanglingWorkers` still surfaces it as `dangling`.

## Source

`packages/daemon/src/sessions/service.ts`: the three recycle catches, each anchored `@decision
08320d02`. `packages/daemon/src/db.ts`'s `cancelWakesForSession`. `packages/shared/src/types.ts`'s
`recycle_failed` case doc + membership entry.
