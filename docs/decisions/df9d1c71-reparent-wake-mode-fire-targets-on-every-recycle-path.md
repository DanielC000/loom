# df9d1c71 — reparent wake-mode trigger/poll/webhook fire targets on every recycle path

## Do not

- Do not resolve the fire target's lineage head at fire time (option b) — reparenting the stored
  `target_session_id` alongside `reparentWakes`/`reparentQuestions` (option a) was chosen so the three
  mechanisms stay symmetric, with no second path to keep in sync.
- Do not add an MCP tool for trigger/poll/webhook targeting — they stay REST-only
  (`event-trigger-mcp-absence.mjs` asserts this); human-configured targets remain human-configured.
- Do not treat `recycleWorker`'s pre-spawn-failure catch as covered by this fix — it cancels wakes but
  leaves these targets live on the predecessor, deliberately, by cost not impossibility (see card
  `22a5a2d5`'s own record).
- Do not read "the running dist contains `reparentEventTriggerTargets`" as proof any trigger has
  actually fired through it — that proves the KIND of code is live, not that it has been exercised.

## Narrative

Found by Bugfix worker `b9d1b6e6` during card `5a56bb0a`'s reachability trace; lead-verified at source
(main `c2307efc`, 2026-09-11). A wake-mode `event_triggers`/`poll_jobs`/`webhook_endpoints` row stores a
fixed `target_session_id`, written only at REST create/update, with no reparent helper alongside the
existing `reparentLiveWorkers`/`reparentAllChildren`/`reparentWakes`/`reparentQuestions` in `db.ts`.
Nothing resolves the lineage at fire time either — `EventTriggerService.fire`, the worker-report poll
path, and webhook ingress all call `resume(trigger.targetSessionId)` verbatim. Once the targeted
manager/platform recycles, every fire calls `resume(predecessor)`, which `resume()` refuses
(`hasSuccessor`); the per-trigger catch swallows it and the trigger is dead for good while looking
enabled.

**Fix:** three new `db.ts` reparent helpers (mirroring `reparentWakes`/`reparentQuestions` exactly),
wired into EVERY recycle path that already carries wakes/questions — the live `recycle_me` settle
(`recycleWorker`/`recycleManager`/`recyclePlatformLead`), the boot-time
`reconcileStrandedRecycleSettlesEarly`, the deferred-fallback loop in
`finishReconcilingRecycleSettles`, and the fleet-return path `recoverFleetAfterFailedRecycleSuccessor`
(which reparents targets BACK to the predecessor, as wakes already do). A target aimed at a
non-recycled session is byte-identical in behavior. A table sweep by `CREATE TABLE` (not by code path)
confirmed exactly three tables hold a fire target (`event_triggers`/`webhook_endpoints`.
`target_session_id`, `poll_jobs`.`session_id`); `schedules` has no target column despite an earlier
design-note proposal, so nothing there was missed; `companion_*` tables are out of this card's
manager/worker/Lead recycle scope and were not examined.

Code Review `8007b68f` found one should-fix (the deferred-fallback reparent had no discriminating test —
closed before merge with scenario D', a RED control removing the 3 fix lines) and two pre-existing gaps,
carded separately (`22a5a2d5`: `recycleWorker`'s pre-spawn-failure catch; `5c409108`: a poll
snapshot-vs-fetch race).

Deployed via a bundled restart (2026-09-11, main `a27be516`) covering four runtime cards at once;
verified with a 2-leg control (build-identity leg, plus a before/after dist symbol-count check for all
four cards' new symbols, with a positive control confirming the grep instrument works and a negative
control on a removed symbol).

## Source

`packages/daemon/test/recycle-carries-wake-targets.mjs:234`, `@decision df9d1c71`. Merged `fb7fad1`.
Related: `5a56bb0a` (the sibling successor-side guard this was found while tracing), `22a5a2d5`,
`5c409108`, `59bfc939`, `ee05750e` (bundled in the same restart).
