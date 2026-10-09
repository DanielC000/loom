# a4c5f234 — consolidate a both-dead halted-recycle lineage onto the predecessor at boot

## Narrative

Split out of `dfc3b014`'s own "Both-dead split lineage" scope cut. When a halted recycle's predecessor P
and successor S1 are BOTH unresumable this boot, `reconcileHaltedRecycleSuccessorsEarly`'s own NEVER
RESURRECT gate (`@decision 08c81809`/`f1969787`) left both sides completely untouched — ownership stayed
split between a live-but-dead-this-boot P and an archived, dead S1 forever, with no automatic or
human-visible path back.

**P, not S1, is the canonical consolidation target.** Every existing reclaim/recovery path in this whole
subsystem already moves custody onto the PREDECESSOR, never the successor — the existing `recovered`
bucket in this same function, `finalizeRecovery`/`stampStranded` in `finishReconcilingRecycleSettles`
(`08c81809`) — and every human `allowSuperseded` resume in this subsystem targets the predecessor.
Choosing S1 would reverse that direction uniquely for this one case, and there is no existing primitive to
reparent P's own never-moved categories "onto S1" (they are just P's native rows, never moved in the first
place). The structurally-identical "neither side resumable" precedent in the SIBLING settle-lost-to-restart
mechanism (`08c81809`'s `stampStranded`) already chose the predecessor as the visible bookkeeping owner for
exactly this shape of problem.

**Mechanism: mirror `stampStranded`, not `finalizeRecovery`.** `finalizeRecovery` assumes P IS resumable
(it calls `resume(predecessorId, {allowSuperseded:true})`), which contradicts this branch's own premise (P
is NOT durably resumable here, by construction — this branch is only reached once that is established).
`stampStranded` is the record that actually matches "both dead": it never calls `resume()`, only
un-archives P (`db.restoreSession`) + flips it to `exited` (visible, not live) + stamps a `[loom:
orphaned-fleet]`-style banner via `setLastError`. This consolidation reuses that exact mechanism, with
different wording (ownership WAS reparented here, unlike `stampStranded`'s own case, which reparents
nothing).

**Categories moved**: identical to the existing `recovered` branch's reparent block — workers
(`reparentAllChildren`), wakes, questions, event-trigger targets, poll-job targets, webhook targets,
pending-owner-message, plus nulling `fresh.recycledFrom`. `capQueue` is excluded, same as the `recovered`
branch — this early phase is DB-only (no `SessionService`/`capQueue` instance exists yet), so there is
nothing to call regardless. Idempotent via the SAME top-of-loop `db.hasSuccessor(predecessorId)` guard the
`recovered` branch already relies on: once `recycled_from` is nulled, a second boot's loop iteration
short-circuits before ever reaching this branch again — no new marker needed.

## Code Review follow-up: the two checks the Lead required before `done`

**(1) Crash-orphaned-worker recovery interaction — does NOT break NEVER RESURRECT, on the CRASH path.**
Boot ordering (`boot-backstop.ts`'s `runBootRecoveryPrefix`): the early reparent
(`reconcileHaltedRecycleSuccessorsEarly`) runs BEFORE `db.recoverStaleSessions()`, which runs BEFORE
`deriveCrashOrphanedWorkers`/`deriveCrashOrphanedManagers` — all inside the SAME function call, well
before `finishReconcilingHaltedRecycleSuccessors` (the archive+banner phase) and far before the actual
resume attempts (`resumeFleetOnBoot`/`recoverCrashOrphanedWorkers`, both called later in `index.ts`).
Because the reparent happens first, a worker moved onto P in this branch CAN pass
`deriveCrashOrphanedWorkers`'s own filter (worker role + real `engineSessionId` + not archived +
`parentSessionId`/`taskId` set + no own successor + parent role manager/platform + task not terminal) and
surface in `crashOrphanedWorkers` naming P as `managerSessionId` — a genuine side door INTO the
crash-recovery candidate derivation.

On the CRASH path (no `RestartIntent`, `recoverCrashOrphanedWorkers`) this is NOT a resurrection:
`recoverCrashOrphanedWorkers` is manager-first by design (`@decision sha:b65d9a5e`) — it attempts
`resume(managerId)` BEFORE any of that manager's workers, and if the manager's own attempt fails it never
attempts the workers at all (`failed.push(...workers...)`, no `resumeOne` call on any of them). `resume()`'s
own preconditions (`!session.engineSessionId` throw, `!engineTranscriptExists(...)` throw,
`sessionCwdMissing(cwd)` = `!fs.existsSync(cwd)` throw, PLUS the forced-role-fresh-start bypass — see
Round 2 below) are now the IDENTICAL gate `isDurablyResumable` checks, so `isDurablyResumable(P) === false`
guarantees `resume(P)` throws, P lands in `managersFailed`, and the worker is never individually attempted.
Pinned by `recycle-manager-halted-successor-dies.mjs` scenario (F)'s crash-path assertions, which now also
inject the `resumeOne` seam and assert the worker id was never passed to it (Round 2, finding 6a).

