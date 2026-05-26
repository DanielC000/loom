// Loom de-risking spike daemon.
// claude -> node-pty -> ws -> xterm, + SessionStart hook capture, stop/resume, late-attach.
// Plain ESM, no build step. See README.md.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { WebSocketServer } from "ws";

const require = createRequire(import.meta.url);
const pty = require("node-pty");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = 7878;
const RING_CAP_BYTES = 256 * 1024;

// --- Windows gotcha: node-pty's agent does NOT search %PATH%; pass an absolute path. ---
const CLAUDE_BIN = "C:\\Users\\danie\\.local\\bin\\claude.exe";

// Per-session working dir (Claude keys sessions to this dir; resume MUST reuse it).
const SANDBOX = path.join(__dirname, "sandbox");
const TMP = path.join(__dirname, "tmp");
const LOGS = path.join(__dirname, "logs");
for (const d of [SANDBOX, TMP, LOGS]) fs.mkdirSync(d, { recursive: true });
if (!fs.existsSync(path.join(SANDBOX, "README.md")))
  fs.writeFileSync(path.join(SANDBOX, "README.md"), "# Spike sandbox\nScratch project dir for the Loom spike.\n");

const RELAY = path.join(__dirname, "relay.mjs");

/** @type {Map<string, Session>} */
const sessions = new Map();

function log(...a) { console.log(new Date().toISOString().slice(11, 23), ...a); }

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------
function buildEnv(altScreen) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "CLAUDECODE" || k.startsWith("CLAUDE_CODE_")) continue;
    if (v !== undefined) env[k] = v;
  }
  // Demo #3 toggle. Default (altScreen falsy): set DISABLE=1 -> output stays on the main
  // screen so xterm scrollback works (the Loom-desired default). Pass altScreen:true to leave
  // the var unset and get default alt-screen behavior, for the A/B comparison.
  if (!altScreen) env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN = "1";
  return env;
}

function writeSettings(loomId) {
  const cmd = { hooks: [{ type: "command", command: `node "${RELAY}" ${loomId} ${PORT}` }] };
  const settings = {
    hooks: { SessionStart: [cmd], Stop: [cmd], StopFailure: [cmd] },
    // §9 permission policy: acceptEdits + a warmup/read allowlist. Avoids the
    // --dangerously-skip-permissions "Bypass Permissions mode" acceptance gate entirely.
    permissions: {
      defaultMode: "acceptEdits",
      allow: [
        "Bash(obsidian:*)", "Bash(git status:*)", "Bash(git log:*)",
        "Bash(git diff:*)", "Bash(ls:*)", "Bash(cat:*)",
        // for the orphan-under-tool test:
        "Bash(sleep:*)", "Bash(ping:*)", "Bash(timeout:*)",
      ],
    },
  };
  const p = path.join(TMP, `settings-${loomId}.json`);
  fs.writeFileSync(p, JSON.stringify(settings, null, 2));
  return p;
}

/**
 * @param {{prompt?:string, altScreen?:boolean, resumeId?:string, cwd?:string, label?:string}} opts
 */
