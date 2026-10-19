import path from "node:path";
import { PROJECTS_WORK_ROOT, projectWorkDir } from "../paths.js";
import { killableRemoveDir, type RemoveDirResult } from "../git/worktrees.js";

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

/** `await`able delay — used only for the short bounded clean-reject retry below. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Outcome of one {@link raceRemoval} attempt — a STRUCTURAL discrimination (which branch settled first/
 *  at all), never a message-string classification (see `git/bounded.ts`'s own `treeDeathUnconfirmed` doc
 *  for why sniffing error text is the wrong tool for exactly this kind of distinction). */
type RemovalRaceOutcome =
  | { kind: "result"; result: RemoveDirResult }
  | { kind: "timeout" }
  | { kind: "rejected"; message: string };

/**
 * Races `p` against a plain timer, but — unlike `git/bounded.ts`'s generic `withTimeout` — never
 * conflates "my own timer fired" with "the underlying promise rejected for some other reason" (manager
 * code-review follow-up, card 8e32605d round 2): a real `killableRemoveDir` call can itself reject if its
 * `spawnChild` throws SYNCHRONOUSLY inside the Promise executor (e.g. a genuinely failed `spawn()`) — that
 * is a removal that never even STARTED, not a wedge, and must never be logged as one.
 */
function raceRemoval(p: Promise<RemoveDirResult>, ms: number): Promise<RemovalRaceOutcome> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ kind: "timeout" });
    }, ms);
    p.then(
      (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: "result", result });
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ kind: "rejected", message: err instanceof Error ? err.message : String(err) });
      },
    );
  });
}

/**
 * PERMANENTLY remove one project's work dir (card 5eace211, bound + made killable by card 8e32605d) — the
 * irreversible counterpart to `ensureProjectWorkDir`, mirroring `deleteProjectArchives`'s own best-effort
 * contract (`gateway/server.ts`): called ONLY from the permanent-delete path, AFTER the caller has
 * confirmed no session or gate for this project is still live (see `SessionService.hasLiveGateForProject`)
 * — never from the soft-archive path, which keeps the dir (see that route's own size-report instead).
 *
 * @decision 8e32605d — never route this back through `fs.promises.rm`/the libuv threadpool (bd9fc808).
 * Never retry a KILLED (wedged) or REJECTED (never-started) removeDir outcome — only a clean, settled,
 * non-killed failure gets the retry below.
 */
export async function deleteProjectWorkDir(
  projectId: string,
  deps: DeleteProjectWorkDirDeps = {},
): Promise<void> {
  const dir = projectWorkDir(projectId);
  const rel = path.relative(PROJECTS_WORK_ROOT, dir);
  const isSingleSegmentUnderRoot = rel.length > 0 && rel === path.basename(rel) && !rel.startsWith("..");
  const isUuidShaped = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(projectId);
  if (!isSingleSegmentUnderRoot || !isUuidShaped) {
    // eslint-disable-next-line no-console
    console.warn(`[projects] deleteProjectWorkDir REFUSED — projectId is not a single UUID-shaped path segment directly under PROJECTS_WORK_ROOT: ${JSON.stringify(projectId)}`);
    return;
  }

  const timeoutMs = deps.timeoutMs ?? DELETE_PROJECT_WORK_DIR_TIMEOUT_MS;
  const removeDir = deps.removeDir ?? ((p, ms) => killableRemoveDir(p, ms));
  let result: RemoveDirResult = { removed: true, killed: false };
  // Set ONLY on a "rejected" (never-started) outcome — distinguishes that wording from a genuine timeout
  // at the single warn emission point below, without widening the public RemoveDirResult shape itself.
  let rejectionMessage: string | null = null;
  for (let attempt = 1; attempt <= DELETE_PROJECT_WORK_DIR_CLEAN_RETRY_ATTEMPTS; attempt++) {
    const outcome = await raceRemoval(removeDir(dir, timeoutMs), timeoutMs);
    if (outcome.kind === "timeout") {
      result = { removed: false, killed: true };
      break; // genuinely wedged — never retry
    }
    if (outcome.kind === "rejected") {
      result = { removed: false, killed: true }; // internal signal only: non-retried, same as a wedge
      rejectionMessage = outcome.message;
      break; // the removal never started — never retry
    }
    result = outcome.result;
    if (result.removed || result.killed) break; // success, or genuinely wedged — never retry a killed result
    if (attempt < DELETE_PROJECT_WORK_DIR_CLEAN_RETRY_ATTEMPTS) await delay(DELETE_PROJECT_WORK_DIR_CLEAN_RETRY_DELAY_MS);
  }
  if (!result.removed) {
    const reason = rejectionMessage !== null
      ? `removal failed to start: ${rejectionMessage}`
      : result.killed ? "genuinely wedged — killed the removal child" : "clean failure after retries";
    // A human permanent-delete has no later sweep to retry this — this warning is the only trail.
    // eslint-disable-next-line no-console
    console.warn(`[projects] deleteProjectWorkDir COULD NOT remove the work dir for project ${projectId} (${reason}): ${dir} left on disk.`);
  }
}
