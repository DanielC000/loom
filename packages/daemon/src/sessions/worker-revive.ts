/**
 * `worker_revive` (card dc13bcf1) — bring a MERGED worker's conversation back onto a FRESH worktree/branch
 * bound to a follow-up card, so its manager can instruct a fix to the landed commit.
 *
 * Mechanism (proved by a real-spawn spike against the installed engine, not assumed): the engine resolves
 * `--resume <id>` by id across every project transcript dir, so a FORK (`--resume <old> --fork-session
 * --session-id <new>`) started from ANY cwd continues the same conversation even when the source's own cwd
 * no longer exists. Loom's `resume()` refuses that case (ghost-resume guard) — a revive is therefore a
 * NEW session row that forks, never a resume of the old row.
 *
 * @decision dc13bcf1 — revive forks (the source transcript stays pristine, each Loom row owns its own
 * engine id) into a NEW follow-up card the manager filed; never reopen the merged card, never file the
 * `worker_revived` link as a recycle_* event (resume()'s hasSuccessor refusals must not fire on the source).
 */

/** Everything spawnWorker needs beyond its ordinary inputs to start a revived worker. */
export interface ReviveSpawnSpec {
  /** The MERGED source worker's Loom session id (lineage + event only; the source row is never touched). */
  sourceSessionId: string;
  /** Its engine conversation id — what `--resume` is pointed at. */
  sourceEngineSessionId: string;
  /** Fresh engine id minted for the fork (`--session-id`), persisted on the new row up front. */
  forkEngineSessionId: string;
  /** The merged card the source worker landed. */
  originalTaskId: string;
  /** The squash commit that landed it (null when the ship-state was never recorded). */
  commitSha: string | null;
}

export interface ReviveKickoffInput {
  originalTaskId: string;
  originalTaskTitle: string;
  commitSha: string | null;
  /** The old worktree path — named ONLY so the reviver can tell the worker its remembered paths are stale. */
  oldWorktreePath: string | null;
  followUpTaskId: string;
  followUpTitle: string;
  followUpBody: string;
  /** The new branch (`loom/<key>`), cut from current mainline. */
  branch: string;
  note?: string;
}

/**
 * The revive kickoff — delivered post-ready as the fork's first turn (the fork itself boots with no prompt,
 * like every spawn). It replaces the agent's base brief: the forked conversation already carries it.
 */
export function composeReviveKickoff(i: ReviveKickoffInput): string {
  const sha = i.commitSha ? `commit \`${i.commitSha}\`` : "its landed commit (the ship-state sha was not recorded — find it with `git log --grep` on the card title)";
  const oldPath = i.oldWorktreePath ? ` (\`${i.oldWorktreePath}\`)` : "";
  const note = i.note?.trim();
  return [
    "## You have been REVIVED to fix your own landed work",
    "",
    `You are the same worker that finished card \`${i.originalTaskId}\` — "${i.originalTaskTitle}". That card already MERGED as ${sha}. ` +
      `Your old worktree${oldPath} and its branch no longer exist, and the conversation above is your memory of that earlier task.`,
    "",
    `- **Every file path in your memory of that task is STALE.** Re-read a file in your CURRENT worktree before you edit or reason from it — main may also have moved since you finished.`,
    `- You are now bound to a NEW card, \`${i.followUpTaskId}\` — "${i.followUpTitle}" — on branch \`${i.branch}\`, cut from the CURRENT mainline. Commit only to this branch and report against this card.`,
    "",
    "### The follow-up card",
    i.followUpBody.trim() || "(no body — see the manager note below)",
    ...(note ? ["", "### Manager note", note] : []),
    "",
    "Fix what the follow-up card describes in the landed commit, verify it, commit, and `worker_report` as usual. If the premise is wrong (the commit is fine, or the defect lives elsewhere), say so in a `worker_report` rather than inventing a change.",
  ].join("\n");
}
