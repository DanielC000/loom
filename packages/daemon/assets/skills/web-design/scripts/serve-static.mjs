#!/usr/bin/env node
// Serve a static directory over LOOPBACK so a Playwright-driven agent can eyeball an on-disk HTML
// artifact via http:// — Playwright's browser_navigate blocks file:// outright, and hand-rolling
// `python -m http.server` (or similar) every render cycle is wasted ceremony. Dependency-free: only
// node:http/node:fs/node:path/node:child_process/node:crypto/node:os/node:url, so it runs anywhere Node
// runs, no install step.
//
// Usage:
//   node serve-static.mjs [dir] [port]
//     Foreground mode (unchanged): serves <dir> (default: cwd) on <port> (default: 0 = OS picks a free
//     port) and blocks in this process until Ctrl-C / SIGTERM or LOOM_SERVE_STATIC_TIMEOUT_MS elapses
//     (default 30 minutes). Prints exactly one line once listening:
//       Serving <dir> at http://127.0.0.1:<port>/
//
//   node serve-static.mjs start <dir> [port]
//     Spawns the server for <dir>, DETACHED so it outlives this launcher process, and prints:
//       Serving <dir> at http://127.0.0.1:<port>/ (pid <pid>)
//       Stop with: node serve-static.mjs stop <dir>
//     Records {pid, port, dir, startedAt} to a tracking file keyed off <dir>'s absolute path (see
//     trackingFilePath) so a LATER, separate `stop` invocation — even from a different shell — can find
//     and kill EXACTLY this process. Refuses to start a second tracked server over an already-tracked,
//     still-alive one for the same <dir>; stop the first one before starting another.
//
//   node serve-static.mjs stop <dir>
//     Reads the tracking file for <dir>, kills the tracked pid BY THAT EXACT PID, and removes the
//     tracking file. A no-op (exit 0) if no tracked server is found for <dir> — this never enumerates
//     processes and never searches by name or port.
//
// SAFETY (the reason start/stop exist): `stop` only ever acts on the pid THIS SAME HELPER recorded in
// `start` for that exact <dir> — never a name/port/netstat search. It never touches any process it
// didn't itself spawn. PID REUSE: if the tracked pid has since exited and the OS reused that number for an
// unrelated process, `stop` does not signal it — before killing, it re-reads that ONE pid's command line
// and requires the tracking-file path (passed to the server as `--track <file>`, unique to this <dir>) as a
// WHOLE argument; otherwise it refuses (nonzero exit, tracking file kept). Mirrors dev-server.mjs in this same scripts/ dir (single-purpose, no deps, tracked-pid
// start/stop, one printed line to act on) — keep the two in sync if either changes.
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF_PATH = fileURLToPath(import.meta.url);
const SELF = path.basename(SELF_PATH);

function usageAndExit() {
  console.error(`Usage:\n  node ${SELF} [dir] [port]\n  node ${SELF} start <dir> [port]\n  node ${SELF} stop <dir>`);
  process.exit(1);
}

// Tracking file lives in the OS temp dir, keyed off the served dir's absolute path — never inside the
// served dir itself, so it's never mistaken for part of the artifact and survives independently of
// whether the dir is later removed. Distinct filename prefix from dev-server.mjs's own tracking files so
// the two helpers never collide when pointed at the same dir.
function trackingFilePath(absDir) {
  const hash = crypto.createHash("sha256").update(absDir).digest("hex").slice(0, 16);
  return path.join(os.tmpdir(), `loom-serve-static-${hash}.json`);
}

function readTracked(absDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(trackingFilePath(absDir), "utf8"));
    if (parsed && typeof parsed.pid === "number" && typeof parsed.port === "number" && parsed.dir === absDir) return parsed;
    return null;
  } catch {
    return null;
  }
}

function writeTrackedAt(trackFile, record) {
  fs.writeFileSync(trackFile, JSON.stringify(record), "utf8");
}

