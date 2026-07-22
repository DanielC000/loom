import fs from "node:fs";
import type { Db } from "../db.js";
import type { Project } from "@loom/shared";
import { isGitRepo } from "../git/reader.js";
import { branchExistsInRepo } from "../git/worktrees.js";
import { resolveRepoByKey, UnknownRepoKeyError } from "./resolve-repo.js";

/**
 * Result of a live-worktree-session guard (repoPath rebind, `repos` registry edit, or `task.repoKey`
 * retarget). `ok:false` carries a human-readable `error` plus, when the block is the live-worktree
 * guard, the offending `liveSessions` so the caller can name them in a structured response.
 */
export type RebindCheck =
  | { ok: true }
  | { ok: false; error: string; liveSessions?: Array<{ sessionId: string; branch: string | null; worktreePath: string }> };

/** The `{sessionId, branch, worktreePath}` projection {@link checkLiveWorktreeSessions} reports. */
function liveWorktreeSessionsFor(db: Db, projectId: string) {
  return db.listLiveWorktreeSessionsInProject(projectId)
    .map((s) => ({ sessionId: s.id, branch: s.branch ?? null, worktreePath: s.worktreePath as string }));
}

/**
 * The SHARED live-worktree-session refusal, PROJECT-WIDE — the query+shape both unscoped WRITE paths that
 * could strand a worktree reuse, so neither hand-rolls its own live-session scan:
 *  - {@link checkRepoRebind} — a `repoPath` rebind: the WHOLE project's worktrees hang off the old
 *    primary, so ANY live worktree session blocks it, not just one task's.
 *  - a `repos` registry edit (gateway/server.ts PATCH /api/projects/:id) — repathing/removing ANY entry
 *    could strand a worktree cut from it, and registry edits are rare/human-only, so the blanket policy
 *    costs little for real safety (mirrors checkRepoRebind's own policy rather than a precise per-key diff).
 *
 * A `task.repoKey` retarget does NOT use this — see {@link checkTaskRepoKeyRebind} instead: it must be
 * scoped to the ONE task (an unrelated task's live worktree must never block a different task's retarget)
 * AND must catch a worktree/branch that OUTLIVES its session's `process_state` (a rejected merge or
 * `worker_stop` RETAINS both by design), which this live-only, project-wide check cannot express.
 *
 * WRITE-PATH ONLY. A READ/RECOVERY path (ship-state's `resolveMergedInfo`, boot-reconcile) must NEVER
 * call this — those degrade on a stale/missing repo (catch {@link UnknownRepoKeyError} and fall back to
 * primary, or skip-and-warn) instead of blocking; only a human/manager-initiated WRITE that could orphan
 * a live worktree gets refused outright. Keep that asymmetry — don't "unify" the two postures later.
 */
export function checkLiveWorktreeSessions(db: Db, projectId: string): RebindCheck {
  const sessions = liveWorktreeSessionsFor(db, projectId);
  if (sessions.length === 0) return { ok: true };
  const named = sessions.map((s) => s.sessionId).join(", ");
  return {
    ok: false,
    error: `cannot make this change while ${sessions.length} live worktree session(s) exist for this project — stop them first (${named})`,
    liveSessions: sessions,
  };
}

