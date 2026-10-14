// git-resolve.mjs — standalone win32 absolute-git-path resolver for Loom's shipped session hooks (card
// 61d0c029). decision-records.mjs and comment-anchor-lint.mjs are plain .mjs files invoked directly by
// the Claude CLI's hook runner — they cannot import the daemon's dist, so this module carries its own copy
// of the resolution logic in packages/daemon/src/git/bounded.ts (resolveAbsoluteGitExePath /
// isAbsoluteWindowsExePath / resolveWin32GitBinary / resolveGitBinaryForSpawn): ABSOLUTE PATH entries
// only, falling back to the bare "git" literal when unresolved, byte-identical on POSIX. A relative PATH
// entry is skipped outright (a relative hit used to resolve to a repo-reachable RELATIVE spawn target) —
// see docs/decisions/5b50eede-absolute-git-path.md for the full rationale this mirrors.
//
// Deliberately duplicated here, not imported from src/ — assets ship as standalone files invoked by bare
// `node <path>`, the same "assets ship standalone" convention ANCHOR_RE's own duplication across
// decision-records.mjs and comment-anchor-lint.mjs already uses (see that constant's doc in
// decision-records.mjs). packages/daemon/test/git-resolve-assets-parity.mjs asserts this copy's behavior
// can never silently drift from bounded.ts's own.
//
// Deliberately NO console output of any kind, unlike bounded.ts's own resolver (which logs once on an
// unresolved PATH, for daemon-side diagnostics only): a hook script's stdout IS the PostToolUse JSON
// payload Claude Code parses, so an extra stdout byte from a module these hooks import would corrupt that
// payload for every hook that uses it.
import fs from "node:fs";
import path from "node:path";

/** @decision 5b50eede — "absolute" means drive-rooted or UNC ONLY, never `path.isAbsolute` (also `true` for
 * a current-drive-relative `\foo`) — mirrors bounded.ts's own `isAbsoluteWindowsExePath` exactly. */
export function isAbsoluteWindowsExePath(p) {
  if (p.length >= 3 && /^[A-Za-z]$/.test(p[0] ?? "") && p[1] === ":" && (p[2] === "\\" || p[2] === "/")) return true;
  if (p.startsWith("\\\\") || p.startsWith("//")) return true;
  return false;
}

/** Mirrors bounded.ts's own `resolveAbsoluteGitExePath` exactly (minus its diagnostic console.log — see
 * this file's header): SKIP a PATH entry failing {@link isAbsoluteWindowsExePath}; test only
 * `<dir>\git.exe`. */
export function resolveAbsoluteGitExePath(pathOverride) {
  const PATH = pathOverride ?? (process.env.PATH || process.env.Path || "");
  const dirs = PATH.split(";").filter(Boolean);
  for (const dir of dirs) {
    if (!isAbsoluteWindowsExePath(dir)) continue;
    const candidate = path.join(dir, "git.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Mirrors bounded.ts's own `resolveWin32GitBinary` exactly: `undefined` on POSIX or when unresolved. */
export function resolveWin32GitBinary() {
  if (process.platform !== "win32") return undefined;
  const resolved = resolveAbsoluteGitExePath();
  return resolved && isAbsoluteWindowsExePath(resolved) ? resolved : undefined;
}

/** Mirrors bounded.ts's own `resolveGitBinaryForSpawn` exactly: the absolute git.exe on win32 when one
 * resolves, else the literal "git" — always "git" on POSIX. Every raw git spawn in this directory's
 * shipped hooks must call this instead of writing the literal "git" (card 61d0c029). */
export function resolveGitBinaryForSpawn() {
  return resolveWin32GitBinary() ?? "git";
}
