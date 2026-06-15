import fs from "node:fs";
import path from "node:path";
import { commitVault } from "./versioner.js";

// Sibling to browser.ts: the WRITE side of the vault. Every operation is confined to the
// project's vault dir by a mandatory path-traversal guard (see resolveInVault), and on success
// flows through the SAME commit path as the auto-committer (versioner.commitVault) so vault
// history stays consistent. Reached from the human REST path and — as a role-gated trust elevation
// (Platform Manager P3) — from the platform MCP `vault_write`, gated strictly to role==="platform".
// Ordinary agents (loom-tasks/orchestration) never call this — they write via their session cwd.

export type VaultWriteOutcome =
  | { ok: true; committed: boolean }
  | { ok: false; reason: "traversal" | "exists" | "not-found" | "is-dir" | "error" };

/**
 * Resolve a UI-supplied relative path to an absolute path that is PROVABLY inside the vault root,
 * or null if it escapes (`..`, an absolute path, or a symlinked ancestor pointing outside).
 * The lexical check rejects `..`/absolute escapes; the realpath check on the deepest existing
 * ancestor rejects an in-vault symlink/junction whose real target is outside the vault.
 */
function resolveInVault(vaultPath: string, relPath: string): string | null {
  // Defense-in-depth: reject any backslash in the relative path on EVERY platform. On POSIX `\` is a
  // legitimate filename char (so `..\..` reads as a single segment, not traversal), but a `\` in a
  // vault-relative path is never legitimate and becomes a path separator — i.e. traversal — the moment
  // the vault is synced to Windows. Rejecting it everywhere keeps the guard uniform and the file safe.
  if (relPath.includes("\\")) return null;
  const root = path.resolve(vaultPath);
  const target = path.resolve(root, relPath);
  // Reject writing the root itself, and any path that is not strictly within root (lexical guard).
  if (target === root || !target.startsWith(root + path.sep)) return null;
  // Symlink guard: the target may not exist yet (create/write), so walk up to the deepest existing
  // ancestor and confirm its REAL path is still within the real vault root.
  try {
    const realRoot = fs.realpathSync(root);
    let probe = target;
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break; // reached a filesystem root without finding an existing ancestor
      probe = parent;
    }
    const realProbe = fs.realpathSync(probe);
    if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) return null;
  } catch { return null; } // missing/unreadable root → reject
  return target;
}

/** Write (create or overwrite) a file's text content within the vault, then commit. */
export async function writeVaultFile(vaultPath: string, relPath: string, content: string): Promise<VaultWriteOutcome> {
  const target = resolveInVault(vaultPath, relPath);
  if (!target) return { ok: false, reason: "traversal" };
  try {
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) return { ok: false, reason: "is-dir" };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, "utf8");
  } catch { return { ok: false, reason: "error" }; }
  const committed = await commitVault(vaultPath, `loom: write ${relPath} (via UI)`).catch(() => false);
  return { ok: true, committed };
}

/** Create a NEW file (fails if it already exists), then commit. */
export async function createVaultFile(vaultPath: string, relPath: string, content = ""): Promise<VaultWriteOutcome> {
  const target = resolveInVault(vaultPath, relPath);
  if (!target) return { ok: false, reason: "traversal" };
  if (fs.existsSync(target)) return { ok: false, reason: "exists" };
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content, { encoding: "utf8", flag: "wx" }); // wx: fail if exists (race-safe)
  } catch { return { ok: false, reason: "error" }; }
  const committed = await commitVault(vaultPath, `loom: create ${relPath} (via UI)`).catch(() => false);
  return { ok: true, committed };
}

/** Delete a file within the vault (files only — never a directory), then commit. */
export async function deleteVaultFile(vaultPath: string, relPath: string): Promise<VaultWriteOutcome> {
  const target = resolveInVault(vaultPath, relPath);
  if (!target) return { ok: false, reason: "traversal" };
  try {
    if (!fs.existsSync(target)) return { ok: false, reason: "not-found" };
    if (fs.statSync(target).isDirectory()) return { ok: false, reason: "is-dir" };
    fs.rmSync(target);
  } catch { return { ok: false, reason: "error" }; }
  const committed = await commitVault(vaultPath, `loom: delete ${relPath} (via UI)`).catch(() => false);
  return { ok: true, committed };
}
