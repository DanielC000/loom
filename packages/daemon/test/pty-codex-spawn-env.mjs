import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 8d828fa4 — RED-before-GREEN proof that `createCodexPty`'s spawn env now flows through the SAME
// `buildSpawnEnv` + `scratchDirEnv` seam `createPty` already uses, instead of the old bare `process.env`
// copy that silently dropped `opts.sessionEnv` (a REQUIRED SpawnOpts field, read on the very next lines by
// `buildMcpServers` for `LOOM_PYTHON_INTERPRETER` and never merged into the actual spawn env) plus the
// git-safety vars (GIT_PAGER/PAGER/GIT_TERMINAL_PROMPT), LOOM_WORKTREE, the Python-encoding vars, and
// LOOM_SCRATCH_DIR.
//
// SHAPE: drives the REAL (unsubclassed) `PtyHost.createCodexPty()` directly — a REAL node-pty spawn, a
// REAL OS child process substituted for the codex binary via `LOOM_CODEX_BIN` (+ a generated `.cmd`
// wrapper on Windows) — the SAME substitution technique `kickoff-real-spawn.mjs` already established for
// `LOOM_CLAUDE_BIN`. Not a mocked exec (memory `real-spawn-smoke-for-subprocess-features`: mocking the
// exec impl never proves bytes cross a real OS process boundary). Calling `createCodexPty` directly
// (rather than `spawnCodexProcess`/`host.spawn`) deliberately bypasses ALL of codex's trust-dialog/busy/
// readiness machinery — none of that lives inside `createCodexPty` itself — so this file never touches the
// shared `~/.codex/config.toml` and needs no `acquireCodexRealSpawnLock`: it never runs the real, installed
// `codex` CLI at all, only a synthetic stand-in that dumps its own env and exits.
//
// WINDOWS-ONLY (mirrors kickoff-real-spawn.mjs): the `.cmd`-wrapper mechanism is Windows-specific. SKIPS
// (exit 0) on non-win32 rather than silently passing 0 checks.
//
// Run: 1) build (turbo builds shared first), 2) node test/pty-codex-spawn-env.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

if (process.platform !== "win32") {
  // Card 85bd4052 (sibling of 5978735a): MUST be a `WARN  ` line (exact two-space prefix, test-daemon.mjs's
  // own WARN_LINE_RE) — a bare `SKIP` line is discarded entirely once this file reports a pass, leaving
  // zero trace on ubuntu-latest CI that this file's real coverage never ran there.
  console.log("WARN  SKIP  pty-codex-spawn-env.mjs — the .cmd-wrapper fixture mechanism this file uses is Windows-only (process.platform !== 'win32' here); see this file's header for the accepted POSIX gap (mirrors kickoff-real-spawn.mjs).");
  process.exit(0);
}

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "env-dump-cli.mjs");
const tmpHome = mkdtempManaged("loom-codex-spawn-env-");
process.env.LOOM_HOME = tmpHome;

// A .cmd wrapper so node-pty (which spawns `bin` directly with an args ARRAY, no shell/interpreter
// indirection) can launch `node env-dump-cli.mjs` as the substitute "codex" binary — mirrors
// kickoff-real-spawn.mjs's identical LOOM_CLAUDE_BIN wrapper.
const wrapperPath = path.join(tmpHome, "fake-codex.cmd");
fs.writeFileSync(wrapperPath, `@"${process.execPath}" "${FIXTURE_PATH}" %*\r\n`);
process.env.LOOM_CODEX_BIN = wrapperPath;

const envOutputFile = path.join(tmpHome, "spawned-env.json");
process.env.FIXTURE_ENV_OUTPUT_FILE = envOutputFile;

// Positive-control setup for the CLAUDECODE/CLAUDE_CODE_* scrub check below: set them non-empty on THIS
// process's own env BEFORE spawning, so a later "absent from the child" assertion proves the scrub
// actually ran, rather than merely proving the vars were never present to begin with.
process.env.CLAUDECODE = "1";
process.env.CLAUDE_CODE_ENTRYPOINT = "cli";

