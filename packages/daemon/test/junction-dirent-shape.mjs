import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card e3fcd8ea item 3 — PINS the measured Dirent/lstat shape of a real Windows directory junction, so a
// future Node/libuv upgrade that changes it fails LOUDLY here instead of silently flipping
// `isLikelyJunctionOrSymlink` (git/worktrees.ts) from "redundant today" to "load-bearing" with nothing
// calling it out. That helper is otherwise reached only AFTER `!entry.isDirectory()`/`!leaf.isDirectory()`
// has already filtered a real junction out (MEASURED on Node 22.16/Win11, this file) — see
// docs/decisions/e3fcd8ea-stale-aside-leftover-nits.md for the full reasoning and why the helper is kept
// anyway as declared, inert defence-in-depth rather than dropped.
//
// win32-only: directory junctions are a Windows-specific NTFS reparse-point concept; skips elsewhere.
//
// Run: node packages/daemon/test/junction-dirent-shape.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

useOwnLoomHome("loom-junction-dirent-");
requireHermeticEnv();

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

if (process.platform !== "win32") {
  console.log("SKIP  junction-dirent-shape.mjs — win32-only (directory junctions are a Windows NTFS reparse-point concept)");
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "loom-junction-dirent-"));
try {
  const realDir = path.join(root, "real");
  fs.mkdirSync(realDir, { recursive: true });
  const junctionPath = path.join(root, "real.stale-1700000000099");
  fs.symlinkSync(realDir, junctionPath, "junction");

  const entries = fs.readdirSync(root, { withFileTypes: true });
  const realEntry = entries.find((e) => e.name === "real");
  const junctionEntry = entries.find((e) => e.name === path.basename(junctionPath));

  // Negative control: an ordinary real directory's Dirent, for contrast with the junction below.
  check("(control) a real (non-junction) directory's Dirent reports isDirectory()=true", realEntry?.isDirectory() === true);
  check("(control) a real (non-junction) directory's Dirent reports isSymbolicLink()=false", realEntry?.isSymbolicLink() === false);

  // The measured fact this test pins: a real junction's Dirent (readdir level).
  check("(pinned) a junction's readdirSync Dirent reports isDirectory()=false", junctionEntry?.isDirectory() === false);
  check("(pinned) a junction's readdirSync Dirent reports isSymbolicLink()=true", junctionEntry?.isSymbolicLink() === true);

  // The same fact via fs.lstatSync — the API isLikelyJunctionOrSymlink itself actually calls.
  const lst = fs.lstatSync(junctionPath);
  check("(pinned) fs.lstatSync on a junction reports isSymbolicLink()=true", lst.isSymbolicLink() === true);
  check("(pinned) fs.lstatSync on a junction reports isDirectory()=false", lst.isDirectory() === false);
} finally {
  // best-effort: unlink the junction itself first, never recurse through it into the real target.
  try { fs.rmdirSync(path.join(root, "real.stale-1700000000099")); } catch { /* best-effort */ }
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — on this Node/libuv version, a real Windows directory junction's Dirent (readdirSync, withFileTypes) AND fs.lstatSync both report isDirectory()=false / isSymbolicLink()=true, confirming the pre-existing `!entry.isDirectory()` filter in listStaleAsideWorktrees already excludes a junction before isLikelyJunctionOrSymlink is ever reached. If this ever goes RED, that premise has changed — re-examine whether isLikelyJunctionOrSymlink has become load-bearing again (see docs/decisions/e3fcd8ea-*)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
