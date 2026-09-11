# 5a56bb0a — `resume()` refuses an automatic resume of a retired recycle successor

## Narrative

Follow-up to `08c81809`'s "Accepted, narrow residuals": `resume()` checked `hasSuccessor` but never `resumability`/`archivedAt` for an AUTOMATIC caller, and unconditionally un-archived any row it resumed. `08c81809` fixed the ONE producer it introduced (a retired recycle successor resurrected on boot, guarded by the in-process-only `retiredRecycleSuccessorIds` field) — this card closes the STRUCTURAL gap: `PollWatcher.fire`, `EventTriggerService.fire`, and webhook ingress's `fireWebhookTarget` (none reparent a manager/platform's own `target_session_id` off it on recycle) could still resurrect a retired successor for the daemon's whole remaining life. `WakeService.tick` does NOT reach this — see Reachability.

## Round 1 — why not a bare `resumability`/`archivedAt` leg

`archivedAt != null` alone is wrong: `archiveOnExit` archives EVERY exited non-`run` session — the NORMAL state of every stopped session. A bare `resumability === "dead"` stamp can be STALE — `deriveCrashOrphanedWorkers` self-heals exactly that case. `unlinkAndArchiveDeadRecycleSuccessor` stamps a row dead+archived for a POLICY reason with a transcript/cwd that stay valid — indistinguishable from a stale stamp by re-derivation.

## Round 1's fix, and why Code Review rejected it (B1)

Round 1 shipped `resumability==="dead"` AND `archivedAt!=null` AND the marker (below), all three required. Code Review B1 reproduced an end-to-end bypass: the Archive UI's "Restore (view-only)" (`restoreSession`'s `dead` branch) clears `archivedAt` but never touches `resumability` — one view-only restore + one trigger fire resurrected the retired successor next to its live predecessor, and the self-heal then made the escape permanent.

## The fix — refuse on the marker ALONE

`resume()`'s chokepoint (next to `hasSuccessor`) refuses whenever the `recycle_successor_retired` `OrchestrationEventKind` exists for this id, gated on `!opts.allowSuperseded` — no `resumability`/`archivedAt` leg. The marker is filed by exactly ONE chokepoint (`unlinkAndArchiveDeadRecycleSuccessor`), for exactly one reason — it cannot go stale like a bare stamp, so nothing else need agree. Mirrors `hasSuccessor` itself: that guard never self-heals either — a human-forced recycled predecessor stays refused on every later automatic resume, because the predecessor owns the fleet. A retired successor now behaves identically: `allowSuperseded` is a ONE-TIME override, never a permanent lift. `resumability` still self-heals to `"resumable"` on a successful spawn (fixes a latent worktree-GC `isLive` hazard, Code Review M3) — but a marker-only guard means that self-heal can no longer lift a retirement.

`Db.hasWorkerEventKind(id, kind)` is a new indexed point-scoped existence check (seeks `idx_orch_events_kind`), unlike the fleet-wide `listWorkerSessionIdsWithEventKind`. `Db.archiveDeadRecycleSuccessor(id, event)` wraps the dead stamp, archive, and marker write in ONE `db.transaction` (M4) — a hard kill between them would otherwise leave a dead+archived row with no marker: unrefusable here, and never retried.

## Do not

- Do not refuse on `archivedAt != null` alone (normal state of every stopped session) or a bare `resumability === "dead"` stamp alone (can be stale).
- Do not re-add a `resumability`/`archivedAt` leg alongside the marker — B1: the view-only Restore clears `archivedAt` without touching `resumability`, defeating any conjunction requiring either.
- Do not let `allowSuperseded` lift the retirement permanently — one-time only; the marker is never cleared, so the row is refused again on its NEXT ordinary exit.
- Do not add a new `Resumability` value for this — `"dead"` is keyed on too widely (crash-recovery watcher, `restoreSession`, `sessionOrphaned`, worktree-GC, the UI) for an unnecessary ripple.
- Do not key the marker off `lastError` text — fragile.
- Do not add `recycle_successor_retired` to `EVENT_TRIGGER_EVENT_KINDS`/`GATE_HISTORY_KINDS`/`REPORT_RESOLVED_EVENT_KINDS` — mirrors siblings `recycle_fleet_recovered`/`recycle_failed`, neither a member.
- Do not file the marker at either CALLER site instead of the shared chokepoint — the boot-reconcile caller's `stampStranded` fallthrough never fires its own `recycle_fleet_recovered` for the retired successor.

## Reachability (verified, not assumed)

Wakes/Questions are NOT reachable: `reparentWakes`/`reparentQuestions` run either in the early DB-only boot phase BEFORE the row is dead-marked, or synchronously right after `unlinkAndArchiveDeadRecycleSuccessor` live, with no `await` gap for a watcher tick. Poll/trigger/webhook ARE reachable: no reparent helper exists for any of their `target_session_id`s, and target validation imposes no role restriction. That non-reparenting gap is separate and already-carded (it also strands a trigger against an ordinary recycled predecessor, refused by `hasSuccessor`); this fix makes the retired-successor case REFUSE instead of resurrect, not fix the gap itself.

## Source

`sessions/service.ts`: `resume()`'s chokepoint + self-heal, `unlinkAndArchiveDeadRecycleSuccessor`. `db.ts`: `hasWorkerEventKind`, `archiveDeadRecycleSuccessor`. `shared/src/types.ts`: `recycle_successor_retired`. Test: `resume-refuses-retired-recycle-successor.mjs` — a real `EventTriggerService.fire` driving the real `resume()`, genuinely-intact transcript+cwd, the B1 bypass reproduced and refused, a positive control (ordinary archived manager still resumed), and the one-time-override trace.
