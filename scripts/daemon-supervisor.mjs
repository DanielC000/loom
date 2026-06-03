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
import path from "node:path";

const RESTART_EXIT_CODE = 75; // must match packages/daemon/src/orchestration/restart.ts
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..");
const daemonDir = path.join(repoRoot, "packages", "daemon");

/** Run a shell command to completion, inheriting stdio. Returns its exit code (null → 1). */
function sh(command, cwd, extraEnv) {
  const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
  return spawnSync(command, { cwd, stdio: "inherit", shell: true, env }).status ?? 1;
}

for (;;) {
  // Build shared + daemon (turbo ^build handles the shared dependency). FULL TURBO no-ops when nothing
  // changed, so the tool-triggered restart (which already built) relaunches fast.
  const buildCode = sh("pnpm exec turbo build --filter=@loom/daemon", repoRoot);
  if (buildCode !== 0) {
    console.error(`[supervisor] daemon build failed (exit ${buildCode}) — NOT starting a broken daemon.`);
    process.exit(buildCode);
  }
  // LOOM_SUPERVISED tells the daemon a supervisor is present, so `daemon_restart` is allowed (without
  // it the manager would kill the daemon with nothing to bring it back).
  const runCode = sh("node dist/index.js", daemonDir, { LOOM_SUPERVISED: "1" });
  if (runCode === RESTART_EXIT_CODE) {
    console.log("[supervisor] daemon requested restart — rebuilding and relaunching…");
    continue;
  }
  process.exit(runCode);
}
