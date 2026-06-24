#!/usr/bin/env node
// Loom vault preflight — self-heal Obsidian for the `obsidian` CLI the vault skills use.
//
// WHY: the `obsidian` CLI (version/read/search/daily:read) needs the Obsidian DESKTOP PROCESS running —
// NOT the Local REST API (port 27124 can be down yet the CLI works once the process is up). When Obsidian
// is down the CLI dead-ends with "unable to find Obsidian. Please make sure Obsidian is running." A vault
// skill runs this preflight FIRST: if auto-start is enabled and Obsidian is down, it launches the OS app
// and polls `obsidian version` until ready, bounded — otherwise it falls back to direct filesystem access.
//
// DEFAULT-SAFE (Loom ships to public npm): this NEVER throws and ALWAYS exits 0. Disabled, headless/CI,
// not-installed, or launch-timeout all resolve to a non-`ready` status the caller treats as "use the FS".
// It is a no-op unless LOOM_OBSIDIAN_AUTOSTART=1 (set by resolveConfig only when obsidian.autoStart is on).
//
// INVOCATION (from a vault skill, before any `obsidian` command):  node "$LOOM_OBSIDIAN_PREFLIGHT"
// Reads env: LOOM_OBSIDIAN_AUTOSTART ("1" to enable), LOOM_OBSIDIAN_PATH (executable/.app override).
//
// The pure helpers + the seam-injectable `ensureObsidian` orchestrator are EXPORTED so the hermetic test
// asserts gating / probe / fallback / launch-command construction WITHOUT launching the real GUI app.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { pathToFileURL } from "node:url";

/** Parse the preflight config out of the session env (LOOM_OBSIDIAN_* vars resolveConfig injects). */
export function readConfigFromEnv(env = process.env) {
  const rawPath = env.LOOM_OBSIDIAN_PATH;
  return {
    autoStart: env.LOOM_OBSIDIAN_AUTOSTART === "1",
    path: rawPath && rawPath.trim() ? rawPath : undefined,
  };
}

/**
 * Headless / CI detection: launching a GUI app is pointless (or blocked) on a server. Treat as headless
 * when forced, under CI, or on a Linux box with no display server. macOS/Windows always have a desktop
 * session for an interactive user, so they're only headless when forced (covers locked-down CI runners).
 */
export function isHeadless(env = process.env, platform = process.platform) {
  if (env.LOOM_OBSIDIAN_FORCE_HEADLESS === "1") return true;
  if (env.CI && env.CI !== "false" && env.CI !== "0") return true;
  if (platform === "linux" && !env.DISPLAY && !env.WAYLAND_DISPLAY) return true;
  return false;
}

/** OS-aware default Obsidian launch target (used when no LOOM_OBSIDIAN_PATH override is set). */
export function defaultObsidianPath(platform = process.platform, env = process.env) {
  switch (platform) {
    case "win32": {
      // Per-machine install lives under Program Files (NOT %LOCALAPPDATA%) — confirmed live by the Lead.
      const pf = env.ProgramFiles || "C:\\Program Files";
      return `${pf}\\Obsidian\\Obsidian.exe`;
    }
    case "darwin":
      return "/Applications/Obsidian.app";
    default:
      // Linux: rely on an `obsidian` launcher on PATH (distro package / AppImage symlink).
      return "obsidian";
  }
}

/**
 * Build the OS-correct launch command for Obsidian. macOS opens the `.app` bundle via `open` (which also
 * accepts a plain path); Windows/Linux exec the binary directly, detached so it outlives this preflight.
 */
export function buildLaunchCommand({ platform = process.platform, path: exePath, env = process.env } = {}) {
  const target = exePath || defaultObsidianPath(platform, env);
  switch (platform) {
    case "darwin":
      // `open <bundle-or-path>` launches the app and returns immediately (it does not block on the GUI).
      return { command: "open", args: [target], detached: true };
    default:
      // win32 + linux: spawn the executable directly, detached + unref'd by the real launcher below.
      return { command: target, args: [], detached: true };
  }
}

/** Real readiness probe: `obsidian version` → exit 0 means the CLI can reach a running Obsidian. */
export function probeObsidianReady(spawnSyncImpl = spawnSync) {
  try {
    const r = spawnSyncImpl("obsidian", ["version"], { stdio: "ignore", timeout: 4000 });
    if (r.error) return false; // ENOENT (CLI not installed) or the probe itself timed out
    return r.status === 0;
  } catch {
    return false;
  }
}

/**
 * Orchestrate the preflight with INJECTABLE seams (probe / launch / sleep / clock / existsSync) so the
 * hermetic test drives every branch deterministically. ALWAYS resolves (never throws). Returns
 * `{ status, launched, command? }` where status is one of:
 *   ready        — Obsidian is up and the CLI works (no launch needed, or launch succeeded then polled ready)
 *   disabled     — autoStart off (the default): caller uses the filesystem, no launch attempted
 *   headless     — CI / no display: a GUI launch is pointless, fall back to the filesystem
 *   not-installed— the launch target is absent or the launch failed: fall back to the filesystem
 *   timeout      — launched, but the CLI never became ready within the bounded poll: fall back
 * Any status other than `ready` means "the obsidian CLI is unusable — read/write the vault directly".
 */
export async function ensureObsidian({
  env = process.env,
  platform = process.platform,
  probe,
  launch,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  existsSync = fs.existsSync,
  now = () => Date.now(),
  timeoutMs = 15000,
  pollMs = 500,
} = {}) {
  const cfg = readConfigFromEnv(env);

  // Gating: disabled → never launch. The caller falls back to the filesystem.
  if (!cfg.autoStart) return { status: "disabled", launched: false };

  // Already up → nothing to heal.
  if (await probe()) return { status: "ready", launched: false };

  // Down, but a GUI launch is pointless on a headless/CI box → fall back to the filesystem.
  if (isHeadless(env, platform)) return { status: "headless", launched: false };

  const command = buildLaunchCommand({ platform, path: cfg.path, env });

  // An ABSOLUTE target that doesn't exist = not installed at that location → fall back (don't try to
  // launch a missing binary). A bare command (e.g. "obsidian" on PATH) is left to the launch attempt.
  const looksPathLike = /[\\/]/.test(command.command);
  if (looksPathLike && !existsSync(command.command)) {
    return { status: "not-installed", launched: false, command };
  }

  try {
    launch(command);
  } catch {
    // Launch failed (ENOENT / perms) → NEVER throw; fall back to the filesystem.
    return { status: "not-installed", launched: false, command };
  }

  // Poll `obsidian version` until ready, bounded by timeoutMs.
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await sleep(pollMs);
    if (await probe()) return { status: "ready", launched: true, command };
  }
  return { status: "timeout", launched: true, command };
}

/** Wire the REAL seams (spawnSync probe + detached spawn launch) and run the preflight. */
async function main() {
  const result = await ensureObsidian({
    probe: () => probeObsidianReady(),
    launch: (cmd) => {
      const child = spawn(cmd.command, cmd.args, { detached: true, stdio: "ignore" });
      child.unref(); // let Obsidian outlive this short-lived preflight process
    },
  });
  // One status line for the calling skill; ALWAYS exit 0 so the preflight can never break the caller.
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

// Run only when invoked directly (not when imported by the hermetic test).
const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) main().catch(() => {}).finally(() => process.exit(0));
