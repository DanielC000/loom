import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Platform Lead→human DECISION INBOX (ports question_ask/question_pull from the manager surface,
// mcp/orchestration.ts, onto the platform MCP surface — mcp/platform.ts). HERMETIC, claude-free — a REAL
// Db on a temp file + the REAL PlatformMcpRouter driven over an in-process MCP InMemoryTransport, and the
// REAL gateway buildServer for the REST answer/read paths. NO real claude / no network / no daemon.
//
// Mirrors test/question-inbox.mjs's three layers, but on the PLATFORM (Lead) surface:
//   (T) TOOL  — question_ask/question_pull are registered on the platform surface; question_ask derives
//               projectId SERVER-SIDE from the caller's OWN session (the reserved Platform home) — never
//               agent-passed; question_pull round-trips pending -> (answered, simulated at the db layer)
//               -> consumed, and purges any stale queued nudge on a multi-consume pull (parity with the
//               manager path's card bbc46336 follow-up).
//   (a) REST  — the human-only POST /api/questions/:id/answer route's push-on-answer nudge reaches a
//               PLATFORM-role pty exactly as it does a manager's: enqueueStdin is keyed purely on
//               Question.sessionId with no role filtering, so this proves that DoD item rather than
//               assuming it.
//   (b) READ  — GET /api/questions surfaces a question raised from the reserved/picker-hidden Platform
//               home; the read path carries no reserved-project filtering.
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-question-inbox.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (so nothing touches the real ~/.loom or ~/.claude). Set
// BEFORE importing dist (paths.ts reads LOOM_HOME at import time). ---
const tmpHome = path.join(os.tmpdir(), `loom-platform-qi-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const repo = path.join(os.tmpdir(), `loom-platform-qi-repo-${Date.now()}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# platform question-inbox test repo\n");
execSync(`git init -q && git add . && git -c user.email=qi@loom -c user.name=qi commit -q -m init`, { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
// The reserved/system "Loom Platform" home — picker-hidden, but the Lead's decision inbox must still work.
db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertAgent({ id: "agentLead", projectId: "pHome", name: "Lead", startupPrompt: "LEAD", position: 0, profileId: null });
db.insertSession({
  id: "PL", projectId: "pHome", agentId: "agentLead", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "platform", parentSessionId: null,
});

// sessions stub — question_pull's post-consume queue-cleanup call is the only method it needs (mirrors
// question-inbox.mjs's (T) section); record its calls to prove the multi-consume purge fires.
const purgeCalls = [];
const sessionsStub = { purgeAnsweredQuestionNudges(sessionId, ids) { purgeCalls.push({ sessionId, ids }); } };
const platform = new PlatformMcpRouter(db, sessionsStub);

const parse = (res) => JSON.parse(res.content[0].text);
async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "platform-qi-test", version: "0" });
  await client.connect(clientT);
  return client;
}

try {
  // ===================== (T) tool surface + real handler behavior, keyed on the Lead's OWN session =====
  check("(T) the platform session HAS the platform surface", !!platform.resolveRole("PL"));

  const client = await connect(platform.buildServer("PL"));
  const call = async (name, args) => parse(await client.callTool({ name, arguments: args ?? {} }));
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check("(T) question_ask is registered on the platform surface", tools.includes("question_ask"));
  check("(T) question_pull is registered on the platform surface", tools.includes("question_pull"));

  const askResult = await call("question_ask", {
    title: "Ship the platform tool now?", body: "the code review is green", options: ["yes", "no"], recommendation: "yes",
  });
  check("(T) question_ask returns a questionId", typeof askResult.questionId === "string" && askResult.questionId.length > 0);
  const created = db.getQuestion(askResult.questionId);
  check("(T) the created row is scoped to the Lead's OWN session (never agent-passed)", created.sessionId === "PL");
  check("(T) projectId is derived SERVER-SIDE as the Lead's project — the reserved Platform home", created.projectId === "pHome");
  check("(T) the created row starts 'pending'", created.state === "pending");

  const pullEmpty = await call("question_pull");
  check("(T) pulling before it's answered returns an empty list", Array.isArray(pullEmpty.questions) && pullEmpty.questions.length === 0);

  // Simulate the human's answer at the db layer (the REST path is exercised separately below), then a
  // second unrelated pending question too, to prove a multi-consume pull purges BOTH stale nudges.
  db.answerQuestion(askResult.questionId, { chosenOption: "yes", note: "ship it", answeredAt: new Date().toISOString() });
  const second = await call("question_ask", { title: "Second decision", body: "b" });
  db.answerQuestion(second.questionId, { chosenOption: null, note: "go ahead", answeredAt: new Date().toISOString() });

  const pullAfter = await call("question_pull");
  check("(T) question_pull returns both now-answered questions", pullAfter.questions.length === 2);
  check("(T) each entry carries questionId/title/chosenOption/note",
    pullAfter.questions.some((q) => q.questionId === askResult.questionId && q.chosenOption === "yes" && q.title === "Ship the platform tool now?") &&
    pullAfter.questions.some((q) => q.questionId === second.questionId && q.note === "go ahead"));
  check("(T) both rows are now 'consumed'", db.getQuestion(askResult.questionId).state === "consumed" && db.getQuestion(second.questionId).state === "consumed");
  check("(T) a repeat pull is empty (already consumed)", (await call("question_pull")).questions.length === 0);
  check("(T) the multi-consume pull purged stale nudges for BOTH questions (parity with the manager path)",
    purgeCalls.length === 1 && purgeCalls[0].sessionId === "PL" &&
    purgeCalls[0].ids.includes(askResult.questionId) && purgeCalls[0].ids.includes(second.questionId));

  await client.close();

  // ===================== (a) REST: the push-on-answer nudge reaches a PLATFORM-role pty =====================
  const enqueued = [];
  const stubPty = {
    enqueueStdin: (sessionId, text, source, onDeliver, route, kind) => {
      enqueued.push({ sessionId, text, source, kind });
      return { delivered: true };
    },
  };
  const stub = {};
  const app = await buildServer({
    db, pty: stubPty, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
    userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
  });

  try {
    // A fresh pending question raised BY the Lead (sessionId "PL", role platform).
    const restAsk = await connect(platform.buildServer("PL"));
    const restCall = async (name, args) => parse(await restAsk.callTool({ name, arguments: args ?? {} }));
    const restQ = await restCall("question_ask", { title: "REST path check", body: "does the nudge land?" });
    await restAsk.close();

    const answerRes = await app.inject({ method: "POST", url: `/api/questions/${restQ.questionId}/answer`, payload: { note: "yes it does" } });
    check("(a) answering a platform-raised question -> 200", answerRes.statusCode === 200);
    check("(a) the push-on-answer nudge was enqueued to the PLATFORM session (PL), same as a manager's",
      enqueued.length === 1 && enqueued[0].sessionId === "PL");
    check("(a) the nudge uses the SAME rail POST /input uses: source 'human', kind 'agent'",
      enqueued[0].source === "human" && enqueued[0].kind === "agent");
    check("(a) the nudge names the question's title", enqueued[0].text.includes("REST path check"));

    // ===================== (b) READ: GET /api/questions surfaces a reserved-home question =====================
    const listRes = await app.inject({ method: "GET", url: "/api/questions" });
    check("(b) GET /api/questions -> 200", listRes.statusCode === 200);
    const list = JSON.parse(listRes.payload);
    const found = list.find((q) => q.id === restQ.questionId);
    check("(b) the platform-raised question IS surfaced by the read API (not filtered as reserved/hidden)", !!found);
    check("(b) it carries the reserved Platform home's projectId + name", !!found && found.projectId === "pHome" && found.projectName === "Loom Platform");
  } finally {
    await app.close();
  }
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — question_ask/question_pull are registered on the platform (Lead) surface, deriving projectId SERVER-SIDE from the Lead's own reserved-home session (never agent-passed); question_pull round-trips pending -> answered -> consumed and purges stale nudges on a multi-consume pull; the human-only REST answer route's push nudge reaches a PLATFORM-role pty exactly like a manager's (no role filtering on that path); and GET /api/questions surfaces a question raised from the reserved/picker-hidden Platform home (the read API carries no reserved-project filter)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
