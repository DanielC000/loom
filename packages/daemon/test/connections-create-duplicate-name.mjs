import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 2d8acbea — every connection CREATE route refuses a name already held by another connection (409),
// using the SAME check the edit path uses (assertNameFree: exact, trimmed, case-sensitive match).
// Routes: POST /api/connections (api-key/bearer), POST /api/connections/ssh, POST /api/connections/oauth.
// Hermetic: temp LOOM_HOME, a REAL Db, fastify `inject`, pure-JS ssh fixture keys. No network, no claude.
// Run: build, then node test/connections-create-duplicate-name.mjs
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import path from "node:path";
import fs from "node:fs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = mkdtempManaged("loom-conn-dup-");
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { listConnections } = await import("../dist/connections/store.js");
const { utils: sshUtils } = (await import("ssh2")).default;
const { generateParseableEd25519 } = await import("./_ssh-test-keys.mjs");

const db = new Db(path.join(tmpHome, "dup.db"));
const stub = {};
const app = await buildServer({
  db, pty: { enqueueStdin: () => ({ delivered: true }) }, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
  userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
});
const post = (url, payload) => app.inject({ method: "POST", url, payload });
const count = () => listConnections(db).length;

const key = generateParseableEd25519(sshUtils);
const FP = "SHA256:" + "A".repeat(43);
const apiBody = (name) => ({ name, host: "api.example.com", authScheme: "api-key", secret: "sk-dup-test" });
const sshBody = (name) => ({ name, host: "nas.home.lan", port: 22, user: "loom", privateKey: key.private, hostKeyFingerprint: FP });
const oauthBody = (name) => ({ name, host: "oauth.example.com", provider: "custom", clientId: "cid", clientSecret: "csecret", authUrl: "https://a.example/auth", tokenUrl: "https://a.example/token", scopes: ["read"] });
const routes = [
  ["api-key", "/api/connections", apiBody],
  ["ssh", "/api/connections/ssh", sshBody],
  ["oauth", "/api/connections/oauth", oauthBody],
];

// Seed ONE row per route kind, then try to create each kind under every seeded name (cross-kind too).
for (const [kind, url, body] of routes) {
  const r = await post(url, body(`First ${kind}`));
  check(`${kind}: a fresh name is created (201)`, r.statusCode === 201);
}
const seeded = count();
check("seed: three rows exist", seeded === 3);

for (const [kind, url, body] of routes) {
  const base = count();
  for (const target of ["First api-key", "First ssh", "First oauth", "  First api-key  "]) {
    const r = await post(url, body(target));
    check(`${kind}: creating under existing name ${JSON.stringify(target)} is refused (409)`, r.statusCode === 409 && /already exists/.test(r.json().error));
  }
  check(`${kind}: nothing was persisted by the refused creates`, count() === base);
  // Case-sensitive, matching the edit path's existing behaviour (exact name match).
  const ci = await post(url, body(`first ${kind}`));
  check(`${kind}: a different-CASE name is NOT a collision (edit path is case-sensitive too)`, ci.statusCode === 201);
}

await app.close();
db.close?.();
await finishAndExit(failures);
