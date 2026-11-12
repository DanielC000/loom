import { resolveConfig } from "@loom/shared";
import type { Db } from "../db.js";
import type { ForeignRepoContext } from "./vault-path.js";

/**
 * Card c24dfd28 — build the cross-project half of the vaultPath containment check
 * ({@link import("./vault-path.js").checkVaultRepoTripleContainment}'s `opts.foreign`) from the DB.
 * `excludeProjectId` is the project being written (its OWN paths are never foreign; pass `undefined` on a
 * create — the new project is not in the DB yet). For an existing project its stored vaultPath rides along
 * so an unchanged vaultPath (a rename that resends it) is not re-judged.
 *
 * @decision c24dfd28 — every create/update surface must pass this to the shared triple check; never
 * re-derive "foreign repo paths" or the shared-root exemption at a call site. The exemption is
 * `isSharedVaultRoot` over the human-only platform list (7c1d6dbf), applied to the foreign repo's git
 * toplevel — never a second signal.
 */
export function foreignRepoContext(
  db: Pick<Db, "listForeignRepoPaths" | "listForeignVaultPaths" | "getPlatformConfig" | "getProject">,
  excludeProjectId: string | undefined,
): ForeignRepoContext {
  const own = excludeProjectId ? db.getProject(excludeProjectId) : undefined;
  return {
    paths: db.listForeignRepoPaths(excludeProjectId),
    vaultPaths: db.listForeignVaultPaths(excludeProjectId),
    storedRepoPaths: own ? [own.repoPath, ...own.repos.map((r) => r.path)].filter(Boolean) : undefined,
    sharedVaultRoots: resolveConfig(undefined, db.getPlatformConfig()).platform.sharedVaultRoots ?? [],
    storedVaultPath: own?.vaultPath || undefined,
  };
}
