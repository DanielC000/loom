import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// agent_get's startupPrompt ⇒ spill.ts migration (card bf0fd0f3).
//
// BEFORE this change, agent_get returned the FULL agent record — including startupPrompt — with NO spill
// treatment at all, on all three routers that register it (manager mcp/orchestration.ts, platform
// mcp/platform.ts, setup mcp/setup.ts). An oversized brief rode inline and fell through to the host
// engine's own opaque single-line overflow spill. FIX: all three now spill startupPrompt through the SAME
// shared `spillableAgentGet` primitive (spill.ts) `tasks_get`'s body spill already uses the shape of
// (spillTextIfLarge, one large VALUE — never the NDJSON many-rows shape) — mirrors tasks-get-body-spill.mjs's
// harness shape.
//
// Proves, on EACH of the three routers:
//   (A) an over-budget startupPrompt ⇒ the response keeps every other field inline (id, name, position, …)
//       but replaces `startupPrompt` with `startupPromptFile`/`startupPromptChars`/`note`; the pointed-at
//       file is real, lives under the CALLING session's own scratch dir, and is BYTE-IDENTICAL to the
//       exact prompt text handed to the spill.
//   (B) a small (below-cap) agent_get call is BYTE-IDENTICAL to before: startupPrompt present inline, no
//       startupPromptFile/startupPromptChars/note anywhere.
//   (C) a repeat pull of the SAME oversized agent re-uses the SAME deterministic scratch path (overwrite,
//       not accumulation).
//
// HERMETIC, CLAUDE-FREE, NETWORK-FREE: an isolated LOOM_HOME + sandboxed HOME, a REAL Db, and the REAL
// OrchestrationMcpRouter / PlatformMcpRouter / SetupMcpRouter over in-process MCP InMemoryTransports (no
// HTTP, no daemon, no pty).
//
// Run: 1) build (turbo builds shared first), 2) node test/agent-get-startupprompt-spill.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-agsps-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { SPILL_INLINE_BUDGET_CHARS } = await import("../dist/spill.js");
const { sessionScratchDir } = await import("../dist/paths.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();

// A ~55,000-char startupPrompt — real line breaks INSIDE it too (mirrors tasks-get-body-spill.mjs's own
// bigBody shape), so a naive "count newlines" check would be exercised, not merely a giant single blob.
const PROMPT_LINE = "y".repeat(200);
const bigPrompt = (tag) => Array.from({ length: 275 }, (_, i) => `${PROMPT_LINE}-${tag}${i}`).join("\n");

const fakePty = { enqueueStdin: () => ({ delivered: false }) };

async function connect(server, name) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name, version: "0" });
  await client.connect(clientT);
  return { client, call: async (n, args) => JSON.parse((await client.callTool({ name: n, arguments: args })).content[0].text) };
}

// ═══════════════════════════ (1) MANAGER surface — mcp/orchestration.ts ═══════════════════════════
{
  const dbFile = path.join(tmpHome, "mgr.db");
  const db = new Db(dbFile);
  const projId = "p-mgr";
  const SESSION_ID = "S-MGR";
  db.insertProject({ id: projId, name: "Mgr Project", repoPath: "C:/f", vaultPath: "C:/f", config: {}, createdAt: now, archivedAt: null, reserved: false });
  const AGENT_BIG = "mgr-agent-big";
  const bigA = bigPrompt("MGR-A");
  db.insertAgent({ id: AGENT_BIG, projectId: projId, name: "Big Rig", startupPrompt: bigA, position: 0, profileId: null });
  const AGENT_SMALL = "mgr-agent-small";
  db.insertAgent({ id: AGENT_SMALL, projectId: projId, name: "Small Rig", startupPrompt: "just a short brief", position: 1, profileId: null });
  db.insertSession({
    id: SESSION_ID, projectId: projId, agentId: AGENT_BIG, engineSessionId: null, title: null, cwd: "C:/f",
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager", parentSessionId: null,
  });

  const svc = new SessionService(db, fakePty, new OrchestrationControl());
  const server = new OrchestrationMcpRouter(db, svc).buildServer(SESSION_ID, "manager");
  const { client, call } = await connect(server, "agent-get-spill-mgr");

  try {
    // (A) oversized — spills
    const gotBig = await call("agent_get", { agentId: AGENT_BIG });
    check("(1A) manager: oversized agent_get keeps id/name/position inline", gotBig.id === AGENT_BIG && gotBig.name === "Big Rig" && gotBig.position === 0);
    check("(1A) manager: oversized agent_get replaces startupPrompt with startupPromptFile/Chars/note",
      gotBig.startupPrompt === undefined && typeof gotBig.startupPromptFile === "string" && typeof gotBig.startupPromptChars === "number" && typeof gotBig.note === "string");
    check("(1A) manager: startupPromptChars exceeds the spill budget", gotBig.startupPromptChars > SPILL_INLINE_BUDGET_CHARS);
    check("(1A) manager: the spilled file lives under THIS session's own scratch dir", gotBig.startupPromptFile.startsWith(sessionScratchDir(SESSION_ID)));
    const spilledBig = fs.readFileSync(gotBig.startupPromptFile, "utf8");
    check("(1A) manager: spilled file is BYTE-IDENTICAL to the exact prompt text handed to the spill", spilledBig === bigA);
    check("(1A) manager: startupPromptChars matches the spilled text's own length", gotBig.startupPromptChars === spilledBig.length);

    // (B) below-cap — byte-identical to before
    const gotSmall = await call("agent_get", { agentId: AGENT_SMALL });
    check("(1B) manager: below-cap agent_get keeps startupPrompt inline, no pointer fields",
      gotSmall.startupPrompt === "just a short brief" && gotSmall.startupPromptFile === undefined && gotSmall.startupPromptChars === undefined && gotSmall.note === undefined);

    // (C) repeat pull — deterministic key, overwrites
    const gotBig2 = await call("agent_get", { agentId: AGENT_BIG });
    check("(1C) manager: repeat pull re-uses the SAME deterministic scratch path (no accumulation)", gotBig2.startupPromptFile === gotBig.startupPromptFile);

    await client.close();
  } finally {
    try { db.close(); } catch { /* ignore */ }
    for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
  }
}

