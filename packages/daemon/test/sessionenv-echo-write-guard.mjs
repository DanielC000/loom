import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card a253cec8: a masked `sessionEnv` RESPONSE is a valid write INPUT. Every config-returning surface
// masks `sessionEnv` VALUES with same-length bullet filler (`maskSessionEnvRecord`, card b2f9ce3a) —
// but feeding that masked response straight back as a write, via a plain deep-merge or a `replace:true`
// payload, silently overwrites the real secret with the filler. Invisible (the masker is idempotent, so
// the response is byte-identical before and after) and unrecoverable (config history masks both prior
// and next too). `setProjectConfigSafe` (tasks/columns.ts) is the ONE chokepoint every config-PATCH
// writer shares (human REST, Platform Lead, Setup Assistant, manager project_update); this test proves
// the reject-on-echo guard there.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic — mirrors project-config-history.mjs's harness
// (a REAL Db + the REAL Fastify gateway + the REAL Platform MCP router, in-process).
//
// Proves:
//   (1) REPRODUCE THE DESTRUCTION'S SHAPE, against current dist: a real secret is written, the write
//       RESPONSE comes back masked, and re-submitting that exact masked value (plain deep-merge) is now
//       REJECTED (400) with the REAL secret left untouched in the DB — the failure this guard closes.
//   (2) The SAME masked-echo, via `replace:true` (the card's second destructive vector), is ALSO rejected.
//   (3) The guard detects the mask SHAPE, not a hardcoded bullet count: it fires the same way for a
//       short secret and a long one.
//   (4) Legitimate writes are NOT broken: a genuine same-length rotation to different real content, a
//       brand-new key whose value happens to be all-filler-char (no prior value to be ambiguous with),
//       and a value that merely CONTAINS the filler character all succeed.
//   (5) The guard covers the REST write path (this whole file) AND the platform MCP `project_configure`
//       path — same chokepoint, so the same masked-echo is rejected on both real writers.
import fs from "node:fs";
import path from "node:path";
import { requireHermeticEnv } from "./_guard.mjs";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

const TMP = mkdtempManaged("loom-sessionenv-echo-");
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = String(hermeticPort());
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const now = new Date().toISOString();
const dbFile = path.join(TMP, "loom.db");
const db = new Db(dbFile);

// Fake pty (the platform router's constructor needs a SessionService; no tool here spawns).
class SeamHost extends createSeamHost(PtyHost) {
  createPty(opts) { return { ...super.createPty(opts), pid: 1 }; }
  stop() {}
}
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());

const parse = (res) => JSON.parse(res.content[0].text);
const connect = async (server) => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "sessionenv-echo-test", version: "0" });
  await client.connect(clientT);
  return async (name, args) => parse(await client.callTool({ name, arguments: args }));
};

// THROWAWAY LITERALS ONLY — never a real credential (per the task's own DoD-3 and CLAUDE.md).
const SECRET_A = "sk-test-throwaway-alpha-0001";
const SECRET_B = "sk-test-throwaway-beta-000002"; // deliberately a different length than SECRET_A
const SECRET_LONG = "sk-test-throwaway-a-much-longer-secret-value-0003";

