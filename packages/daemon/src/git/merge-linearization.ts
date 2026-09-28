import type { SimpleGit } from "simple-git";
import { withTimeout } from "./bounded.js";

// The ONE definition of "may this merge commit be skipped when a branch's own commits are replayed onto main?" — shared by `merge_batch`'s landing (batch-merge.ts) and by the owed-commit
// computation for a HELD branch (`computeOwedLanding`, worktrees.ts, card 13fc5227), so the two replay paths cannot drift (card bc2240d7: skipping a merge that carries resolution content
// silently loses it).

/** Bound on how many merge commits one branch may carry before it is dropped unexamined (each is up to
 *  three bounded git calls). */
export const MAX_MERGE_COMMITS_CHECKED = 20;

/** `undefined` when merge commit `mergeSha` is a pure main-forward that landing may skip; otherwise
 *  the failing condition, worded for the drop reason. Fails CLOSED: any git error returns a reason.
 *  (i) every non-first parent must be an ancestor of `mainRef`; (ii) `git diff-tree --cc` must be empty
 *  (card bc2240d7 — see batch-merge.ts's file header). */
export async function mergeCommitBlocksLinearization(
  git: Pick<SimpleGit, "raw">, mergeSha: string, mainRef: string, timeoutMs: number,
): Promise<string | undefined> {
  let parents: string[];
  try {
    parents = (await withTimeout(
      git.raw(["rev-list", "--parents", "-n", "1", mergeSha]), timeoutMs, "git rev-list --parents (batch land, merge parents)",
    )).trim().split(/\s+/).slice(1);
  } catch (e) {
    return `could not be inspected (${(e as Error).message})`;
  }
  for (const p of parents.slice(1)) {
    // Compare `merge-base` OUTPUT to the parent's full sha rather than using `--is-ancestor`: simple-git
    // resolves a non-zero exit with empty stderr as success, so `--is-ancestor`'s exit-1 "no" would read as "yes".
    let onMain: boolean;
    try {
      onMain = (await withTimeout(git.raw(["merge-base", p, mainRef]), timeoutMs, "git merge-base (batch land, parent on main)")).trim() === p;
    } catch {
      onMain = false; // no common ancestor (exit 1) or a real error — fail closed
    }
    if (!onMain) return `merges ${p.slice(0, 7)}, which is not reachable from main`;
  }
  let combined: string;
  try {
    combined = await withTimeout(
      git.raw(["diff-tree", "--cc", "--no-commit-id", "-p", "-r", mergeSha]), timeoutMs, "git diff-tree --cc (batch land, resolution content)",
    );
  } catch (e) {
    return `could not be checked for resolution content (${(e as Error).message})`;
  }
  if (combined.trim() !== "") return "carries conflict-resolution content of its own";
  return undefined;
}
