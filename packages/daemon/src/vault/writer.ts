import fs from "node:fs";
import path from "node:path";
import { commitVault, isOperationalVaultDir, type CommitVaultResult } from "./versioner.js";

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
  // `committedBlockedReason` (card a09b81a0) is present ONLY when `committed:false` because commitVault
  // refused on a code-repo collision, or (round 4) backed off because an advisory pause lease is held —
  // distinct from every OTHER silent `committed:false` backoff (an ordinary no-op, quarantined,
  // externally-managed), which carry no reason, unchanged. The write to disk already succeeded by the time
  // this is returned — `ok` stays true; only the COMMIT was blocked. A `"paused"` write is NOT lost: it
  // sits uncommitted on disk until a later auto-commit tick (once the lease lifts) commits it.
  | { ok: true; committed: boolean; committedBlockedReason?: "code-repo-collision" | "paused" }
  | { ok: false; reason: "traversal" | "exists" | "not-found" | "is-dir" | "error" | "operational-dir" | "hard-link" };

/** @decision b2fde796 — `O_NOFOLLOW` is POSIX-only (Node's `fs.constants` omits it on win32, confirmed
 *  empirically rather than assumed). `0` ORed into an open-flags bitmask is a no-op, so this constant is
 *  safe to include unconditionally in {@link writeVaultFile}'s open call on every platform. */
const O_NOFOLLOW_IF_POSIX = typeof (fs.constants as { O_NOFOLLOW?: number }).O_NOFOLLOW === "number"
  ? (fs.constants as { O_NOFOLLOW: number }).O_NOFOLLOW
  : 0;

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
 *  `:` anywhere (see {@link lexicalVaultTarget}'s own colon check for why), a trailing dot/space (see {@link
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

/** Result of {@link lexicalVaultTarget}: either refused outright (lexical/segment/root-containment
 *  failure), or a confirmed-confined `target` under `root`, plus whether `root` exists on disk yet. */
type LexicalVaultTarget = { refused: true } | { refused: false; root: string; target: string; rootExists: boolean };

/**
 * Shared lexical prelude for both {@link resolveInVault} and {@link resolveInVaultForDelete}: the
 * backslash/colon/segment-shape refusals, the root/target resolution, and the root-containment check —
 * every guard that is identical between the two resolvers. Deliberately stops BEFORE the final-target
 * lstat check, which is where the two resolvers genuinely diverge (write refuses a symlink final target
 * unconditionally; delete does not) — that difference stays explicit in each caller, never folded in
 * here as a flag.
 *
 * @decision b2fde796 — this extraction is the one the card's own @decision allows: it forbids a flag
 *  inside {@link resolveInVault} to skip its final-symlink refusal, not a shared lexical prelude that
 *  stops short of that check.
 */
function lexicalVaultTarget(vaultPath: string, relPath: string): LexicalVaultTarget {
  // Defense-in-depth: reject any backslash in the relative path on EVERY platform. On POSIX `\` is a
  // legitimate filename char (so `..\..` reads as a single segment, not traversal), but a `\` in a
  // vault-relative path is never legitimate and becomes a path separator — i.e. traversal — the moment
  // the vault is synced to Windows. Rejecting it everywhere keeps the guard uniform and the file safe.
  if (relPath.includes("\\")) return { refused: true };
  // @decision ffe98495 — refuse ANY colon on every platform: NTFS resolves `<dir>::$INDEX_ALLOCATION`
  // to `<dir>` ITSELF (an alternate-data-stream alias), so a segment-name check alone can still land
  // inside a real `.git` this way; `<file>:<stream>` is the same alias class, one level down.
  if (relPath.includes(":")) return { refused: true };
  if (relPath.split("/").some(isRefusedVaultSegment)) return { refused: true };
  const root = path.resolve(vaultPath);
  const target = path.resolve(root, relPath);
  // Reject writing the root itself, and any path that is not strictly within root (lexical guard).
  // This — not a symlink walk — is what rejects a genuine `..`/absolute escape, so it applies whether or
  // not the vault root itself exists on disk yet.
  if (target === root || !target.startsWith(root + path.sep)) return { refused: true };
  return { refused: false, root, target, rootExists: fs.existsSync(root) };
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
  const lex = lexicalVaultTarget(vaultPath, relPath);
  if (lex.refused) return null;
  const { root, target, rootExists } = lex;
  // The vault root hasn't been scaffolded yet (e.g. a freshly created project's vaultPath). Nothing on
  // disk can be a symlink escape if the root doesn't even exist, and the lexical prelude already proved
  // `target` is confined to it — so let the caller create it (writeVaultFile/createVaultFile mkdir the
  // parent chain before writing). This is NOT a traversal case; it's just an uncreated root.
  if (!rootExists) return target;
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
    if (!ancestorChainIsSafe(root, target)) return null;
  } catch { return null; } // unreadable root/ancestor → reject
  return target;
}