// Card 9346ed5b: this HOST's own ambient shell env can ALREADY carry LOOM_OBSIDIAN_AUTOSTART=1 +
// LOOM_OBSIDIAN_PREFLIGHT (a real project running with obsidian.autoStart enabled locally sets these) —
// buildSpawnEnv reads the REAL `process.env` as its base, so leaving these ambient would make both the
// negative control below and the positive obsidian-variant spawn pass or fail for the wrong reason (host
// state, not this test's own scenario) — the exact "hermetic test" trap the worker doctrine warns about.
// Strip them from THIS test process's own env before any spawn so the fix-under-test is exercised on a
// clean baseline; the positive spawn below re-adds LOOM_OBSIDIAN_AUTOSTART via its own sessionEnv only.
delete process.env.LOOM_OBSIDIAN_AUTOSTART;
delete process.env.LOOM_OBSIDIAN_PREFLIGHT;

const { PtyHost } = await import("../dist/pty/host.js");
const { sessionScratchDir, ENSURE_OBSIDIAN_SCRIPT } = await import("../dist/paths.js");

const events = { onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onExit() {} };
const host = new PtyHost(events);

const SESSION_ID = "codex-spawn-env-test";
const spawnCwd = fs.mkdtempSync(path.join(tmpHome, "cwd-"));
const opts = {
  sessionId: SESSION_ID,
  cwd: spawnCwd,
  permission: {},
  geometry: { cols: 120, rows: 40 },
  sessionEnv: {
    LOOM_TEST_SESSIONENV_MARKER: "reached-codex-spawn",
    // Proves createCodexPty actually THREADS opts.sessionEnv into buildSpawnEnv (the defect this card
    // fixes), not merely that buildSpawnEnv itself honors an override in isolation (spawn-env.mjs already
    // proves that in general) — a sessionEnv PAGER override must still beat buildSpawnEnv's own PAGER=cat
    // default on the codex path specifically.
    PAGER: "less-override",
  },
  role: "worker",
  harness: "codex",
};

// --- exercise the REAL codex-path env builder ----------------------------------------------------------
const pty = host.createCodexPty(opts);

let spawnedEnv;
try {
  await waitUntil(() => fs.existsSync(envOutputFile), { label: "fixture's env dump file to appear" });
  spawnedEnv = JSON.parse(fs.readFileSync(envOutputFile, "utf8"));
} finally {
  try { pty.kill(); } catch { /* best-effort */ }
}

// --- the headline fix: opts.sessionEnv actually reaches the spawned codex child's REAL env --------------
check("opts.sessionEnv reaches the REAL spawned codex child env (the dropped-field defect this card fixes)", spawnedEnv.LOOM_TEST_SESSIONENV_MARKER === "reached-codex-spawn");
check("a sessionEnv override wins over buildSpawnEnv's own PAGER default on the codex path too", spawnedEnv.PAGER === "less-override");

// --- the rest of buildSpawnEnv's git-safety / worktree-anchor / Python-encoding vars, now wired ----------
check("GIT_PAGER=cat reaches the real codex child env", spawnedEnv.GIT_PAGER === "cat");
check("GIT_TERMINAL_PROMPT=0 reaches the real codex child env", spawnedEnv.GIT_TERMINAL_PROMPT === "0");
check("LOOM_WORKTREE is set to the spawn cwd on the real codex child env", spawnedEnv.LOOM_WORKTREE === spawnCwd);
check("PYTHONIOENCODING=utf-8 reaches the real codex child env", spawnedEnv.PYTHONIOENCODING === "utf-8");
check("PYTHONUTF8=1 reaches the real codex child env", spawnedEnv.PYTHONUTF8 === "1");

// --- scratchDirEnv wiring (this card's DoD item 1's "plus scratchDirEnv") --------------------------------
const expectedScratchDir = sessionScratchDir(SESSION_ID);
check("LOOM_SCRATCH_DIR reaches the real codex child env, matching sessionScratchDir(sessionId)", spawnedEnv.LOOM_SCRATCH_DIR === expectedScratchDir);
check("the scratch dir was actually created on disk (mirrors createPty's own eager, best-effort mkdir)", fs.existsSync(expectedScratchDir) && fs.statSync(expectedScratchDir).isDirectory());

