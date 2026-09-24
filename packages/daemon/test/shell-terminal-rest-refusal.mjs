import "./_guard.mjs";
// Card 710a34fa (REST half) — a host shell is not a session: the Tier-1 session routes
// POST /api/sessions/:id/input and /stop must REFUSE a shell id (409) and never touch its pty, for a remote
// gateway-token peer AND for loopback. Shell teardown stays on DELETE /api/terminals/:id (Tier 0, loopback).
// Uses the REAL PtyHost via the createShellPty() seam (fake node-pty, no process), NOT a pty stub.
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

const TMP = mkdtempManaged("loom-shell-rest-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(hermeticPort());
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(path.join(TMP, "logs"), { recursive: true });
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { buildServer } = await import("../dist/gateway/server.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const fakes = [];
class TestPtyHost extends PtyHost {
  createShellPty() {
    const writes = []; let exitCb = null; let kills = 0;
    const fake = { pid: 7777, write: (d) => { writes.push(d); }, resize() {}, onData: () => ({ dispose() {} }),
      onExit: (cb) => { exitCb = cb; return { dispose() {} }; }, kill: () => { kills++; if (exitCb) exitCb({ exitCode: 0 }); },
      writes, get kills() { return kills; } };
    fakes.push(fake); return fake;
  }
}
const events = { onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} };
const host = new TestPtyHost(events);

const HOST = "loom-remote-test.example.com", TOKEN = "test-valid-gateway-token", SECRET = "loopback-secret-xyz";
const stub = {};
const db = new Db(path.join(TMP, "loom.db"));
db.insertProject({ id: "p1", name: "P1", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: new Date().toISOString(), archivedAt: null });
db.setPlatformConfig({ remoteAccess: { enabled: true, bindHost: HOST } });
const app = await buildServer({
  db, pty: host, sessions: { killAllWorkers: () => 0 }, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
  userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, requestShutdown: () => {},
  verifyGatewayToken: (t) => t === TOKEN, loopbackSecret: SECRET,
  // card 23496950: a remote peer's Origin must be the FULL remote origin (scheme + host + the remote listener's port).
  remoteEndpoint: { current: { scheme: "https", port: 4444 } },
});
const remote = (method, url, payload) => app.inject({ method, url, remoteAddress: "203.0.113.7",
  headers: { host: HOST, origin: `https://${HOST}:4444`, authorization: `Bearer ${TOKEN}`, ...(payload ? { "content-type": "application/json" } : {}) }, payload });
const loop = (method, url, payload) => app.inject({ method, url, remoteAddress: "127.0.0.1",
  headers: { host: "127.0.0.1", origin: "http://127.0.0.1", authorization: `Bearer ${SECRET}`, ...(payload ? { "content-type": "application/json" } : {}) }, payload });

try {
  const created = await loop("POST", "/api/terminals", { projectId: "p1", command: "sh" });
  const id = created.json().id;
  const fake = fakes[0];
  check("setup: shell created and alive in the REAL PtyHost", created.statusCode === 201 && host.isAlive(id) && !!fake);

  const rIn = await remote("POST", `/api/sessions/${id}/input`, { text: "echo PWNED" });
  check("remote token: POST /api/sessions/<shell>/input is refused (409)", rIn.statusCode === 409);
  check("remote token: the shell pty received NOTHING from /input", fake.writes.length === 0);

  const rStop = await remote("POST", `/api/sessions/${id}/stop`, { mode: "hard" });
  check("remote token: POST /api/sessions/<shell>/stop is refused (409)", rStop.statusCode === 409);
  check("remote token: the shell is still alive and was not killed", host.isAlive(id) && fake.kills === 0);

  const lIn = await loop("POST", `/api/sessions/${id}/input`, { text: "echo hi" });
  const lStop = await loop("POST", `/api/sessions/${id}/stop`, { mode: "graceful" });
  check("loopback: /input and /stop on a shell id are refused too (structural, not per-tier)", lIn.statusCode === 409 && lStop.statusCode === 409);
  check("loopback: shell still untouched", host.isAlive(id) && fake.writes.length === 0 && fake.kills === 0);

  // control: the same route on a NON-shell (unknown) id is NOT blanket-refused — it reaches enqueueStdin
  const ctl = await remote("POST", "/api/sessions/no-such-agent/input", { text: "hello" });
  check("control: /input for a non-shell id is not 409 (reaches the normal path; session-dead)", ctl.statusCode === 200 && ctl.json().reason === "session-dead");
  const ctlStop = await remote("POST", "/api/sessions/no-such-agent/stop", { mode: "graceful" });
  check("control: /stop for a non-shell id still 200s", ctlStop.statusCode === 200);

  // programmatic rate-limit resume must not claim to resume a shell, nor write to it
  check("resumeAfterRateLimit(shellId) returns false and writes nothing", host.resumeAfterRateLimit(id) === false && fake.writes.length === 0);
  check("stop(shellId) without {shell:true} returns false (refused)", host.stop(id, "hard") === false && host.isAlive(id));

  // raw writeStdin (the loopback /ws/term path) is the ONE way in, and shell teardown stays on its own route
  host.writeStdin(id, "ls\r");
  check("control: raw writeStdin still reaches the shell", fake.writes.join("") === "ls\r");
  const rDel = await remote("DELETE", `/api/terminals/${id}`);
  check("remote token cannot tear down a shell via DELETE /api/terminals (Tier 0 → 403)", rDel.statusCode === 403 && host.isAlive(id));
  const lDel = await loop("DELETE", `/api/terminals/${id}`);
  check("loopback DELETE /api/terminals/:id still kills the shell", lDel.statusCode === 200 && !host.isAlive(id) && fake.kills === 1);
} finally {
  await app.close();
  db.close();
}
await finishAndExit(failures === 0 ? 0 : 1);
