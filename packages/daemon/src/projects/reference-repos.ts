import path from "node:path";
import { isGitRepo } from "../git/reader.js";
import { expandTilde } from "../paths.js";

/** Result of {@link validateReferenceRepos}. `ok:false` names the FIRST offending entry. */
export type ReferenceReposCheck =
  | { ok: true; value: string[] }
  | { ok: false; error: string };

/**
 * The SHARED validator for a project's `referenceRepos` (reference-repos epic Phase 2, card f4888775) —
 * used by the HUMAN-only REST create (POST /api/projects) + update (PATCH /api/projects/:id) paths, the
 * ONLY surfaces that may ever set this field (see db.ts's `updateProject` doc + CLAUDE.md: a host path is
 * an exfil-adjacent grant, same trust class as repoPath/gateCommand/python.interpreterPath).
 *
 * Each entry must be:
 *  (1) an ABSOLUTE host path — a worker's cwd is a worktree elsewhere on disk, so a relative
 *      `../other-repo` is meaningless to it; and
 *  (2) an EXISTING git repository (`isGitRepo`, mirroring the repoPath / checkRepoRebind guard).
 *
 * Rejects the WHOLE array on the first bad entry (naming it), never a partial accept.
 *
 * Each entry is {@link expandTilde}-expanded FIRST (a leading `~`/`~/` is a shell expansion Node never
 * sees), so `~/other-repo` resolves to the home dir before the absolute-path check below — the stored
 * `value` is the expanded form.
 */
export async function validateReferenceRepos(input: unknown): Promise<ReferenceReposCheck> {
  if (!Array.isArray(input) || !input.every((p) => typeof p === "string")) {
    return { ok: false, error: "referenceRepos must be an array of strings" };
  }
  const expanded = input.map(expandTilde);
  for (const p of expanded) {
    if (!path.isAbsolute(p)) {
      return { ok: false, error: `referenceRepos entries must be absolute paths: ${p}` };
    }
    if (!(await isGitRepo(p))) {
      return { ok: false, error: `referenceRepos entry is not an existing git repository: ${p}` };
    }
  }
  return { ok: true, value: expanded };
}
