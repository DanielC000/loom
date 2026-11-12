import type { Db } from "../db.js";
import { resolveGitMainCheckoutRootSync } from "../git/repo-lock.js";
import { canonicalSharedRootKey } from "./shared-roots.js";

/** app_meta one-shot marker: stamped after the FIRST evaluation of any outcome (the one exception: a corrupt config row). */
export const SHARED_VAULT_ROOTS_SEED_KEY = "vault.sharedVaultRootsSeed";

export type SharedVaultRootsSeedResult =
  | { outcome: "already-done" }
  | { outcome: "owner-list-present" }
  | { outcome: "seeded"; root: string; vouchers: number }
  | { outcome: "none" }
  | { outcome: "ambiguous"; candidates: string[] }
  | { outcome: "config-corrupt" };

/**
 * Card 7c1d6dbf — ONE-TIME boot migration: seed the human-only `sharedVaultRoots` list with the install's
 * shared notes vault, so the exemption the old layout inference granted implicitly survives the switch to
 * an explicit list. NEVER hardcodes a path (the repo is public; a path would be wrong on every install).
 *
 * The layout inference lives ONLY here, once, as a migration heuristic — it is no longer a runtime guard.
 * Candidate roots are the git roots governing the `vaultPath`s of NON-ARCHIVED, NON-RESERVED projects. A root
 * needs >=2 DISTINCT canonical vault paths under it (distinct PATHS, not projects: reserved-home duplicates
 * share one). It is DISQUALIFIED only by a non-archived, non-vaultOnly project whose `repoPath`/`repos[]` is
 * governed by that root while its own `vaultPath` is NOT (or is empty) — a project using the root as CODE.
 * A "notes-repo" project (repo = the root, vault inside it) does NOT disqualify. Seeds only when EXACTLY ONE
 * root qualifies; zero or several ⇒ nothing seeded (the owner adds roots in Settings).
 *
 * @decision 7c1d6dbf — a TRUE one-shot: the marker is stamped after the FIRST evaluation of ANY outcome, so
 * layout inference is never re-armed on a later boot. Only a corrupt config row skips and does not stamp.
 *
 * Idempotent (marker), best-effort (the caller wraps it: a throw must never gate boot). The seed is
 * recorded in the platform-config change history (actor "migration:7c1d6dbf") and returned for the caller
 * to log; the Settings field then shows the value.
 */
export function seedSharedVaultRootsOnce(db: Db): SharedVaultRootsSeedResult {
  if (db.getMeta(SHARED_VAULT_ROOTS_SEED_KEY)) return { outcome: "already-done" };
  // A row that EXISTS but does not parse reads as `{}`: writing the seed would clobber the human's config.
  // Skip WITHOUT stamping, so it retries once the config is fixed. Never write over it.
  if (db.isPlatformConfigCorrupt()) return { outcome: "config-corrupt" };
  const stamp = () => db.setMeta(SHARED_VAULT_ROOTS_SEED_KEY, new Date().toISOString());
  const before = db.getPlatformConfig();
  if (Array.isArray(before.sharedVaultRoots) && before.sharedVaultRoots.length > 0) {
    stamp();
    return { outcome: "owner-list-present" };
  }

  const live = db.listAllProjects(); // non-archived (includes reserved rows)
  const everyProject = [...live, ...db.listArchivedProjects()]; // the disqualifier is fail-closed: archived code counts
  const governingKey = (p: string): string | null => {
    const g = resolveGitMainCheckoutRootSync(p);
    return g === null ? null : canonicalSharedRootKey(g);
  };

  // root key -> { root (a real spelling), DISTINCT canonical vault paths under it }
  const byRoot = new Map<string, { root: string; vaultKeys: Set<string> }>();
  for (const p of live) {
    if (p.reserved || !p.vaultPath) continue; // reserved homes are excluded from candidacy entirely
    const root = resolveGitMainCheckoutRootSync(p.vaultPath);
    if (root === null) continue; // not inside a git repo — no repo to exempt
    const key = canonicalSharedRootKey(root);
    const slot = byRoot.get(key) ?? { root, vaultKeys: new Set<string>() };
    slot.vaultKeys.add(canonicalSharedRootKey(p.vaultPath));
    byRoot.set(key, slot);
  }

  const candidates: { root: string; vouchers: number }[] = [];
  for (const [key, slot] of byRoot) {
    if (slot.vaultKeys.size < 2) continue;
    // Disqualified only by a project (archived included) using the root as CODE: non-vaultOnly, a code path
    // governed by this root, and its OWN vault not governed by the same root (or empty). A notes-repo project
    // (repo = root, vault inside it) is not a disqualifier.
    const usesRootAsCode = everyProject.some((p) => {
      if (p.vaultOnly) return false;
      const codeInRoot = [p.repoPath, ...p.repos.map((r) => r.path)].filter(Boolean).some((c) => governingKey(c) === key);
      if (!codeInRoot) return false;
      const vaultInRoot = !!p.vaultPath && governingKey(p.vaultPath) === key;
      return !vaultInRoot;
    });
    if (usesRootAsCode) continue;
    candidates.push({ root: slot.root, vouchers: slot.vaultKeys.size });
  }

  // none / ambiguous: nothing is written, but the decision is FINAL (stamped) — never re-run on a later boot.
  if (candidates.length === 0) { stamp(); return { outcome: "none" }; }
  if (candidates.length > 1) { stamp(); return { outcome: "ambiguous", candidates: candidates.map((c) => c.root) }; }

  const [only] = candidates;
  const after = { ...before, sharedVaultRoots: [only!.root] };
  db.setPlatformConfig(after);
  db.recordPlatformConfigChange(before, after, "migration:7c1d6dbf");
  stamp(); // stamp last for the seeded case (the config write above already succeeded)
  return { outcome: "seeded", root: only!.root, vouchers: only!.vouchers };
}
