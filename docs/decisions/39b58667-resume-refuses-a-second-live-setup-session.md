# 39b58667 — `resume()` refuses to mint a second LIVE setup session; the verification is VERIFIED pty liveness, never the raw DB flag

## Narrative

Card `15806f81` closed the singleton gap (decision `ad131671`) for `forkSession`. `resume()` had the
same gap: resuming an EXITED "setup" row while a sibling "setup" row for the same agent is genuinely
live also minted a second live setup session, reachable via the human `/resume` REST route
(`allowSuperseded`), the Archive→Restore REST route, and — the hard case — the daemon's own
fleet-wide boot resume after a deliberate `daemon_restart`.

### Why the check is keyed on VERIFIED `pty.isAlive`, never the raw DB "live" flag

**Round 2 correction:** the original text here claimed every pre-restart-live session is still
DB-flagged `processState:"live"` at the moment its own `resume()` call runs during boot. That is FALSE.
`runBootRecoveryPrefix` (`index.ts` ~309) calls `db.recoverStaleSessions()` (`db.ts:6034-6043`)
unconditionally and FIRST — before `PtyHost`/`SessionService` even exist (`index.ts` ~321) and long
before `resumeFleetOnBoot` is ever invoked (`index.ts` ~1519) — flipping every `live`/`starting` row,
including both duplicate setup rows, straight to `exited`. By the time the per-entry loop starts,
neither stale-live setup row is DB-"live" at all.

The real reason order matters: `liveFleetResumeSet` (`service.ts:5492`) captures the fleet — BOTH setup
rows — as live BEFORE the restart (capture-before-flip: the capture runs pre-exit, `recoverStaleSessions`
runs post-boot, so the flip always lands after the capture it will later be replayed against).
`resumeFleetOnBoot`'s entries loop (`service.ts` ~5889) then processes that captured list
synchronously, one entry at a time, in a FLAT, unspecified order (decision `6d6b1b7b`). Resuming the
FIRST of the two setup entries calls `resume()`, which flips ITS OWN row to genuinely DB-"live" and
spawns its real pty (`resume()`'s M5 ordering, `service.ts` ~3850-3851: `setProcessState(id, "live")`
runs, then `pty.spawn`) — all within this SAME loop, before the SECOND setup entry is even reached. So
when the second is processed, its sibling genuinely IS DB-live: that is CURRENT truth this boot just
produced moments earlier, never a leftover stale flag from before the crash.

Keying the check on verified `pty.isAlive` instead of the raw DB flag still matters, for a narrower
reason than "staleness": the M5 ordering writes `setProcessState(id, "live")` BEFORE `pty.spawn` actually
runs, so a fast-failing spawn's `onExit` is what flips it back to `exited` — a brief phantom-live window
where the DB flag says "live" but the pty has not (or will never) actually come up. The DB flag can
disagree with real pty liveness this way — a phantom-live row, or (as above) a sibling row genuinely
flipped live by an EARLIER `resume()` call in the SAME boot loop — so verified liveness is the
authority, never the raw flag, in every caller alike. This needs **no per-caller carve-out** — once a
row's own resume has genuinely settled, the DB flag and `pty.isAlive` agree again, so the same
unconditional check is correct for the REST route, the Archive-restore route, and every automatic/boot
path alike.

### Why the lookup is `liveSetupSessions` (plural, ALL matches), never `liveSetupSession` (singular, first-by-recency)

`liveSetupSession` (the pre-existing helper `startSetup`/`forkSession` use) is `db.liveSessions(agentId)
.find(s => s.role === "setup")` — ordered by `last_activity` DESC, returning only the FIRST match. A
self-exclusion check built on that single match is unsound with two stale-live rows A (more recently
active) and B (less recently active), processed boot-order B-then-A:

- `resume(B)`: the `.find()` match is always A (more recent, regardless of which row is being resumed).
  A ≠ B, and `pty.isAlive(A)` is false (A hasn't been resumed yet) → B resumes fine, becomes genuinely alive.
- `resume(A)`: the `.find()` match is now A **itself** (still the most-recent) → excluded by the
  self-check → the function never even looks at B → A ALSO resumes → **two live rows**, the exact bug
  this card exists to close.

So the check must look PAST the first match. `liveSetupSession` was split into a plural
`liveSetupSessions` (the real lookup — `db.liveSessions(agentId).filter(role==="setup")`, ALL matches)
with `liveSetupSession` becoming a thin, behavior-UNCHANGED wrapper (`liveSetupSessions(agentId)[0]`) —
`startSetup`/`forkSession` keep calling the singular form exactly as before; `resume()`'s refusal
consumes the plural form directly and finds any sibling OTHER than itself that is verifiably alive.

### No `allowSuperseded` bypass

Unconditional, mirroring `SETUP_SESSION_FORK_BARRED_ERROR`'s shape (fork has no override either) —
there is no legitimate reason to want two live setup sessions simultaneously, unlike the
recycle-superseded carve-out (which exists to deliberately inspect a retired predecessor, a different
situation).

### Idempotency of resuming the SAME row

Unchanged, and needed no new code: the pre-existing `if (this.pty.isAlive(session.id)) return session;`
short-circuit at the very top of `resume()` runs before the new check, so re-resuming an already-live
row never reaches it.

### Why `recoverCrashOrphanedWorkers` (the crash-path boot loop) needed NO change

Traced both boot loops per the kickoff's instruction. `resumeFleetOnBoot` (the deliberate
`daemon_restart` path) resumes its ENTIRE captured fleet regardless of role — a setup session can be a
member of that flat `entries` loop. `recoverCrashOrphanedWorkers` (the genuine-crash path) cannot ever
reach a setup session: its candidate derivation (`deriveCrashOrphanedWorkers`/`deriveCrashOrphanedManagers`,
`orchestration/crash-orphaned-workers.ts`) is hard-filtered to `role === "worker"` and
`role === "manager" || role === "platform"`; `recoverStaleSessions()` (which runs first, at boot,
role-agnostically) just flips every stale-live row — including any duplicate setup rows — straight to
`exited`, with no resume attempt at all; and the separate `CrashRecoveryWatcher` explicitly excludes
`setup` from its own `RECOVERABLE_ROLE_MAP`. So after a genuine crash, a duplicate setup pair is simply
left `exited` by the blanket reconcile — no automatic path ever attempts to resume either one, and the
new refusal has nothing to intercept there. Confirmed by reading all three mechanisms directly, not
assumed from the kickoff's framing.

