import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card fafae623: assets/env-isolated-launch.mjs deliberately DUPLICATES pty/resolve-bin.ts's
// needsWindowsCmdShim/parseNpmCmdShim/winCmdShimSpawnTarget (every asset script in this directory is
// dist-free by convention — see env-isolated-launch.mjs's own doc). This file pins the two copies
// IDENTICAL against the same corpus of inputs, so they can't silently drift apart. DETERMINISTIC +
// CLAUDE-FREE + NETWORK-FREE.
//
// Proves:
//   (a) the npm-cmd-shim-matching REGEX source text is byte-identical between the two files (the single
//       most security-relevant thing to keep in sync).
//   (b) needsWindowsCmdShim (dist) and needsWindowsCmdHandling (asset) agree on every tested command path.
//   (c) parseNpmCmdShim: for a GENUINE npm-cmd-shim-shaped file, both resolve the SAME {entry, nodeBin} —
//       dist via its throwing contract, asset via its null-returning contract (different error shapes by
//       design: the asset needs a non-throwing "try path A, fall back to path B" flow; the dist version's
//       callers wrap it in try/catch at a higher level). For a NON-matching file (Node's own bundled
//       npx.cmd shape), both REJECT it — dist by throwing, asset by returning null.
//
// Run: 1) build (turbo builds shared first), 2) node test/win-cmd-shim-parity.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSET = path.join(__dirname, "..", "assets", "env-isolated-launch.mjs");

const distSrc = fs.readFileSync(path.join(__dirname, "..", "src", "pty", "resolve-bin.ts"), "utf8");
const assetSrc = fs.readFileSync(ASSET, "utf8");

// ===================== (a) regex source text parity (BOTH gate regexes — the block AND the dp0 marker) =====================
const BLOCK_REGEX_LABEL_RE = /const NPM_CMD_SHIM_NODE_BLOCK_RE =\s*\n?\s*(\/.*\/gi);/;
const DP0_REGEX_LABEL_RE = /const NPM_CMD_SHIM_DP0_MARKER = (\/.*\/i);/;
for (const [label, re] of [["NPM_CMD_SHIM_NODE_BLOCK_RE", BLOCK_REGEX_LABEL_RE], ["NPM_CMD_SHIM_DP0_MARKER", DP0_REGEX_LABEL_RE]]) {
  const distMatch = distSrc.match(re);
  const assetMatch = assetSrc.match(re);
  check(`(a) the dist source still declares ${label} (sanity — the extraction pattern itself works)`, !!distMatch);
  check(`(a) the asset source still declares ${label} (sanity)`, !!assetMatch);
  if (distMatch && assetMatch) {
    check(`(a) ${label}'s source text is BYTE-IDENTICAL between pty/resolve-bin.ts and assets/env-isolated-launch.mjs`,
      distMatch[1] === assetMatch[1]);
  }
}

const { needsWindowsCmdShim, parseNpmCmdShim: distParse, winCmdShimSpawnTarget: distShim } = await import("../dist/pty/resolve-bin.js");
const { needsWindowsCmdHandling, parseNpmCmdShim: assetParse, winCmdShimSpawnTarget: assetShim } = await import(pathToFileURL(ASSET).href);

// ===================== (b) needsWindowsCmdShim / needsWindowsCmdHandling agree =====================
for (const cmd of ["C:\\x\\npx.cmd", "C:\\x\\npx.CMD", "C:\\x\\run.bat", "C:\\x\\node.exe", "/usr/bin/markitdown-mcp", "C:\\x\\thing.Bat"]) {
  check(`(b) needsWindowsCmdShim/needsWindowsCmdHandling agree on ${JSON.stringify(cmd)}`,
    needsWindowsCmdShim(cmd) === needsWindowsCmdHandling(cmd));
}

// ===================== (c) parseNpmCmdShim: genuine shim + non-matching file =====================
{
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "loom-shimparity-"));
  const shimPath = path.join(scratchDir, "fake-cli.cmd");
  // The modern npm cmd-shim template, VERIFIED byte-identical (modulo the entry path) against a real
  // host's codex.cmd/corepack.cmd/pnpm.cmd — see resolve-bin-cmd-shim-parse.mjs's own npmCmdShimTemplate,
  // which this mirrors. Includes the `:find_dp0`/`CALL :find_dp0` preamble NPM_CMD_SHIM_DP0_MARKER
  // requires — a shim missing it (as an earlier, incomplete asset-side fixture here did) must be
  // REJECTED, not accepted; that gap is exactly what this parity test is for.
  const genuineShim = [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\cli.js" %*',
    "",
  ].join("\r\n");
  fs.writeFileSync(shimPath, genuineShim);
  fs.writeFileSync(path.join(scratchDir, "cli.js"), "// entry");

  if (process.platform === "win32") {
    let distResult, distThrew = false;
    try { distResult = distParse(shimPath); } catch { distThrew = true; }
    const assetResult = assetParse(shimPath);
    check("(c) a genuine npm-cmd-shim: dist does NOT throw", !distThrew);
    check("(c) a genuine npm-cmd-shim: asset does NOT return null", assetResult !== null);
    if (!distThrew && assetResult) {
      check("(c) a genuine npm-cmd-shim: both resolve the SAME entry path", distResult.entry === assetResult.entry);
      check("(c) a genuine npm-cmd-shim: both resolve the SAME nodeBin", distResult.nodeBin === assetResult.nodeBin);
    }
    const distShimResult = distShim(shimPath, ["--version"]);
    const assetShimResult = assetShim(shimPath, ["--version"]);
    check("(c) winCmdShimSpawnTarget/winCmdShimSpawnTarget (asset) agree on the resolved {command,args}",
      JSON.stringify(distShimResult) === JSON.stringify(assetShimResult));
  } else {
    console.log("SKIP  (c) genuine-npm-cmd-shim parsing is win32-only (needsWindowsCmdShim is false off win32, both sides no-op)");
  }

  // Node's OWN bundled npx.cmd shape — neither side should accept it as an npm-cmd-shim.
  const npxLikePath = path.join(scratchDir, "npx-like.cmd");
  fs.writeFileSync(npxLikePath, '@ECHO OFF\r\nSETLOCAL\r\nSET "NODE_EXE=%~dp0\\node.exe"\r\n"%NODE_EXE%" "%~dp0\\npx-cli.js" %*\r\n');
  let distThrewOnNpx = false;
  try { distParse(npxLikePath); } catch { distThrewOnNpx = true; }
  check("(c) Node's own npx.cmd shape: dist REJECTS it (throws)", distThrewOnNpx);
  check("(c) Node's own npx.cmd shape: asset REJECTS it (returns null)", assetParse(npxLikePath) === null);

  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the asset launcher's duplicated npm-cmd-shim parser (needsWindowsCmdHandling/parseNpmCmdShim/winCmdShimSpawnTarget) stays byte-identical in its matching regex and agrees with pty/resolve-bin.ts's own copy on every tested input, including a genuine npm-cmd-shim and Node's own bundled npx.cmd shape (correctly rejected by both) — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
