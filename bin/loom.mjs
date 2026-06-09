#!/usr/bin/env node
// The public `loom` CLI. Boots the single-process daemon (which serves the prebuilt web viewport from
// its own loopback origin — Releases v1 Part 1), waits for the gateway to answer, prints the local URL,
// and opens the browser. So `npx loom` / `npm i -g loom && loom` runs the whole app.
//
// This file is shipped at <pkg>/bin/loom.mjs and the daemon at <pkg>/dist/index.js — the assembled npm
// package layout (see scripts/build-npm-package.mjs). It is NOT meant to run from the monorepo source
// tree (there is no <repo-root>/dist); use `pnpm daemon` for dev.
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import { spawn } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(here, ".."); // the installed `loom` package root (holds the umbrella package.json)

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkgRoot, "package.json"), "utf8")).version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function printHelp() {
  console.log(`loom v${readVersion()} — local-first AI project workspace

Usage: loom [options]

Boots the Loom daemon (loopback only), serves the web viewport from the same
process, and opens your browser to it.

Options:
  -p, --port <n>   Port to listen on (default 4317; or env LOOM_PORT)
      --no-open    Do not open the browser automatically
  -v, --version    Print the loom version and exit
  -h, --help       Show this help and exit
`);
}

// --- args -----------------------------------------------------------------------------------------
const argv = process.argv.slice(2);
let port = process.env.LOOM_PORT ? Number(process.env.LOOM_PORT) : 4317;
let open = true;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--help" || a === "-h") { printHelp(); process.exit(0); }
  else if (a === "--version" || a === "-v") { console.log(readVersion()); process.exit(0); }
  else if (a === "--no-open") open = false;
  else if (a === "--port" || a === "-p") port = Number(argv[++i]);
  else if (a.startsWith("--port=")) port = Number(a.slice("--port=".length));
  else { console.error(`loom: unknown argument '${a}' (try 'loom --help')`); process.exit(2); }
}
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`loom: invalid port '${port}' (expected 1-65535)`);
  process.exit(2);
}

// --- boot -----------------------------------------------------------------------------------------
const daemonEntry = path.join(pkgRoot, "dist", "index.js");
if (!fs.existsSync(daemonEntry)) {
  console.error(`loom: daemon entry not found at ${daemonEntry}
This package looks incomplete (was it built/assembled with scripts/build-npm-package.mjs?).`);
  process.exit(1);
}

process.env.LOOM_PORT = String(port);
const url = `http://127.0.0.1:${port}`;
console.log(`Starting Loom v${readVersion()} …`);

// In-process boot: importing the daemon entry runs its main() (binds 127.0.0.1:LOOM_PORT and serves the
// viewport). The daemon owns its own SIGINT/SIGTERM shutdown + "listening" log; we just await readiness.
await import(pathToFileURL(daemonEntry).href);

const ready = await waitForReady(port, 30000);
if (ready) {
  console.log(`\n  Loom is running at ${url}\n  Press Ctrl-C to stop.\n`);
  if (open) openBrowser(url);
} else {
  console.error(`loom: the daemon did not answer on ${url} within 30s — it may still be starting; open the URL manually.`);
}

// Poll GET /api/version until the gateway answers 200 (or the timeout elapses).
function waitForReady(p, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const attempt = () => {
      const req = http.get({ host: "127.0.0.1", port: p, path: "/api/version", timeout: 1000 }, (res) => {
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

// Best-effort: open the default browser. If it fails, the URL is already printed above.
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
