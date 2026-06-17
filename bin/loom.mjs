#!/usr/bin/env node
// The public `loom` CLI — a small MANAGEMENT CLI over the single-process daemon (which serves the
// prebuilt web viewport from its own loopback origin — Releases v1 Part 1).
//
//   loom                  start the daemon in the FOREGROUND + open the browser (backward-compatible:
//                         byte-identical to the original bare `loom`; same as `loom start`)
//   loom start [-d]       start the daemon. --detach/-d backgrounds it + writes a PID file
//   loom stop             gracefully stop a running (detached) daemon + clean the PID file
//   loom status           report running/stopped + version + URL + PID (exit non-zero if not running)
//   loom restart          stop, then start (honors --detach/--port/--no-open)
//   loom open             open the browser to a running daemon
//   loom update [--channel stable|beta]
//                         upgrade in place (npm i -g loomctl@<dist-tag>) + restart the daemon
//
// This file is shipped at <pkg>/bin/loom.mjs and the daemon at <pkg>/dist/index.js — the assembled npm
// package layout (see scripts/build-npm-package.mjs). It is NOT meant to run from the monorepo source
// tree (there is no <repo-root>/dist); use `pnpm daemon` for dev.
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { CHANNELS, isValidChannel, installSpecFor, readChannel, writeChannel } from "./update-config.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, ".."); // the installed `loom` package root (holds the umbrella package.json)
const DEFAULT_PORT = 4317;
const SUBCOMMANDS = new Set(["start", "stop", "status", "restart", "open", "service", "update"]);
const SERVICE_ACTIONS = new Set(["install", "uninstall", "status"]);

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function printHelp() {
  console.log(`loom v${readVersion()} — local-first AI project workspace

Usage: loom [command] [options]

With NO command, loom starts the daemon in the foreground and opens your browser
(loopback only) — the same as \`loom start\`.

Commands:
  start            Start the daemon (foreground by default). --detach to background it.
  stop             Stop a running daemon (gracefully) and clean its PID file.
  status           Show whether the daemon is running, plus version, URL and PID.
  restart          Stop, then start (honors --detach/--port/--no-open).
  open             Open your browser to a running daemon.
  service <action> Register Loom to autostart in the background on login.
                   Actions: install | uninstall | status. Uses the OS service
                   manager (systemd --user / launchd / Task Scheduler).
  update           Upgrade Loom in place (npm i -g loomctl@<dist-tag>) and
                   restart the running daemon. --channel switches + remembers
                   the release channel (stable → npm 'latest', beta → 'beta';
                   default stable). End users run no supervisor, so the update
                   is a stop → reinstall → start cycle.

Options:
  -p, --port <n>   Port to listen on (default ${DEFAULT_PORT}; or env LOOM_PORT)
  -d, --detach     (start/restart) Run the daemon in the background and return
      --no-open    Do not open the browser automatically
      --channel <c> (update) Release channel: stable | beta. Switches and
                   persists the channel; a bare 'loom update' reuses the last.
  -v, --version    Print the loom version and exit
  -h, --help       Show this help and exit

State (PID file + update-config.json) lives under LOOM_HOME (default ~/.loom).
`);
}

