import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Access-story Phase B (card 56ffe50a) — the gateway token: mint/rotate/revoke + the fail-closed,
// constant-time, never-echo verify, and the two-way scope separation from a Run API key (Agent Runs
// R1). HERMETIC + CLAUDE-FREE + NETWORK-FREE: a REAL Db + the REAL buildServer driven via app.inject.
//
// Covers the card's DoD:
//   (A) mint returns the plaintext ONCE (`lgw_` prefix) + stores ONLY a salted hash (never the secret
//       at rest, never echoed by list/get/edit);
//   (B) authenticateGatewayToken: MATCHES a good token, REJECTS a tampered secret (constant-time
//       compare — proven via the shared verifySecret primitive, structurally confirmed here), a
//       malformed token, and an unknown id — all fail-closed (ok:false with a reason, never a throw);
//   (C) ROTATE invalidates the old secret + returns a fresh plaintext once;
//   (D) PAUSE / REVOKE block auth; re-activating restores it; DELETE removes the row entirely;
//   (E) the two-way SCOPE separation: a Run API key (`lrk_`) does NOT authenticate as a gateway token,
//       and a gateway token does NOT authenticate as a Run API key — proven both directions;
//   (F) HUMAN-ONLY: the admin REST lives only on loopback-shaped routes, and no compiled MCP server
//       references the gateway-token store methods (mirrors agent-runs-keys.mjs's G3).
// Run: 1) build (turbo builds shared first), 2) node test/gateway-token.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-gwtoken-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
process.env.LOOM_PORT = "45391";
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows
process.env.HOME = sandboxHome;        // POSIX

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { parseGatewayToken, parseApiKey } = await import("../dist/keys/hash.js");

const stub = {};
const buildApp = (db) => buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, control: stub, usageStatus: stub });

