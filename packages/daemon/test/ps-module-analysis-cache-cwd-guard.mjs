import "./_guard.mjs";
// STANDING GUARD (card d5432aff) — win32 ONLY. When a test sandboxes USERPROFILE/HOME to a bare temp
// dir (the near-universal pattern in this suite), `[Environment]::GetFolderPath("LocalApplicationData")`
// silently resolves to "" — a folder-EXISTENCE check against `%USERPROFILE%\AppData\Local`, NOT an
// env-var-presence one (`$env:LOCALAPPDATA` itself stays correct). PowerShell's own module-analysis-cache
// feature then falls back to a path relative to CWD, leaving an untracked
// `Microsoft/Windows/PowerShell/ModuleAnalysisCache` in whatever worktree a test happened to run from —
// which can flag a gate verdict as "worktree changed while the gate ran" and trip dirty-tree checks.
//
// THE REAL CACHE WRITE WAS NOT REPRODUCED DETERMINISTICALLY — not by this card's own investigation, and
// not by worker d598dab0's prior one. Every attempt (the real `WIN32_SWEEP_PS_COMMAND` Get-CimInstance
// call, `Get-Module -ListAvailable`, a trailing sleep for the async analysis job, 5x in a loop) produced
// zero residue under a sandboxed USERPROFILE with cwd set to a throwaway temp dir. So this file does NOT
// assert "no Microsoft/ dir appears" (that would be a fixed-wait-shaped unfalsifiable negative — it would
// pass whether or not the fix works, since the write can't be forced either way). Instead it proves the
// MECHANISM the fix addresses:
//   (A) the precondition — LocalApplicationData really does resolve empty under exactly this sandbox
//       shape (plus an ambient positive control, so the check isn't vacuously "always empty");
//   (B) a powershell.exe child spawned from a process that merely imports `test/_guard.mjs` (the
//       standalone `node test/x.mjs` path, no harness) sees `PSModuleAnalysisCachePath` pointing OUTSIDE
//       cwd — real end-to-end, not a specimen;
//   (C) `scripts/test-daemon.mjs` (the harness that spawns every OTHER test file as a child) carries the
//       SAME wiring for ITS OWN spawned children, closing the ~14% of files that don't import `_guard.mjs`
//       at all — a STATIC source-text check (spawning the real harness end-to-end for this one assertion
//       is impractical) with its own synthetic RED/GREEN specimens, since there's no live spawn to prove
//       it the way (B) does.
//
// Belongs on `CHANGED_SCRIPT_TEXT_SCANNER_REPO_PATHS` (git/worktrees.ts) — section (C) raw-reads real
// `packages/daemon/scripts/test-daemon.mjs` SOURCE TEXT (never dist/**, a .mjs script has no compile
// step), so a comment-only edit to that script could in principle flip it; added there alongside this
// file's own creation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { stripComments } from "./_strip-comments.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DAEMON_SCRIPT = path.join(__dirname, "..", "scripts", "test-daemon.mjs");
const GUARD_PATH = path.join(__dirname, "_guard.mjs");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

if (process.platform !== "win32") {
  check("SKIP (non-win32): this card's whole defect class (powershell.exe's own ModuleAnalysisCache) is win32-only", true);
  console.log("\n✅ ALL PASS (skipped on non-win32).");
  process.exit(0);
}

// ── Section A: the precondition itself ──
const LAD_PROBE = "Write-Output ([Environment]::GetFolderPath('LocalApplicationData'))";
function resolveLadUnder(env, cwd) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", LAD_PROBE], {
    env, cwd, encoding: "utf8", timeout: 15_000,
  }).trim();
}

const sandboxCwd = fs.mkdtempSync(path.join(os.tmpdir(), "loom-ps-cache-guard-cwd-"));
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-ps-cache-guard-home-"));
try {
  const ladAmbient = resolveLadUnder(process.env, sandboxCwd);
  check(`positive control: ambient env (no USERPROFILE sandbox) resolves LocalApplicationData to something real (got "${ladAmbient}")`,
    ladAmbient.length > 0);

  const ladSandboxed = resolveLadUnder({ ...process.env, USERPROFILE: sandboxHome }, sandboxCwd);
  check(`precondition reproduced: USERPROFILE sandboxed to a bare temp dir with no AppData\\Local resolves LocalApplicationData to EMPTY (got "${ladSandboxed}") — this is the fallback that writes a cache into cwd`,
    ladSandboxed === "");
} finally {
  fs.rmSync(sandboxCwd, { recursive: true, force: true });
  fs.rmSync(sandboxHome, { recursive: true, force: true });
}

// ── Section B: test/_guard.mjs's own fallback, exercised end-to-end from a real spawned child ──
// Dynamically imports _guard.mjs by absolute file:// URL (never a relative "./_guard.mjs" specifier,
// which would need the probe to physically live inside test/) so the probe can run from ANY cwd,
// including the sandboxed one this check cares about, with no file ever written into test/ itself (a
// loose file there would be picked up by the suite's own test-discovery).
const GUARD_PROBE_CODE =
  'import { pathToFileURL } from "node:url";\n' +
  "await import(pathToFileURL(process.env.LOOM_GUARD_PATH).href);\n" +
  'process.stdout.write(process.env.PSModuleAnalysisCachePath || "");\n';