The only observable side effect is an extra `manager_crash_resume_failed` audit event under P —
**this is NOT merely "harmless audit"** (Round 2 correction, finding 3): it pages the owner via
`companion/attention-push.ts` (it is a trigger kind) and is, in fact, the ONLY owner signal this lineage
produces on the crash path. That paging is intentional and must NOT be suppressed — a separate card
tracks whether/how to also page from the `consolidated` branch directly rather than relying on this
side-effect page.

**This does NOT generalize to a RESTART-INTENT boot (Round 2 correction, finding 4).**
`resumeFleetOnBoot` (the restart-intent path) is FLAT, not manager-first — it resumes every captured
`RestartIntent` entry independently via its own `resumeOne(e.sessionId)` call, with no manager-first
gating. A worker captured in the pre-restart snapshot that is ITSELF durably resumable (its own
engine id/transcript/cwd, independent of whatever happened to its manager) WILL be resumed there even
though its manager P failed. This is NOT a regression introduced by this card — `resumeFleetOnBoot`'s flat
shape is pre-existing, unrelated behavior; "nothing here is resumed" / "the worker is never individually
attempted" in this record and its tests is scoped to the CRASH path (`recoverCrashOrphanedWorkers`) only.

**Worktree GC protection**: inherited for free, no new code. `index.ts` folds `crashOrphanedWorkers`'s
`workerSessionId`/`managerSessionId` into `protectedSessionIds` (card `9fc41af5`) BEFORE pass-B GC runs —
since the reparented worker surfaces in `crashOrphanedWorkers` with `managerSessionId: P.id` (same
reasoning as above), its worktree (and P's) is protected by the exact same wiring that already protects the
pre-existing `recovered` bucket's worktrees, with zero new code required.

**(2) Un-archiving P — the two cases are not distinguishable, because there is only one archiving
mechanism.** Verified, not guessed: `gateway/server.ts`'s own comment at its session-archive routes states
"Archiving is AUTOMATIC now (card b37750a4): a session auto-archives when its pty exits ... there is NO
manual archive endpoint." The only human-facing actions on an archived row are `POST /api/sessions/:id/
restore` (undo — clears `archived_at`, nothing else) and `DELETE /api/sessions/:id/archive` (PERMANENT
removal, which would make `db.getSession` return nothing and the whole loop `continue` before ever reaching
this branch). `Db.restoreSession` itself is a trivial, unconditional, idempotent `UPDATE ... SET
archived_at = NULL` with no role/resumability/reason guard. So there is no "a human archived this on
purpose, leave it alone" state to special-case — archiving is never a deliberate human action in the first
place, only an automatic byproduct of the pty exiting, regardless of why. Calling `db.restoreSession(
predecessorId)` unconditionally (mirroring `stampStranded`'s own, already-shipped identical call for the
symmetric settle-lost-to-restart case) is correct and needs no distinction.

## Code Review ROUND 2 — two MAJORs

**MAJOR 1 — `isDurablyResumable` could classify a row `resume()` would actually revive.** The original
`isDurablyResumable` (`recycle-settle-reconcile.ts`) was a hand-rolled THREE-check replica of `resume()`'s
own up-front preconditions — but `resume()` has a FOURTH shape it never knew about: a codex-pinned row
whose RESOLVED role forces claude (`TRANSCRIPT_ROOT_DENY_ROLES`, ruling 1(b) card `7955458e`) skips the
engine-id/transcript checks entirely and fresh-starts via `resumeForcedRoleAsFreshClaude` — it needs
neither to come back, only a real `cwd`. A legacy codex-pinned MANAGER row with no engine id would
therefore have been wrongly classified "not durably resumable", landing in `consolidated` and unlinking
its (also-dead) successor — and then a LATER automatic resume (`recoverCrashOrphanedWorkers`,
`resumeFleetOnBoot`, or `WakeService.tick` on a reparented wake, `wake.ts:204`) would actually succeed in
reviving it live, breaking NEVER RESURRECT through a side door this record's own Round 1 analysis missed.

**Fix:** `isForcedRoleFreshStart` (`profiles/codex-compat.ts`) is now THE one place this shape is
computed; `resume()` and `isDurablyResumable` both call it (never each keeping an independent copy of the
expression), so the two can never classify a row differently again. `isDurablyResumable`'s `Pick<Session,
...>` type widened to include `"role"` (every real caller already passes a full `Session`, so this is a
type-only widening, no behavior change at existing call sites beyond the fix itself). A forced-role row
now reads as resumable and routes to the EXISTING `recovered` path, which is correct — it needs no new
bucket. Pinned by a new, unit-level test (`halted-recycle-forced-role-resumability.mjs`, independent of
the full Db+PtyHost+SessionService harness, mirroring `is-superseded-by-recycle.mjs`'s own style) covering
all three `resume()`-precondition failure shapes directly: codex forced-role (now `recovered`), missing
transcript (still `consolidated`), missing cwd (still `consolidated`).

**MAJOR 2 — the banner's remedy could not actually work.** The original banner told a human to resume P
with `allowSuperseded`. That is wrong: `allowSuperseded` only bypasses the superseded/retired REFUSALS
(`service.ts:4085,4091`), never the engine-id/transcript/cwd preconditions that are the REASON P is in
this branch at all — and P has no successor left to be "superseded" by anyway, since this branch already
unlinked it. Worse, a failed AUTOMATIC resume attempt on the transcript/cwd paths (not the "no engine id"
path) sets `resumability:"dead"` (`service.ts:4061,4071`), which hides the Resume button in the web UI
(`web/src/lib/sessions.ts:105`) — `allowSuperseded` was actively misleading, not just unhelpful.

**Fix:** the banner now uses `stampStranded`'s own honest wording — "No automatic owner exists; a human
must intervene (reassign the workers or start a new manager)" — naming no specific mechanism that doesn't
actually work. The corresponding "Do not" bullet below is fixed to match.

## Do not

- Do not reparent onto S1 instead of P — every reclaim path in this subsystem moves custody onto the
  predecessor; there is no primitive (and no precedent) for the reverse direction, and every human
  `allowSuperseded` resume in this subsystem targets the predecessor.
- Do not call `resume()`/`restoreLiveAfterConfirmedAlive` or otherwise flip P to live from this branch —
  NEVER RESURRECT: P is only made VISIBLE (`exited`, un-archived, banner stamped), never resumed.
- Do not tell the banner's reader to resume P with `allowSuperseded` (Round 2 MAJOR 2) — it bypasses only
  the superseded/retired refusals, never the engine-id/transcript/cwd checks that put P here, and P has no
  successor left anyway. Use `stampStranded`'s own honest wording instead: no automatic owner exists; a
  human must intervene (reassign the workers or start a new manager).
- Do not add a `capQueue` reparent call here — this early phase is DB-only; no `SessionService`/`capQueue`
  instance exists yet (mirrors the existing `recovered` branch, which also omits it).
- Do not gate `db.restoreSession(predecessorId)` on any "was this archived by a human" check — there is no
  such state; archiving is automatic-only (card `b37750a4`), and the call is already idempotent.
- Do not suppress, or stop filing, the `manager_crash_resume_failed` attempt on the crash path (Round 2
  correction, finding 3) — it is NOT merely a harmless audit line: it pages the owner via
  `attention-push.ts` and is the ONLY owner signal this lineage produces there. A separate card tracks the
  paging decision; this one must keep firing it in the meantime.
- Do not claim "nothing is resumed" / "the worker is never individually attempted" applies to EVERY boot
  path (Round 2 correction, finding 4) — it is true only for the CRASH path
  (`recoverCrashOrphanedWorkers`'s manager-first design). `resumeFleetOnBoot` (restart-intent) is FLAT and
  WILL resume a durably-resumable reparented worker even if its manager P fails — pre-existing behavior,
  not a regression this card introduces or must fix.
- Do not let `isDurablyResumable` keep an independent copy of `resume()`'s forced-role-fresh-start
  condition (Round 2 MAJOR 1) — both must call `isForcedRoleFreshStart` (`profiles/codex-compat.ts`), the
  ONE place that expression is computed, or classification can silently drift from what `resume()`
  actually does again.
- Do not add `recycle_split_lineage_consolidated` to `EVENT_TRIGGER_EVENT_KINDS`/`GATE_HISTORY_KINDS`/
  `ORCH_ACTIVITY_KINDS`/`REPORT_RESOLVED_EVENT_KINDS` — mirrors every sibling `recycle_*` kind's posture;
  none of the four apply to an audit-only recycle bookkeeping marker.

## Source

`packages/daemon/src/sessions/halted-recycle-reconcile.ts` (`reconcileHaltedRecycleSuccessorsEarly`'s new
`consolidated` bucket), `packages/daemon/src/sessions/service.ts`
(`finishReconcilingHaltedRecycleSuccessors`'s new `consolidated` handling + `resume()`'s
`isForcedRoleFreshStart` call site), `packages/daemon/src/sessions/recycle-settle-reconcile.ts`
(`isDurablyResumable`, widened), `packages/daemon/src/profiles/codex-compat.ts`
(`isForcedRoleFreshStart`, Round 2 MAJOR 1), `packages/shared/src/types.ts` (`OrchestrationEventKind`),
`packages/daemon/src/index.ts` (destructure + log line). Tests:
`packages/daemon/test/recycle-manager-halted-successor-dies.mjs` scenario (F)/(F2) (idempotency,
resolved-marker respect, crash-orphan interaction incl. the injected `resumeOne` seam and a non-worker
category assertion) and `packages/daemon/test/halted-recycle-forced-role-resumability.mjs` (Round 2 MAJOR
1's three `resume()`-precondition fixtures). Landed by card `a4c5f234`.