function spawnSession(opts = {}) {
  const loomId = randomUUID().slice(0, 8);
  const cwd = opts.cwd || SANDBOX;
  const settingsPath = writeSettings(loomId);

  const args = [];
  if (opts.resumeId) args.push("--resume", opts.resumeId);
  if (opts.prompt) args.push(opts.prompt); // positional MUST precede any variadic flag
  args.push("--settings", settingsPath);
  args.push("--permission-mode", "acceptEdits"); // §9: no bypass-acceptance gate
  // --strict-mcp-config WITH an explicit --mcp-config stops claude from *discovering*
  // project .mcp.json (the docker/sentry enable prompt) — so startup is unattended (§6).
  // Loom's real config injects the task MCP server here; the spike uses an empty set.
  args.push("--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}');

  const env = buildEnv(opts.altScreen);
  log(`spawn ${loomId} bin=${CLAUDE_BIN} resume=${opts.resumeId || "none"} altScreenDisabled=${opts.altScreen === false} cwd=${cwd}`);
  const proc = pty.spawn(CLAUDE_BIN, args, {
    name: "xterm-256color",
    cols: 120,
    rows: 40, // FIXED geometry, never resized (Q6 decoupling)
    cwd,
    env,
  });

  const logStream = fs.createWriteStream(path.join(LOGS, `${loomId}.log`));
  /** @type {Session} */
  const s = {
    loomId, pty: proc, pid: proc.pid, cwd, settingsPath,
    claudeSessionId: opts.resumeId || null,
    resumedFrom: opts.resumeFrom || null,
    ring: { chunks: [], bytes: 0 },
    subscribers: new Set(),
    alive: true, exit: null, hooks: [], logStream,
    createdAt: Date.now(),
  };
  sessions.set(loomId, s);

  proc.onData((d) => {
    const buf = Buffer.from(d, "utf-8");
    appendRing(s, buf);
    logStream.write(buf);
    for (const ws of s.subscribers) { try { if (ws.readyState === 1) ws.send(buf); } catch {} }
  });
  proc.onExit(({ exitCode, signal }) => {
    s.alive = false;
    s.exit = { code: exitCode, signal: signal ?? null, at: Date.now() };
    log(`exit ${loomId} code=${exitCode} signal=${signal ?? "-"}`);
    broadcastControl(s, { type: "exit", code: exitCode, signal: signal ?? null });
    try { logStream.end(); } catch {}
  });

  return s;
}

function appendRing(s, buf) {
  s.ring.chunks.push(buf);
  s.ring.bytes += buf.length;
  while (s.ring.bytes > RING_CAP_BYTES && s.ring.chunks.length > 1) {
    s.ring.bytes -= s.ring.chunks.shift().length;
  }
}
function scrollback(s) { return Buffer.concat(s.ring.chunks); }
function broadcastControl(s, obj) {
  const msg = JSON.stringify(obj);
  for (const ws of s.subscribers) { try { if (ws.readyState === 1) ws.send(msg); } catch {} }
}

// ---------------------------------------------------------------------------
// Stop mechanisms (demo #5)
// ---------------------------------------------------------------------------
function stopSession(s, mode) {
  if (!s.alive) return { ok: false, why: "already exited" };
  if (mode === "hard") {
    log(`HARD stop ${s.loomId} (pty.kill -> TerminateProcess on Windows)`);
    try { s.pty.kill(); } catch (e) { return { ok: false, why: String(e) }; }
    return { ok: true, mode };
  }
  if (mode === "exitcmd") {
    log(`GRACEFUL(/exit) ${s.loomId}`);
    s.pty.write("/exit\r");
    return { ok: true, mode };
  }
  // default graceful: double Ctrl-C
  log(`GRACEFUL(ctrl-c x2) ${s.loomId}`);
  s.pty.write("\x03");
  setTimeout(() => { if (s.alive) s.pty.write("\x03"); }, 600);
  return { ok: true, mode: "graceful" };
}

// ---------------------------------------------------------------------------
// Orphan / process-tree inspection (read-only powershell)
// ---------------------------------------------------------------------------
function getProcessTree(rootPid) {
  return new Promise((resolve) => {
    execFile("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command",
        "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json -Compress"],
      { maxBuffer: 16 * 1024 * 1024 },
      (err, stdout) => {
        if (err) return resolve({ error: String(err), descendants: [] });
        let all;
        try { all = JSON.parse(stdout); } catch (e) { return resolve({ error: "parse", descendants: [] }); }
        if (!Array.isArray(all)) all = [all];
        const byParent = new Map();
        for (const p of all) {
          const arr = byParent.get(p.ParentProcessId) || [];
          arr.push(p); byParent.set(p.ParentProcessId, arr);
        }
        const out = []; const seen = new Set(); const queue = [rootPid];
        while (queue.length) {
          const pid = queue.shift();
          for (const c of (byParent.get(pid) || [])) {
            if (seen.has(c.ProcessId)) continue;
            seen.add(c.ProcessId); out.push(c); queue.push(c.ProcessId);
          }
        }
        const rootAlive = all.some((p) => p.ProcessId === rootPid);
        resolve({ rootPid, rootAlive, descendants: out });
      });
  });
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}
function sendFile(res, file, type) {
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end("not found"); return; }
    res.writeHead(200, { "content-type": type });
    res.end(data);
  });
}
async function readBody(req) {
  let raw = ""; for await (const c of req) raw += c;
  try { return raw ? JSON.parse(raw) : {}; } catch { return {}; }
}
function sessionView(s) {
  return {
    loomId: s.loomId, pid: s.pid, cwd: s.cwd, alive: s.alive, exit: s.exit,
    claudeSessionId: s.claudeSessionId, resumedFrom: s.resumedFrom,
    ringBytes: s.ring.bytes, subscribers: s.subscribers.size,
    hooks: s.hooks.map((h) => ({ event: h.hook_event_name, session_id: h.session_id, at: h._at })),
  };
}

