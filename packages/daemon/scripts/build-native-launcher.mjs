#!/usr/bin/env node
// Compiles packages/daemon/native/win-job-launcher/launcher.cs → packages/daemon/assets/native/
// win-job-launcher.exe, via the in-box .NET Framework C# compiler (csc.exe) — never MSVC, never
// node-gyp. Windows-only; a LOUD no-op everywhere else and when csc.exe cannot be found, so this is
// safe to invoke unconditionally (e.g. from a CI step) without gating on platform/toolchain first.
//
// Deliberately OUTSIDE the default `pnpm build` pipeline (card 1718416d, owner ruling): the toolchain
// this needs (csc.exe) is not guaranteed on every dev/CI host that runs the ordinary build, and adding a
// compile step there would make every build slower/flakier for a Windows-only, opt-in containment
// feature. Invoke explicitly: `pnpm --filter @loom/daemon build:native`.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SOURCE = path.join(repoRoot, "packages/daemon/native/win-job-launcher/launcher.cs");
const OUT_DIR = path.join(repoRoot, "packages/daemon/assets/native");
export const OUT_EXE = path.join(OUT_DIR, "win-job-launcher.exe");

// The ONE shared csc.exe location every .NET Framework 4.x install uses (verified present and working
// on a real Windows 11 host during card 1718416d's own investigation — see docs/decisions/1718416d-*.md
// for how this was checked). Tries 64-bit first, falls back to 32-bit; .NET Framework is in-box on every
// currently-supported Windows 10/11 release per Microsoft's own install docs, but presence of THIS exact
// file at THIS exact path is not independently guaranteed by that — hence the existence check + loud
// no-op rather than an assumed-present hard dependency.
const CSC_CANDIDATES = [
  "C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe",
  "C:\\Windows\\Microsoft.NET\\Framework\\v4.0.30319\\csc.exe",
];

function log(m) { console.log(`[build:native] ${m}`); }

function main() {
  if (process.platform !== "win32") {
    log(`skipped — win32-only (this host is '${process.platform}'). The daemon falls back to the taskkill-based kill-confirm path everywhere this hasn't been built.`);
    return 0;
  }
  const csc = CSC_CANDIDATES.find((p) => fs.existsSync(p));
  if (!csc) {
    log(`skipped — no csc.exe found at any of: ${CSC_CANDIDATES.join(", ")}. Install .NET Framework 4.x (in-box on current Windows 10/11) or build on a host that has it. Falling back to the taskkill-based kill-confirm path.`);
    return 0;
  }
  if (!fs.existsSync(SOURCE)) {
    console.error(`[build:native] ERROR: source file missing: ${SOURCE}`);
    return 1;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  log(`compiling ${path.relative(repoRoot, SOURCE)} → ${path.relative(repoRoot, OUT_EXE)} via ${csc} ...`);
  const r = spawnSync(csc, ["-nologo", `-out:${OUT_EXE}`, SOURCE], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`[build:native] ERROR: csc.exe exited ${r.status}`);
    return 1;
  }
  log(`built OK: ${OUT_EXE}`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main());
