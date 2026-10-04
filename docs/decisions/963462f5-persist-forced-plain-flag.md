# 963462f5 — persist a forced-plain flag so resume/fork/harnessDrainStatus keep a human's plain choice exactly

## Narrative

`f900237d`'s interim rule (`resume()`/`forkSession()` passing `forcePlain: row.role === null &&
profileConfersSpawnableRole(agent)` into `resolveAgentSpawn`) re-derives "was this row a deliberate human
plain choice" from the agent's CURRENT profile, live, on every call. That record named two accepted
residuals it deferred to this card:

1. A human's ACTUAL `forcePlain` start on an agent whose profile itself has a null or clamped role is
   indistinguishable, by row inspection alone, from a role-omitted start that legitimately landed role-null
   for an unrelated reason — the row carried no discriminator for *why* its role is null.
2. A `forcePlain` start on a profile that WAS spawnable at start time but is LATER edited to a null/clamped
   role, or whose `profileId` is reassigned to a different profile, regains that NEW profile's `allowDelta`
   on resume/fork — because the interim rule re-resolves the agent's profile LIVE, not at the moment the
   human actually chose plain.

A third, independently-discovered residual (verified empirically before this card's design was approved,
not merely theorized): `harnessDrainStatus()` (`sessions/service.ts`) called `resolveAgentSpawn` with NO
`forcePlain` argument at all (not even the interim rule) — so a forced-plain row on a
`PROFILE_SPAWNABLE_ROLES` profile had its profile consulted as if it were a real role, mis-resolving its
"wanted" harness. Under a project/platform default-harness of `codex` for `worker`, this listed the
forced-plain row in `pending` PERMANENTLY — nothing ever respawns a plain row with a different role, so it
could never clear. `f900237d`'s own record explicitly scoped this out as "not a permission issue... tracked
separately" — correct, since it is a harness-drain correctness bug, not a permission-widening one, but
real and unfixed until this card.

## The fix

`Session.forcedPlain?: boolean | null` — a TRI-STATE discriminator, additive nullable `INTEGER` column
(`forced_plain`, `SESSION_ADDED_COLUMNS` in `db.ts`; no index references it; no base-SCHEMA statement
reads it, so an upgraded-DB boot can never hit the "column referenced before its migration ran" class of
bug `db-legacy-boot.mjs` guards against).

- `true`/`false` on every row created after this card: `startNew` always knows real human intent directly
  (`forcedPlain: opts.forcePlain ?? false`) — never leaves a fresh row ambiguous.
- `forkSession` STAMPS the RESOLVED value onto the new forked row (`effectiveForcePlain(src, agent)` when
  the agent still exists, else a raw copy of `src.forcedPlain` in the already-existing agent-missing
  branch) — converging a legacy-null source's ambiguity forward onto a definite value, never copying the
  ambiguity itself.
- `null` on a row that predates this migration, OR on any row ever written by a spawn path OTHER than
  `startNew`/`forkSession` (`startManager`/`startPlatformLead`/`startAuditor`/`startWorkspaceAuditor`/
  `startSetup`/`startOperator`, the "run" spawn, `spawnWorker`/worker revive, every recycle site). It is
  harmless everywhere, for one reason that covers every case uniformly: `forcedPlain` is sticky-TRUE
  only, so `null` and `false` are EQUIVALENT inputs to `effectiveForcePlain` — a row's `role` being
  non-null at most of those sites is incidental, not what makes `null` safe (the gateway e2e test-seed
  route, `gateway/server.ts:3501`, can write `role:null` + `forcedPlain:null` from the very same insert,
  and it's still harmless for the identical reason).
  `effectiveForcePlain(session, agent)` — the ONE place that reads this column — falls back to
  `f900237d`'s interim rule whenever `forcedPlain` isn't a definite `true` (see Round 2 below for the
  `??` vs OR correction).
- `resume()`, `forkSession()`'s own spawn-options resolution, and `harnessDrainStatus()` all call
  `effectiveForcePlain` — never re-derive the interim rule inline at a call site.
- NO write at any recycle site (`recycleWorker`/`recycleManager`/`recyclePlatformLead`) or at boot-reconcile
  — verified (not assumed) that every recycle successor's `role` is hardcoded to a concrete non-null value
  (`"worker"`/`"manager"`/`"platform"`), so a recycle row is never ambiguous in the first place; and every
  boot/crash-recovery resume path (`index.ts`, `crash-recovery-watcher.ts`, `webhooks/ingress.ts`,
  `poll.ts`, `event-triggers.ts`) routes through the SAME `sessions.resume()` chokepoint, so fixing
  `resume()` covers boot-reconcile transitively with no separate write.
- `forcedPlain` is excluded from every agent-facing session projection (`SESSION_ROW_FIELDS` in
  `mcp/orchestration.ts`, `SESSION_LIST_FIELDS` in `mcp/sessionView.ts`) — same posture as
  `reachedReadyAt` (`08c81809`): purely internal spawn machinery, never surfaced to an agent.

## Round 2 (Code Review `c47b73d6` of `65d3c37c`, verdict CHANGES)

**MAJOR, lead ruling:** `effectiveForcePlain` must combine `forcedPlain` with the interim rule via **OR**,
never `??`: `session.forcedPlain === true || (session.role === null && profileConfersSpawnableRole(agent))`.
With `??`, a definite `false` (a NON-forced role-null row — e.g. one whose profile was itself null/clamped
at start, so `startNew` wrote `forcedPlain:false` honestly) SHORT-CIRCUITED past the interim rule entirely.
Reproduced by the reviewer: such a row, once its agent's profile was later edited or reassigned to a
SPAWNABLE role (worker/manager/assistant), adopted that NEW profile's `allowDelta` AND role pin on
resume/fork, and reappeared as `harnessDrainStatus` `pending` — exactly the widening `f900237d`'s interim
rule exists to prevent, now let through BY `forcedPlain:false` rather than caught by it. "A non-forced
role-null row keeps following its CURRENT profile" was considered and explicitly NOT adopted — that is a
different, unwanted resolve mode, not this card's job. `forcedPlain` is **sticky-TRUE only**: `true` always
wins (a real, permanent human choice); `false` and `null` both defer identically to the interim rule's live
re-check — `false` is informative (we KNOW it wasn't a deliberate choice) but is NOT license to suppress
the role/profile safety net a legacy `null` row already relies on.

**Doc correction (MINOR, revised again after the delta review):** "`null` ONLY on a row that predates this
migration" (this record's own original wording, and `Session.forcedPlain`'s doc comment) was false —
every spawn path OTHER than `startNew`/`forkSession` inserts `forcedPlain` as `undefined` ⇒ `NULL` too.
The FIRST correction pass claimed this was harmless because those rows are "always paired with a non-null
`role`" — also false: the gateway e2e test-seed route (`gateway/server.ts:3501`,
`role: s.role && s.role !== "plain" ? (s.role as SessionRole) : null`) can insert `role:null` WITH
`forcedPlain` left `undefined` ⇒ `NULL`, from the same object literal. The role-pairing claim is dropped
entirely. The actually-correct, uniform reason `null` is harmless everywhere: `forcedPlain` is
sticky-TRUE only, so `null` and a definite `false` are EQUIVALENT inputs to `effectiveForcePlain` — there
is no case where nullness alone changes the outcome. Corrected above and in `Session.forcedPlain`'s own
doc comment. No new write was added at any site — the correction is doc-only.

**Test hazard (found during this round's own review):** `forced-plain-persisted.mjs` originally called a
LIVE `startNew()` on an agent whose project set a codex harness default for role "worker" — that resolved
`harness:"codex"`, which `PtyHost.spawn()` routes to `spawnCodexProcess`/`createCodexPty`, a seam the
shared `createSeamHost` fixture never fakes (it only overrides `createPty`). That spawned the REAL
installed `codex.CMD` on every run. Fixed: seed that row directly via `db.insertSession` instead, and the
test's `SeamHost` now overrides `createCodexPty` to THROW — matching the same belt-and-braces pattern
already used by `harness-switch-now.mjs`/`harness-drain-status.mjs`/`default-harness-config.mjs`/
`codex-fleet-switch-guard.mjs`. Swept the rest of `packages/daemon/test` for the same shape (a project/
platform harness default of codex + `createSeamHost` + a live `startNew`/`resume`/`forkSession` call) —
no other offenders found; the other six files matching `default:\s*"codex"` were all already safe.

## Do not

- Do not combine `forcedPlain` with the interim rule using `??` — use OR (`=== true || (...)`). A `??`
  lets a definite `false` suppress the interim rule's own protective re-check, which is the Round 2 MAJOR
  regression above. `forcedPlain` is sticky-TRUE only; `false` must behave exactly like `null`.
- Do not adopt "a non-forced role-null row keeps following its CURRENT profile live" as a resolve mode —
  considered and rejected in Round 2; it is a different, unwanted semantics, not a fix.
- Do not re-derive `effectiveForcePlain`'s logic inline at any call site — `resume()`, `forkSession()`, and
  `harnessDrainStatus()` must all call the ONE shared private helper, or a future change to the interim
  rule (or to how legacy rows are detected) silently drifts between them.
- Do not write `forcedPlain` at any recycle call site, or treat its absence there as a gap — role is
  hardcoded non-null at every recycle site today; re-verify that invariant before assuming it's still safe
  to skip, should a future role ever recycle into a null-role row.
- Do not copy a fork source's possibly-null `forcedPlain` forward verbatim when the agent still exists —
  stamp the RESOLVED (`effectiveForcePlain`) value instead, so ambiguity converges on every new row rather
  than propagating indefinitely through a chain of forks.
- Do not add `forcedPlain` to `SESSION_ROW_FIELDS`/`SESSION_LIST_FIELDS` (or any other agent-facing
  projection) without a deliberate review — it is internal spawn machinery, not a field an agent-facing
  view should carry.
- Do not call `Db.setSessionHarness` to simulate a "pre-default" worker row in a test — that setter is a
  write-once-at-insert exception reserved for `resumeForcedRoleAsFreshClaude` alone (`aa82caed`). Seed such
  a fixture row directly via `db.insertSession` instead.

## Source

`packages/shared/src/types.ts` (`Session.forcedPlain`), `packages/daemon/src/db.ts`
(`SESSION_ADDED_COLUMNS.forced_plain`, `migrateSessions`, `insertSession`, `toSession`),
`packages/daemon/src/sessions/service.ts` (`effectiveForcePlain`, `startNew`, `forkSession`, `resume()`,
`harnessDrainStatus()`), `packages/daemon/src/mcp/orchestration.ts` (`SESSION_ROW_FIELDS`),
`packages/daemon/src/mcp/sessionView.ts` (`SESSION_LIST_FIELDS`). Test:
`packages/daemon/test/forced-plain-persisted.mjs`.
