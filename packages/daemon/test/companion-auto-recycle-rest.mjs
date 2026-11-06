import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 1837a542 — the human-only REST half of the Companion AUTO-RECYCLE opt-in
// (`PUT /api/companion/:sessionId/auto-recycle`). Hermetic like companion-recycle-rest.mjs: temp LOOM_HOME + a
// REAL Db + the REAL buildServer (app.inject), pty/sessions stubbed. NO network, NO claude, NO daemon. Proves:
//   1. PUT {autoRecycleOnExhaustion:true|false} -> 200, persisted, and the masked config read reports it.
//   2. Default OFF: a configured Companion reads autoRecycleOnExhaustion:false until the owner sets it.
//   3. Validation + gating: non-boolean -> 400, unknown session -> 404, non-assistant -> 400, no config row -> 409.
//   4. The ordinary config PUT can neither set nor clear the flag (a body key is ignored; the stored value survives).
//   5. Trust tier: the PUT is Tier 0 (same as the lead-mode writer), never listed as a Tier-1 read.
// Run: 1) build (turbo builds shared first), 2) node test/companion-auto-recycle-rest.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-cmp-autorecycle-rest-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { routeTier } = await import("../dist/gateway/trust-tier.js");

const db = new Db(path.join(tmpHome, "loom.db"));
const now = new Date().toISOString();
const projId = randomUUID();
db.insertProject({ id: projId, name: "AutoRecycle REST", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
function seed(role, name, position) {
  const agentId = randomUUID();
  db.insertAgent({ id: agentId, projectId: projId, name, startupPrompt: "", position, profileId: null, endpoint: false, ioSchema: null });
  const id = randomUUID();
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: `eng-${name}`, title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role,
  });
  return id;
}
const configured = seed("assistant", "Configured", 0);
const unconfigured = seed("assistant", "Unconfigured", 1);
const worker = seed("worker", "Worker", 2);
const UNKNOWN = randomUUID();
db.upsertCompanionConfig({
  sessionId: configured, botTokenBlob: "", channel: "telegram", allowedChatId: "1", chatScope: "dm",
  heartbeatIntervalMinutes: 0, heartbeatPrompt: null, enabled: true,
});

const stub = {};
const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
const put = (id, body) => app.inject({ method: "PUT", url: `/api/companion/${id}/auto-recycle`, payload: body, headers: { "content-type": "application/json" } });
const masked = async (id) => JSON.parse((await app.inject({ method: "GET", url: `/api/companion/config/${id}` })).payload);
try {
  // ---- 2. default OFF ----
  check("(2) default: the masked config read reports autoRecycleOnExhaustion:false", (await masked(configured)).autoRecycleOnExhaustion === false);

  // ---- 1. set / clear ----
  {
    const res = await put(configured, { autoRecycleOnExhaustion: true });
    const body = JSON.parse(res.payload);
    check("(1) PUT true -> 200 echoing the value", res.statusCode === 200 && body.sessionId === configured && body.autoRecycleOnExhaustion === true);
    check("(1) …persisted in the DB and reported by the masked config read", db.getCompanionConfig(configured).autoRecycleOnExhaustion === true && (await masked(configured)).autoRecycleOnExhaustion === true);
    const off = await put(configured, { autoRecycleOnExhaustion: false });
    check("(1) PUT false -> 200 and persisted", off.statusCode === 200 && db.getCompanionConfig(configured).autoRecycleOnExhaustion === false);
  }

  // ---- 3. validation + gating ----
  {
    db.setCompanionAutoRecycle(configured, true);
    for (const [label, body] of [["a string", { autoRecycleOnExhaustion: "true" }], ["a number", { autoRecycleOnExhaustion: 1 }], ["missing", {}], ["null", { autoRecycleOnExhaustion: null }]]) {
      const res = await put(configured, body);
      check(`(3) non-boolean (${label}) -> 400 and the stored value is unchanged`, res.statusCode === 400 && db.getCompanionConfig(configured).autoRecycleOnExhaustion === true);
    }
    check("(3) unknown sessionId -> 404", (await put(UNKNOWN, { autoRecycleOnExhaustion: true })).statusCode === 404);
    check("(3) a non-assistant (worker) session -> 400", (await put(worker, { autoRecycleOnExhaustion: true })).statusCode === 400);
    const noCfg = await put(unconfigured, { autoRecycleOnExhaustion: true });
    check("(3) a Companion with no run config -> 409 and NO config row is invented", noCfg.statusCode === 409 && db.getCompanionConfig(unconfigured) === undefined);
  }

  // ---- 4. the ordinary config PUT cannot touch the flag ----
  {
    db.setCompanionAutoRecycle(configured, true);
    const res = await app.inject({
      method: "PUT", url: `/api/companion/config/${configured}`, headers: { "content-type": "application/json" },
      payload: { autoRecycleOnExhaustion: false, heartbeatIntervalMinutes: 15 },
    });
    check("(4) PUT /api/companion/config/:id with the key in its body: accepted but the flag SURVIVES (still true)",
      res.statusCode === 200 && db.getCompanionConfig(configured).autoRecycleOnExhaustion === true && db.getCompanionConfig(configured).heartbeatIntervalMinutes === 15);
    db.setCompanionAutoRecycle(configured, false);
    await app.inject({
      method: "PUT", url: `/api/companion/config/${configured}`, headers: { "content-type": "application/json" },
      payload: { autoRecycleOnExhaustion: true, heartbeatIntervalMinutes: 20 },
    });
    check("(4) …and the ordinary config PUT cannot SET it either (still false)", db.getCompanionConfig(configured).autoRecycleOnExhaustion === false);
  }

  // ---- 5. trust tier ----
  check("(5) PUT /api/companion/:sessionId/auto-recycle is Tier 0 (a writer; same tier as the lead-mode writer)",
    routeTier("PUT", "/api/companion/:sessionId/auto-recycle") === 0 && routeTier("PUT", "/api/companion/:sessionId/lead-mode") === 0);
  check("(5-control) the tier function does discriminate: the lead-mode GET read is Tier 1", routeTier("GET", "/api/companion/:sessionId/lead-mode") === 1);
} finally {
  try { await app.close(); } catch { /* ignore */ }
}

db.close();
cleanupPathSync(tmpHome);
console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
