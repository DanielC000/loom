# 5439b7d2 — boot-reconcile's protected-worktree set also folds in fleet-wide crash-recovery-eligible sessions

## Narrative

The card's original premise — boot Pass B's protected set omits sessions orphaned by THIS boot's own
crash — did NOT reproduce. `index.ts` already derives `crashOrphanedWorkers`/`crashOrphanedManagers` via
`deriveCrashOrphanedWorkers`/`deriveCrashOrphanedManagers` (`orchestration/crash-orphaned-workers.ts`,
scoped to whatever `db.recoverStaleSessions()` just flipped from live/starting to exited) and folds their
ids into `protectedSessionIds` *before* `SessionService.reconcileOrchestrationOnBoot` runs — exactly the
mechanism `CLAUDE.md`'s self-hosting section already describes. Card `9ac3a739`'s own decision record had
already flagged that its Pass-A fix didn't absorb this card, and explicitly left the real gap as a
separate investigation.

The real gap is narrower and lives elsewhere: the ONGOING crash-recovery watchdog
(`orchestration/crash-recovery-watcher.ts`) recovers a session whose pty died unexpectedly while a *prior*
daemon instance was otherwise healthy (`recordUnexpectedExit` — fires only for an unintended exit, AFTER
the row is already `process_state='exited'`; a whole-daemon crash/restart is excluded by construction).
If that daemon then itself crashes/restarts before the watchdog's own `setInterval` (no immediate tick —
first fire only after `intervalMs`, armed late in boot at `crashRecoveryWatcher.start()`, well after Pass
A/B already ran at `reconcileOrchestrationOnBoot`) gets a chance to resume it, the session is invisible to
`deriveCrashOrphanedWorkers` at the next boot: `recoverStaleSessions()` only touches rows that were
`live`/`starting` at the instant of THIS crash, and this session was already `exited` from the prior
instance. Its row still carries an unresolved `session_died`/`worker_report_undelivered` trigger,
`resumability !== 'dead'` (nothing stamps it dead on an ordinary exit), and a non-terminal task — the
watchdog will still try to resume it on its own next tick. But boot-reconcile's `protectedWorktreePaths`
(`protectedSessionIds.has(s.id) || isLive`) never heard about it, so if its worktree happens to hold no
commits-ahead and no dirty files (`worktreeHasWork` returns false — e.g. it died right after spawn, before
any edit), Pass B GCs the directory before the watchdog ever gets there.

## Fix

Added `listCrashRecoveryEligibleSessionIds(db, control)` in `orchestration/crash-recovery-watcher.ts`: it
reuses the watchdog tick's own candidate query (`db.listWorkerSessionIdsWithEventKind` over
`RECOVERY_TRIGGER_KINDS`) and the existing exported `isCrashRecoveryEligible` predicate (already reused
once outside the watchdog, by `SessionService.notifyManagerOfExitedWorker`) — no second eligibility
definition. `index.ts` calls it, wrapped in a try/catch that logs and falls back to an empty result (never
aborts boot reconcile), and folds the returned ids into `protectedSessionIds` alongside the existing
restart-intent/crash-orphaned-worker ids, before `reconcileOrchestrationOnBoot` is invoked. Pure DB + an
in-memory `control.isPaused` read per candidate — no git/fs/network call anywhere in the path; the
candidate set is normally a handful of ids (sessions that ever recorded a trigger event), not a fleet-wide
scan.

This is PROTECTION ONLY: the new helper never resumes or mutates anything — it only widens the set of
worktree paths Pass A/B treat as off-limits for this boot.

### Residual: a protected-but-never-recovered worktree is kept until eligibility lapses

A worktree protected this way is NOT guaranteed to ever actually get resumed — the watchdog's own tick
still independently decides whether/when to call `resume()`. A worktree protected on one boot stays
protected on every SUBSEQUENT boot too, for as long as `isCrashRecoveryEligible` keeps returning true for
that session, which lapses only when one of: (a) the watchdog successfully resumes it and the session
stays live past its stability window (`session_recovered` is recorded, but by then it's `isLive` anyway,
not dependent on this helper); (b) the watchdog exhausts `crashRecoveryMaxAttempts` for that episode
(`session_resume_attempt` count reaches the project's cap — the watchdog then stops trying and escalates
via `session_recovery_abandoned`, but does NOT itself clear the trigger, so `isCrashRecoveryEligible`
still returns false only because `attempts >= maxAttempts`, which keeps it UNPROTECTED on the next boot,
letting Pass B finally reclaim it); (c) the session gets recycled/superseded (`isSupersededByRecycle`
starts returning true); (d) a human/manager stops recovery some other way that flips `resumability` to
`dead` or the engine id is cleared; or (e) a human pauses it (`control.isPaused`). Until one of those
happens, a worktree with no commits/edits whose owning session is mid-crash-recovery-episode will keep
surviving boot after boot even though it holds no actual work — an accepted trade (bounded by the same
`crashRecoveryMaxAttempts` cap that already bounds the watchdog itself), not a leak, since case (b) is
exactly what eventually lets Pass B reclaim it.

## Do not

- Do not refactor the watchdog tick's own resume-gating loop to call `listCrashRecoveryEligibleSessionIds`
  or `isCrashRecoveryEligible` in place of its own `lastTrigger`/`lastRecovered` POSITION comparison — that
  comparison is deliberately stricter (card bcdea586, same-ms-tie correctness for the actual resume
  decision); `isCrashRecoveryEligible`'s plain `.ts` comparison is lenient on a tie by design, which is the
  conservative direction for a PROTECTION decision but the wrong direction for gating a real resume.
- Do not let a throw from `listCrashRecoveryEligibleSessionIds` (or anything it calls) abort or block boot
  reconcile — the caller must catch, log, and fall back to the protected set as it exists without this
  helper's contribution.
- Do not expand this helper to resume, mutate session rows, or append events — it is a read-only
  protection-set contributor; the watchdog's own tick remains the only place that actually resumes a
  crash-recovery-eligible session.
