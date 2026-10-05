import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card adeb453f — pure parseNpmCmdShim/winCmdShimSpawnTarget LOGIC checks, deliberately in a
// PLATFORM-INDEPENDENT file (unlike codescape-cmd-shim-real-spawn.mjs, which WARN-SKIPs its entire body
// on non-win32 because its job is a REAL spawn). parseNpmCmdShim itself has no platform gate — it's pure
// text/path parsing — so ubuntu CI should actually run these checks, not skip them (the gap item 5 of the
// card's review named: "the real-spawn file WARN-SKIPs on ubuntu CI, so CI never runs them").
//
// Fixtures are byte-exact (CRLF) copies of REAL shim shapes captured from this host on 2026-10-04:
//   - the modern npm cmd-shim template (verified against %APPDATA%\npm\codex.cmd / corepack.cmd /
//     pnpm.cmd — all genuine `npm install -g` outputs, byte-identical in structure)
//   - a real pnpm-global shim (`pnpm add -g semver`, run in an isolated throwaway PNPM_HOME, never the
//     real one)
// See docs/decisions/adeb453f-npm-cmd-shim-node-only-anchored-containment.md for the full narrative and
// the upstream cmd-shim source this was cross-checked against.
//
// Run after a build: pnpm --filter @loom/daemon build && node packages/daemon/test/resolve-bin-cmd-shim-parse.mjs
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { parseNpmCmdShim, needsWindowsCmdShim, winCmdShimSpawnTarget } from "../dist/pty/resolve-bin.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const checkThrows = (label, fn, messageIncludes) => {
  let threw = null;
  try { fn(); } catch (err) { threw = err; }
  const ok = threw instanceof Error && (!messageIncludes || threw.message.includes(messageIncludes));
  check(`${label} (threw=${!!threw}${messageIncludes ? `, message includes "${messageIncludes}"` : ""})`, ok);
};

const tmpHome = mkdtempManaged("loom-resolve-bin-parse-");

/** The modern npm cmd-shim template (verified byte-identical, modulo the entry path, against this
 *  host's real codex.cmd/corepack.cmd/pnpm.cmd). `relativeEntry` is the %dp0%-relative entry path. */
function npmCmdShimTemplate(relativeEntry) {
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

/** The same template but with the shebang interpreter set to `deno` instead of `node` — a REAL shape
 *  `cmd-shim` produces for a deno-shebanged target script (`#!/usr/bin/env deno`); confirmed against
 *  upstream cmd-shim source: `_prog`/`longProg` are derived from the shebang's own interpreter word,
 *  with no node-specific special-casing. Card finding 1: the OLD parser ignored this entirely and always
 *  launched the entry under node regardless. */
function denoCmdShimTemplate(relativeEntry) {
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
    'IF EXIST "%dp0%\\deno.exe" (',
    '  SET "_prog=%dp0%\\deno.exe"',
    ") ELSE (",
    '  SET "_prog=deno"',
    "  SET PATHEXT=%PATHEXT:;.JS;=;%",
    ")",
    "",
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${relativeEntry}" %*`,
    "",
  ].join("\r\n");
}

/** A real pnpm-global shim (`pnpm add -g semver`), bytes captured verbatim from an isolated throwaway
 *  PNPM_HOME on this host, with the install-specific absolute segments parameterized. No dp0/_prog
 *  indirection at all — `%~dp0` used directly, two independent literal invocation lines. */
function pnpmGlobalShimTemplate(relativeEntry) {
  return [
    "@SETLOCAL",
    '@IF NOT DEFINED NODE_PATH (',
    '  @SET "NODE_PATH=C:\\fake\\pnpm\\global\\5\\node_modules"',
    ") ELSE (",
    '  @SET "NODE_PATH=C:\\fake\\pnpm\\global\\5\\node_modules;%NODE_PATH%"',
    ")",
    '@IF EXIST "%~dp0\\node.exe" (',
    `  "%~dp0\\node.exe"  "%~dp0\\${relativeEntry}" %*`,
    ") ELSE (",
    "  @SET PATHEXT=%PATHEXT:;.JS;=;%",
    `  node  "%~dp0\\${relativeEntry}" %*`,
    ")",
    "",
  ].join("\r\n");
}

