import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card d5e3fa82: `@fastify/websocket` used to be registered with NO `maxPayload`, so every `/ws/*` route
// (term/fleet/companion) shared ws's library default of 104,857,600 bytes (~100 MiB) — and `/ws/fleet`
// accepts a connection with NO credential at all on loopback, so any co-resident process could force the
// daemon to buffer up to ~100 MiB per connection before ws even inspects the bytes (memory/event-loop
// DoS). Fixed by passing `WS_MAX_PAYLOAD_BYTES` (gateway/server.ts) into the single
// `app.register(websocket, { options: {...} })` call, which every route's socket shares.
//
// This test proves, against the real `/ws/fleet` route (chosen because it needs no pty stub and no
// credential, keeping the fixture minimal — maxPayload is a daemon-wide `ws.Server` option, not a
// per-route one, so this exercises the SAME enforcement every other `/ws/*` route gets):
//   1. A frame comfortably UNDER the cap is processed normally (proves the cap isn't so tight it breaks
//      real traffic — the DoD's "generous headroom" requirement).
//   2. A frame OVER the cap is rejected with a clean `1009` ("Message Too Big") close — not a crash — and
//      the oversized frame's content never reaches application state (the hub's subscription map).
//   3. The daemon process survives the oversized frame and keeps serving OTHER connections afterward.
// HERMETIC + CLAUDE-FREE + NETWORK-FREE (Db + buildServer via @fastify/websocket's injectWS, like
// ws-fleet.mjs).
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

