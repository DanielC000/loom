import { resolveConfig, columnKeyForRole, type Session } from "@loom/shared";
import type { Db } from "../db.js";
import { engineTranscriptExists } from "../sessions/transcript.js";
import { deriveAwaitingReview } from "./report-resolution.js";

/**
 * A worker session identified as crash-orphaned at boot — see {@link deriveCrashOrphanedWorkers}.
 * @decision 959a5fb7 — `reportedState`/`awaitingReview` (not the wider report-EXISTENCE signal) gate
 *  the crash-recovery nudge and the "awaiting your review/merge" summary count.
 * @decision db05e657 — computed by the SAME {@link deriveAwaitingReview} predicate `worker_list`'s
 *  own projection uses; also deleted this interface's former report-existence-only `reportedDone`
 *  field, an easily-confused near-duplicate of `reportedState` with zero functional readers of its own.
 */
export interface CrashOrphanedWorker {
  workerSessionId: string;
  managerSessionId: string;
  reportedState: "done" | "blocked" | null;
  awaitingReview: boolean;
}

/**
 * @decision 9fc41af5 — the DB-derived complement to `SessionService.resumeFleetOnBoot`, covering a
 *  genuine daemon CRASH (no captured `RestartIntent`) where in-flight workers used to sit exited +
 *  auto-archived with no non-lossy recovery path otherwise.
 *
 * `recovered` MUST be the exact Session[] `db.recoverStaleSessions()` returns at boot (index.ts), read
 * BEFORE the boot-backstop archive pass runs — every session that was actually `live`/`starting` the
 * instant the process died, i.e. genuinely crash-orphaned by THIS crash (not merely "exited a while
 * ago"). Calling this against a fresh DB re-query instead would see every one of them already archived
 * by that same backstop pass and recover nothing.
 *
 * Recovers a worker iff: it's a `worker` with a captured, non-dead engine id (a cached 'dead' stamp is
 * RE-VERIFIED live rather than trusted outright — see below); wasn't archived BEFORE this
 * crash; has no recycle successor (never resurrect a superseded row — its successor owns the work);
 * its parent is a manager/platform session; and its
 * task still exists and is NOT on the project's resolved terminal/done lane. A worker that reported
 * `done` but whose task hasn't landed yet (crashed between the report and the merge) IS still
 * recovered — excluding it would be worse than resurrecting it: its worktree/branch already hold real
 * committed work (Pass B's worktreeHasWork guard keeps that on disk regardless of session state, and
 * worker_merge/worker_merge_confirm merge purely off the branch + worktree, never checking session
 * liveness or archivedAt), so the only thing recovery adds for a done-but-unmerged worker is
 * VISIBILITY — reappearing in the manager's worker_list instead of sitting silently archived where the
 * manager has no reason to look for it.
 *
 * @decision sha:a9c9a342 — a cached `resumability:'dead'` stamp used to be trusted outright and could
 *  silently exclude a perfectly-healthy worker (and its whole manager) from crash recovery; it is now
 *  always re-verified live instead (see the self-heal below).
 */
