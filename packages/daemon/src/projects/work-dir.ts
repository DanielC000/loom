import { PROJECTS_WORK_ROOT, projectWorkDir, isSingleProjectSegmentUnderRoot } from "../paths.js";
import { removeDirWithCleanRetry, type RemoveDirResult } from "../git/worktrees.js";

/**
 * Card 8e32605d — `deleteProjectWorkDir` lives here, not in `paths.ts`, because it needs
 * `killableRemoveDir`, and `git/worktrees.ts` already imports FROM `paths.ts` (`WORKTREES_DIR`) —
 * importing it back into that near-leaf module (imported by half the daemon) would make it the first
 * file on either side of a new circular-import edge. `projects/` already imports from `git/*` elsewhere
 * (`rebind.ts`, `repos.ts`), so this is the established-safe direction.
 */

/** Injectable seam for {@link deleteProjectWorkDir} — mirrors `RunSnapshotRemoveDeps` (runs/snapshot.ts) /
 *  `ScratchGcDeps` (sessions/scratch-gc.ts) exactly. Lets a test simulate a wedged (never-settling)
 *  removal, or a clean reject-then-succeed sequence, without real filesystem flakiness. Real callers
 *  never pass this. */
export interface DeleteProjectWorkDirDeps {
  removeDir?: (target: string, timeoutMs: number) => Promise<RemoveDirResult>;
  timeoutMs?: number;
}

/**
 * Deliberately NOT the 15s `GIT_OP_TIMEOUT_MS`/`SCRATCH_GC_REMOVE_TIMEOUT_MS`/`RUN_SNAPSHOT_TIMEOUT_MS`
 * convention (manager code-review follow-up, card 8e32605d round 2) — this is a ONE-OFF human delete of a
 * potentially very large build/cache tree, with no later sweep ever revisiting it, so the budget is sized
 * for a genuinely SLOW removal, not a wedge. Unlike `fs.promises.rm`/the libuv threadpool, a long budget
 * here pins no daemon resource while it waits: `killableRemoveDir` runs a disposable CHILD process, so the
 * only cost of a long timeout is the human-only `DELETE /api/projects/:id/permanent` response taking
 * longer to settle in the pathological (actually wedged) case — never a threadpool slot, never another
 * daemon operation. 10 minutes.
 */
const DELETE_PROJECT_WORK_DIR_TIMEOUT_MS = 600_000;

/** Attempts for a CLEAN (settled, non-killed) removal reject — a transient EBUSY/EPERM handle-lag right
 *  after the last session/gate for this project exits, which SETTLES quickly and is worth a couple of
 *  short retries given this is a ONE-OFF human delete with no later sweep to clean up after a failure. A
 *  genuinely KILLED (wedged) removal is NEVER retried — see {@link deleteProjectWorkDir}'s own doc and
 *  the bd9fc808 decision record. Mirrors `removeWorktree`'s own `REMOVE_DIR_CLEAN_RETRY_ATTEMPTS`/
 *  `REMOVE_DIR_CLEAN_RETRY_DELAY_MS` (git/worktrees.ts), minus that function's worktree-specific
 *  `abortIfClaimed` check, which has no equivalent here. */
const DELETE_PROJECT_WORK_DIR_CLEAN_RETRY_ATTEMPTS = 3;
const DELETE_PROJECT_WORK_DIR_CLEAN_RETRY_DELAY_MS = 500;

/**
 * PERMANENTLY remove one project's work dir (card 5eace211, bound + made killable by card 8e32605d) — the
 * irreversible counterpart to `ensureProjectWorkDir`, mirroring `deleteProjectArchives`'s own best-effort
 * contract (`gateway/server.ts`): called ONLY from the permanent-delete path, AFTER the caller has
 * confirmed no session or gate for this project is still live (see `SessionService.hasLiveGateForProject`)
 * — never from the soft-archive path, which keeps the dir (see that route's own size-report instead).
 *
 * @decision 8e32605d — never route this back through `fs.promises.rm`/the libuv threadpool (bd9fc808).
 * Never retry a KILLED (wedged) or REJECTED (never-started) removeDir outcome — only a clean, settled,
 * non-killed failure gets the retry (the loop itself now lives in `removeDirWithCleanRetry`, card c2fc8d84).
 */
export async function deleteProjectWorkDir(
  projectId: string,
  deps: DeleteProjectWorkDirDeps = {},
): Promise<void> {
  const dir = projectWorkDir(projectId);
  if (!isSingleProjectSegmentUnderRoot(PROJECTS_WORK_ROOT, dir, projectId)) {
    // eslint-disable-next-line no-console
    console.warn(`[projects] deleteProjectWorkDir REFUSED — projectId is not a single UUID-shaped path segment directly under PROJECTS_WORK_ROOT: ${JSON.stringify(projectId)}`);
    return;
  }

  const outcome = await removeDirWithCleanRetry(dir, {
    timeoutMs: deps.timeoutMs ?? DELETE_PROJECT_WORK_DIR_TIMEOUT_MS,
    attempts: DELETE_PROJECT_WORK_DIR_CLEAN_RETRY_ATTEMPTS,
    delayMs: DELETE_PROJECT_WORK_DIR_CLEAN_RETRY_DELAY_MS,
    removeDir: deps.removeDir,
  });
  if (!outcome.result.removed) {
    const reason = outcome.kind === "rejected"
      ? `removal failed to start: ${outcome.rejectionMessage}`
      : outcome.kind === "wedged" ? "genuinely wedged — killed the removal child" : "clean failure after retries";
    // A human permanent-delete has no later sweep to retry this — this warning is the only trail.
    // eslint-disable-next-line no-console
    console.warn(`[projects] deleteProjectWorkDir COULD NOT remove the work dir for project ${projectId} (${reason}): ${dir} left on disk.`);
  }
}