const TMP = mkdtempManaged("loom-ws-max-payload-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(hermeticPort());
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer, WS_MAX_PAYLOAD_BYTES } = await import("../dist/gateway/server.js");
const { FleetHub } = await import("../dist/gateway/fleet-hub.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

async function waitFor(cond, timeoutMs = 2000) {
  try {
    return await sharedWaitUntil(cond, { timeoutMs, intervalMs: 20, label: "ws-max-payload: cond" });
  } catch (err) {
    if (err?.exhaustedOnThrow !== false) throw err;
    return cond();
  }
}

// A sub:events frame whose total serialized size is `targetBytes`, padding via managerId (an arbitrary
// string field the route already accepts — see server.ts's /ws/fleet handler).
function frameOfSize(targetBytes) {
  const skeleton = JSON.stringify({ t: "sub:events", managerId: "", sinceSeq: 0 });
  const padLen = Math.max(0, targetBytes - skeleton.length);
  return JSON.stringify({ t: "sub:events", managerId: "x".repeat(padLen), sinceSeq: 0 });
}

const db = new Db(path.join(TMP, "loom.db"));
const fleetHub = new FleetHub();

let serverSocket;
const originalAdd = fleetHub.add.bind(fleetHub);
fleetHub.add = (socket) => { serverSocket = socket; originalAdd(socket); };

const app = await buildServer({
  db, pty: {}, sessions: {}, mcp: {}, orchMcp: {}, platformMcp: {}, auditMcp: {}, userAuditMcp: {},
  setupMcp: {}, runMcp: {}, control: {}, usageStatus: {}, requestShutdown: () => {},
  fleetHub,
});

// Captures messages AND the close event, wired via injectWS's `onInit` hook (synchronous, before the
// handshake) — see project memory "injectws-first-frame-needs-oninit": a post-resolve `.on("message", ...)`
// misses a frame sent in the same synchronous flush as `open`.
function makeRecorder() {
  const messages = [];
  let closeInfo = null;
  const onInit = (ws) => {
    ws.on("message", (data) => { try { messages.push(JSON.parse(data.toString())); } catch { /* ignore non-JSON */ } });
    ws.on("close", (code, reason) => { closeInfo = { code, reason: reason?.toString() ?? "" }; });
  };
  return { onInit, messages, getClose: () => closeInfo };
}

try {
  await app.ready();

  check("(0) WS_MAX_PAYLOAD_BYTES is well under ws's ~100 MiB library default",
    WS_MAX_PAYLOAD_BYTES > 0 && WS_MAX_PAYLOAD_BYTES < 100 * 1024 * 1024);

  // --- (1) UNDER-cap frame: processed normally, socket stays open --------------------------------------
  const rec1 = makeRecorder();
  const ws1 = await app.injectWS("/ws/fleet", { headers: { host: "127.0.0.1" } }, { onInit: rec1.onInit });
  await waitFor(() => rec1.messages.some((m) => m.t === "hello"));

  const underCapFrame = frameOfSize(WS_MAX_PAYLOAD_BYTES - 1024);
  check("(1) the under-cap frame built is actually under the cap", Buffer.byteLength(underCapFrame) < WS_MAX_PAYLOAD_BYTES);
  ws1.send(underCapFrame);
  await waitFor(() => fleetHub.subscriptionsFor(serverSocket)?.size === 1);
  check("(1) a frame comfortably under the cap is processed (subscription recorded)",
    fleetHub.subscriptionsFor(serverSocket)?.size === 1);
  check("(1) the socket stays open after an under-cap frame", ws1.readyState === ws1.OPEN);
  ws1.terminate();

  // --- (2) OVER-cap frame: rejected with a clean 1009 close, never reaches the hub ----------------------
  const rec2 = makeRecorder();
  const ws2 = await app.injectWS("/ws/fleet", { headers: { host: "127.0.0.1" } }, { onInit: rec2.onInit });
  await waitFor(() => rec2.messages.some((m) => m.t === "hello"));
  check("(2) a second connection registers on the hub", fleetHub.size === 1);

  const overCapFrame = frameOfSize(WS_MAX_PAYLOAD_BYTES + 1024);
  check("(2) the over-cap frame built actually exceeds the cap", Buffer.byteLength(overCapFrame) > WS_MAX_PAYLOAD_BYTES);
  ws2.send(overCapFrame);
  await waitFor(() => rec2.getClose() !== null, 5000);
  const close2 = rec2.getClose();
  check("(2) an over-cap frame is rejected with a clean close (not left hanging / not a crash)", close2 !== null);
  check("(2) the close code is 1009 (Message Too Big)", close2?.code === 1009);
  check("(2) the over-cap frame's payload never reached the hub (no subscription recorded)",
    (fleetHub.subscriptionsFor(serverSocket)?.size ?? 0) === 0);
  // NOTE: not asserting `fleetHub.size === 0` here — a server-INITIATED close (this path) doesn't complete
  // its handshake on @fastify/websocket's synthetic in-memory duplex transport, the same harness
  // limitation ws-fleet.mjs documents for a client-initiated graceful close; a real socket's close
  // handshake (and the resulting `fleetHub.remove`) completes fine, this is a test-transport gap, not a
  // route bug. Already proven above: the client observes a clean 1009 close and the payload never reached
  // application state.
  ws2.terminate();

  // --- (3) the daemon survives and keeps serving other connections afterward ---------------------------
  const rec3 = makeRecorder();
  const ws3 = await app.injectWS("/ws/fleet", { headers: { host: "127.0.0.1" } }, { onInit: rec3.onInit });
  await waitFor(() => rec3.messages.some((m) => m.t === "hello"));
  check("(3) a fresh connection after the oversized frame still gets a hello (daemon did not crash)",
    rec3.messages.some((m) => JSON.stringify(m) === JSON.stringify({ t: "hello", v: 1 })));
  const plainResp = await app.inject({ method: "GET", url: "/api/version", headers: { host: "127.0.0.1" } });
  check("(3) a plain REST request still succeeds afterward", plainResp.statusCode === 200);
  ws3.terminate();
} finally {
  await app.close();
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — /ws/fleet (and every other /ws/* route sharing the same ws.Server) accepts a frame under WS_MAX_PAYLOAD_BYTES and cleanly rejects (close 1009, no crash) one over it."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
