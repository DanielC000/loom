import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a21f5c9e — production-wiring assertion: `webhooks/ingress.ts`'s `fireWebhookTarget` calls
// `deps.sessions.enqueueDurableNudge` unconditionally (Round 2, item 4, deleted the raw `pty.enqueueStdin`
// fallback that used to exist ONLY for a bare hermetic test stub omitting it — see
// webhook-enqueue-durable-nudge.mjs's own (P1d), now a regression guard proving the deleted fallback
// stays gone, not a test of it). THIS file proves the real production wiring (`gateway/server.ts`'s
// `registerWebhookIngress(app, { db: deps.db, sessions: deps.sessions, pty: deps.pty })`, exercised here via
// the REAL `buildServer`) calls the REAL `SessionService.enqueueDurableNudge` method.
//
// Fully hermetic: a REAL Db + the REAL SessionService driven against a FAKE pty (PtyHost.createPty() seam,
// mirrors companion-name.mjs) + the REAL buildServer (app.inject). NO network, NO real claude.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHmac } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-webhook-edn-wiring-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { createWebhookEndpoint } = await import("../dist/webhooks/store.js");

const hexHmac = (secret, data) => createHmac("sha256", secret).update(data).digest("hex");
const settle = () => new Promise((r) => setImmediate(r));
function signGeneric(secret, rawBodyStr, deliveryId, nowMs = Date.now()) {
  const rawBody = Buffer.from(rawBodyStr, "utf8");
  const tsSec = Math.floor(nowMs / 1000);
  const signedContent = Buffer.concat([Buffer.from(`v1.${deliveryId}.${tsSec}.`, "utf8"), rawBody]);
  const sig = "sha256=" + hexHmac(secret, signedContent);
  return {
    payload: rawBodyStr,
    headers: { "content-type": "application/json", "x-loom-signature": sig, "x-loom-timestamp": String(tsSec), "x-loom-delivery-id": deliveryId },
  };
}

try {
  check("SessionService.prototype.enqueueDurableNudge is a real function (reflection sanity check)",
    typeof SessionService.prototype.enqueueDurableNudge === "function");

  const db = new Db(path.join(tmpHome, "wiring.db"));
  const now = new Date().toISOString();
  db.insertProject({ id: "wire-proj", name: "wire", repoPath: "wire-proj", vaultPath: "wire-proj", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "wire-agent", projectId: "wire-proj", name: "wire-target", startupPrompt: "", position: 0 });
  // role:null (plain) — usesOrchestrationMcp(null) is false, so enqueueDurableNudge dispatches SYNCHRONOUSLY
  // (no waitForMcpSeen wait), keeping this test deterministic with no async MCP-handshake simulation needed.
  db.insertSession({
    id: "wire-wake-sess", projectId: "wire-proj", agentId: "wire-agent", engineSessionId: "eng-wire-1", title: null,
    cwd: "wire-proj", processState: "exited", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role: null,
  });

  const events = {
    onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {},
  };
  const host = new (createSeamHost(PtyHost))(events);
  const svc = new SessionService(db, host, new OrchestrationControl());

  // SPY: shadow the instance's own real `enqueueDurableNudge` (an own-property override shadows the
  // prototype method on THIS instance only) — still a genuine call into the REAL implementation underneath.
  const calls = [];
  const realEnqueueDurableNudge = svc.enqueueDurableNudge.bind(svc);
  svc.enqueueDurableNudge = (...args) => { calls.push(args); return realEnqueueDurableNudge(...args); };

  // A separate, STUBBED `pty.isAlive` forced true — this is the dep ingress.ts's OWN `deps.pty` (used only
  // for its `isAlive` pre-check), distinct from the REAL host `svc` is bound to internally. Forcing it
  // true skips the resume() call entirely, so this test needs no real spawn.
  const pty = { isAlive: () => true };

  const stub = {};
  const app = await buildServer({
    db, pty, sessions: svc, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
    userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub, requestShutdown: () => {},
  });

  const endpoint = createWebhookEndpoint(db, {
    name: "Wiring target", sourceType: "generic", secret: "wiring-secret", mode: "wake",
    targetSessionId: "wire-wake-sess", agentId: null,
  });
  const { payload, headers } = signGeneric("wiring-secret", '{"i":1}', "wiring-delivery-1");
  const r = await app.inject({ method: "POST", url: `/hooks/${endpoint.path}`, payload, headers });
  check("wake delivery through the REAL buildServer -> 200", r.statusCode === 200);
  await settle();

  check("the REAL registerWebhookIngress wiring (gateway/server.ts) calls the REAL SessionService.enqueueDurableNudge",
    calls.length === 1 && calls[0][0] === "wire-wake-sess" && calls[0][1] === null);

  await app.close();
  db.close();
} finally {
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the REAL production wiring (gateway/server.ts's registerWebhookIngress(app, {sessions: deps.sessions, ...}), exercised through the REAL buildServer) calls the REAL SessionService.enqueueDurableNudge for a wake-mode webhook delivery."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
