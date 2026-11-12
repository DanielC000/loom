import fs from "node:fs";
import path from "node:path";

/**
 * Card 7c1d6dbf — the ONE predicate deciding "is this repo a human-declared shared notes vault root?".
 * Reused by every vault guard that must tell a pure notes vault apart from a code repo (the auto-committer's
 * code-repo-collision exemption today; the vault-path / commit-time guards that build on it).
 *
 * @decision 7c1d6dbf — membership is EQUALITY against the human-only `PlatformConfig.sharedVaultRoots`
 *  list, never layout inference (a third project's vaultPath inside a code repo must not exempt that repo),
 *  and a listed root vouches for ITSELF only — never a subfolder, never a parent.
 *
 * @decision 7c1d6dbf — canonicalize by REALPATH, never `canonicalRepoLockKey` (git-TOPLEVEL keyed: a
 *  listed subfolder would key to its whole code repo and exempt it).
 *
 * Handles case, junction, `\\?\` and trailing slash; an unresolvable path falls back to its lexical form.
 */
export function canonicalSharedRootKey(p: string): string {
  let resolved: string;
  try {
    resolved = fs.realpathSync.native(p);
  } catch {
    resolved = path.resolve(p);
  }
  resolved = resolved.replace(/^\\\\\?\\(?!UNC\\)/i, "").replace(/[\\/]+$/, "");
  if (resolved === "") resolved = path.sep; // filesystem root
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

/**
 * Whether `governingRoot` (an already-resolved governing repo root) EQUALS, canonically, an entry of
 * `sharedVaultRoots`. Empty/absent list ⇒ `false` (fail closed). Non-absolute or blank entries never match.
 */
export function isSharedVaultRoot(governingRoot: string, sharedVaultRoots: readonly string[] | undefined): boolean {
  if (!governingRoot || !sharedVaultRoots || sharedVaultRoots.length === 0) return false;
  const key = canonicalSharedRootKey(governingRoot);
  for (const entry of sharedVaultRoots) {
    if (typeof entry !== "string" || entry.trim() === "" || !path.isAbsolute(entry)) continue;
    if (canonicalSharedRootKey(entry) === key) return true;
  }
  return false;
}
