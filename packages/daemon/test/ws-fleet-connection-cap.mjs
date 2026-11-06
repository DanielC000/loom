import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 1baf6fb6: per-process cap on concurrent /ws/fleet connections (MAX_FLEET_CONNECTIONS). Real route + real
// FleetHub, injectWS (network-free). Proves: connections up to the cap are served; the next is refused with 1013
// "too many fleet connections" and never registered; freeing a slot admits a new one; and the per-socket
// subscription cap (d5e3fa82) is unaffected at the cap.
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { waitUntil } from "./_wait.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

const TMP = mkdtempManaged("loom-ws-fleet-conn-cap-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(hermeticPort());
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { FleetHub, MAX_FLEET_CONNECTIONS, MAX_EVENT_SUBSCRIPTIONS_PER_SOCKET } = await import("../dist/gateway/fleet-hub.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const db = new Db(path.join(TMP, "loom.db"));
const fleetHub = new FleetHub();
const app = await buildServer({
  db, pty: {}, sessions: {}, mcp: {}, orchMcp: {}, platformMcp: {}, auditMcp: {}, userAuditMcp: {},
  setupMcp: {}, runMcp: {}, control: {}, usageStatus: {}, requestShutdown: () => {}, fleetHub,
});
const open = (onInit) => app.injectWS("/ws/fleet", { headers: { host: "127.0.0.1" } }, { onInit });

try {
  check("(0) the cap is a sane bound: above any real use, below the point where N x 4 MiB is a problem",
    Number.isInteger(MAX_FLEET_CONNECTIONS) && MAX_FLEET_CONNECTIONS >= 16 && MAX_FLEET_CONNECTIONS <= 256);
  check("(0) the connection cap and the per-socket subscription cap are separate constants", MAX_FLEET_CONNECTIONS !== MAX_EVENT_SUBSCRIPTIONS_PER_SOCKET);
  await app.ready();

  const clients = [];
  for (let i = 0; i < MAX_FLEET_CONNECTIONS; i++) clients.push(await open());
  await waitUntil(() => fleetHub.size === MAX_FLEET_CONNECTIONS, { timeoutMs: 5000, intervalMs: 20, label: "fill to cap" });
  check(`(1) ${MAX_FLEET_CONNECTIONS} connections are all registered`, fleetHub.size === MAX_FLEET_CONNECTIONS && fleetHub.full);

  let closeInfo = null;
  const over = await open((ws) => { ws.on("close", (code, reason) => { closeInfo = { code, reason: reason.toString() }; }); });
  await waitUntil(() => closeInfo !== null, { timeoutMs: 5000, intervalMs: 20, label: "over-cap close" });
  check("(2) the connection past the cap is closed 1013 with a clear reason", closeInfo.code === 1013 && closeInfo.reason === "too many fleet connections");
  check("(2) the refused connection was never registered", fleetHub.size === MAX_FLEET_CONNECTIONS);
  void over;

  clients[0].terminate();
  await waitUntil(() => fleetHub.size === MAX_FLEET_CONNECTIONS - 1, { timeoutMs: 5000, intervalMs: 20, label: "free a slot" });
  let admitted = false;
  const again = await open((ws) => { ws.on("message", () => { admitted = true; }); });
  await waitUntil(() => admitted, { timeoutMs: 5000, intervalMs: 20, label: "admitted after free" });
  check("(3) freeing a slot admits a new connection (the hello frame arrives)", admitted && fleetHub.size === MAX_FLEET_CONNECTIONS);

  again.send(JSON.stringify({ t: "sub:events", managerId: "m", sinceSeq: 1 }));
  await waitUntil(() => [...Array(1)].length === 1 && fleetHub.size === MAX_FLEET_CONNECTIONS, { timeoutMs: 1000, intervalMs: 20, label: "noop" });
  check("(4) at the connection cap an existing socket still works (cap is on admission, not activity)", again.readyState === again.OPEN);

  for (const c of clients.slice(1)) c.terminate();
  again.terminate();
} finally {
  await app.close();
  db.close();
}

console.log(failures === 0 ? "\n✅ ALL PASS — /ws/fleet refuses connections past MAX_FLEET_CONNECTIONS with 1013." : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
