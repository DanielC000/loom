import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 5eace211 Code Review item 4 — a real child-spawn proof that `createPty` (the CLAUDE harness, the
// OTHER spawn chokepoint besides `createCodexPty`) sets `LOOM_PROJECT_WORK_DIR`. Mirrors
// pty-codex-spawn-env.mjs's own real-spawn shape exactly (same env-dump-cli.mjs fixture, same
// LOOM_CLAUDE_BIN `.cmd`-wrapper substitution technique `kickoff-real-spawn.mjs` already established for
// this harness), but through the public `host.spawn(opts)` entry point rather than calling the
// `protected createPty` member directly — `spawn()` is the proven, already-working real-spawn seam for
// this harness (see kickoff-real-spawn.mjs), and nothing about env-wiring needs createPty called any more
// directly than that.
//
// SHAPE: a REAL node-pty spawn, a REAL OS child process substituted for `claude` via `LOOM_CLAUDE_BIN`
// (a generated `.cmd` wrapper on Windows). Not a mocked exec (memory `real-spawn-smoke-for-subprocess-
// features`: mocking the exec impl never proves bytes cross a real OS process boundary).
//
// WINDOWS-ONLY (mirrors kickoff-real-spawn.mjs / pty-codex-spawn-env.mjs): the `.cmd`-wrapper mechanism
// is Windows-specific. SKIPS (exit 0, a WARN line) on non-win32 rather than silently passing 0 checks.
//
// Run: 1) build (turbo builds shared first), 2) node test/pty-claude-spawn-env.mjs
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireHermeticEnv, assertUnderOsTmpdir } from "./_guard.mjs"; // arms the Db backstop (LOOM_TEST=1) too
import { mkdtempManaged, finishAndExit, registerForCleanup } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

if (process.platform !== "win32") {
  console.log("WARN  SKIP  pty-claude-spawn-env.mjs — the .cmd-wrapper fixture mechanism this file uses is Windows-only (process.platform !== 'win32' here); see this file's header for the accepted POSIX gap (mirrors kickoff-real-spawn.mjs / pty-codex-spawn-env.mjs).");
  process.exit(0);
}

