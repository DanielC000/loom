#!/usr/bin/env node
// @decision 0d87afda — deletes ORPHANED tsc output from <pkg>/dist before `tsc` runs, so turbo never stores
// (and replays into fresh worktrees/gates) a dist file with no source. Never widen it to a wholesale wipe.
// Usage: node prune-orphan-dist.mjs [pkgDir]   (default: cwd)
//
// A file under dist/ is an orphan iff it is tsc output and its OWN source kind is absent:
// `X.js|.js.map|.d.ts|.d.ts.map` need `src/X.ts` or `src/X.tsx`; `X.mjs|.mjs.map|.d.mts|.d.mts.map` need
// `src/X.mts`; `X.cjs|.cjs.map|.d.cts|.d.cts.map` need `src/X.cts`. EVERYTHING else (build-info.json, any
// non-tsc file) is never touched. Afterwards ANY empty dir under dist/ is removed, pre-existing ones included.
// Safety: no symlink/junction is ever followed or deleted-through; a path whose realpath leaves <pkg>/dist is
// skipped; a missing/unreadable src/ or dist/ deletes nothing. Prints one summary line (paths when N > 0).
import fs from "node:fs";
import path from "node:path";

const pkgDir = path.resolve(process.argv[2] ?? process.cwd());
const srcDir = path.join(pkgDir, "src");
const distDir = path.join(pkgDir, "dist");

const isDir = (p) => { try { return fs.lstatSync(p).isDirectory(); } catch { return false; } };
const ORPHAN_RE = /^(.+?)(\.d\.ts\.map|\.d\.ts|\.js\.map|\.js|\.d\.mts\.map|\.d\.mts|\.mjs\.map|\.mjs|\.d\.cts\.map|\.d\.cts|\.cjs\.map|\.cjs)$/;
const SRC_EXTS = (outSuffix) => (/mts|mjs/.test(outSuffix) ? [".mts"] : /cts|cjs/.test(outSuffix) ? [".cts"] : [".ts", ".tsx"]);

function main() {
  if (!isDir(srcDir)) { console.log(`[prune-orphan-dist] ${pkgDir}: no src/ dir — nothing pruned`); return; }
  if (!isDir(distDir)) { console.log(`[prune-orphan-dist] ${pkgDir}: 0 files pruned (no dist/)`); return; }
  const realDist = fs.realpathSync(distDir);
  const inside = (p) => { const r = path.relative(realDist, p); return r !== "" && !r.startsWith("..") && !path.isAbsolute(r); };
  const pruned = [];
  const dirs = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, ent.name);
      if (ent.isSymbolicLink()) continue; // symlink or junction: never followed, never removed
      if (ent.isDirectory()) { dirs.push(full); walk(full); continue; }
      if (!ent.isFile()) continue;
      const m = ORPHAN_RE.exec(ent.name);
      if (!m) continue;
      const rel = path.relative(distDir, path.join(dir, m[1]));
      if (SRC_EXTS(m[2]).some((e) => fs.existsSync(path.join(srcDir, rel + e)))) continue;
      if (!inside(fs.realpathSync(full))) continue;
      fs.unlinkSync(full);
      pruned.push(path.relative(pkgDir, full).replace(/\\/g, "/"));
    }
  };
  walk(distDir);
  for (const d of dirs.reverse()) {
    try { if (fs.readdirSync(d).length === 0) fs.rmdirSync(d); } catch { /* best-effort tidy only */ }
  }
  console.log(`[prune-orphan-dist] ${pkgDir}: ${pruned.length} files pruned`);
  if (pruned.length > 0) for (const p of pruned) console.log(`[prune-orphan-dist]   - ${p}`);
}

try { main(); } catch (e) {
  console.error(`[prune-orphan-dist] FAILED: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
}
