import fs from "node:fs";
import path from "node:path";

const cache = new Map<string, string>();

/**
 * Resolve an executable to an ABSOLUTE path. Critical on Windows: node-pty's agent
 * does NOT search %PATH%, so we must hand it a fully-qualified path. (Ported from the predecessor.)
 */
export function resolveExecutable(name: string): string {
  if (!name) return name;
  if (path.isAbsolute(name)) return name;
  if (name.includes("/") || name.includes("\\")) return path.resolve(name);

  const cached = cache.get(name);
  if (cached) return cached;

  const PATH = process.env.PATH || process.env.Path || "";
  const sep = process.platform === "win32" ? ";" : ":";
  const dirs = PATH.split(sep).filter(Boolean);
  const exts = process.platform === "win32"
    ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  const hasExt = process.platform === "win32" && path.extname(name).length > 0;

  for (const dir of dirs) {
    const candidates = hasExt ? [path.join(dir, name)] : exts.map((e) => path.join(dir, name + e));
    for (const c of candidates) {
      if (fs.existsSync(c)) { cache.set(name, c); return c; }
    }
  }
  return name;
}