export function deriveCrashOrphanedWorkers(db: Db, recovered: Session[]): CrashOrphanedWorker[] {
  const out: CrashOrphanedWorker[] = [];
  for (const w of recovered) {
    if (w.role !== "worker") continue;
    if (!w.engineSessionId) continue;
    // A cached 'dead' stamp is RE-VERIFIED now rather than trusted outright (see above) — it
    // may be stale from an earlier watcher race on a transcript that's actually fine. A worker that was
    // NEVER flagged dead skips this fs hit entirely (unchanged from before); `resume()` itself still
    // re-checks live at resume time regardless, so this only closes the "silently excluded on a stale
    // flag before ever reaching resume()" gap without adding a filesystem check to the common path.
    //
    // @decision sha:a9c9a342
    if (w.resumability === "dead") {
      if (engineTranscriptExists(w.cwd, w.engineSessionId, w.harness)) {
        db.setResumability(w.id, "resumable"); // self-heal — the stamp was wrong
      } else {
        console.log(`[crash-recovery] worker ${w.id.slice(0, 8)} excluded from recovery: engine transcript missing (unresumable)`);
        continue;
      }
    }
    if (w.archivedAt) continue; // already archived pre-crash — not this crash's doing
    // TASKLESS intentionally excluded here (CR-flagged asymmetry, card 2514e6e1-follow-up): this whole
    // recovery decision hinges on board-column state (the terminal-lane check below decides "genuinely
    // finished, never resurrect") — meaningless for a worker with no card. A taskless worker (an ad-hoc
    // spike, or a read-only reviewer) is expected to be actively awaited by the manager that spawned it,
    // not auto-resumed across a daemon crash the way a tasked worker's in-flight work is; if it produced
    // commits worth recovering, they're retained on disk (boot-reconcile's Pass B worktreeHasWork guard —
    // service.ts, session-agnostic — applies the same to a taskless worker's worktree as a tasked one's)
    // even though the SESSION itself isn't resurrected.
    if (!w.parentSessionId || !w.taskId) continue;
    if (db.hasSuccessor(w.id)) continue; // recycled/superseded — its successor owns the work
    const manager = db.getSession(w.parentSessionId);
    if (!manager || (manager.role !== "manager" && manager.role !== "platform")) continue;
    const task = db.getTask(w.taskId);
    if (!task) continue;
    const project = db.getProject(w.projectId);
    if (!project) continue;
    const terminalKey = columnKeyForRole(resolveConfig(project.config).kanbanColumns, "terminal");
    if (task.columnKey === terminalKey) continue; // landed — genuinely finished, never resurrect
    // reportedState/awaitingReview (card 959a5fb7, unified by card db05e657): "is the manager still
    // genuinely waiting on this worker's last done/blocked report", computed by the SAME shared predicate
    // worker_list's own projection uses — see deriveAwaitingReview's doc (orchestration/report-resolution.ts)
    // for the two rulings (blocked counts like done; a bare merge_rejected never resolves) that make this
    // call identical to `mcp/orchestration.ts`'s `reportedProjection` for the same events.
    const events = db.listEventsForWorker(w.id);
    const { reportedState, awaitingReview } = deriveAwaitingReview(events);
    out.push({ workerSessionId: w.id, managerSessionId: w.parentSessionId, reportedState, awaitingReview });
  }
  return out;
}

/**
 * `sessionId`'s CURRENT successor (`db.getSuccessor`), but ONLY when it is exactly the successor named by
 * `sessionId`'s LATEST `recycle_ownership_transfer_failed` event (same id — the real discriminator; `gen`
 * is checked too, but only as a defensive secondary check, ⛔ never simplify the match to gen-only — see
 * `halted-recycle-reconcile.ts`'s identical framing) — i.e. "is this session a HALTED recycle predecessor
 * whose ownership-transfer handoff is still genuinely unresolved, right now". Returns `undefined` for
 * every other shape: no successor at all, an ordinary (never-halted) recycle, a halt event that no longer
 * names the current successor, or a halt that has since been RESOLVED (see below).
 *
 * `recycle_ownership_transfer_failed` is filed ONLY by `recycleManager` (sessions/service.ts) — never
 * `recyclePlatformLead` (no ownership-transfer/halt branch exists there) and never a worker recycle (that
 * event's `workerSessionId` is always the retiring MANAGER's id, never a worker's) — so this is a
 * guaranteed no-op for a platform or worker `sessionId`, by construction, not by a role check here.
 *
 * @decision 386e4eb5 — never treat a missing/non-numeric `detail.gen` on either side as a match (fails
 *  CLOSED) — every RECLAIM path (pulling the fleet back onto the predecessor) already nulls
 *  `recycled_from` on success, which alone makes the `getSuccessor` check above return undefined.
 *
 * @decision dfc3b014 — a SETTLE-FORWARD path (`recycle_reattempt`) deliberately leaves `recycled_from`
 *  intact instead, so it needs its own marker: the latest-by-ts event of EITHER kind decides, and a
 *  `recycle_ownership_transfer_resolved` latest means "no longer unresolved", full stop.
 */