/** Shared ancestor-chain check used by both {@link resolveInVault} and {@link resolveInVaultForDelete}:
 *  walk up from `probe` to the deepest existing ancestor and confirm its REAL path is still within the
 *  real vault root (`root`), and outside the vault's own `.git`. Throws on an unreadable root/ancestor —
 *  callers treat that as a refusal. */
function ancestorChainIsSafe(root: string, probe: string): boolean {
  const realRoot = realpathNative(root);
  const realGitDir = path.join(realRoot, ".git");
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break; // reached a filesystem root without finding an existing ancestor
    probe = parent;
  }
  const realProbe = realpathNative(probe);
  if (realProbe !== realRoot && !realProbe.startsWith(realRoot + path.sep)) return false;
  if (realProbe === realGitDir || realProbe.startsWith(realGitDir + path.sep)) return false;
  return true;
}

/**
 * The DELETE-specific sibling of {@link resolveInVault}: same lexical/segment/root-containment guards,
 * but — per the LEAD RULING on card `b2fde796` — deliberately does NOT refuse a final target that is
 * ITSELF a symlink/junction. Deleting (unlinking) a link removes only that one directory entry; it never
 * touches whatever the link resolves to, live or dangling, in-vault or out — there is no write-through-a-
 * link escape to prevent on this path the way there is for {@link writeVaultFile}/{@link createVaultFile}.
 * The ancestor-chain check still runs, starting at the target's PARENT directory rather than the target
 * itself, so an intermediate ancestor symlink pointing outside the vault (or into its `.git`) is still
 * refused exactly as it is for a write — only the FINAL component's own link-ness is exempted here.
 *
 * @decision b2fde796 — never fold this into {@link resolveInVault} by making the final-symlink refusal
 *  conditional there: write-through-a-link must stay refused unconditionally; only delete's own unlink-
 *  the-entry semantics make skipping that refusal safe.
 */