function removeTracked(absDir) {
  try { fs.unlinkSync(trackingFilePath(absDir)); } catch { /* already gone */ }
}

function isAlive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// The command line of a live pid as `{ raw, argv }` (both null when gone/unreadable). `argv` is set only
// when it is an unambiguous argument array (linux /proc, win32's quoted command line); the unquoted POSIX
// `ps` text is `raw` only. Used ONLY to re-check a recorded pid before a kill — never to search for one.
function commandLineOf(pid) {
  const none = { raw: null, argv: null };
  try {
    if (process.platform === "win32") {
      const r = spawnSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: "utf8", timeout: 20000 });
      const raw = (r.stdout || "").trim() || null;
      if (!raw) return none;
      return { raw, argv: splitQuotedArgs(raw) };
    }
    if (process.platform === "linux") {
      try {
        const argv = fs.readFileSync(`/proc/${Number(pid)}/cmdline`).toString("utf8").split("\0").filter((s) => s.length > 0);
        return argv.length ? { raw: argv.join(" "), argv } : none;
      } catch { return none; }
    }
    const r = spawnSync("ps", ["-ww", "-o", "args=", "-p", String(pid)], { encoding: "utf8", timeout: 10000 });
    const raw = (r.stdout || "").trim() || null;
    return raw ? { raw, argv: null } : none;
  } catch {
    return none;
  }
}

// Splits a win32 command line into arguments, honoring double-quoted segments (a quoted path may hold
// spaces). Written as a char loop, not a regex, so the detached-console guard's lexer is not confused.
function splitQuotedArgs(line) {
  const out = [];
  let cur = "";
  let has = false;
  let inQuote = false;
  for (const ch of line) {
    if (ch === '"') { inQuote = !inQuote; has = true; continue; }
    if (!inQuote && (ch === " " || ch === "\t")) {
      if (has) { out.push(cur); cur = ""; has = false; }
      continue;
    }
    cur += ch;
    has = true;
  }
  if (has) out.push(cur);
  return out;
}

const normPath = (s) => {
  let c = s.split("\\").join("/");
  while (c.includes("//")) c = c.split("//").join("/");
  return process.platform === "win32" ? c.toLowerCase() : c;
};

// True iff the live command line carries `marker` as a WHOLE argument — never a substring, so a lookalike
// (`<marker>.bak`, `/elsewhere/<marker>`) does not match. Exact argv token when we have an argv array;
// otherwise a space-bounded match on the raw text; otherwise (unreadable) false.
function commandLineHasToken(info, marker) {
  const want = normPath(marker);
  if (info.argv) return info.argv.some((t) => normPath(t) === want);
  if (!info.raw) return false;
  const raw = normPath(info.raw);
  for (let i = raw.indexOf(want); i !== -1; i = raw.indexOf(want, i + 1)) {
    if ((i === 0 || raw[i - 1] === " ") && (i + want.length === raw.length || raw[i + want.length] === " ")) return true;
  }
  return false;
}

// True iff `pid` is still the server `start` launched for `absDir`: its command line carries this dir's
// tracking-file path as its own argument. Called immediately before any kill.
function isTrackedServer(pid, absDir) {
  return commandLineHasToken(commandLineOf(pid), trackingFilePath(absDir));
}