/**
 * The `task.repoKey` retarget guard (multi-repo epic 49136451 phase 2 — Code Review Major 1 fix).
 *
 * WHY THIS IS WIDER THAN {@link checkLiveWorktreeSessions}: that check only matches
 * `process_state='live'`, but a worktree/branch OUTLIVES its session's live-ness by design — a rejected
 * merge (`confirmWorkerMerge` returns early WITHOUT deleting on every reject path) and a plain
 * `worker_stop` both RETAIN the worktree + branch on disk so the manager can recover/re-task. The
 * reachable bug this closes: worker on task T commits → merge rejected (gate failure) → worktree+branch
 * retained → manager stops the worker (now `exited`) → manager retargets `task.repoKey` (the live-only
 * guard doesn't fire — the session isn't live) → manager later re-confirms the merge on that SAME
 * session → the merge correctly lands on the SESSION's stamped (OLD) repo, but ship-state now scans the
 * task's CURRENT (NEW) repoKey — the card reads as never-merged, permanently, with no error anywhere.
 * Exactly the divergence this whole phase exists to prevent, just reached through the exited-not-live gap.
 *
 * So this checks, per session EVER bound to `taskId` (any `process_state`) that was ever handed a
 * worktree ({@link Db.listWorktreeSessionsForTask}): (a) does its worktree dir still exist on disk, or
 * (b) does its branch still exist in the repo it was cut from (a worktree can be gone — e.g. a Windows
 * handle-lag GC — while the branch survives, since `deleteBranch` only ever runs from a SUCCESSFUL
 * `finalizeMerge`). Either signal blocks the retarget. A session whose OWN stamped `repoKey` no longer
 * resolves (its registry entry was independently removed — the project-wide `repos` guard stays
 * live-only, see {@link checkLiveWorktreeSessions}'s doc, so this IS reachable) fails CLOSED: we can't
 * check its branch without knowing which repo to ask, so it blocks rather than silently waving through.
 *
 * Scoped to `taskId` ONLY (unlike the project-wide guards above) — an unrelated task's retained worktree
 * must never block a different task's retarget.
 */
export async function checkTaskRepoKeyRebind(db: Db, project: Project, taskId: string): Promise<RebindCheck> {
  const candidates = db.listWorktreeSessionsForTask(taskId);
  const blocking: Array<{ sessionId: string; branch: string | null; worktreePath: string }> = [];
  for (const s of candidates) {
    const worktreePath = s.worktreePath as string;
    if (fs.existsSync(worktreePath)) {
      blocking.push({ sessionId: s.id, branch: s.branch ?? null, worktreePath });
      continue;
    }
    if (!s.branch) continue; // worktree gone, no branch to check further — nothing left holding work
    let repoPath: string;
    try {
      repoPath = resolveRepoByKey(project, s.repoKey).path;
    } catch (e) {
      if (!(e instanceof UnknownRepoKeyError)) throw e;
      blocking.push({ sessionId: s.id, branch: s.branch, worktreePath }); // can't verify — fail closed
      continue;
    }
    if (await branchExistsInRepo(repoPath, s.branch)) {
      blocking.push({ sessionId: s.id, branch: s.branch, worktreePath });
    }
  }
  if (blocking.length === 0) return { ok: true };
  const named = blocking.map((s) => s.sessionId).join(", ");
  return {
    ok: false,
    error: `cannot change repoKey while ${blocking.length} session(s) for this task still hold a worktree on disk or an undeleted branch — stop/clean them up first (${named})`,
    liveSessions: blocking,
  };
}

/**
 * The SHARED guard for rebinding a project's `repoPath` — used by BOTH the elevated platform MCP
 * (project_update) and the human REST PATCH path so they validate identically. repoPath is otherwise
 * create-time-only; this is the one place it changes, and both gates are fail-closed:
 *
 *  (1) `repoPath` MUST be an existing git repository (`isGitRepo`) — EXACTLY like project_create /
 *      POST /api/projects validate it; a non-repo is rejected before binding.
 *  (2) Refuse while the project has any LIVE session occupying a worktree ({@link checkLiveWorktreeSessions},
 *      unscoped — see its doc). Rebinding the repo would strand those worktrees (they hang off the OLD
 *      repo); the offending sessions are named so the operator can stop them first. This is a
 *      structural-safety block, not a permission check — the surface is already human/elevated-only.
 */
export async function checkRepoRebind(db: Db, projectId: string, repoPath: string): Promise<RebindCheck> {
  if (!(await isGitRepo(repoPath))) {
    return { ok: false, error: `repoPath is not an existing git repository: ${repoPath}` };
  }
  const check = checkLiveWorktreeSessions(db, projectId);
  if (!check.ok) {
    return { ...check, error: `cannot rebind repoPath while ${check.liveSessions!.length} live worktree session(s) exist for this project — stop them first (${check.liveSessions!.map((s) => s.sessionId).join(", ")})` };
  }
  return check;
}
