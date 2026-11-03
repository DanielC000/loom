# dacc6d9e — worker context WARN/INTERRUPT: busy gate, no-supersede, and the gate-in-flight predicate

## Narrative

Card `dacc6d9e`, part B of epic `8c7dfc65`: the worker-scoped twins of `ContextWatcher`'s manager-side
ordinary ratio nudge and emergency interrupt (`9f279c7b`), over a THIRD loop in `ContextWatcher.tick()`
(`db.listLiveWorkers()`). Trigger C (`checkWorkerContextWarn`) crosses `workerContextWarnRatio` (default
0.60) and pushes an informational `[loom:worker-context-high]` notice to the OWNING MANAGER — never a
nudge to the worker itself, since a worker has no wind-down/recycle doctrine of its own. Trigger D
(`checkWorkerContextInterrupt`) crosses `workerContextInterruptRatio` (default 0.85) and Esc-interrupts
the worker directly via `SessionService.redirectWorkerForContextInterrupt`, telling it to commit now and
report progress.

Three design choices were deliberately NOT inherited from the shape of their closest sibling
(`redirectWorker`/`redirectManagerForEmergencyRecycle`), each a manager review correction during this
card's implementation:

1. **Trigger D requires `w.busy === true`.** An idle worker isn't burning context, and an idle worker
   that has already reported (`awaitingReview`) must not be forced into a fresh turn that would make it
   RE-report and clear the review state its manager is actively acting on. Also skipped while the worker
   is parked on a rate limit (`rateLimitedUntil` in the future) — same reasoning, it isn't taking a turn
   either way. Neither refusal records an event, so a later tick can still fire once the worker goes busy
   (or its rate limit clears) while still over the floor.
