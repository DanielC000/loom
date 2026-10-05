// Card 12c6f580 — orchestration/usage-status.ts's prewarmClaudeVersionAsync previously called
// `execFile(bin, ["--version"])` with NO shell and a swallowing `if (err) return`, so on Windows an
// npm-installed claude (a real npm `cmd-shim`-generated `.cmd` file) hit Node's synchronous EINVAL
// (CVE-2024-27980 mitigation) and the version cache silently no-opped forever — no log, no throw, a green
// test suite. The existing hermetic `claude-version-prewarm.mjs` could never catch this: it only ever
// substitutes LOOM_CLAUDE_BIN with this test runner's OWN real `.exe`, never a `.cmd` shim, so it never
// exercised the actual Windows cmd-shim spawn boundary (memory `real-spawn-smoke-for-subprocess-features`).
//
// Fixed by reusing card 7b2670d8's `winCmdShimSpawnTarget`/`parseNpmCmdShim` (pty/resolve-bin.ts) — already
// real-spawn-proven by codescape-cmd-shim-real-spawn.mjs — to parse a real npm cmd-shim and spawn node +
// its real entry script directly, never cmd.exe/shell:true (decision 8ddd12c6: every spawned child would
// become cmd.exe itself, orphaning the real process on kill(), and reopening the CVE's escaping gap).
//
// This file drives `prewarmClaudeVersionAsync`/`getCachedClaudeVersion` against:
//   (1) a REFUSED, non-npm-shaped `.cmd` file — proves `winCmdShimSpawnTarget`'s synchronous throw (new
//       code path this fix wraps in try/catch) is CAUGHT and SURFACED via console.warn, never escapes
//       prewarmClaudeVersionAsync and never silently swallowed, and the cache stays null (never throws
//       into a false appearance of progress).
//   (2) a REAL npm cmd-shim-shaped `.cmd` file (the same template codescape-cmd-shim-real-spawn.mjs
//       verified against this host's real npm-installed `.cmd` shims) pointed at a fixture CLI that prints
//       a version string — no real claude, no network — proving the cache actually fills through the real
//       shim on win32.
// Order matters: (1) runs FIRST, while the module-level cache is still cold (claude-version-prewarm.mjs's
// own ordering note applies identically here — prewarmClaudeVersionAsync's early-return guard would mask
// the error path once the cache is warm).
//
// Mirrors codex-version-real-spawn.mjs / codescape-cmd-shim-real-spawn.mjs's own win32-only fixture-shim
// shape (see either file's header for the accepted POSIX gap this mirrors) — pure/platform-independent
// logic (e.g. winCmdShimSpawnTarget's own parsing) is already covered there, not duplicated here.
//
// Run (after a build): node test/usage-status-cmdshim-real-spawn.mjs
import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

if (process.platform !== "win32") {
  // Card 85bd4052-shaped WARN SKIP (see codex-version-real-spawn.mjs's own header): the `.cmd`-wrapper
  // fixture mechanism this file uses is Windows-only.
  console.log("WARN  SKIP  usage-status-cmdshim-real-spawn.mjs — the .cmd-wrapper fixture this file uses is Windows-only (process.platform !== 'win32' here); see codex-version-real-spawn.mjs's header for the accepted POSIX gap this mirrors.");
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_CLI = path.join(__dirname, "fixtures", "fake-claude-version-cli.mjs");

if (!process.env.LOOM_HOME) process.env.LOOM_HOME = mkdtempManaged("loom-cvp-cmdshim-");
const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

/** The real npm `cmd-shim` template — byte-identical to codescape-cmd-shim-real-spawn.mjs's own (verified
 *  against this host's real npm-installed `codex.cmd`/`corepack.cmd`/`pnpm.cmd`, all byte-identical). */
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

const tmpHome = process.env.LOOM_HOME;
const { getCachedClaudeVersion, prewarmClaudeVersionAsync } = await import("../dist/orchestration/usage-status.js");

const warnLog = [];
const originalWarn = console.warn;
console.warn = (...args) => { warnLog.push(args.join(" ")); };
const restoreWarn = () => { console.warn = originalWarn; };

// ===================== (1) refused: a non-npm .cmd is surfaced, never swallowed, never throws =========
check("cold cache: getCachedClaudeVersion() is null before anything runs", getCachedClaudeVersion() === null);

const bogusDir = path.join(tmpHome, "bogus-install");
fs.mkdirSync(bogusDir, { recursive: true });
const bogusShim = path.join(bogusDir, "fake-claude.cmd");
fs.writeFileSync(bogusShim, "@echo off\r\necho not an npm cmd-shim\r\n");
process.env.LOOM_CLAUDE_BIN = bogusShim;

let threwSync = false;
try { prewarmClaudeVersionAsync(); } catch { threwSync = true; }
// The refusal is fully SYNCHRONOUS (parseNpmCmdShim throws, caught, and console.warn'd before
// prewarmClaudeVersionAsync even returns) — no async gap exists here to wait out, so every assertion below
// reads real settled state, not a guess about how long an async path would take.
check("prewarm never throws SYNCHRONOUSLY even when winCmdShimSpawnTarget refuses the shim", threwSync === false);
check("the refused shim's error was SURFACED via console.warn (not silently swallowed)", warnLog.some((m) => m.includes("[usage-status]") && m.includes("claude version prewarm failed")));
check("a refused shim leaves the cache null (graceful degrade, not a false success)", getCachedClaudeVersion() === null);

warnLog.length = 0;

// ===================== (2) success: a real npm cmd-shim resolves and the cache fills ===================
const installDir = path.join(tmpHome, "npm-install");
fs.mkdirSync(path.join(installDir, "node_modules", "fake-claude", "bin"), { recursive: true });
const entryPath = path.join(installDir, "node_modules", "fake-claude", "bin", "fake-claude.mjs");
fs.copyFileSync(FIXTURE_CLI, entryPath);
const shimPath = path.join(installDir, "fake-claude.cmd");
fs.writeFileSync(shimPath, npmCmdShimTemplate("node_modules\\fake-claude\\bin\\fake-claude.mjs"));
process.env.LOOM_CLAUDE_BIN = shimPath;

prewarmClaudeVersionAsync();
await waitUntil(() => getCachedClaudeVersion() !== null, { timeoutMs: 5000, label: "claude version cache populated via real npm cmd-shim" }).catch(() => {});
check("prewarm resolved a version through the REAL npm cmd-shim (not swallowed as EINVAL)", getCachedClaudeVersion() === "1.2.3");
check("no spurious console.warn was logged on the success path", warnLog.length === 0);

// ===================== idempotent: a second call once warm is a no-op (never re-probes) ================
{
  const warmValue = getCachedClaudeVersion();
  prewarmClaudeVersionAsync();
  check("a second prewarm call once warm leaves the cache unchanged (idempotent)", getCachedClaudeVersion() === warmValue);
}

restoreWarn();
console.log(failures === 0
  ? "\n✅ ALL PASS — a refused .cmd shim is surfaced via console.warn (never thrown, never silently swallowed), and a real npm cmd-shim fills the version cache via a REAL child process."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