const FIXTURE_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "env-dump-cli.mjs");
const tmpHome = mkdtempManaged("loom-claude-spawn-env-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Card 5eace211 (Code Review, CRITICAL): clear any AMBIENT LOOM_PROJECT_WORK_ROOT (a human may set this
// to point at the REAL shared project-work-dir root — Decision 2) BEFORE importing dist/paths.js, which
// reads it at module load. Falling through to the default derives PROJECTS_WORK_ROOT as a sibling of
// `tmpHome` above instead, which the cleanup below (and this spawn's own ensureProjectWorkDir mkdir) can
// then safely mutate.
delete process.env.LOOM_PROJECT_WORK_ROOT;
// Card 49d1ee38: a DIFFERENT var, same trap class. Since card 5eace211 EVERY Loom-spawned session
// (including this worker's own shell, if this file is run from one) carries LOOM_PROJECT_WORK_DIR in its
// OWN ambient env — and buildSpawnEnv's base is a plain copy of `process.env`, so that ambient value would
// otherwise silently leak into the no-projectId spawn's child env below, breaking the negative control at
// line ~111 ("LOOM_PROJECT_WORK_DIR is absent... when opts.projectId is not set") for the wrong reason:
// inherited host/session state, not this test's own scenario. Strip it before any spawn so the
// no-projectId case is exercised on a clean baseline; the project-id-carrying spawn above already proves
// the var still reaches the child when it's actually supposed to.
delete process.env.LOOM_PROJECT_WORK_DIR;
requireHermeticEnv(); // confirms LOOM_HOME (and, now, LOOM_PROJECT_WORK_ROOT if still ambient) are isolated
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const wrapperPath = path.join(tmpHome, "fake-claude.cmd");
fs.writeFileSync(wrapperPath, `@"${process.execPath}" "${FIXTURE_PATH}" %*\r\n`);
process.env.LOOM_CLAUDE_BIN = wrapperPath;

const { PtyHost } = await import("../dist/pty/host.js");
const { projectWorkDir, ensureDirs, WORKTREES_DIR, PROJECTS_WORK_ROOT } = await import("../dist/paths.js");
ensureDirs();
registerForCleanup(WORKTREES_DIR);
// Card 5eace211 Code Review item 6: PROJECTS_WORK_ROOT is a SIBLING of LOOM_HOME, not nested inside
// tmpHome — register it too, mirroring WORKTREES_DIR's own registration just above, or this spawn's
// ensureProjectWorkDir mkdir leaks a real directory under the host's real temp root.
// Card 5eace211 (Code Review, CRITICAL): assert this is GENUINELY a temp-derived root before registering
// it for recursive removal — defense in depth on top of the delete+requireHermeticEnv above, in case a
// future edit to this file ever reorders past that pin.
assertUnderOsTmpdir("PROJECTS_WORK_ROOT", PROJECTS_WORK_ROOT);
registerForCleanup(PROJECTS_WORK_ROOT);

const events = { onEngineSessionId() {}, onContextStats() {}, onRateLimited() {}, onBusy() {}, onExit() {} };
const host = new PtyHost(events);

const SESSION_ID = "claude-spawn-env-test";
const PROJECT_ID = "claude-spawn-env-test-project-id";
const spawnCwd = fs.mkdtempSync(path.join(tmpHome, "cwd-"));
const envOutputFile = path.join(tmpHome, "spawned-env.json");
process.env.FIXTURE_ENV_OUTPUT_FILE = envOutputFile;

const opts = {
  sessionId: SESSION_ID, cwd: spawnCwd, role: "worker", projectId: PROJECT_ID,
  permission: { mode: "acceptEdits", allow: [], deny: [], startupModeCycles: 0 },
  geometry: { cols: 120, rows: 40 }, sessionEnv: {},
};

host.spawn(opts);

let spawnedEnv;
try {
  await waitUntil(() => fs.existsSync(envOutputFile), { label: "fixture's env dump file to appear (claude harness)" });
  spawnedEnv = JSON.parse(fs.readFileSync(envOutputFile, "utf8"));
} finally {
  try { host.stop(SESSION_ID, "hard"); } catch { /* best-effort */ }
}

const expectedWorkDir = projectWorkDir(PROJECT_ID);
check("[5eace211] LOOM_PROJECT_WORK_DIR reaches the real CLAUDE harness child env, matching projectWorkDir(projectId)", spawnedEnv?.LOOM_PROJECT_WORK_DIR === expectedWorkDir);
check("[5eace211] the project work dir was actually created on disk (ensureProjectWorkDir's mkdir)", fs.existsSync(expectedWorkDir) && fs.statSync(expectedWorkDir).isDirectory());

// --- negative control (mirrors pty-codex-spawn-env.mjs's own): a SECOND spawn with NO projectId at all
// must NOT carry the var — proves the block is additive-when-absent, not unconditional. ---
const SESSION_ID_NOPROJ = "claude-spawn-env-test-noproj";
const spawnCwdNoproj = fs.mkdtempSync(path.join(tmpHome, "cwd-noproj-"));
const envOutputFileNoproj = path.join(tmpHome, "spawned-env-noproj.json");
process.env.FIXTURE_ENV_OUTPUT_FILE = envOutputFileNoproj;
const optsNoproj = { ...opts, sessionId: SESSION_ID_NOPROJ, cwd: spawnCwdNoproj, projectId: undefined };
host.spawn(optsNoproj);
let spawnedEnvNoproj;
try {
  await waitUntil(() => fs.existsSync(envOutputFileNoproj), { label: "fixture's env dump file to appear (no-projectId variant)" });
  spawnedEnvNoproj = JSON.parse(fs.readFileSync(envOutputFileNoproj, "utf8"));
} finally {
  try { host.stop(SESSION_ID_NOPROJ, "hard"); } catch { /* best-effort */ }
}
check("[5eace211, negative control] LOOM_PROJECT_WORK_DIR is absent from the real claude child env when opts.projectId is not set", !("LOOM_PROJECT_WORK_DIR" in (spawnedEnvNoproj ?? {})));

console.log(failures === 0
  ? "\n✅ ALL PASS — createPty (the claude harness, the OTHER spawn chokepoint) carries LOOM_PROJECT_WORK_DIR on a REAL spawned OS child process, matching projectWorkDir(projectId), with its mkdir actually landing on disk — and is additive-when-absent (a spawn with no projectId never carries the var), mirroring createCodexPty's own proof in pty-codex-spawn-env.mjs."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