// ═══════════════════════════ (2) PLATFORM surface — mcp/platform.ts ═══════════════════════════
{
  const dbFile = path.join(tmpHome, "plat.db");
  const db = new Db(dbFile);
  db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: "C:/f", vaultPath: "C:/f", config: {}, createdAt: now, archivedAt: null, reserved: true });
  db.insertProject({ id: "pTarget", name: "Target", repoPath: "C:/f", vaultPath: "C:/f", config: {}, createdAt: now, archivedAt: null, reserved: false });
  db.insertAgent({ id: "agentLead", projectId: "pHome", name: "Lead", startupPrompt: "LEAD", position: 0 });
  db.insertSession({
    id: "PL", projectId: "pHome", agentId: "agentLead", engineSessionId: null, title: null, cwd: "C:/f",
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform",
  });
  const AGENT_BIG = "plat-agent-big";
  const bigP = bigPrompt("PLAT-A");
  db.insertAgent({ id: AGENT_BIG, projectId: "pTarget", name: "Plat Big Rig", startupPrompt: bigP, position: 0, profileId: null });
  const AGENT_SMALL = "plat-agent-small";
  db.insertAgent({ id: AGENT_SMALL, projectId: "pTarget", name: "Plat Small Rig", startupPrompt: "tiny brief", position: 1, profileId: null });

  class SeamHost extends createSeamHost(PtyHost) { stop() {} }
  const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
  const svc = new SessionService(db, host, new OrchestrationControl());
  const server = new PlatformMcpRouter(db, svc).buildServer("PL");
  const { client, call } = await connect(server, "agent-get-spill-plat");

  try {
    const gotBig = await call("agent_get", { agentId: AGENT_BIG });
    check("(2A) platform: oversized agent_get keeps id/name/position inline", gotBig.id === AGENT_BIG && gotBig.name === "Plat Big Rig" && gotBig.position === 0);
    check("(2A) platform: oversized agent_get replaces startupPrompt with startupPromptFile/Chars/note",
      gotBig.startupPrompt === undefined && typeof gotBig.startupPromptFile === "string" && typeof gotBig.startupPromptChars === "number" && typeof gotBig.note === "string");
    check("(2A) platform: startupPromptChars exceeds the spill budget", gotBig.startupPromptChars > SPILL_INLINE_BUDGET_CHARS);
    check("(2A) platform: the spilled file lives under the CALLER session's ('PL') scratch dir", gotBig.startupPromptFile.startsWith(sessionScratchDir("PL")));
    const spilledBig = fs.readFileSync(gotBig.startupPromptFile, "utf8");
    check("(2A) platform: spilled file is BYTE-IDENTICAL to the exact prompt text handed to the spill", spilledBig === bigP);

    const gotSmall = await call("agent_get", { agentId: AGENT_SMALL });
    check("(2B) platform: below-cap agent_get keeps startupPrompt inline, no pointer fields",
      gotSmall.startupPrompt === "tiny brief" && gotSmall.startupPromptFile === undefined && gotSmall.startupPromptChars === undefined && gotSmall.note === undefined);

    const gotBig2 = await call("agent_get", { agentId: AGENT_BIG });
    check("(2C) platform: repeat pull re-uses the SAME deterministic scratch path (no accumulation)", gotBig2.startupPromptFile === gotBig.startupPromptFile);

    await client.close();
  } finally {
    try { db.close(); } catch { /* ignore */ }
    for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
  }
}

