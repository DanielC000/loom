import fs from "node:fs";
import path from "node:path";
import { commitVault, isOperationalVaultDir } from "./versioner.js";

// Sibling to browser.ts: the WRITE side of the vault. Every operation is confined to the
// project's vault dir by a mandatory path-traversal guard (see resolveInVault), and on success
// flows through the SAME commit path as the auto-committer (versioner.commitVault) so vault
// history stays consistent. Reached from the human REST path; from the platform MCP `vault_write`
// as a role-gated trust elevation (Platform Manager P3, gated strictly to role==="platform"); and
// from the loom-tasks TaskMcpRouter's own `vault_write` (mcp/server.ts), exposed to an ordinary
// project session ONLY when its resolved Profile sets `vaultWrite` — a human-only grant
// (AGENT_FORBIDDEN_PROFILE_KEYS rejects it on every agent-facing profile writer) — and even then
// confined to the project's own vault root via resolveInVault, same as every other caller.

export type VaultWriteOutcome =
  | { ok: true; committed: boolean }
  | { ok: false; reason: "traversal" | "exists" | "not-found" | "is-dir" | "error" | "operational-dir" };

/** @decision ffe98495 — never remove `.git` or `.obsidian` from this refusal list, and never add
 *  `node_modules`/`worktrees` to it — a vault write into either can plant a hook or a plugin the daemon
 *  or Obsidian later executes. */
const VAULT_CONTROL_DIR_NAMES = [".git", ".obsidian"] as const;

/** @decision ffe98495 — a segment matching this SHAPE is refused outright, regardless of what precedes
 *  the `~digit` — a Windows 8.3 short name can be a HASHED collision form (e.g. `GI7F32~1`), not just a
 *  truncated-prefix one, so there is no fixed prefix to check against; reject the shape itself. */
const WINDOWS_SHORTNAME_SHAPE = /~[0-9]+$/;

/** @decision ffe98495 — refuse a trailing dot/space on EVERY segment, not only one that would otherwise
 *  alias `.git`/`.obsidian`: Windows silently drops it on disk (`notes.` becomes a real dir `notes`),
 *  and the mismatched leftover then makes every later `git add` in this vault fail permanently. */
const TRAILING_DOT_OR_SPACE = /[.\s]$/;

/** Whether `segment` (one `/`-split component of a vault-relative path) is refused outright: a literal
 *  `:` anywhere (see {@link resolveInVault}'s own colon check for why), a trailing dot/space (see {@link
 *  TRAILING_DOT_OR_SPACE}), a Windows 8.3 short-name shape (see {@link WINDOWS_SHORTNAME_SHAPE}), or an
 *  exact case-insensitive match against {@link VAULT_CONTROL_DIR_NAMES} — including as the path's own
 *  leaf (e.g. `relPath === ".git"`, a gitlink file). */
function isRefusedVaultSegment(segment: string): boolean {
  if (TRAILING_DOT_OR_SPACE.test(segment)) return true;
  if (WINDOWS_SHORTNAME_SHAPE.test(segment)) return true;
  const lower = segment.toLowerCase();
  return VAULT_CONTROL_DIR_NAMES.some((name) => lower === name);
}

/** Resolve `p` through the OS's NATIVE realpath (resolves a junction/symlink AND an 8.3 short-name
 *  alias Node's own JS-level `fs.realpathSync` doesn't normalize — same technique as `f9360c84`'s
 *  `isLoomHomeOrAncestor` in versioner.ts). `p` is always confirmed to exist by the caller before this
 *  runs, so no non-existent-path fallback is needed here (unlike that sibling helper). */
function realpathNative(p: string): string {
  try { return fs.realpathSync.native(p); } catch { return fs.realpathSync(p); }
}

/**
 * Resolve a UI-supplied relative path to an absolute path that is PROVABLY inside the vault root,
 * or null if it escapes (`..`, an absolute path, a symlinked ancestor pointing outside, or the final
 * target ITSELF being a symlink/junction), touches a control directory or an outright-refused segment
 * shape (see {@link isRefusedVaultSegment}), or resolves through the vault's own `.git`.
 * The lexical check rejects `..`/absolute escapes; the realpath check on the deepest existing
 * ancestor rejects an in-vault symlink/junction whose real target is outside the vault (or inside its `.git`).
 *
 * @decision af1e0eb4 — never swap the final-target `lstat` check below for `fs.existsSync`: a DANGLING
 *  symlink/junction makes `existsSync` report "doesn't exist", which previously let this function hand
 *  back the dangling link's own path as a "safe" target it never actually inspected.
 */
