import type { Db } from "../db.js";
import { isGitRepo } from "../git/reader.js";

/**
 * Result of the elevated/human repoPath rebind guard. `ok:false` carries a human-readable `error`
 * plus, when the block is the live-worktree guard, the offending `liveSessions` so the caller can
 * name them in a structured response.
 */
export type RebindCheck =
  | { ok: true }
  | { ok: false; error: string; liveSessions?: Array<{ sessionId: string; branch: string | null; worktreePath: string }> };

/**
 * The SHARED guard for rebinding a project's `repoPath` — used by BOTH the elevated platform MCP
 * (project_update) and the human REST PATCH path so they validate identically. repoPath is otherwise
 * create-time-only; this is the one place it changes, and both gates are fail-closed:
 *
 *  (1) `repoPath` MUST be an existing git repository (`isGitRepo`) — EXACTLY like project_create /
 *      POST /api/projects validate it; a non-repo is rejected before binding.
 *  (2) Refuse while the project has any LIVE session occupying a worktree. Rebinding the repo would
 *      strand those worktrees (they hang off the OLD repo); the offending sessions are named so the
 *      operator can stop them first. This is a structural-safety block, not a permission check —
 *      the surface is already human/elevated-only.
 */
export async function checkRepoRebind(db: Db, projectId: string, repoPath: string): Promise<RebindCheck> {
  if (!(await isGitRepo(repoPath))) {
    return { ok: false, error: `repoPath is not an existing git repository: ${repoPath}` };
  }
  const live = db.listLiveWorktreeSessionsInProject(projectId);
  if (live.length > 0) {
    const sessions = live.map((s) => ({ sessionId: s.id, branch: s.branch ?? null, worktreePath: s.worktreePath as string }));
    const named = sessions.map((s) => s.sessionId).join(", ");
    return {
      ok: false,
      error: `cannot rebind repoPath while ${live.length} live worktree session(s) exist for this project — stop them first (${named})`,
      liveSessions: sessions,
    };
  }
  return { ok: true };
}