2. **`redirectWorkerForContextInterrupt` passes `supersedeQueue: false`, unlike `redirectWorker`'s own
   default of `true`.** A worker's queue holds its OWN MANAGER's direction — the same ownership shape
   `deliverRedirect`'s `supersedeQueue` doc describes as the one case where flushing is correct. But this
   interrupt is DAEMON-originated, not the manager's own call: silently discarding a manager's queued
   instruction on the daemon's own initiative is a loss the manager never authorised. The existing
   `worker_report done` hard guard already forces the worker to consume queued direction before reporting,
   so nothing is lost by leaving it queued here — the manager's direction and the interrupt's own text both
   reach the worker (the manager's own direction resolves as a PLAIN delivery, never "superseded").
3. **The owning manager is told directly when Trigger D fires** (`[loom:worker-context-interrupt]`,
   pushed via the same `pty.enqueueStdin` Trigger C uses) — it must not learn about the interrupt only
   from the worker's own next report.

## The gate-in-flight predicate

`SessionService.hasLiveGateForSession(sessionId)` — the worktree-scoped twin of the pre-existing
`hasLiveGateForProject`, narrowed to `GateDescriptor.sessionId` instead of `projectId`. `sessionId` on a
gate descriptor is documented as "the SUBJECT session: the worker for a merge/worker gate" — so this ONE
check covers both hazards a worker-context interrupt must refuse against: the worker's OWN `run_gate`
self-check (gateType `"worker"`) AND its manager's `worker_merge_confirm` gate on that worker's branch
(gateType `"merge"`), regardless of whose pty is actually blocked on the call (a worker never executes
`worker_merge_confirm` itself, but its session id is still the gate's subject). Deliberately NOT the
repo-level `listActiveMergeDangerWindows` check `redirectManagerForEmergencyRecycle` uses — that guards a
DIFFERENT hazard (the MANAGER's own turn synchronously running the squash inside its own
`worker_merge_confirm` call) that cannot apply to a worker's pty at all. The real hazard here is narrower
and worktree-scoped: forcing the worker to `git commit` right now while a gate is reading/building from
that SAME worktree risks a concurrent-git race or invalidates what the gate just tested. Covers BOTH
queued and running phases, not just `phase:"running"` — a QUEUED gate still means an outcome is pending
that an Esc could orphan or misdeliver.

A refusal (not-busy, rate-limited, or gate-in-flight) records NO event, so the very next tick retries from
the same untried state — mirrors `redirectManagerForEmergencyRecycle`'s own merge-danger-window policy;
`ContextWatcher.tick()` never polls/waits inside one tick.

## Once-per-session-id dedupe — the stated premise

Both Trigger C and Trigger D fire AT MOST ONCE EVER per worker session id (`listEventsForWorkerKinds`
presence check), no per-turn re-arm key — copying `checkEmergencyOccupancy`'s own round-4 fix
(`c5b234aa`/`9f279c7b`) rather than re-deriving a fourth re-arm key, since Trigger D's own
Esc→settle→drain mutates `busy`/`lastActivity`/`turnSeq` exactly like the manager emergency interrupt's
does.

For Trigger C specifically, this "once ever" shape is strictly narrower than the card's own "once per
crossing" phrasing could in principle require — it is sound here ONLY under a stated premise: **a live
session's `ctxInputTokens` is monotonically non-decreasing for the life of that session id**, because
auto-compact is disabled by the owner's own decision (card `8c7dfc65`'s incident note), and the only other
way occupancy could drop is a fresh session row (`worker_recycle`), which is a different session id and
re-arms naturally. Under that premise there is only ever ONE crossing per session id to notice, so "once
ever" and "once per crossing" coincide. A manual human `/compact` mid-session is an accepted gap here —
it would make occupancy drop without a session-id change, and this dedupe would still treat the session
as already-notified. This is a deliberate, accepted gap, not an oversight: do not add a re-arm key to
close it.

## Round 2 (Code Review, 4 findings)

1. **The worker loop had no exhaustion guard.** `ContextWatcher.tick()`'s worker loop (Triggers C/D)
   never called `checkContextExhaustion`/`isAlreadyContextExhausted` — the SAME skip the manager/platform
   loops use (card `66ff7321`, part C) — so an exhausted worker (busy cleared, `contextExhaustedAt` set,
   `ctxInputTokens` frozen at whatever it last read) kept feeding both triggers a dead reading forever.
   Fixed by adding the identical two-call skip at the top of the worker loop, reusing the class's own
   methods rather than a worker-specific copy.
   - These two methods are shared verbatim across manager/platform/worker rows; `checkContextExhaustion`'s
     own event-kind branch (`manager_context_exhausted`) is unconditional on the caller's role. Calling it
     for a worker for the first time means: the filed event is `manager_context_exhausted` under a WORKER
     session id, and the owning manager never gets `BusyWorkerWatcher`'s own rich
     `[loom:worker-context-exhausted]` push notice (companion/attention-push.ts's `worker_context_exhausted`
     → "worker-blocked" classification explicitly assumes that direct nudge already happened) — nor does
     any `worker_context_exhausted`-gated event trigger ever fire. **Round 2 wrongly called this
     "race-dependent, cosmetic-at-best" and left it as a named residual.** It was neither: `ContextWatcher`
     is constructed and `start()`-ed before `BusyWorkerWatcher` (index.ts), and Node fires two equal-interval
     (60s) timers in creation order, so `ContextWatcher.tick()` **deterministically** runs first on every
     tick where both would fire — this watcher won the race every single time, not merely sometimes, and
     the loss was the manager's own direct exhaustion notice, never cosmetic. Round 3 (below) closes this
     structurally by making the worker loop's own exhaustion check READ-ONLY — it never marks or files
     anything, so it never competes with `BusyWorkerWatcher` for the mark at all, and the "which one wins"
     question this residual depended on no longer arises.
   - **Recovery-turn gap (sub-finding):** the exhaustion skip alone does not cover a RECOVERY turn. A
     busy rising edge (`SessionService.handleBusyEdge`) clears `contextExhaustedAt` via
     `db.clearContextExhaustedOnResume` but never touches `ctxInputTokens`/`ctxUpdatedAt` — so a human
     composer `/compact` (or any other busy(true) edge) can start a turn with `w.busy:true`, no exhaustion
     flag, and a STALE, pre-compaction `ctxInputTokens` reading still above the interrupt floor, with
     nothing fresh measured yet this turn. `checkWorkerContextInterrupt` fixed this by requiring the
     reading's own timestamp (`w.ctxUpdatedAt`) to be strictly LATER than the current turn's start
     (`w.lastActivity` — `db.setBusy` stamps this on EVERY busy transition, rising and falling, and
     nothing else touches it while busy, so for a busy row it IS the current turn's rising-edge instant).
     A stale reading simply refuses, same as every other refusal in this method (no event, retries next
     tick once a fresh in-turn sample lands via the Stop hook or the mid-turn sampler).

2. **The interrupt was ordered BEHIND queued manager direction.** Round 1 enqueued the Trigger D interrupt
   at the FIFO tail (`supersedeQueue:false`, sender `"system"`), so `drainPending`'s leading same-sender
   run drained the MANAGER's own already-queued direction FIRST, as its own turn — exactly the turn that
   could exhaust the worker, defeating the interrupt's whole purpose. Fixed with a new `headInsert`
   option, additive end-to-end: `EnqueueStdinTail.headInsert` (pty/host.ts) forces `enqueueStdin`'s HELD
   path to insert at `live.pending` index 0 instead of the FIFO tail (and skips the same-sender
   coalescing reorder scan entirely) — threaded through `SessionService.enqueueDurableMessage`'s own
   `ctx.headInsert` and `deliverRedirect`'s own `opts.headInsert`, set `true` only by
   `redirectWorkerForContextInterrupt`. Every other caller omits it — byte-identical FIFO behavior.
   Nothing is flushed/superseded; the manager's own direction still survives and drains right after the
   interrupt, as its own turn, same as `supersedeQueue:false` always intended.

   **Round 3 correction:** this interrupt actually enqueues `kind:"agent"`, never `"warning"` —
   `enqueueDurableMessage`'s `const kind: QueuedMessageKind = ctx.kind ?? "agent"` (sessions/service.ts)
   defaults to `"agent"`, and neither `redirectWorkerForContextInterrupt` nor `deliverRedirect` passes a
   `kind` override. Skipping the coalescing reorder scan is NOT moot for an agent-kind entry in general —
   it matters for every OTHER agent-kind head. It IS still a no-op for THIS specific entry, for a
   different reason: `enqueueStdin` null-maps the `"system"` sender sentinel (`coalesceSenderIdentity`,
   pty/host.ts) before this entry ever reaches `drainPending`, so its `senderId` is `null` — and
   `drainPending`'s same-sender extension loop is gated on `senderKey !== null` (host.ts, the
   `head.giveUpGen === undefined && senderKey !== null` guard), so a null-sender agent head can never
   extend into a coalesced run regardless of whether the reorder scan ran. It always drains ALONE as its
   own turn, which is exactly what keeps the ordering fix sound: the interrupt lands as one isolated turn
   at the queue front, and the manager's own (non-null-sender) direction drains right after it as its own
   separate turn, never merged with it.

3. **Gaps in `hasLiveGateForSession`.** The original predicate only read the cap-admitted registry
   (`snapshot()`) and the mid-squash holder map (`squashOnlySnapshot()`) — missing two further live
   states. Widened to also read `GateSemaphore.repoGuardOnlySnapshot()` (an inert-diff-skip, gate-interval,
   or gate-disabled landing holds ONLY `acquireRepoGuardOnly`, never admitting through the cap/registry
   at all) and `SessionService.peekPendingMerge(sessionId)?.state === "running"` (a `worker_merge_confirm`
   CALL is "running" — ownership-checked and in flight — from the instant it's minted, well before AND
   after gate admission, including the pre-admission prep window and anything served via the retained-
   result reuse path; `peekPendingMerge` also walks the recycle lineage, so a predecessor's still-running
   op is found too). `merge_batch` and the dist-importer check run in ISOLATED worktrees, never this
   worker's own, so neither needed to be added — they were never a gap. The doc's former "this ONE check
   covers BOTH hazards" framing is corrected: it is now four independent reads, none of them more closely
   tied to either hazard (a worker's own `run_gate` self-check, or its manager's `worker_merge_confirm`)
   than the others.

4. Nits: `config.ts`/`types.ts` cited a non-existent `checkWorkerContextRatios` — the real names are
   `checkWorkerContextWarn`/`checkWorkerContextInterrupt`; `config.ts`'s "Read ALSO by card 17576ca3's
   dispatch-time guard" forward claim was reworded to state it as planned, not yet real; the narrative
   previously inline at `service.ts` (`hasLiveGateForSession`'s own doc) and `config.ts` (the two config
   keys' own doc) is now a contract line plus this `@decision dacc6d9e` pointer, with the narrative living
   here instead.

## Round 3 (Code Review round 2, ONE blocking MAJOR)

1. **The worker loop's own reuse of `checkContextExhaustion` was itself the regression.** Round 2's fix
   (finding 1, above) called `this.checkContextExhaustion(db, pty, w, nowIso)` for a worker exactly like
   the manager/platform loops do — but that method is `ContextWatcher`'s own MARKING method: on a match it
   calls `pty.markContextExhausted`, stamps `db.setContextExhausted`, and files `manager_context_exhausted`
   under the session id it was passed. For a worker row that session id is the WORKER's own, and (per the
   corrected residual paragraph above) `ContextWatcher` deterministically ticks before `BusyWorkerWatcher`
   — so this loop permanently WON the mark, every time, for every worker that ever hit the terminal
   "Prompt is too long" write. The consequence: the manager got NO exhaustion notice at all (only a
   `manager_context_exhausted` event stamped against a worker id, which nothing on the manager-notify path
   reads), web attention showed "manager `<workerId>`", the companion classified it as "context-overflow"
   instead of "worker-blocked", and any `worker_context_exhausted`-gated event trigger never fired —
   `BusyWorkerWatcher`'s own `worker_context_exhausted` branch (busy-worker-watcher.ts) never even ran its
   `if (exhaustion)` body, because its own `pty.markContextExhausted` call found the mark already applied
   and no-op'd.

   **Fix:** the worker loop is now READ-ONLY for exhaustion. It still skips an already-marked worker
   (`isAlreadyContextExhausted`, unchanged), but the FIRST-detection path no longer calls the marking
   method at all — a new, separate `isWorkerContextExhaustedUnmarked` mirrors `checkContextExhaustion`'s
   own guard (`!w.busy || w.harness === "codex" || !w.engineSessionId` → skip) and pure tail-read
   (`checkContextExhaustion(w.cwd, w.engineSessionId, w.harness)`, the MODULE-level function from
   `./context-exhaustion.js` — same name, different thing, see that file's own export), but performs NONE
   of the side effects: no `pty.markContextExhausted`, no `db.setContextExhausted`, no event append. A
   match just `continue`s past the rest of the worker loop for this tick, exactly as before, but leaves
   the worker UNMARKED — so `BusyWorkerWatcher`'s own tick (which runs on the same session rows, moments
   later) is now the ONLY place a worker's exhaustion is ever marked or notified, closing the race by
   removing one of its two competitors rather than trying to referee it.

2. **Test.** `context-watcher-worker-exhaustion-busy-worker-watcher.mjs`-shaped coverage is exercised
   through the existing `context-watcher-context-exhausted.mjs` / `busy-worker-watcher-context-exhausted.mjs`
   pair (see this card's own DoD) — a real `ContextWatcher.tick()` followed by a real
   `BusyWorkerWatcher.tick()` against one `Db`, with an exhausted-worker transcript fixture, asserting
   exactly one `worker_context_exhausted` event, the manager notice delivered, and ZERO
   `manager_context_exhausted` events for the worker's own session id. Shown RED against round 2's own
   287f1b44 (the pre-round-3 worker loop) via `negative-control --ref 287f1b44` on `context-watcher.ts` —
   failing on the ASSERTION (zero `manager_context_exhausted` events expected, one found), never on a
   missing export, per lesson 298's own mutant-not-structural-failure bar.

3. **The `kind:"warning"` claim in Round 2 finding 2 (above) was WRONG — corrected inline there.** The
   interrupt actually enqueues `kind:"agent"` (`enqueueDurableMessage`'s own `ctx.kind ?? "agent"`
   default); the ordering fix is sound for an entirely different reason — `coalesceSenderIdentity`
   null-maps the `"system"` sender sentinel before the entry reaches `drainPending`, and a null-sender
   agent head can never extend the same-sender coalescing run (`senderKey !== null` guard) — so it still
   always drains alone. See the inline correction for the full explanation; `pty-head-insert.mjs` gained a
   PRODUCTION-shape scenario (E) proving exactly this: an agent-kind, null-sender, headInsert entry ahead
   of a queued same-manager two-message agent run drains alone, as its own isolated turn, while the
   manager's run is left intact to coalesce on its own next turn.

4. **A named, documented (not closed) residual: the legacy `coalesceAgentMessages:true` toggle (default
   `false`) can still mix the interrupt into the manager's run.** `drainPending`'s branch selection is
   `if (!this.coalesceAgentMessages && head.kind === "agent") { /* same-sender branch */ } else { /*
   route-keyed branch */ }` — when the toggle is `true`, EVERY drain takes the route-keyed branch
   regardless of kind, and that branch's own extension condition (`routeKeyOf(...) === key &&
   (this.coalesceAgentMessages || ...kind === head.kind) && (...proactive ?? false) === proactiveKey`)
   never consults `senderId` or any "was this a headInsert entry" fact at all — because `headInsert` is a
   property of `EnqueueStdinTail` (the enqueue-time OPTIONS tail), consumed only to decide `insertAt` and
   to skip the enqueue-time reorder scan; it is **not** a field on `QueuedMessage` itself (see that type's
   own exhaustive field list, pty/host.ts) and so cannot be read back once the entry sits in `live.pending`
   awaiting drain. So under `coalesceAgentMessages:true`, a head-inserted interrupt (empty route, like the
   manager's own direction) sitting at index 0 is just an ordinary route-keyed-branch head: the manager's
   own queued direction (same empty route key, same proactive) extends the run onto it, and BOTH bodies
   land in one write — the interrupt's text and the manager's own direction concatenated into a single
   turn, exactly the merge `supersedeQueue:false`/`headInsert` were built to avoid.

   **Not fixed here, and not a small, local change** — closing it needs a NEW field that survives from
   enqueue through to drain (and through every requeue/give-up-redrive/restart-carry path a `QueuedMessage`
   field has to survive, per `ownerTextSeq`/`mintedAtGen`'s own carry-forward rules elsewhere in this
   file), not a one-line condition inside `drainPending`. This toggle is OFF by default for every project
   (card `eac3464d`'s own "Do not" section already warns against raising/removing its bounds without
   accounting for a live confirmation-loss defect it amplifies) and the worker-context interrupt is new
   (card `dacc6d9e`, this epic) — so no project has ever combined the two. Pre-dates this card (the
   route-keyed branch's sender-blindness is original design, not something this card introduced) and is
   documented here rather than fixed, per this round's own investigate-first instruction. A future fix
   would thread a persisted `headInsert`-origin marker onto `QueuedMessage` and add it to the route-keyed
   branch's extension condition — scoped and reviewed as its own change, not folded into this one.

## Do not

- Do not add a per-turn re-arm key (per-reading, `lastActivity`, `turnSeq`) to Trigger D's dedupe — see
  `docs/decisions/c5b234aa-mid-turn-sampler-race-guard.md` and
  `docs/decisions/9f279c7b-contextwatcher-emergency-recycle-interrupt-trigger-a.md` for the three rounds
  that each reopened the same cascade from a different direction on the manager's identical interrupt.
- Do not let Trigger D fire for an idle worker, including one `awaitingReview` — it isn't burning
  context, and forcing a fresh turn would make it re-report and clear review state the manager is acting
  on. Do not let it fire while the worker is parked on a rate limit either.
- Do not pass `supersedeQueue: true` (or omit the option, which defaults to `true`) to `deliverRedirect`
  from `redirectWorkerForContextInterrupt` — a worker's queue holds its MANAGER's own direction, and this
  interrupt is daemon-originated, not the manager's own call; discarding it is a loss the manager never
  authorised.
- Do not use `listActiveMergeDangerWindows` (the manager interrupt's own repo-level check) as the
  worker-interrupt's gate predicate — use `hasLiveGateForSession` instead; the two guard different
  hazards and the repo-level one does not apply to a worker's own pty.
- Do not close the manual-`/compact` gap named above by adding a re-arm key to the Trigger C/D dedupe —
  it is an accepted, named gap, not a defect; closing it would reopen the per-turn re-arm cascade this
  record's dedupe section explains.
- Do not let `checkWorkerContextInterrupt` fire without also pushing the `[loom:worker-context-interrupt]`
  notice to the owning manager — the manager must learn about the interrupt directly, not only from the
  worker's own next report.
- Do not let `checkWorkerContextInterrupt` fire on a reading NOT measured during the current turn
  (`w.ctxUpdatedAt` must be strictly later than `w.lastActivity`) — a recovery turn (busy rising edge
  clearing exhaustion, no fresh sample yet) can carry a stale, still-over-floor reading from before the
  turn started.
- Do not reach for a per-turn re-arm key to "fix" the stale-reading rule above either — it is a ONE-TIME
  freshness check against `lastActivity`, not a dedupe key, and does not reopen the per-turn re-arm
  cascade `c5b234aa`/`9f279c7b` warn against (the "AT MOST ONCE EVER per session id" dedupe above is
  untouched).
- Do not reorder a worker-context interrupt via a flush/supersede (`deliverRedirect`'s step (a)) to fix
  ordering against queued manager direction — use `headInsert` instead; a flush would discard the
  manager's own direction, which `supersedeQueue:false` exists specifically to preserve.
- Do not read `hasLiveGateForSession`'s four underlying reads as redundant or removable — each covers a
  live state the others miss (cap-admitted, mid-squash, repo-guard-only, and a pre-admission/retained
  confirm call); removing any one reopens a real refusal gap this round closed.
- Do not call `ContextWatcher.checkContextExhaustion` (the MARKING method) from the worker loop — use
  `isWorkerContextExhaustedUnmarked` instead. `ContextWatcher` deterministically ticks before
  `BusyWorkerWatcher` (index.ts start order + equal-interval timer creation order), so the worker loop
  calling the marking method always wins the mark and starves `BusyWorkerWatcher`'s own
  `worker_context_exhausted` event/notice — the exact round-3 regression. The worker loop must stay
  READ-ONLY for exhaustion; `BusyWorkerWatcher` is the sole marker/notifier for a worker session.
- Do not trust Round 2's "this interrupt enqueues `kind:"warning"`, never `"agent"`" claim — it was wrong;
  it is `kind:"agent"` (`enqueueDurableMessage`'s `ctx.kind ?? "agent"` default). The ordering fix is sound
  anyway, for a different reason: see the Round 3 correction inline and `pty-head-insert.mjs` scenario E.
- Do not attempt a quick fix for the `coalesceAgentMessages:true` route-keyed-coalescing gap (Round 3,
  finding 4) by adding a condition inside `drainPending`'s route-keyed branch alone — `headInsert` is not
  a persisted `QueuedMessage` field (it lives only on the enqueue-time `EnqueueStdinTail` options object),
  so there is nothing on a drained entry to condition on without first adding and threading a new
  persisted field through every requeue/give-up-redrive/restart-carry path, the same scope as this file's
  `ownerTextSeq`/`mintedAtGen` fields. Scope that as its own change if it's ever worth doing — this toggle
  is off by default for every project today.
