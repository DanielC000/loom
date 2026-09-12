# 22a5a2d5 — a failed worker recycle leaves wake-mode event_trigger/poll_job/webhook_endpoint targets on the retired predecessor, by cost, not by impossibility

## Narrative

Code Reviewer `8007b68f` (finding F1 on card `df9d1c71`) traced an asymmetry in `recycleWorker`'s
pre-spawn-failure catch (`sessions/service.ts` ~`:10170-10270` on current main): the catch calls
`cancelWakesForSession(workerSessionId)` (@decision `08320d02`) but never calls the sibling
`reparentEventTriggerTargets`/`reparentPollJobTargets`/`reparentWebhookTargets` the SUCCESS path
calls right below it (`:10274-10279`, alongside `reparentWakes`). The catch unlinks `fresh`'s
`recycled_from` (`:10174`) and archives `fresh` (`:10181`) — it never touches `old` (`workerSessionId`).

**Consequence, traced at source:** after the catch, `db.hasSuccessor(old)` (`db.ts:5585`) reads
`false`, and `old` is never archived or marked `resumability:"dead"`. A wake-mode
`event_trigger`/`poll_job`/`webhook_endpoint` still targeting `old.id` would, on its next fire
(`event-triggers.ts:174-181`; `poll.ts`/webhook ingress mirror this), find `getSession(old)` present,
see `!pty.isAlive(old)`, and call `resume(old)`. `resume()` (`service.ts:2980`) refuses only on
`hasSuccessor` (false here) or the `recycle_successor_retired` marker — filed by a *different*
chokepoint for a *different* scenario, a dead recycle **successor**, not a recycle-failure's old
**predecessor** (@decision `5a56bb0a`) — so neither applies. `resume(old)` would structurally succeed
(same worktree, same transcript, nothing torn down here): the worker just retired comes back.

## Measurement (a cost decision, not a correctness one)

Queried a **copy** of the owner's real, self-hosted `LOOM_HOME` (`~/.loom/loom.db`, WAL included,
copied before any read; live file never opened) — independently reproduced by the manager against a
separate copy one session apart (5084/6023 vs 5085/6024 sessions — right direction, both reads live).

- `event_triggers`/`poll_jobs`/`webhook_endpoints`: **0 rows, unfiltered, all three** — confirmed
  present in `sqlite_master` (not a missing-table false zero); columns checked via `PRAGMA table_info`
  against the real `target_session_id`/`mode` (triggers, webhooks) / `session_id`/`mode` (poll_jobs).
- `recycle_begin`/`recycle_complete`: 724/724 — every recycle ran to completion. `recycle_failed`
  (this exact catch): **0** — it has never executed here.
- Positive control: `sessions WHERE role='worker'` → 5084 (5085 on re-read) — proves the query
  mechanism isn't silently vacuous.

**⛔ Does NOT prove:** these tables are empty because **this owner has never configured a
trigger/poll/webhook at all** — not because targeting a worker is refused or impossible. `loomctl`
ships to populations this can't reach; the precondition is live the moment anyone wires one row at a
worker. Honest claim: **"never exercised on the only measurable population,"** never **"cannot occur."**

## Decision — (d): leave the asymmetry, document it; do not build (a)/(b)/(c)

The failure needs a **compound** precondition — a human REST-wiring a wake-mode row to one specific
*ephemeral worker*, **and** that worker's recycle failing pre-spawn — measured 0/0 on both dimensions,
on the only reachable population. Rejected:

- **(a) disable + record why:** cheapest, mirrors the existing dead-target pattern
  (`event-triggers.ts:101-108`) — still needs 3-table wiring + a new event kind + a RED test, for zero
  measured occurrences.
- **(b) re-point to the manager:** silently overrides a human's explicit wiring with a guess.
- **(c) refuse at fire-time:** an extra check forever, with *worse* observability than (a) — no signal
  the row went dead.

Machinery for an unshown-to-occur case is its own cost; **cost**, not **impossibility**, is the basis.

## Do not

- Do not cite this record's zero-row measurement as proof a worker-targeted row can't exist — only that
  this one instance never configured one. See the bound above.
- Do not port the three `reparent*Targets` helpers into this catch as a "fix" without re-opening this
  decision — the gap is deliberate, not missed twice.
- Do not treat the success path's four reparent calls as a template this catch should follow — no live
  successor exists here to reparent onto (mirrors @decision `08320d02`'s reasoning for cancel-not-reparent).

## Source

`sessions/service.ts`: `recycleWorker`'s catch, anchored `@decision 22a5a2d5`. `db.ts`:
`reparentEventTriggerTargets`/`reparentPollJobTargets`/`reparentWebhookTargets`/`hasSuccessor`/
`cancelWakesForSession`. `orchestration/event-triggers.ts`: `fire`. Related: @decision `08320d02`
(the wake-cancel), @decision `5a56bb0a` (the sibling successor-side guard). Card `22a5a2d5`.
