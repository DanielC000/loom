import path from "node:path";
import { expandTilde } from "../paths.js";

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
