import type { Db } from "../db.js";
import type { Agent, Project, StalePromptWarning } from "@loom/shared";

/** One field of a project WRITE that actually changed, carrying the value it's moving AWAY from. */
interface RenameFieldChange {
  field: "name" | "repoPath" | "vaultPath";
  oldValue: string;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Matches an OLD PATH (repoPath/vaultPath) as a literal substring, separator-normalized (`\` -> `/`)
 * so a prompt quoting it with the opposite slash style (Windows vs POSIX) still matches. An absolute
 * path is inherently unambiguous — no anchoring needed, false-positive risk is negligible.
 */
function matchesStalePath(prompt: string, oldPath: string): boolean {
  const norm = (s: string) => s.replace(/\\/g, "/");
  return norm(prompt).includes(norm(oldPath));
}

/**
 * Matches an OLD PROJECT NAME only in load-bearing shapes — never a bare substring, which would
 * false-positive on a short/common name and on a prompt that legitimately narrates project history
 * ("formerly known as X"). Two shapes count:
 *  (a) the name as a FULL PATH SEGMENT bounded by `/`, `\`, or a string edge — catches
 *      `Projects/<name>/…`, `GitHub/<name>`, `<name>/Orchestrator Log.md`, generically, without
 *      hardcoding "Projects/". A rename to a superset name (Invest -> Investments) does NOT
 *      false-positive: "Investments/" has no `/` immediately after "Invest", so the boundary fails.
 *  (b) `/pickup <name>` (word-boundary) — the doctrine skill-invocation self-orientation reference.
 * Case-sensitive on purpose: the value was stamped verbatim by whatever composed the prompt, and
 * loosening case would only raise the false-positive rate on a name that also reads as an ordinary word.
 */
function matchesStaleName(prompt: string, oldName: string): boolean {
  const escaped = escapeRegExp(oldName);
  const normalized = prompt.replace(/\\/g, "/");
  const pathSegment = new RegExp(`(^|/)${escaped}(?=/|$)`, "m");
  const pickup = new RegExp(`/pickup\\s+${escaped}\\b`);
  return pathSegment.test(normalized) || pickup.test(prompt);
}

/** Which of `name`/`repoPath`/`vaultPath` actually changed value on this write (old non-empty, old !== new). */
function computeRenameChanges(
  oldProject: Pick<Project, "name" | "repoPath" | "vaultPath">,
  patch: { name?: string; repoPath?: string; vaultPath?: string },
): RenameFieldChange[] {
  const changes: RenameFieldChange[] = [];
  if (patch.name !== undefined && oldProject.name && patch.name !== oldProject.name) {
    changes.push({ field: "name", oldValue: oldProject.name });
  }
  if (patch.repoPath !== undefined && oldProject.repoPath && patch.repoPath !== oldProject.repoPath) {
    changes.push({ field: "repoPath", oldValue: oldProject.repoPath });
  }
  if (patch.vaultPath !== undefined && oldProject.vaultPath && patch.vaultPath !== oldProject.vaultPath) {
    changes.push({ field: "vaultPath", oldValue: oldProject.vaultPath });
  }
  return changes;
}

/** Scan a set of agents' startupPrompts against a list of changed fields; pure, no I/O. */
function lintStalePrompts(
  agents: Array<Pick<Agent, "id" | "name" | "startupPrompt">>,
  changes: RenameFieldChange[],
): StalePromptWarning[] {
  const warnings: StalePromptWarning[] = [];
  for (const agent of agents) {
    const prompt = agent.startupPrompt;
    if (!prompt) continue;
    const staleFields = changes
      .filter(({ field, oldValue }) => (field === "name" ? matchesStaleName(prompt, oldValue) : matchesStalePath(prompt, oldValue)))
      .map((c) => c.field);
    if (staleFields.length > 0) warnings.push({ agentId: agent.id, agentName: agent.name, staleFields });
  }
  return warnings;
}

/**
 * On a project rename / repoPath (or vaultPath) change, scan every agent's `startupPrompt` for the OLD
 * value(s) so a rename can't silently strand a stale self-orientation reference (card 0597e092 —
 * Platform-Audit finding `8fce57e9`, the Invest->Seismo mis-dispatch vector). WARN-only — this NEVER
 * edits an agent's prompt; the content fix is a deliberate human/Lead decision (`agent_update`), not a
 * mechanical rewrite. THE SHARED CHOKEPOINT for both project-update write sites (REST `PATCH
 * /api/projects/:id` and the elevated `project_update` MCP tool) — both must call this so a rename
 * lints identically no matter which surface performed it.
 *
 * `oldProject` MUST be read BEFORE the write (`db.updateProject`) that performs the rename — comparing
 * against the row's post-write state would compare new-vs-new and always report zero changes. `patch`
 * is the same `{name?, repoPath?, vaultPath?}` passed to that write. Only fields that ACTUALLY changed
 * value are linted (a no-op PATCH, or a patch that sets a field to its own current value, warns nothing).
 */
export function lintStalePromptsOnProjectChange(
  db: Db,
  projectId: string,
  oldProject: Pick<Project, "name" | "repoPath" | "vaultPath">,
  patch: { name?: string; repoPath?: string; vaultPath?: string },
): StalePromptWarning[] {
  const changes = computeRenameChanges(oldProject, patch);
  if (changes.length === 0) return [];
  return lintStalePrompts(db.listAgents(projectId), changes);
}
