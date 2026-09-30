import path from "node:path";
import type { RepoRegistryEntry } from "@loom/shared";
import { expandTilde } from "../paths.js";
import { isGitRepo } from "../git/reader.js";
import { validateRepoRegistry, canonicalizeExistingPath, comparisonKey } from "./repos.js";

/** Result of {@link validateVaultPath}. `ok:false` names the offending value. */
export type VaultPathCheck =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * The SHARED absolute-path guard for a project's `vaultPath` — mirrors `validateReferenceRepos`
 * (reference-repos.ts), which already enforces this for the structurally identical `referenceRepos`
 * field.
 *
 * `raw` MUST be non-empty before calling this — an empty vaultPath is the legitimate "no vault bound" /
 * explicit-unbind case and must never be routed through this check.
 *
 * Existence is intentionally NOT checked here (unlike referenceRepos' isGitRepo check) — that stays
 * call-site-specific: a vault-only project requires an EXISTING directory (`isExistingDir`), while a
 * code project's optional vault gets auto-scaffolded (`ensureVaultRoot`) rather than required to pre-exist.
 * Idempotent on an already-expanded absolute input (expandTilde is a no-op on a path with no leading `~`),
 * so callers that already `expandTilde`d upstream can pass the result straight through.
 *
 * @decision 96c4b245 — reject a non-absolute vaultPath here; there's no recoverable base to resolve it against, so never guess one at render/boot time instead.
 * @decision d867e478 — "" is the legitimate no-vault/unbind case, not a validation failure; every call site must guard it, never route it through this check.
 */
export function validateVaultPath(raw: string): VaultPathCheck {
  const expanded = expandTilde(raw);
  if (!path.isAbsolute(expanded)) {
    return { ok: false, error: `vaultPath must be an absolute path: ${expanded}` };
  }
  return { ok: true, value: expanded };
}

/** Result of {@link checkVaultPathUpdate}. `value: undefined` means "no change requested" (the caller's
 *  patch omitted vaultPath); `value: ""` is a validated, legitimate unbind. */
export type VaultPathUpdateCheck =
  | { ok: true; value: string | undefined }
  | { ok: false; error: string };

/**
 * The SHARED `vaultPath` UPDATE guard — every `project_update`-shaped write surface (human REST PATCH,
 * the manager's own `project_update`, the setup operator's `project_update`, and the elevated platform
 * MCP `project_update`) calls this instead of hand-rolling its own trim/expand/validate/unbind/alias
 * sequence, so a rebind or unbind validates IDENTICALLY everywhere — mirrors {@link checkRepoRebind}'s
 * role for `repoPath` (`projects/rebind.ts`).
 *
 * `raw` is the caller's incoming patch value exactly as received (untrimmed): `undefined` means "this
 * patch doesn't touch vaultPath" and passes through unchanged. A trimmed-empty value is the legitimate
 * explicit-unbind case per {@link validateVaultPath}'s own decision notes above, UNLESS it would strand a
 * vault-only project (refused instead — see the vault-only check below). Any other non-empty value is
 * `expandTilde`-expanded, run through {@link validateVaultPath} (absolute path required), then checked
 * for ALIASING `project.repoPath` or any `project.repos` registry entry — the same normalization + the
 * same {@link validateRepoRegistry} call REST/platform already run for this, not a second alias rule.
 * `project.repoPath === project.vaultPath` is legitimate ONLY for a genuine vault-only project (`isGitRepo`
 * tells that apart from a legacy repo-bound project that merely happens to share its path with its vault).
 */
export async function checkVaultPathUpdate(
  project: { repoPath: string; vaultPath: string; repos: RepoRegistryEntry[] },
  raw: string | undefined,
): Promise<VaultPathUpdateCheck> {
  if (raw === undefined) return { ok: true, value: undefined };
  const trimmed = raw.trim();
  if (!trimmed) {
    if (project.repoPath === project.vaultPath && !(await isGitRepo(project.repoPath))) {
      return { ok: false, error: "cannot unbind the vault of a vault-only project (it has no separate repoPath) — archive it instead" };
    }
    return { ok: true, value: "" };
  }
  const absCheck = validateVaultPath(expandTilde(trimmed));
  if (!absCheck.ok) return absCheck;
  const candidate = absCheck.value;
  if (await isGitRepo(project.repoPath)) {
    if (comparisonKey(canonicalizeExistingPath(candidate)) === comparisonKey(canonicalizeExistingPath(project.repoPath))) {
      return { ok: false, error: `vaultPath aliases the project's repoPath (${project.repoPath}) — the vault auto-committer would commit into the code repo` };
    }
  }
  if (project.repos.length > 0) {
    const registryCheck = await validateRepoRegistry(project.repos, { repoPath: project.repoPath, vaultPath: candidate });
    if (!registryCheck.ok) return { ok: false, error: `vaultPath conflicts with the existing repos registry: ${registryCheck.error}` };
  }
  return { ok: true, value: candidate };
}
