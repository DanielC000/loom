import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 7b812c18 — the HUMAN-ONLY ssh host-key re-pin: POST /api/connections/:id/ssh/repin-host-key.
// Hermetic: a real Db on a temp LOOM_HOME, the real buildServer (app.inject), and a THROWAWAY loopback
// ssh2.Server whose host key fingerprint is computed independently of the route.
//
// Proves: a valid re-pin writes exactly the presented fingerprint and files ONE ssh_host_key_repinned
// event; it refuses (pin and event untouched) a stale previousFingerprint, a fingerprint the host does
// not present, a malformed fingerprint, an unknown/non-ssh id and an unreachable host; and that no MCP
// router exposes any re-pin/host-key tool (a tool-NAME sweep only — not descriptions or schemas — over the
// manager, worker, setup, platform and task routers); the store-level repinSshHostKey refuses a changed pin and a
// changed address on its own; and a manual PUT pin edit at an unchanged address files a via:manual-edit event.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-ssh-repin-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { createSshConnection, createConnection, getConnectionMetadata, repinSshHostKey } = await import("../dist/connections/store.js");
const { computeHostKeyFingerprint } = await import("../dist/connections/ssh.js");
const { buildServer } = await import("../dist/gateway/server.js");
const sshDefault = (await import("ssh2")).default;
const { utils: sshUtils } = sshDefault;
const { generateParseableEd25519 } = await import("./_ssh-test-keys.mjs");

