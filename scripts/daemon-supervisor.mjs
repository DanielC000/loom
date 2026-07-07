#!/usr/bin/env node
// Watch-free, restart-capable daemon runner for SELF-HOSTING (orchestrating Loom WITH Loom).
//
// Why this exists: the dev daemon runs under `tsx watch`, so any worker merge that touches
// packages/daemon/src/** restarts it and kills the live manager + worker ptys mid-flight (the
// 2026-06-03 overnight cascade). This supervisor runs the BUILT daemon with no file watcher, so
// source merges don't bounce it — AND it relaunches the daemon when a manager deliberately calls
// `daemon_restart` to pick up merged daemon code (the daemon exits with RESTART_EXIT_CODE; on the
// way back up it auto-resumes the manager + its workers).
//
// Restart policy: relaunch ONLY on the explicit restart sentinel. ANY other exit (including a crash)
// STOPS the loop, so a broken daemon stays visibly down instead of crash-looping — that crash-loop
// is exactly what burned us on 2026-06-03 (ELIFECYCLE 255, repeated).
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRotatingLog } from "./lib/rotating-log.mjs";

const RESTART_EXIT_CODE = 75; // must match packages/daemon/src/orchestration/restart.ts
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const daemonDir = path.join(repoRoot, "packages", "daemon");

// Mirrors packages/daemon/src/crashlog.ts CRASHLOG_PATH (LOOM_HOME/crash.log). The daemon's fatal-exit
// handler writes the crashlog here; a freshly launched daemon would overwrite it on its next crash. So
// before each launch, rotate any existing crash.log to crash.log.prev — keeping the last two — so a
// restart (or a human re-run after a crash) never clobbers the previous crash signature. Best-effort.
const LOOM_HOME = process.env.LOOM_HOME || path.join(os.homedir(), ".loom");
const CRASHLOG = path.join(LOOM_HOME, "crash.log");
function rotateCrashlog() {
  try {
    if (!fs.existsSync(CRASHLOG)) return;
    const prev = `${CRASHLOG}.prev`;
    fs.rmSync(prev, { force: true }); // Windows renameSync fails if the destination exists — clear it first
    fs.renameSync(CRASHLOG, prev);
  } catch (err) {
    console.error(`[supervisor] crashlog rotate failed (continuing): ${err.message}`);
  }
}

/** Run a shell command to completion, inheriting stdio. Returns its exit code (null → 1). */
function sh(command, cwd, extraEnv) {
  const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
  return spawnSync(command, { cwd, stdio: "inherit", shell: true, env }).status ?? 1;
}

// ---- Daemon-death diagnostics (card 4c0dc6e6) ----
//
// A real daemon crash once left NO trace: the daemon runs stdio:"inherit" under this supervisor
// (terminal-only, nothing persisted), and packages/daemon/src/crashlog.ts's uncaughtException /
// unhandledRejection / exit handlers only fire for a JS-level death — they never ran, so it wasn't a
// JS crash, but nothing else recorded what happened either. These two additions widen the net
// WITHOUT changing the restart control flow above:
//
//   1. Tee the daemon's stdout/stderr to a size-bounded rotating file, so the last output before a
//      death survives even a death with no signature of its own (crashlog.ts complements this for
//      the JS-crash case; this covers everything, including a silent native/external death).
//   2. Run the daemon with Node's built-in diagnostic report (--report-on-fatalerror
//      --report-uncaught-exception), so a NATIVE fatal error (OOM, an abort inside a native addon
//      like node-pty/better-sqlite3) that crashlog.ts's JS-only handlers can't observe still drops a
//      report.*.json with a stack/heap/handle snapshot.
//
// Deliberately NOT attempted here: detaching the daemon from a closable console/RDP session (so a
// closed terminal can't take the daemon down with it). That needs a real design decision — full
// detachment on Windows means giving up stdio:"inherit" entirely (a detached child can't share the
// parent console), trading today's "watch it live in the terminal" workflow for a headless,
// log-file-only one — which is more than a diagnostics-only change should decide unilaterally. Left
// as a follow-up; see the worker report for a sketch.
const OUTPUT_LOG = createRotatingLog({
  basePath: path.join(LOOM_HOME, "logs", "daemon-output.log"),
  maxBytes: 5 * 1024 * 1024, // 5MB per file
  maxFiles: 3, // live file + 2 rotated slots — bounded at ~15MB total, never grows unbounded
});
const REPORTS_DIR = path.join(LOOM_HOME, "reports");

