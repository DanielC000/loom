import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0bcdd158 — each transcript turn can carry its engine line's `ts`, but ONLY on the human REST route.
// HERMETIC + CLAUDE-FREE: temp LOOM_HOME, sandboxed HOME/USERPROFILE (claude engine dir) and CODEX_HOME,
// all set before the first dist import. Pins:
//   (1) claude parseTranscriptFile: with {withTs:true}, ts kept when the line has a parseable one and the
//       key is ABSENT (not null/0/"") when it has none or garbage; with no opts, no turn has a ts key.
//   (2) codex parseTranscriptFile: same, on the real rollout record shapes (top-level `timestamp`),
//       including the task_complete fallback turn.
//   (3) GET /api/sessions/:id/transcript carries ts (bare array and ?offset= envelope).
//   (4) the agent-facing MCP reads do NOT: worker_transcript (manager), transcript_read (auditor
//       surface), the Platform Lead's session_transcript and a granted companion's transcript_read all
//       return turns whose key set is exactly {role, text}. The runs REST route stays {role, text} too.
// Record: docs/decisions/0bcdd158-transcript-turn-timestamp-is-rest-only.md
import fs from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { requireHermeticEnv } from "./_guard.mjs";
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";

const TMP = useOwnLoomHome("lt-ts-");
const sandboxHome = path.join(TMP, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;
delete process.env.CLAUDE_CONFIG_DIR;
process.env.CODEX_HOME = path.join(TMP, "codex");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { registerTranscriptReadTools } = await import("../dist/mcp/transcript-read.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { archivedTranscriptPath, engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const claude = await import("../dist/pty/claude-transcript.js");
const codex = await import("../dist/pty/codex-transcript.js");

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const keysOf = (t) => Object.keys(t).sort().join(",");

const T1 = "2026-11-06T10:00:00.000Z", T2 = "2026-11-06T10:00:00.042Z", T3 = "2026-11-06T10:00:01.500Z";
// Five turns: user (ts), assistant tool_use (ts), tool_result (ts), assistant (NO timestamp), user (garbage ts).
const claudeLines = [
  { type: "user", timestamp: T1, message: { role: "user", content: "kick off" } },
  { type: "assistant", timestamp: T2, message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_0000tag00001", name: "mcp__loom-tasks__tasks_get", input: { id: "x" } }] } },
  { type: "user", timestamp: T3, message: { role: "user", content: [{ type: "tool_result", tool_use_id: "toolu_0000tag00001", content: "{\"id\":\"x\"}" }] } },
  { type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "no timestamp on this line" }] } },
  { type: "user", timestamp: "not a date", message: { role: "user", content: "garbage timestamp" } },
].map((o) => JSON.stringify(o)).join("\n") + "\n";

// ── (1) claude parser ──────────────────────────────────────────────────────────────────────────
const claudeFile = path.join(TMP, "claude-fixture.jsonl");
fs.writeFileSync(claudeFile, claudeLines);
{
  const turns = claude.parseTranscriptFile(claudeFile, { withTs: true });
  check(`(1) claude: 5 turns parsed (got ${turns.length})`, turns.length === 5);
  check("(1) claude: ts kept on the timestamped user/tool_use/tool_result turns",
    turns[0]?.ts === T1 && turns[1]?.ts === T2 && turns[2]?.ts === T3 && turns[2]?.role === "tool_result");
  check("(1) claude: a line with NO timestamp has no ts key at all", !("ts" in turns[3]) && keysOf(turns[3]) === "role,text");
  check("(1) claude: a garbage timestamp is dropped, not passed through", !("ts" in turns[4]));
  const plain = claude.parseTranscriptFile(claudeFile);
  check("(1) claude: default parse (no opts) carries no ts on any turn",
    plain.length === 5 && plain.every((t) => keysOf(t) === "role,text"));
}

