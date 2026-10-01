import "./_guard.mjs";
// Code Review fix round, card 3c205fb5 (reviewed tip 13764a04) — see
// docs/decisions/3c205fb5-gateway-token-revoke-closes-open-sockets.md's "Fix round" section.
//
// `GatewayTokenSocketRegistry.closeAll` used to call ONLY `socket.close(code, reason)`. In ws 8.21 that
// moves the socket to CLOSING and waits up to its own `closeTimeout` (~30s) for the PEER's close frame —
// it does NOT stop reading. ws's `Receiver` keeps emitting `'message'` while CLOSING (no `readyState`
// check anywhere in `websocket.js`'s `receiverOnMessage`), and none of `/ws/term`, `/ws/fleet`,
// `/ws/companion` check `readyState` before acting on an inbound frame. So a leaked-token client that
// simply IGNORES the close frame could keep sending frames as owner-attested input for up to 30s after
// its token was revoked/paused/rotated/deleted.
//
// This is REAL NETWORK (a real `app.listen()`, a hand-rolled raw TCP client) rather than `injectWS`'s
// synthetic in-memory duplex: the bug lives in ws's own Receiver/socket-lifecycle behavior, which only a
// real socket exercises faithfully. The raw client performs its OWN WS handshake and encodes its OWN
// masked frames — it never uses the `ws` package's client, which would auto-ack a server close frame and
// mask the exact non-cooperation under test.
//
// Classification: a real loopback TCP peer (127.0.0.1) is normally the "loopback" trust class, which
// bypasses gateway-token auth entirely (gateway/trust-tier.ts). An `X-Forwarded-For` header on the
// handshake downgrades that to the "forwarded" REMOTE class (deliberately, per card 4cbbc343: presence of
// a proxy-shaped header can only LOWER trust) without standing up a second real listener — the simplest
// real way to reach the gateway-token-gated code these routes actually run in production.
//
// NEGATIVE-ASSERTION DISCIPLINE: "the post-revoke frame was NOT processed" is never checked on a blind
// sleep (see fixed-wait-negative-guard.mjs's whole reason for existing). Each case sends the frame under
// test, then an immediately-following, distinctly-tagged WITNESS frame, and waits (bounded) for the
// witness's own observable effect. A single socket's frames are handled in the order they were written
// (one 'message' handler, one event loop), so the witness being observed PROVES the frame under test was
// already processed too, if it was ever going to be — the same ORDER-as-witness technique
// remote-trusted-proxy-real.mjs's stdin-drop case uses. If the witness never shows up inside the bound,
// that is read as "the connection died before either frame could be read" — checked against the raw
// socket's own observed death, never asserted from the timeout alone.
import fs from "node:fs";
import net from "node:net";
import crypto from "node:crypto";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";

