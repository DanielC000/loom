import "./_guard.mjs";
// Card 3c205fb5 — a gateway token's open WS sockets (/ws/term, /ws/fleet, /ws/companion) must close when
// the token is revoked, paused, rotated, or deleted — not just stop authorizing FUTURE requests. Before
// this card the token was checked only at upgrade, so a socket already open under a revoked token kept
// streaming indefinitely. HERMETIC + CLAUDE-FREE + NETWORK-FREE: a REAL Db + the REAL buildServer driven
// via app.injectWS with a REMOTE socket, authenticated with a real gateway token over the
// Sec-WebSocket-Protocol bearer subprotocol (the same mechanism card 710a34fa's test uses).
//
// A "this socket is unaffected" claim is never proven by a fixed sleep then checking a `closed` flag
// stayed false (unfalsifiable in one trial — see fixed-wait-negative-guard.mjs). Instead `proveAlive`
// below sends a real, distinctively-tagged frame on each of the three sockets and polls for its
// SERVER-OBSERVED effect (a pty repaint, a fleet-hub subscription, a recorded companion inbound call) —
// an affirmative round-trip, not an absence-after-a-timer.
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

const TMP = mkdtempManaged("loom-gwtoken-ws-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(hermeticPort());
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { GatewayTokenSocketRegistry } = await import("../dist/gateway/token-sockets.js");
const { FleetHub } = await import("../dist/gateway/fleet-hub.js");
const { WS_GENERIC_SUBPROTOCOL, WS_BEARER_PREFIX } = await import("../dist/gateway/trust-tier.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const HOST = "loom-gwtoken-ws-test.example.com";
const REMOTE = { remoteAddress: "203.0.113.9" };
const repaints = [];
const companionInbound = [];
const ptyStub = {
  subscribe: () => () => {},
  writeStdin: () => {},
  repaint: (id) => { repaints.push(id); },
  resize: () => {},
  listShells: () => [],
};
const companionStub = {
  handleInAppInbound: async (sessionId, text) => { companionInbound.push({ sessionId, text }); },
};

// Injected (not buildServer's default) so the test can capture each connection's SERVER-side socket —
// the key `subscriptionsFor` reads by — exactly like ws-fleet.mjs's own `serverSocket` capture.
const fleetHub = new FleetHub();
const fleetServerSockets = [];
const originalFleetAdd = fleetHub.add.bind(fleetHub);
fleetHub.add = (socket) => { fleetServerSockets.push(socket); originalFleetAdd(socket); };

const db = new Db(path.join(TMP, "loom.db"));
db.setPlatformConfig({ remoteAccess: { enabled: true, bindHost: HOST } });
const gwA = db.createGatewayToken("socket-close A");
const gwB = db.createGatewayToken("socket-close B");

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
  // card 23496950: a remote peer's Origin must be the FULL remote origin (scheme + host + the remote listener's port).
  remoteEndpoint: { current: { scheme: "https", port: 4444 } },
});
await app.ready(); // the first WS call below has no preceding app.inject() to implicitly ready() it
const H = { host: HOST, origin: `https://${HOST}:4444` };
const proto = (t) => `${WS_GENERIC_SUBPROTOCOL}, ${WS_BEARER_PREFIX}${t}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms = 2000) { const end = Date.now() + ms; while (Date.now() < end) { if (pred()) return true; await sleep(20); } return pred(); }

// Opens one REMOTE, token-authenticated socket on each of the three Tier-1 WS routes and returns them
// plus a live `closed` map a later assertion can poll.
async function openSockets(tokenPlaintext, sessionId) {
  const headers = { ...H, "sec-websocket-protocol": proto(tokenPlaintext) };
  const term = await app.injectWS(`/ws/term/${sessionId}`, { headers, socket: REMOTE });
  const fleet = await app.injectWS("/ws/fleet", { headers, socket: REMOTE });
  const fleetServerSocket = fleetServerSockets[fleetServerSockets.length - 1];
  const companion = await app.injectWS(`/ws/companion/${sessionId}`, { headers, socket: REMOTE });
  const closed = { term: false, fleet: false, companion: false };
  term.on("close", () => { closed.term = true; });
  fleet.on("close", () => { closed.fleet = true; });
  companion.on("close", () => { closed.companion = true; });
  return { sessionId, term, fleet, fleetServerSocket, companion, closed };
}

// Sends one distinctively-tagged frame on each socket in `set` and polls for its SERVER-OBSERVED effect.
// An affirmative round-trip proof that the socket is still open AND being actively served — never a
// sleep-then-check-it-stayed-false, which can't tell "truly unaffected" from "hasn't closed yet".
async function proveAlive(set) {
  const tag = `probe-${set.sessionId}-${Date.now()}`;
  set.term.send(JSON.stringify({ type: "repaint" }));
  set.fleet.send(JSON.stringify({ t: "sub:events", managerId: tag, sinceSeq: 0 }));
  set.companion.send(JSON.stringify({ type: "chat", text: tag }));
  return {
    term: await waitFor(() => repaints.includes(set.sessionId)),
    fleet: await waitFor(() => fleetHub.subscriptionsFor(set.fleetServerSocket)?.get(tag) === 0),
    companion: await waitFor(() => companionInbound.some((e) => e.sessionId === set.sessionId && e.text === tag)),
  };
}

try {
  // ===== setup: two different tokens, each with a socket open on all three WS routes =====
  const a = await openSockets(gwA.plaintext, "sess-a");
  const b = await openSockets(gwB.plaintext, "sess-b");
  check("setup: token A's 3 sockets registered", registry.countFor(gwA.token.id) === 3);
  check("setup: token B's 3 sockets registered", registry.countFor(gwB.token.id) === 3);

  // ===== REVOKE closes token A's sockets; a DIFFERENT token's sockets stay open and responsive =====
  const revokeRes = await app.inject({ method: "POST", url: `/api/gateway-tokens/${gwA.token.id}`, payload: { status: "revoked" } });
  check("revoke: REST call ok (200)", revokeRes.statusCode === 200);
  check("revoke: /ws/term closed", await waitFor(() => a.closed.term));
  check("revoke: /ws/fleet closed", await waitFor(() => a.closed.fleet));
  check("revoke: /ws/companion closed", await waitFor(() => a.closed.companion));
  check("revoke: registry empty for token A after close", registry.countFor(gwA.token.id) === 0);
  const aliveAfterRevoke = await proveAlive(b);
  check("revoke: a DIFFERENT token's /ws/term stays open (repaint round-trips)", aliveAfterRevoke.term);
  check("revoke: a DIFFERENT token's /ws/fleet stays open (sub:events round-trips)", aliveAfterRevoke.fleet);
  check("revoke: a DIFFERENT token's /ws/companion stays open (chat round-trips)", aliveAfterRevoke.companion);
  check("revoke: token B's registry entry is untouched (3)", registry.countFor(gwB.token.id) === 3);

  // ===== PAUSE closes token B's sockets exactly like revoke does =====
  const pauseRes = await app.inject({ method: "POST", url: `/api/gateway-tokens/${gwB.token.id}`, payload: { status: "paused" } });
  check("pause: REST call ok (200)", pauseRes.statusCode === 200);
  check("pause: /ws/term closed", await waitFor(() => b.closed.term));
  check("pause: /ws/fleet closed", await waitFor(() => b.closed.fleet));
  check("pause: /ws/companion closed", await waitFor(() => b.closed.companion));
  check("pause: registry empty for token B after close", registry.countFor(gwB.token.id) === 0);

  // ===== reactivating + a name-only edit close nothing (nothing stale to cut off) =====
  await app.inject({ method: "POST", url: `/api/gateway-tokens/${gwB.token.id}`, payload: { status: "active" } });
  const b2 = await openSockets(gwB.plaintext, "sess-b2");
  check("reactivate: a fresh socket set registers (3)", registry.countFor(gwB.token.id) === 3);
  const renameRes = await app.inject({ method: "POST", url: `/api/gateway-tokens/${gwB.token.id}`, payload: { name: "renamed" } });
  check("name-only edit: REST call ok (200)", renameRes.statusCode === 200);
  const aliveAfterRename = await proveAlive(b2);
  check("name-only edit: closes nothing (term stays responsive)", aliveAfterRename.term);
  check("name-only edit: closes nothing (fleet stays responsive)", aliveAfterRename.fleet);
  check("name-only edit: closes nothing (companion stays responsive)", aliveAfterRename.companion);
  check("name-only edit: registry still holds all 3", registry.countFor(gwB.token.id) === 3);

  // ===== ROTATE: the OLD secret's sockets close (its authority is dead the instant rotation happens) =====
  const rotateRes = await app.inject({ method: "POST", url: `/api/gateway-tokens/${gwB.token.id}/rotate` });
  check("rotate: REST call ok (200)", rotateRes.statusCode === 200);
  const newPlaintext = rotateRes.json().plaintext;
  check("rotate: /ws/term closed (old secret)", await waitFor(() => b2.closed.term));
  check("rotate: /ws/fleet closed (old secret)", await waitFor(() => b2.closed.fleet));
  check("rotate: /ws/companion closed (old secret)", await waitFor(() => b2.closed.companion));
  check("rotate: registry empty after close", registry.countFor(gwB.token.id) === 0);

  // the NEW secret authenticates a fresh socket, registered under the SAME (preserved) token id
  const b3 = await openSockets(newPlaintext, "sess-b3");
  check("rotate: a fresh socket under the new secret registers under the same id", registry.countFor(gwB.token.id) === 3);

  // ===== DELETE closes whatever is still open for the (now-gone) row =====
  const delRes = await app.inject({ method: "DELETE", url: `/api/gateway-tokens/${gwB.token.id}` });
  check("delete: REST call ok (200)", delRes.statusCode === 200);
  check("delete: /ws/term closed", await waitFor(() => b3.closed.term));
  check("delete: /ws/fleet closed", await waitFor(() => b3.closed.fleet));
  check("delete: /ws/companion closed", await waitFor(() => b3.closed.companion));
  check("delete: registry empty after close", registry.countFor(gwB.token.id) === 0);

  // ===== close-cleanup: a socket closed by ordinary means (not a token status change) self-unregisters =====
  // NOTE: a CLIENT-initiated graceful `.close()` doesn't complete server-side on @fastify/websocket's
  // synthetic in-memory duplex (see ws-fleet.mjs's own note on this) — `.terminate()` simulates an abrupt
  // disconnect, which the real 'close' handler (the same one closeAll's server-initiated close also hits)
  // must handle identically either way.
  const gwC = db.createGatewayToken("normal-close");
  const c = await openSockets(gwC.plaintext, "sess-c");
  check("normal close: registered (3)", registry.countFor(gwC.token.id) === 3);
  c.term.terminate(); c.fleet.terminate(); c.companion.terminate();
  check("normal close: self-unregisters (registry empty)", await waitFor(() => registry.countFor(gwC.token.id) === 0));
} finally {
  await app.close();
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a gateway token's open /ws/term, /ws/fleet and /ws/companion sockets close on revoke/pause/rotate/delete; a different token's sockets stay open AND responsive; the registry self-cleans on ordinary close; an unrelated edit or reactivation closes nothing."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
