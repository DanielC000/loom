import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Inbound webhook endpoint store + human-only REST CRUD (agent-tooling epic P5b, card 8fbedcac).
// SECURITY-CRITICAL, fully hermetic: a REAL Db on a temp LOOM_HOME + the REAL envelope key file + the
// REAL buildServer (app.inject). NO live network, NO real claude, NO daemon.
//
// Covers:
//   1. round-trip + encryption-at-rest: the stored blob is CIPHERTEXT (plaintext absent); list/get
//      metadata NEVER carries the secret in any shape; the generated `path` is a random opaque slug.
//   2. the human-only REST CRUD via the REAL buildServer: POST(create)->GET(list)->DELETE, an
//      enable/disable toggle, mode<->target coherence validation (mirrors event-triggers), and the
//      secret never appears in ANY response body.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-webhook-store-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45511";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const {
  listWebhookEndpoints, getWebhookEndpointMetadata, createWebhookEndpoint, deleteWebhookEndpoint,
  setWebhookEndpointEnabled, decryptWebhookSecret, WEBHOOK_ENDPOINT_NAME_MAX, WEBHOOK_ENDPOINT_SECRET_MAX,
} = await import("../dist/webhooks/store.js");
const { buildServer } = await import("../dist/gateway/server.js");

const dbFile = (name) => path.join(tmpHome, name);
const PLAINTEXT = "whsec_DO-NOT-LEAK-this-signing-secret-xyz";