const TMP = mkdtempManaged("loom-gwtoken-ignore-close-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "0";
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { GatewayTokenSocketRegistry } = await import("../dist/gateway/token-sockets.js");
const { FleetHub } = await import("../dist/gateway/fleet-hub.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const companionInbound = [];
const companionStub = {
  handleInAppInbound: async (sessionId, text) => { companionInbound.push({ sessionId, text }); },
};
const ptyStub = {
  subscribe: () => () => {}, writeStdin: () => {}, repaint: () => {}, resize: () => {}, listShells: () => [],
};
const fleetHub = new FleetHub();
const fleetServerSockets = [];
const originalFleetAdd = fleetHub.add.bind(fleetHub);
fleetHub.add = (socket) => { fleetServerSockets.push(socket); originalFleetAdd(socket); };

const db = new Db(path.join(TMP, "loom.db"));
// A non-loopback `bindHost` arms `isTrustTierHookActive` (trust-tier.ts), which is what lets a
// `forwarded`-class request (the X-Forwarded-For downgrade above) actually reach the gateway-token
// check instead of being refused outright by the "remote class with no trust wall" fail-closed guard.
db.setPlatformConfig({ remoteAccess: { enabled: true, bindHost: "loom-ignore-close-test.example.com" } });
const registry = new GatewayTokenSocketRegistry();
const stub = {};
const app = await buildServer({
  db, pty: ptyStub, sessions: { killAllWorkers: () => 0 }, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
  userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, requestShutdown: () => {},
  companion: companionStub,
  verifyGatewayToken: (t) => db.authenticateGatewayToken(t).ok,
  identifyGatewayToken: (t) => { const r = db.authenticateGatewayToken(t); return r.ok ? r.token.id : undefined; },
  gatewayTokenSockets: registry,
  fleetHub,
});
await app.listen({ port: 0, host: "127.0.0.1" });
const port = app.server.address().port;

// ===== raw WS client: manual handshake, manual masked-frame encoding — NEVER the `ws` package's client =====
// (which would auto-ack a received close frame and so couldn't exercise a client that ignores it).
function encodeMaskedTextFrame(str) {
  const payload = Buffer.from(str, "utf8");
  const len = payload.length;
  if (len >= 126) throw new Error("test payload too large for the 7-bit length fast path");
  const header = Buffer.from([0x81, 0x80 | len]); // FIN+text opcode; mask bit set + 7-bit length
  const mask = crypto.randomBytes(4);
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

// Connects a raw TCP socket and performs the WS upgrade by hand; resolves once the 101 response's header
// block is fully read. `X-Forwarded-For` downgrades this loopback peer to the "forwarded" remote trust
// class (see file header) so the gateway-token-gated code path actually runs. Returns the raw socket, a
// `sendFrame` helper, and a `died` promise that settles (once) on the socket's first close/end/error.
function connectRaw(urlPath) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(port, "127.0.0.1");
    const key = crypto.randomBytes(16).toString("base64");
    let buf = Buffer.alloc(0);
    let handshakeDone = false;
    let diedResolve;
    const died = new Promise((r) => { diedResolve = r; });
    let diedSettled = false;
    const settleDied = (reason) => { if (!diedSettled) { diedSettled = true; diedResolve(reason); } };
    sock.on("close", () => settleDied("close"));
    sock.on("end", () => settleDied("end"));
    sock.on("error", (err) => { settleDied(`error:${err.code ?? err.message}`); if (!handshakeDone) reject(err); });
    sock.on("connect", () => {
      sock.write(
        `GET ${urlPath} HTTP/1.1\r\n` +
        `Host: 127.0.0.1:${port}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n` +
        `X-Forwarded-For: 203.0.113.50\r\n\r\n`
      );
    });
    sock.on("data", (chunk) => {
      if (handshakeDone) return; // post-handshake bytes (close frames, pushes) are never parsed — ignored by design
      buf = Buffer.concat([buf, chunk]);
      const headerEnd = buf.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      handshakeDone = true;
      const statusLine = buf.subarray(0, buf.indexOf("\r\n")).toString();
      if (!/^HTTP\/1\.1 101\b/.test(statusLine)) { reject(new Error(`expected 101, got: ${statusLine}`)); return; }
      resolve({ sock, died, sendFrame: (obj) => sock.write(encodeMaskedTextFrame(JSON.stringify(obj))) });
    });
  });
}

// A plain loopback JSON POST (this REST call itself is loopback-classed — unaffected by the WS peers'
// forced "forwarded" classification above, which only applies to the WS upgrades).
function postJson(urlPath, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body ?? {});
    const req = net.connect(port, "127.0.0.1");
    req.on("connect", () => {
      req.write(
        `POST ${urlPath} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nContent-Type: application/json\r\n` +
        `Content-Length: ${Buffer.byteLength(payload)}\r\nConnection: close\r\n\r\n${payload}`
      );
    });
    let data = Buffer.alloc(0);
    req.on("data", (c) => { data = Buffer.concat([data, c]); });
    req.on("end", () => resolve(data.toString()));
    req.on("error", reject);
  });
}

// Races "the witness frame's own observable effect showed up" against "the raw socket died" — both are
// real, observable events (never a blind sleep). `hangMs` only turns a genuine hang into a failure, per
// ws-rejected-upgrade-close.mjs's own established pattern.
async function raceWitnessOrDeath(observeWitness, died, hangMs = 3000) {
  let timer;
  const witness = waitUntil(observeWitness, { timeoutMs: hangMs - 200 }).then(() => "witness", () => "neither");
  const hang = new Promise((r) => { timer = setTimeout(() => r("hang"), hangMs); });
  const outcome = await Promise.race([witness, died.then(() => "died"), hang]);
  clearTimeout(timer);
  return outcome;
}

