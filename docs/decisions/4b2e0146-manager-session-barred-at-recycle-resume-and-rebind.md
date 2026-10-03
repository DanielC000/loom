# 4b2e0146 — apply the manager-start bar at recycleManager, resume(), and checkRepoRebind

## Background

`d25e4ea7` unified the reserved-project / operational-home predicates behind `managerSessionBarredFrom`
and wired it into the session-start chokepoint (`refuseManagerIntoReservedHome`, called from
`startNew`/`startManager`) — but left three gaps, traced at source during this card's own Code Review
follow-up (`6fff4ba4`):

- `recycleManager` (`sessions/service.ts`) never consulted it — a manager could recycle a fresh successor
  into a project that had since become barred (e.g. a `repoPath` rebind) even though a FRESH `startManager`
  against that same project would already be refused.
- `resume()` (`sessions/service.ts`) never consulted it either — EVERY automatic resume caller (boot
  `resumeFleetOnBoot`, wake, rate-limit, crash-recovery, companion revive) funnels through this one method,
  so the same stranded-row hazard `37e15c26`/`d25e4ea7` meant to close was reachable through resume instead
  of a fresh spawn.
- `checkRepoRebind` (`projects/rebind.ts`) — the shared guard for both the Platform Lead's `project_update`
  and the human REST PATCH — only ever refused rebinding a RESERVED project (`d25e4ea7`'s gate 0). It had
  no check at all for the "under-protection" direction `d25e4ea7` deliberately left open: an ORDINARY
  project rebound TO a reserved/operational-home path while it already has a LIVE MANAGER running there.
  Its only live-session guard, `checkLiveWorktreeSessions`, is SQL-scoped to `worktree_path IS NOT NULL` —
  a manager has no worktree, so it structurally never appeared in that query.

## Fix

- `recycleManager`: refuse via `managerSessionBarredFrom(project)`, thrown as `MANAGER_SESSION_BARRED_ERROR`,
  immediately after resolving `project` — BEFORE any teardown/insert (same early-throw placement the
  blank-continuation and `hasSuccessor` guards already use in this method), so a refusal leaves the
  predecessor completely untouched (still live, no successor row minted at all). Files a durable
  `manager_session_barred` event (`detail: {source:"recycle", projectId, repoPath, reserved}`) under the
  predecessor's own id — `recycle_me`'s existing `catch` already returns `{error: e.message}` to the live
  caller in the same turn; the durable event is the backstop for visibility beyond that one turn (a human/
  Platform Lead reading the session's event history, or the predecessor never getting a further turn to
  relay it, e.g. because it was trying to recycle for being near its own context limit).
- `resume()`: the SAME check, for `session.role === "manager"`, placed immediately after the project
  lookup (before `config = resolveConfig(...)`, before any state mutation) — the earliest point `project`
  is available. Files the same `manager_session_barred` event (`detail.source:"resume"`), additionally
  carrying `liveWorkerIds` — the refused manager's own live-at-call-time worker sessions
  (`db.listWorkers(session.id).filter(w => w.processState === "live")`) — since `resume()` cannot itself
  stop or reparent them; they are left exactly as found. No `allowSuperseded`-style override: unlike
  `checkRepoRebind`'s reserved-rebind gate, there is no legitimate case for resuming a manager-role session
  into a barred cwd, mirroring `refuseManagerIntoReservedHome`'s own unconditional posture at
  `startNew`/`startManager`.
- `checkRepoRebind`: a new gate (2), between the existing `isGitRepo` check and the live-worktree-session
  check, using `managerSessionBarredFrom({reserved: project.reserved, repoPath})` against the REQUESTED
  target path + `db.listLiveManagersInProject(projectId)`. Refuses, naming the live manager session(s)
  (mirrors `checkLiveWorktreeSessions`'s own `liveSessions` shape), ONLY while the project has ≥1 live
  manager AND the target would bar one. UNCONDITIONAL — no `humanAuthorized` override (same structural-
  safety posture as the live-worktree gate, not a permission check).
- `OrchestrationEventKind` gains `"manager_session_barred"` (`packages/shared/src/types.ts`), filed per
  refused session (never batched), mirroring `manager_crash_resume_failed`'s per-manager filing posture.

## Boot-resume disclosure (resumeFleetOnBoot)

Deliberately did NOT touch `resumeFleetOnBoot`'s generic `captureFailureDetail`/`fleet_resume_failed`
plumbing. `resume()`'s own thrown `Error` already flows through `normalizeResumeOneResult(resumeOne(...))`
exactly like every other resume refusal reason (dead transcript, missing cwd) — captured in
`failed`/`failedDetail`, and (when the overall fleet resume isn't clean) surfaced via the pre-existing
`fleet_resume_failed` aggregate event + a live Platform Lead nudge. **Round 2 correction (Code Review
`70d926b8`): this chain was broken on ship** — `RESUME_KNOWN_SAFE_REASONS` (orchestration/resume-nudge.ts)
didn't list `MANAGER_SESSION_BARRED_ERROR`, so `normalizeResumeOneResult` silently rewrote it to
`RESUME_UNKNOWN_REASON_FALLBACK` ("unexpected error during resume") everywhere that reason reached a
human/agent surface — `fleet_resume_failed`'s own `detail`, the Lead's `[loom:fleet-resume-failure]` nudge,
and `manager_crash_resume_failed`. Fixed by adding it to the allowlist. The NEW `manager_session_barred`
event (filed by `resume()` itself, independent of the caller) is the durable, per-session record; the
existing fleet-wide machinery is the existing "something in the fleet failed to resume, and why"
disclosure — now actually carrying the real reason instead of the generic fallback.

**Pre-existing gap, not closed by either round: a barred `daemon_restart` REQUESTER gets only the
per-session event.** `resumeFleetOnBoot`'s requester-specific tail (sessions/service.ts, the final block
after the main per-entry loop) only computes/files `fleet_resume_failed` and the Lead nudge INSIDE the
branch where `resumeOne(reqId)` SUCCEEDED (so it can report on the REST of the fleet to the now-live
requester). When the requester's OWN resume fails — for any reason, `manager_session_barred` included —
execution falls to the bare `else { failed.push(reqId); }`: no `fleet_resume_failed` event, no Lead nudge,
no requester nudge (it isn't live to receive one). The only trace is the daemon's own `[boot] ... N
unresumable (skipped)` console log (host-local, not durable/agent-visible) and `resume()`'s own
per-session `manager_session_barred` event. This is pre-existing behavior for ANY requester resume
failure at this chokepoint, not a new hazard either card introduces — flagged here, not fixed, since
closing it is a broader change to the requester-tail's control flow.

## Why no automatic worker reparenting at boot

`recoverCrashOrphanedWorkers` (the CRASH, no-`RestartIntent` boot branch) resumes a manager BEFORE its
workers and, on a manager resume failure, never attempts its workers at all (`b65d9a5e`'s own "Do not":
"an un-archived worker with no live manager is an orphan nothing will notice") — so a `manager_session_barred`
refusal there correctly leaves the manager's workers un-resumed/resumable, discoverable via the existing
`manager_crash_resume_failed` event's own `workers` detail. Nothing needed changing there.

`resumeFleetOnBoot` (the graceful-RESTART, `RestartIntent`-present boot branch) resumes every entry FLAT,
in unspecified order, independent of its parent's own resume outcome — a worker entry resumes regardless of
whether its manager entry in the same batch failed. This is PRE-EXISTING behavior for ANY manager resume
failure at that chokepoint (dead transcript, missing cwd, now also `manager_session_barred`) — not a new
hazard this card introduces. `resume()`'s own `liveWorkerIds` detail (see above) is this card's answer for
that path: it cannot stop/reparent those workers itself, so it names them in the durable event instead.

## Audited: no currently-live-or-resumable manager is retroactively affected

Before shipping, a READ-ONLY audit of a copy of the real `loom.db` (per project memory
`a-db-copy-still-points-at-real-repos` — read-only `Db` queries only, never booted, copy deleted after)
computed `managerSessionBarredFrom` for every non-archived project with a non-archived manager session:
0 of 30 non-archived projects / 7 non-archived manager sessions were flagged. No owner-visible behaviour
change on ship.

## Do not

- Do not re-derive `project.reserved`/`isLoomHomeOrAncestor(repoPath)` separately at any of these three
  call sites — call `managerSessionBarredFrom` (same rule `d25e4ea7` already states).
- Do not add a `humanAuthorized`-style override to the `resume()` or `recycleManager` refusal — there is no
  legitimate case for a manager session running in a barred project, unlike `checkRepoRebind`'s gate (0)
  (reserved-project rebind), which IS a permission the Platform Lead's own surface can lack.
- Do not fold `checkRepoRebind`'s new gate (2) into gate (0) — gate (0) is about the project's OWN
  `reserved` flag at rebind time; gate (2) is about a LIVE MANAGER already running when the rebind target
  would newly bar one. They're independent conditions with independent (and differently-scoped) refusals.
- Do not read `checkRepoRebind`'s new gate as closing the "under-protection" direction broadly — it only
  blocks a rebind while a live manager exists. An ordinary project with NO live manager can still be bound
  to a barred `repoPath` (unchanged, deliberate per `d25e4ea7`'s own "Do not" — out of scope for both cards).
- Do not assume a hermetic test's "ordinary" project fixture is safe merely because it doesn't literally
  say `reserved:true` — see project memory `ordinary-project-fixture-loomhome-alias-trap`: a `repoPath`
  that equals `LOOM_HOME`/`os.tmpdir()`-as-ancestor is just as barred. Several pre-existing fixtures
  (`owner-message-park-disposition.mjs`, `peer-message-*.mjs`, `recycle-pending-carry.mjs`,
  `recycle-purges-stale-context-nudge.mjs`, `scheduler-recycle-carry.mjs`, `paste-recovery-boundary-carry.mjs`,
  `transcript-root-deny-spawn-paths.mjs`) hit exactly this once `recycleManager`/`resume` started consulting
  the predicate; each was repaired to use a genuinely-ordinary path instead of silently widening the guard
  to tolerate them.