// ── (2) codex parser ───────────────────────────────────────────────────────────────────────────
const codexFile = path.join(TMP, "codex-fixture.jsonl");
fs.writeFileSync(codexFile, [
  { timestamp: T1, type: "session_meta", payload: { session_id: "c1", cwd: "/fake" } },
  { timestamp: T1, type: "event_msg", payload: { type: "task_started" } },
  { timestamp: T1, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] } },
  { type: "response_item", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "untimed" }] } },
  { timestamp: T3, type: "event_msg", payload: { type: "task_complete", last_agent_message: "pong" } },
].map((o) => JSON.stringify(o)).join("\n") + "\n");
{
  const turns = codex.parseTranscriptFile(codexFile, { withTs: true });
  check(`(2) codex: 3 turns parsed (got ${turns.length})`, turns.length === 3);
  check("(2) codex: response_item turn keeps its line ts", turns[0]?.text === "ping" && turns[0]?.ts === T1);
  check("(2) codex: an untimed line's turn has no ts key", turns[1]?.text === "untimed" && !("ts" in turns[1]));
  check("(2) codex: the task_complete fallback turn takes that line's ts", turns[2]?.text === "pong" && turns[2]?.ts === T3);
  const plain = codex.parseTranscriptFile(codexFile);
  check("(2) codex: default parse carries no ts", plain.length === 3 && plain.every((t) => keysOf(t) === "role,text"));
}

// ── shared Db: an archived session (REST + transcript_read) and a live worker (worker_transcript) ──
const now = "2026-11-06T10:00:00.000Z";
const db = new Db(path.join(TMP, "loom.db"));
const cwd = path.join(TMP, "repo");
fs.mkdirSync(cwd, { recursive: true });
db.insertProject({ id: "pT", name: "T", repoPath: cwd, vaultPath: cwd, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "aT", projectId: "pT", name: "A", startupPrompt: "x", position: 0 });
db.insertSession({ id: "sArch", projectId: "pT", agentId: "aT", engineSessionId: null, title: null, cwd,
  processState: "exited", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null });
db.archiveSession("sArch");
const archFile = archivedTranscriptPath("pT", "sArch");
fs.mkdirSync(path.dirname(archFile), { recursive: true });
fs.writeFileSync(archFile, claudeLines);

db.insertSession({ id: "M", projectId: "pT", agentId: "aT", engineSessionId: "eng-m", title: null, cwd, processState: "live",
  resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager" });
db.insertSession({ id: "W", projectId: "pT", agentId: "aT", engineSessionId: "eng-w", title: null, cwd, processState: "live",
  resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker",
  parentSessionId: "M", taskId: "tk", branch: "loom/w" });
const liveFile = engineTranscriptPath(cwd, "eng-w");
check("(setup) the live engine transcript path is inside the sandboxed HOME", path.resolve(liveFile).startsWith(path.resolve(sandboxHome)));
fs.mkdirSync(path.dirname(liveFile), { recursive: true });
fs.writeFileSync(liveFile, claudeLines);

// ── (3) REST carries ts ────────────────────────────────────────────────────────────────────────
const app = await buildServer({
  db, pty: {}, sessions: {}, mcp: {}, orchMcp: {}, platformMcp: {}, auditMcp: {}, userAuditMcp: {}, setupMcp: {},
  runMcp: {}, control: {}, usageStatus: {}, requestShutdown: () => {},
});
try {
  const bare = JSON.parse((await app.inject({ method: "GET", url: "/api/sessions/sArch/transcript" })).body);
  check("(3) REST bare array: timestamped turns carry ts", Array.isArray(bare) && bare[0]?.ts === T1 && bare[1]?.ts === T2 && bare[2]?.ts === T3);
  check("(3) REST bare array: the untimed turn has no ts key", bare.length === 5 && !("ts" in bare[3]) && !("ts" in bare[4]));
  const env = JSON.parse((await app.inject({ method: "GET", url: "/api/sessions/sArch/transcript?offset=1" })).body);
  check("(3) REST ?offset= envelope: turns carry ts too", env.offset === 1 && env.turns?.[0]?.ts === T2 && env.turns?.[1]?.ts === T3);
  // The runs transcript route is NOT the strip's route: it stays {role,text}.
  db.insertRun({
    id: "rT", projectId: "pT", agentId: "aT", sessionId: "W", keyId: null, status: "completed",
    input: null, schema: null, result: null, usage: null, transcriptRef: null, error: null,
    webhookUrl: null, idempotencyKey: null, createdAt: now, startedAt: now, endedAt: now,
  });
  const run = JSON.parse((await app.inject({ method: "GET", url: "/api/projects/pT/runs/rT/transcript" })).body);
  check(`(3) runs REST route: turns stay exactly {role,text} (got ${JSON.stringify(run?.map?.(keysOf))})`,
    Array.isArray(run) && run.length === 5 && run.every((t) => keysOf(t) === "role,text"));
} finally {
  await app.close();
}

// ── (4) agent-facing MCP reads do not ──────────────────────────────────────────────────────────
async function connect(server, name) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name, version: "0" });
  await client.connect(clientT);
  return async (tool, args) => JSON.parse((await client.callTool({ name: tool, arguments: args })).content[0].text);
}
const turnsOf = (r) => (Array.isArray(r) ? r : r?.turns);
const allPlain = (turns) => Array.isArray(turns) && turns.length > 0 && turns.every((t) => keysOf(t) === "role,text");