try {
  // ===== /ws/companion: a non-cooperative client's post-revoke chat frame must NOT reach handleInAppInbound =====
  {
    const sessionId = "ignore-close-companion";
    const gw = db.createGatewayToken("ignore-close-companion");
    const conn = await connectRaw(`/ws/companion/${sessionId}?token=${gw.plaintext}`);

    conn.sendFrame({ type: "chat", text: "before-revoke" });
    check("(companion) positive control: a pre-revoke chat frame over the raw socket IS processed",
      await waitUntil(() => companionInbound.some((e) => e.sessionId === sessionId && e.text === "before-revoke"), { timeoutMs: 2000 }).then(() => true, () => false));

    // By the time this resolves, closeAll() already ran SYNCHRONOUSLY inside the route handler — both
    // close() and (the fix) terminate() have already been issued on the server-side socket.
    await postJson(`/api/gateway-tokens/${gw.token.id}`, { status: "revoked" });

    // The non-cooperative client: never reads/acts on the close frame, just keeps writing.
    conn.sendFrame({ type: "chat", text: "after-revoke" });
    conn.sendFrame({ type: "chat", text: "witness-companion" });
    const outcome = await raceWitnessOrDeath(
      () => companionInbound.some((e) => e.sessionId === sessionId && e.text === "witness-companion"),
      conn.died,
    );
    check("(companion) post-revoke: the connection died (terminate) rather than the witness frame landing",
      outcome === "died");
    check("(companion) post-revoke: handleInAppInbound was NEVER called with the post-revoke frame",
      !companionInbound.some((e) => e.sessionId === sessionId && e.text === "after-revoke"));
    check("(companion) post-revoke: the witness frame was NEVER processed either (same order-of-arrival proof)",
      !companionInbound.some((e) => e.sessionId === sessionId && e.text === "witness-companion"));
  }

  // ===== /ws/fleet: a non-cooperative client's post-revoke sub:events frame must NOT register =====
  {
    const gw = db.createGatewayToken("ignore-close-fleet");
    const conn = await connectRaw(`/ws/fleet?token=${gw.plaintext}`);
    const serverSocket = fleetServerSockets[fleetServerSockets.length - 1];

    conn.sendFrame({ t: "sub:events", managerId: "before-revoke", sinceSeq: 0 });
    check("(fleet) positive control: a pre-revoke sub:events frame over the raw socket IS processed",
      await waitUntil(() => fleetHub.subscriptionsFor(serverSocket)?.get("before-revoke") === 0, { timeoutMs: 2000 }).then(() => true, () => false));

    await postJson(`/api/gateway-tokens/${gw.token.id}`, { status: "revoked" });

    conn.sendFrame({ t: "sub:events", managerId: "after-revoke", sinceSeq: 0 });
    conn.sendFrame({ t: "sub:events", managerId: "witness-fleet", sinceSeq: 0 });
    const outcome = await raceWitnessOrDeath(
      () => fleetHub.subscriptionsFor(serverSocket)?.get("witness-fleet") === 0,
      conn.died,
    );
    check("(fleet) post-revoke: the connection died (terminate) rather than the witness frame landing",
      outcome === "died");
    check("(fleet) post-revoke: the post-revoke sub:events frame was NEVER registered",
      fleetHub.subscriptionsFor(serverSocket)?.get("after-revoke") === undefined);
    check("(fleet) post-revoke: the witness frame was NEVER registered either (same order-of-arrival proof)",
      fleetHub.subscriptionsFor(serverSocket)?.get("witness-fleet") === undefined);
  }
} finally {
  await app.close();
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a non-cooperative client (ignores the close frame) on a revoked token's /ws/companion or /ws/fleet socket cannot process another frame after revoke: terminate() tears the connection down instead of leaving it CLOSING-but-readable."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
