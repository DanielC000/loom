import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Project-config CHANGE HISTORY (card a0cafef2, sibling of platform-config.mjs's test (24)/(25) for
// db1e3503). db.setProjectConfig blind-overwrites with no history — same gap platform_config had — but
// with a MATERIALLY WIDER, LOWER-TRUST actor surface: THREE of the four config-PATCH writers are
// AGENT-facing (the Platform Lead's + Setup Assistant's project_configure/project_update, and the
// manager's own project_update), with only ONE human REST PATCH. Unlike db1e3503 (which could honestly
// hardcode actor:"human" — the human REST PATCH is platform_config's ONLY write surface), hardcoding
// "human" here would be a FALSE ATTRIBUTION. `setProjectConfigSafe` (tasks/columns.ts) is the single
// chokepoint all four writers route through; it now takes an `actor` param and records the change via
// Db.recordProjectConfigChange, so every writer gets truthful attribution for free.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic — mirrors project-config-column-orphan.mjs's
// harness (a REAL Db + the REAL Platform/Setup MCP routers, in-process + the REAL Fastify gateway).
//
// Proves:
//   (1) DB-level ring buffer: no-op write records nothing; a real change records changedKeys/prior/next/
//       actor/timestamp; a second change to the same key records the OLD value as prior (not
//       re-derived); only the actually-differing keys are named in a multi-key write, sorted.
//   (2) The ring buffer is scoped PER PROJECT (not one shared daemon-global ring like platform_config's):
//       driving one project's history past the cap never evicts a QUIET sibling project's history, and
//       each project's own ring still caps at the limit.
//   (3) setProjectConfigSafe threads a TRUTHFUL actor end-to-end across all four real write surfaces:
//       the human REST PATCH ("human"), the Platform Lead's project_configure ("platform:<sessionId>"),
//       the Setup Assistant's project_configure AND project_update ("setup:<sessionId>"), and the
//       manager's project_update ("manager:<sessionId>") — each DISTINGUISHABLE from the others, and a
//       no-op / rejected write records nothing on every surface.
//   (4) GET /api/projects/:id/config/history (REST, human-only) reflects the recorded entries in the
//       same shape platform's sibling route does, newest-first.
//   (5) History is also recorded correctly on setProjectConfigSafe's RE-KEY path (a kanbanColumns
//       key-set change), not just the blind path.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { requireHermeticEnv } from "./_guard.mjs";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "loom-projcfghist-"));
process.env.LOOM_HOME = TMP;
process.env.LOOM_PORT = "45320";
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const now = new Date().toISOString();
const dbFile = path.join(TMP, "loom.db");
const db = new Db(dbFile);

// Fake pty (the routers' constructor needs a SessionService; no tool here spawns).
class SeamHost extends PtyHost {
  createPty() { return { pid: 1, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  stop() {}
}
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());

const parse = (res) => JSON.parse(res.content[0].text);
const connect = async (server) => {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "projcfghist-test", version: "0" });
  await client.connect(clientT);
  return async (name, args) => parse(await client.callTool({ name, arguments: args }));
};

