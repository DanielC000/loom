import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Owner-controlled encrypted credential store (agent-tooling epic, P1 foundation, card ba8ecb06).
// SECURITY-CRITICAL, fully hermetic: a REAL Db on a temp LOOM_HOME + the REAL envelope key file (under the
// temp home) + the REAL buildServer (app.inject) + the REAL agent-facing config validator + the REAL MCP
// routers (setup/orchestration) instantiated in-process. NO live network, NO real claude, NO daemon.
//
// Covers the card's DoD:
//   1. round-trip + encryption-at-rest: the stored blob is CIPHERTEXT (plaintext absent), decrypts
//      internally via getSecretForUse, but list/get metadata NEVER carries the secret in any shape.
//   2. the human-only REST CRUD via the REAL buildServer: POST(create)→GET(list)→DELETE(revoke), the
//      secret never appears in ANY response body, and validation 400s leave no row.
//   3. the agent-facing config validator REJECTS a `connections` key (it's not a project-config field —
//      connections are daemon-global — so BOTH the human and agent validators reject it identically).
//   4. HUMAN-ONLY: no MCP tool (setup / orchestration manager+worker+assistant / platform, each checked by
//      a live buildServer()+listTools() scan) exposes a connection tool, name, or description.
// Run: 1) build (turbo builds shared first), 2) node test/connections-store.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-connections-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const {
  listConnections, getConnectionMetadata, createConnection, deleteConnection, getSecretForUse,
  CONNECTION_NAME_MAX, CONNECTION_HOST_MAX, CONNECTION_SECRET_MAX,
} = await import("../dist/connections/store.js");
const { decryptSecret } = await import("../dist/keys/envelope.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { validateAgentProjectConfigOverride, validateProjectConfigOverride } = await import("../dist/mcp/platform.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

const dbFile = (name) => path.join(tmpHome, name);
// A distinctive plaintext secret used throughout — its presence in ANY response body/blob is a hard failure.
const PLAINTEXT = "ghp_DO-NOT-LEAK-this-secret-abcdefghijklmnop";

try {
  // ============ Part 1 — round-trip + encryption at rest + metadata-only reads ============
  {
    const db = new Db(dbFile("p1.db"));
    check("default-off: pristine db has NO connections", db.listConnections().length === 0);
    check("default-off: getConnection(any) is undefined", db.getConnection("nope") === undefined);

    const created = createConnection(db, { name: "GitHub PAT", host: "api.github.com", authScheme: "bearer", secret: PLAINTEXT });
    check("create: returns metadata with an id", typeof created.id === "string" && created.id.length > 0);
    check("create: metadata carries name/host/authScheme/createdAt", created.name === "GitHub PAT" && created.host === "api.github.com" && created.authScheme === "bearer" && !!created.createdAt);
    check("create: returned metadata has NO secret-shaped key", !("secret" in created) && !("secretBlob" in created));
    check("create: returned metadata JSON does not contain the plaintext", !JSON.stringify(created).includes(PLAINTEXT));

    // The RAW stored row is ciphertext, not plaintext.
    const row = db.getConnection(created.id);
    check("at-rest: stored blob is NOT the plaintext secret", row.secretBlob !== PLAINTEXT);
    check("at-rest: stored blob does NOT contain the plaintext substring", !row.secretBlob.includes(PLAINTEXT));
    check("at-rest: stored blob is a v1 envelope", row.secretBlob.startsWith("v1:"));
    check("at-rest: decrypts internally back to the exact secret (envelope helper)", decryptSecret(row.secretBlob) === PLAINTEXT);

    // The store's own decrypt seam (unused anywhere in P1) round-trips correctly.
    check("getSecretForUse: decrypts to the exact plaintext", getSecretForUse(db, created.id) === PLAINTEXT);
    check("getSecretForUse: unknown id -> undefined (never throws)", getSecretForUse(db, "nope") === undefined);

    // Metadata reads (list/get) NEVER carry the secret in any shape.
    const list = listConnections(db);
    check("list: one entry", list.length === 1);
    const listJson = JSON.stringify(list);
    check("list: JSON has no secret-shaped key", !listJson.includes("secret") && !listJson.includes("v1:"));
    check("list: JSON does not contain the plaintext", !listJson.includes(PLAINTEXT));
    const got = getConnectionMetadata(db, created.id);
    check("get: metadata round-trips", got && got.id === created.id && got.name === "GitHub PAT");
    check("get: unknown id -> undefined", getConnectionMetadata(db, "nope") === undefined);

    // A second create with a DIFFERENT key path (test seam) uses a distinct key, proving the envelope's
    // keyPath parameter is genuinely threaded through (swappable-backend seam, not hardcoded).
    const altKeyPath = path.join(tmpHome, "keys", "alt-connections.key");
    const created2 = createConnection(db, { name: "Alt", host: "example.com", authScheme: "api-key", secret: "alt-secret-xyz" }, altKeyPath);
    check("alt keyPath: round-trips under its own key file", getSecretForUse(db, created2.id, altKeyPath) === "alt-secret-xyz");
    check("alt keyPath: created a distinct key file", fs.existsSync(altKeyPath));

    // The store's OWN validation is the structural backstop (item 2 hardening): a caller that skips its
    // own pre-validation (e.g. a future P2 caller) still can't persist an invalid/oversized connection —
    // createConnection THROWS regardless of caller, and no row is ever written on a rejected input.
    const countBefore = db.listConnections().length;
    const throwsFor = (label, input) => {
      let threw = false;
      try { createConnection(db, input); } catch { threw = true; }
      check(`store backstop: ${label} -> throws`, threw);
    };
    throwsFor("blank name", { name: "", host: "h.example", authScheme: "bearer", secret: "s" });
    throwsFor("oversized name", { name: "x".repeat(CONNECTION_NAME_MAX + 1), host: "h.example", authScheme: "bearer", secret: "s" });
    throwsFor("oversized host", { name: "n", host: "h".repeat(CONNECTION_HOST_MAX + 1), authScheme: "bearer", secret: "s" });
    throwsFor("invalid authScheme", { name: "n", host: "h.example", authScheme: "oauth2", secret: "s" });
    throwsFor("oversized secret", { name: "n", host: "h.example", authScheme: "bearer", secret: "x".repeat(CONNECTION_SECRET_MAX + 1) });
    check("store backstop: none of the rejected inputs wrote a row", db.listConnections().length === countBefore);

    deleteConnection(db, created.id);
    check("delete: row gone", db.getConnection(created.id) === undefined);
    check("delete: unknown id is idempotent (no throw)", (() => { try { deleteConnection(db, "nope"); return true; } catch { return false; } })());

    db.close();
  }

  // ============ Part 2 — the human-only REST CRUD via the REAL buildServer (app.inject) ============
  {
    const db = new Db(dbFile("p2.db"));
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
    const bodies = []; // every response body — swept for the plaintext at the end.
    const inject = async (opts) => { const r = await app.inject(opts); bodies.push(r.payload); return r; };

    const list0 = await inject({ method: "GET", url: "/api/connections" });
    check("REST GET: empty list before any create", list0.statusCode === 200 && JSON.parse(list0.payload).length === 0);

    const create = await inject({ method: "POST", url: "/api/connections", payload: {
      name: "Slack webhook", host: "hooks.slack.com", authScheme: "api-key", secret: PLAINTEXT,
    } });
    const createdBody = JSON.parse(create.payload);
    check("REST POST: create -> 201 metadata", create.statusCode === 201 && createdBody.name === "Slack webhook" && createdBody.host === "hooks.slack.com" && createdBody.authScheme === "api-key");
    check("REST POST: create response has NO secret field", !("secret" in createdBody) && !("secretBlob" in createdBody));
    check("REST POST: create body has NO plaintext secret", !create.payload.includes(PLAINTEXT));
    const storedRow = db.getConnection(createdBody.id);
    check("REST POST: stored blob is encrypted (decrypts to the secret, plaintext not stored)", storedRow.secretBlob !== PLAINTEXT && decryptSecret(storedRow.secretBlob) === PLAINTEXT);

    const getList = await inject({ method: "GET", url: "/api/connections" });
    const listBody = JSON.parse(getList.payload);
    check("REST GET list: one metadata row", getList.statusCode === 200 && listBody.length === 1 && listBody[0].id === createdBody.id);
    check("REST GET list: no secret field on any row", listBody.every((r) => !("secret" in r) && !("secretBlob" in r)));

    // Validation 400s — none of these write a row.
    check("REST POST: missing name -> 400", (await inject({ method: "POST", url: "/api/connections", payload: { host: "h", authScheme: "bearer", secret: "s" } })).statusCode === 400);
    check("REST POST: missing host -> 400", (await inject({ method: "POST", url: "/api/connections", payload: { name: "n", authScheme: "bearer", secret: "s" } })).statusCode === 400);
    check("REST POST: invalid authScheme -> 400", (await inject({ method: "POST", url: "/api/connections", payload: { name: "n", host: "h", authScheme: "oauth2", secret: "s" } })).statusCode === 400);
    check("REST POST: missing secret -> 400", (await inject({ method: "POST", url: "/api/connections", payload: { name: "n", host: "h", authScheme: "bearer" } })).statusCode === 400);

    // Over-length bounds — prove the boundary (security-relevant limit), not just that a value exists.
    check("REST POST: name over CONNECTION_NAME_MAX -> 400", (await inject({ method: "POST", url: "/api/connections", payload: { name: "x".repeat(CONNECTION_NAME_MAX + 1), host: "h", authScheme: "bearer", secret: "s" } })).statusCode === 400);
    check("REST POST: host over CONNECTION_HOST_MAX -> 400", (await inject({ method: "POST", url: "/api/connections", payload: { name: "n", host: "h".repeat(CONNECTION_HOST_MAX + 1), authScheme: "bearer", secret: "s" } })).statusCode === 400);
    check("REST POST: secret over CONNECTION_SECRET_MAX -> 400", (await inject({ method: "POST", url: "/api/connections", payload: { name: "n", host: "h", authScheme: "bearer", secret: "x".repeat(CONNECTION_SECRET_MAX + 1) } })).statusCode === 400);
    check("REST POST: a rejected create left the count unchanged", db.listConnections().length === 1);

    // DELETE (revoke).
    const del = await inject({ method: "DELETE", url: `/api/connections/${createdBody.id}` });
    check("REST DELETE: -> ok + row gone", del.statusCode === 200 && db.getConnection(createdBody.id) === undefined);
    check("REST DELETE: GET list empty again", JSON.parse((await inject({ method: "GET", url: "/api/connections" })).payload).length === 0);
    check("REST DELETE: unknown id is idempotent (200)", (await inject({ method: "DELETE", url: "/api/connections/whatever" })).statusCode === 200);

    // The plaintext secret appears in NO response body across the whole sequence.
    check("REST: the plaintext secret appears in NO response body", bodies.every((b) => !b.includes(PLAINTEXT)));

    await app.close();
    db.close();
  }

  // ============ Part 3 — the agent-facing config validator rejects a `connections` field ============
  {
    // Connections are DAEMON-GLOBAL, not a per-project ProjectConfigOverride field — so an unknown
    // `connections` key is rejected on BOTH the human and agent validators identically (the strict-zod
    // schema has no such key on either shape). This is the "no config-field write path" half of the DoD.
    const agentResult = validateAgentProjectConfigOverride({ connections: [{ name: "evil", host: "evil.example", authScheme: "bearer", secret: "x" }] });
    check("agent validator: rejects an unknown `connections` key", agentResult.ok === false);
    check("agent validator: rejection names the unknown key", agentResult.ok === false && /connections/.test(agentResult.error));

    const humanResult = validateProjectConfigOverride({ connections: [{ name: "n", host: "h", authScheme: "bearer", secret: "x" }] });
    check("human validator: ALSO rejects `connections` (it's not a project-config field on either path)", humanResult.ok === false);

    // Sanity: a valid override with no `connections` key still passes on the agent path (surgical rejection).
    check("agent validator: an override without `connections` still accepted", validateAgentProjectConfigOverride({ docLint: false }).ok === true);
  }

  // ============ Part 4 — HUMAN-ONLY: no MCP tool (setup / orchestration / platform) exposes connections ============
  {
    const db = new Db(dbFile("p4.db"));
    class SeamHost extends PtyHost {
      createPty() { return { pid: 1, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
      stop() {}
    }
    const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
    const svc = new SessionService(db, host, new OrchestrationControl());
    const orch = new OrchestrationMcpRouter(db, svc);
    const setup = new SetupMcpRouter(db, svc);
    const platform = new PlatformMcpRouter(db, svc);

    const listOf = async (server) => {
      const [clientT, serverT] = InMemoryTransport.createLinkedPair();
      await server.connect(serverT);
      const client = new Client({ name: "connections-test", version: "0" });
      await client.connect(clientT);
      const tools = (await client.listTools()).tools;
      await client.close();
      return tools;
    };

    // NO tool NAME ever mentions "connection" (no purpose-built connection tool exists on any router).
    const mentionsConnectionByName = (tools) => tools.some((t) => /connection/i.test(t.name));
    // A tool DESCRIPTION may mention "connection" ONLY to document that the field is REJECTED (P2 added
    // this to setup/platform's profile_create/profile_update — see profiles/validate.ts's
    // agentProfileKeyError) — never to describe a capability that grants/reads one. A description
    // mentioning "connection" without also signalling rejection would mean a NEW connection-touching
    // capability slipped onto an agent-facing tool, which this still catches.
    const grantsConnectionCapability = (tools) => tools.some((t) => {
      const d = t.description ?? "";
      return /connection/i.test(d) && !/reject|human-only/i.test(d);
    });

    const managerTools = await listOf(orch.buildServer("mgr-1", "manager"));
    check("orchestration (manager): NO tool name mentions 'connection'", !mentionsConnectionByName(managerTools));
    check("orchestration (manager): NO tool description grants a connection capability", !grantsConnectionCapability(managerTools));
    const workerTools = await listOf(orch.buildServer("wkr-1", "worker"));
    check("orchestration (worker): NO tool name mentions 'connection'", !mentionsConnectionByName(workerTools));
    check("orchestration (worker): NO tool description grants a connection capability", !grantsConnectionCapability(workerTools));
    const assistantTools = await listOf(orch.buildServer("assist-1", "assistant"));
    check("orchestration (assistant): NO tool name mentions 'connection'", !mentionsConnectionByName(assistantTools));
    check("orchestration (assistant): NO tool description grants a connection capability", !grantsConnectionCapability(assistantTools));
    const setupTools = await listOf(setup.buildServer());
    check("setup: NO tool name mentions 'connection'", !mentionsConnectionByName(setupTools));
    check("setup: NO tool description grants a connection capability (profile_create/update only REJECT it)", !grantsConnectionCapability(setupTools));

    // PlatformMcpRouter's `buildServer` is TS-`private` (an HTTP-handle()-only entry at the type level),
    // but that's a compile-time annotation only — the compiled method is an ordinary callable at runtime,
    // exactly like OrchestrationMcpRouter's above. Calling it directly gives the SAME live tool-name/
    // description scan as every other router here (no broader, looser raw-source-text scan needed).
    const platformTools = await listOf(platform.buildServer("plat-1"));
    check("platform: NO tool name mentions 'connection'", !mentionsConnectionByName(platformTools));
    check("platform: NO tool description grants a connection capability (profile_create/update only REJECT it)", !grantsConnectionCapability(platformTools));

    db.close();
  }

  console.log(failures === 0
    ? "\n✅ ALL PASS — connections: encrypted at rest (envelope, swappable keyPath seam), metadata-only list/get (secret absent from every shape), human-only REST CRUD (secret never in a response body), the agent+human config validators reject an unknown `connections` field, and no MCP router (setup/orchestration manager+worker+assistant/platform) exposes a connection-granting tool (setup/platform's profile_create/update now document REJECTING the P2 `connections` profile field — see authenticated-request.mjs for that surface's own coverage)."
    : `\n❌ ${failures} FAILURE(S).`);
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL/handle retry (Windows) */ } }
}
process.exit(failures === 0 ? 0 : 1);