function writeShim(dirName, fileName, content) {
  const dir = path.join(tmpHome, dirName);
  fs.mkdirSync(dir, { recursive: true });
  const shimPath = path.join(dir, fileName);
  fs.writeFileSync(shimPath, content);
  return { dir, shimPath };
}

// ===================== genuine modern-npm shim: accepted, entry + nodeBin resolved correctly =====================
{
  const { dir, shimPath } = writeShim("genuine", "corepack.cmd", npmCmdShimTemplate("node_modules\\corepack\\dist\\corepack.js"));
  const parsed = parseNpmCmdShim(shimPath);
  const expectedEntry = path.resolve(path.join(dir, "node_modules", "corepack", "dist", "corepack.js"));
  check("(genuine) entry resolves to the real relative path, joined onto the shim's own dir", parsed.entry === expectedEntry);
  check("(genuine) nodeBin falls back to the currently-running node (no sibling node.exe present)", parsed.nodeBin === process.execPath);
}

// ===================== sibling node.exe preferred when present on disk =====================
{
  const { dir, shimPath } = writeShim("sibling", "corepack.cmd", npmCmdShimTemplate("node_modules\\corepack\\dist\\corepack.js"));
  const siblingNodeExe = path.join(dir, "node.exe");
  fs.writeFileSync(siblingNodeExe, ""); // never executed — parsing only ever checks fs.existsSync
  const parsed = parseNpmCmdShim(shimPath);
  check("(sibling) nodeBin prefers the shim's own sibling node.exe when present on disk", parsed.nodeBin === siblingNodeExe);
}

// ===================== finding 1: a real deno-shebang shim is REFUSED, never silently run under node =====================
{
  const { shimPath } = writeShim("deno", "fake-deno-cli.cmd", denoCmdShimTemplate("node_modules\\fake-deno-cli\\bin\\cli.js"));
  checkThrows(
    "(deno) a cmd-shim whose _prog names deno (not node) is refused, not silently launched under node",
    () => parseNpmCmdShim(shimPath),
    "expected exactly one node-interpreter dispatch block",
  );
}

// ===================== finding 2: a decoy REM line before the real block never wins =====================
{
  const relativeEntry = "node_modules\\real-pkg\\bin\\real.js";
  const genuine = npmCmdShimTemplate(relativeEntry);
  // Insert a decoy BEFORE the real dp0/_prog block — the exact shape the card called out: a REM-commented
  // fake invocation line naming a different (and traversing) entry.
  const withDecoy = genuine.replace(
    "CALL :find_dp0\r\n",
    'CALL :find_dp0\r\nREM "%_prog%" "%dp0%\\..\\decoy.js" %*\r\n',
  );
  const { dir, shimPath } = writeShim("decoy", "real-pkg.cmd", withDecoy);
  const parsed = parseNpmCmdShim(shimPath);
  const expectedEntry = path.resolve(path.join(dir, "node_modules", "real-pkg", "bin", "real.js"));
  check("(decoy) a REM-commented decoy line before the real block never wins — the REAL entry is extracted", parsed.entry === expectedEntry);
  check("(decoy) the decoy's own path never appears in the resolved entry", !parsed.entry.includes("decoy.js"));
}

// ===================== ambiguous: two full dispatch blocks refuses rather than picking the first =====================
{
  const block1 = npmCmdShimTemplate("node_modules\\pkg-one\\bin\\one.js");
  const block2 = npmCmdShimTemplate("node_modules\\pkg-two\\bin\\two.js");
  // Splice block2's own IF/ELSE+invocation portion in again right after block1's — two complete,
  // independently-matchable dispatch blocks in one file.
  const secondBlockOnly = block2.slice(block2.indexOf('IF EXIST "%dp0%\\node.exe"'));
  const twoBlocks = block1 + "\r\n" + secondBlockOnly;
  const { shimPath } = writeShim("ambiguous", "two-blocks.cmd", twoBlocks);
  checkThrows(
    "(ambiguous) two complete dispatch blocks in one file refuses (never silently picks the first)",
    () => parseNpmCmdShim(shimPath),
    "found 2",
  );
}

