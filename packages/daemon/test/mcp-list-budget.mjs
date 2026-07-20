import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// MCP-layer DEFAULT-LIST TOKEN-BUDGET test (PL Auditor finding #5). The companion to
// session-list-summary.mjs: that one proves the PROJECTION shape; this one proves the DEFAULT response
// actually FITS the tool-result token cap — because the finding was that a ROW COUNT lied (the audit
// list_sessions "200-row default" still ran ~71K chars at scope:all, and list_all_agents had NO cap and
// overflowed at ~104K chars). So here we assert against MEASURED char size, not just a row count.
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like session-list-summary.mjs: a REAL Db + the
// REAL routers driven over an in-process MCP InMemoryTransport (no HTTP, no external daemon).
//
// Proves, against a representative OVER-SIZED fixture (enough agents/sessions to overflow the OLD behavior):
//   - platform list_all_agents DEFAULT response fits the char budget, is capped at DEFAULT_AGENT_SUMMARY_CAP
//     rows, and DROPS the heavy startupPrompt/ioSchema — while full:true (the OLD unbounded behavior) BLOWS
//     the budget, proving the fixture is genuinely over-sized.
//   - audit list_sessions DEFAULT (scope:"all") fits the budget and is capped at DEFAULT_SESSION_SUMMARY_CAP
//     rows — while a 200-row read (the OLD cap that "lied") BLOWS the budget.
// Run: 1) build (turbo builds shared first), 2) node test/mcp-list-budget.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// Hermetic LOOM_HOME + sandbox HOME — set BEFORE importing dist (paths.ts reads LOOM_HOME at import).
const tmpHome = path.join(os.tmpdir(), `loom-mlb-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { AuditMcpRouter } = await import("../dist/mcp/audit.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { SetupMcpRouter } = await import("../dist/mcp/setup.js");
const { DEFAULT_SESSION_SUMMARY_CAP } = await import("../dist/mcp/sessionView.js");
const { DEFAULT_AGENT_SUMMARY_CAP } = await import("../dist/mcp/agentView.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// The budget the DEFAULT response must fit. The MCP tool-result cap is ~25K tokens; JSON of dense
// UUIDs/ISO-timestamps tokenizes at ~3 chars/token (the auditor's real 71K-char overflow ≈ the cap), so
// we hold the default to a conservative CHAR budget with headroom — the SAME ~48K-char "comfortably under
// the tool-result cap" figure the transcript pager uses (TRANSCRIPT_PAGE_CHAR_BUDGET, ~12K tokens). The
// assertion is on MEASURED serialized bytes, which is the whole point of the finding (the row count lied).
const CHAR_BUDGET = 48_000;
const size = (res) => res.content[0].text.length;            // bytes the tool actually hands back
const approxTokens = (chars) => Math.round(chars / 3);       // dense-JSON ratio, for the log line
const parse = (res) => JSON.parse(res.content[0].text);

// A temp dir to use as session cwd (no git needed — list tools never touch the worktree).
const repo = path.join(tmpHome, "repo");
fs.mkdirSync(repo, { recursive: true });

const now = new Date().toISOString();
const db = new Db();

// --- Over-sized AGENT fixture: many agents, each with a multi-KB startupPrompt (the ~104K-char overflow
// driver). Spread across a few live projects incl. the reserved home so list_all_agents aggregates them. ---
const N_AGENTS = 250;
const BIG_PROMPT = "You are a Loom worker. ".repeat(90); // ~2KB brief per agent (representative of a real one)
db.insertProject({ id: "00000000-0000-0000-0000-0000000home", name: "Loom Platform", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertProject({ id: "00000000-0000-0000-0000-0000000proj", name: "An Ordinary Project With A Realistic Name", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProfile({ id: "profAudit", name: "Platform-audit", role: "auditor", description: "audit rig", allowDelta: [], skills: null, model: null, icon: "🔎" });
for (let i = 0; i < N_AGENTS; i++) {
  const projectId = i % 2 === 0 ? "00000000-0000-0000-0000-0000000proj" : "00000000-0000-0000-0000-0000000home";
  db.insertAgent({
    id: `agent-${String(i).padStart(28, "0")}`, // ~34 chars, representative of a real agent id length
    projectId,
    name: `Worker Agent Number ${i} (a realistic seat name)`,
    startupPrompt: BIG_PROMPT,
    position: i,
    profileId: null,
  });
}

// --- Over-sized SESSION fixture: many ARCHIVED + EXITED sessions (the auditor's intended history, kept
// regardless of state at scope:"all") with fat enriched rows, so the audit default genuinely hits its cap. ---
const N_SESSIONS = 250;
db.insertSession({ id: "AUD", projectId: "00000000-0000-0000-0000-0000000home", agentId: "agent-0000000000000000000000000000", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "auditor", parentSessionId: null });
for (let i = 0; i < N_SESSIONS; i++) {
  const id = `session-${String(i).padStart(28, "0")}`; // ~36 chars (representative session id)
  db.insertSession({
    id, projectId: "00000000-0000-0000-0000-0000000proj", agentId: "agent-0000000000000000000000000000",
    engineSessionId: `eng-${i}`, title: `A long human-readable session title that bloats the heavy blob #${i}`,
    cwd: repo, processState: "exited", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: new Date(Date.now() - i * 1000).toISOString(),
    lastError: null, role: "worker", parentSessionId: null,
    model: "claude-opus-4-8", ctxInputTokens: 123456, ctxTurns: 42,
  });
  db.archiveSession(id); // archived rows are the auditor's history, kept at scope:"all" regardless of state
}

