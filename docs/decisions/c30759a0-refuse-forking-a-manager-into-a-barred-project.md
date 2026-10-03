# c30759a0 — refuse forking a manager session into a manager-barred project

Follow-up to `4b2e0146` (`docs/decisions/d25e4ea7-unify-reserved-and-operational-home-manager-predicates.md`
and the sibling `startNew`/`startManager`/`recycleManager`/`resume()` guards), found by Code Review
`70d926b8`. That card gated every manager fresh-spawn/recycle/resume chokepoint against
`managerSessionBarredFrom` (a project that is `reserved`, or whose `repoPath` resolves to `LOOM_HOME` or
an ancestor of it) — but `forkSession` (`sessions/service.ts`, human REST `/api/sessions/:id/fork`) was a
sibling spawn path it missed: a fork of a manager-role source keeps `role: "manager"` ("a forked manager
stays a manager", so it keeps its orchestration MCP surface), which mints a brand-new manager session row
exactly like a fresh spawn would — and had no `managerSessionBarredFrom` check at all. A manager session
whose project had been rebound to a barred path (after the manager started, so `startNew`/`startManager`
never saw it) could still be forked into a second live manager session there.

## Fix

`forkSession` now refuses, BEFORE any row is minted, when the source's resolved role is `"manager"` and
`managerSessionBarredFrom(project)` is true — mirroring `recycleManager`'s placement (right after the
project row is fetched, before `resolveConfig`/any state mutation) so the source session is left
completely untouched (still live, no fork row inserted at all). It throws the same
`MANAGER_SESSION_BARRED_ERROR` text as the other four chokepoints, and files the same durable
`manager_session_barred` event kind, with `detail.source: "fork"` (joining `"recycle"`/`"resume"`),
keyed on the SOURCE session's id (the session being forked, since that's the one that would otherwise go
on living with the hazard) and no `liveWorkerIds` (unlike `resume()`'s detail) — a fork of a manager
carries no worker lineage of its own to report.

Fork is human-only (REST, not an agent-callable tool), so this is not a regression any live agent could
trigger — it closes the same latent hazard class as `4b2e0146` for the one spawn path that case missed.

## Do not

- Do not key this check on anything but the SOURCE session's resolved `role` — a non-manager fork never
  needs it (it can't mint a role:"manager" row), and checking role-agnostically would wrongly refuse an
  ordinary worker/plain fork into a barred project (out of scope; no such hazard exists for a non-manager
  role, since only `role === "manager"` grants the orchestration MCP surface this guard protects).
- Do not place this check after `resolveConfig`/the engine-id pre-assignment/`db.insertSession` — it must
  run before ANY state mutation, exactly like `recycleManager`'s placement, so a refused fork leaves the
  source session provably untouched.
- Do not add `liveWorkerIds` to this event's detail — unlike `resume()`, a fork carries no worker lineage
  (`taskId`/`worktreePath`/`branch` are deliberately not carried onto a fork row), so there is nothing
  analogous to report.
- Do not re-derive `managerSessionBarredFrom`/`MANAGER_SESSION_BARRED_ERROR` separately here — both are
  already imported into `sessions/service.ts` for the sibling chokepoints; reuse them.
