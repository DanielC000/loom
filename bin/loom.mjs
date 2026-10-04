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
//   loom open --print-url [--host H] [--port P]
//                         PRINT a tokenized cockpit URL (a live credential) for a tunnelled device
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
import net from "node:net";
import { spawn, spawnSync } from "node:child_process";
import { CHANNELS, isValidChannel, installSpecFor, readChannel, writeChannel } from "./update-config.mjs";
import { commandLineOf, matchesRecordedEntry } from "./lib/cmdline-identity.mjs";
import { acquireStartGuard } from "./lib/start-guard.mjs";

// UV_THREADPOOL_SIZE (task dea6728e, defense-in-depth): the default libuv pool is only 4 threads, so a
// small handful of wedged fs ops could starve fs/dns/crypto process-wide. `startDetached`/`loom service`
// spawn a FRESH node process for the daemon, where setting this on that child's env reliably works.
// `startForeground` instead runs the daemon IN-PROCESS (the OS-service path: `loom start --no-open`) via
// a dynamic import — by the time that import runs, this process's own ESM module loading has likely
// already touched the threadpool, so this assignment is BEST-EFFORT for that path only, never a
// guarantee (libuv reads the env var once, lazily, on first threadpool use — there is no in-process way
// to resize it after the fact). Never overrides an operator's own explicit setting.
if (!process.env.UV_THREADPOOL_SIZE) process.env.UV_THREADPOOL_SIZE = "16";

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
                   With --print-url, print a tokenized cockpit URL instead (see
                   below) for a browser on another device, e.g. behind an SSH
                   port-forward. The URL is a LIVE CREDENTIAL — it goes to
                   stdout only when you explicitly ask; treat it like a password.
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
      --print-url  (open) Print the cockpit URL with the access token embedded
                   and do NOT open a browser. -p/--port is then the tunnel's
                   LOCAL port on the device you will browse from.
      --host <h>   (open --print-url) Host in the printed URL: 127.0.0.1 (default)
                   or localhost — the only two the daemon serves the cockpit on
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
  const out = { command: null, serviceAction: null, port: undefined, open: true, detach: false, channel: null, printUrl: false, host: undefined, help: false, version: false, error: null, exitCode: 0 };
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
    else if (a === "--print-url") out.printUrl = true;
    else if (a === "--host") out.host = argv[++i] ?? "";
    else if (a.startsWith("--host=")) out.host = a.slice("--host=".length);
    else if (a === "--channel") out.channel = argv[++i];
    else if (a.startsWith("--channel=")) out.channel = a.slice("--channel=".length);
    else { out.error = `unknown argument '${a}' (try 'loom --help')`; out.exitCode = 2; return out; }
  }
  if (out.port !== undefined && !isValidPort(out.port)) {
    out.error = `invalid port '${out.port}' (expected 1-65535)`; out.exitCode = 2; return out;
  }
  if ((out.printUrl || out.host !== undefined) && out.command !== "open") {
    out.error = "--print-url and --host apply only to 'loom open'"; out.exitCode = 2; return out;
  }
  if (out.host !== undefined && !out.printUrl) {
    out.error = "--host requires --print-url"; out.exitCode = 2; return out;
  }
  if (out.host !== undefined && normalizeUrlHost(out.host) === null) {
    out.error = `invalid host '${out.host}' (expected 127.0.0.1 or localhost — the daemon's DNS-rebind guard 403s the cockpit on any other Host, so a URL for it would not load)`; out.exitCode = 2; return out;
  }
  // A supplied --channel must be a known channel (a bare 'loom update' leaves it null → use persisted).
  if (out.channel !== null && !isValidChannel(out.channel)) {
    out.error = `invalid channel '${out.channel ?? ""}' (expected ${CHANNELS.join(" | ")})`; out.exitCode = 2; return out;
  }
  return out;
}