// --- Over-sized LIVE-SESSION fixture: many NON-archived "live" sessions (the state platform/setup
// list_all_sessions defaults to) so paging past DEFAULT_SESSION_SUMMARY_CAP is exercised on the SAME
// state the default reads — the archived fixture above is audit-only (scope:"all" keeps archived rows,
// which listAllSessions excludes entirely; see db.ts's "rail/god-eye lists EXCLUDE archived" comment). ---
const N_LIVE_SESSIONS = 120;
for (let i = 0; i < N_LIVE_SESSIONS; i++) {
  const id = `livesess-${String(i).padStart(24, "0")}`;
  db.insertSession({
    id, projectId: "00000000-0000-0000-0000-0000000proj", agentId: "agent-0000000000000000000000000000",
    engineSessionId: `live-eng-${i}`, title: `A live worker session #${i}`,
    cwd: repo, processState: "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: new Date(Date.now() - i * 1000).toISOString(),
    lastError: null, role: "worker", parentSessionId: null,
    model: "claude-opus-4-8", ctxInputTokens: 1000, ctxTurns: 3,
  });
}
// The "AUD" session inserted above is also state:"live", so the unfiltered default aggregates it too.
const N_TOTAL_LIVE = N_LIVE_SESSIONS + 1;

// Fake pty seam (no real claude) — the routers need a SessionService, but list tools only hit the Db.
class SeamHost extends PtyHost {
  createPty() { return { pid: 1, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  stop() {}
}
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());
const auditRouter = new AuditMcpRouter(db, svc);
const platformRouter = new PlatformMcpRouter(db, svc);
const setupRouter = new SetupMcpRouter(db, svc);

const connect = async (server, name) => {
  const [cT, sT] = InMemoryTransport.createLinkedPair();
  await server.connect(sT);
  const client = new Client({ name, version: "0" });
  await client.connect(cT);
  return client;
};

try {
  // ===================== platform list_all_agents — the no-cap overflow (finding part 1) =====================
  const pClient = await connect(platformRouter.buildServer(), "mlb-platform");
  const callAgents = (args) => pClient.callTool({ name: "list_all_agents", arguments: args });

  const agentsDefault = await callAgents({});
  const agentsDefaultParsed = parse(agentsDefault);
  const agentsDefaultSize = size(agentsDefault);
  // Card 57cb355d: this fixture's N_AGENTS(250) exceeds DEFAULT_AGENT_SUMMARY_CAP(100), so the default
  // (no offset/limit passed) now returns the {agents,total,returned,offset,nextOffset} envelope — the
  // SAME shape session_transcript uses — instead of a bare capped array with no cap signal.
  check("list_all_agents default (capped) returns the pagination envelope, not a bare array",
    !Array.isArray(agentsDefaultParsed) && Array.isArray(agentsDefaultParsed.agents));
  const agentsDefaultRows = agentsDefaultParsed.agents;
  console.log(`   list_all_agents default: ${agentsDefaultRows.length} rows, ${agentsDefaultSize} chars (~${approxTokens(agentsDefaultSize)} tok)`);
  check("list_all_agents default FITS the char budget", agentsDefaultSize < CHAR_BUDGET);
  check(`list_all_agents default is capped at DEFAULT_AGENT_SUMMARY_CAP (${DEFAULT_AGENT_SUMMARY_CAP})`, agentsDefaultRows.length === DEFAULT_AGENT_SUMMARY_CAP);
  check("list_all_agents envelope reports the TRUE total (not just the capped row count) + a non-null nextOffset",
    agentsDefaultParsed.total === N_AGENTS && agentsDefaultParsed.returned === DEFAULT_AGENT_SUMMARY_CAP &&
    agentsDefaultParsed.offset === 0 && agentsDefaultParsed.nextOffset === DEFAULT_AGENT_SUMMARY_CAP);
  check("list_all_agents default DROPS the heavy startupPrompt + ioSchema", agentsDefaultRows.every((a) => !("startupPrompt" in a) && !("ioSchema" in a)));
  check("list_all_agents default keeps the orient fields (id/projectId/name/position/profileId/endpoint)",
    agentsDefaultRows.every((a) => ["id", "projectId", "name", "position", "profileId", "endpoint"].every((k) => k in a)));

  // Paging PAST the cap with offset:nextOffset walks the WHOLE set exactly once, ending at nextOffset:null
  // (N_AGENTS(250) needs 3 pages of DEFAULT_AGENT_SUMMARY_CAP(100): 100+100+50).
  const agentsPage2 = await callAgents({ offset: agentsDefaultParsed.nextOffset });
  const agentsPage2Parsed = parse(agentsPage2);
  check("list_all_agents page 2 (offset:nextOffset) returns the next capped page, more remaining",
    agentsPage2Parsed.total === N_AGENTS && agentsPage2Parsed.offset === DEFAULT_AGENT_SUMMARY_CAP &&
    agentsPage2Parsed.returned === DEFAULT_AGENT_SUMMARY_CAP && agentsPage2Parsed.nextOffset === 2 * DEFAULT_AGENT_SUMMARY_CAP);
  const agentsPage3 = await callAgents({ offset: agentsPage2Parsed.nextOffset });
  const agentsPage3Parsed = parse(agentsPage3);
  check("list_all_agents page 3 (offset:nextOffset) reaches the true end (nextOffset:null)",
    agentsPage3Parsed.total === N_AGENTS && agentsPage3Parsed.offset === 2 * DEFAULT_AGENT_SUMMARY_CAP &&
    agentsPage3Parsed.returned === N_AGENTS - 2 * DEFAULT_AGENT_SUMMARY_CAP && agentsPage3Parsed.nextOffset === null);

  // The OLD behavior — full, unbounded rows — would have overflowed: prove the fixture is representative.
  const agentsFull = await callAgents({ full: true });
  const agentsFullRows = parse(agentsFull);
  const agentsFullSize = size(agentsFull);
  console.log(`   list_all_agents full:true: ${agentsFullRows.length} rows, ${agentsFullSize} chars (~${approxTokens(agentsFullSize)} tok)`);
  check("list_all_agents full:true returns EVERY agent (no cap on the explicit heavy opt-in)", agentsFullRows.length === N_AGENTS);
  check("list_all_agents full:true RESTORES the heavy startupPrompt", agentsFullRows.every((a) => typeof a.startupPrompt === "string" && a.startupPrompt.length > 0));
  check("FIXTURE IS REPRESENTATIVE: the OLD unbounded full-row response BLOWS the budget", agentsFullSize > CHAR_BUDGET);

  // ===================== platform list_all_sessions — card 9ad4dce7: the sibling pagination gap ==========
  // list_all_tasks/list_all_agents got the cap/pagination envelope (a33a713); list_all_sessions was left on
  // a bare-capped-array shape with no cap signal. Same envelope shape, keyed "sessions" instead of "agents".
  const callPlatSessions = (args) => pClient.callTool({ name: "list_all_sessions", arguments: args });

  const platSessDefault = await callPlatSessions({});
  const platSessDefaultParsed = parse(platSessDefault);
  check("platform list_all_sessions default (capped) returns the pagination envelope, not a bare array",
    !Array.isArray(platSessDefaultParsed) && Array.isArray(platSessDefaultParsed.sessions));
  const platSessDefaultRows = platSessDefaultParsed.sessions;
  check(`platform list_all_sessions default is capped at DEFAULT_SESSION_SUMMARY_CAP (${DEFAULT_SESSION_SUMMARY_CAP})`, platSessDefaultRows.length === DEFAULT_SESSION_SUMMARY_CAP);
  check("platform list_all_sessions envelope reports the TRUE total (not just the capped row count) + a non-null nextOffset",
    platSessDefaultParsed.total === N_TOTAL_LIVE && platSessDefaultParsed.returned === DEFAULT_SESSION_SUMMARY_CAP &&
    platSessDefaultParsed.offset === 0 && platSessDefaultParsed.nextOffset === DEFAULT_SESSION_SUMMARY_CAP);

  // Paging PAST the cap with offset:nextOffset walks the WHOLE set exactly once, ending at nextOffset:null
  // (N_TOTAL_LIVE(121) needs 3 pages of DEFAULT_SESSION_SUMMARY_CAP(50): 50+50+21).
  const platSessPage2 = await callPlatSessions({ offset: platSessDefaultParsed.nextOffset });
  const platSessPage2Parsed = parse(platSessPage2);
  check("platform list_all_sessions page 2 (offset:nextOffset) returns the next capped page, more remaining",
    platSessPage2Parsed.total === N_TOTAL_LIVE && platSessPage2Parsed.offset === DEFAULT_SESSION_SUMMARY_CAP &&
    platSessPage2Parsed.returned === DEFAULT_SESSION_SUMMARY_CAP && platSessPage2Parsed.nextOffset === 2 * DEFAULT_SESSION_SUMMARY_CAP);
  const platSessPage3 = await callPlatSessions({ offset: platSessPage2Parsed.nextOffset });
  const platSessPage3Parsed = parse(platSessPage3);
  check("platform list_all_sessions page 3 (offset:nextOffset) reaches the true end (nextOffset:null)",
    platSessPage3Parsed.total === N_TOTAL_LIVE && platSessPage3Parsed.offset === 2 * DEFAULT_SESSION_SUMMARY_CAP &&
    platSessPage3Parsed.returned === N_TOTAL_LIVE - 2 * DEFAULT_SESSION_SUMMARY_CAP && platSessPage3Parsed.nextOffset === null);

  // full:true still returns every row uncapped (unchanged behavior) — proves the envelope-wrap didn't
  // regress the explicit heavy opt-in.
  const platSessFull = await callPlatSessions({ full: true });
  const platSessFullRows = parse(platSessFull);
  check("platform list_all_sessions full:true returns EVERY session (no cap on the explicit heavy opt-in)", platSessFullRows.length === N_TOTAL_LIVE);
  await pClient.close();

  // ===================== setup-surface list_all_agents — card 6500b707: the sibling gap ==================
  // c30cf4aa envelope-wrapped the PLATFORM list_all_agents (above) but left the setup-assistant surface's
  // OWN list_all_agents (mcp/setup.ts) on the old bare-capped-array shape with no cap signal. Same fixture,
  // same assertions, against the setup router instead.
  const sClient = await connect(setupRouter.buildServer(), "mlb-setup");
  const callSetupAgents = (args) => sClient.callTool({ name: "list_all_agents", arguments: args });

  const setupAgentsDefault = await callSetupAgents({});
  const setupAgentsDefaultParsed = parse(setupAgentsDefault);
  check("setup list_all_agents default (capped) returns the pagination envelope, not a bare array",
    !Array.isArray(setupAgentsDefaultParsed) && Array.isArray(setupAgentsDefaultParsed.agents));
  const setupAgentsDefaultRows = setupAgentsDefaultParsed.agents;
  check(`setup list_all_agents default is capped at DEFAULT_AGENT_SUMMARY_CAP (${DEFAULT_AGENT_SUMMARY_CAP})`, setupAgentsDefaultRows.length === DEFAULT_AGENT_SUMMARY_CAP);
  check("setup list_all_agents envelope reports the TRUE total (not just the capped row count) + a non-null nextOffset",
    setupAgentsDefaultParsed.total === N_AGENTS && setupAgentsDefaultParsed.returned === DEFAULT_AGENT_SUMMARY_CAP &&
    setupAgentsDefaultParsed.offset === 0 && setupAgentsDefaultParsed.nextOffset === DEFAULT_AGENT_SUMMARY_CAP);
  check("setup list_all_agents default DROPS the heavy startupPrompt + ioSchema", setupAgentsDefaultRows.every((a) => !("startupPrompt" in a) && !("ioSchema" in a)));

  // Paging PAST the cap with offset:nextOffset reaches the true end (mirrors the platform walk above).
  const setupAgentsPage2 = await callSetupAgents({ offset: setupAgentsDefaultParsed.nextOffset });
  const setupAgentsPage2Parsed = parse(setupAgentsPage2);
  check("setup list_all_agents page 2 (offset:nextOffset) returns the next capped page, more remaining",
    setupAgentsPage2Parsed.total === N_AGENTS && setupAgentsPage2Parsed.offset === DEFAULT_AGENT_SUMMARY_CAP &&
    setupAgentsPage2Parsed.returned === DEFAULT_AGENT_SUMMARY_CAP && setupAgentsPage2Parsed.nextOffset === 2 * DEFAULT_AGENT_SUMMARY_CAP);
  const setupAgentsPage3 = await callSetupAgents({ offset: setupAgentsPage2Parsed.nextOffset });
  const setupAgentsPage3Parsed = parse(setupAgentsPage3);
  check("setup list_all_agents page 3 (offset:nextOffset) reaches the true end (nextOffset:null)",
    setupAgentsPage3Parsed.total === N_AGENTS && setupAgentsPage3Parsed.offset === 2 * DEFAULT_AGENT_SUMMARY_CAP &&
    setupAgentsPage3Parsed.returned === N_AGENTS - 2 * DEFAULT_AGENT_SUMMARY_CAP && setupAgentsPage3Parsed.nextOffset === null);

  // full:true still returns every row uncapped (unchanged behavior) — proves the envelope-wrap didn't
  // regress the explicit heavy opt-in.
  const setupAgentsFull = await callSetupAgents({ full: true });
  const setupAgentsFullRows = parse(setupAgentsFull);
  check("setup list_all_agents full:true returns EVERY agent (no cap on the explicit heavy opt-in)", setupAgentsFullRows.length === N_AGENTS);

  // ===================== setup-surface list_all_sessions — card 9ad4dce7: the sibling pagination gap ====
  // Same envelope treatment as setup list_all_agents above, applied to setup's OWN list_all_sessions —
  // the mirror of the platform list_all_sessions block above, against the setup router instead.
  const callSetupSessions = (args) => sClient.callTool({ name: "list_all_sessions", arguments: args });

  const setupSessDefault = await callSetupSessions({});
  const setupSessDefaultParsed = parse(setupSessDefault);
  check("setup list_all_sessions default (capped) returns the pagination envelope, not a bare array",
    !Array.isArray(setupSessDefaultParsed) && Array.isArray(setupSessDefaultParsed.sessions));
  const setupSessDefaultRows = setupSessDefaultParsed.sessions;
  check(`setup list_all_sessions default is capped at DEFAULT_SESSION_SUMMARY_CAP (${DEFAULT_SESSION_SUMMARY_CAP})`, setupSessDefaultRows.length === DEFAULT_SESSION_SUMMARY_CAP);
  check("setup list_all_sessions envelope reports the TRUE total (not just the capped row count) + a non-null nextOffset",
    setupSessDefaultParsed.total === N_TOTAL_LIVE && setupSessDefaultParsed.returned === DEFAULT_SESSION_SUMMARY_CAP &&
    setupSessDefaultParsed.offset === 0 && setupSessDefaultParsed.nextOffset === DEFAULT_SESSION_SUMMARY_CAP);

  // Paging PAST the cap with offset:nextOffset reaches the true end (mirrors the platform walk above).
  const setupSessPage2 = await callSetupSessions({ offset: setupSessDefaultParsed.nextOffset });
  const setupSessPage2Parsed = parse(setupSessPage2);
  check("setup list_all_sessions page 2 (offset:nextOffset) returns the next capped page, more remaining",
    setupSessPage2Parsed.total === N_TOTAL_LIVE && setupSessPage2Parsed.offset === DEFAULT_SESSION_SUMMARY_CAP &&
    setupSessPage2Parsed.returned === DEFAULT_SESSION_SUMMARY_CAP && setupSessPage2Parsed.nextOffset === 2 * DEFAULT_SESSION_SUMMARY_CAP);
  const setupSessPage3 = await callSetupSessions({ offset: setupSessPage2Parsed.nextOffset });
  const setupSessPage3Parsed = parse(setupSessPage3);
  check("setup list_all_sessions page 3 (offset:nextOffset) reaches the true end (nextOffset:null)",
    setupSessPage3Parsed.total === N_TOTAL_LIVE && setupSessPage3Parsed.offset === 2 * DEFAULT_SESSION_SUMMARY_CAP &&
    setupSessPage3Parsed.returned === N_TOTAL_LIVE - 2 * DEFAULT_SESSION_SUMMARY_CAP && setupSessPage3Parsed.nextOffset === null);

  // full:true still returns every row uncapped (unchanged behavior) — proves the envelope-wrap didn't
  // regress the explicit heavy opt-in.
  const setupSessFull = await callSetupSessions({ full: true });
  const setupSessFullRows = parse(setupSessFull);
  check("setup list_all_sessions full:true returns EVERY session (no cap on the explicit heavy opt-in)", setupSessFullRows.length === N_TOTAL_LIVE);
  await sClient.close();

  // ===================== audit list_sessions — the "200-row default lied" overflow (finding part 2) =========
  const aClient = await connect(auditRouter.buildServer("AUD"), "mlb-audit");
  const callSessions = (args) => aClient.callTool({ name: "list_sessions", arguments: args });

  // DEFAULT scope is "all" (every session incl. archived) — exactly the read that overflowed at ~71K chars.
  const sessDefault = await callSessions({});
  const sessDefaultRows = parse(sessDefault);
  const sessDefaultSize = size(sessDefault);
  console.log(`   audit list_sessions default (scope:all): ${sessDefaultRows.length} rows, ${sessDefaultSize} chars (~${approxTokens(sessDefaultSize)} tok)`);
  check("audit list_sessions default (scope:all) FITS the char budget", sessDefaultSize < CHAR_BUDGET);
  check(`audit list_sessions default is capped at DEFAULT_SESSION_SUMMARY_CAP (${DEFAULT_SESSION_SUMMARY_CAP})`, sessDefaultRows.length === DEFAULT_SESSION_SUMMARY_CAP);

  // The OLD cap (200) "lied" — a 200-row summary read of the SAME rows still blows the budget.
  const sess200 = await callSessions({ limit: 200 });
  const sess200Rows = parse(sess200);
  const sess200Size = size(sess200);
  console.log(`   audit list_sessions limit:200 (the OLD default): ${sess200Rows.length} rows, ${sess200Size} chars (~${approxTokens(sess200Size)} tok)`);
  check("OLD 200-row default LIED: a 200-row summary read BLOWS the budget", sess200Rows.length === 200 && sess200Size > CHAR_BUDGET);
  check("sanity: the new default cap is well below the old 200", DEFAULT_SESSION_SUMMARY_CAP < 200);
  await aClient.close();
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — list_all_agents and audit list_sessions DEFAULT responses are bounded UNDER the measured token/char budget (not just a row count): the projection + measured caps fit, while the old unbounded / 200-row behavior provably overflowed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
