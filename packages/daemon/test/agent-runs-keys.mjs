import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Agent Runs R1 (GATE) — the `endpoint` agent flag + the project-scoped, hashed-at-rest, human-only
// API-key store + its loopback REST admin. HERMETIC + CLAUDE-FREE + NETWORK-FREE: a REAL Db, the REAL
// buildServer driven via app.inject, and a REAL SessionService against a FAKE pty (the createPty seam).
// NO run execution exists yet (no /api/runs, no run kind) — R1 builds ONLY the flag + the key store.
//
// Covers the card's DoD exactly:
//   (A) the agents migration is ADDITIVE + IDEMPOTENT — a pre-`endpoint` DB backfills agents to
//       endpoint=false on open, and re-opening neither double-applies nor loses data;
//   (B) key CREATE returns the plaintext ONCE and stores ONLY a salted hash (never the secret at rest);
//   (C) authenticate MATCHES a good key + REJECTS a bad secret / malformed / unknown token;
//   (D) the endpoint-agent ALLOWLIST rejects a non-endpoint (or wrong-project) agent;
//   (E) ROTATE invalidates the old secret (old token stops authing; new token auths);
//   (F) REVOKE / PAUSE block auth (and re-activating restores it);
//   (G) the HUMAN-ONLY invariant — the endpoint flip + key admin live ONLY on the loopback REST; NO
//       MCP path can flip endpoint (proven behaviorally on the MCP-reachable updateAgentPreset) and NO
//       MCP server carries a key tool (proven structurally over the compiled mcp/*.js).
// Run: 1) build (turbo builds shared first), 2) node test/agent-runs-keys.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME (host.ts opens a per-session log dir) + a sandboxed HOME so nothing reads the real
// ~/.claude / ~/.loom. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import time).
const tmpHome = path.join(os.tmpdir(), `loom-arkeys-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45390";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows
process.env.HOME = sandboxHome;        // POSIX
const repo = path.join(tmpHome, "repo");
fs.mkdirSync(repo, { recursive: true });

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { parseApiKey } = await import("../dist/keys/hash.js");

const now = new Date().toISOString();
const stub = {};
const buildApp = (db) => buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });

try {
  // ===================== (A) migration ADDITIVE + IDEMPOTENT =====================
  // Hand-craft a PRE-endpoint DB: an `agents` table missing the endpoint/io_schema columns, with a row.
  const legacyFile = path.join(tmpHome, "legacy.db");
  {
    const raw = new Database(legacyFile);
    raw.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, repo_path TEXT NOT NULL,
        vault_path TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, archived_at TEXT);
      CREATE TABLE agents (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
        startup_prompt TEXT NOT NULL DEFAULT '', position INTEGER NOT NULL DEFAULT 0, profile_id TEXT);
    `);
    raw.prepare("INSERT INTO projects (id,name,repo_path,vault_path,created_at) VALUES (?,?,?,?,?)").run("pLegacy", "Legacy", repo, repo, now);
    raw.prepare("INSERT INTO agents (id,project_id,name,startup_prompt,position) VALUES (?,?,?,?,?)").run("aLegacy", "pLegacy", "Legacy Agent", "hi", 0);
    raw.close();
  }
  // Open with the real Db → migrateAgents() ADD COLUMNs endpoint(default 0)+io_schema; backfills the row.
  let dbL = new Db(legacyFile);
  const migrated = dbL.getAgent("aLegacy");
  check("(A) pre-existing agent backfills to endpoint=false", migrated.endpoint === false);
  check("(A) pre-existing agent backfills io_schema to null", migrated.ioSchema === null);
  check("(A) the rest of the legacy row is preserved (name/prompt intact)", migrated.name === "Legacy Agent" && migrated.startupPrompt === "hi");
  // A key created on the migrated DB survives a re-open (idempotent migration doesn't wipe data).
  const persistKey = dbL.createApiKey({ projectId: "pLegacy", name: "persist", endpointAgentIds: [], caps: { maxConcurrentRuns: null, dailyTokenCap: null, dailySpendCap: null } });
  dbL.close();
  // Re-open TWICE more → migration is a no-op (no throw), the agent is unchanged, the key still there.
  dbL = new Db(legacyFile); dbL.close();
  dbL = new Db(legacyFile);
  check("(A) re-opening the migrated DB does not throw or re-default the agent", dbL.getAgent("aLegacy").endpoint === false);
  check("(A) data survives re-open (the key persisted across the idempotent migration)", !!dbL.getApiKey(persistKey.key.id));
  dbL.close();
  // The agents table has EXACTLY ONE endpoint column after repeated opens (no duplicate ADD COLUMN).
  {
    const raw = new Database(legacyFile, { readonly: true });
    const cols = raw.prepare("PRAGMA table_info(agents)").all().map((c) => c.name);
    raw.close();
    check("(A) idempotent: exactly one `endpoint` column", cols.filter((c) => c === "endpoint").length === 1);
    check("(A) idempotent: exactly one `io_schema` column", cols.filter((c) => c === "io_schema").length === 1);
  }

  // ===================== shared fixture for B–G: a fresh DB + project + endpoint/non-endpoint agents =====================
  const db = new Db(path.join(tmpHome, "main.db"));
  db.insertProject({ id: "pMain", name: "Main", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null });
  // A brand-new agent inserted WITHOUT endpoint set defaults to false (additive at the insert path too).
  db.insertAgent({ id: "aPlain", projectId: "pMain", name: "Plain Build Agent", startupPrompt: "", position: 0, profileId: null });
  check("(B-pre) a freshly-inserted agent defaults endpoint=false", db.getAgent("aPlain").endpoint === false);
  // An endpoint agent (the only kind eligible for a key allowlist).
  db.insertAgent({ id: "aEndpoint", projectId: "pMain", name: "Market Analysis", startupPrompt: "analyze", position: 1, profileId: null, endpoint: true, ioSchema: { type: "object" } });
  check("(B-pre) an endpoint agent round-trips endpoint=true + ioSchema", db.getAgent("aEndpoint").endpoint === true && db.getAgent("aEndpoint").ioSchema?.type === "object");

  const app = await buildApp(db);

  // ===================== (B) key CREATE returns plaintext once + stores ONLY a hash =====================
  const createRes = await app.inject({
    method: "POST", url: "/api/projects/pMain/keys",
    payload: { name: "Invest app", endpointAgentIds: ["aEndpoint"], caps: { maxConcurrentRuns: 3, dailyTokenCap: 1_000_000, dailySpendCap: 25 } },
  });
  check("(B) POST create → 201", createRes.statusCode === 201);
  const created = createRes.json();
  const plaintext = created.plaintext;
  check("(B) create returns a plaintext token (lrk_ prefix)", typeof plaintext === "string" && plaintext.startsWith("lrk_"));
  check("(B) create returns PUBLIC metadata with NO secret/hash/salt", created.key && !("hash" in created.key) && !("salt" in created.key) && !("plaintext" in created.key));
  check("(B) created key persisted the allowlist + caps", JSON.stringify(created.key.endpointAgentIds) === JSON.stringify(["aEndpoint"]) && created.key.caps.maxConcurrentRuns === 3);
  const keyId = created.key.id;
  // The secret is the part after the embedded id; assert it is NOWHERE at rest.
  const parsed = parseApiKey(plaintext);
  check("(B) token parses into {id, secret}; id matches the row", parsed && parsed.id === keyId && parsed.secret.length > 0);
  const rec = db.getApiKeyRecord(keyId);
  check("(B) at rest: a 32-hex salt + 64-hex sha256 hash are stored", /^[0-9a-f]{32}$/.test(rec.salt) && /^[0-9a-f]{64}$/.test(rec.hash));
  check("(B) at rest: the stored hash is NOT the secret (hashed, not plaintext)", rec.hash !== parsed.secret && rec.salt !== parsed.secret);
  // Raw row scan: the secret must appear in NO column value on disk.
  {
    const raw = new Database(path.join(tmpHome, "main.db"), { readonly: true });
    const row = raw.prepare("SELECT * FROM api_keys WHERE id = ?").get(keyId);
    raw.close();
    const blob = JSON.stringify(row);
    check("(B) raw row contains NO column named 'secret'/'plaintext'/'token'", !("secret" in row) && !("plaintext" in row) && !("token" in row));
    check("(B) the plaintext secret appears in NO stored column value", !blob.includes(parsed.secret) && !blob.includes(plaintext));
  }
  // LIST never leaks the secret/hash either.
  const listed = (await app.inject({ method: "GET", url: "/api/projects/pMain/keys" })).json();
  check("(B) LIST returns the key as metadata only (no hash/salt)", listed.length === 1 && !("hash" in listed[0]) && !("salt" in listed[0]));

  // ===================== (C) authenticate matches good / rejects bad =====================
  const auth = db.authenticateApiKey(plaintext);
  check("(C) a good token authenticates (ok:true, right key)", auth.ok === true && auth.key.id === keyId);
  check("(C) the auth result is PUBLIC metadata (no hash/salt)", auth.ok && !("hash" in auth.key) && !("salt" in auth.key));
  check("(C) a tampered secret is rejected (bad-secret)", db.authenticateApiKey(plaintext + "x").reason === "bad-secret");
  check("(C) a malformed token is rejected (malformed)", db.authenticateApiKey("not-a-loom-key").ok === false && db.authenticateApiKey("not-a-loom-key").reason === "malformed");
  check("(C) an unknown key id is rejected (unknown)", db.authenticateApiKey(`lrk_${"x".repeat(36)}.deadbeef`).reason === "unknown");

  // ===================== (D) allowlist rejects a non-endpoint (or wrong-project) agent =====================
  const badAllow = await app.inject({ method: "POST", url: "/api/projects/pMain/keys", payload: { name: "bad", endpointAgentIds: ["aPlain"] } });
  check("(D) create with a NON-endpoint agent on the allowlist → 400", badAllow.statusCode === 400);
  check("(D) the 400 names the offending agent", /aPlain/.test(badAllow.json().error ?? ""));
  check("(D) db.validateEndpointAllowlist rejects a non-endpoint agent", db.validateEndpointAllowlist("pMain", ["aPlain"]).ok === false);
  check("(D) db.validateEndpointAllowlist accepts an endpoint agent", db.validateEndpointAllowlist("pMain", ["aEndpoint"]).ok === true);
  check("(D) db.validateEndpointAllowlist rejects a wrong-project / unknown id", db.validateEndpointAllowlist("pMain", ["aLegacy"]).ok === false);
  // editing an existing key's allowlist with a non-endpoint agent is also rejected.
  const badEdit = await app.inject({ method: "POST", url: `/api/keys/${keyId}`, payload: { endpointAgentIds: ["aPlain"] } });
  check("(D) editing a key's allowlist with a non-endpoint agent → 400", badEdit.statusCode === 400);

  // ===================== (E) rotate invalidates the old secret =====================
  const rotateRes = await app.inject({ method: "POST", url: `/api/keys/${keyId}/rotate` });
  check("(E) POST rotate → 200 with a fresh plaintext", rotateRes.statusCode === 200 && rotateRes.json().plaintext.startsWith("lrk_"));
  const newPlaintext = rotateRes.json().plaintext;
  check("(E) rotation yields a DIFFERENT token", newPlaintext !== plaintext);
  check("(E) rotate stamps rotatedAt", typeof rotateRes.json().key.rotatedAt === "string");
  check("(E) the OLD token no longer authenticates (secret invalidated)", db.authenticateApiKey(plaintext).ok === false);
  check("(E) the NEW token authenticates (same key id preserved)", db.authenticateApiKey(newPlaintext).ok === true && db.authenticateApiKey(newPlaintext).key.id === keyId);

  // ===================== (F) revoke / pause block auth =====================
  await app.inject({ method: "POST", url: `/api/keys/${keyId}`, payload: { status: "paused" } });
  check("(F) a PAUSED key is blocked (reason paused)", db.authenticateApiKey(newPlaintext).reason === "paused");
  await app.inject({ method: "POST", url: `/api/keys/${keyId}`, payload: { status: "revoked" } });
  check("(F) a REVOKED key is blocked (reason revoked)", db.authenticateApiKey(newPlaintext).reason === "revoked");
  await app.inject({ method: "POST", url: `/api/keys/${keyId}`, payload: { status: "active" } });
  check("(F) re-activating restores auth", db.authenticateApiKey(newPlaintext).ok === true);
  // DELETE permanently removes the key (then auth → unknown).
  await app.inject({ method: "DELETE", url: `/api/keys/${keyId}` });
  check("(F) DELETE removes the key (auth → unknown)", db.getApiKey(keyId) === undefined && db.authenticateApiKey(newPlaintext).reason === "unknown");

  // ===================== (G) HUMAN-ONLY invariant =====================
  // (G1) the human REST surface CAN flip the endpoint flag.
  const flip = await app.inject({ method: "POST", url: "/api/agents/aPlain", payload: { endpoint: true, ioSchema: { in: "x" } } });
  check("(G1) REST agent-edit flips endpoint=true (the human surface)", flip.statusCode === 200 && flip.json().endpoint === true && flip.json().ioSchema?.in === "x");
  await app.inject({ method: "POST", url: "/api/agents/aPlain", payload: { endpoint: false, ioSchema: null } }); // full reset for the behavioral test below
  check("(G1) REST agent-edit can clear endpoint back to false", db.getAgent("aPlain").endpoint === false);
  check("(G1) a non-boolean endpoint is rejected (400)", (await app.inject({ method: "POST", url: "/api/agents/aPlain", payload: { endpoint: "yes" } })).statusCode === 400);

  // (G2) the MCP-reachable agent-write path CANNOT flip endpoint, even if a caller smuggles it in the patch.
  class SeamHost extends PtyHost {
    constructor(events) { super(events); this.capture = []; }
    createPty(opts) { this.capture.push(opts); return { pid: 4242, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  }
  const events = {
    onEngineSessionId(id, eng) { db.setEngineSessionId(id, eng); }, onBusy(id, b) { db.setBusy(id, b); },
    onContextStats() {}, onRateLimited() {}, onExit(id) { db.setProcessState(id, "exited"); db.setBusy(id, false); },
  };
  const svc = new SessionService(db, new SeamHost(events), new OrchestrationControl());
  db.insertSession({ id: "mgr1", projectId: "pMain", agentId: "aPlain", engineSessionId: null, title: null, cwd: repo,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
  // updateAgentPreset is what the orchestration `agent_update` MCP tool calls. Smuggle endpoint into the patch.
  svc.updateAgentPreset("mgr1", "aPlain", { name: "Renamed via MCP", startupPrompt: "p", endpoint: true, ioSchema: { hacked: true } });
  const afterMcp = db.getAgent("aPlain");
  check("(G2) the MCP-reachable updateAgentPreset applied its allowed fields (name)", afterMcp.name === "Renamed via MCP");
  check("(G2) ...but could NOT flip endpoint (still false — no MCP path sets it)", afterMcp.endpoint === false);
  check("(G2) ...and could NOT set ioSchema either", afterMcp.ioSchema === null);
  // assignAgentProfile likewise must not touch endpoint.
  svc.assignAgentProfile("mgr1", "aEndpoint", null);
  check("(G2) assignAgentProfile leaves endpoint untouched", db.getAgent("aEndpoint").endpoint === true);

  // (G3) STRUCTURAL: no compiled MCP server references the key-store methods, and none sets endpoint
  // truthy or accepts an `endpoint` input field — so no agent tool can mint/rotate/revoke a key OR
  // publish an agent as an endpoint. (Only the loopback REST does — proven in G1/B–F.)
  const mcpDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "mcp");
  const mcpFiles = fs.readdirSync(mcpDir).filter((f) => f.endsWith(".js"));
  const keyMethods = ["createApiKey", "rotateApiKey", "updateApiKey", "deleteApiKey", "authenticateApiKey", "validateEndpointAllowlist", "listApiKeys"];
  let mcpClean = true; const offenders = [];
  for (const f of mcpFiles) {
    const src = fs.readFileSync(path.join(mcpDir, f), "utf8");
    if (keyMethods.some((m) => src.includes(m))) { mcpClean = false; offenders.push(`${f}: key method`); }
    if (/endpoint:\s*true/.test(src)) { mcpClean = false; offenders.push(`${f}: sets endpoint:true`); }
    if (/endpoint:\s*z\./.test(src)) { mcpClean = false; offenders.push(`${f}: endpoint zod input`); }
  }
  check(`(G3) no compiled MCP server carries a key tool or an endpoint flip${offenders.length ? " — " + offenders.join("; ") : ""}`, mcpClean);

  await app.close();
  db.close();
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry (Windows) */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Agent Runs R1: additive+idempotent endpoint migration; hashed-at-rest keys (plaintext once, secret never stored); good/bad/rotate/pause/revoke auth; endpoint-only allowlist; and the human-only invariant (REST flips endpoint + mints keys; NO MCP path can) — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
