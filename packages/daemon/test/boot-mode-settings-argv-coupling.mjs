import "./_guard.mjs"; // prod-guard (sets LOOM_TEST=1)
// Code Reviewer's decisive finding on task 51926260 (card `795910c7`, extended `81f1be62`): the coupling
// commit 795910c7 introduced between the WRITTEN settings.json `permissions.defaultMode` and the REAL
// `--permission-mode` argv value (host.ts createPty, both now derived from `computeBootMode`) had NO
// test that could observe a divergence. `boot-mode-direct.mjs` only exercises `computeBootMode` in
// isolation (never checks anything actually WRITTEN or SPAWNED); `settings-auto-mode-prompt.mjs` calls
// `writeSessionSettings` directly with a literal `mode` that was already resolved, so it can't see this
// either; `spawn-command-line-preflight.mjs`'s real-createPty case uses `startupModeCycles: 0`, exactly
// the shape where `bootMode === permission.mode` by construction — structurally incapable of observing a
// divergence. Decisive falsification (verbatim from review): revert host.ts's `buildSpawnArgs({ ...,
// mode: bootMode })` back to `mode: permission.mode` (dropping ONLY that one coupling, not
// `computeBootMode` itself) and the WHOLE SUITE stays green.
//
// THIS FILE closes that gap: drives the REAL (unsubclassed) `PtyHost.createPty()` — a real node.exe
// substituted for `claude` via `LOOM_CLAUDE_BIN` (the same technique `spawn-command-line-preflight.mjs`
// and `kickoff-real-spawn.mjs` already established) — for the realistic platform/worker default
// (`startupModeCycles: 2`, target `auto`, directly expressible), then asserts the WRITTEN settings file's
// `permissions.defaultMode` equals the value immediately following `--permission-mode` in the REAL argv
// this spawn handed node-pty (captured from `createPty`'s own unconditional `[pty] spawn ... args=`
// console.log line — the same real code path a production spawn logs from, not a test-only hook).
//
// RUN: pnpm build (repo root) then `node test/boot-mode-settings-argv-coupling.mjs` from packages/daemon.
// WINDOWS-ONLY (mirrors spawn-command-line-preflight.mjs's own real-createPty section): a real node.exe
// substituted for claude via LOOM_CLAUDE_BIN was only established/verified on Windows in this repo.
import fs from "node:fs";
import path from "node:path";
import { mkdtempManaged, registerForCleanup, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

if (process.platform !== "win32") {
  console.log("SKIP  boot-mode-settings-argv-coupling.mjs — the LOOM_CLAUDE_BIN real-node.exe-substitution technique this file uses was only established/verified on Windows (process.platform !== 'win32' here); see spawn-command-line-preflight.mjs's own header for the same gap.");
  process.exit(0);
}

const tmpHome = mkdtempManaged("loom-bmsac-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
// Substitute a real, trivial, always-present executable for `claude` (mirrors spawn-command-line-
// preflight.mjs): resolveExecutable passes an absolute path through unchanged, so this makes createPty's
// real spawn launch a real (harmless) node.exe process instead of a real `claude`.
process.env.LOOM_CLAUDE_BIN = process.execPath;

const { PtyHost } = await import("../dist/pty/host.js");
const { ensureDirs, WORKTREES_DIR, SETTINGS_DIR } = await import("../dist/paths.js");
ensureDirs();
registerForCleanup(WORKTREES_DIR); // sibling of LOOM_HOME, created by production ensureDirs()

const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new PtyHost(events);

/** Capture createPty's own unconditional `[pty] spawn <id> ... args=[...]` line for `sessionId`. */
function spawnAndCaptureArgv(sessionId, permission) {
  const lines = [];
  const realLog = console.log;
  console.log = (...args) => { lines.push(args.join(" ")); realLog(...args); };
  try {
    host.spawn({
      sessionId, cwd: tmpHome,
      permission: { allow: [], deny: [], ...permission },
      geometry: { cols: 120, rows: 40 }, sessionEnv: {},
    });
  } finally {
    console.log = realLog;
  }
  const line = lines.find((l) => l.startsWith(`[pty] spawn ${sessionId} `));
  if (!line) throw new Error(`never saw the '[pty] spawn ${sessionId} ...' log line — createPty's own logging changed shape?`);
  const m = line.match(/ args=(\[.*\])$/);
  if (!m) throw new Error(`couldn't find the trailing args=[...] JSON in: ${line}`);
  return JSON.parse(m[1]);
}

function readWrittenDefaultMode(sessionId) {
  const file = path.join(SETTINGS_DIR, `${sessionId}.json`);
  const json = JSON.parse(fs.readFileSync(file, "utf8"));
  return json.permissions?.defaultMode;
}

let sessionId;
try {
  // The realistic platform/worker default: mode:acceptEdits, startupModeCycles:2 — target is `auto`,
  // directly expressible, so computeBootMode should boot DIRECTLY there (this is the exact shape the
  // real spurious-reminder bug (task 51926260) reproduced against).
  sessionId = "coupling-1";
  const args = spawnAndCaptureArgv(sessionId, { mode: "acceptEdits", startupModeCycles: 2 });
  const flagIdx = args.indexOf("--permission-mode");
  check("the real argv actually carries --permission-mode (sanity — the whole test is moot otherwise)", flagIdx !== -1 && flagIdx + 1 < args.length);
  const argvMode = args[flagIdx + 1];
  check("computeBootMode resolved the realistic worker/platform default DIRECTLY to auto (no plan transit)", argvMode === "auto");

  const writtenMode = readWrittenDefaultMode(sessionId);
  check("settings.json permissions.defaultMode was actually written", writtenMode !== undefined);
  check("THE COUPLING: settings.json permissions.defaultMode === the REAL --permission-mode argv value " +
    "(a divergence here means the CLI would boot at one mode while settings.json's defaultMode claims " +
    "another — the exact class of bug this file exists to catch)",
    writtenMode === argvMode);

  check("host actually spawned a real process for this session (the check above exercised the REAL createPty, not a stub)",
    host.isAlive(sessionId));
} finally {
  if (sessionId) { try { host.stop(sessionId, "hard"); } catch { /* best-effort cleanup */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — for the realistic platform/worker default config, the REAL --permission-mode argv value and the WRITTEN settings.json permissions.defaultMode agree (both resolved from computeBootMode) — the two boot-mode mechanisms cannot silently diverge. Reverting host.ts's `mode: bootMode` back to `mode: permission.mode` (dropping only that one coupling) turns 'THE COUPLING' check above RED — see this task's worker_report for that proof; not re-run here since it requires editing production source mid-test."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