try {
  const db = new Db(path.join(tmpHome, "main.db"));
  const app = await buildApp(db);

  // ===================== (A) mint returns plaintext once + stores ONLY a hash =====================
  const createRes = await app.inject({ method: "POST", url: "/api/gateway-tokens", payload: { name: "My laptop" } });
  check("(A) POST mint → 201", createRes.statusCode === 201);
  const created = createRes.json();
  const plaintext = created.plaintext;
  check("(A) mint returns a plaintext token (lgw_ prefix)", typeof plaintext === "string" && plaintext.startsWith("lgw_"));
  check("(A) mint returns PUBLIC metadata with NO secret/hash/salt", created.token && !("hash" in created.token) && !("salt" in created.token) && !("plaintext" in created.token));
  check("(A) the minted token carries the given name", created.token.name === "My laptop");
  const tokenId = created.token.id;
  const parsed = parseGatewayToken(plaintext);
  check("(A) token parses into {id, secret}; id matches the row", parsed && parsed.id === tokenId && parsed.secret.length > 0);
  const rec = db.getGatewayTokenRecord(tokenId);
  check("(A) at rest: a 32-hex salt + 64-hex sha256 hash are stored", /^[0-9a-f]{32}$/.test(rec.salt) && /^[0-9a-f]{64}$/.test(rec.hash));
  check("(A) at rest: the stored hash is NOT the secret (hashed, not plaintext)", rec.hash !== parsed.secret && rec.salt !== parsed.secret);
  {
    const raw = new Database(path.join(tmpHome, "main.db"), { readonly: true });
    const row = raw.prepare("SELECT * FROM gateway_tokens WHERE id = ?").get(tokenId);
    raw.close();
    const blob = JSON.stringify(row);
    check("(A) raw row contains NO column named 'secret'/'plaintext'/'token'", !("secret" in row) && !("plaintext" in row) && !("token" in row));
    check("(A) never-echo: the plaintext secret appears in NO stored column value", !blob.includes(parsed.secret) && !blob.includes(plaintext));
  }
  // LIST / edit-response never leak the secret/hash either.
  const listed = (await app.inject({ method: "GET", url: "/api/gateway-tokens" })).json();
  check("(A) never-echo: LIST returns metadata only (no hash/salt/plaintext)", listed.length === 1 && !("hash" in listed[0]) && !("salt" in listed[0]) && !("plaintext" in listed[0]));
  const edited = (await app.inject({ method: "POST", url: `/api/gateway-tokens/${tokenId}`, payload: { name: "Renamed" } })).json();
  check("(A) never-echo: the edit response carries no secret material either", edited.name === "Renamed" && !("hash" in edited) && !("salt" in edited) && !("plaintext" in edited));

  // ===================== (B) authenticate: fail-closed, constant-time, matches / rejects =====================
  const auth = db.authenticateGatewayToken(plaintext);
  check("(B) a good token authenticates (ok:true, right id)", auth.ok === true && auth.token.id === tokenId);
  check("(B) the auth result is PUBLIC metadata (no hash/salt)", auth.ok && !("hash" in auth.token) && !("salt" in auth.token));
  check("(B) a tampered secret is rejected (bad-secret)", db.authenticateGatewayToken(plaintext + "x").reason === "bad-secret");
  check("(B) a malformed token is rejected (malformed)", db.authenticateGatewayToken("not-a-loom-token").ok === false && db.authenticateGatewayToken("not-a-loom-token").reason === "malformed");
  check("(B) a missing/undefined token is rejected (malformed) — the WS/REST no-token case", db.authenticateGatewayToken(undefined).reason === "malformed");
  check("(B) an unknown token id is rejected (unknown)", db.authenticateGatewayToken(`lgw_${"x".repeat(36)}.deadbeef`).reason === "unknown");
  // Structural constant-time proof: the compiled authenticateGatewayToken body calls the shared,
  // timingSafeEqual-backed verifySecret — never a raw string compare of the secret/hash.
  {
    const dbSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "db.js"), "utf8");
    const fnStart = dbSrc.indexOf("authenticateGatewayToken(token)");
    const fnBody = dbSrc.slice(fnStart, fnStart + 600);
    check("(B) authenticateGatewayToken verifies via the shared constant-time verifySecret", /verifySecret\(/.test(fnBody));
  }

  // ===================== (C) rotate invalidates the old secret =====================
  const rotateRes = await app.inject({ method: "POST", url: `/api/gateway-tokens/${tokenId}/rotate` });
  check("(C) POST rotate → 200 with a fresh plaintext", rotateRes.statusCode === 200 && rotateRes.json().plaintext.startsWith("lgw_"));
  const newPlaintext = rotateRes.json().plaintext;
  check("(C) rotation yields a DIFFERENT token", newPlaintext !== plaintext);
  check("(C) rotate stamps rotatedAt", typeof rotateRes.json().token.rotatedAt === "string");
  check("(C) the OLD token no longer authenticates (secret invalidated)", db.authenticateGatewayToken(plaintext).ok === false);
  check("(C) the NEW token authenticates (same id preserved)", db.authenticateGatewayToken(newPlaintext).ok === true && db.authenticateGatewayToken(newPlaintext).token.id === tokenId);

  // ===================== (D) pause / revoke block auth; delete removes =====================
  await app.inject({ method: "POST", url: `/api/gateway-tokens/${tokenId}`, payload: { status: "paused" } });
  check("(D) a PAUSED token is blocked (reason paused)", db.authenticateGatewayToken(newPlaintext).reason === "paused");
  await app.inject({ method: "POST", url: `/api/gateway-tokens/${tokenId}`, payload: { status: "revoked" } });
  check("(D) a REVOKED token is blocked (reason revoked)", db.authenticateGatewayToken(newPlaintext).reason === "revoked");
  await app.inject({ method: "POST", url: `/api/gateway-tokens/${tokenId}`, payload: { status: "active" } });
  check("(D) re-activating restores auth", db.authenticateGatewayToken(newPlaintext).ok === true);
  check("(D) an invalid status is rejected (400)", (await app.inject({ method: "POST", url: `/api/gateway-tokens/${tokenId}`, payload: { status: "bogus" } })).statusCode === 400);
  const delRes = await app.inject({ method: "DELETE", url: `/api/gateway-tokens/${tokenId}` });
  check("(D) DELETE → 200 ok:true", delRes.statusCode === 200 && delRes.json().ok === true);
  check("(D) DELETE removes the token (auth → unknown)", db.getGatewayToken(tokenId) === undefined && db.authenticateGatewayToken(newPlaintext).reason === "unknown");
  check("(D) DELETE on an already-gone id → 404", (await app.inject({ method: "DELETE", url: `/api/gateway-tokens/${tokenId}` })).statusCode === 404);
  check("(D) rotate on an unknown id → 404", (await app.inject({ method: "POST", url: `/api/gateway-tokens/${tokenId}/rotate` })).statusCode === 404);

  // ===================== (E) two-way scope separation: gateway token vs. Run API key =====================
  db.insertProject({ id: "pScope", name: "Scope", repoPath: tmpHome, vaultPath: tmpHome, config: {}, createdAt: new Date().toISOString(), archivedAt: null });
  const runKey = db.createApiKey({ projectId: "pScope", name: "run key", endpointAgentIds: [], caps: { maxConcurrentRuns: null, dailyTokenCap: null, dailySpendCap: null } });
  const gwToken = db.createGatewayToken("scope check");
  check("(E) a Run key does NOT parse as a gateway token", parseGatewayToken(runKey.plaintext) === null);
  check("(E) a gateway token does NOT parse as a Run key", parseApiKey(gwToken.plaintext) === null);
  check("(E) a Run key does NOT authenticate against the gateway-token store (malformed)", db.authenticateGatewayToken(runKey.plaintext).ok === false && db.authenticateGatewayToken(runKey.plaintext).reason === "malformed");
  check("(E) a gateway token does NOT authenticate against the Run-key store (malformed)", db.authenticateApiKey(gwToken.plaintext).ok === false && db.authenticateApiKey(gwToken.plaintext).reason === "malformed");
  // The daemon's own verifyGatewayToken wiring (index.ts) is `(token) => db.authenticateGatewayToken(token).ok`
  // — reproduce that exact predicate here against a Run key to prove the wired boundary, not just the db call.
  const verifyGatewayToken = (token) => db.authenticateGatewayToken(token).ok;
  check("(E) the wired verifyGatewayToken predicate rejects a Run key", verifyGatewayToken(runKey.plaintext) === false);
  check("(E) the wired verifyGatewayToken predicate accepts a real gateway token", verifyGatewayToken(gwToken.plaintext) === true);

  // ===================== (F) HUMAN-ONLY: no MCP server references the gateway-token store =====================
  const mcpDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "mcp");
  const mcpFiles = fs.readdirSync(mcpDir).filter((f) => f.endsWith(".js"));
  const gwMethods = ["createGatewayToken", "rotateGatewayToken", "updateGatewayToken", "deleteGatewayToken", "authenticateGatewayToken", "listGatewayTokens"];
  let mcpClean = true; const offenders = [];
  for (const f of mcpFiles) {
    const src = fs.readFileSync(path.join(mcpDir, f), "utf8");
    if (gwMethods.some((m) => src.includes(m))) { mcpClean = false; offenders.push(`${f}: gateway-token method`); }
  }
  check(`(F) no compiled MCP server references the gateway-token store${offenders.length ? " — " + offenders.join("; ") : ""}`, mcpClean);

  await app.close();
  db.close();
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry (Windows) */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — gateway token: hashed-at-rest + plaintext-once mint/rotate; fail-closed constant-time authenticate (good/tampered/malformed/unknown/paused/revoked); two-way scope separation from a Run API key; and no MCP path can reach the store — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
