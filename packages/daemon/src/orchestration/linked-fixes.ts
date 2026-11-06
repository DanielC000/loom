import type { Project, Task } from "@loom/shared";
import { columnKeyForRole, resolveConfig } from "@loom/shared";
import type { Db } from "../db.js";
import { getTaskMergedInfo, type MergedCommitInfo } from "../git/worktrees.js";

/** Most-recent triage links examined per refresh — bounds the per-refresh work on a long-lived Lead board. */
export const LINKED_FIXES_MAX_LINKS = 50;
/** Ids named in the nudge line before it collapses to "+N more". */
export const LINKED_FIXES_LIST_CAP = 8;

/**
 * Resolve an escalation's linked destination card to its project, task and git-derived merged state. The
 * ONE place that join lives: `escalation_status` (`sessions/service.ts`) and the Lead's idle nudge both
 * call it, so the two can never disagree on what "the linked fix merged" means. `merged` is null when
 * the fix is not PROVEN merged (never merged, outside the scan window, or a git read failure).
 */
export async function resolveEscalationDestMerged(
  db: Db,
  link: { destinationProjectId: string; destinationTaskId: string },
): Promise<{ destProject: Project | undefined; destTask: Task | undefined; merged: MergedCommitInfo | null }> {
  const destProject = db.getProject(link.destinationProjectId);
  const destTask = db.getTask(link.destinationTaskId);
  // Both ledgers are scoped to the destination task's own repoKey (the branch-gone ledger gate, and the
  // steady-state post-finalize read of a possibly different project's repo).
  const destRepoKey = destTask?.repoKey ?? "primary";
  const merged = destProject ? await getTaskMergedInfo(destProject.repoPath, link.destinationTaskId, {
    goneBranchLedger: db.getGoneBranchLedgerFacts(destProject.id, destRepoKey),
    workerTipLedger: db.getWorkerTipLedgerFacts(destProject.id, destRepoKey),
  }) : null;
  return { destProject, destTask, merged };
}

/**
 * Platform escalation cards on `platformProjectId`'s board that are NOT yet in its terminal column but
 * whose linked fix (via `resolvesEscalation`) has MERGED on its own board. A Lead's own board counts can't
 * move when the resolving work lands on another board; this is the cross-board signal. Cost per call: one
 * SQL read, plus per link a `getTaskMergedInfo` read. That read is served from a per-(repo, HEAD) cached
 * merged-commit map, so a cache hit is an in-memory lookup, but a cold cache (first call, or any HEAD move
 * on a destination repo) costs one `git log -n 5000` per distinct destination repo, and a map hit is then
 * verified against git (content / path-set) before it counts as merged. Callers must therefore throttle
 * it. At most {@link LINKED_FIXES_MAX_LINKS} open links are examined. A link whose resolution throws is
 * skipped, never fatal.
 */
export async function findPlatformCardsWithMergedFixes(
  db: Db,
  platformProjectId: string,
): Promise<string[]> {
  const project = db.getProject(platformProjectId);
  if (!project) return [];
  const terminalKey = columnKeyForRole(resolveConfig(project.config).kanbanColumns, "terminal");
  const links = db.listEscalationTriageLinks(platformProjectId, terminalKey, LINKED_FIXES_MAX_LINKS);
  const out: string[] = [];
  for (const l of links) {
    try {
      const { merged } = await resolveEscalationDestMerged(db, l);
      if (merged) out.push(l.escalationTaskId);
    } catch { /* one unreadable link must not hide the others */ }
  }
  return out;
}

/** Nudge suffix for the Lead's idle message; "" at N=0 so a quiet board adds no noise. */
export function formatLinkedFixesLine(ids: readonly string[]): string {
  if (ids.length === 0) return "";
  const shown = ids.slice(0, LINKED_FIXES_LIST_CAP).map((id) => id.slice(0, 8)).join(", ");
  const more = ids.length > LINKED_FIXES_LIST_CAP ? `, +${ids.length - LINKED_FIXES_LIST_CAP} more` : "";
  return `[loom:linked-fixes] ${ids.length} Platform card${ids.length === 1 ? " has a" : "s have"} linked fix${ids.length === 1 ? "" : "es"} merged: ${shown}${more}.`;
}
