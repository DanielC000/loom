import path from "node:path";
import { expandTilde } from "../paths.js";

/** Result of {@link validateVaultPath}. `ok:false` names the offending value. */
export type VaultPathCheck =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * The SHARED absolute-path guard for a project's `vaultPath` — mirrors `validateReferenceRepos`
 * (reference-repos.ts), which already enforces this for the structurally identical `referenceRepos`
 * field. `vaultPath` never got the same treatment: every write site only `expandTilde`d the input, so a
 * relative value (e.g. a path copied out of Obsidian's own vault-relative note browser instead of a real
 * filesystem path) was accepted and stored verbatim — later rendered as a confidently-wrong-looking
 * relative path in a manager's "Where things live" block (card 96c4b245). There is no recoverable "vault
 * root" Loom could resolve a relative value against (no such config exists anywhere), so the only
 * correct fix is to reject a relative value at the bind boundary rather than guess a base at render time.
 *
 * `raw` MUST be non-empty before calling this — an empty vaultPath is the legitimate "no vault bound" /
 * explicit-unbind case (card d867e478) and must never be routed through this check.
 *
 * Existence is intentionally NOT checked here (unlike referenceRepos' isGitRepo check) — that stays
 * call-site-specific: a vault-only project requires an EXISTING directory (`isExistingDir`), while a
 * code project's optional vault gets auto-scaffolded (`ensureVaultRoot`) rather than required to pre-exist.
 * Idempotent on an already-expanded absolute input (expandTilde is a no-op on a path with no leading `~`),
 * so callers that already `expandTilde`d upstream can pass the result straight through.
 */
export function validateVaultPath(raw: string): VaultPathCheck {
  const expanded = expandTilde(raw);
  if (!path.isAbsolute(expanded)) {
    return { ok: false, error: `vaultPath must be an absolute path: ${expanded}` };
  }
  return { ok: true, value: expanded };
}
