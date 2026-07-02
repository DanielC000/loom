#!/usr/bin/env node
// Serve a static directory over LOOPBACK so a Playwright-driven agent can eyeball an on-disk HTML
// artifact via http:// — Playwright's browser_navigate blocks file:// outright, and hand-rolling
// `python -m http.server` (or similar) every render cycle is wasted ceremony. Dependency-free: only
// node:http/node:fs/node:path, so it runs anywhere Node runs, no install step.
//
// Usage: node serve-static.mjs [dir] [port]
//   dir   - directory to serve (default: cwd)
//   port  - port to bind (default: 0 = OS picks a free port)
//
// Prints exactly one line once listening:
//   Serving <dir> at http://127.0.0.1:<port>/
// Open that URL in Playwright instead of a file:// path. The server keeps running until you stop it
// (Ctrl-C / SIGTERM) or LOOM_SERVE_STATIC_TIMEOUT_MS elapses (default 30 minutes) — a bounded safety
// net so a forgotten background server never lingers on a loopback port indefinitely.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

// realpath'd at startup (not just path.resolve'd) so the per-request containment check below compares
// against the SAME real basis a symlinked-file target resolves onto — a `root` left un-realpath'd could
// itself sit behind a symlinked path segment and make an otherwise-contained real path look external.
const root = fs.realpathSync(path.resolve(process.argv[2] || process.cwd()));
const requestedPort = Number(process.argv[3] || 0);
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
});

const shutdown = () => server.close(() => process.exit(0));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
if (TIMEOUT_MS > 0) setTimeout(shutdown, TIMEOUT_MS).unref();
