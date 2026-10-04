# 9d73e537 — prune a shared skills manifest on CURRENT liveness, not resumability

## Narrative

`injectSkills` (`skills/inject.ts`) keeps a per-session manifest at a shared cwd (manager/platform/setup/
auditor/plain sessions sharing `project.repoPath`). A session's key never left that manifest once
written, so it grew without bound across every recycle generation, and a no-longer-relevant session's
claimed skill name lingered in `otherClaimed` forever — permanently defeating the "never clobber the
repo's own pre-existing skill" check for any name a session that's since gone idle ever touched.

The first fix pruned a manifest key when the caller-injected predicate reported
`resumability !== "dead"`. Code Review round 2 caught this as under-pruning: an exited-but-resumable row
(the ordinary steady state of a stopped worker/plain session — `processState:"exited"`, `archivedAt`
set, `resumability` still `"resumable"`) keeps that value forever — nothing flips it except
`sweepDeadSessions`/the recycle-retirement path setting `"dead"`. Most of the real-world growth this card
exists to stop would have survived unpruned.

The predicate (renamed `isSessionLive`) is now keyed on `processState ∈ {"live", "starting"}` instead,
read via `db.getSession(id)`. Pruning an exited-but-resumable session's claim is safe: `injectSkills` runs
on EVERY `createPty` (fresh/resume/fork/recycle), so a session that's later actually resumed re-claims its
own skills at that moment — nothing is lost between resumes but regenerable bookkeeping.

DB `process_state`, not PtyHost's own `live`/`liveCodex` maps, is the reliable source for a sibling
session that's mid-spawn. `sessions/service.ts` flips every spawn path's row to `processState:"live"`
BEFORE wiring the pty (the load-bearing "flip before `pty.spawn`" invariant `live-flip-reconcile-
guard.mjs` polices), and `spawn()` runs synchronously end-to-end with no `await` before `createPty` — so
two sessions' spawns can never interleave mid-flip, and by the time ANY sibling's own `createPty`/
`injectSkills` call could observe a row, a session that is itself mid-spawn already reads `"live"` in the
DB. `PtyHost.live`/`liveCodex`, by contrast, only gain an entry via `this.live.set(...)` AFTER `createPty`
returns — i.e. after `injectSkills` has already run for that session — so consulting the live map instead
would misclassify a sibling that is itself still inside its own `createPty` call as not-yet-live.
`"starting"` is included defensively for the brief insertSession-to-flip window, even though that window
is synchronous and unobservable cross-session today.

## Do not

- Do not revert to `resumability !== "dead"` (or any other resumability-keyed check) for this predicate —
  it was tried and demonstrably under-prunes the common exited-but-resumable case; see the test's section
  (0) in `packages/daemon/test/skills-manifest-prune-dead-sessions.mjs` for the RED proof.
- Do not source "is this session live" from `PtyHost.live`/`liveCodex` for this predicate — those maps are
  populated only AFTER `createPty` returns, so they read a sibling mid-spawn as not-yet-live when the DB
  already correctly reads it as live.
- Do not drop `"starting"` from the live-state check to simplify to `processState === "live"` alone — kept
  as a defensive margin for the insertSession-to-flip window.
- Do not let `inject.ts` import the DB directly to implement this check inline — the predicate stays an
  OPTIONAL callback injected by the caller (wired through `PtyHost` from `index.ts`, mirroring
  `getCapabilityCatalog`/`getOtherProjects`), so every existing hermetic test (no predicate passed)
  behaves byte-identically (no pruning at all).

## Source

`packages/daemon/src/skills/inject.ts` (`injectSkills`'s `isSessionLive` param), `packages/daemon/src/
pty/host.ts` (`PtyHost.isSessionLive` field + wiring), `packages/daemon/src/index.ts` (the real
predicate) — card `9d73e537`, round 2 per Code Review.