// Kill exactly `pid` by that exact handle — never a name/port search. `taskkill /T /F` on win32 kills
// the tracked pid's whole subtree; POSIX kills the process group first (start() puts the child in its
// own group via `detached: true`) then the pid itself as a fallback.
function killTracked(pid) {
  if (process.platform === "win32") {
    try { spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" }); } catch { /* best effort */ }
    return;
  }
  try { process.kill(-pid, "SIGKILL"); } catch { /* no such group / already gone */ }
  try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
}

// Foreground serve — unchanged behavior for the plain `node serve-static.mjs [dir] [port]` form. When
// `trackFile` is set (only passed internally by `start`'s spawned child), also records the ACTUAL bound
// pid+port to it once listening, and removes it again on a clean shutdown.
function serve(dirArg, portArg, trackFile) {
  // realpath'd at startup (not just path.resolve'd) so the per-request containment check below compares
  // against the SAME real basis a symlinked-file target resolves onto — a `root` left un-realpath'd
  // could itself sit behind a symlinked path segment and make an otherwise-contained real path look
  // external. The tracking key (`absDir`) stays un-realpath'd so it matches what start()/stop() compute.
  const absDir = path.resolve(dirArg || process.cwd());
  const root = fs.realpathSync(absDir);
  const requestedPort = Number(portArg || 0);
  const TIMEOUT_MS = Number(process.env.LOOM_SERVE_STATIC_TIMEOUT_MS || 30 * 60 * 1000);

  const MIME = {
    ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon",
    ".woff": "font/woff", ".woff2": "font/woff2",
    ".txt": "text/plain; charset=utf-8", ".pdf": "application/pdf",
  };

  const server = http.createServer((req, res) => {
    let reqPath;
    try {
      reqPath = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    } catch {
      res.writeHead(400).end("Bad request");
      return;
    }
    if (reqPath.endsWith("/")) reqPath += "index.html";

    // The WHATWG URL parser collapses UN-encoded ".." segments during parsing (a leading ".." at the
    // root is dropped, never left in `pathname`) — but an ENCODED segment ("%2e%2e%2f") isn't split as a
    // path boundary by the parser, so it survives into `reqPath` after decodeURIComponent and must be
    // caught here, lexically, by resolving + checking containment before ever touching the filesystem.
    const resolved = path.resolve(root, `.${reqPath}`);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    // Lexical containment alone is NOT enough: `resolved` can be a symlink INSIDE root whose target sits
    // OUTSIDE it (e.g. `<dir>/leak.html -> /etc/passwd`), which the check above never sees. Resolve
    // symlinks (async — the handler must stay non-blocking) and re-assert containment against the REAL
    // path before ever reading file contents.
    fs.realpath(resolved, (err, real) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
        return;
      }
      if (real !== root && !real.startsWith(root + path.sep)) {
        res.writeHead(403).end("Forbidden");
        return;
      }
      fs.readFile(real, (err2, data) => {
        if (err2) {
          res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
          return;
        }
        const type = MIME[path.extname(resolved).toLowerCase()] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": type }).end(data);
      });
    });
  });

  server.listen(requestedPort, "127.0.0.1", () => {
    const addr = server.address();
    console.log(`Serving ${root} at http://127.0.0.1:${addr.port}/`);
    if (trackFile) {
      writeTrackedAt(trackFile, { pid: process.pid, port: addr.port, dir: absDir, startedAt: new Date().toISOString() });
    }
  });

  const shutdown = () => {
    if (trackFile) { try { fs.unlinkSync(trackFile); } catch { /* already gone */ } }
    server.close(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  if (TIMEOUT_MS > 0) setTimeout(shutdown, TIMEOUT_MS).unref();
}

async function start(dirArg, portArg) {
  if (!dirArg) usageAndExit();
  const absDir = path.resolve(dirArg);
  if (!fs.existsSync(absDir) || !fs.statSync(absDir).isDirectory()) {
    console.error(`start: not a directory: ${absDir}`);
    process.exit(1);
  }

  const existing = readTracked(absDir);
  if (existing && isAlive(existing.pid)) {
    console.error(`start: a static server is already tracked for ${absDir} (pid ${existing.pid}). Stop it first: node ${SELF} stop ${dirArg}`);
    process.exit(1);
  }
  removeTracked(absDir);

  const trackFile = trackingFilePath(absDir);
  const port = String(portArg || 0);
  const child = spawn(process.execPath, [SELF_PATH, absDir, port, "--track", trackFile], {
    // detached: own process group on POSIX (so killTracked's group-kill reaches it), and lets the child
    // outlive this launcher process either way. stdio fully ignored — never a pipe left dangling once
    // this launcher exits.
    detached: true,
    // detached:true alone opens a new visible console window on Windows; windowsHide:true hides
    // only that window (no-op on POSIX).
    windowsHide: true,
    stdio: "ignore",
  });
  if (!child.pid) {
    console.error("start: failed to spawn (no pid)");
    process.exit(1);
  }
  child.unref();

  // The child knows the ACTUAL bound port (0 means OS-assigned); wait for it to write that back to
  // trackFile rather than guessing. Bounded so a broken child fails fast instead of hanging forever.
  // Ceiling stays 5000ms (do not widen — a previous remedy for a sibling site was a
  // widen that only held 12 days). The one real intermediate signal available here is the CHILD'S OWN
  // LIVENESS: this launcher holds child.pid directly, so a crash before trackFile is written is an
  // immediate, genuine terminal signal — distinct from "still starting, just slow under host load" —
  // and there's no reason to burn the rest of the ceiling waiting on a process that's already gone.
  const waitStartedAt = Date.now();
  const deadline = waitStartedAt + 5000;
  let record = null;
  let childDied = false;
  while (Date.now() < deadline) {
    try {
      const parsed = JSON.parse(fs.readFileSync(trackFile, "utf8"));
      if (parsed && typeof parsed.pid === "number" && typeof parsed.port === "number") { record = parsed; break; }
    } catch { /* not written yet */ }
    if (!isAlive(child.pid)) { childDied = true; break; }
    await new Promise((r) => setTimeout(r, 50));
  }
  if (!record) {
    const waitedMs = Date.now() - waitStartedAt;
    if (childDied) {
      console.error(`start: child pid ${child.pid} exited before writing ${trackFile} (waited ${waitedMs}ms) for ${absDir}`);
    } else {
      console.error(`start: server did not come up within ${waitedMs}ms — still waiting on ${trackFile} from pid ${child.pid} for ${absDir}`);
    }
    // Only a child that is still alive AND still carries our marker is ours to kill: a child that already
    // exited may have had its pid reused.
    if (!childDied && isTrackedServer(child.pid, absDir)) { try { killTracked(child.pid); } catch { /* best effort */ } }
    process.exit(1);
  }
  console.log(`Serving ${absDir} at http://127.0.0.1:${record.port}/ (pid ${record.pid})`);
  console.log(`Stop with: node ${SELF} stop ${dirArg}`);
}

function stop(dirArg) {
  if (!dirArg) usageAndExit();
  const absDir = path.resolve(dirArg);
  const tracked = readTracked(absDir);
  if (!tracked) {
    console.log(`stop: no tracked static server for ${absDir} (nothing to do)`);
    return;
  }
  if (isAlive(tracked.pid)) {
    // Re-verify identity right before the kill: the OS may have reused this pid for an unrelated process
    // since `start`. Refuse and leave the tracking file so nothing else is touched.
    if (!isTrackedServer(tracked.pid, absDir)) {
      console.error(`stop: REFUSED — pid ${tracked.pid} is alive but its command line is not the static server this helper launched for ${absDir} (the pid was likely reused by an unrelated process, or its command line could not be read). Nothing was killed. Remove the stale tracking file ${trackingFilePath(absDir)} once you have confirmed the server is gone.`);
      process.exit(1);
    }
    killTracked(tracked.pid);
  }
  removeTracked(absDir);
  console.log(`Stopped pid ${tracked.pid} tracked for ${absDir}`);
}

const [, , a2, a3, a4, a5] = process.argv;
if (a2 === "start") {
  await start(a3, a4);
} else if (a2 === "stop") {
  stop(a3);
} else {
  serve(a2, a3, a4 === "--track" ? a5 : null);
}