function resolveInVaultForDelete(vaultPath: string, relPath: string): string | null {
  const lex = lexicalVaultTarget(vaultPath, relPath);
  if (lex.refused) return null;
  const { root, target, rootExists } = lex;
  if (!rootExists) return target; // nothing to delete under an uncreated root; caller 404s
  try {
    if (!ancestorChainIsSafe(root, path.dirname(target))) return null;
  } catch { return null; }
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

/** Shared `commitVault(...)` → `VaultWriteOutcome`'s `ok:true` arm mapping for the three writers below —
 *  one place, so the `committedBlockedReason` surfacing (card a09b81a0) can't drift between them. A
 *  `commitVault` rejection (a bound-timeout rethrow — see that function's own doc) degrades to the same
 *  `committed:false`, no-reason shape every other silent backoff already gets. */
async function commitAndReportOutcome(vaultPath: string, message: string): Promise<VaultWriteOutcome> {
  const result = await commitVault(vaultPath, message).catch((): CommitVaultResult => ({ committed: false }));
  return result.blockedReason
    ? { ok: true, committed: result.committed, committedBlockedReason: result.blockedReason }
    : { ok: true, committed: result.committed };
}

/**
 * Write (create or overwrite) a file's text content within the vault, then commit.
 *
 * @decision b2fde796 — refuse an existing overwrite target whose `stat.nlink > 1` (a hard link into the
 *  vault aliasing an outside inode); the nlink check and the write must happen on the SAME open fd, never
 *  a separate lstat-then-writeFileSync, to close the check-to-write TOCTOU window.
 */
export async function writeVaultFile(vaultPath: string, relPath: string, content: string): Promise<VaultWriteOutcome> {
  // @decision 68cc29db — refuse BEFORE touching disk: an operational (LOOM_HOME-rooted) "vault" must
  // never receive a file write, not just never be committed — see versioner.ts's commitVault chokepoint.
  if (isOperationalVaultDir(vaultPath)) return { ok: false, reason: "operational-dir" };
  const target = resolveInVault(vaultPath, relPath);
  if (!target) return { ok: false, reason: "traversal" };
  let fd: number | undefined;
  try {
    if (fs.existsSync(target) && fs.statSync(target).isDirectory()) return { ok: false, reason: "is-dir" };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    // O_NOFOLLOW (POSIX only — see O_NOFOLLOW_IF_POSIX) refuses outright with ELOOP if the final
    // component became a symlink between resolveInVault's own lstat check and this open, rather than
    // silently following it. No O_TRUNC yet — truncating now, before the nlink check below, would
    // already have destroyed a hard-linked target's shared content.
    fd = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | O_NOFOLLOW_IF_POSIX);
    const nlink = fs.fstatSync(fd).nlink;
    if (nlink > 1) {
      fs.closeSync(fd);
      fd = undefined;
      return { ok: false, reason: "hard-link" };
    }
    fs.ftruncateSync(fd, 0);
    // fs.writeFileSync loops internally until all bytes are written when given an fd (unlike a single
    // fs.writeSync call, which can short-write and still report success on a truncated note).
    fs.writeFileSync(fd, content, "utf8");
    fs.closeSync(fd);
    fd = undefined;
  } catch (err) {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* fd already invalid/closed */ } }
    // ELOOP here means O_NOFOLLOW refused the open because the final component became a symlink after
    // resolveInVault's own lstat check (the TOCTOU window) — the same class of refusal as a traversal
    // caught earlier, not a generic I/O failure.
    const code = (err as NodeJS.ErrnoException)?.code;
    return { ok: false, reason: code === "ELOOP" ? "traversal" : "error" };
  }
  return commitAndReportOutcome(vaultPath, `loom: write ${relPath} (via UI)`);
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
  return commitAndReportOutcome(vaultPath, `loom: create ${relPath} (via UI)`);
}

/**
 * Delete a file or link within the vault (files or links — a link entry is unlinked, never followed;
 * never a directory), then commit.
 *
 * @decision b2fde796 — unlike write, delete uses {@link resolveInVaultForDelete}: a final-component
 *  symlink/junction is unlinked directly, lstat-based, WITHOUT following it — removing only that one
 *  directory entry, never the link's target.
 */
export async function deleteVaultFile(vaultPath: string, relPath: string): Promise<VaultWriteOutcome> {
  if (isOperationalVaultDir(vaultPath)) return { ok: false, reason: "operational-dir" };
  const target = resolveInVaultForDelete(vaultPath, relPath);
  if (!target) return { ok: false, reason: "traversal" };
  try {
    let st: fs.Stats;
    try { st = fs.lstatSync(target); } catch { return { ok: false, reason: "not-found" }; }
    if (st.isDirectory()) return { ok: false, reason: "is-dir" };
    // st.isSymbolicLink() or a regular file: either way, unlink the single directory entry at `target`
    // — never follow it. fs.unlinkSync never dereferences a symlink (unlike fs.rmSync with no flags on
    // some older semantics); using it unconditionally here makes that non-following intent explicit.
    fs.unlinkSync(target);
  } catch { return { ok: false, reason: "error" }; }
  return commitAndReportOutcome(vaultPath, `loom: delete ${relPath} (via UI)`);
}
