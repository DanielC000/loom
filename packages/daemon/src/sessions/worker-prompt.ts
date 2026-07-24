import type { Project, RepoRegistryEntry } from "@loom/shared";
import type { ResolvedRepo } from "../projects/resolve-repo.js";
import type { ReusedDirtyWorktreeInfo, StaleBaseInfo } from "../git/worktrees.js";

/**
 * What a REVIEW-ONLY spawn (card 47bbdc3f) needs mechanically injected into its kickoff — the
 * server-resolved branch + tip sha this worker's OWN branch was cut FROM, so a manager never hand-types
 * the reviewed branch name again (the bug that let a mistyped branch review the wrong card). Present ONLY
 * when `worker_spawn` was called with `reviewOfWorkerSessionId`/`reviewOfTaskId`; every other spawn omits
 * it and its prompt is byte-identical to before this existed.
 */
export interface ReviewOfInfo {
  /** The reviewed branch name (e.g. `loom/abc123`). */
  branch: string;
  /** That branch's tip commit sha AT SPAWN TIME — a pinned snapshot, not a live pointer (see the block's
   *  own text: the worker is told explicitly that a later push to the reviewed branch is NOT reflected). */
  headSha: string;
}

/**
 * What a worker needs to know about a MULTI-REPO project's writable registry (multi-repo epic 49136451,
 * phase 3). Supplied ONLY when the project actually has a registry — a single-repo project passes
 * `undefined` and the whole block is omitted, so its prompt is byte-identical to before this existed.
 *
 * `targetKey` is the repo THIS worker's worktree was cut from: `null` = the project's primary repo, same
 * convention as `Task.repoKey`/`Session.repoKey`. It is deliberately the SESSION's stamped key, not the
 * task's current one — a manager may retarget the card after the worktree already exists, and the
 * worktree is physically rooted in the repo it was cut from (see `Session.repoKey`'s own doc).
 *
 * `targetGateCommand` is that repo's OWN gate, and `undefined` genuinely means "this repo has no gate
 * configured" — it does NOT fall back to the project-level command, by design (a gate that exits 0 for
 * an unrelated reason would report a FALSE green on code it never tested). The block says so explicitly,
 * because "will my work be verified?" is the single fact a worker most needs from the registry.
 */
export interface WorkerRepoContext {
  targetKey: string | null;
  targetPath: string;
  targetGateCommand?: string;
  registry: RepoRegistryEntry[];
}

/**
 * Build the {@link WorkerRepoContext} for a worker spawn from an ALREADY-RESOLVED repo — returns
 * `undefined` (⇒ no block at all) for a project with no registry, which is the single-repo case and must
 * stay byte-identical.
 *
 * Takes a {@link ResolvedRepo} rather than a raw key on purpose: resolution is the caller's job because
 * WHICH key to resolve differs by call site and getting it wrong is the bug this epic's phase 2 exists to
 * prevent. A fresh spawn resolves the TASK's key (it is about to stamp that onto the new session); a
 * recycle resolves the SESSION's own stamped key, because the worktree it is reusing is physically rooted
 * in whatever repo it was originally cut from. Handing this function a pre-resolved repo keeps that
 * decision visible at each call site instead of hiding it behind a shared default.
 */