export function currentHaltedSuccessor(db: Db, sessionId: string): Session | undefined {
  const fresh = db.getSuccessor(sessionId);
  if (!fresh) return undefined;
  const latest = db.listEventsForSession(sessionId)
    .filter((e) =>
      (e.kind === "recycle_ownership_transfer_failed" || e.kind === "recycle_ownership_transfer_resolved")
      && e.workerSessionId === sessionId)
    .at(-1); // listEventsForSession is ORDER BY ts, rowid — chronological; .at(-1) is genuinely the latest.
  if (!latest || latest.kind !== "recycle_ownership_transfer_failed") return undefined;
  const haltGen = (latest.detail as { gen?: number } | undefined)?.gen;
  if (fresh.id !== latest.managerSessionId || typeof haltGen !== "number" || fresh.gen !== haltGen) return undefined;
  return fresh;
}

/**
 * @decision 92c20eb9 — never fold this into {@link currentHaltedSuccessor} or into
 * `isSupersededByRecycle` — they cover disjoint recycle-fleet scenarios, not variants of one check.
 * @decision 92c20eb9 — never drop the `reachedReadyAt` check: it can be set before the settle loop's
 * next poll ever files `recycle_fleet_resolved` (or, across a restart, with no event at all) — trusting
 * a stale unresolved event in that gap would tell a human to stop the fleet's sole live owner.
 */
export function currentUnresolvedSettleSuccessor(db: Db, sessionId: string): Session | undefined {
  const fresh = db.getSuccessor(sessionId);
  if (!fresh) return undefined;
  if (fresh.reachedReadyAt != null) return undefined;
  const latest = db.listEventsForSession(sessionId)
    .filter((e) => e.kind === "recycle_fleet_unresolved" || e.kind === "recycle_fleet_resolved" || e.kind === "recycle_fleet_recovered")
    .at(-1);
  if (!latest || latest.kind !== "recycle_fleet_unresolved") return undefined;
  const detail = latest.detail as { deadSuccessorId?: string; reason?: string; halted?: boolean } | undefined;
  if (detail?.reason !== "timeout" || detail?.halted === true) return undefined;
  if (fresh.id !== detail?.deadSuccessorId) return undefined;
  return fresh;
}

/**
 * @decision 92c20eb9 — never widen this into an automatic reclaim; only a human-initiated hard-stop of
 * the named successor is safe (it routes through the existing, tested `!pty.isAlive` reclaim branch
 * instead of racing `settleRecycleHandoff`'s unconditional ready-branch hard-stop of the predecessor).
 */
export function unresolvedSettleEscalationHint(successor: Session): string {
  return `your successor ${successor.id} has not confirmed reaching SessionStart since the settle ` +
    `timeout — call question_ask to ask a human to hard-stop it (POST /api/sessions/${successor.id}/stop ` +
    `with body {"mode":"hard"}, or the Sessions UI's stop action), which will trigger the existing ` +
    `automatic fleet-reclaim back onto you. Say in your ask that the human should do this ONLY IF your ` +
    `successor still shows not-ready by the time they act — if it has since become ready, stopping it ` +
    `would be wrong`;
}

/**
 * Shared successor-exclusion predicate (card `6859f9e7`): a session with a recycle successor is never a
 * valid automatic resume target — `resume()` refuses it unconditionally without a human
 * `allowSuperseded` override (sessions/service.ts). Used by both `deriveCrashOrphanedManagers` below
 * (the crash-path manager derivation) and `SessionService.liveFleetResumeSet` (the RestartIntent capture
 * snapshot for an ordinary `daemon_restart`) so the two resume-candidate derivations can't drift apart
 * again: a `daemon_restart` taken mid-`recycleManager` used to capture BOTH the predecessor and its
 * already-live successor, since the predecessor is deliberately kept live awaiting ownership-transfer
 * settle. On boot, `resume(predecessor)` threw "a successor exists" and that throw was counted as a
 * genuine `fleet_resume_failed`, even though the predecessor was never meant to resume.
 *
 * @decision f1969787 — never refuse a halted-recycle predecessor unconditionally just because
 *  `hasSuccessor` is true — see {@link currentHaltedSuccessor} for the one case that must stay resumable.
 *
 * @decision 386e4eb5 — never bypass {@link currentHaltedSuccessor}'s exact id+gen match here (e.g. back to
 *  bare `hasSuccessor`) — a bare-presence check wrongly auto-resumes a predecessor that was already
 *  cleanly re-recycled to an unrelated new successor.
 */