function readGuardSetPsModuleCachePath(cwd) {
  const childEnv = { ...process.env, LOOM_GUARD_PATH: GUARD_PATH };
  delete childEnv.PSModuleAnalysisCachePath; // prove the FALLBACK fires, not an inherited ambient value
  return execFileSync(process.execPath, ["--input-type=module", "-e", GUARD_PROBE_CODE], {
    cwd, env: childEnv, encoding: "utf8", timeout: 15_000,
  }).trim();
}

const probeCwd = fs.mkdtempSync(path.join(os.tmpdir(), "loom-ps-cache-guard-probecwd-"));
try {
  const setPath = readGuardSetPsModuleCachePath(probeCwd);
  check(`_guard.mjs fallback: importing it alone (no harness) sets PSModuleAnalysisCachePath to a non-empty value (got "${setPath}")`,
    setPath.length > 0);
  check(`_guard.mjs fallback: the value is OUTSIDE cwd (${probeCwd}), not a cwd-relative fallback path (got "${setPath}")`,
    setPath.length > 0 && !path.resolve(setPath).toLowerCase().startsWith(path.resolve(probeCwd).toLowerCase()));
  check(`_guard.mjs fallback: the value lives under the OS temp dir (got "${setPath}")`,
    setPath.length > 0 && path.resolve(setPath).toLowerCase().startsWith(path.resolve(os.tmpdir()).toLowerCase()));
} finally {
  fs.rmSync(probeCwd, { recursive: true, force: true });
}

// ── Section C: scripts/test-daemon.mjs carries the SAME wiring for its OWN spawned children — a static
// source-text check (presence-only; the harness's own per-child spawn is impractical to exercise
// end-to-end just for this one assertion) with its own synthetic RED/GREEN specimens, since there is no
// live spawn here to prove it the way Section B does. ──
function sourceHasPsModuleCacheWiring(source) {
  const stripped = stripComments(source);
  return stripped.includes('process.platform === "win32"')
    && stripped.includes("!process.env.PSModuleAnalysisCachePath")
    && stripped.includes("PSModuleAnalysisCachePath:");
}

const SPECIMEN_WITHOUT_WIRING =
  'const r = await spawnWithTimeout(process.execPath, [file], {\n' +
  "  timeoutMs,\n" +
  '  env: { ...process.env, LOOM_HOME: home, LOOM_PORT: String(port), LOOM_TEST: "1" },\n' +
  "});\n";
const SPECIMEN_WITH_WIRING =
  'const r = await spawnWithTimeout(process.execPath, [file], {\n' +
  "  timeoutMs,\n" +
  "  env: {\n" +
  '    ...process.env, LOOM_HOME: home, LOOM_PORT: String(port), LOOM_TEST: "1",\n' +
  '    ...(process.platform === "win32" && !process.env.PSModuleAnalysisCachePath\n' +
  '      ? { PSModuleAnalysisCachePath: path.join(home, "ps-module-analysis-cache", "ModuleAnalysisCache") }\n' +
  "      : {}),\n" +
  "  },\n" +
  "});\n";
// Negative control: mentions "win32" and an unrelated negated env check, but never PSModuleAnalysisCachePath
// at all — must still read as missing, proving the detector isn't satisfied by a near-miss.
const SPECIMEN_UNRELATED_WIN32_CHECK =
  'const r = await spawnWithTimeout(process.execPath, [file], {\n' +
  "  timeoutMs,\n" +
  '  env: { ...process.env, ...(process.platform === "win32" && !process.env.SOME_OTHER_FLAG ? { SOME_OTHER_FLAG: "1" } : {}) },\n' +
  "});\n";

check("sanity (RED specimen): a runOne shape without the PSModuleAnalysisCachePath wiring is flagged missing",
  !sourceHasPsModuleCacheWiring(SPECIMEN_WITHOUT_WIRING));
check("sanity (GREEN specimen): the SAME shape WITH the wiring is recognized as fixed",
  sourceHasPsModuleCacheWiring(SPECIMEN_WITH_WIRING));
check("negative control: an unrelated win32-gated env check (no PSModuleAnalysisCachePath at all) is never mistaken for this wiring",
  !sourceHasPsModuleCacheWiring(SPECIMEN_UNRELATED_WIN32_CHECK));

const testDaemonSource = fs.readFileSync(TEST_DAEMON_SCRIPT, "utf8");
check("real corpus: scripts/test-daemon.mjs's own child-spawn env carries the win32-only PSModuleAnalysisCachePath wiring",
  sourceHasPsModuleCacheWiring(testDaemonSource));

console.log(failures === 0
  ? "\n✅ ALL PASS — the broken-LocalApplicationData precondition reproduces under a sandboxed USERPROFILE " +
    "with no AppData\\Local, test/_guard.mjs's fallback redirects PSModuleAnalysisCachePath outside cwd for " +
    "a standalone `node test/x.mjs` run, and scripts/test-daemon.mjs independently carries the same wiring " +
    "for every child IT spawns under the harness."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