// --- arg parsing (pure + exported, so it can be unit-tested without running the CLI) ---------------
// Returns { command, port, open, detach, channel, help, version, error, exitCode }. command is null for
// the backward-compatible bare invocation. port is undefined when not supplied (resolved at use-site);
// channel is null when --channel was not supplied (the `update` handler then reuses the persisted one).
export function parseArgs(argv) {
  const out = { command: null, serviceAction: null, port: undefined, open: true, detach: false, channel: null, help: false, version: false, error: null, exitCode: 0 };
  let i = 0;
  // A leading non-flag token is the subcommand; an unknown one is an error (mirrors the old unknown-arg
  // behavior). A leading flag (e.g. `loom --version`) keeps command = null (bare).
  if (argv.length && !argv[0].startsWith("-")) {
    if (SUBCOMMANDS.has(argv[0])) {
      out.command = argv[0]; i = 1;
      // `service` takes a sub-action (install | uninstall | status) as its next non-flag token.
      if (out.command === "service") {
        if (argv[i] && !argv[i].startsWith("-")) {
          if (SERVICE_ACTIONS.has(argv[i])) { out.serviceAction = argv[i]; i++; }
          else { out.error = `unknown service action '${argv[i]}' (expected install | uninstall | status)`; out.exitCode = 2; return out; }
        } else { out.error = "service requires an action (install | uninstall | status)"; out.exitCode = 2; return out; }
      }
    }
    else { out.error = `unknown command '${argv[0]}' (try 'loom --help')`; out.exitCode = 2; return out; }
  }
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--version" || a === "-v") out.version = true;
    else if (a === "--no-open") out.open = false;
    else if (a === "--detach" || a === "-d") out.detach = true;
    else if (a === "--port" || a === "-p") out.port = Number(argv[++i]);
    else if (a.startsWith("--port=")) out.port = Number(a.slice("--port=".length));
    else if (a === "--channel") out.channel = argv[++i];
    else if (a.startsWith("--channel=")) out.channel = a.slice("--channel=".length);
    else { out.error = `unknown argument '${a}' (try 'loom --help')`; out.exitCode = 2; return out; }
  }
  if (out.port !== undefined && !isValidPort(out.port)) {
    out.error = `invalid port '${out.port}' (expected 1-65535)`; out.exitCode = 2; return out;
  }
  // A supplied --channel must be a known channel (a bare 'loom update' leaves it null → use persisted).
  if (out.channel !== null && !isValidChannel(out.channel)) {
    out.error = `invalid channel '${out.channel ?? ""}' (expected ${CHANNELS.join(" | ")})`; out.exitCode = 2; return out;
  }
  return out;
}

function isValidPort(p) { return Number.isInteger(p) && p >= 1 && p <= 65535; }

// Effective port: an explicit --port wins, else env LOOM_PORT, else the default. Validated (mirrors the
// original bare behavior, which also errored on a bad env LOOM_PORT).
function resolvePort(explicit) {
  if (explicit !== undefined) return explicit; // already validated in parseArgs
  const p = process.env.LOOM_PORT ? Number(process.env.LOOM_PORT) : DEFAULT_PORT;
  if (!isValidPort(p)) { console.error(`loom: invalid port '${p}' (expected 1-65535)`); process.exit(2); }
  return p;
}

// --- PID file (under LOOM_HOME / ~/.loom) -----------------------------------------------------------
function loomHome() { return process.env.LOOM_HOME || path.join(os.homedir(), ".loom"); }
function pidFilePath() { return path.join(loomHome(), "daemon.pid"); }

function readPidFile() {
  try {
    const rec = JSON.parse(fs.readFileSync(pidFilePath(), "utf8"));
    if (rec && Number.isInteger(rec.pid)) return rec;
  } catch { /* missing or malformed → treated as not-running */ }
  return null;
}
function writePidFile(rec) {
  fs.mkdirSync(loomHome(), { recursive: true });
  fs.writeFileSync(pidFilePath(), JSON.stringify(rec, null, 2) + "\n");
}
function removePidFile() { try { fs.unlinkSync(pidFilePath()); } catch { /* already gone */ } }

// Is a process with this pid still alive? signal 0 probes without delivering. ESRCH = gone; EPERM =
// exists-but-not-ours (still alive).
function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === "EPERM"; }
}

// --- HTTP probes ------------------------------------------------------------------------------------
const urlFor = (port) => `http://127.0.0.1:${port}`;

// Poll GET /api/version until the gateway answers 200 (or the timeout elapses) → true when ready.
function waitForReady(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/version", timeout: 1000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) resolve(true);
        else retry();
      });
      req.on("error", retry);
      req.on("timeout", () => { req.destroy(); retry(); });
    };
    const retry = () => (Date.now() >= deadline ? resolve(false) : setTimeout(attempt, 150));
    attempt();
  });
}