export function isSupersededByRecycle(db: Db, sessionId: string): boolean {
  if (!db.hasSuccessor(sessionId)) return false;
  return !currentHaltedSuccessor(db, sessionId);
}

/**
 * @decision 92c20eb9 — shared refusal text for BOTH spawnWorker and callerSupersededError, so the
 * wording can't drift between the two chokepoints; never re-checks isSupersededByRecycle itself.
 */
export function retiredCallerMessage(db: Db, managerSessionId: string): string {
  const successor = db.getSuccessor(managerSessionId);
  const base = `you are being retired (recycled); your successor ${successor?.id ?? "(unknown)"} owns the fleet`;
  // @decision 92c20eb9 — card ca0111a3: append the same escalation hint question_ask's own carve-out
  // uses, so a predecessor stuck in the unresolved-settle window learns its one way out the FIRST time it
  // tries any other refused tool, not only if it happens to already know to call question_ask.
  const unresolved = currentUnresolvedSettleSuccessor(db, managerSessionId);
  return unresolved ? `${base}. ${unresolvedSettleEscalationHint(unresolved)}.` : base;
}

/**
 * @decision sha:a9c9a342 — a manager crash-orphaned in its own right, with no surviving worker to
 *  ride along on, used to never get a resume attempt at all; every manager/platform row in `recovered`
 *  not covered by `orphanedWorkers` now gets ONE independent attempt via this list (`soloManagerIds`).
 *
 * `recoverCrashOrphanedWorkers` groups its resume targets BY MANAGER, keyed off `orphanedWorkers` — see
 * `SessionService.recoverCrashOrphanedWorkers`'s `soloManagerIds` option for how this list is consumed.
 *
 * `recoverStaleSessions()` selects `recovered` purely on `process_state IN ('live','starting')` — it does
 * NOT filter on a missing engine id, archived, or recycle-superseded rows (that's exactly why the WORKER
 * path above guards all three). A manager row can be `live`/`starting` in the DB while caught mid-
 * `starting` at crash time with NO captured engine id yet (there's no transcript to resume into — it can
 * NEVER be resumable, not even in principle), while ALREADY archived pre-crash, or while a `recycle_me`
 * predecessor still shows live/starting even though a successor has since taken over — a crash can freeze
 * any of these shapes. Skipping these guards would either resurrect a dead/retired manager into a
 * duplicate/zombie session, or attempt a resume that structurally cannot succeed (surfacing a misleading
 * "unresumable" failure for a session that was never a real recovery candidate) — so this mirrors the
 * worker path's `engineSessionId`/`archivedAt`/`hasSuccessor` checks exactly.
 */
export function deriveCrashOrphanedManagers(db: Db, recovered: Session[], orphanedWorkers: CrashOrphanedWorker[]): string[] {
  const covered = new Set(orphanedWorkers.map((c) => c.managerSessionId));
  const out: string[] = [];
  for (const s of recovered) {
    if (s.role !== "manager" && s.role !== "platform") continue;
    if (covered.has(s.id)) continue;
    if (!s.engineSessionId) continue; // never captured an engine id — structurally never resumable
    if (s.archivedAt) continue; // already archived pre-crash — not this crash's doing
    if (isSupersededByRecycle(db, s.id)) continue; // recycled/superseded — its successor owns the work
    out.push(s.id);
  }
  return out;
}
