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
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  const runCode = sh("node dist/index.js", daemonDir, {
    LOOM_SUPERVISED: "1", LOOM_DEV: process.env.LOOM_DEV ?? "1", UV_THREADPOOL_SIZE: process.env.UV_THREADPOOL_SIZE ?? "16",
  });
  if (runCode === RESTART_EXIT_CODE) {
    console.log("[supervisor] daemon requested restart — rebuilding and relaunching…");
    continue;
  }
  process.exit(runCode);
}