// Poll until the gateway STOPS answering on /api/version (or the timeout elapses) → true when down.
function waitForDown(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const req = http.get({ host: "127.0.0.1", port, path: "/api/version", timeout: 1000 }, (res) => {
        res.resume();
        // Any answer (even non-200) means the port is still held → keep waiting.
        Date.now() >= deadline ? resolve(false) : setTimeout(attempt, 150);
      });
      req.on("error", () => resolve(true)); // connection refused / reset → the daemon is gone
      req.on("timeout", () => { req.destroy(); Date.now() >= deadline ? resolve(false) : setTimeout(attempt, 150); });
    };
    attempt();
  });
}

// One-shot GET /api/version → the version string, or null if the daemon isn't answering.
function fetchVersion(port) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/version", timeout: 1500 }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => {
        if (res.statusCode !== 200) return resolve(null);
        try { resolve(JSON.parse(data).version ?? "unknown"); } catch { resolve("unknown"); }
      });
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => { req.destroy(); resolve(null); });
  });
}

// POST /internal/shutdown (the daemon's graceful control hook) → { status } or { error }.
function postShutdown(port) {
  return new Promise((resolve) => {
    const req = http.request({ host: "127.0.0.1", port, path: "/internal/shutdown", method: "POST", timeout: 2000 }, (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on("error", (e) => resolve({ error: e }));
    req.on("timeout", () => { req.destroy(); resolve({ error: new Error("timeout") }); });
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (!isAlive(pid)) return true; await sleep(120); }
  return !isAlive(pid);
}

// Best-effort: open the default browser. If it fails, the URL is already printed.
function openBrowser(target) {
  try {
    let cmd, cmdArgs;
    if (process.platform === "win32") { cmd = "cmd"; cmdArgs = ["/c", "start", "", target]; }
    else if (process.platform === "darwin") { cmd = "open"; cmdArgs = [target]; }
    else { cmd = "xdg-open"; cmdArgs = [target]; }
    const child = spawn(cmd, cmdArgs, { stdio: "ignore", detached: true });
    child.on("error", () => { /* best-effort — URL already printed */ });
    child.unref();
  } catch { /* best-effort */ }
}

function resolveDaemonEntry() {
  const daemonEntry = path.join(pkgRoot, "dist", "index.js");
  if (!fs.existsSync(daemonEntry)) {
    console.error(`loom: daemon entry not found at ${daemonEntry}
This package looks incomplete (was it built/assembled with scripts/build-npm-package.mjs?).`);
    process.exit(1);
  }
  return daemonEntry;
}

// --- start (FOREGROUND): backward-compatible with the original bare `loom` -------------------------
async function startForeground({ port, open }) {
  const daemonEntry = resolveDaemonEntry();
  process.env.LOOM_PORT = String(port);
  const url = urlFor(port);
  console.log(`Starting Loom v${readVersion()} …`);

  // In-process boot: importing the daemon entry runs its main() (binds 127.0.0.1:LOOM_PORT and serves
  // the viewport). The daemon owns its own SIGINT/SIGTERM shutdown + "listening" log; we just await
  // readiness.
  await import(pathToFileURL(daemonEntry).href);

  const ready = await waitForReady(port, 30000);
  if (ready) {
    console.log(`\n  Loom is running at ${url}\n  Press Ctrl-C to stop.\n`);
    if (open) openBrowser(url);
  } else {
    console.error(`loom: the daemon did not answer on ${url} within 30s — it may still be starting; open the URL manually.`);
  }
}

// --- start --detach: background the daemon, write a PID file, return -------------------------------
async function startDetached({ port, open }) {
  const daemonEntry = resolveDaemonEntry();
  const url = urlFor(port);

  // Already up on this port? Don't spawn a second daemon that would just fail to bind.
  if (await fetchVersion(port)) {
    console.log(`loom: a daemon is already running at ${url}.`);
    return 0;
  }

  // Detached child IS the daemon process (node dist/index.js) — its pid is the one we later stop. Its
  // logs go to a file under LOOM_HOME/logs so a backgrounded boot stays debuggable; fall back to ignore.
  const env = { ...process.env, LOOM_PORT: String(port) };
  let stdio = "ignore";
  let logPath = null;
  try {
    const logsDir = path.join(loomHome(), "logs");
    fs.mkdirSync(logsDir, { recursive: true });
    logPath = path.join(logsDir, "daemon-detached.log");
    const fd = fs.openSync(logPath, "a");
    stdio = ["ignore", fd, fd];
  } catch { /* keep stdio = "ignore" */ }

  const child = spawn(process.execPath, [daemonEntry], { cwd: pkgRoot, env, detached: true, windowsHide: true, stdio });
  child.unref();
  writePidFile({ pid: child.pid, port, url, version: readVersion(), startedAt: new Date().toISOString() });
  console.log(`Starting Loom v${readVersion()} in the background …`);

  const ready = await waitForReady(port, 30000);
  if (ready) {
    console.log(`\n  Loom is running at ${url}  (detached, PID ${child.pid})\n  Stop it with 'loom stop'.\n`);
    if (open) openBrowser(url);
    return 0;
  }
  console.error(`loom: the daemon did not answer on ${url} within 30s (PID ${child.pid}).
It may still be starting — check 'loom status'${logPath ? ` or the log at ${logPath}` : ""}.`);
  return 1;
}

// --- stop: graceful, with a cross-platform fallback ladder -----------------------------------------
// Ladder: (1) the loopback POST /internal/shutdown control hook (truly graceful + identical on
// Windows/POSIX); (2) if that hook is ABSENT (404 — an older daemon predating it) fall back to POSIX
// SIGTERM (the daemon's own graceful handler); (3) LAST resort a hard kill — and we print a clear
// warning that the stop was NOT graceful (Windows has no SIGTERM, so an older daemon there can only be
// hard-killed). Stale/absent PID files are handled as "not running".
async function stop() {
  const rec = readPidFile();
  if (!rec) { console.log("loom: no daemon is running (no PID file)."); return 0; }
  if (!isAlive(rec.pid)) { removePidFile(); console.log(`loom: not running (stale PID ${rec.pid} cleaned).`); return 0; }

  const port = rec.port ?? DEFAULT_PORT;
  let graceful = false;

  // (1) graceful control hook
  const hook = await postShutdown(port);
  if (hook.status === 202 || hook.status === 200) {
    if (await waitForDown(port, 12000)) graceful = true;
  } else if (hook.status === 404) {
    console.error("loom: this daemon predates the graceful-shutdown hook — falling back to a signal.");
  }

  // (2) POSIX SIGTERM fallback (the daemon's signal handler runs the SAME graceful path). On Windows
  // there is no real SIGTERM, so this is skipped and we go straight to the hard-kill warning below.
  if (!graceful && isAlive(rec.pid) && process.platform !== "win32") {
    try { process.kill(rec.pid, "SIGTERM"); } catch { /* may already be exiting */ }
    if (await waitForExit(rec.pid, 10000)) graceful = true;
  }

  // (3) last-resort HARD kill — NOT graceful; warn loudly so it stays honest.
  if (!graceful && isAlive(rec.pid)) {
    console.error("loom: ⚠ graceful stop did not complete — HARD-killing the daemon (no transcript snapshot / clean teardown).");
    if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(rec.pid), "/T", "/F"], { stdio: "ignore" });
    else { try { process.kill(rec.pid, "SIGKILL"); } catch { /* gone */ } }
    await waitForExit(rec.pid, 5000);
  }

  if (isAlive(rec.pid)) { console.error(`loom: failed to stop the daemon (PID ${rec.pid}).`); return 1; }
  removePidFile();
  console.log(graceful ? "loom: daemon stopped (graceful)." : "loom: daemon stopped (forced).");
  return 0;
}

// --- status: probe the daemon; exit non-zero if not running (scriptable) ---------------------------
async function status({ port }) {
  const rec = readPidFile();
  const probePort = port ?? rec?.port ?? (process.env.LOOM_PORT ? Number(process.env.LOOM_PORT) : DEFAULT_PORT);
  const url = urlFor(probePort);
  const version = await fetchVersion(probePort);
  if (version) {
    const pidNote = rec && isAlive(rec.pid) ? `  (detached, PID ${rec.pid})` : "";
    console.log(`loom: running — v${version} at ${url}${pidNote}`);
    return 0;
  }
  // Not answering. Clean a stale PID file if its process is also gone.
  if (rec && !isAlive(rec.pid)) { removePidFile(); console.log(`loom: not running (stale PID ${rec.pid} cleaned).`); }
  else console.log(`loom: not running (no daemon answering on ${url}).`);
  return 1;
}

// --- open: open the browser to a running daemon ----------------------------------------------------
async function openCmd({ port }) {
  const rec = readPidFile();
  const probePort = port ?? rec?.port ?? (process.env.LOOM_PORT ? Number(process.env.LOOM_PORT) : DEFAULT_PORT);
  const url = urlFor(probePort);
  if (!(await fetchVersion(probePort))) {
    console.error(`loom: no daemon is running at ${url} — start one with 'loom start'.`);
    return 1;
  }
  console.log(`loom: opening ${url} …`);
  openBrowser(url);
  return 0;
}

// --- service: register/unregister/inspect OS autostart (delegates to ./service.mjs) ----------------
// The registered service runs `loom start --no-open` in the FOREGROUND under the OS service manager
// (systemd --user / launchd / Task Scheduler) — END USERS get no supervisor, the OS owns keep-alive.
async function serviceCmd({ action, port }) {
  const { runService } = await import(pathToFileURL(path.join(here, "service.mjs")).href);
  return runService({
    action,
    platform: process.platform,
    node: process.execPath,           // the absolute node that will run the daemon at login
    loomBin: fileURLToPath(import.meta.url), // this CLI's absolute path (bin/loom.mjs)
    workingDir: pkgRoot,              // run from the installed package root (where dist/ lives)
    port,
    loomHome: loomHome(),
    isRunning: fetchVersion,          // cross-check "running?" against the live daemon
  });
}

// --- update: upgrade in place via npm, then a clean restart ----------------------------------------
// END USERS run NO supervisor (the exit-75 restart sentinel is supervisor-only — see CLAUDE.md), so an
// update can't be a self-restart; it's a deliberate stop → reinstall → start cycle driven from here:
//   (1) resolve + persist the channel (--channel switches+persists; bare reuses the last, default
//       stable) and derive the npm install spec (stable → loomctl@latest, beta → loomctl@beta);
//   (2) gracefully STOP the running daemon FIRST — so npm can replace files the daemon holds open
//       (Windows locks a running process's modules) and the fresh boot picks up the new code;
//   (3) `npm i -g <spec>` to upgrade the global package in place;
//   (4) START the daemon back up (detached) if one had been running, now on the new code.
// (Self-hosting note from CLAUDE.md: a dep-adding upgrade needs the install to land before the start —
// step 3 precedes step 4, so that holds here.)
async function update({ channel, port: explicitPort }) {
  const home = loomHome();
  const chan = channel ? writeChannel(home, channel) : readChannel(home);
  const spec = installSpecFor(chan);

  const rec = readPidFile();
  const port = explicitPort ?? rec?.port ?? (process.env.LOOM_PORT ? Number(process.env.LOOM_PORT) : DEFAULT_PORT);
  const wasRunning = !!(await fetchVersion(port));

  console.log(`loom: updating on the '${chan}' channel → npm i -g ${spec}`);

  // (2) stop first (graceful, reusing the stop ladder) so files are unlocked for the reinstall.
  if (wasRunning) {
    console.log("loom: stopping the running daemon …");
    const rc = await stop();
    if (rc !== 0) { console.error("loom: could not stop the daemon — aborting update (nothing was reinstalled)."); return rc; }
  } else {
    console.log("loom: no daemon is running — installing the update only.");
  }

  // (3) reinstall the global package in place. npm respects the active npm prefix, so a staged/throwaway
  //     prefix is upgraded rather than the dev global. Spawn through the SHELL: on Windows `npm` is
  //     `npm.cmd`, and Node 22 refuses to spawnSync a .cmd directly (EINVAL — a CVE mitigation), so
  //     shell:true is required there; it also resolves bare `npm` on POSIX. The args are hardcoded safe
  //     tokens (`spec` is `loomctl@<dist-tag>` with the channel validated to stable|beta), so there is
  //     no shell-injection surface.
  const r = spawnSync("npm", ["i", "-g", spec], { stdio: "inherit", shell: true });
  if (r.error || r.status !== 0) {
    const why = r.error ? r.error.message : `exit ${r.status}`;
    console.error(`loom: npm install failed (${why}). The daemon was NOT restarted — start it with 'loom start'.`);
    return 1;
  }

  // (4) bring the (now-updated) daemon back up if it had been running.
  if (wasRunning) {
    console.log("loom: starting the updated daemon …");
    return await startDetached({ port, open: false });
  }
  console.log(`loom: updated to the latest '${chan}' release. Start the daemon with 'loom start'.`);
  return 0;
}

// --- dispatch --------------------------------------------------------------------------------------
async function run(argv = process.argv.slice(2)) {
  const parsed = parseArgs(argv);
  if (parsed.error) { console.error(`loom: ${parsed.error}`); process.exit(parsed.exitCode); }
  if (parsed.help) { printHelp(); process.exit(0); }
  if (parsed.version) { console.log(readVersion()); process.exit(0); }

  switch (parsed.command) {
    case "stop": process.exit(await stop());
    case "status": process.exit(await status({ port: parsed.port }));
    case "open": process.exit(await openCmd({ port: parsed.port }));
    case "update": process.exit(await update({ channel: parsed.channel, port: parsed.port }));
    case "service": {
      // status cross-checks a running daemon; install bakes a concrete port into the unit/plist/task.
      const port = resolvePort(parsed.port);
      process.exit(await serviceCmd({ action: parsed.serviceAction, port }));
    }
    case "restart": {
      await stop();
      const port = resolvePort(parsed.port);
      if (parsed.detach) process.exit(await startDetached({ port, open: parsed.open }));
      await startForeground({ port, open: parsed.open });
      return; // foreground: the in-process daemon keeps running
    }
    case "start":
    case null: { // bare `loom` (backward-compat) and `loom start`
      const port = resolvePort(parsed.port);
      if (parsed.detach) process.exit(await startDetached({ port, open: parsed.open }));
      await startForeground({ port, open: parsed.open });
      return;
    }
    default: { printHelp(); process.exit(0); }
  }
}

// True only when this module IS the program's entry point — i.e. argv1 and this module's URL resolve
// to the SAME file. Realpath-normalize BOTH sides so a symlinked global dir (fnm's fnm_multishells
// junction, nvm/volta/pnpm-global) still matches: there Node realpaths import.meta.url to the package's
// true location, but the shim leaves process.argv[1] as the symlinked path — the raw href compare then
// mismatches and the CLI silently no-ops on EVERY command (the 0.4.0 fnm bug). Fall back to the plain
// href compare when realpath throws (e.g. argv1 doesn't exist on disk). Stays false when the file is
// merely imported (a test's argv1 is the test file, whose realpath won't equal loom.mjs's).
export function isDirectInvocation(argv1, metaUrl) {
  if (!argv1) return false;
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(metaUrl));
  } catch {
    return pathToFileURL(argv1).href === metaUrl; // fallback (e.g. argv1 doesn't exist)
  }
}

// Run only when invoked directly (not when imported by a test for parseArgs/isDirectInvocation).
if (isDirectInvocation(process.argv[1], import.meta.url)) {
  run().catch((err) => { console.error("loom:", err?.message ?? err); process.exit(1); });
}
