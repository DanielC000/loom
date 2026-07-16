import type { ReusedDirtyWorktreeInfo } from "../git/worktrees.js";

/**
 * Card af902717 — compose a WORKER session's opening from its agent BASE BRIEF + the dynamic part.
 *
 * Before this, a manager-spawned worker only ever received the dynamic text (the manager's kickoff on
 * spawn, the `[loom:handoff]…` summary on recycle); its agent's `startupPrompt` (the Dev/Bugfix/Web
 * Designer brief — "Step 0: run `/worker`", "CLAUDE.md is law", reproduce-first) was DEAD config in the
 * orchestrated flow. The manager path already composed its brief (`composeManagerStartupPrompt`); this
 * is the worker mirror.
 *
 * Order: a worktree LOCATION block FIRST, then the agent BASE BRIEF, then the dynamic part (kickoff /
 * handoff) — the location block names the worker's edit dir, the brief is the standing doctrine, the
 * dynamic part is the specific task to act on. An empty/whitespace brief ⇒ the block leads the dynamic
 * part ALONE. PURE + exported so the hermetic test can assert the composition.
 *
 * The location block mirrors `composeManagerStartupPrompt`'s shape and exists for the same class of bug:
 * nothing in a worker's context names its WORKTREE, so an absolute main-repo path elsewhere in its
 * context (e.g. an agent brief) out-prioritizes the actual worktree cwd and the worker leaks edits into
 * the main checkout. Naming the worktree as the edit dir, present even on an empty brief, is the guard.
 *
 * `cwd` is OPTIONAL and backward-compatible: when it's falsy/omitted, the OLD output is returned verbatim
 * (no block) — so the pure-function callers/tests that pass only `(brief, dynamicPart)` stay byte-stable.
 *
 * `referenceRepos` (reference-repos epic Phase 3, "Interpretation A") is likewise OPTIONAL: an
 * undefined/empty list omits the block entirely, so every existing caller stays byte-identical. When
 * non-empty, it names each project-configured reference repo as a READ-ONLY target the worker may
 * inspect — never a cwd, worktree base, or commit/gate target (that stays `cwd` alone). Mirrors the
 * manager's block in `composeManagerStartupPrompt`.
 *
 * `reusedDirtyWorktree` (board card 2250836c) is likewise OPTIONAL: `undefined` omits the block entirely
 * (byte-identical to before this param existed — a fresh worktree or a clean reuse never sets it). When
 * present (this spawn REUSED a worktree retained from a prior hard-stopped/rejected-merge attempt, and it
 * still carries real leftover uncommitted work), a reconcile note is injected naming the leftover paths —
 * this is what removes the need for a manager to hand-instruct a `git status; reconcile` note on every
 * retry (the finding this card fixes).
 */
export function composeWorkerStartupPrompt(
  brief: string | undefined,
  dynamicPart: string,
  cwd?: string,
  referenceRepos?: string[],
  reusedDirtyWorktree?: ReusedDirtyWorktreeInfo,
): string {
  const base = brief?.trim();
  const body = base ? `${base}\n\n---\n\n${dynamicPart}` : dynamicPart;
  const location = cwd?.trim();
  if (!location) return body;
  const block =
    "## Where you edit (your isolated git worktree)\n" +
    `- **Your worktree (make ALL edits here, never the main checkout):** \`${location}\`\n\n` +
    "This worktree IS your cwd. If anything else in your context names the main repo path, that's for " +
    "reference, not where you edit — make every change here, on your assigned branch.";
  const refs = referenceRepos?.filter((r) => r.trim());
  const refBlock = refs && refs.length > 0
    ? "\n\n**Also referenced (read-only, not your cwd):**\n" +
      refs.map((r) => `- \`${r}\``).join("\n") +
      "\n\nYou may read/inspect these repos, but never commit there — there is no worktree, branch, " +
      "or gate for a reference repo. If your task turns out to need changes IN a reference repo, that's " +
      "out of scope for this worktree; escalate it up instead of committing there."
    : "";
  const dirtyBlock = reusedDirtyWorktree
    ? "\n\n**⚠ Reused worktree — reconcile before you start:** this worktree was REUSED from a prior " +
      "hard-stopped (or rejected-merge) attempt on this task and still has uncommitted changes " +
      `(run \`git status\`):\n\n\`\`\`\n${reusedDirtyWorktree.statusSummary}\n\`\`\`\n` +
      (reusedDirtyWorktree.truncated ? `\n(${reusedDirtyWorktree.fileCount} paths total — showing the first ones)\n` : "") +
      "\nFinish that work if it's good, or revert it (`git checkout .` / `git clean -fd`) before you make " +
      "any new edits — reconcile BEFORE building on top of an unreviewed leftover."
    : "";
  return `${block}${refBlock}${dirtyBlock}\n\n${body}`;
}
