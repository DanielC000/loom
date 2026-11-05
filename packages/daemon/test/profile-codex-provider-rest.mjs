import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 2ef54430 — the HUMAN REST surface for a Profile's codex model-provider endpoint (POST/PUT/GET
// /api/profiles). HERMETIC: temp LOOM_HOME, a REAL Db, fastify `inject` (no listener), no real claude/codex.
// Covers the wiring profile-codex-provider.mjs cannot: that the REST handlers actually CALL the connection
// binding check, persist `v.value` (not req.body), clear on null, and never echo a secret.
// Run: 1) build (turbo builds shared first), 2) node test/profile-codex-provider-rest.mjs
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import path from "node:path";
import fs from "node:fs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = mkdtempManaged("loom-cprov-rest-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { createConnection } = await import("../dist/connections/store.js");

const db = new Db(path.join(tmpHome, "cprov.db"));
const stub = {};
const app = await buildServer({
  db, pty: { enqueueStdin: () => ({ delivered: true }) }, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
  userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
});

const SECRET = "sk-dummy-rest-secret";
const conn = createConnection(db, { name: "Example API", host: "api.example.com", authScheme: "api-key", secret: SECRET });
const connOther = createConnection(db, { name: "Other API", host: "api.other.net", authScheme: "api-key", secret: "sk-other" });
const connOauthLike = createConnection(db, { name: "Bearer API", host: "api.example.com", authScheme: "bearer", secret: "tok" });
const good = { id: "myhost", baseUrl: "https://api.example.com/v1", connectionId: conn.id };

const post = (payload) => app.inject({ method: "POST", url: "/api/profiles", payload });
const put = (id, payload) => app.inject({ method: "PUT", url: `/api/profiles/${id}`, payload });

const r1 = await post({ name: "Provider Rig", role: "worker", harness: "codex", codexProvider: good });
const p1 = r1.json();
check("POST: a matching custom provider is created (201) and echoed back", r1.statusCode === 201 && p1.codexProvider?.connectionId === conn.id);
check("POST: the response and the stored row carry NO secret", !r1.body.includes(SECRET) && !JSON.stringify(db.getProfile(p1.id)).includes(SECRET));
check("GET: the stored provider reads back with its connection REFERENCE", JSON.stringify((await app.inject({ method: "GET", url: `/api/profiles/${p1.id}` })).json().codexProvider) === JSON.stringify(good));

const r2 = await post({ name: "Mismatch Rig", role: "worker", harness: "codex", codexProvider: { ...good, baseUrl: "https://api.evil.example/v1" } });
check("POST: a baseUrl host != the Connection's host is REFUSED (400) and nothing is created", r2.statusCode === 400 && /Connection's host/.test(r2.json().error) && !db.listProfiles().some((p) => p.name === "Mismatch Rig"));
const r3 = await post({ name: "Wrong Conn Rig", role: "worker", harness: "codex", codexProvider: { ...good, connectionId: connOther.id } });
check("POST: a Connection for a different host is refused (400)", r3.statusCode === 400);
const r4 = await post({ name: "Ghost Conn Rig", role: "worker", harness: "codex", codexProvider: { ...good, connectionId: "no-such-connection" } });
check("POST: an unknown connectionId is refused (400)", r4.statusCode === 400 && /no stored Connection/.test(r4.json().error));
check("POST: that 400 says no save can succeed until the provider is fixed or cleared (deleted-connection case)", /no save of this profile can succeed/.test(r4.json().error));
const r5 = await post({ name: "Claude Rig", role: "worker", codexProvider: good });
check("POST: a provider on a non-codex profile is refused (400)", r5.statusCode === 400 && /requires harness "codex"/.test(r5.json().error));
const r6 = await post({ name: "Http Rig", role: "worker", harness: "codex", codexProvider: { ...good, baseUrl: "http://api.example.com/v1" } });
check("POST: plain http to a non-loopback host is refused (400)", r6.statusCode === 400);
const r7 = await post({ name: "Builtin Rig", role: "worker", harness: "codex", codexProvider: { id: "ollama" } });
check("POST: a built-in local provider (no URL, no key) is created", r7.statusCode === 201 && r7.json().codexProvider?.id === "ollama");
const r8 = await post({ name: "Bearer Rig", role: "worker", harness: "codex", codexProvider: { ...good, connectionId: connOauthLike.id } });
check("POST: a bearer connection on the same host is accepted", r8.statusCode === 201);

// PUT: unrelated edit leaves it; switching OFF codex without clearing is refused; null clears.
const u1 = await put(p1.id, { description: "edited" });
check("PUT: an unrelated edit PRESERVES the provider (merge keeps the stored value)", u1.statusCode === 200 && u1.json().codexProvider?.id === "myhost");
const u2 = await put(p1.id, { harness: "claude" });
check("PUT: switching to claude while a provider is stored is REFUSED (400); stored row unchanged", u2.statusCode === 400 && db.getProfile(p1.id).harness === "codex" && !!db.getProfile(p1.id).codexProvider);
const u3 = await put(p1.id, { harness: "claude", codexProvider: null });
check("PUT: harness claude + codexProvider:null succeeds and CLEARS it", u3.statusCode === 200 && db.getProfile(p1.id).codexProvider === undefined && db.getProfile(p1.id).harness === "claude");
const u4 = await put(p1.id, { harness: "codex", codexProvider: { ...good, baseUrl: "https://api.elsewhere.example/v1" } });
check("PUT: a host-mismatched edit is refused (400) and the profile is unchanged", u4.statusCode === 400 && db.getProfile(p1.id).codexProvider === undefined);
const u5 = await put(p1.id, { harness: "codex", codexProvider: good });
const reach = u5.json().grantReach;
check("PUT: re-adding it is a recorded GRANT (grantReach names codexProvider)", u5.statusCode === 200 && Array.isArray(reach?.addedKeys) && reach.addedKeys.includes("codexProvider"));

await app.close();
db.close();
await finishAndExit(failures);