{
  const router = new OrchestrationMcpRouter(db, /** @type {any} */ ({ peekPendingMerge() { return undefined; }, listPendingSpawns() { return []; } }));
  const call = await connect(router.buildServer("M", "manager"), "turn-ts-orch");
  const bare = turnsOf(await call("worker_transcript", { workerSessionId: "W" }));
  check(`(4) worker_transcript: 5 turns, each exactly {role,text} (got ${JSON.stringify(bare?.map(keysOf))})`, bare?.length === 5 && allPlain(bare));
  check("(4) worker_transcript ?offset page: exactly {role,text}", allPlain(turnsOf(await call("worker_transcript", { workerSessionId: "W", offset: 0 }))));
  check("(4) worker_transcript lastN: exactly {role,text}", allPlain(turnsOf(await call("worker_transcript", { workerSessionId: "W", lastN: 3 }))));
}
{
  const server = new McpServer({ name: "turn-ts-audit", version: "0" });
  registerTranscriptReadTools(server, db);
  const call = await connect(server, "turn-ts-audit-client");
  check("(4) transcript_read (live): exactly {role,text}", allPlain(turnsOf(await call("transcript_read", { projectId: "pT", sessionId: "W" }))));
  check("(4) transcript_read (auditor, archived): exactly {role,text}",
    allPlain(turnsOf(await call("transcript_read", { projectId: "pT", sessionId: "sArch", archived: true }))));
}
{
  // The Platform Lead's session_transcript (mcp/platform.ts): live, archived-snapshot, lastN, finalMessageOnly.
  const router = new PlatformMcpRouter(db, /** @type {any} */ ({}));
  const call = await connect(router.buildServer(), "turn-ts-platform");
  const live = turnsOf(await call("session_transcript", { sessionId: "W" }));
  check(`(4) session_transcript (live): 5 turns, exactly {role,text} (got ${JSON.stringify(live?.map?.(keysOf))})`, live?.length === 5 && allPlain(live));
  check("(4) session_transcript (archived snapshot): exactly {role,text}", allPlain(turnsOf(await call("session_transcript", { sessionId: "sArch" }))));
  check("(4) session_transcript lastN: exactly {role,text}", allPlain(turnsOf(await call("session_transcript", { sessionId: "W", lastN: 2 }))));
  check("(4) session_transcript finalMessageOnly: exactly {role,text}",
    allPlain(turnsOf(await call("session_transcript", { sessionId: "W", finalMessageOnly: true }))));
}
{
  // A granted companion's transcript_read (companion/capabilities.ts), on an owner-authored DM turn.
  db.insertAgent({ id: "aC", projectId: "pT", name: "C", startupPrompt: "", position: 0 });
  db.insertSession({ id: "C", projectId: "pT", agentId: "aC", engineSessionId: null, title: null, cwd, processState: "live",
    resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant" });
  db.upsertCompanionCapabilityGrant({ sessionId: "C", capability: "transcript-read", projectId: "pT", mode: "read" });
  const fakePty = {
    getActiveTurnOwnerText() { return "the owner said: read W"; },
    getActiveTurnOrigin() { return null; },
    getActiveTurnSenderId() { return null; },
    enqueueStdin() { return { delivered: false, reason: "held" }; },
  };
  const orch = new OrchestrationMcpRouter(db, /** @type {any} */ ({}), /** @type {any} */ ({}), /** @type {any} */ (fakePty));
  const call = await connect(orch.buildServer("C", "assistant"), "turn-ts-companion");
  const turns = turnsOf(await call("transcript_read", { sessionId: "W" }));
  check(`(4) companion transcript_read: 5 turns, exactly {role,text} (got ${JSON.stringify(turns?.map?.(keysOf) ?? turns)})`, turns?.length === 5 && allPlain(turns));
}

db.close?.();
finishAndExit(failures);
