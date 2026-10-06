# 92c20eb9 — refuse fleet writes from a manager being retired by recycle

## Context

`insertRecycleSuccessor` (sessions/service.ts, called from `recycleManager`/`reattemptManagerOwnershipTransfer`)
links a fresh successor's `recycled_from` to the predecessor SYNCHRONOUSLY, well before the predecessor's
pty is actually hard-stopped. `settleRecycleHandoff` is fire-and-forget (`void this.settleRecycleHandoff(...)`)
and only stops the predecessor after `RECYCLE_SUCCESSOR_SETTLE_FLUSH_DELAY_MS` plus the successor reaching
ready — the predecessor's row stays `role:"manager"`, `processState:"live"` the whole time. The same shape
exists for `recycle_reattempt`'s RESOLVED branch. In that window, the predecessor can still receive and
execute MCP tool calls.

Two distinct defects were found in this window, both keyed off the same `isSupersededByRecycle` predicate
(orchestration/crash-orphaned-workers.ts) — never a bare `hasSuccessor`, which would also refuse the one
case that must stay live: a halted predecessor whose ownership-transfer handoff is still genuinely
unresolved (decision `386e4eb5`/`f1969787`).

1. **`spawnWorker`** (and `reviveWorker`, which wraps it) had no check at all — a worker spawned/revived by
   the retiring predecessor during this window was parented to a manager about to be stopped.
2. **`selfHealWorkerLink`** (mcp/orchestration.ts) is called from every manager-surface per-worker tool. It
   uses `workerReadableByManager`, which is lineage-scoped (same `lineageRootId` root), not exact-parent —
   so if the retiring predecessor called ANY of those tools on a worker `attemptManagerOwnershipTransfer`
   had already reparented onto the successor, the self-heal would relink the worker's `parentSessionId`
   BACK onto the dying predecessor, undoing the correct reparent and orphaning the worker from the
   successor's `worker_list` (an exact-parent-match query) right before the predecessor is hard-stopped.

## Fix

- `spawnWorker` refuses up front (`isSupersededByRecycle(this.db, managerSessionId)`) before any side
  effect — covers `worker_revive` for free since it calls `spawnWorker` internally.
- `selfHealWorkerLink` skips the relink (returns the row unchanged) when the caller is superseded —
  `callerSupersededError()`, mcp/orchestration.ts.
- The write tools among `selfHealWorkerLink`'s callers that mutate fleet state on behalf of the caller —
  `worker_stop`, `worker_message`, `worker_redirect`, `worker_recycle`, `worker_merge_confirm`,
  `merge_batch`, `worker_set_mode`, `worker_flush`, `worker_reap`, `worker_relink` — refuse outright with
  the same error text when the caller is superseded, via the same `callerSupersededError()` helper.
- Error text (both chokepoints): `you are being retired (recycled); your successor <id> owns the fleet`.

## Do not

- Do not use a bare `hasSuccessor` check in place of `isSupersededByRecycle` anywhere in this fix — it
  would wrongly refuse a halted predecessor whose handoff is genuinely unresolved and must stay live (see
  `386e4eb5`/`f1969787`).
- Do not refuse the three pure-read callers of `selfHealWorkerLink` (`worker_status`, `worker_transcript`,
  `worker_report_get`) or `worker_merge` (a dry-run review, not a mutation) — only the self-heal's
  RELINK side effect was ever unsafe for a read; the reads themselves stay available to a retiring
  predecessor.
- Do not compute `isSupersededByRecycle` once at server-build time and cache it — the caller's own
  supersession status can change mid-session (the predecessor's MCP server is built while it is NOT yet
  superseded); it must be re-evaluated on every call.
- Do not duplicate the `isSupersededByRecycle`/`getSuccessor`/error-text logic at each of the ten write
  call sites — route them all through the one `callerSupersededError()` helper (mcp/orchestration.ts) so
  the error text and predicate can't drift apart across sites.

## Halted-predecessor relink-back (Code Review round 1)