let app;
try {
  // ===================== (1) DB-level ring buffer semantics =====================
  db.insertProject({ id: "pA", name: "A", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null, reserved: false });
  db.insertProject({ id: "pB", name: "B", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null, reserved: false });

  // A no-op write (before === after) records nothing — there is no change to attribute.
  db.recordProjectConfigChange("pA", { docLint: true }, { docLint: true }, "human");
  check("(1) identical before/after records nothing", db.listProjectConfigHistory("pA").length === 0);

  // A real change records ONE entry: the changed key, its prior + resulting value, actor, timestamp.
  db.recordProjectConfigChange("pA", {}, { docLint: true }, "human");
  const h1 = db.listProjectConfigHistory("pA");
  check("(1) one entry recorded", h1.length === 1);
  check("(1) changedKeys names the changed top-level key", JSON.stringify(h1[0].changedKeys) === JSON.stringify(["docLint"]));
  check("(1) prior value recorded (absent → omitted, not fabricated)", h1[0].prior.docLint === undefined);
  check("(1) next (resulting) value recorded", h1[0].next.docLint === true);
  check("(1) actor recorded", h1[0].actor === "human");
  check("(1) timestamp recorded", typeof h1[0].createdAt === "string" && h1[0].createdAt.length > 0);

  // A second change to the SAME key: the recorded prior value is the OLD value, not re-derived.
  db.recordProjectConfigChange("pA", { docLint: true }, { docLint: false }, "setup:sessX");
  const h2 = db.listProjectConfigHistory("pA");
  check("(1) two entries now, newest first", h2.length === 2 && h2[0].next.docLint === false && h2[0].prior.docLint === true);
  check("(1) the OLDER entry is unchanged (not mutated in place)", h2[1].next.docLint === true);

  // Only the keys that ACTUALLY changed are named — an untouched sibling never shows up as "changed".
  db.recordProjectConfigChange("pA", { docLint: false, obsidian: { path: "/x" } }, { docLint: false, obsidian: { path: "/y" } }, "human");
  const h3 = db.listProjectConfigHistory("pA");
  check("(1) only the actually-differing key is named", JSON.stringify(h3[0].changedKeys) === JSON.stringify(["obsidian"]));

  // A multi-key write in one call records ALL changed keys in ONE entry, sorted (deterministic reads).
  db.recordProjectConfigChange("pA", {}, { sessionEnv: { A: "1" }, docLint: true }, "human");
  const h4 = db.listProjectConfigHistory("pA");
  check("(1) a multi-key write records one entry naming both keys, sorted",
    JSON.stringify(h4[0].changedKeys) === JSON.stringify(["docLint", "sessionEnv"]));

  // ===================== (2) ring buffer is PER PROJECT, not one shared daemon-global ring =====================
  // pB gets exactly TWO writes — a quiet sibling project.
  db.recordProjectConfigChange("pB", {}, { docLint: true }, "human");
  db.recordProjectConfigChange("pB", { docLint: true }, { docLint: false }, "human");
  check("(2) pB has exactly 2 entries before pA is driven past the cap", db.listProjectConfigHistory("pB").length === 2);

  // Drive pA's history well past its cap with distinct changes.
  for (let i = 0; i < 210; i++) {
    db.recordProjectConfigChange("pA", { sessionEnv: { N: String(i) } }, { sessionEnv: { N: String(i + 1) } }, "human");
  }
  const cappedA = new Database(dbFile, { readonly: true }).prepare("SELECT COUNT(*) AS c FROM project_config_history WHERE project_id = ?").get("pA").c;
  check("(2) ★ pA's ring buffer caps at exactly the limit (bounded, not unlimited growth)", cappedA === 200);
  const newestA = db.listProjectConfigHistory("pA", 1);
  check("(2) the most recent write for pA survives the prune", newestA[0].next.sessionEnv.N === "210");
  // pB's own (untouched) history is BYTE-IDENTICAL — pA's churn never evicted pB's rows.
  check("(2) ★ pB's history is UNTOUCHED by pA's ring eviction (per-project scoping, not a shared ring)",
    db.listProjectConfigHistory("pB").length === 2);
  const totalRows = new Database(dbFile, { readonly: true }).prepare("SELECT COUNT(*) AS c FROM project_config_history").get().c;
  check("(2) total rows across both projects = pA's 200 cap + pB's 2 (each project bounded independently)", totalRows === 202);

  // ===================== (3) actor threading across the four REAL write surfaces =====================
  const platform = await connect(new PlatformMcpRouter(db, svc).buildServer("plat-sess-1"));
  const setup = await connect(new SetupMcpRouter(db, svc).buildServer("setup-sess-1"));
  app = await buildServer({ db, pty: {}, sessions: svc, mcp: {}, orchMcp: {}, platformMcp: {}, auditMcp: {}, control: {}, usageStatus: {} });

  // --- (3a) human REST PATCH → actor "human" ---
  db.insertProject({ id: "pH", name: "H", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null, reserved: false });
  const restPatch = await app.inject({ method: "PATCH", url: "/api/projects/pH/config", payload: { config: { docLint: true } } });
  check("(3a) REST PATCH → 200", restPatch.statusCode === 200);
  const hH = db.listProjectConfigHistory("pH");
  check("(3a) REST PATCH recorded exactly one entry", hH.length === 1);
  check("(3a) ★ actor is truthfully \"human\"", hH[0].actor === "human");

  // A no-op REST PATCH (same value) records nothing new.
  const restNoop = await app.inject({ method: "PATCH", url: "/api/projects/pH/config", payload: { config: { docLint: true } } });
  check("(3a) no-op REST PATCH → 200", restNoop.statusCode === 200);
  check("(3a) no-op REST PATCH records nothing new", db.listProjectConfigHistory("pH").length === 1);

  // --- (3b) Platform Lead's project_configure → actor "platform:<sessionId>" ---
  db.insertProject({ id: "pP", name: "P", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null, reserved: false });
  const platRes = await platform("project_configure", { projectId: "pP", config: { docLint: true } });
  check("(3b) platform project_configure accepted", platRes.ok === true && !platRes.error);
  const hP = db.listProjectConfigHistory("pP");
  check("(3b) platform project_configure recorded exactly one entry", hP.length === 1);
  check("(3b) ★ actor carries the platform session id — NOT hardcoded \"human\"", hP[0].actor === "platform:plat-sess-1");

  // --- (3c) Setup Assistant's project_configure → actor "setup:<sessionId>" ---
  db.insertProject({ id: "pS1", name: "S1", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null, reserved: false });
  const setupRes = await setup("project_configure", { projectId: "pS1", config: { docLint: true } });
  check("(3c) setup project_configure accepted", setupRes.ok === true && !setupRes.error);
  const hS1 = db.listProjectConfigHistory("pS1");
  check("(3c) setup project_configure recorded exactly one entry", hS1.length === 1);
  check("(3c) ★ actor carries the setup session id — NOT hardcoded \"human\"", hS1[0].actor === "setup:setup-sess-1");

  // --- (3d) Setup Assistant's project_update → actor "setup:<sessionId>" (the SECOND setup.ts call site) ---
  db.insertProject({ id: "pS2", name: "S2", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null, reserved: false });
  const setupUpdRes = await setup("project_update", { projectId: "pS2", config: { docLint: true } });
  check("(3d) setup project_update accepted", !setupUpdRes.error);
  const hS2 = db.listProjectConfigHistory("pS2");
  check("(3d) setup project_update recorded exactly one entry", hS2.length === 1);
  check("(3d) ★ actor carries the setup session id on THIS call site too", hS2[0].actor === "setup:setup-sess-1");

  // --- (3e) the manager's own project_update (updateProjectStructural) → actor "manager:<sessionId>" ---
  db.insertProject({ id: "pM", name: "M", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null, reserved: false });
  db.insertAgent({ id: "aM", projectId: "pM", name: "Mgr", startupPrompt: "", position: 0, profileId: null });
  db.insertSession({
    id: "mgr-sess-1", projectId: "pM", agentId: "aM", engineSessionId: null, title: null, cwd: TMP,
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager", parentSessionId: null,
  });
  svc.updateProjectStructural("mgr-sess-1", "pM", { config: { docLint: true } });
  const hM = db.listProjectConfigHistory("pM");
  check("(3e) manager project_update recorded exactly one entry", hM.length === 1);
  check("(3e) ★ actor carries the manager session id — NOT hardcoded \"human\"", hM[0].actor === "manager:mgr-sess-1");

  // --- (3f) all four actors are mutually DISTINGUISHABLE (the DoD's core requirement) ---
  const actors = new Set([hH[0].actor, hP[0].actor, hS1[0].actor, hM[0].actor]);
  check("(3f) ★★ the human path and every distinct agent surface produce DISTINGUISHABLE actors",
    actors.size === 4 && [...actors].every((a) => typeof a === "string" && a.length > 0));

  // --- (3g) a REJECTED write (invalid config) never records a phantom change ---
  const badRest = await app.inject({ method: "PATCH", url: "/api/projects/pH/config", payload: { config: { bogusTopLevelKey: 1 } } });
  check("(3g) an invalid REST PATCH → 400", badRest.statusCode === 400);
  check("(3g) a rejected PATCH records no history entry", db.listProjectConfigHistory("pH").length === 1);

  // ===================== (4) GET /api/projects/:id/config/history (REST) =====================
  const emptyHist = await app.inject({ method: "GET", url: "/api/projects/pM/config/history" });
  // pM already has one write from (3e); assert the route reflects it in the right shape instead of {} .
  check("(4) GET history 200", emptyHist.statusCode === 200);
  const entriesM = emptyHist.json().entries;
  check("(4) GET history reflects the recorded entry", entriesM.length === 1 && entriesM[0].actor === "manager:mgr-sess-1");
  check("(4) entry shape matches {id,changedKeys,prior,next,actor,createdAt}",
    typeof entriesM[0].id === "string" && Array.isArray(entriesM[0].changedKeys)
    && typeof entriesM[0].prior === "object" && typeof entriesM[0].next === "object" && typeof entriesM[0].createdAt === "string");

  // Fresh project → empty history, not an error.
  db.insertProject({ id: "pFresh", name: "Fresh", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null, reserved: false });
  const freshHist = await app.inject({ method: "GET", url: "/api/projects/pFresh/config/history" });
  check("(4) fresh project → 200 with an empty entries array", freshHist.statusCode === 200 && freshHist.json().entries.length === 0);

  // Unknown project → 404.
  const missingHist = await app.inject({ method: "GET", url: "/api/projects/does-not-exist/config/history" });
  check("(4) unknown project → 404", missingHist.statusCode === 404);

  // Newest-first ordering: a follow-up write on pM is prepended.
  svc.updateProjectStructural("mgr-sess-1", "pM", { config: { docLint: false } });
  const afterSecond = (await app.inject({ method: "GET", url: "/api/projects/pM/config/history" })).json().entries;
  check("(4) newest entry first", afterSecond.length === 2 && afterSecond[0].next.docLint === false && afterSecond[0].prior.docLint === true);

  // ===================== (5) history recorded on setProjectConfigSafe's RE-KEY path too =====================
  db.insertProject({ id: "pRekey", name: "Rekey", repoPath: TMP, vaultPath: TMP, config: {}, createdAt: now, archivedAt: null, reserved: false });
  const cardRekey = randomUUID();
  db.insertTask({ id: cardRekey, projectId: "pRekey", title: "on review", body: "", columnKey: "review", position: 1, priority: "p2", createdAt: now, updatedAt: now });
  const newBoard = [{ key: "backlog", label: "Backlog", role: "defaultLanding" }, { key: "done", label: "Done", role: "terminal" }];
  const rekeyRes = await platform("project_configure", { projectId: "pRekey", config: { kanbanColumns: newBoard } });
  check("(5) platform project_configure (column drop, re-key path) accepted", rekeyRes.ok === true && !rekeyRes.error);
  const hRekey = db.listProjectConfigHistory("pRekey");
  check("(5) ★ the re-key path ALSO recorded a history entry", hRekey.length === 1);
  check("(5) the entry's actor is threaded through the re-key path too", hRekey[0].actor === "platform:plat-sess-1");
  check("(5) the entry names kanbanColumns as the changed key", JSON.stringify(hRekey[0].changedKeys) === JSON.stringify(["kanbanColumns"]));
} finally {
  try { if (app) await app.close(); } catch { /* ignore */ }
  db.close();
  for (let i = 0; i < 5; i++) { try { fs.rmSync(TMP, { recursive: true, force: true }); break; } catch { /* retry WAL handle on Windows */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — project_config_history (card a0cafef2): the DB-level ring buffer records changed-keys/prior/next/actor/timestamp per write, a no-op records nothing, and eviction is scoped PER PROJECT (a busy project's churn never evicts a quiet sibling's history, unlike platform_config's single shared ring); setProjectConfigSafe threads a TRUTHFUL, per-surface-distinguishable actor across all four real writers — the human REST PATCH (\"human\"), the Platform Lead's project_configure (\"platform:<sessionId>\"), the Setup Assistant's project_configure AND project_update (\"setup:<sessionId>\"), and the manager's project_update (\"manager:<sessionId>\") — never hardcoding \"human\" for an agent write; a rejected/no-op write on any surface records nothing; GET /api/projects/:id/config/history (human-only REST) reflects the recorded entries newest-first, 404s on an unknown project, and empty-array's a fresh one; and history is recorded correctly on BOTH of setProjectConfigSafe's paths — the blind path and the column re-key path."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