// Allowlist for the host in a printed credential URL: exactly the two names the daemon's DNS-rebind guard
// (`isLoopbackHostname`, gateway/server.ts) accepts for the cockpit. Anything else — `[::1]`, a hostname,
// a zone-id (`%`) — would print a URL the daemon itself 403s, so it is rejected up front. Returns the host
// or null. (`localhost` and `127.0.0.1` are different browser origins: each keeps its own token.)
const PRINT_URL_HOSTS = new Set(["127.0.0.1", "localhost"]);
export function normalizeUrlHost(h) {
  return typeof h === "string" && PRINT_URL_HOSTS.has(h) ? h : null;
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

// Card 9ccedbee: the daemon now requires a shared secret (as `Authorization: Bearer <token>`) on every
// human-only config WRITE, even from loopback — see packages/daemon/src/gateway/loopback-secret.ts. It
// is generated lazily by the daemon itself at boot (0600, under LOOM_HOME); this CLI never mints it,
// only reads the same file back to embed it in the browser URL it opens. The web SPA captures the
// `?token=` query param on first load, remembers it (localStorage), and strips it from the visible URL —
// so this is a one-time-per-browser-profile thing, not a per-launch requirement. A daemon still mid-boot
// (the file not created yet) degrades to the bare URL: the browser just won't have a token until the
// user revisits a tokenized URL once.
//
// The tokenized URL is built in exactly TWO sinks — `openBrowser` (a one-time OS-process argv, not a
// durable channel) and `printUrlCmd` (the explicit `open --print-url` stdout write) — and no free function
// returns one (card 85671808; cli-print-url.mjs proves the structure by injection, not a text scan). Both
// take a BARE origin and read the secret themselves. A tokenized URL must NEVER reach a console: `loom start --no-open` is how `loom service
// install` registers the daemon with the OS service manager (systemd/launchd/Task Scheduler), which
// commonly captures a foregrounded service's own stdout into ITS OWN durable, often broadly-readable log
// (e.g. `journalctl`) — the exact same "secret lands in a durable log agents routinely read for unrelated
// reasons" exposure a manager review caught in the daemon's OWN boot banner (see index.ts). `urlHint`
// below is the console-safe counterpart: it prints the bare URL plus a pointer to the secret FILE PATH,
// never the secret itself.
function loopbackSecretPath() { return path.join(loomHome(), "gateway-loopback.key"); }
// → { secret, error }: `error` is the fs error for an unreadable file (ENOENT = not created yet).
function readLoopbackSecretResult() {
  try { const s = fs.readFileSync(loopbackSecretPath(), "utf8").trim(); return { secret: s || null, error: null }; }
  catch (error) { return { secret: null, error }; }
}
function readLoopbackSecret() { return readLoopbackSecretResult().secret; }
// The ONE tokenized-URL builder (origin like `http://127.0.0.1:4317`, no trailing slash). Module-private
// and NOT exported; only the two sinks above may call it.
const tokenizedUrl = (origin, secret) => `${origin}/?token=${encodeURIComponent(secret)}`;
function urlHint(url) {
  return readLoopbackSecret()
    ? `${url}  (first visit: append ?token=<value>, where <value> is the contents of ${loopbackSecretPath()} — the browser remembers it after)`
    : url;
}

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

// One-shot probe of the loopback port that tells apart "nothing is listening here at all" from
// "something is listening but isn't answering" — the distinction `stop()` needs before it trusts a bare
// pid enough to signal it (task a242c747). Returns "answered" (got an HTTP response, any status — the
// port is held by an HTTP server, presumably Loom), "refused" (ECONNREFUSED/ECONNRESET — the OS actively
// rejected the connection because no process is bound to this port at all), or "timeout"/"other-error"
// (a connection went through — or errored some other way — but no response arrived; consistent with a
// still-listening process that just isn't responding, e.g. a genuinely wedged daemon).
function classifyPortResponse(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port, path: "/api/version", timeout: timeoutMs }, (res) => {
      res.resume();
      resolve("answered");
    });
    req.on("error", (e) => resolve(e && (e.code === "ECONNREFUSED" || e.code === "ECONNRESET") ? "refused" : "other-error"));
    req.on("timeout", () => { req.destroy(); resolve("timeout"); });
  });
}

