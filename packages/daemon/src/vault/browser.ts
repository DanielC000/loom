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

/** Read a file's text content, guarding against path traversal outside the vault. */
export function readVaultFile(vaultPath: string, relPath: string): string | null {
  const root = path.resolve(vaultPath);
  const target = path.resolve(root, relPath);
  if (target !== root && !target.startsWith(root + path.sep)) return null; // traversal guard
  try { return fs.readFileSync(target, "utf8"); } catch { return null; }
}