// ===================== non-empty shebang-args segment is refused =====================
{
  const relativeEntry = "node_modules\\pkg\\bin\\cli.js";
  const genuine = npmCmdShimTemplate(relativeEntry);
  // A real cmd-shim for `#!/usr/bin/env node --harmony` inserts the args text right between "%_prog%"
  // and the entry's opening quote.
  const withArgs = genuine.replace('"%_prog%"  "%dp0%', '"%_prog%" --harmony "%dp0%');
  const { shimPath } = writeShim("args", "pkg.cmd", withArgs);
  checkThrows(
    "(args) a shim whose shebang carried interpreter args (--harmony) is refused, not misparsed",
    () => parseNpmCmdShim(shimPath),
    "expected exactly one node-interpreter dispatch block",
  );
}

// ===================== containment: a relative entry that `..`s outside the shim's own directory tree =====================
{
  const { shimPath } = writeShim("traversal", "evil.cmd", npmCmdShimTemplate("..\\..\\evil.js"));
  checkThrows(
    "(containment) an entry that resolves outside the shim's own directory tree is refused",
    () => parseNpmCmdShim(shimPath),
    "resolves outside the shim's own directory",
  );
}

// ===================== decision: a real pnpm-global shim is refused, not special-cased =====================
{
  const { shimPath } = writeShim("pnpm-global", "semver.CMD", pnpmGlobalShimTemplate("global\\5\\.pnpm\\semver@7.8.5\\node_modules\\semver\\bin\\semver.js"));
  checkThrows(
    "(pnpm) a real pnpm-global shim shape is refused — no dp0/_prog indirection to anchor on",
    () => parseNpmCmdShim(shimPath),
    "missing its dp0 lookup",
  );
}

// ===================== a hand-authored, non-cmd-shim .cmd/.bat is refused =====================
{
  const { shimPath } = writeShim("bogus", "bogus.cmd", "@echo off\r\necho not an npm cmd-shim\r\n");
  checkThrows(
    "(bogus) a hand-authored .cmd with no dp0 lookup is refused",
    () => parseNpmCmdShim(shimPath),
    "missing its dp0 lookup",
  );
}

// ===================== needsWindowsCmdShim / winCmdShimSpawnTarget — platform-gated, both branches asserted =====================
check("(shim) needsWindowsCmdShim is true for a resolved .cmd ONLY on win32", needsWindowsCmdShim("C:\\x\\y.cmd") === (process.platform === "win32"));
check("(shim) needsWindowsCmdShim is false for a real .exe regardless of platform", needsWindowsCmdShim("C:\\x\\y.exe") === false);
{
  const t = winCmdShimSpawnTarget("C:\\x\\y.exe", ["a", "b"]);
  check("(shim) winCmdShimSpawnTarget is a byte-identical passthrough for a non-.cmd command, any platform", t.command === "C:\\x\\y.exe" && JSON.stringify(t.args) === JSON.stringify(["a", "b"]));
}
if (process.platform === "win32") {
  const { dir, shimPath } = writeShim("reroute", "corepack.cmd", npmCmdShimTemplate("node_modules\\corepack\\dist\\corepack.js"));
  const t = winCmdShimSpawnTarget(shimPath, ["ingest", "a b"]);
  const expectedEntry = path.resolve(path.join(dir, "node_modules", "corepack", "dist", "corepack.js"));
  check("(win32) a .cmd command is rerouted to node directly, not cmd.exe", t.command === process.execPath);
  check("(win32) rerouted args are [entry, ...originalArgs]", JSON.stringify(t.args) === JSON.stringify([expectedEntry, "ingest", "a b"]));
} else {
  const { shimPath } = writeShim("reroute", "corepack.cmd", npmCmdShimTemplate("node_modules\\corepack\\dist\\corepack.js"));
  const t = winCmdShimSpawnTarget(shimPath, ["ingest"]);
  check("(non-win32) winCmdShimSpawnTarget never reroutes — needsWindowsCmdShim is unconditionally false off win32", t.command === shimPath && JSON.stringify(t.args) === JSON.stringify(["ingest"]));
}

await finishAndExit(failures === 0 ? 0 : 1);