// @decision 279c0208 — never un-anchor either alternative: a bare `dist[\/]index\.js|loom(\.mjs)?` and a
// bare `[\/]loom(?:["'\s]|$)` were both reproduced as false positives (a foreign app, an unrelated `vim`).
export const LEGACY_DAEMON_CMDLINE_RE = /loomctl[\\/](?:dist[\\/]index\.js|bin[\\/]loom\.mjs)|[\\/]bin[\\/]loom(?:["'\s]|$)/i;

// Confirms a pid's live command line actually names a LOOM process before `stop()` signals it (card
// 279c0208). Two tiers:
//   1. PREFERRED: `rec.entry` — the exact absolute path THIS pid was spawned/invoked with, recorded at
//      pid-record-write time — confirmed via `matchesRecordedEntry` (`./lib/cmdline-identity.mjs`, shared
//      with `scripts/daemon-supervisor-stop.mjs`).
//   2. FALLBACK (a pid record predating this field): `LEGACY_DAEMON_CMDLINE_RE` — `loomctl/dist/index.js`
//      or `loomctl/bin/loom.mjs` (this package's own name), or `…/bin/loom` (the POSIX global-symlink
//      shape, anchored on the `bin` DIRECTORY since `loomctl` isn't in that path either — never a bare
//      `loom`-named path component, which matched `vim …/loom` / `git -C …/loom status` before).
// Returns false — REFUSE, never guess — when the command line can't be read at all, or matches neither
// tier: a stale pid record recycled into an unrelated process must never be signalled.
//
// @decision 03cc6cae — tier 1 is an exact argv match when available (win32/Linux), else a whole-argument
// boundary match on the raw string (POSIX `ps`, never quotes) — never a bare substring or naive split.
// Not position-anchored to "the entry script handed to node" — see this record's round-4 section.
function isOurDaemon(rec) {
  const info = commandLineOf(rec.pid);
  if (!info.raw) return false;
  if (rec.entry) return matchesRecordedEntry(info, rec.entry);
  return LEGACY_DAEMON_CMDLINE_RE.test(info.raw);
}

// POST /internal/shutdown (the daemon's graceful control hook) → { status } or { error }.
// Card 93249b52: this route now requires the SAME loopback-secret bearer credential every /api/* write
// does (see gateway/server.ts's `isGuardedInternalWrite`) — this CLI runs on the same host and can read
// the secret file directly (`readLoopbackSecret`, already used above for `openBrowser`/`urlHint`), so no
// new discovery mechanism is needed. `stop()` only ever targets an ALREADY-running daemon (found via the
// PID file / a live port probe), and `getOrCreateLoopbackSecret()` runs in index.ts's `main()` BEFORE the
// gateway ever starts listening — so by the time a daemon is reachable at all, the secret file is
// guaranteed to already exist; there's no boot-race window here. A daemon that predates this card (no
// guard wired) just ignores the extra header. If the secret is somehow still unreadable (a permissions
// problem, a corrupt-then-mid-regenerate file), `postShutdown` sends no header, the guarded daemon 401s,
// and `stop()`'s existing SIGTERM/SIGKILL fallback ladder (below) still gets the daemon down — so this
// never leaves a user unable to stop their own daemon, only ungraceful in that one edge case.
function postShutdown(port) {
  return new Promise((resolve) => {
    const secret = readLoopbackSecret();
    const headers = secret ? { authorization: `Bearer ${secret}` } : {};
    const req = http.request({ host: "127.0.0.1", port, path: "/internal/shutdown", method: "POST", timeout: 2000, headers }, (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on("error", (e) => resolve({ error: e }));
    req.on("timeout", () => { req.destroy(); resolve({ error: new Error("timeout") }); });
    req.end();
  });
}

// Card 0da5a3f7: `update()`'s narrower stop path for a daemon that ANSWERS (fetchVersion succeeded) but
// has no usable PID record — no pid file at all, or one whose recorded pid is no longer alive. There is
// no pid to identify, let alone verify, so there is nothing safe to signal: this deliberately never falls
// back to SIGTERM/SIGKILL/taskkill the way stop()'s own ladder does for a usable record. Only the
// graceful loopback hook, then a bounded wait for the port to actually go down. Returns false on anything
// short of that (a non-2xx/absent hook response, or a port still held once the wait elapses) — `update()`
// treats false as "could not confirm stopped" and refuses to proceed to the reinstall.
async function stopViaLoopbackOnly(port, timeoutMs = 12000) {
  const hook = await postShutdown(port);
  if (hook.status !== 200 && hook.status !== 202) return false;
  return waitForDown(port, timeoutMs);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitForExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (!isAlive(pid)) return true; await sleep(120); }
  return !isAlive(pid);
}

function launchBrowser(target) {
  try {
    let cmd, cmdArgs;
    if (process.platform === "win32") { cmd = "cmd"; cmdArgs = ["/c", "start", "", target]; }
    else if (process.platform === "darwin") { cmd = "open"; cmdArgs = [target]; }
    else { cmd = "xdg-open"; cmdArgs = [target]; }
    const child = spawn(cmd, cmdArgs, { stdio: "ignore", detached: true });
    // best-effort: if this fails, the line printed just above (urlHint) has the FILE PATH to build the
    // tokenized URL manually — it does NOT carry the token itself (card 9ccedbee; see urlHint's own doc).
    child.on("error", () => {});
    child.unref();
  } catch { /* best-effort */ }
}
// Best-effort: open the default browser at a BARE origin, appending the loopback token here (a daemon
// still mid-boot has no secret file yet → the bare origin). `launch` is a test seam.
export function openBrowser(origin, { launch = launchBrowser } = {}) {
  const secret = readLoopbackSecret();
  launch(secret ? tokenizedUrl(origin, secret) : origin);
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

// Card 0da5a3f7: foreground has no separate child process to track — THIS CLI invocation IS the daemon
// process (the daemon boots in-process via the dynamic import below), so `process.pid` already IS its
// pid. Before this, `writePidFile` was called ONLY from `startDetached`, so a bare `loom`/`loom start`
// (and, since `loom service` registers `loom start --no-open`, an OS-service-managed daemon too) never
// had a PID record at all — `loom stop` then unconditionally reported "no PID file" and returned 0
// *without ever attempting the graceful shutdown hook*, and `loom update` treated that false "already
// stopped" as license to run `npm i -g` UNDER a still-live daemon. Writing this record here, in the same
// shape `startDetached` already uses, fixes `loom stop` against a foreground/OS-service daemon for free
// (see `stop()` — its logic is unchanged; it just now has a `rec` to work with).
function writeForegroundPidRecord({ port, url }) {
  // `entry: process.argv[1]` (card 279c0208 review) — literally the path this SAME live process was
  // invoked with (the npm global symlink, or the Windows shim's resolved bin/loom.mjs path), so it is
  // GUARANTEED to appear verbatim in this pid's own live command line later — see `isOurDaemon`.
  writePidFile({ pid: process.pid, port, url, entry: process.argv[1], version: readVersion(), startedAt: new Date().toISOString() });
}
// Removes the pid file ONLY if it still names OUR OWN pid — never a later invocation's record we lost a
// clobber race against (e.g. a stray second `loom start` on the same LOOM_HOME). Exported so a test can
// exercise the exact write/remove pair without booting a real daemon (there is no `<repo-root>/dist` in
// this monorepo checkout for `resolveDaemonEntry` to find — see this file's own header comment; the
// packaged npm layout is what `startForeground` actually runs against).
export function removeForegroundPidRecordIfOwnedBySelf() {
  try {
    const cur = readPidFile();
    if (cur && cur.pid === process.pid) removePidFile();
  } catch { /* best-effort — never block process exit */ }
}
export { writeForegroundPidRecord };

// --- start (FOREGROUND): backward-compatible with the original bare `loom` -------------------------
async function startForeground({ port, open }) {
  const daemonEntry = resolveDaemonEntry();
  process.env.LOOM_PORT = String(port);
  const url = urlFor(port);
  console.log(`Starting Loom v${readVersion()} …`);

  // Record our own pid BEFORE booting (mirrors startDetached, which writes immediately after spawn,
  // before the child is necessarily ready) — see writeForegroundPidRecord's own comment for why. Clean
  // exit (Ctrl-C/SIGTERM/SIGHUP all funnel through the daemon's own gracefulShutdown → process.exit(0),
  // which fires this process's 'exit' event synchronously) removes it again.
  writeForegroundPidRecord({ port, url });
  process.once("exit", removeForegroundPidRecordIfOwnedBySelf);

  // In-process boot: importing the daemon entry runs its main() (binds 127.0.0.1:LOOM_PORT and serves
  // the viewport). The daemon owns its own SIGINT/SIGTERM shutdown + "listening" log; we just await
  // readiness.
  await import(pathToFileURL(daemonEntry).href);

  const ready = await waitForReady(port, 30000);
  if (ready) {
    console.log(`\n  Loom is running at ${urlHint(url)}\n  Press Ctrl-C to stop.\n`);
    if (open) openBrowser(url);
  } else {
    console.error(`loom: the daemon did not answer on ${url} within 30s — it may still be starting; open the URL manually.`);
  }
}

// --- start --detach: background the daemon, write a PID file, return -------------------------------
async function startDetached({ port, open }) {
  // Guard FIRST (card 4e026f35) — before resolveDaemonEntry, before the port probe, before anything else
  // — and held through the full readiness wait below, released in `finally` regardless of outcome. See
  // bin/lib/start-guard.mjs for why this uses an OS-released primitive rather than a file lock.
  const guard = await acquireStartGuard({ loomHome: loomHome(), port });
  if (!guard.acquired) {
    console.log(`loom: a start for this LOOM_HOME/port is already in progress.`);
    return 0;
  }
  // Card 4e026f35 round 3 item 4: `degraded:true` means the OS-released primitive itself failed open on
  // an unexpected (non-EADDRINUSE) error — this launch still proceeds (see acquireStartGuard's own doc
  // for why that's correct), but silently proceeding with NO mutual exclusion at all is worth a line, not
  // a swallowed diagnostic.
  if (guard.degraded) console.error(`loom: start-guard degraded (${guard.code}) — proceeding without mutual exclusion for this launch.`);
  try {
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
    // `entry: daemonEntry` (card 279c0208 review) — the exact absolute path this child was spawned with
    // (see `resolveDaemonEntry`), so it is GUARANTEED to appear verbatim in this pid's own live command
    // line later — see `isOurDaemon`.
    writePidFile({ pid: child.pid, port, url, entry: daemonEntry, version: readVersion(), startedAt: new Date().toISOString() });
    console.log(`Starting Loom v${readVersion()} in the background …`);

    const ready = await waitForReady(port, 30000);
    if (ready) {
      console.log(`\n  Loom is running at ${urlHint(url)}  (detached, PID ${child.pid})\n  Stop it with 'loom stop'.\n`);
      if (open) openBrowser(url);
      return 0;
    }
    console.error(`loom: the daemon did not answer on ${url} within 30s (PID ${child.pid}).
It may still be starting — check 'loom status'${logPath ? ` or the log at ${logPath}` : ""}.`);
    return 1;
  } finally {
    guard.release();
  }
}

// --- stop: graceful, with a cross-platform fallback ladder -----------------------------------------
// Ladder: (1) the loopback POST /internal/shutdown control hook (truly graceful + identical on
// Windows/POSIX); (2) if that hook is ABSENT (404 — an older daemon predating it) fall back to POSIX
// SIGTERM (the daemon's own graceful handler); (3) LAST resort a hard kill — and we print a clear
// warning that the stop was NOT graceful (Windows has no SIGTERM, so an older daemon there can only be
// hard-killed). Stale/absent PID files are handled as "not running".
//
// IDENTITY, not just liveness (task a242c747): `isAlive(rec.pid)` below only proves *some* process holds
// this pid — OS pids get reused, so after an unclean exit the pid file can point at a totally unrelated
// process, and signalling it blind (steps 2/3 use a bare pid — SIGTERM, SIGKILL, and on Windows
// `taskkill /T /F`, which kills that process's WHOLE tree) can hit an innocent bystander. Resolved into
// one of several outcomes just below — see that block's own comment for which is which.
//
// @decision 03cc6cae — `isOurDaemon` runs on EVERY branch that can fall through to the signal ladder, never
// just the port-probe "timeout" outcome; a stand-in daemon must present a recorded-entry command line.
//
// RESIDUAL WINDOW (not closed by the above, card a2f821bf): identity is confirmed BEFORE the signal is
// chosen, not AT the instant it is issued. Between a passing check (the hook responding, the port-probe
// resolving to something other than "refused", or the command-line confirmation) and the actual
// `process.kill`/`taskkill` call below, the confirmed process can exit and the OS can reuse its pid — the
// signal can then, in principle, reach an unrelated process. On Windows this is worse: the hard-kill path
// is `taskkill /T /F`, which
// takes the WHOLE process tree, not just the one pid. Not closed by narrowing — a retry, a re-check
// immediately before signalling, or a shorter gap all leave the same window, just smaller. What WOULD
// close it is signalling by a stable handle rather than a recyclable number (a Windows process handle
// opened at confirmation time and signalled through it directly; a POSIX pidfd) — neither of which Node
// exposes cross-platform today. Not reducible with the APIs available to us here, not structurally
// impossible.
async function stop() {
  const rec = readPidFile();
  if (!rec) { console.log("loom: no daemon is running (no PID file)."); return 0; }
  if (!isAlive(rec.pid)) { removePidFile(); console.log(`loom: not running (stale PID ${rec.pid} cleaned).`); return 0; }

  const port = rec.port ?? DEFAULT_PORT;
  let graceful = false;

  // (1) graceful control hook
  const hook = await postShutdown(port);
  if (hook.status === 202 || hook.status === 200) {
    // TEST SEAM (card 03cc6cae): under LOOM_TEST=1 ONLY, LOOM_TEST_STOP_WAIT_FOR_DOWN_MS shortens this wait
    // so a hermetic test can exercise the "202/200 whose waitForDown timed out" identity-check branch
    // without a real 12s wait. Unset, or outside LOOM_TEST, this is byte-identical to the original.
    const waitMs = process.env.LOOM_TEST === "1" && process.env.LOOM_TEST_STOP_WAIT_FOR_DOWN_MS
      ? Number(process.env.LOOM_TEST_STOP_WAIT_FOR_DOWN_MS)
      : 12000;
    if (await waitForDown(port, waitMs)) graceful = true;
  } else if (hook.status === 404) {
    console.error("loom: this daemon predates the graceful-shutdown hook — falling back to a signal.");
  } else if (hook.status === 401) {
    // Card 93249b52: the daemon rejected our credential (or we couldn't read one — see postShutdown's own
    // comment for why that shouldn't normally happen). Falls through to the signal ladder below, same as
    // a 404 — on POSIX that's still a graceful SIGTERM; on Windows (no real SIGTERM) it goes straight to
    // a hard kill, so this is worth telling the user about rather than failing silently.
    console.error(`loom: the daemon rejected our stop credential (401) — falling back to a signal.${process.platform === "win32" ? " On Windows this means a HARD kill (no graceful teardown)." : ""}`);
  }

  // Identity check before EITHER signal step below — on EVERY path that can still reach the signal ladder
  // here (card 03cc6cae's decision note above `stop()` states the current scoping; supersedes 279c0208,
  // which confirmed identity only on the no-HTTP-response path). An HTTP response on the recorded port
  // (hook.status defined — 200/202 whose waitForDown timed out, 404, or 401) proves SOMETHING is listening
  // there, never that it's the pid WE recorded — a pid recycled into an unrelated process that happens to
  // also run an HTTP server on this port would previously have been signalled unverified. When there was no
  // HTTP response at all (hook.status undefined), probe the port directly first — THREE outcomes:
  //   - REFUSED (nothing listening at all): treat it like any other stale PID file (clean it, never
  //     signal) — a running Loom daemon always holds its port, so a pid alive without holding it is
  //     almost certainly a reused one.
  //   - TIMEOUT or ANSWERED (the port IS held, responding or not): consistent with a genuinely wedged real
  //     daemon, or an un-signalled one that just didn't answer this specific probe in time — falls through
  //     to the identity check below either way.
  //   - anything else (an unclassified connection error): genuinely UNDECIDABLE — refuse to guess and hand
  //     the human the exact pid and command so they can finish the job themselves if it really is stuck.
  if (!graceful) {
    if (hook.status === undefined) {
      const probe = await classifyPortResponse(port);
      if (probe === "refused") {
        console.error(`loom: PID ${rec.pid} is alive, but nothing is listening on ${urlFor(port)}. Treating the PID file as stale — a running Loom daemon always holds its port, so this PID is almost certainly a reused one belonging to another process.`);
        removePidFile();
        console.log(`loom: not running (stale PID ${rec.pid} cleaned). The process still holding that PID was NOT signalled.`);
        return 0;
      }
      if (probe === "other-error") {
        console.error(`loom: could not confirm whether PID ${rec.pid} is still the Loom daemon (no answer on ${urlFor(port)}).`);
        console.error(`loom: refusing to signal an unidentified process. If you're sure PID ${rec.pid} is the stuck daemon, stop it yourself: ${process.platform === "win32" ? `taskkill /PID ${rec.pid} /T /F` : `kill -9 ${rec.pid}`}`);
        return 1;
      }
      // probe === "timeout" or "answered": the port IS held. Confirm the command line below before
      // falling through to the signal ladder.
    }
    // Confirm the live COMMAND LINE actually matches what WE recorded launching this pid with (see
    // `isOurDaemon`'s own comment) before falling through to the signal ladder — refuses, rather than
    // guessing, when it can't. A real wedged/unresponsive daemon's command line is readable regardless of
    // HTTP responsiveness, so a truly wedged daemon never becomes harder to stop than a pid recycled into
    // an unrelated process — but this is NOT automatically trivial: a Windows npm cmd-shim's own invocation
    // shape can genuinely differ from the Node-normalized recorded `entry` (card 03cc6cae review; see
    // `cmdlineHasEntryArgument`'s own normalization), which is why that normalization step matters here.
    if (!isOurDaemon(rec)) {
      console.error(`loom: PID ${rec.pid} is alive and holds ${urlFor(port)}, but its live command line does not confirm it as the loom daemon — it may have been reused by an unrelated process since the PID file was written.`);
      console.error(`loom: refusing to signal an unverified process. If you're sure PID ${rec.pid} is the stuck daemon, stop it yourself: ${process.platform === "win32" ? `taskkill /PID ${rec.pid} /T /F` : `kill -9 ${rec.pid}`}`);
      return 1;
    }
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
async function openCmd({ port, printUrl, host }) {
  if (printUrl) return printUrlCmd({ port, host });
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

// `loom open --print-url`: the EXPLICIT, opt-in way to hand a tunnelled browser (which can't run `loom
// open`) the loopback credential in a URL. The secret still comes only from the host filesystem — no
// network surface. It prints to stdout ONLY on this explicit request (never from start/status — see the
// tokenized-URL note above) and warns on stderr that the URL is a live credential. `port` here is the
// address the URL will be opened at (the tunnel's local port), so no daemon probe is made.
export function printUrlCmd({ port, host }, { write = console.log } = {}) {
  const { secret, error } = readLoopbackSecretResult();
  if (!secret) {
    if (error && error.code !== "ENOENT") {
      console.error(`loom: could not read the access credential at ${loopbackSecretPath()} (${error.code ?? error.message}) — check the file's permissions/ownership, then retry.`);
    } else if (error) {
      console.error(`loom: no access credential found at ${loopbackSecretPath()} — start the daemon once (it creates the file), then retry.`);
    } else {
      console.error(`loom: the access credential file at ${loopbackSecretPath()} is empty — restart the daemon so it regenerates it, then retry.`);
    }
    return 1;
  }
  const rec = readPidFile();
  const p = port ?? rec?.port ?? resolvePort(undefined);
  const h = host === undefined ? "127.0.0.1" : normalizeUrlHost(host);
  console.error("loom: WARNING — this URL embeds the loopback access credential. Anyone holding it can drive the full local API. Treat it like a password: don't paste it into chat, tickets or logs.");
  write(tokenizedUrl(`http://${h}:${p}`, secret));
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

// The real reinstall step, spawned through the SHELL (Windows `npm` is `npm.cmd`, and Node 22 refuses to
// spawnSync a .cmd directly — EINVAL, a CVE mitigation — so shell:true is required there; it also
// resolves bare `npm` on POSIX). The args are hardcoded safe tokens (`spec` is `loomctl@<dist-tag>` with
// the channel validated to stable|beta), so there is no shell-injection surface.
//
// TEST SEAM (card 0da5a3f7): under LOOM_TEST=1 ONLY, LOOM_TEST_NPM_INSTALL_CMD — a JSON argv-prefix array,
// e.g. `["node","/path/to/fixture.mjs"]` — replaces this call so a hermetic test can exercise update()'s
// full stop → install → restart flow without ever touching the real global npm registry; `spec` is still
// appended as the final argv entry so a fixture can assert exactly what would have been installed. Unset,
// or outside LOOM_TEST, this is byte-identical to the original unconditional real-npm call.
function runNpmInstall(spec) {
  if (process.env.LOOM_TEST === "1" && process.env.LOOM_TEST_NPM_INSTALL_CMD) {
    const [file, ...prefixArgs] = JSON.parse(process.env.LOOM_TEST_NPM_INSTALL_CMD);
    return spawnSync(file, [...prefixArgs, spec], { stdio: "inherit" });
  }
  return spawnSync("npm", ["i", "-g", spec], { stdio: "inherit", shell: true });
}

// `loom update` never touches a registered OS-autostart service artifact, so an existing install's plist/
// unit/task can drift behind what the just-installed code would now generate. Hints at a refresh rather
// than silently rewriting one.
// @decision 279c0208 — hint only; never auto-rewrite/reload a registered service. Best-effort: a probe
// failure here must never turn a successful update into a reported failure.
async function hintServiceRefresh() {
  try {
    const { isServiceRegistered } = await import(pathToFileURL(path.join(here, "service.mjs")).href);
    if (isServiceRegistered({ platform: process.platform })) {
      console.log("loom: an autostart service is registered for Loom — re-run 'loom service install' to refresh it with any service-configuration changes in this release ('loom update' does not rewrite a registered service automatically).");
    }
  } catch { /* best-effort — never fail the update over this */ }
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
//
// @decision 0da5a3f7 — step (2) must NEVER let step (3) run against a still-live daemon: only a USABLE
// pid record (rec && isAlive(rec.pid)) may go through stop()'s full ladder; anything else refuses the
// update outright on anything short of a confirmed-down port via stopViaLoopbackOnly, never a signal.
async function update({ channel, port: explicitPort }) {
  const home = loomHome();
  const chan = channel ? writeChannel(home, channel) : readChannel(home);
  const spec = installSpecFor(chan);

  const rec = readPidFile();
  const port = explicitPort ?? rec?.port ?? (process.env.LOOM_PORT ? Number(process.env.LOOM_PORT) : DEFAULT_PORT);
  const wasRunning = !!(await fetchVersion(port));

  console.log(`loom: updating on the '${chan}' channel → npm i -g ${spec}`);

  // (2) stop first (graceful) so files are unlocked for the reinstall.
  if (wasRunning) {
    if (rec && isAlive(rec.pid)) {
      console.log("loom: stopping the running daemon …");
      const rc = await stop();
      if (rc !== 0) { console.error("loom: could not stop the daemon — aborting update (nothing was reinstalled)."); return rc; }
    } else {
      console.log("loom: a daemon is answering on the port but has no usable PID record (it may predate this fix, or the record is stale/foreign) — stopping it via the graceful shutdown hook only …");
      if (!(await stopViaLoopbackOnly(port))) {
        console.error(`loom: refusing to update — a daemon is still running at ${urlFor(port)} and could not be confirmed stopped (there is no PID record to identify it, so it can't be hard-killed safely either). Stop it yourself, then retry 'loom update'.`);
        return 1;
      }
      removePidFile(); // clear any stale/foreign record now that the port is confirmed down
      console.log("loom: daemon stopped (graceful, no PID record).");
    }
  } else {
    console.log("loom: no daemon is running — installing the update only.");
  }

  // (3) reinstall the global package in place. npm respects the active npm prefix, so a staged/throwaway
  //     prefix is upgraded rather than the dev global — see runNpmInstall for the spawn shape + test seam.
  const r = runNpmInstall(spec);
  if (r.error || r.status !== 0) {
    const why = r.error ? r.error.message : `exit ${r.status}`;
    console.error(`loom: npm install failed (${why}). The daemon was NOT restarted — start it with 'loom start'.`);
    return 1;
  }

  await hintServiceRefresh();

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
    case "open": process.exit(await openCmd({ port: parsed.port, printUrl: parsed.printUrl, host: parsed.host }));
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