export function buildWorkerRepoContext(
  project: Pick<Project, "repos">,
  resolved: ResolvedRepo,
): WorkerRepoContext | undefined {
  if (project.repos.length === 0) return undefined;
  return {
    targetKey: resolved.key === "primary" ? null : resolved.key,
    targetPath: resolved.path,
    targetGateCommand: resolved.gateCommand,
    registry: project.repos,
  };
}

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
 *
 * `staleBase` (board card 5150fdc2, part 2) is likewise OPTIONAL: `undefined` omits the block entirely
 * (a fresh branch, a 0-ahead branch, or a stale branch that was auto-forwarded cleanly never sets it — see
 * `createWorktree`'s `resolveStaleBase`). When present, a forward-merge note is injected naming how many
 * commits behind main this branch's base is and what changed on main since — the fix for the incident
 * this card exists to close: a re-spawn onto a commits-ahead branch used to silently keep building on its
 * ORIGINAL fork point forever, with no signal to the worker that main had moved on.
 *
 * `reviewOf` (card 47bbdc3f) is likewise OPTIONAL: `undefined` omits the block entirely (every non-review
 * spawn stays byte-identical). When present (this worker's OWN branch was cut from the tip of a reviewed
 * branch via `reviewOfWorkerSessionId`/`reviewOfTaskId` — see `spawnWorker`'s `reviewForkFrom`), a block
 * names that branch + sha SO THE MANAGER NEVER HAND-TYPES IT AGAIN, and says explicitly that this
 * worktree's content already IS that reviewed branch's committed tip — ordinary Read/Grep is correct by
 * construction, no `git show`/diff gymnastics needed — while also flagging that it's a PINNED SNAPSHOT
 * (a later push to the reviewed branch is not reflected without a fresh spawn).
 */
export function composeWorkerStartupPrompt(
  brief: string | undefined,
  dynamicPart: string,
  cwd?: string,
  referenceRepos?: string[],
  reusedDirtyWorktree?: ReusedDirtyWorktreeInfo,
  staleBase?: StaleBaseInfo,
  repoContext?: WorkerRepoContext,
  reviewOf?: ReviewOfInfo,
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
  // Multi-repo epic 49136451, phase 3. Emitted whenever the project HAS a registry — including when this
  // task targets the primary repo, because a worker on the primary of a multi-repo project still needs to
  // know the other repos exist and are not its own (that is exactly the worker who would otherwise wander
  // into one). Omitted entirely for a project with no registry.
  const repoBlock = repoContext
    ? (() => {
        const targetLabel = repoContext.targetKey ?? "primary";
        const others = repoContext.registry.filter((r) => r.key !== repoContext.targetKey);
        const otherLines = [
          ...(repoContext.targetKey === null ? [] : [`- \`primary\` — the project's primary repo`]),
          ...others.map((r) => `- \`${r.key}\` — \`${r.path}\``),
        ];
        return (
          `\n\n**This task targets the \`${targetLabel}\` repo** (\`${repoContext.targetPath}\`) — the worktree above was ` +
          "cut FROM that repo, and your branch, your gate and your merge all land there.\n\n" +
          (repoContext.targetGateCommand
            ? `Your \`run_gate\` self-check and the merge gate both run THIS repo's own gate command (\`${repoContext.targetGateCommand}\`).`
            : "This repo has NO gate command configured, so a merge here is reported as **unverified**. It does " +
              "not fall back to another repo's gate — a gate that passed for an unrelated repo would look like " +
              "verification without being any. Test your change by hand, and say plainly in your report what you " +
              "ran and what is unverified.") +
          (otherLines.length > 0
            ? "\n\n**Other repos registered on this project (NOT yours for this task):**\n" + otherLines.join("\n")
            : "") +
          "\n\n**One task = one repo.** You never choose or change which repo a task targets — that is your " +
          "manager's dispatch decision. If your task turns out to need a change in another registered repo, " +
          "that is a SEPARATE card: report it up via `worker_report` and let your manager sequence a sibling " +
          "task there. Do not edit or commit in another repo's working tree from here."
        );
      })()
    : "";
  const dirtyBlock = reusedDirtyWorktree
    ? "\n\n**⚠ Reused worktree — reconcile before you start:** this worktree was REUSED from a prior " +
      "hard-stopped (or rejected-merge) attempt on this task and still has uncommitted changes " +
      `(run \`git status\`):\n\n\`\`\`\n${reusedDirtyWorktree.statusSummary}\n\`\`\`\n` +
      (reusedDirtyWorktree.truncated ? `\n(${reusedDirtyWorktree.fileCount} paths total — showing the first ones)\n` : "") +
      "\nFinish that work if it's good, or revert it (`git checkout .` / `git clean -fd`) before you make " +
      "any new edits — reconcile BEFORE building on top of an unreviewed leftover."
    : "";
  const staleBlock = staleBase
    ? "\n\n**⚠ Stale branch base — merge the mainline forward before building:** your branch's history is " +
      `${staleBase.behindBy} commit(s) behind the project's current mainline tip (this branch forked at ` +
      `\`${staleBase.baseSha}\`). Merge (or rebase) the mainline forward into your branch BEFORE you start ` +
      "editing — building on a stale base risks silently reverting or conflicting with work that landed " +
      "on the mainline after this branch was cut." +
      (staleBase.changedFiles.length > 0
        ? "\n\nFiles changed on the mainline since this branch's fork point:\n\n```\n" +
          `${staleBase.changedFiles.join("\n")}\n\`\`\`\n` +
          (staleBase.truncated ? `\n(showing the first ${staleBase.changedFiles.length} — more files changed)\n` : "")
        : "")
    : "";
  const reviewBlock = reviewOf
    ? "\n\n**🧐 This is a REVIEW spawn — your worktree already IS the reviewed content:** your own branch " +
      `above was cut from the TIP of \`${reviewOf.branch}\` at commit \`${reviewOf.headSha}\` — NOT from ` +
      "the project's mainline. Ordinary `Read`/`Grep` against your worktree already shows the reviewed " +
      "branch's code; you do NOT need `git show <branch>:<path>` or a manual diff against another tree " +
      "to see the right content. This is a PINNED SNAPSHOT taken at spawn time, not a live pointer — if " +
      "the author has pushed further commits to that branch since, this worktree will not reflect them; " +
      "say so in your report if the timing matters, and ask for a fresh review spawn if you need the " +
      "latest tip."
    : "";
  return `${block}${refBlock}${repoBlock}${dirtyBlock}${staleBlock}${reviewBlock}\n\n${body}`;
}
