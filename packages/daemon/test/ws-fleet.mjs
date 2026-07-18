import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// C2 of the WS delta-push umbrella (1efde4ba) — the `/ws/fleet` transport skeleton (route + FleetHub
// registry, gateway/fleet-hub.ts). TRANSPORT SKELETON ONLY: no data feeds wired in this card (session/
// status/event emission are later cards, C3/C5/C7) — this proves the wire-level contract this card
// actually ships:
//   1. Connecting sends `{t:"hello",v:1}` and registers the socket on the hub (hub.size).
//   2. A `sub:events{managerId,sinceSeq}` message records the subscription on THAT socket — proven both
//      directly (FleetHub.subscriptionsFor) and behaviorally (a hub.broadcastEvent for that managerId
//      reaches the client).
//   3. An `unsub:events{managerId}` message clears it — proven the same two ways, including that a
//      broadcastEvent for that managerId no longer reaches the client.
//   4. An unknown `t` is ignored (forward-compat) — no throw, no state change.
//   4b. CR-caught crash guard: a raw non-object frame (`"null"`, a bare number, a bare string) must NOT
//       crash the handler — `JSON.parse` doesn't throw on those, so touching `.t` without a type-guard
//       throws an uncaught TypeError in a ws 'message' listener, which takes the whole daemon process
//       down under the supervisor (a 4-byte-frame DoS, reachable by any Tier-1 client). Also: a
//       sub:events with a non-string managerId (or non-finite sinceSeq) is ignored, not just non-crashing
//       — C7 will trust hub subscription state without re-validating it.
//   5. Closing the socket removes it from the hub (hub.size back to 0).
// HERMETIC + CLAUDE-FREE + NETWORK-FREE (Db + buildServer via @fastify/websocket's injectWS, like
// trust-tier.mjs's own WS coverage) — the loopback path needs no gateway token.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "loom-ws-fleet-"));
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45343"; // distinct from trust-tier.mjs's 45342 — no port collision if run concurrently
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { FleetHub } = await import("../dist/gateway/fleet-hub.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// A queued inbox of parsed messages, wired via injectWS's `onInit` hook (called SYNCHRONOUSLY before the
// handshake even starts) rather than attaching `.on("message", ...)` only after `injectWS` resolves — the
// server sends its `hello` the instant the connection opens, and on @fastify/websocket's in-memory duplex
// transport 'open' + that first 'message' can land in the SAME synchronous flush, before a post-resolve
// listener would ever get attached. `onInit` closes that race by listening from before 'open' can fire.
function makeInbox() {
  const queue = [];
  let waiter = null;
  const onInit = (ws) => {
    ws.on("message", (data) => {
      const msg = JSON.parse(data.toString());
      if (waiter) { const resolve = waiter; waiter = null; resolve(msg); } else queue.push(msg);
    });
  };
  const next = (ms = 500) => {
    if (queue.length) return Promise.resolve(queue.shift());
    return new Promise((resolve) => {
      const timer = setTimeout(() => { waiter = null; resolve(null); }, ms);
      waiter = (msg) => { clearTimeout(timer); resolve(msg); };
    });
  };
  return { onInit, next };
}

// Poll `cond` until it's true or `timeoutMs` elapses — used instead of a fixed sleep for hub-state
// assertions that depend on the server having processed an already-sent message.
async function waitFor(cond, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return cond();
}

const db = new Db(path.join(TMP, "loom.db"));
const fleetHub = new FleetHub(); // injected so the test can assert hub state + drive broadcastEvent directly

// Capture the SERVER-side socket the route hands to fleetHub.add() — distinct from the client-side `ws`
// injectWS returns (they're the two ends of an in-memory duplex pair) — so subscriptionsFor() can be
// asserted directly against the real hub key, not just observed behaviorally.
let serverSocket;
const originalAdd = fleetHub.add.bind(fleetHub);
fleetHub.add = (socket) => { serverSocket = socket; originalAdd(socket); };

const app = await buildServer({
  db, pty: {}, sessions: {}, mcp: {}, orchMcp: {}, platformMcp: {}, auditMcp: {}, userAuditMcp: {},
  setupMcp: {}, runMcp: {}, control: {}, usageStatus: {}, requestShutdown: () => {},
  fleetHub,
});

try {
  check("(0) hub starts empty", fleetHub.size === 0);

  // injectWS as the FIRST inject call on a fresh app can hang @fastify/websocket's handshake — an
  // existing harness quirk unrelated to this route (trust-tier.mjs never hits it because its WS checks
  // always follow an earlier plain .inject() call on the same app, which implicitly triggers ready()
  // first). Calling ready() explicitly here sidesteps it.
  await app.ready();

  const inbox = makeInbox();
  const ws = await app.injectWS("/ws/fleet", { headers: { host: "127.0.0.1" } }, { onInit: inbox.onInit }); // loopback, no token needed
  const hello = await inbox.next();
  check("(1) connecting sends {t:'hello',v:1}", JSON.stringify(hello) === JSON.stringify({ t: "hello", v: 1 }));
  check("(1) connecting registers the socket on the hub", fleetHub.size === 1 && !!serverSocket);

  // --- sub:events records the subscription -----------------------------------------------------------
  ws.send(JSON.stringify({ t: "sub:events", managerId: "mgr-1", sinceSeq: 7 }));
  check("(2) sub:events records {managerId: sinceSeq} directly on the hub's subscription state",
    await waitFor(() => fleetHub.subscriptionsFor(serverSocket)?.get("mgr-1") === 7));

  const evt = { t: "event", managerId: "mgr-1", event: { kind: "worker_report", at: "2026-07-18T00:00:00.000Z", seq: 1 } };
  fleetHub.broadcastEvent("mgr-1", evt);
  const received = await inbox.next();
  check("(2b) a broadcastEvent for that subscribed managerId reaches the client", JSON.stringify(received) === JSON.stringify(evt));

  // A broadcastEvent for a DIFFERENT (unsubscribed) managerId must NOT reach this client.
  fleetHub.broadcastEvent("mgr-other", { t: "event", managerId: "mgr-other", event: { kind: "x", at: "y", seq: 2 } });
  const noise = await inbox.next(200);
  check("(2c) a broadcastEvent for an UNSUBSCRIBED managerId does not reach the client", noise === null);

  // --- unsub:events clears the subscription -----------------------------------------------------------
  ws.send(JSON.stringify({ t: "unsub:events", managerId: "mgr-1" }));
  check("(3) unsub:events clears the subscription directly on the hub's subscription state",
    await waitFor(() => fleetHub.subscriptionsFor(serverSocket)?.has("mgr-1") === false));
  fleetHub.broadcastEvent("mgr-1", evt);
  const afterUnsub = await inbox.next(200);
  check("(3b) a broadcastEvent for that now-unsubscribed managerId no longer reaches the client", afterUnsub === null);

  // --- unknown t is ignored (forward-compat): no throw, no state change --------------------------------
  ws.send(JSON.stringify({ t: "totally:unknown", foo: "bar" }));
  await new Promise((r) => setTimeout(r, 50)); // let the server-side message handler run (no observable effect to poll on)
  fleetHub.broadcastEvent("mgr-1", evt); // still unsubscribed — proves the unknown message didn't resurrect it
  const afterUnknown = await inbox.next(200);
  check("(4) an unknown message type is ignored (no throw, no resurrected subscription)", afterUnknown === null && fleetHub.size === 1);

  // --- (4b) raw non-object frames must not crash the handler (CR blocker: JSON.parse("null") doesn't ----
  // throw, so a bare `.t` read would) — assert the socket + hub survive, then that a broadcast still
  // reaches the client afterward (proves the handler, and the process, are still alive and functioning).
  for (const [label, raw] of [["bare 'null'", "null"], ["bare number", "42"], ["bare string", "\"x\""]]) {
    ws.send(raw);
    await new Promise((r) => setTimeout(r, 50));
    check(`(4b) a raw ${label} frame does not crash the handler (socket stays open, hub unchanged)`,
      ws.readyState === ws.OPEN && fleetHub.size === 1);
  }
  fleetHub.broadcast({ t: "status", pausedScopes: [], schedulerEnabled: true });
  const survivedBroadcast = await inbox.next();
  check("(4b) the socket is still functional after the malformed frames (a broadcast still reaches it)", survivedBroadcast?.t === "status");

  // A sub:events with a non-string managerId, or a non-finite sinceSeq, is IGNORED — not just non-crashing.
  ws.send(JSON.stringify({ t: "sub:events", managerId: 123, sinceSeq: 1 }));
  ws.send(JSON.stringify({ t: "sub:events", managerId: "mgr-2", sinceSeq: "not-a-number" }));
  await new Promise((r) => setTimeout(r, 50));
  check("(4c) sub:events with a non-string managerId or non-finite sinceSeq is ignored (hub subscription state unchanged)",
    fleetHub.subscriptionsFor(serverSocket)?.size === 0);

  // broadcast() (used by later cards) fans out to every connected socket regardless of subscriptions.
  fleetHub.broadcast({ t: "status", pausedScopes: [], schedulerEnabled: false });
  const statusMsg = await inbox.next();
  check("(5) broadcast() reaches every connected socket (no subscription needed)", statusMsg?.t === "status");

  // ws.close() (the graceful handshake) doesn't complete server-side on @fastify/websocket's synthetic
  // in-memory duplex transport (a harness limitation, not a route bug — a real socket's close handshake
  // completes fine); terminate() simulates an abrupt disconnect, which the 'close' handler below (the
  // same one a graceful close would also invoke) must handle identically either way.
  ws.terminate();
  check("(6) closing the socket removes it from the hub", await waitFor(() => fleetHub.size === 0));
} finally {
  await app.close();
  db.close();
  for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — /ws/fleet sends hello + registers on the hub; sub:events/unsub:events record/clear the subscription (proven behaviorally via broadcastEvent); unknown message types are ignored; closing removes the socket."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