function resolveInVault(vaultPath: string, relPath: string): string | null {
  // Defense-in-depth: reject any backslash in the relative path on EVERY platform. On POSIX `\` is a
  // legitimate filename char (so `..\..` reads as a single segment, not traversal), but a `\` in a
  // vault-relative path is never legitimate and becomes a path separator — i.e. traversal — the moment
  // the vault is synced to Windows. Rejecting it everywhere keeps the guard uniform and the file safe.
  if (relPath.includes("\\")) return null;
  // @decision ffe98495 — refuse ANY colon on every platform: NTFS resolves `<dir>::$INDEX_ALLOCATION`
  // to `<dir>` ITSELF (an alternate-data-stream alias), so a segment-name check alone can still land
  // inside a real `.git` this way; `<file>:<stream>` is the same alias class, one level down.
  if (relPath.includes(":")) return null;
  if (relPath.split("/").some(isRefusedVaultSegment)) return null;
  const root = path.resolve(vaultPath);
  const target = path.resolve(root, relPath);
  // Reject writing the root itself, and any path that is not strictly within root (lexical guard).
  // This — not the symlink walk below — is what rejects a genuine `..`/absolute escape, so it applies
  // whether or not the vault root itself exists on disk yet.
  if (target === root || !target.startsWith(root + path.sep)) return null;
  // The vault root hasn't been scaffolded yet (e.g. a freshly created project's vaultPath). Nothing on
  // disk can be a symlink escape if the root doesn't even exist, and the lexical check above already
  // proved `target` is confined to it — so let the caller create it (writeVaultFile/createVaultFile
  // mkdir the parent chain before writing). This is NOT a traversal case; it's just an uncreated root.
  if (!fs.existsSync(root)) return target;
  // Final-target guard (see the @decision above): lstat the target ITSELF — never existsSync, which
  // follows the link and is blind to a dangling one — and refuse outright if it's a symlink/junction,
  // live or dangling. An ENOENT here means the target doesn't exist at all (ordinary create) and falls
  // through to the walk-up below unchanged.
  try {
    if (fs.lstatSync(target).isSymbolicLink()) return null;
  } catch { /* ENOENT: no filesystem entry at all here — fine, it's a normal create */ }
  // Symlink guard: the target may not exist yet (create/write), so walk up to the deepest existing
  // ancestor and confirm its REAL path is still within the real vault root, and outside the vault's own
  // `.git` (a pre-existing symlink/junction, planted by some other means, could resolve into `.git` while
  // nominally staying "inside the vault root").
  //
  // @decision ffe98495 — never drop the `.git`-realpath check below; it is defense in depth on top of
  // the segment-name refusal above, not a replacement for it.
  try {
    const realRoot = realpathNative(root);
    const realGitDir = path.join(realRoot, ".git");
    let probe = target;
    while (!fs.existsSync(probe)) {
      const parent = path.dirname(probe);
      if (parent === probe) break; // reached a filesystem root without finding an existing ancestor
      probe = parent;
    }
    const realProbe = realpathNative(probe);
    if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) return null;
    if (realProbe === realGitDir || realProbe.startsWith(realGitDir + path.sep)) return null;
  } catch { return null; } // unreadable root/ancestor → reject
  return target;
}

/**
 * Best-effort scaffold of a project's vault ROOT directory (mkdir -p; never throws). Called from
 * project_create/project_init so a freshly bound vaultPath is writable immediately — without this, a
 * project whose vaultPath doesn't yet exist on disk hits `resolveInVault`'s missing-root path on its
 * FIRST write instead (which now scaffolds it there too), but scaffolding at create time means the
 * directory — and thus the project — is visibly ready right away.
 */
export function ensureVaultRoot(vaultPath: string): void {
  try { fs.mkdirSync(vaultPath, { recursive: true }); } catch { /* best-effort — vault_write surfaces real errors */ }
}

/** Write (create or overwrite) a file's text content within the vault, then commit. */
export async function writeVaultFile(vaultPath: string, relPath: string, content: string): Promise<VaultWriteOutcome> {
  // @decision 68cc29db — refuse BEFORE touching disk: an operational (LOOM_HOME-rooted) "vault" must
  // never receive a file write, not just never be committed — see versioner.ts's commitVault chokepoint.
  if (isOperationalVaultDir(vaultPath)) return { ok: false, reason: "operational-dir" };
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
  if (isOperationalVaultDir(vaultPath)) return { ok: false, reason: "operational-dir" };
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
  if (isOperationalVaultDir(vaultPath)) return { ok: false, reason: "operational-dir" };
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
