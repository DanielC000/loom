import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 4084fadb — HERMETIC pin that `createCodexPty`'s spawn argv always carries the update-check
// suppression override (`CODEX_UPDATE_CHECK_OVERRIDE_ARGS`, codex-host.ts), independent of whether an
// update actually happens to be pending on the host running this test. The real-spawn proof
// (codex-prompt-ascii-fold-real-spawn.mjs, run manually against a genuinely-pending update on 2026-09-10)
// is the load-bearing pre-fix-RED/post-fix-GREEN evidence for the ACTUAL dialog suppression — that proof
// is only possible in the narrow window a real update is pending, so it can't be this project's ongoing
// regression guard. THIS file is: it asserts the argv shape directly, on every run, on any host, whether
// or not codex has a pending update right now — the gap the card's own DoD-3 names ("the real-spawn tests
// alone would read green on a broken fix" once the pending update is gone).
//
// SHAPE: mirrors pty-codex-spawn-env.mjs exactly (same fixture substitution technique, same
// LOOM_CODEX_BIN .cmd-wrapper trick) — drives the REAL (unsubclassed) `PtyHost.createCodexPty()` against a
// synthetic stand-in binary, never the real installed `codex` CLI, so this never touches
// `~/.codex/config.toml` and needs no `acquireCodexRealSpawnLock()`.
//
// WINDOWS-ONLY (mirrors pty-codex-spawn-env.mjs's own `.cmd`-wrapper mechanism). SKIPS (exit 0) on
// non-win32 rather than silently passing 0 checks.
//
// Run: 1) build (turbo builds shared first), 2) node test/codex-update-check-spawn-argv.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

if (process.platform !== "win32") {
  console.log("WARN  SKIP  codex-update-check-spawn-argv.mjs — the .cmd-wrapper fixture mechanism this file uses is Windows-only (process.platform !== 'win32' here); see this file's header for the accepted POSIX gap (mirrors pty-codex-spawn-env.mjs).");
  process.exit(0);
}

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "env-dump-cli.mjs");
const tmpHome = mkdtempManaged("loom-codex-update-check-argv-");
process.env.LOOM_HOME = tmpHome;

const wrapperPath = path.join(tmpHome, "fake-codex.cmd");
fs.writeFileSync(wrapperPath, `@"${process.execPath}" "${FIXTURE_PATH}" %*\r\n`);
process.env.LOOM_CODEX_BIN = wrapperPath;

const { PtyHost } = await import("../dist/pty/host.js");
const { CODEX_UPDATE_CHECK_OVERRIDE_ARGS } = await import("../dist/pty/codex-host.js");

check("CODEX_UPDATE_CHECK_OVERRIDE_ARGS is the expected [\"-c\", \"check_for_update_on_startup=false\"] pair", CODEX_UPDATE_CHECK_OVERRIDE_ARGS.length === 2 && CODEX_UPDATE_CHECK_OVERRIDE_ARGS[0] === "-c" && CODEX_UPDATE_CHECK_OVERRIDE_ARGS[1] === "check_for_update_on_startup=false");

const events = { onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onExit() {} };

/** Spawn `createCodexPty` once with the given opts overlay, wait for the fixture to dump its argv, return
 *  the argv it actually received (codex-bound args only — argv.slice(2) on the fixture side). */
async function spawnAndCaptureArgv(sessionId, optsOverlay) {
  const host = new PtyHost(events);
  const spawnCwd = fs.mkdtempSync(path.join(tmpHome, `cwd-${sessionId}-`));
  const envOutputFile = path.join(tmpHome, `env-${sessionId}.json`);
  const argvOutputFile = path.join(tmpHome, `argv-${sessionId}.json`);
  const opts = {
    sessionId, cwd: spawnCwd, permission: {}, geometry: { cols: 120, rows: 40 },
    sessionEnv: { FIXTURE_ENV_OUTPUT_FILE: envOutputFile, FIXTURE_ARGV_OUTPUT_FILE: argvOutputFile },
    role: "worker", harness: "codex",
    ...optsOverlay,
  };
  const pty = host.createCodexPty(opts);
  try {
    await waitUntil(() => fs.existsSync(argvOutputFile), { label: `${sessionId} fixture's argv dump file to appear` });
    return JSON.parse(fs.readFileSync(argvOutputFile, "utf8"));
  } finally {
    try { pty.kill(); } catch { /* best-effort */ }
  }
}

/** True iff `-c check_for_update_on_startup=false` appears as an ADJACENT pair anywhere in argv (never
 *  merely that both tokens are present somewhere unrelated). */
function hasUpdateCheckOverride(argv) {
  for (let i = 0; i < argv.length - 1; i++) {
    if (argv[i] === "-c" && argv[i + 1] === "check_for_update_on_startup=false") return true;
  }
  return false;
}

// --- fresh spawn (no resumeId, no fork) — the ordinary worker/manager/platform spawn AND recycle path
// (project memory codex-recycle-is-always-fresh-never-resume: recycle never sets resumeId either). --------
const freshArgv = await spawnAndCaptureArgv("codex-argv-fresh", {});
console.log(`[info] fresh spawn argv: ${JSON.stringify(freshArgv)}`);
check("fresh spawn argv carries the update-check override", hasUpdateCheckOverride(freshArgv));

// --- resume spawn (resumeId set, no fork) — buildCodexResumeArgs prepends ["resume", id] ahead of
// everything else; the override must still land, not get pushed off by the prepend. -----------------------
const resumeArgv = await spawnAndCaptureArgv("codex-argv-resume", { resumeId: "11111111-1111-1111-1111-111111111111" });
console.log(`[info] resume spawn argv: ${JSON.stringify(resumeArgv)}`);
check("resume spawn argv carries the update-check override", hasUpdateCheckOverride(resumeArgv));
check("resume spawn argv still leads with the resume subcommand (this test's own resumeArgs assumption holds)", resumeArgv[0] === "resume" && resumeArgv[1] === "11111111-1111-1111-1111-111111111111");

// --- fork spawn (resumeId set AND fork:true) — buildCodexResumeArgs deliberately drops resumeArgs here
// (a fresh session, per c6ce2804), so this proves the override survives on THAT branch too, not just the
// two exercised above. ---------------------------------------------------------------------------------
const forkArgv = await spawnAndCaptureArgv("codex-argv-fork", { resumeId: "22222222-2222-2222-2222-222222222222", fork: true });
console.log(`[info] fork spawn argv: ${JSON.stringify(forkArgv)}`);
check("fork spawn argv carries the update-check override", hasUpdateCheckOverride(forkArgv));
check("fork spawn argv does NOT lead with resume (fork forces a fresh spawn, per buildCodexResumeArgs)", forkArgv[0] !== "resume");

// --- negative control: the check function itself must be able to return false, or the three PASSes above
// prove nothing. -------------------------------------------------------------------------------------------
check("[negative control] hasUpdateCheckOverride returns false against argv genuinely missing the override", !hasUpdateCheckOverride(["-a", "never", "-s", "workspace-write"]));
check("[negative control] hasUpdateCheckOverride returns false against the two tokens present but NOT adjacent", !hasUpdateCheckOverride(["-c", "some_other_key=true", "check_for_update_on_startup=false"]));

console.log(failures === 0
  ? "\n✅ ALL PASS — createCodexPty's real spawn argv carries \"-c check_for_update_on_startup=false\" on a fresh spawn, a resume spawn, and a fork spawn alike (the three shapes buildCodexResumeArgs distinguishes), proven against a real OS child process substituted for codex via LOOM_CODEX_BIN, so this regresses loudly even when no codex update happens to be pending on the host running this test."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
