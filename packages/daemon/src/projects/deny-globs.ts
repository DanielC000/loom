/** Result of {@link validateDenyGlobs}. `ok:false` names the FIRST offending entry. */
export type DenyGlobsCheck =
  | { ok: true; value: string[] }
  | { ok: false; error: string };

/**
 * The SHARED validator for a project's `denyGlobs` (card d5d3bdc9) — used by the HUMAN-only REST create
 * (POST /api/projects) + update (PATCH /api/projects/:id) paths, the ONLY surfaces that may ever set
 * this field (see db.ts's `updateProject` doc + CLAUDE.md: it controls a merge-review warning, same
 * trust class as repoPath/referenceRepos/noGateByDesign).
 *
 * Unlike `referenceRepos`, a deny-glob is a PATTERN, not a filesystem path — no absolute-path or
 * existence check applies. Each entry need only be a non-empty string; matching semantics (`**`/`*`/`?`,
 * POSIX repo-relative) are the merge-review path's concern (git/worktrees.ts `pathGlobToRegExp`).
 *
 * Rejects the WHOLE array on the first bad entry (naming it), never a partial accept. An empty array is
 * valid — it's how a project opts OUT of the default `["mockups/**"]` warning entirely.
 */
export function validateDenyGlobs(input: unknown): DenyGlobsCheck {
  if (!Array.isArray(input) || !input.every((g) => typeof g === "string")) {
    return { ok: false, error: "denyGlobs must be an array of strings" };
  }
  for (const g of input) {
    if (!g.trim()) {
      return { ok: false, error: "denyGlobs entries must be non-empty strings" };
    }
  }
  return { ok: true, value: input };
}