try {
  const hostKey = generateParseableEd25519(sshUtils);
  const clientKey = generateParseableEd25519(sshUtils);
  const LIVE_FP = computeHostKeyFingerprint(sshUtils.parseKey(hostKey.public).getPublicSSH());
  const OLD_FP = "SHA256:" + "A".repeat(43);
  const OTHER_FP = "SHA256:" + "B".repeat(43);
  check("fixture: the live fingerprint differs from both stand-ins", LIVE_FP !== OLD_FP && LIVE_FP !== OTHER_FP);

  const server = new sshDefault.Server({ hostKeys: [hostKey.private] }, (conn) => { conn.on("error", () => {}); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;

  const db = new Db(path.join(tmpHome, "t.db"));
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
  const bodies = [];
  const inject = async (opts) => { const r = await app.inject(opts); bodies.push(r.payload); return r; };
  const mk = (name, extra = {}) => createSshConnection(db, { name, host: "127.0.0.1", port, user: "loom", privateKey: clientKey.private, hostKeyFingerprint: OLD_FP, ...extra });
  const pin = (id) => db.getConnection(id).sshHostKeyFingerprint;
  const events = () => db.listEventsSince(0, 5000).filter((e) => e.kind === "ssh_host_key_repinned");
  const url = (id) => `/api/connections/${id}/ssh/repin-host-key`;
  const post = (id, payload) => inject({ method: "POST", url: url(id), payload });

  const c = mk("Repin target");

  // --- refusals leave the pin and the audit log untouched ---
  const stale = await post(c.id, { fingerprint: LIVE_FP, previousFingerprint: OTHER_FP });
  check("stale previousFingerprint -> 409, pin unchanged, no event", stale.statusCode === 409 && pin(c.id) === OLD_FP && events().length === 0);
  const notPresented = await post(c.id, { fingerprint: OTHER_FP, previousFingerprint: OLD_FP });
  check("a fingerprint the host does not present -> 409, pin unchanged, no event", notPresented.statusCode === 409 && pin(c.id) === OLD_FP && events().length === 0);
  for (const [label, body] of [
    ["malformed fingerprint", { fingerprint: "garbage", previousFingerprint: OLD_FP }],
    ["non-string fingerprint", { fingerprint: 5, previousFingerprint: OLD_FP }],
    ["missing previousFingerprint", { fingerprint: LIVE_FP }],
    ["empty body", {}],
  ]) {
    const r = await post(c.id, body);
    check(`${label} -> 400, pin unchanged, no event`, r.statusCode === 400 && pin(c.id) === OLD_FP && events().length === 0);
  }
  check("unknown id -> 404", (await post("does-not-exist", { fingerprint: LIVE_FP, previousFingerprint: OLD_FP })).statusCode === 404);
  const bearer = createConnection(db, { name: "Bearer", host: "api.example", authScheme: "bearer", secret: "sk-not-ssh-123456" });
  check("a non-ssh connection id -> 404", (await post(bearer.id, { fingerprint: LIVE_FP, previousFingerprint: OLD_FP })).statusCode === 404);

  // --- the happy path: exactly the presented fingerprint, one audit event ---
  const ok = await post(c.id, { fingerprint: LIVE_FP, previousFingerprint: OLD_FP });
  check("valid re-pin -> 200 and the response carries the new pin", ok.statusCode === 200 && JSON.parse(ok.payload).hostKeyFingerprint === LIVE_FP);
  check("the stored pin is now exactly the live fingerprint", pin(c.id) === LIVE_FP && getConnectionMetadata(db, c.id).hostKeyFingerprint === LIVE_FP);
  const ev = events();
  check("exactly one ssh_host_key_repinned event with connectionId + previous + new fingerprint",
    ev.length === 1 && ev[0].detail.connectionId === c.id && ev[0].detail.previousFingerprint === OLD_FP && ev[0].detail.fingerprint === LIVE_FP);
  check("the event carries nothing beyond the three fields + via (no key material)", Object.keys(ev[0].detail).sort().join(",") === "connectionId,fingerprint,previousFingerprint,via");
  check("the route's event is labelled via:live-repin", ev[0].detail.via === "live-repin");
  const replay = await post(c.id, { fingerprint: LIVE_FP, previousFingerprint: OLD_FP });
  check("replaying the same request is stale -> 409, no second event", replay.statusCode === 409 && events().length === 1);
  const noop = await post(c.id, { fingerprint: LIVE_FP, previousFingerprint: LIVE_FP });
  check("re-pinning to the already-current pin is a 200 no-op with no event", noop.statusCode === 200 && events().length === 1);
  check("no response body ever contains key material", bodies.every((b) => !b.includes("PRIVATE KEY") && !b.includes(clientKey.private.slice(40, 80))));

  // --- store-level CAS: repinSshHostKey itself refuses a changed pin AND a changed address (no route in front) ---
  const baseHost = { host: "127.0.0.1", port };
  const c3 = mk("Store CAS target");
  const e0 = events().length;
  let st = null;
  try { repinSshHostKey(db, c3.id, { fingerprint: LIVE_FP, previousFingerprint: OTHER_FP, ...baseHost }); } catch (e) { st = e; }
  check("store: a changed pin (previousFingerprint != current) throws 409, pin unchanged", st?.status === 409 && pin(c3.id) === OLD_FP);
  st = null;
  try { repinSshHostKey(db, c3.id, { fingerprint: LIVE_FP, previousFingerprint: OLD_FP, host: "other.example", port }); } catch (e) { st = e; }
  check("store: a changed host throws 409, pin unchanged", st?.status === 409 && pin(c3.id) === OLD_FP);
  st = null;
  try { repinSshHostKey(db, c3.id, { fingerprint: LIVE_FP, previousFingerprint: OLD_FP, host: "127.0.0.1", port: port + 1 }); } catch (e) { st = e; }
  check("store: a changed port throws 409, pin unchanged", st?.status === 409 && pin(c3.id) === OLD_FP);
  const stOk = repinSshHostKey(db, c3.id, { fingerprint: LIVE_FP, previousFingerprint: OLD_FP, ...baseHost });
  check("store: (positive control) the matching pin AND address re-pins", stOk.changed === true && pin(c3.id) === LIVE_FP);
  check("store: the store itself files no event (the route does)", events().length === e0);

  // --- the manual PUT pin edit at an unchanged address is audited as a re-pin too (via:manual-edit) ---
  const c4 = mk("Manual edit target");
  const e1 = events().length;
  const putOk = await inject({ method: "PUT", url: `/api/connections/${c4.id}/ssh`, payload: { hostKeyFingerprint: OTHER_FP } });
  const evM = events();
  check("PUT pin edit at an unchanged address -> 200 and the pin moved", putOk.statusCode === 200 && pin(c4.id) === OTHER_FP);
  check("PUT pin edit files one ssh_host_key_repinned via:manual-edit with previous + new",
    evM.length === e1 + 1 && evM[evM.length - 1].detail.via === "manual-edit" && evM[evM.length - 1].detail.connectionId === c4.id
      && evM[evM.length - 1].detail.previousFingerprint === OLD_FP && evM[evM.length - 1].detail.fingerprint === OTHER_FP);
  await inject({ method: "PUT", url: `/api/connections/${c4.id}/ssh`, payload: { name: "Manual edit target 2" } });
  check("a PUT that doesn't touch the pin files no re-pin event", events().length === e1 + 1);
  await inject({ method: "PUT", url: `/api/connections/${c4.id}/ssh`, payload: { hostKeyFingerprint: OTHER_FP } });
  check("a PUT repeating the current pin files no re-pin event", events().length === e1 + 1);
  await inject({ method: "PUT", url: `/api/connections/${c4.id}/ssh`, payload: { host: "localhost", hostKeyFingerprint: OLD_FP } });
  check("a PUT that changes the address (new pin for a new address) files no re-pin event", events().length === e1 + 1 && pin(c4.id) === OLD_FP);

  // --- an unreachable host refuses (502) rather than pinning blind ---
  const c2 = mk("Unreachable target");
  const eBefore502 = events().length;
  await new Promise((r) => server.close(r));
  const closed = await post(c2.id, { fingerprint: LIVE_FP, previousFingerprint: OLD_FP });
  check("host unreachable -> 502, pin unchanged, no new event", closed.statusCode === 502 && pin(c2.id) === OLD_FP && events().length === eBefore502);

  // --- the human-only boundary: no MCP router exposes a re-pin / host-key tool ---
  const { TaskMcpRouter } = await import("../dist/mcp/server.js");
  const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
  const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
  const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
  const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { SessionService } = await import("../dist/sessions/service.js");
  const { OrchestrationControl } = await import("../dist/orchestration/control.js");
  const { PtyHost } = await import("../dist/pty/host.js");
  const { createSeamHost } = await import("./_seam-host-fixture.mjs");
  class SeamHost extends createSeamHost(PtyHost) { createPty(o) { return { ...super.createPty(o), pid: 1 }; } stop() {} }
  const svc = new SessionService(db, new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} }), new OrchestrationControl());
  const toolNames = async (server) => {
    const [ct, st] = InMemoryTransport.createLinkedPair();
    await server.connect(st);
    const client = new Client({ name: "repin", version: "0" });
    await client.connect(ct);
    const names = (await client.listTools()).tools.map((t) => t.name);
    await client.close();
    return names;
  };
  const all = [
    ...(await toolNames(new OrchestrationMcpRouter(db, svc).buildServer("m1", "manager"))),
    ...(await toolNames(new OrchestrationMcpRouter(db, svc).buildServer("w1", "worker"))),
    ...(await toolNames(new SetupMcpRouter(db, svc).buildServer())),
    ...(await toolNames(new PlatformMcpRouter(db, svc).buildServer("p1"))),
    ...(await toolNames(new TaskMcpRouter(db, {}).buildServer("p1", "s-task"))),
  ];
  check("(positive control) the sweep sees real tools", all.length > 20 && all.includes("worker_report"));
  check("no MCP tool name mentions repin / host key / fingerprint", !all.some((n) => /repin|host.?key|fingerprint/i.test(n)));

  await app.close();
  db.close();
} finally {
  cleanupPathSync(tmpHome);
}
console.log(failures === 0 ? "\n✅ ALL PASS" : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