/**
 * Launch the daemon, teeing its stdout/stderr to BOTH the console (as before) and OUTPUT_LOG, with
 * Node's diagnostic-report flags passed as CLI args (NOT via NODE_OPTIONS — NODE_OPTIONS runs its
 * OWN mini-parser that treats `\` as an escape character, so a Windows REPORTS_DIR like
 * `C:\Users\name\.loom\reports` gets silently mangled to `C:UsersnameloomReports`; verified against a
 * real Windows node — CLI args use ordinary argv parsing and have no such escaping). Resolves the
 * daemon's exit code; a signal-kill resolves as 1, matching the previous spawnSync `.status ?? 1`
 * behavior.
 */
function runDaemon(cwd, extraEnv) {
  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
  const cmd = `node --report-on-fatalerror --report-uncaught-exception --report-directory="${REPORTS_DIR}" dist/index.js`;
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd, shell: true, env, stdio: ["inherit", "pipe", "pipe"] });
    const tee = (out) => (chunk) => { out.write(chunk); OUTPUT_LOG.append(chunk); };
    child.stdout.on("data", tee(process.stdout));
    child.stderr.on("data", tee(process.stderr));
    child.on("error", (err) => {
      console.error(`[supervisor] failed to start daemon: ${err.message}`);
      resolve(1);
    });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

for (;;) {
  // Build in two steps so a failure has the right blast radius. FULL TURBO no-ops when nothing
  // changed, so the tool-triggered restart (which already built) relaunches fast.
  //
  // 1) shared + daemon (turbo ^build handles the shared dependency) — FATAL on failure: never start
  //    a broken daemon.
  const buildCode = sh("pnpm exec turbo build --filter=@loom/daemon", repoRoot);
  if (buildCode !== 0) {
    console.error(`[supervisor] daemon build failed (exit ${buildCode}) — NOT starting a broken daemon.`);
    process.exit(buildCode);
  }
  // 2) web — the daemon serves the UI statically from packages/web/dist, so a fresh boot rebuilds it
  //    to avoid serving a stale bundle. But a web build failure is NON-FATAL: the gateway boots fine on
  //    a missing/stale dist (server.ts logs + skips static), so a BAD web build must not block the WHOLE
  //    daemon boot (all-project orchestration). Log loudly and boot on the previous dist. Turbo/vite
  //    does not wipe dist on a failed build, so the prior good bundle survives.
  const webBuildCode = sh("pnpm exec turbo build --filter=@loom/web", repoRoot);
  if (webBuildCode !== 0) {
    console.error("[supervisor] WARNING: web build failed — booting with the previous packages/web/dist (UI may be stale)");
  }
  // Preserve any prior crashlog before the daemon (re)launches and possibly overwrites it.
  rotateCrashlog();
  // LOOM_SUPERVISED tells the daemon a supervisor is present, so `daemon_restart` is allowed (without
  // it the manager would kill the daemon with nothing to bring it back).
  // LOOM_DEV defaults ON here: `daemon:stable` is the SELF-HOSTING / dogfooding entry point (regular
  // loomctl users run the packaged bin/loom.mjs, never this), so the dev-only Platform layer should seed.
  // Defaulted (not hardcoded) so an explicit `LOOM_DEV=0 pnpm daemon:stable` can still test the non-dev path.
  // UV_THREADPOOL_SIZE (task dea6728e, defense-in-depth): the default libuv pool is only 4 threads, so a
  // small handful of wedged fs ops could still starve fs/dns/crypto process-wide even with removeWorktree's
  // killable removal (which no longer uses the threadpool at all, but other daemon code still does).
  // Widened here since this spawns a FRESH node process — set BEFORE the daemon starts, which is the only
  // point a bump actually takes effect (libuv reads it once, lazily, on first threadpool use). Never
  // overrides an operator's own explicit setting.
  const runCode = await runDaemon(daemonDir, {
    LOOM_SUPERVISED: "1", LOOM_DEV: process.env.LOOM_DEV ?? "1", UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE ?? "16",
  });
  if (runCode === RESTART_EXIT_CODE) {
    console.log("[supervisor] daemon requested restart — rebuilding and relaunching…");
    continue;
  }
  process.exit(runCode);
}