// ═══════════════════════════ (3) SETUP surface — mcp/setup.ts (fail-closed, user-facing) ═══════════════════════════
{
  const dbFile = path.join(tmpHome, "setup.db");
  const db = new Db(dbFile);
  db.insertProject({ id: "pSetup", name: "Setup Project", repoPath: "C:/f", vaultPath: "C:/f", config: {}, createdAt: now, archivedAt: null, reserved: false });
  db.insertAgent({ id: "agentOp", projectId: "pSetup", name: "Operator", startupPrompt: "OP", position: 0 });
  db.insertSession({
    id: "OP", projectId: "pSetup", agentId: "agentOp", engineSessionId: null, title: null, cwd: "C:/f",
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "setup",
  });
  const AGENT_BIG = "setup-agent-big";
  const bigS = bigPrompt("SETUP-A");
  db.insertAgent({ id: AGENT_BIG, projectId: "pSetup", name: "Setup Big Rig", startupPrompt: bigS, position: 1, profileId: null });
  const AGENT_SMALL = "setup-agent-small";
  db.insertAgent({ id: AGENT_SMALL, projectId: "pSetup", name: "Setup Small Rig", startupPrompt: "brief brief", position: 2, profileId: null });

  class SeamHost extends createSeamHost(PtyHost) { stop() {} }
  const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
  const svc = new SessionService(db, host, new OrchestrationControl());
  const server = new SetupMcpRouter(db, svc).buildServer("OP");
  const { client, call } = await connect(server, "agent-get-spill-setup");

  try {
    const gotBig = await call("agent_get", { agentId: AGENT_BIG });
    check("(3A) setup: oversized agent_get keeps id/name/position inline", gotBig.id === AGENT_BIG && gotBig.name === "Setup Big Rig" && gotBig.position === 1);
    check("(3A) setup: oversized agent_get replaces startupPrompt with startupPromptFile/Chars/note",
      gotBig.startupPrompt === undefined && typeof gotBig.startupPromptFile === "string" && typeof gotBig.startupPromptChars === "number" && typeof gotBig.note === "string");
    check("(3A) setup: startupPromptChars exceeds the spill budget", gotBig.startupPromptChars > SPILL_INLINE_BUDGET_CHARS);
    check("(3A) setup: the spilled file lives under the CALLER session's ('OP') scratch dir", gotBig.startupPromptFile.startsWith(sessionScratchDir("OP")));
    const spilledBig = fs.readFileSync(gotBig.startupPromptFile, "utf8");
    check("(3A) setup: spilled file is BYTE-IDENTICAL to the exact prompt text handed to the spill", spilledBig === bigS);
    // The reachability concern the card names for this specific surface: a spill POINTER must not widen
    // what this LOWER-PRIVILEGE operator can read — the pointed-at file lives under ITS OWN caller
    // session's scratch dir (asserted above), never another session's, and every other projected field
    // (endpoint/ioSchema/profileId/…) is untouched by this change — same agentFields() projection as before.
    check("(3A) setup: no OTHER agent field is widened by the spill (endpoint/ioSchema/profileId untouched)",
      gotBig.endpoint === false && gotBig.ioSchema === null && gotBig.profileId === null && gotBig.projectId === "pSetup");

    const gotSmall = await call("agent_get", { agentId: AGENT_SMALL });
    check("(3B) setup: below-cap agent_get keeps startupPrompt inline, no pointer fields",
      gotSmall.startupPrompt === "brief brief" && gotSmall.startupPromptFile === undefined && gotSmall.startupPromptChars === undefined && gotSmall.note === undefined);

    const gotBig2 = await call("agent_get", { agentId: AGENT_BIG });
    check("(3C) setup: repeat pull re-uses the SAME deterministic scratch path (no accumulation)", gotBig2.startupPromptFile === gotBig.startupPromptFile);

    await client.close();
  } finally {
    try { db.close(); } catch { /* ignore */ }
    for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
    try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — agent_get now spills an oversized startupPrompt through the shared spillableAgentGet primitive (spillTextIfLarge, one large value — never NDJSON), on all THREE registering routers (manager/platform/setup), instead of relying on the host engine's own opaque overflow-spill; the spilled file is byte-identical to the exact prompt text handed to the spill and lives under the calling session's own scratch dir; below-cap reads stay byte-identical to before on every surface; repeat pulls of the same agent overwrite rather than accumulate; and the setup surface's spill pointer widens nothing else about what that lower-privilege operator can read."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