let app;
try {
  app = await buildServer({ db, pty: {}, sessions: svc, mcp: {}, orchMcp: {}, platformMcp: {}, auditMcp: {}, control: {}, usageStatus: {} });

  // ===================== (1) REPRODUCE THE DESTRUCTION'S SHAPE, then show the guard refuses it =====================
  db.insertProject({ id: "pEcho", name: "Echo", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null, reserved: false });

  // Write a real secret.
  const write1 = await app.inject({ method: "PATCH", url: "/api/projects/pEcho/config", payload: { config: { sessionEnv: { API_KEY: SECRET_A } } } });
  check("(1) real secret write → 200", write1.statusCode === 200);
  const storedAfterWrite1 = db.getProject("pEcho").config.sessionEnv.API_KEY;
  check("(1) the REAL secret is what's actually stored (not masked in the DB)", storedAfterWrite1 === SECRET_A);

  // The write RESPONSE comes back masked (card 0c5d6851's redaction on the config-PATCH route).
  const maskedFromResponse = write1.json().config.sessionEnv.API_KEY;
  check("(1) the write response masks the value to same-length bullet filler", maskedFromResponse === "•".repeat(SECRET_A.length));
  check("(1) ★ CONTROL: the masked response never contains the raw secret", maskedFromResponse !== SECRET_A);

  // Re-submit EXACTLY that masked response as a write (a plain deep-merge — "take what I got back, change
  // a different key" is the natural caller shape the card describes) — THE GUARD MUST REJECT THIS.
  const echoWrite = await app.inject({ method: "PATCH", url: "/api/projects/pEcho/config", payload: { config: { sessionEnv: { API_KEY: maskedFromResponse } } } });
  check("(1) ★★ the masked-echo write is REJECTED, not silently accepted", echoWrite.statusCode === 400);
  check("(1) the rejection names the offending key", echoWrite.json().error.includes("API_KEY"));
  const storedAfterEcho = db.getProject("pEcho").config.sessionEnv.API_KEY;
  check("(1) ★★★ THE REAL SECRET SURVIVES — this is the destruction the card reported, now prevented", storedAfterEcho === SECRET_A);
  check("(1) the stored value was never overwritten with filler", storedAfterEcho !== maskedFromResponse);

  // ===================== (2) the SAME masked-echo via `replace:true` — the card's second destructive vector =====================
  const echoReplace = await app.inject({
    method: "PATCH", url: "/api/projects/pEcho/config",
    payload: { replace: true, config: { sessionEnv: { API_KEY: maskedFromResponse } } },
  });
  check("(2) ★★ the masked-echo is ALSO rejected via replace:true", echoReplace.statusCode === 400);
  check("(2) the real secret still survives after the replace:true attempt", db.getProject("pEcho").config.sessionEnv.API_KEY === SECRET_A);

  // ===================== (3) mask-SHAPE detection, not a hardcoded bullet count =====================
  db.insertProject({ id: "pLong", name: "Long", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null, reserved: false });
  const longWrite = await app.inject({ method: "PATCH", url: "/api/projects/pLong/config", payload: { config: { sessionEnv: { TOKEN: SECRET_LONG } } } });
  check("(3) setup: long secret write → 200", longWrite.statusCode === 200);
  const maskedLong = longWrite.json().config.sessionEnv.TOKEN;
  check("(3) the long secret masks to its OWN length, not a fixed bullet count", maskedLong.length === SECRET_LONG.length && maskedLong.length !== SECRET_A.length);
  const echoLong = await app.inject({ method: "PATCH", url: "/api/projects/pLong/config", payload: { config: { sessionEnv: { TOKEN: maskedLong } } } });
  check("(3) ★ a DIFFERENT-length mask is caught too — the guard checks shape, not one hardcoded length", echoLong.statusCode === 400);

  // ===================== (4) legitimate writes are NOT broken =====================
  // (4a) a genuine same-length rotation to DIFFERENT real content must still work.
  const rotate = await app.inject({ method: "PATCH", url: "/api/projects/pEcho/config", payload: { config: { sessionEnv: { API_KEY: SECRET_B.slice(0, SECRET_A.length) } } } });
  check("(4a) a genuine same-length rotation to different content → 200 (not caught as a mask echo)", rotate.statusCode === 200);
  check("(4a) the new real value is what's actually stored", db.getProject("pEcho").config.sessionEnv.API_KEY === SECRET_B.slice(0, SECRET_A.length));

  // (4b) a brand-new key with no prior value — even one that happens to be all-filler-char — is not ambiguous with a mask.
  db.insertProject({ id: "pFresh", name: "Fresh", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null, reserved: false });
  const freshAllBullets = "•".repeat(6);
  const freshWrite = await app.inject({ method: "PATCH", url: "/api/projects/pFresh/config", payload: { config: { sessionEnv: { NEW_KEY: freshAllBullets } } } });
  check("(4b) a brand-new key (no prior value) is never rejected, even if its literal value is all-filler-char", freshWrite.statusCode === 200);
  check("(4b) the literal value is stored as given", db.getProject("pFresh").config.sessionEnv.NEW_KEY === freshAllBullets);

  // (4c) a value that merely CONTAINS the filler character (not entirely composed of it) is a real value, not a mask.
  const mixedValue = `sk-${"•".repeat(3)}-real-suffix`;
  const mixedWrite = await app.inject({ method: "PATCH", url: "/api/projects/pFresh/config", payload: { config: { sessionEnv: { NEW_KEY: mixedValue } } } });
  check("(4c) a value containing (not entirely composed of) the filler char is accepted", mixedWrite.statusCode === 200);
  check("(4c) it's stored verbatim", db.getProject("pFresh").config.sessionEnv.NEW_KEY === mixedValue);

  // ===================== (5) the SAME chokepoint also guards the platform MCP `project_configure` path =====================
  const platform = await connect(new PlatformMcpRouter(db, svc).buildServer("plat-sess-echo"));
  db.insertProject({ id: "pMcp", name: "Mcp", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null, reserved: false });
  const mcpWrite = await platform("project_configure", { projectId: "pMcp", config: { sessionEnv: { MCP_KEY: SECRET_A } } });
  check("(5) platform project_configure: real secret write accepted", mcpWrite.ok === true && !mcpWrite.error);
  check("(5) real secret is what's stored", db.getProject("pMcp").config.sessionEnv.MCP_KEY === SECRET_A);
  const maskedMcp = "•".repeat(SECRET_A.length);
  const mcpEcho = await platform("project_configure", { projectId: "pMcp", config: { sessionEnv: { MCP_KEY: maskedMcp } } });
  check("(5) ★★ the SAME chokepoint rejects a masked echo on the MCP surface too", mcpEcho.error !== undefined || mcpEcho.ok === false);
  check("(5) the real secret survives on the MCP-driven project too", db.getProject("pMcp").config.sessionEnv.MCP_KEY === SECRET_A);
} finally {
  try { if (app) await app.close(); } catch { /* ignore */ }
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — sessionenv-echo-write-guard (card a253cec8): a real sessionEnv secret write's own RESPONSE comes back masked (card 0c5d6851), and re-submitting that exact masked value as a later write — plain deep-merge or replace:true, over REST or the platform MCP project_configure — is REJECTED at the shared setProjectConfigSafe chokepoint, with the real secret left untouched in the DB (the destruction the card reported, now prevented). The guard detects the mask SHAPE (all-filler-char AND same length as the currently-stored value), not a hardcoded bullet count — proven across two different secret lengths — and never blocks a legitimate write: a genuine same-length rotation to different content, a brand-new key with no prior value to be ambiguous with (even one whose literal value happens to be all-filler-char), and a value that merely contains the filler character all succeed."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
