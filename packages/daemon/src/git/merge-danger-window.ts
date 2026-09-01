import { canonicalRepoLockKey } from "./repo-lock.js";
import { writeMergeDangerLatch, clearMergeDangerLatch } from "./merge-danger-latch.js";

/**
 * IN-PROCESS tracker for the narrow interval inside `mergeBranchLocked` (git/worktrees.ts) during which a
 * canonical repo's git index holds THIS op's own STAGED-but-not-yet-committed squash diff — from just
 * before `git merge --squash` through the final `git commit` (or, on a conflict/rawError/probe-failure
 * exit, through that same exit's own cleanup `git reset --hard`). A process death inside this span leaves
 * the canonical repo with uncommitted staged content that `mergeBranchLocked`'s own entry check (card
 * 9e77050f/06b5c47f) then refuses the NEXT merge on — the "trigger-3" hazard — and it never auto-clears
 * without a human.
 *
 * Board card 5a7692a4: `gracefulShutdown` (index.ts) used to `process.exit(0)` unconditionally, with zero
 * awareness of an in-flight merge — a signal or an owner-initiated `loom stop` landing here (a real,
 * measured ~92s-margin near-miss) could exit mid-window. This module is what lets `gracefulShutdown` see
 * "is anything in the danger window right now" and delay its own exit by a short, BOUNDED grace before
 * exiting regardless — see {@link waitForMergeDangerWindowsToClear}. It is never a hard refusal of the
 * owner's stop: it only delays `process.exit`, and only up to a fixed ceiling, then exits either way.
 *
 * TWO persistence layers, deliberately different, for two different questions:
 *  - This Map is IN-MEMORY, live-process state, for `gracefulShutdown`'s own bounded wait above — a
 *    question only the still-running process can answer.
 *  - `enter`/`exit` below ALSO durably write/clear a per-repo latch file via merge-danger-latch.ts, for the
 *    boot-time EVENT question a hard death (SIGKILL, power loss, a crash that never runs any handler)
 *    leaves unanswered: "did THIS process die inside a merge squash" — see that module's own doc for why
 *    `scanCanonicalReposForMergeResidue`'s unconditional STATE probe (git/worktrees.ts, "is the tree dirty
 *    right now") answers a related but genuinely different question and cannot substitute for this.
 */

export interface MergeDangerWindowEntry {
  repoPath: string;
  branch: string;
  opId?: string;
  enteredAt: number;
}

const activeDangerWindows = new Map<string, MergeDangerWindowEntry>();

/**
 * Called by `mergeBranchLocked` right before `git merge --squash` — the call whose interrupted state (a
 * staged, uncommitted diff) is the actual "trigger-3" hazard this module exists to close. A rejection
 * that returns with zero side effects before this call (e.g. `gateBaseInvalidated`, caught before any
 * write) never marks this repo as being in the danger window at all. Updates the in-memory Map AND
 * durably persists the SAME fact via {@link writeMergeDangerLatch} (synchronous, atomic, never throws)
 * — one call, two persistence layers, so the two can never drift out of sync with each other.
 *
 * ⚠️ NOT literally the attempt's first mutating git call, despite this module's own name (board card
 * c6a6f405 item 3 — corrects a prior version of this doc that claimed otherwise). When stale
 * in-progress-merge residue survives from an earlier interrupted attempt, `mergeBranchLocked`'s entry
 * check runs its OWN earlier `git reset --merge HEAD` to clear it (card 9e77050f/06b5c47f) — a real
 * mutating call, outside this window and outside the durable latch. Left uncovered deliberately narrow:
 * that clear only ever runs when residue ALREADY exists, and it only ever resets to the CURRENT HEAD (it
 * can't manufacture new staged content), so a death mid-clear reproduces the same pre-existing
 * unattributed-dirty-tree shape at a much smaller blast radius than the squash itself — not a new
 * regression this window needs to widen to cover. See git/worktrees.ts's residue-clear block (searches:
 * "residue clear") for the call site and its own cross-reference back here.
 */
export function enterMergeDangerWindow(repoPath: string, branch: string, opId?: string): void {
  activeDangerWindows.set(canonicalRepoLockKey(repoPath), { repoPath, branch, opId, enteredAt: Date.now() });
  writeMergeDangerLatch(repoPath, branch, opId);
}

