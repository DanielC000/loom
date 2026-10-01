import fs from "node:fs";
import path from "node:path";
import type { VaultEntry } from "@loom/shared";

const IGNORE = new Set([".git", ".obsidian", "node_modules"]);
const MAX_ENTRIES = 5000;

/** Flat, recursive listing of a vault folder (read-only). Skips VCS/Obsidian internals. */
export function listVaultTree(vaultPath: string): VaultEntry[] {
  const out: VaultEntry[] = [];
  const walk = (abs: string, rel: string) => {
    if (out.length >= MAX_ENTRIES) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (IGNORE.has(e.name)) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) { out.push({ path: childRel, type: "dir" }); walk(path.join(abs, e.name), childRel); }
      else if (e.isFile()) out.push({ path: childRel, type: "file" });
    }
  };
  walk(vaultPath, "");
  return out;
}

/**
 * Resolve a vault-relative path to its GUARDED absolute real path, or null if it escapes the
 * vault root / is missing / unreadable. The single source of truth for the traversal guard — both
 * the text reader (`readVaultFile`) and the raw byte serving path (`statVaultFile`) go through this
 * so the two can never drift. Two layers: a lexical containment check, then a `realpathSync`
 * symlink-escape check (a link INSIDE the vault pointing OUTSIDE looks lexically in-bounds; only
 * realpath reveals it escapes).
 */
export function resolveVaultFilePath(vaultPath: string, relPath: string): string | null {
  const root = path.resolve(vaultPath);
  const target = path.resolve(root, relPath);
  if (target !== root && !target.startsWith(root + path.sep)) return null; // lexical traversal guard
  try {
    const real = fs.realpathSync(target);
    const realRoot = fs.realpathSync(root);
    if (real !== realRoot && !real.startsWith(realRoot + path.sep)) return null;
    return real;
  } catch { return null; } // missing file/root or unreadable → not found
}

/** Read a file's text content, guarding against path traversal outside the vault. */
export function readVaultFile(vaultPath: string, relPath: string): string | null {
  const real = resolveVaultFilePath(vaultPath, relPath);
  if (real === null) return null;
  try { return fs.readFileSync(real, "utf8"); } catch { return null; }
}

/** A guarded, on-disk vault FILE: its real absolute path + byte size. */
export interface VaultFileStat { real: string; size: number; }

/**
 * Stat a vault file through the SAME guard as `readVaultFile`, returning its real path + size for
 * the raw byte serving route (so it can enforce a size cap and set Content-Length before streaming).
 * Returns null if the path escapes the vault, is missing/unreadable, or is not a regular file.
 */
export function statVaultFile(vaultPath: string, relPath: string): VaultFileStat | null {
  const real = resolveVaultFilePath(vaultPath, relPath);
  if (real === null) return null;
  try {
    const st = fs.statSync(real);
    if (!st.isFile()) return null; // directories etc. are not servable as raw bytes
    return { real, size: st.size };
  } catch { return null; }
}

/**
 * Content-Type for a vault file by extension — a conservative allow-list backing the raw serving
 * route. Images map to `image/*`, PDFs to `application/pdf`, common text formats to UTF-8 text,
 * everything else to `application/octet-stream`.
 *
 * ⛔ It DOES return one type a browser executes as a document: `image/svg+xml`. An `<img>` tag never
 * runs an SVG's script, but NAVIGATING to the raw URL does — so the route itself must neutralise that
 * (see `isActiveDocumentContentType` below and the route's own CSP in gateway/server.ts).
 */
const VAULT_CONTENT_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
  ".md": "text/plain; charset=utf-8",
  ".markdown": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".json": "text/plain; charset=utf-8",
  ".csv": "text/plain; charset=utf-8",
  ".tsv": "text/plain; charset=utf-8",
  ".log": "text/plain; charset=utf-8",
  ".yml": "text/plain; charset=utf-8",
  ".yaml": "text/plain; charset=utf-8",
};

export function vaultFileContentType(relPath: string): string {
  return VAULT_CONTENT_TYPES[path.extname(relPath).toLowerCase()] ?? "application/octet-stream";
}

/**
 * Would a browser render this Content-Type as an ACTIVE (scriptable) DOCUMENT if the raw URL were
 * navigated to directly — a new tab, a middle-click, a pasted link? Keyed on the RESOLVED type, not
 * the extension, so it can never drift from `VAULT_CONTENT_TYPES` above: add an active type there and
 * this returns true for it without a second edit. `application/pdf` is deliberately NOT in this set —
 * it is a document, but PDF script runs in the viewer's own restricted engine with no DOM or
 * `localStorage` access, and it needs the carve-out the route documents.
 */
export function isActiveDocumentContentType(contentType: string): boolean {
  const t = (contentType.split(";")[0] ?? "").trim().toLowerCase();
  // `+xml` covers image/svg+xml and application/xhtml+xml without naming each one.
  return t === "text/html" || t === "text/xml" || t === "application/xml" || t.endsWith("+xml");
}