// --- the CLAUDECODE/CLAUDE_CODE_* scrub is ALSO now live on the codex path (positive-controlled above) ---
check("CLAUDECODE is scrubbed from the real codex child env (positive-controlled: was '1' on this process's own env)", !("CLAUDECODE" in spawnedEnv));
check("CLAUDE_CODE_ENTRYPOINT (a CLAUDE_CODE_* var) is scrubbed from the real codex child env", !("CLAUDE_CODE_ENTRYPOINT" in spawnedEnv));

// --- negative control: LOOM_OBSIDIAN_PREFLIGHT must be ABSENT when autostart is off (this spawn's own opts
// never set LOOM_OBSIDIAN_AUTOSTART) — proves the obsidian block below only fires when it's meant to ------
check("[9346ed5b, negative control] LOOM_OBSIDIAN_PREFLIGHT is absent from the real codex child env when LOOM_OBSIDIAN_AUTOSTART is not set", !("LOOM_OBSIDIAN_PREFLIGHT" in spawnedEnv));

// --- Card 9346ed5b: mirror createPty's obsidian-preflight block — buildSpawnEnv (since 8d828fa4) merges
// opts.sessionEnv, so LOOM_OBSIDIAN_AUTOSTART now reaches a codex spawn's env, but createCodexPty never set
// the PARTNER path variable createPty's own block sets — leaving the obsidian-preflight skill fragment
// (injected off opts.sessionEnv directly, independent of this env build) instructing the agent to run an
// empty variable. A second, distinct spawn (own sessionId + own FIXTURE_ENV_OUTPUT_FILE override via
// sessionEnv, so it never clobbers the first spawn's already-captured dump above) with autostart turned on.
const SESSION_ID_OBSIDIAN = "codex-spawn-env-test-obsidian";
const envOutputFileObsidian = path.join(tmpHome, "spawned-env-obsidian.json");
const spawnCwdObsidian = fs.mkdtempSync(path.join(tmpHome, "cwd-obsidian-"));
const optsObsidian = {
  ...opts,
  sessionId: SESSION_ID_OBSIDIAN,
  cwd: spawnCwdObsidian,
  sessionEnv: {
    ...opts.sessionEnv,
    LOOM_OBSIDIAN_AUTOSTART: "1",
    FIXTURE_ENV_OUTPUT_FILE: envOutputFileObsidian,
  },
};
const ptyObsidian = host.createCodexPty(optsObsidian);
let spawnedEnvObsidian;
try {
  await waitUntil(() => fs.existsSync(envOutputFileObsidian), { label: "obsidian-variant fixture's env dump file to appear" });
  spawnedEnvObsidian = JSON.parse(fs.readFileSync(envOutputFileObsidian, "utf8"));
} finally {
  try { ptyObsidian.kill(); } catch { /* best-effort */ }
}
check("[9346ed5b] LOOM_OBSIDIAN_AUTOSTART=1 reaches the real codex child env (plain sessionEnv passthrough, unrelated to this card's own fix)", spawnedEnvObsidian.LOOM_OBSIDIAN_AUTOSTART === "1");
check("[9346ed5b fix] LOOM_OBSIDIAN_PREFLIGHT is set to the ensure-obsidian script's absolute path on the real codex child env when autostart is on (mirrors createPty's own block)", spawnedEnvObsidian.LOOM_OBSIDIAN_PREFLIGHT === ENSURE_OBSIDIAN_SCRIPT);

console.log(failures === 0
  ? "\n✅ ALL PASS — createCodexPty's real spawn env now carries opts.sessionEnv (proven on a real OS child process, the field the pre-fix bare process.env copy silently dropped) plus buildSpawnEnv's git-safety/LOOM_WORKTREE/Python-encoding vars and the CLAUDECODE/CLAUDE_CODE_* scrub, and scratchDirEnv's LOOM_SCRATCH_DIR (mkdir'd on disk) — all routed through the SAME shared unit createPty already uses, with a sessionEnv override still winning on the codex path exactly as it does on claude's."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