/**
 * Called by `mergeBranchLocked` in a `finally` wrapping EVERY exit from the danger region — success, a
 * handled conflict/rawError/probe-failure (after that exit's own cleanup git call has itself settled,
 * since it sits in the SAME `finally` as that cleanup, never before it), or an uncaught throw. Idempotent
 * — safe to call when no entry exists. Clears BOTH the in-memory Map and the durable latch file — a
 * process that survives to reach this call needs neither anymore; a process that does NOT survive to
 * reach it leaves the durable latch behind for the next boot to find, which is the entire point.
 */
export function exitMergeDangerWindow(repoPath: string): void {
  activeDangerWindows.delete(canonicalRepoLockKey(repoPath));
  clearMergeDangerLatch(repoPath);
}

/** Snapshot of every repo currently inside its own danger window, for `gracefulShutdown` to inspect. */
export function listActiveMergeDangerWindows(): MergeDangerWindowEntry[] {
  return [...activeDangerWindows.values()];
}

/**
 * Bounded grace before `gracefulShutdown` exits regardless — sized for the TYPICAL window, not the worst
 * case. The window itself is a small fixed count of LOCAL git subprocess calls (no network, no build); the
 * closest measured analog in this codebase (gate-semaphore.ts's own comment on a comparable-sized sequence
 * of real git calls) is "~1.5s typical". Each individual git call in the window is separately bounded at
 * GIT_OP_TIMEOUT_MS (15s in git/worktrees.ts), so a pathological worst case could in principle stretch the
 * real window to ~75-90s if every call in it hung — this grace is deliberately far below that: a shutdown
 * that waits that long is a worse bug than the one it exists to fix.
 */
export const MERGE_DANGER_SHUTDOWN_GRACE_MS = 5_000;
const POLL_INTERVAL_MS = 150;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => { setTimeout(resolve, ms); });
}

/**
 * Wait, AT MOST `graceMs`, for every currently-active merge danger window to clear — POLLING real state,
 * not a single fixed sleep (a fixed wait guarding "did it clear" can't distinguish "cleared" from "hasn't
 * cleared YET" in one trial). Logs a loud, specific warning (repo/branch/opId/age) for each window found
 * active, ONCE, before waiting — so even a grace that fully elapses (the merge never finished) leaves an
 * operator with exactly what to go check, not a silent gap.
 *
 * FAIL-OPEN + ALWAYS RESOLVES within `graceMs` of being called, never throws: `gracefulShutdown` must be
 * able to call `process.exit` unconditionally right after this settles. ⛔ NEVER a hard refusal of the
 * owner's stop — this only delays the exit, and only up to this ceiling.
 */
export async function waitForMergeDangerWindowsToClear(graceMs: number = MERGE_DANGER_SHUTDOWN_GRACE_MS): Promise<void> {
  try {
    const initial = listActiveMergeDangerWindows();
    if (initial.length === 0) return;
    for (const w of initial) {
      const ageMs = Date.now() - w.enteredAt;
      console.warn(
        `[shutdown] a canonical merge squash is IN FLIGHT at ${w.repoPath} (branch '${w.branch}'${w.opId ? `, op ${w.opId}` : ""}, entered ${ageMs}ms ago) — ` +
        `waiting up to ${graceMs}ms for it to settle before exiting; if it does not, the canonical repo may be left with staged, ` +
        `uncommitted residue that the next merge attempt against it will refuse until a human resolves it by hand (the boot-time ` +
        `residue scan will also flag it on next start).`,
      );
    }
    const deadline = Date.now() + graceMs;
    while (Date.now() < deadline) {
      if (listActiveMergeDangerWindows().length === 0) return;
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
    }
    const stillActive = listActiveMergeDangerWindows();
    if (stillActive.length > 0) {
      console.warn(`[shutdown] exiting anyway after ${graceMs}ms grace with ${stillActive.length} merge squash(es) still in flight — check the affected repo(s) for staged residue on next boot.`);
    }
  } catch {
    /* never block the exit this exists to gate */
  }
}
