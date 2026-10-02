import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card d5e3fa82: `FleetHub.subscribeEvents` used to record a `managerId -> sinceSeq` entry on a per-socket
// `Map` with NO upper bound — and `/ws/fleet` accepts a connection with NO credential at all on loopback,
// so any co-resident process could grow that map without limit (memory DoS) just by sending `sub:events`
// frames with distinct `managerId`s. Fixed by `MAX_EVENT_SUBSCRIPTIONS_PER_SOCKET` (gateway/fleet-hub.ts):
// a NEW managerId past the cap is silently dropped; an UPDATE to an already-subscribed managerId (which
// never grows the map) is always allowed.
//
// This test proves, against the real `/ws/fleet` route + the real `FleetHub`:
//   1. Subscribing to `MAX_EVENT_SUBSCRIPTIONS_PER_SOCKET` distinct managers all succeed (the cap has
//      generous headroom for real use, which today is zero — see project memory
//      "ws-delta-push-c4-measured-status-events-unmigrated": no web client sends sub:events yet).
//   2. One more distinct manager past the cap is silently dropped (map size does not grow).
//   3. Re-subscribing to an ALREADY-subscribed manager (updating sinceSeq) still works even while at the
//      cap — proves the cap bounds GROWTH, not activity.
//   4. The socket stays open and keeps functioning after hitting the cap (no crash, no close).
// HERMETIC + CLAUDE-FREE + NETWORK-FREE (Db + buildServer via @fastify/websocket's injectWS, like
// ws-fleet.mjs).
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil as sharedWaitUntil } from "./_wait.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

const TMP = mkdtempManaged("loom-ws-fleet-sub-cap-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(hermeticPort());
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { FleetHub, MAX_EVENT_SUBSCRIPTIONS_PER_SOCKET } = await import("../dist/gateway/fleet-hub.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

async function waitFor(cond, timeoutMs = 2000) {
  try {
    return await sharedWaitUntil(cond, { timeoutMs, intervalMs: 20, label: "ws-fleet-subscription-cap: cond" });
  } catch (err) {
    if (err?.exhaustedOnThrow !== false) throw err;
    return cond();
  }
}

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

try {
  check("(0) MAX_EVENT_SUBSCRIPTIONS_PER_SOCKET is a sane finite positive bound", Number.isInteger(MAX_EVENT_SUBSCRIPTIONS_PER_SOCKET) && MAX_EVENT_SUBSCRIPTIONS_PER_SOCKET > 0);

  await app.ready();
  const inbox = makeInbox();
  const ws = await app.injectWS("/ws/fleet", { headers: { host: "127.0.0.1" } }, { onInit: inbox.onInit });
  await inbox.next();
  check("(setup) connecting registers the socket on the hub", fleetHub.size === 1 && !!serverSocket);

  // --- (1) subscribing to exactly the cap's worth of distinct managers all succeed ----------------------
  for (let i = 0; i < MAX_EVENT_SUBSCRIPTIONS_PER_SOCKET; i++) {
    ws.send(JSON.stringify({ t: "sub:events", managerId: `mgr-${i}`, sinceSeq: i }));
  }
  await waitFor(() => fleetHub.subscriptionsFor(serverSocket)?.size === MAX_EVENT_SUBSCRIPTIONS_PER_SOCKET);
  check(`(1) all ${MAX_EVENT_SUBSCRIPTIONS_PER_SOCKET} distinct managers are recorded (at the cap)`,
    fleetHub.subscriptionsFor(serverSocket)?.size === MAX_EVENT_SUBSCRIPTIONS_PER_SOCKET);

  // --- (2) one more distinct manager past the cap is silently dropped ------------------------------------
  ws.send(JSON.stringify({ t: "sub:events", managerId: "mgr-overflow", sinceSeq: 0 }));
  // Canary technique (ws-fleet.mjs): a canary update to an ALREADY-subscribed manager right after the
  // overflow attempt proves (via in-order ws message processing) that the overflow send has already been
  // handled by the time we check state.
  ws.send(JSON.stringify({ t: "sub:events", managerId: "mgr-0", sinceSeq: 999 }));
  await waitFor(() => fleetHub.subscriptionsFor(serverSocket)?.get("mgr-0") === 999);
  check("(2) a NEW manager past the cap is silently dropped (map size does not grow past the cap)",
    fleetHub.subscriptionsFor(serverSocket)?.size === MAX_EVENT_SUBSCRIPTIONS_PER_SOCKET);
  check("(2) the overflow manager was never actually recorded",
    fleetHub.subscriptionsFor(serverSocket)?.has("mgr-overflow") === false);

  // --- (3) updating an ALREADY-subscribed manager still works while at the cap ---------------------------
  check("(3) updating an already-subscribed manager's sinceSeq works even while at the cap (from the canary above)",
    fleetHub.subscriptionsFor(serverSocket)?.get("mgr-0") === 999);
  ws.send(JSON.stringify({ t: "sub:events", managerId: "mgr-1", sinceSeq: 12345 }));
  await waitFor(() => fleetHub.subscriptionsFor(serverSocket)?.get("mgr-1") === 12345);
  check("(3b) a second already-subscribed manager's update also lands, map still at the cap (not grown)",
    fleetHub.subscriptionsFor(serverSocket)?.get("mgr-1") === 12345 && fleetHub.subscriptionsFor(serverSocket)?.size === MAX_EVENT_SUBSCRIPTIONS_PER_SOCKET);

  // --- (4) the socket survives hitting the cap and keeps functioning -------------------------------------
  check("(4) the socket stays open after hitting the cap", ws.readyState === ws.OPEN);
  fleetHub.broadcast({ t: "status", pausedScopes: [], schedulerEnabled: true });
  const stillWorks = await inbox.next();
  check("(4) the socket still receives broadcasts after hitting the cap (no crash)", stillWorks?.t === "status");

  // Freeing a slot (unsubscribe) lets a NEW manager in again — the cap bounds the map size, not a
  // permanent lockout once reached.
  ws.send(JSON.stringify({ t: "unsub:events", managerId: "mgr-2" }));
  await waitFor(() => fleetHub.subscriptionsFor(serverSocket)?.has("mgr-2") === false);
  ws.send(JSON.stringify({ t: "sub:events", managerId: "mgr-overflow-2", sinceSeq: 0 }));
  await waitFor(() => fleetHub.subscriptionsFor(serverSocket)?.has("mgr-overflow-2") === true);
  check("(5) freeing a slot via unsub lets a new manager back in (cap bounds size, not a permanent lockout)",
    fleetHub.subscriptionsFor(serverSocket)?.size === MAX_EVENT_SUBSCRIPTIONS_PER_SOCKET);

  ws.terminate();
  check("(6) closing the socket removes it from the hub", await waitFor(() => fleetHub.size === 0));
} finally {
  await app.close();
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — FleetHub caps per-socket event subscriptions at MAX_EVENT_SUBSCRIPTIONS_PER_SOCKET: new managers past the cap are dropped, updates to already-subscribed managers still work, and the socket survives."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
