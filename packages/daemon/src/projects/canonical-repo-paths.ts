import type { Project } from "@loom/shared";

/** @decision b272d215 — every repo a merge can land on RIGHT NOW; narrower than
 *  `Db.listAllRegisteredRepoPaths()` (also counts reserved/archived — see its own doc). Extracted
 *  (`1de37538`) so index.ts's boot call and the Step B provider share ONE definition — see that record. */
export function computeCanonicalRepoPaths(db: { listProjects(): Project[] }): string[] {
  const paths = new Set<string>();
  for (const project of db.listProjects()) {
    for (const repoPath of [project.repoPath, ...project.repos.map((r) => r.path)]) {
      if (repoPath) paths.add(repoPath);
    }
  }
  return [...paths];
}