A HALTED predecessor (the `386e4eb5`/`f1969787` carve-out above) is deliberately NOT superseded, but can
already have had a worker reparented onto its successor (halting only blocks RETIRING, not the "workers"
step). `callerSupersededError()` never fires for it, so it hit the same relink-back bug as the superseded
case (`recycle-refuses-fleet-writes.mjs`'s Part B: `liveW` on `m2` while `m1` stays unsuperseded).

Fix: `selfHealWorkerLink` also skips the relink whenever the worker's `parentSessionId` already equals the
caller's own successor (`db.getSuccessor(managerSessionId)?.id`) — unconditionally, independent of
`isSupersededByRecycle`. Once the relink stops, a write tool's own downstream exact-match guard in
`sessions.*` correctly refuses "not your worker" for that one worker.

### Do not

- Do not gate this check on `isSupersededByRecycle` — false by design for exactly the case this covers.
- Do not extend the 10 write-tool refusals to also check "does this worker belong to my successor" — a
  halted predecessor still legitimately owns the REST of its fleet; the downstream exact-match guard
  already refuses the ONE worker that moved, once this fix stops masking that it moved.

## Card 8ca27cce — five more writes, and the settle-nudge target itself

The 92c20eb9 Code Review (reviewer `e6c9a84c`, 2026-10-06) found the original fix's own scope was
incomplete: `callerSupersededError()` only ever reached the 10 `selfHealWorkerLink` write callers, never
the handful of OTHER manager-surface tools that mutate fleet-wide or host-wide state on the caller's
behalf, and the SETTLE-NUDGE routing this card's own Fix section didn't touch at all turned out to share
the identical blind spot via a different mechanism. A follow-up review (`74d00a2a`, same day) then found
`question_ask` belonged in the refuse set too (it was first traced as "no fix needed" — see below for why
that was wrong) and a second gap in the settle-nudge fix itself.

### Traced, fixed by REFUSE (same `callerSupersededError()` chokepoint)

- **`gate_cancel`** (manager-scoped, orchestration.ts) — a retiring predecessor could cancel a merge/
  run_gate/deploy op its successor now owns. `cancelGateOp` had no supersession check at all.
- **`daemon_restart`** — a retiring predecessor could trigger a fleet-wide restart (every live session,
  every project) mid-settle. `requestDaemonRestart` only checked `role==="manager"||"platform"`.
- **`deploy`** — a retiring predecessor could unilaterally run the project's configured `deployCommand`
  (a build/push/webhook). `deployOwnProject` had no supersession check either.
- **`question_ask`** — `reparentQuestions` is a ONE-SHOT `UPDATE` run once at recycle-mint time; a
  question filed by the predecessor AFTER that pass keeps `session_id = predecessor` FOREVER (nothing
  ever re-runs the reparent for it). That stale `session_id` breaks three session_id-EXACT reads, each on
  its own downstream consumer, none of which are agent-lineage-joined the way the human-answer push and
  `question_pull` are (see the corrected trace below): `Db.hasPendingQuestionForSession` (exact
  `session_id = ?`, read by `idle-watcher.ts` to suppress an idle nudge while a manager is genuinely
  waiting on its own ask) misses it on the successor, so the successor gets nudged as if it forgot to ask
  anything; `hasUnconsumedAnswer` (`orchestration/wake-impact.ts`, same exact-match read via
  `listQuestionsForSession`) misses an answered-but-unpulled row too, so a restart wake that exists only
  to deliver that answer gets misclassified as a no-op wake; and `listQuestionsForAudit`'s `stale` flag
  (questionTool.ts's `auditRequestItem`, card `5ea0153c`) is computed from the row's CURRENT routing
  target — once the predecessor is finally hard-stopped, a perfectly live, successor-owned ask reads as
  stale/moot in the human's own Requests audit.

All four refuse via the SAME `callerSupersededError()` helper used by the original 10, at the MCP-handler
call site (never inside the `SessionService` method itself — matches the original 10's placement, and
keeps the predicate at one chokepoint).

### Traced, fixed by a NARROWER refuse (`wake_me`, universal tool)

`wake_me` (mcp/server.ts, the universal `loom-tasks` router — every role, not just manager) is keyed to
the exact scheduling session id, with no lineage resolution: a wake scheduled by the retiring predecessor
either fires into the dying predecessor (wasted) or, once the predecessor is hard-stopped, `WakeService.
tick()`'s auto-resume throws `isSupersededByRecycle`'s own refusal and the wake is dropped (`wake_dropped`
event, wake.ts). Fixed by calling the SAME two exported primitives `callerSupersededError()` wraps
(`isSupersededByRecycle`/`retiredCallerMessage`, crash-orphaned-workers.ts) directly — `wake_me` lives on
a different router than the manager-only `callerSupersededError()` closure, so it cannot reuse that exact
closure, but reuses the same two underlying functions, never a re-derived predicate.

**Scoped to `role==="manager"` only** (an explicit role check before the supersession check) — `wake_me` is
also reachable by workers, the platform Lead, and companions, none of which this card analyzed. Worker
`worker_recycle` and Platform Lead `recyclePlatformLead` recycled-wake semantics are UN-ANALYZED by this
fix, not confirmed safe — a future card widening this must verify that window on its own terms, not assume
the manager analysis transfers.

**Why `question_ask` was first traced as safe, and why that was wrong:** the human-answer push
(`POST /api/questions/:id/answer`, gateway/server.ts) genuinely does resolve its delivery target via
`db.getLiveSessionForAgent(agentId)` — the MOST-RECENTLY-CREATED live session on the asking agent, never
the question row's own `session_id` — so the ANSWER NOTIFICATION really does reach the successor. The
error was treating that one push as the whole mechanism. `question_pull`'s own read
(`pullAnsweredQuestionsForAgent`/`pullAnsweredQuestionsForAgentBounded`, db.ts — a direct
`JOIN sessions s ON s.id = q.session_id WHERE s.agent_id = ?`, corrected here from an earlier, wrong
claim that it also used `getLiveSessionForAgent`) is ALSO agent-lineage-joined and would have found the
row fine. But the three consumers named above are NOT lineage-joined, and nothing about the push or the
pull mechanism protects them — the trace only checked "can the successor eventually learn the answer",
never "does anything read this row by exact session_id in the meantime".

### Traced, no fix needed

- **`schedule_create`** — a `Schedule` row is keyed by `agentId`/`cron`, never by the creating session's
  id; `Scheduler.tick()` fires it via `startManager(agentId, ...)`, agent-scoped, not session-scoped. There
  is nothing on the row for a recycle to leave stranded — it was never "owned" by the predecessor's session
  in the way the other tools in this card are.
- **`reminder_create`** — registered ONLY when `this.companion.companionSessionIds?.has(sessionId)`
  (orchestration.ts) — a manager session is never a companion session, so this tool is not even on a
  retiring manager's tool list. Unreachable by the scenario this card is about.
- **`gate_intent_declare`/`gate_intent_withdraw`** — structurally advisory-only (card `a5d1ae04`): never
  touch the `GateSemaphore`, never persisted across a restart, and `gate_queue`'s own read side already
  excludes a dead seat's declaration. Harmless if a retiring predecessor declares one.
- **platform.ts's own `daemon_restart`** (the Platform Lead surface) — OUT OF SCOPE. The Platform Lead
  uses a different recycle mechanism (`recyclePlatformLead`, no ownership-transfer/halt branch at all) and
  this card is specifically about MANAGER ownership transfer; that twin carries no supersession check
  either, but fixing it needs its own analysis of the Lead's recycle shape, not an assumption that this
  card's manager-scoped reasoning transfers.

**Scope boundary (LEAD decision):** the REMAINING manager-surface mutators — `project_update`/
`project_archive`, `agent_*`/`profile_delete`, `board_column_*`, `skill_*`, `memory_*`,
`schedule_update`, `peer_message`, `notify_lead`, `platform_escalate`, `end_me`, `tasks_*` — are
DELIBERATELY left unguarded by this card. They write project/config state (or peer/board/skill/memory
rows) that is never keyed to the CALLING SESSION's own id the way a fleet-ownership tool (a worker's
`parentSessionId`, a gate op's `sessionId`, a wake's `sessionId`, a question's `session_id`) is — so the
defect class this card and 92c20eb9 both exist to close (a stale/dying session acting as if it still owns
something it no longer does) does not apply to them. A retiring predecessor's stale-intent edit to one of
these during the few-second settle window is an accepted, bounded cost, not a gap to close here.

### Fix: `resolveSettleNudgeTarget` itself had the SAME blind spot

`resolveSettleNudgeTarget` (service.ts, `@decision 05c36bf4`) re-resolves a settle-nudge's delivery target
at settle time via `liveLineageSuccessor(db, sessionId)` — which checks `processState==="live"` on the
STARTING id FIRST, before ever walking to `db.getSuccessor`. Since the predecessor's row stays
`processState:"live"` for the entire settle window (this record's own Context, above), an op that settles
WITHIN that window — merge/gate/batch alike — resolved its nudge target back to the dying predecessor
itself, not the successor. If that durable push didn't drain before the hard-stop, `redriveQueuedMessage`'s
manager-specific branch (service.ts) explicitly RETIRES it rather than redelivering to the successor
(reasoning the successor can recover the real outcome via `gate_status`/`gate_history` instead) — so this
was a lost courtesy nudge, not a lost durable record, but still a real gap inside the exact window this
card is about.

Fixed AT THE RESOLVER (not in `liveLineageSuccessor`'s general semantics, which several OTHER callers rely
on unchanged): when `isSupersededByRecycle(sessionId)` is true, route to the successor's own
lineage-forward-resolved live session (`liveLineageSuccessor(db, successor.id)`) — bypassing the starting
id's own liveness entirely. **Round 2 correction (Code Review `74d00a2a`):** the first version of this fix
fell back to the BARE successor id (`?? successor.id`) when nothing was found live forward of it — but a
successor can itself die before ever reaching ready, with neither an ordinary hard-stop of the predecessor
nor `recoverFleetAfterFailedRecycleSuccessor`'s link-unwind having run yet; returning that dead successor's
id hands the nudge to a pty nothing will ever drain. Fixed to fall through to the ORIGINAL
`liveLineageSuccessor(db, sessionId)?.id ?? sessionId` lineage walk from the STARTING id instead — in that
exact shape the predecessor is still the only live thing in the lineage, so the walk correctly finds it.
When `isSupersededByRecycle` is false (including the HALTED carve-out), behavior is completely unchanged —
`liveLineageSuccessor(db, sessionId)` as before, so a halted predecessor keeps receiving its own nudges
directly, exactly as `386e4eb5`/`f1969787` require.

Tests: `packages/daemon/test/pending-op-settle-lineage.mjs` scenarios (E) (settles inside the live settle
window — nudge lands on the successor, with the predecessor-attribution suffix), (F) (HALTED control —
nudge stays on the genuinely-halted predecessor, no suffix), and (G) (round-2 correction — the successor
dies before ready; the nudge falls through to the still-live predecessor, never the dead successor's id).

### Do not

- Do not refuse `gate_cancel`/`daemon_restart`/`deploy`/`question_ask`/`wake_me` by adding a SECOND,
  independently-derived supersession check — the first four route through the EXISTING
  `callerSupersededError()` closure; `wake_me` calls the SAME two underlying exported primitives that
  closure wraps. A third, hand-rolled check anywhere is exactly the drift this card's own parent record
  (92c20eb9's "Do not" above) already warns against.
- Do not widen `wake_me`'s refusal beyond `role==="manager"` without first analyzing worker/platform-lead
  recycled-wake semantics on their own terms — this fix's role scope is a deliberate boundary of what was
  actually investigated, not evidence the wider case is safe.
- Do not fix `resolveSettleNudgeTarget`'s blind spot by changing `liveLineageSuccessor`'s own
  starting-id-liveness semantics — other callers (e.g. `liveFleetResumeSet`'s exclusion filter,
  `pending-op-settle-lineage.mjs` scenario 0/0b) rely on today's behavior unchanged; the fix belongs at
  THIS resolver only, gated on `isSupersededByRecycle`.
- Do not fall back to a bare `successor.id` when nothing is live forward of it (the round-1 shape of this
  fix) — a successor that died before ready is not a valid delivery target; fall through to the ORIGINAL
  lineage walk from the starting `sessionId` instead (round 2's actual fix, above).
- Do not assume `question_ask`'s delivery mechanism being lineage-safe means the TOOL itself is safe to
  leave unrefused — a mechanism can correctly deliver the eventual ANSWER while several OTHER, unrelated,
  exact-session_id-keyed reads of the same row (idle-nudge suppression, wake-impact classification, the
  audit `stale` flag) still break. Trace every consumer of a row's session_id, not just the one you
  already know about.
- Do not assume `schedule_create`/`reminder_create` needed a refusal just because `question_ask` turned
  out to need one on review — `schedule_create`'s row is agent-keyed (no session_id to go stale at all)
  and `reminder_create` is unreachable by a manager session; both were traced individually and found
  structurally unaffected, for reasons specific to each, not by analogy to question_ask's shape.