### Why the collapse must not read as a fleet-resume failure

`resumeFleetOnBoot`'s per-entry loop pushes any `resumeOne` failure into `failed`/`failedDetail`
unconditionally, which (if `failed.length > 0`) files the aggregate `fleet_resume_failed` event —
unconditionally mapped by `attention-push.ts`'s `classify()` to the `"worker-crashed"` alert class (no
`resumeFailed`-style discriminator on that aggregate kind, unlike its per-entry sibling
`fleet_resume_entry_failed`). A setup-singleton collapse is expected, benign housekeeping — exactly one
of the two rows surviving IS the correct, intended outcome, not a crash — so it must never reach that
bucket. The per-entry loop intercepts the RAW `resumeOne` result (before `normalizeResumeOneResult`
would otherwise sanitize this specific, known-safe reason down to `RESUME_UNKNOWN_REASON_FALLBACK`,
defeating the match) when `e.role === "setup"` and the raw reason is exactly
`SETUP_SESSION_RESUME_BARRED_ERROR`: it is tracked in a new `setupResumeSuperseded` bucket instead of
`failed`, and files one informational `setup_resume_superseded` event naming BOTH session ids (the
superseded loser under its own id, and the surviving winner re-derived via the same
`liveSetupSessions`+`pty.isAlive` check, as `detail.supersededBy`).

### Which of the two stale-live rows survives is order-dependent — accepted

`resumeFleetOnBoot`'s entries loop runs in unspecified order (decision `6d6b1b7b`), so which of two
stale-live setup rows for one agent happens to resume first — and therefore wins — is not deterministic
across restarts. This is accepted, not a gap to close: both rows are the same agent's Setup operator,
so either surviving is equally correct: there is nothing to distinguish them by.

## Do not

- Do not key the setup-singleton resume refusal on the raw DB `processState === "live"` flag — it can
  briefly disagree with real pty liveness (a phantom-live row from `resume()`'s own M5
  write-before-spawn ordering, or a sibling row genuinely flipped live moments earlier by an EARLIER
  `resume()` call in the SAME boot loop, never a leftover pre-crash staleness — `recoverStaleSessions`
  has already flipped every captured entry to `exited` before the loop starts); key it on verified
  `pty.isAlive`, which is what makes the check correct with no per-caller carve-out.
- Do not add an `allowSuperseded` bypass to this refusal — there is no legitimate case for two live
  setup sessions, unlike the recycle-superseded carve-out.
- Do not build this check (or any future one needing "any OTHER live sibling") on `liveSetupSession`
  (singular) — it returns only the first match BY RECENCY, which can mask a genuinely-live OTHER row
  exactly when resuming the recency-first one. Use `liveSetupSessions` (plural, all matches) instead.
- Do not let a setup-singleton collapse land in `resumeFleetOnBoot`'s `failed`/`failedDetail` — it feeds
  the unconditional `fleet_resume_failed` aggregate (`attention-push.ts` maps it to `"worker-crashed"`
  with no discriminator), paging the owner for expected housekeeping. Intercept the RAW `resumeOne`
  result before `normalizeResumeOneResult` sanitizes the reason away.
- Do not assume `recoverCrashOrphanedWorkers` needs the identical interception — its candidate
  derivation structurally excludes `setup` (verify by reading `crash-orphaned-workers.ts`'s role
  filters, not by trusting this sentence as the set drifts).
- Do not treat `setup_resume_superseded`'s winner-dependent-on-entries-order as a bug — it is accepted;
  do not attempt to make the winner deterministic without a fresh case.

## Source

`packages/daemon/src/sessions/service.ts` — `SETUP_SESSION_RESUME_BARRED_ERROR`, `liveSetupSessions`/
`liveSetupSession`, the refusal in `resume()`, and the `setupResumeSuperseded` interception in
`resumeFleetOnBoot`. `packages/shared/src/types.ts` — the `setup_resume_superseded` event kind.
`packages/daemon/src/gateway/server.ts` — the `/api/sessions/:id/resume` 409 mapping.
