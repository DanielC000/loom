import path from "node:path";
import { expandTilde } from "../paths.js";
import { isGitRepo } from "../git/reader.js";

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
 * MCP `project_update`) should call this instead of hand-rolling the same trim/expand/validate/unbind
 * sequence, so a rebind or unbind validates IDENTICALLY everywhere — mirrors {@link
 * checkRepoRebind}'s role for `repoPath` (`projects/rebind.ts`).
 *
 * `raw` is the caller's incoming patch value exactly as received (untrimmed): `undefined` means "this
 * patch doesn't touch vaultPath" and passes through unchanged. A trimmed-empty value is the legitimate
 * explicit-unbind case per {@link validateVaultPath}'s own decision notes above, UNLESS it would strand a
 * vault-only project — `project.repoPath === project.vaultPath` and that shared path is NOT itself a git
 * repo (the `isGitRepo` check tells a genuine bare vault-only folder apart from a legacy repo-bound
 * project that merely happens to share its path with its vault, which may safely unbind) — where it's
 * refused instead. Any other non-empty value is `expandTilde`-expanded then run through {@link
 * validateVaultPath} itself (absolute path required).
 *
 * Deliberately scoped to JUST this sequence — it does not also re-run {@link validateRepoRegistry}'s
 * anti-alias check against a project's `repos` registry (a separate validator with its own call sites and
 * trust posture); a caller that accepts `repos` edits or needs the alias re-check on a `vaultPath` rebind
 * still runs that separately, as REST/platform already do.
 */
export async function checkVaultPathUpdate(
  project: { repoPath: string; vaultPath: string },
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
  return validateVaultPath(expandTilde(trimmed));
}