const VENDOR = {
  "/vendor/xterm.js": [path.join(__dirname, "node_modules/@xterm/xterm/lib/xterm.js"), "text/javascript"],
  "/vendor/xterm.css": [path.join(__dirname, "node_modules/@xterm/xterm/css/xterm.css"), "text/css"],
  "/vendor/addon-fit.js": [path.join(__dirname, "node_modules/@xterm/addon-fit/lib/addon-fit.js"), "text/javascript"],
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const p = url.pathname;
  const loopback = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);

  if (req.method === "GET" && (p === "/" || p === "/index.html"))
    return sendFile(res, path.join(__dirname, "public/index.html"), "text/html");
  if (req.method === "GET" && VENDOR[p]) return sendFile(res, ...VENDOR[p]);

  // Hook relay target (loopback only).
  if (req.method === "POST" && p === "/hook") {
    if (!loopback) { res.writeHead(403); return res.end("forbidden"); }
    const body = await readBody(req);
    const s = sessions.get(body.loomId);
    const hook = body.hook || {};
    if (s) {
      hook._at = Date.now(); s.hooks.push(hook);
      if (hook.hook_event_name === "SessionStart" && typeof hook.session_id === "string") {
        const isNew = !s.claudeSessionId;
        s.claudeSessionId = hook.session_id;
        if (isNew) log(`CAPTURED ${s.loomId} -> claudeSessionId=${hook.session_id} (source=${hook.source ?? "?"})`);
        broadcastControl(s, { type: "sessionId", id: hook.session_id });
      } else {
        log(`hook ${s.loomId} ${hook.hook_event_name} session_id=${hook.session_id ?? "-"}`);
      }
    }
    return sendJson(res, 200, { ok: true });
  }

  if (req.method === "POST" && p === "/api/spawn") {
    const b = await readBody(req);
    const s = spawnSession({ prompt: b.prompt, altScreen: b.altScreen });
    return sendJson(res, 200, sessionView(s));
  }
  if (req.method === "POST" && p === "/api/input") {
    const b = await readBody(req); const s = sessions.get(b.loomId);
    if (!s || !s.alive) return sendJson(res, 400, { ok: false, why: "no live session" });
    s.pty.write(b.data ?? ""); return sendJson(res, 200, { ok: true });
  }
  if (req.method === "POST" && p === "/api/stop") {
    const b = await readBody(req); const s = sessions.get(b.loomId);
    if (!s) return sendJson(res, 404, { ok: false });
    const before = await getProcessTree(s.pid);
    const r = stopSession(s, b.mode);
    return sendJson(res, 200, { ...r, childrenBeforeStop: before });
  }
  if (req.method === "POST" && p === "/api/resume") {
    const b = await readBody(req); const s = sessions.get(b.loomId);
    if (!s || !s.claudeSessionId) return sendJson(res, 400, { ok: false, why: "no claudeSessionId" });
    const ns = spawnSession({ resumeId: s.claudeSessionId, cwd: s.cwd, resumeFrom: s.loomId });
    return sendJson(res, 200, sessionView(ns));
  }
  if (req.method === "GET" && p === "/api/state") {
    const s = sessions.get(url.searchParams.get("loomId"));
    if (!s) return sendJson(res, 404, { ok: false });
    return sendJson(res, 200, sessionView(s));
  }
  if (req.method === "GET" && p === "/api/orphans") {
    const pid = Number(url.searchParams.get("pid"));
    return sendJson(res, 200, await getProcessTree(pid));
  }
  if (req.method === "GET" && p === "/api/sessions")
    return sendJson(res, 200, [...sessions.values()].map(sessionView));

  res.writeHead(404); res.end("not found");
});

// ---------------------------------------------------------------------------
// WebSocket terminal: /ws/term/:loomId  (attach/detach, replay, bidirectional)
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });
server.on("upgrade", (req, socket, head) => {
  const m = (req.url || "").split("?")[0].match(/^\/ws\/term\/([^/]+)$/);
  if (!m) { socket.destroy(); return; }
  const loomId = decodeURIComponent(m[1]);
  const s = sessions.get(loomId);
  if (!s) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    log(`attach ${loomId} (subscribers ${s.subscribers.size} -> ${s.subscribers.size + 1})`);
    s.subscribers.add(ws);
    // Replay ring buffer so a LATE attach sees a coherent screen (demo #6).
    const sb = scrollback(s);
    if (sb.length) ws.send(sb);
    if (s.claudeSessionId) ws.send(JSON.stringify({ type: "sessionId", id: s.claudeSessionId }));
    if (!s.alive) ws.send(JSON.stringify({ type: "exit", code: s.exit?.code ?? null }));
    ws.on("message", (raw) => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg?.type === "stdin" && typeof msg.data === "string" && s.alive) s.pty.write(msg.data);
      else if (msg?.type === "repaint" && s.alive) s.pty.write("\x0c"); // Ctrl-L repaint mitigation
    });
    ws.on("close", () => {
      s.subscribers.delete(ws);
      log(`detach ${loomId} (subscribers now ${s.subscribers.size}; pty stays alive=${s.alive})`);
    });
  });
});

server.listen(PORT, "127.0.0.1", () => {
  log(`Loom spike daemon on http://127.0.0.1:${PORT}`);
  log(`claude bin: ${CLAUDE_BIN}`);
  log(`sandbox cwd: ${SANDBOX}`);
});
