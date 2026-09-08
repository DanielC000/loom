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
  console.log("SKIP  pty-codex-spawn-env.mjs — the .cmd-wrapper fixture mechanism this file uses is Windows-only (process.platform !== 'win32' here); see this file's header for the accepted POSIX gap (mirrors kickoff-real-spawn.mjs).");
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

const { PtyHost } = await import("../dist/pty/host.js");
const { sessionScratchDir } = await import("../dist/paths.js");

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

console.log(failures === 0
  ? "\n✅ ALL PASS — createCodexPty's real spawn env now carries opts.sessionEnv (proven on a real OS child process, the field the pre-fix bare process.env copy silently dropped) plus buildSpawnEnv's git-safety/LOOM_WORKTREE/Python-encoding vars and the CLAUDECODE/CLAUDE_CODE_* scrub, and scratchDirEnv's LOOM_SCRATCH_DIR (mkdir'd on disk) — all routed through the SAME shared unit createPty already uses, with a sessionEnv override still winning on the codex path exactly as it does on claude's."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