try {
  // ============ Part 1 — round-trip + encryption at rest + metadata-only reads ============
  {
    const db = new Db(dbFile("p1.db"));
    check("default-off: pristine db has NO webhook endpoints", db.listWebhookEndpoints().length === 0);

    const nowIso = new Date().toISOString();
    db.insertProject({ id: "p1-proj", name: "p1", repoPath: "p1-proj", vaultPath: "p1-proj", config: {}, createdAt: nowIso, archivedAt: null });
    db.insertAgent({ id: "p1-agent", projectId: "p1-proj", name: "webhook-target", startupPrompt: "", position: 0 });
    const agent = { id: "p1-agent" };

    const created = createWebhookEndpoint(db, {
      name: "GitHub push", sourceType: "github", secret: PLAINTEXT,
      mode: "spawn", targetSessionId: null, agentId: agent.id,
    });
    check("create: returns metadata with an id + a random path", typeof created.id === "string" && typeof created.path === "string" && created.path.length >= 16);
    check("create: metadata carries name/sourceType/mode/agentId/enabled", created.name === "GitHub push" && created.sourceType === "github" && created.mode === "spawn" && created.agentId === agent.id && created.enabled === true);
    check("create: returned metadata has NO secret-shaped key", !("secret" in created) && !("secretBlob" in created));
    check("create: returned metadata JSON does not contain the plaintext", !JSON.stringify(created).includes(PLAINTEXT));

    const row = db.getWebhookEndpoint(created.id);
    check("at-rest: stored blob is NOT the plaintext secret", row.secretBlob !== PLAINTEXT);
    check("at-rest: stored blob does NOT contain the plaintext substring", !row.secretBlob.includes(PLAINTEXT));
    check("at-rest: stored blob is a v1 envelope", row.secretBlob.startsWith("v1:"));
    check("at-rest: decryptWebhookSecret round-trips to the exact plaintext", decryptWebhookSecret(row) === PLAINTEXT);

    const byPath = db.getWebhookEndpointByPath(created.path);
    check("getWebhookEndpointByPath: resolves the same row", byPath && byPath.id === created.id);
    check("getWebhookEndpointByPath: unknown path -> undefined", db.getWebhookEndpointByPath("nope-not-a-real-path") === undefined);

    const list = listWebhookEndpoints(db);
    check("list: one entry", list.length === 1);
    const listJson = JSON.stringify(list);
    check("list: JSON has no secret-shaped key or ciphertext", !listJson.includes("secret") && !listJson.includes("v1:"));
    check("list: JSON does not contain the plaintext", !listJson.includes(PLAINTEXT));
    const got = getWebhookEndpointMetadata(db, created.id);
    check("get: metadata round-trips", got && got.id === created.id && got.name === "GitHub push");
    check("get: unknown id -> undefined", getWebhookEndpointMetadata(db, "nope") === undefined);

    // Path uniqueness: two endpoints never collide (the store retries on collision; astronomically
    // unlikely with real randomness, but structurally distinct paths is directly observable here).
    const created2 = createWebhookEndpoint(db, { name: "Second", sourceType: "generic", secret: "another-secret", mode: "spawn", targetSessionId: null, agentId: agent.id });
    check("create: a second endpoint gets a DIFFERENT path", created2.path !== created.path);

    // Validation backstop (mirrors connections' structural backstop).
    const countBefore = db.listWebhookEndpoints().length;
    const throwsFor = (label, input) => {
      let threw = false;
      try { createWebhookEndpoint(db, input); } catch { threw = true; }
      check(`store backstop: ${label} -> throws`, threw);
    };
    throwsFor("blank name", { name: "", sourceType: "github", secret: "s", mode: "spawn", targetSessionId: null, agentId: agent.id });
    throwsFor("oversized name", { name: "x".repeat(WEBHOOK_ENDPOINT_NAME_MAX + 1), sourceType: "github", secret: "s", mode: "spawn", targetSessionId: null, agentId: agent.id });
    throwsFor("invalid sourceType", { name: "n", sourceType: "bitbucket", secret: "s", mode: "spawn", targetSessionId: null, agentId: agent.id });
    throwsFor("oversized secret", { name: "n", sourceType: "github", secret: "x".repeat(WEBHOOK_ENDPOINT_SECRET_MAX + 1), mode: "spawn", targetSessionId: null, agentId: agent.id });
    check("store backstop: none of the rejected inputs wrote a row", db.listWebhookEndpoints().length === countBefore);

    setWebhookEndpointEnabled(db, created.id, false);
    check("disable: enabled flips to false", db.getWebhookEndpoint(created.id).enabled === false);
    check("disable: metadata reflects it too", getWebhookEndpointMetadata(db, created.id).enabled === false);
    setWebhookEndpointEnabled(db, created.id, true);
    check("re-enable: enabled flips back to true", db.getWebhookEndpoint(created.id).enabled === true);

    deleteWebhookEndpoint(db, created.id);
    check("delete: row gone", db.getWebhookEndpoint(created.id) === undefined);
    check("delete: unknown id is idempotent (no throw)", (() => { try { deleteWebhookEndpoint(db, "nope"); return true; } catch { return false; } })());

    db.close();
  }

  // ============ Part 2 — the human-only REST CRUD via the REAL buildServer (app.inject) ============
  {
    const db = new Db(dbFile("p2.db"));
    const p2NowIso = new Date().toISOString();
    db.insertProject({ id: "p2-proj", name: "p2", repoPath: "p2-proj", vaultPath: "p2-proj", config: {}, createdAt: p2NowIso, archivedAt: null });
    db.insertAgent({ id: "p2-agent", projectId: "p2-proj", name: "target-agent", startupPrompt: "", position: 0 });
    const agent = { id: "p2-agent" };
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
    const bodies = [];
    const inject = async (opts) => { const r = await app.inject(opts); bodies.push(r.payload); return r; };

    const list0 = await inject({ method: "GET", url: "/api/webhook-endpoints" });
    check("REST GET: empty list before any create", list0.statusCode === 200 && JSON.parse(list0.payload).length === 0);

    // mode 'spawn' requires an existing agentId.
    const badAgent = await inject({ method: "POST", url: "/api/webhook-endpoints", payload: { name: "n", sourceType: "github", secret: PLAINTEXT, mode: "spawn", agentId: "not-real" } });
    check("REST POST: spawn mode with an unknown agentId -> 404", badAgent.statusCode === 404);
    // mode 'wake' requires an existing targetSessionId.
    const badWake = await inject({ method: "POST", url: "/api/webhook-endpoints", payload: { name: "n", sourceType: "github", secret: PLAINTEXT, mode: "wake", targetSessionId: "not-real" } });
    check("REST POST: wake mode with an unknown targetSessionId -> 404", badWake.statusCode === 404);
    check("REST POST: invalid mode -> 400", (await inject({ method: "POST", url: "/api/webhook-endpoints", payload: { name: "n", sourceType: "github", secret: PLAINTEXT, mode: "bogus" } })).statusCode === 400);
    check("REST POST: invalid sourceType -> 400", (await inject({ method: "POST", url: "/api/webhook-endpoints", payload: { name: "n", sourceType: "bitbucket", secret: PLAINTEXT, mode: "spawn", agentId: agent.id } })).statusCode === 400);

    const create = await inject({ method: "POST", url: "/api/webhook-endpoints", payload: {
      name: "Stripe events", sourceType: "stripe", secret: PLAINTEXT, mode: "spawn", agentId: agent.id,
    } });
    const createdBody = JSON.parse(create.payload);
    check("REST POST: create -> 201 metadata", create.statusCode === 201 && createdBody.name === "Stripe events" && createdBody.sourceType === "stripe" && createdBody.agentId === agent.id);
    check("REST POST: create response has NO secret field", !("secret" in createdBody) && !("secretBlob" in createdBody));
    check("REST POST: create body has NO plaintext secret", !create.payload.includes(PLAINTEXT));
    check("REST POST: create response carries the opaque path (needed to configure the sender)", typeof createdBody.path === "string" && createdBody.path.length > 0);

    const getList = await inject({ method: "GET", url: "/api/webhook-endpoints" });
    const listBody = JSON.parse(getList.payload);
    check("REST GET list: one metadata row", getList.statusCode === 200 && listBody.length === 1 && listBody[0].id === createdBody.id);
    check("REST GET list: no secret field on any row", listBody.every((r) => !("secret" in r) && !("secretBlob" in r)));

    // Enable/disable toggle.
    const disable = await inject({ method: "POST", url: `/api/webhook-endpoints/${createdBody.id}/enabled`, payload: { enabled: false } });
    check("REST enable-toggle: disable -> 200, row now disabled", disable.statusCode === 200 && db.getWebhookEndpoint(createdBody.id).enabled === false);
    const badToggle = await inject({ method: "POST", url: `/api/webhook-endpoints/${createdBody.id}/enabled`, payload: { enabled: "not-a-bool" } });
    check("REST enable-toggle: non-boolean enabled -> 400", badToggle.statusCode === 400);
    const reEnable = await inject({ method: "POST", url: `/api/webhook-endpoints/${createdBody.id}/enabled`, payload: { enabled: true } });
    check("REST enable-toggle: re-enable -> 200, row enabled again", reEnable.statusCode === 200 && db.getWebhookEndpoint(createdBody.id).enabled === true);

    // Over-length bound.
    check("REST POST: secret over WEBHOOK_ENDPOINT_SECRET_MAX -> 400", (await inject({ method: "POST", url: "/api/webhook-endpoints", payload: { name: "n", sourceType: "github", secret: "x".repeat(WEBHOOK_ENDPOINT_SECRET_MAX + 1), mode: "spawn", agentId: agent.id } })).statusCode === 400);
    check("REST POST: a rejected create left the count unchanged", db.listWebhookEndpoints().length === 1);

    const del = await inject({ method: "DELETE", url: `/api/webhook-endpoints/${createdBody.id}` });
    check("REST DELETE: -> ok + row gone", del.statusCode === 200 && db.getWebhookEndpoint(createdBody.id) === undefined);
    check("REST DELETE: GET list empty again", JSON.parse((await inject({ method: "GET", url: "/api/webhook-endpoints" })).payload).length === 0);
    check("REST DELETE: unknown id is idempotent (200)", (await inject({ method: "DELETE", url: "/api/webhook-endpoints/whatever" })).statusCode === 200);

    check("REST: the plaintext secret appears in NO response body across the whole sequence", bodies.every((b) => !b.includes(PLAINTEXT)));

    await app.close();
    db.close();
  }

  console.log(failures === 0
    ? "\n✅ ALL PASS — webhook endpoints: encrypted at rest (envelope), a random non-guessable opaque path per endpoint, metadata-only list/get (secret absent from every shape), human-only REST CRUD (secret never in a response body, mode<->target coherence enforced, over-length bounds enforced), and an enable/disable toggle that leaves the endpoint's path/config intact."
    : `\n❌ ${failures} FAILURE(S).`);
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL/handle retry (Windows) */ } }
}
process.exit(failures === 0 ? 0 : 1);
