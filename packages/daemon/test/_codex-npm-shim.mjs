// Card e92cd4a3 — shared Windows test fixture: a REAL npm `cmd-shim`-shaped `codex.cmd` (the template npm
// writes for a global install, same shape as test/codescape-cmd-shim-real-spawn.mjs's) whose entry is a copy
// of a self-contained fixture CLI. `createCodexPty` now resolves a `.cmd` bin through `winCmdShimSpawnTarget`
// (node + the shim's real entry, fail closed on an unrecognised shim), so a bare `@node fixture %*` wrapper
// no longer parses; every Windows codex spawn fixture goes through this one writer instead. The fixture
// must import only node: builtins (it is copied, not linked).
import fs from "node:fs";
import path from "node:path";

/** The npm `cmd-shim` template; `relativeEntry` is the `%dp0%`-relative backslash path to the entry script. */
export function npmCmdShimTemplate(relativeEntry) {
  return [
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
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${relativeEntry}" %*`,
    "",
  ].join("\r\n");
}

/** Write `<dir>/<name>.cmd` (+ its `node_modules/<name>/bin/<name>.mjs` entry copied from `fixturePath`);
 *  returns the absolute shim path. win32 only in practice (the caller gates on it). */
export function writeNpmCodexShim(dir, fixturePath, name = "fake-codex") {
  const binDir = path.join(dir, "node_modules", name, "bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.copyFileSync(fixturePath, path.join(binDir, `${name}.mjs`));
  const shimPath = path.join(dir, `${name}.cmd`);
  fs.writeFileSync(shimPath, npmCmdShimTemplate(`node_modules\\${name}\\bin\\${name}.mjs`));
  return shimPath;
}
