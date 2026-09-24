import "./_guard.mjs";
// Card 4a22aab8 — a WS upgrade rejected by a guard onRequest hook (401 loopback-secret, 403 Origin) must not
// strand its raw socket: `app.close()` has to settle afterwards. Root cause was hook ORDER: @fastify/websocket
// flags an upgrade in ITS onRequest hook and destroys the socket in its onResponse hook only if flagged, so a
// guard registered before the plugin that replied early left the socket open forever (server.close() waits on it).
// REAL listen on an ephemeral 127.0.0.1 port + real `ws` clients (app.inject/injectWS use an in-memory duplex and
// cannot show a stranded TCP socket). Also pins that the status + body a rejected client sees are unchanged, and
// carries a positive control (an authorised upgrade still opens) so a green here is not a vacuous "nothing works".
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

const TMP = mkdtempManaged("loom-ws-rejected-close-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "0";
process.env.LOOM_CODEX_BIN = path.join(TMP, "no-such-codex"); // never a real codex spawn
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { WebSocket } = await import("ws");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const SECRET = "ws-rejected-close-secret";
const stub = {};
const ptyStub = {
  subscribe: () => () => {}, writeStdin: () => {}, repaint: () => {}, resize: () => {},
  listShells: () => [], spawnShell: () => {}, stop: () => {},
};
const db = new Db(path.join(TMP, "t.db"));
const app = await buildServer({
  db, pty: ptyStub, sessions: { killAllWorkers: () => 0 }, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
  userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, requestShutdown: () => {},
  loopbackSecret: SECRET,
});
await app.listen({ port: 0, host: "127.0.0.1" });
const port = app.server.address().port;

// Settles by the socket's own events, never a timer: { kind: "open" } | { kind: "http", status, body } | { kind: "error" }.
function probe(urlPath, protocols, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${urlPath}`, protocols, { headers });
    let settled = false, opened = false;
    const done = (v) => { if (!settled) { settled = true; try { ws.terminate(); } catch { /* */ } resolve(v); } };
    ws.on("open", () => { opened = true; ws.close(); });
    ws.on("unexpected-response", (rq, res) => {
      let body = ""; res.on("data", (c) => { body += c; });
      res.on("end", () => { rq.destroy(); done({ kind: "http", status: res.statusCode, body }); });
    });
    ws.on("error", () => done({ kind: "error" }));
    ws.on("close", () => done(opened ? { kind: "open" } : { kind: "error" }));
  });
}

// (1) the guards still run for WS routes, with the same status + body a client saw before the reorder.
const noSecret = await probe("/ws/term/s1");
check("(1) /ws/term WITHOUT the loopback secret → 401 (guard still runs for a WS route)", noSecret.kind === "http" && noSecret.status === 401);
check("(1) ...body is the unchanged JSON error", noSecret.kind === "http" && JSON.parse(noSecret.body).error === "unauthorized — see `loom open` for how to obtain the local access credential");
const badOrigin = await probe("/ws/fleet", undefined, { origin: "https://evil.example" });
check("(2) /ws/fleet with a cross-origin Origin → 403 (CSRF hook still runs, first)", badOrigin.kind === "http" && badOrigin.status === 403);
check("(2) ...body is the unchanged JSON error", badOrigin.kind === "http" && JSON.parse(badOrigin.body).error === "cross-origin request refused");
// POSITIVE CONTROL: the same probe form DOES see an open upgrade when authorised, so the rejections above are the guard's doing.
check("(3) POSITIVE CONTROL: /ws/term WITH the secret opens", (await probe("/ws/term/s1", ["loom.v1", `loom.bearer.${SECRET}`])).kind === "open");

// (4) THE BUG: after rejected upgrades app.close() must settle. Raced against a timer ONLY to turn a hang into a
// failure — the pass condition is close() settling, an event, so this is not a fixed-wait negative assertion.
let timer;
const closed = await Promise.race([
  app.close().then(() => "closed"),
  new Promise((r) => { timer = setTimeout(() => r("hang"), 10000); }),
]);
clearTimeout(timer);
check("(4) app.close() settles after 401 + 403 rejected WS upgrades (no stranded socket)", closed === "closed");

if (closed === "closed") db.close();
await finishAndExit(failures ? 1 : 0);
