# 63edeb55 — crash-recovery must not treat a refused second-live-manager resume as a crash loop

## Context

Card af165ec7 made `resume()` structurally refuse a manager whose agent already has a different live
manager (`SecondLiveManagerError`, naming the holder session), except for the one sanctioned halted
recycle-partner case. The crash-recovery watcher (`orchestration/crash-recovery-watcher.ts`) did not know
about this refusal: it treated every `resume()` failure identically, burning a crash-loop attempt each
tick. Once `crashRecoveryMaxAttempts` was reached it escalated with `session_recovery_abandoned` and a
`[loom:crash-loop] ... died N× after auto-resume ... fix the cause` banner on the session's `lastError`.
That escalation is false: the session never died N times — a structural guard refused the SAME resume
attempt, every tick, for as long as the other live manager holds the agent.

## Fix

`SessionService.findSupersedingLiveManager(sessionId)` reuses `refuseSecondLiveManagerUnlessHaltedPartner`
itself (catching the exact `SecondLiveManagerError` `resume()` would throw) to answer "would resume() be
refused for this reason right now", returning the holder's session id or `null`. The watcher's tick loop
calls this (via the optional `CrashRecoveryDeps.findSupersedingLiveManager` injection) for a `manager`-role
candidate, BEFORE the `session_resume_attempt` event is filed, and skips silently when a holder is
returned — the same "not actually a resume candidate right now" posture already used for
`isSupersededByRecycle` immediately above it in the loop, not a resume failure to bound. The moment the
holder stops superseding (exits, or is reconciled into the sanctioned halted-partner exemption), the next
tick's check returns `null` and the session falls through to a normal resume attempt.

## Do not

- Do not treat this refusal like any other resume failure — it is structural, not a crash: do not file a
  `session_resume_attempt` event or count it toward `crashRecoveryMaxAttempts` for this specific reason.
- Do not re-derive "is this session superseded by a second live manager" with a second, independent
  predicate — always go through `findSupersedingLiveManager`, which is a thin catch around
  `refuseSecondLiveManagerUnlessHaltedPartner` itself, so the two can never drift apart.
- Do not widen this skip beyond `role === "manager"` — `SecondLiveManagerError` is only ever thrown for a
  manager resume; a worker/assistant/operator resume failure must keep the pre-existing accounting.
- Do not make `findSupersedingLiveManager` a required dependency — it is optional on
  `CrashRecoveryDeps` precisely so a hermetic test double that omits it keeps the pre-card-63edeb55
  behavior (resume attempted, any throw — including `SecondLiveManagerError` — handled generically).
