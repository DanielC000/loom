import type { Project, Task } from "@loom/shared";
import { resolveConfig } from "@loom/shared";

/**
 * The `{key, path, gateCommand}` triple every repo-scoped operation should resolve through — the ONE
 * resolver every repoPath-shaped role is meant to route through, per the multi-repo epic (49136451).
 * Phase 1 wires only the mechanical read-only callers (ship-state, spawn-time advisory); the worker
 * worktree cut / gate execution / merge / squash callsites stay on `project.repoPath` directly until
 * phase 2 threads them through here too.
 */
export interface ResolvedRepo {
  key: string;
  path: string;
  gateCommand: string | undefined;
}

/**
 * Thrown by {@link resolveRepo} when `task.repoKey` names a key that is no longer in the project's
 * `repos` registry (e.g. a human removed the entry after the task was written — write-time validation
 * at task-create/update can't prevent a LATER registry edit). Callers on a read path that must stay
 * available even for a stale card (`tasks_get`/`tasks_list`) should catch this and degrade to the
 * primary repo rather than propagate — see `mcp/tasks.ts` `resolveMergedInfo`.
 */
export class UnknownRepoKeyError extends Error {
  constructor(public readonly repoKey: string, public readonly projectId: string) {
    super(`repoKey "${repoKey}" does not name a registered repo on project ${projectId}`);
    this.name = "UnknownRepoKeyError";
  }
}

/**
 * Resolve which repo a task (or a taskless/general project operation) targets: `task.repoKey` → the
 * matching `project.repos` entry, else the project's PRIMARY repo (`repoPath` + the project-level
 * resolved `orchestration.gateCommand`). `task` omitted, or `task.repoKey` null/undefined/`"primary"`,
 * always resolves to primary — this is the byte-identical path every existing single-repo project takes
 * today, unchanged.
 *
 * A registry hit returns the ENTRY'S OWN `gateCommand` verbatim (possibly `undefined`) — deliberately
 * NOT falling back to the project-level gate (see `RepoRegistryEntry`'s doc: different repos need
 * different toolchains, and inheriting an unrelated command risks a false-green "pass" on a repo it
 * never actually tested). An `undefined` gateCommand here is meant to flow into the SAME "unverified: no
 * gateCommand" merge warning a gateless project gets today, not be silently treated as "no gate needed".
 *
 * Throws {@link UnknownRepoKeyError} if `task.repoKey` is set but names no entry in the CURRENT registry
 * (stale data — the entry existed at write time but was later removed). Callers on a must-stay-available
 * read path should catch this explicitly; write/spawn paths should let it propagate as a real error.
 */
export function resolveRepo(project: Project, task?: Pick<Task, "repoKey"> | null): ResolvedRepo {
  const repoKey = task?.repoKey;
  if (repoKey === undefined || repoKey === null || repoKey === "primary") {
    return {
      key: "primary",
      path: project.repoPath,
      gateCommand: resolveConfig(project.config).orchestration.gateCommand || undefined,
    };
  }
  const entry = project.repos.find((r) => r.key === repoKey);
  if (!entry) throw new UnknownRepoKeyError(repoKey, project.id);
  return { key: entry.key, path: entry.path, gateCommand: entry.gateCommand };
}
