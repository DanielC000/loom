import path from "node:path";
import fs from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { LOOM_HOME } from "../paths.js";
import { writeJsonAtomic } from "../pty/claude-config.js";

/**
 * Self-host daemon restart support (the `daemon_restart` manager tool). Orchestrating Loom WITH Loom,
 * a manager that merges daemon-`src` worker branches can't see that code run until the daemon is
 * rebuilt + restarted — but restarting kills its own pty. This module is the coordination layer:
 *   - the daemon exits with RESTART_EXIT_CODE; the supervisor (scripts/daemon-supervisor.mjs)
 *     rebuilds and relaunches ONLY on that code;
 *   - a restart-intent file persists who to re-resume across the gap so boot can bring the manager
 *     (and its live workers) back and tell it the merged code is now live.
 * Only valid under the supervisor (LOOM_SUPERVISED=1) — otherwise nothing relaunches the daemon.
 */

/** Exit code that asks the supervisor to rebuild + relaunch. MUST match scripts/daemon-supervisor.mjs. */
export const RESTART_EXIT_CODE = 75;

const INTENT_PATH = path.join(LOOM_HOME, "restart-intent.json");

export interface RestartIntent {
  reason: string;
  managerSessionId: string;
  /** The manager's workers that were live at restart time — resumed best-effort on boot. */
  workerSessionIds: string[];
  requestedAt: string;
}

/** True only when running under the restart supervisor — i.e. `daemon_restart` can safely relaunch. */
export function isSupervised(): boolean {
  return process.env.LOOM_SUPERVISED === "1";
}

export function writeRestartIntent(intent: RestartIntent): void {
  writeJsonAtomic(INTENT_PATH, intent);
}

/** Read the pending restart intent (consume with clearRestartIntent after acting on it). */
export function readRestartIntent(): RestartIntent | null {
  try {
    return JSON.parse(fs.readFileSync(INTENT_PATH, "utf8")) as RestartIntent;
  } catch {
    return null; // absent or unreadable → no pending restart
  }
}

export function clearRestartIntent(): void {
  try {
    fs.rmSync(INTENT_PATH, { force: true });
  } catch {
    /* best-effort */
  }
}

/** Repo root, derived from this module's built location (dist/orchestration/restart.js → ../../../..). */
function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
}

/**
 * Rebuild the daemon (shared + daemon via turbo) WHILE the current daemon is still running its
 * in-memory code, so a broken build aborts the restart and leaves the manager alive to fix it —
 * rather than exiting into a daemon that won't come back up. Resolves the exit code + a tail of
 * output for the failure message. Never throws (a spawn error resolves as a non-zero code).
 */
export function buildDaemon(): Promise<{ code: number; tail: string }> {
  return new Promise((resolve) => {
    let out = "";
    const child = spawn("pnpm exec turbo build --filter=@loom/daemon", {
      cwd: repoRoot(),
      shell: true,
    });
    const cap = (b: Buffer) => { out += b.toString(); if (out.length > 4000) out = out.slice(-4000); };
    child.stdout?.on("data", cap);
    child.stderr?.on("data", cap);
    child.on("error", (e) => resolve({ code: 1, tail: `${out}\n${e.message}`.trim() }));
    child.on("close", (code) => resolve({ code: code ?? 1, tail: out.trim().slice(-1500) }));
  });
}
