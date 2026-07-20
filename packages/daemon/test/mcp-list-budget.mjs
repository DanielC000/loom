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

// Fake pty seam (no real claude) — the routers need a SessionService, but list tools only hit the Db.
class SeamHost extends PtyHost {
  createPty() { return { pid: 1, write() {}, onData() { return { dispose() {} }; }, onExit() { return { dispose() {} }; }, kill() {}, resize() {} }; }
  stop() {}
}
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());
const auditRouter = new AuditMcpRouter(db, svc);
const platformRouter = new PlatformMcpRouter(db, svc);

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
  await pClient.close();

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
