import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Critical-class availability fix (board card 4c5f37d5): EVERY `/ws/*` JSON message handler must survive
// a malformed inbound frame. `JSON.parse` happily returns a non-throwing, non-object value for a frame
// like "null" (→ null), "42" (→ a number), "\"x\"" (→ a string), or "[]" (→ an array) — none of those
// have the field a handler is about to read (msg.type on /ws/term + /ws/companion), so dereferencing one
// without a type-guard throws an uncaught TypeError in a ws 'message' listener. That throw propagates
// past the socket's own 'error' handler straight to `process`, and crashlog's uncaughtException handler
// exits the whole daemon (exit 1, NOT the supervisor's restart sentinel 75 → the fleet STAYS DOWN) — a
// ~4-byte-frame DoS reachable by any Tier-1 client or loopback process.
//
// /ws/fleet already carried an inline guard (C2); this card retrofits it plus /ws/term and /ws/companion
// onto ONE shared helper, `parseWsJsonObject` (gateway/server.ts). This test covers the two routes that
// were UNGUARDED on main — /ws/term and /ws/companion — proving for each:
//   1. A raw non-object frame ("null", a bare number, a bare string, "[]") does NOT crash the handler —
//      the socket stays OPEN and the server process survives.
//   2. A subsequent VALID frame on the SAME socket still works — proves the handler (not just the
//      process) is still alive and functioning, not merely that nothing threw.
// HERMETIC + CLAUDE-FREE + NETWORK-FREE (Db + buildServer via @fastify/websocket's injectWS, like
// ws-fleet.mjs / trust-tier.mjs's own WS coverage) — the loopback path needs no gateway token.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "loom-ws-json-hardening-"));
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45345"; // distinct from trust-tier.mjs's 45342 and ws-fleet.mjs's 45343
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Poll `cond` until it's true or `timeoutMs` elapses.
async function waitFor(cond, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

const db = new Db(path.join(TMP, "loom.db"));

// Minimal stubs — record calls so a "did the valid frame actually get handled" assertion doesn't just
// rest on "didn't throw".
const ptyCalls = { stdin: [], repaint: [], resize: [] };
const pty = {
  subscribe: () => () => {}, // returns an unsub fn; onData/onControl never fire in this test (no real pty)
  writeStdin: (sessionId, data) => ptyCalls.stdin.push({ sessionId, data }),
  repaint: (sessionId) => ptyCalls.repaint.push(sessionId),
  resize: (sessionId, cols, rows) => ptyCalls.resize.push({ sessionId, cols, rows }),
};
const chatCalls = [];
const companion = {
  handleInAppInbound: async (sessionId, text) => { chatCalls.push({ sessionId, text }); },
};

const app = await buildServer({
  db, pty, sessions: {}, mcp: {}, orchMcp: {}, platformMcp: {}, auditMcp: {}, userAuditMcp: {},
  setupMcp: {}, runMcp: {}, control: {}, usageStatus: {}, requestShutdown: () => {},
  companion,
});

try {
  await app.ready();

  const MALFORMED = [["bare 'null'", "null"], ["bare number", "42"], ["bare string", "\"x\""], ["bare array", "[]"]];

  // --- /ws/term ---------------------------------------------------------------------------------------
  {
    const ws = await app.injectWS("/ws/term/sess-term", { headers: { host: "127.0.0.1" } });
    for (const [label, raw] of MALFORMED) {
      ws.send(raw);
      await new Promise((r) => setTimeout(r, 50));
      check(`(term) a raw ${label} frame does not crash the handler (socket stays open)`, ws.readyState === ws.OPEN);
    }
    ws.send(JSON.stringify({ type: "stdin", data: "echo hi\n" }));
    check("(term) a valid frame after the malformed ones is still handled (writeStdin called)",
      await waitFor(() => ptyCalls.stdin.some((c) => c.sessionId === "sess-term" && c.data === "echo hi\n")));
    ws.terminate();
  }

  // --- /ws/companion ------------------------------------------------------------------------------------
  {
    const ws = await app.injectWS("/ws/companion/sess-companion", { headers: { host: "127.0.0.1" } });
    for (const [label, raw] of MALFORMED) {
      ws.send(raw);
      await new Promise((r) => setTimeout(r, 50));
      check(`(companion) a raw ${label} frame does not crash the handler (socket stays open)`, ws.readyState === ws.OPEN);
    }
    ws.send(JSON.stringify({ type: "chat", text: "hello" }));
    check("(companion) a valid frame after the malformed ones is still handled (handleInAppInbound called)",
      await waitFor(() => chatCalls.some((c) => c.sessionId === "sess-companion" && c.text === "hello")));
    ws.terminate();
  }

  // --- process-level survival: the daemon itself is still up + serving other requests after all of the
  // above malformed frames on both routes -----------------------------------------------------------------
  const stillUp = await app.inject({ method: "GET", url: "/api/version", headers: { host: "127.0.0.1" } });
  check("(process) the daemon is still serving requests after every malformed frame on both routes", stillUp.statusCode === 200);
} finally {
  await app.close();
  db.close();
  for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — /ws/term and /ws/companion survive malformed (null/number/string/array) JSON frames; a valid frame on the same socket afterward is still handled; the daemon process stays up."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
