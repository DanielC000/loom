import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 432765ab, end-to-end through the REAL MCP tool handlers (not just the unit-level resolver/copy
// primitives covered by attachment-core.mjs). HERMETIC — a REAL Db + REAL OrchestrationMcpRouter/
// PlatformMcpRouter/TaskMcpRouter/AuditMcpRouter over in-process MCP InMemoryTransports, no real
// claude/network/daemon. Covers:
//   (A) a manager's question_ask with a VALID attachment succeeds; the row round-trips with the public
//       attachment shape.
//   (B) a manager's question_ask with a RELATIVE attachment path is rejected OUTRIGHT — the whole call
//       fails and NOTHING is filed (no new question row at all, not even a half-built one).
//   (C) a manager's question_ask with an attachment OUTSIDE every allowed root is rejected OUTRIGHT, same
//       nothing-filed guarantee.
//   (D) the Platform Lead's question_ask ALSO accepts attachments, including on type:"notice" (valid on
//       every type per the card's own spec).
//   (E) EVERY read surface carries the public attachments shape and NEVER an absolute path
//       (originalPath/storedFilename never appear anywhere in the serialized tool response):
//       question_pull (manager), task_request_get (loom-tasks, via a linked task), requests_list
//       (manager, project-scoped) and requests_list (Auditor, cross-project).
//   (F) the unchanged-answer-flow guarantee (card's own DoD): a request WITH attachments still answers
//       via options/note exactly as before — attachments never touch how a request is answered.
//
// Run: 1) build (turbo builds shared first), 2) node packages/daemon/test/attachment-read-surfaces.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-attach-surfaces-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { AuditMcpRouter } = await import("../dist/mcp/audit.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const dbFile = path.join(tmpHome, "surfaces.db");
const db = new Db(dbFile);
const now = new Date().toISOString();

async function connectedClient(server, name) {
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), (async () => {})()]);
  const client = new Client({ name, version: "0" });
  await client.connect(ct);
  return client;
}
const callTool = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

/** Deep-scan a serialized response for ANY string value that looks like an absolute host path pointing
 *  at the two internal fields that must never surface: a stray `originalPath`/`storedFilename` KEY
 *  anywhere in the object tree (regardless of nesting — the redaction must hold structurally, not just
 *  at the top level this test happens to look at). */
function containsInternalAttachmentFields(value) {
  if (value === null || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some(containsInternalAttachmentFields);
  for (const [k, v] of Object.entries(value)) {
    if (k === "originalPath" || k === "storedFilename") return true;
    if (containsInternalAttachmentFields(v)) return true;
  }
  return false;
}

// A SIBLING of tmpHome (LOOM_HOME), never nested inside it — card 432765ab's structural LOOM_HOME
// refusal would otherwise (correctly) refuse every fixture path created under here.
const scratch = path.join(os.tmpdir(), `loom-attach-surfaces-scratch-${Date.now()}-${process.pid}`);
fs.mkdirSync(scratch, { recursive: true });
const repoRoot = path.join(scratch, "repo");
fs.mkdirSync(repoRoot, { recursive: true });
const outsideDir = path.join(scratch, "outside");
fs.mkdirSync(outsideDir, { recursive: true });

const projId = "surf-proj";
const agentId = "surf-agent";
const mgrId = "surf-mgr";

try {
  db.insertProject({ id: projId, name: "Surfaces", repoPath: repoRoot, vaultPath: "", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "Manager", startupPrompt: "BRIEF", position: 0 });
  db.insertSession({
    id: mgrId, projectId: projId, agentId, engineSessionId: "eng-surf-mgr", title: null, cwd: repoRoot,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
  const taskId = "surf-task-00000000";
  db.insertTask({ id: taskId, projectId: projId, title: "Linked task", body: "", columnKey: "in_progress", position: 1, priority: "p2", createdAt: now, updatedAt: now });

  const fakePty = { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null, purgeQueuedByQuestionIds: () => [] };
  const sessions = new SessionService(db, fakePty, new OrchestrationControl());
  const orch = new OrchestrationMcpRouter(db, sessions);
  const mgrServer = orch.buildServer(mgrId, "manager");
  const mgrClient = await connectedClient(mgrServer, "attachment-read-surfaces-mgr");

  const goodFile = path.join(repoRoot, "mockup.png");
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47]).copy(png, 0);
  png.writeUInt32BE(640, 16);
  png.writeUInt32BE(480, 20);
  fs.writeFileSync(goodFile, png);

  let questionId;
  // ===== (A) a valid attachment succeeds =====
  {
    const before = db.listOpenQuestions(true).length;
    const res = await callTool(mgrClient, "question_ask", {
      type: "decision", title: "Review this mockup", body: "see attached", options: ["approve", "reject"],
      taskId, attachments: [{ path: goodFile, label: "Mockup v1" }],
    });
    check("(A1) a valid attachment is accepted — no error", typeof res.error !== "string");
    questionId = res.questionId;
    check("(A2) a question row now exists", typeof questionId === "string");
    const after = db.listOpenQuestions(true).length;
    check("(A3) exactly one new question was filed", after === before + 1);
    const row = db.getQuestion(questionId);
    check("(A4) the stored row carries exactly one public attachment", row?.attachments.length === 1);
    check("(A5) the stored row's attachment never carries an absolute path anywhere", !containsInternalAttachmentFields(row.attachments));
    check("(A6) kind/label/dimensions were correctly derived", row.attachments[0].label === "Mockup v1" && row.attachments[0].kind === "image" && row.attachments[0].imageDimensions?.width === 640);
  }

  // ===== (B) a RELATIVE attachment path is rejected outright, nothing filed =====
  {
    const before = db.listOpenQuestions(true).length;
    const res = await callTool(mgrClient, "question_ask", {
      title: "Relative path test", body: "x", attachments: [{ path: "relative/mockup.png" }],
    });
    check("(B1) a relative attachment path is refused", typeof res.error === "string" && /absolute/.test(res.error));
    const after = db.listOpenQuestions(true).length;
    check("(B2) NOTHING was filed for the refused call", after === before);
  }

  // ===== (C) an attachment OUTSIDE every allowed root is rejected outright, nothing filed =====
  {
    const outsideFile = path.join(outsideDir, "secret.txt");
    fs.writeFileSync(outsideFile, "nope");
    const before = db.listOpenQuestions(true).length;
    const res = await callTool(mgrClient, "question_ask", {
      title: "Outside-root test", body: "x", attachments: [{ path: outsideFile }],
    });
    check("(C1) an attachment outside every allowed root is refused", typeof res.error === "string" && /outside every allowed root/.test(res.error));
    const after = db.listOpenQuestions(true).length;
    check("(C2) NOTHING was filed for the refused call", after === before);
  }
  await mgrClient.close();

  // ===== (D) the Platform Lead's question_ask also accepts attachments, including on type:"notice" =====
  {
    const reservedProjId = "surf-platform-home";
    db.insertProject({ id: reservedProjId, name: "Loom Platform", repoPath: repoRoot, vaultPath: "", config: {}, createdAt: now, archivedAt: null, reserved: true });
    const leadAgentId = "surf-lead-agent";
    db.insertAgent({ id: leadAgentId, projectId: reservedProjId, name: "Lead", startupPrompt: "BRIEF", position: 0 });
    const leadId = "surf-lead";
    db.insertSession({
      id: leadId, projectId: reservedProjId, agentId: leadAgentId, engineSessionId: "eng-surf-lead", title: null, cwd: repoRoot,
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: "platform",
    });
    const leadServer = new PlatformMcpRouter(db, {}).buildServer(leadId);
    const leadClient = await connectedClient(leadServer, "attachment-read-surfaces-lead");
    const res = await callTool(leadClient, "question_ask", {
      type: "notice", title: "Deploy landed", body: "fyi", attachments: [{ path: goodFile }],
    });
    check("(D1) the Lead's question_ask accepts an attachment on type:\"notice\"", typeof res.error !== "string");
    const row = db.getQuestion(res.questionId);
    check("(D2) the notice's attachment round-trips with no absolute path", row?.attachments.length === 1 && !containsInternalAttachmentFields(row.attachments));
    await leadClient.close();
  }

  // ===== (E) every read surface carries the public shape, never an absolute path; (F) the answer flow
  // is unchanged by the presence of attachments =====
  {
    db.answerQuestion(questionId, { chosenOption: "approve", note: "looks good", answeredAt: new Date().toISOString() });
    check("(F) the answer flow (options/chosenOption/note) is unaffected by attachments", db.getQuestion(questionId)?.chosenOption === "approve" && db.getQuestion(questionId)?.note === "looks good");

    const mgrServer2 = orch.buildServer(mgrId, "manager");
    const mgrClient2 = await connectedClient(mgrServer2, "attachment-read-surfaces-mgr2");

    const pulled = await callTool(mgrClient2, "question_pull", {});
    const pulledItem = (pulled.questions ?? []).find((q) => q.questionId === questionId);
    check("(E1) question_pull returns the answered request", !!pulledItem);
    check("(E2) question_pull carries the public attachments shape", pulledItem?.attachments?.length === 1 && pulledItem.attachments[0].label === "Mockup v1");
    check("(E3) question_pull NEVER carries an absolute path anywhere in its response", !containsInternalAttachmentFields(pulled));

    // includeConsumed:true — question_pull (E1-E3) already drained+consumed this request, and
    // requests_list's default view excludes consumed rows (same as question_pull's own "pull and gone").
    const listed = await callTool(mgrClient2, "requests_list", { includeConsumed: true });
    const listedItem = (listed.items ?? []).find((q) => q.id === questionId);
    check("(E4) the manager's requests_list carries the public attachments shape", listedItem?.attachments?.length === 1);
    check("(E5) the manager's requests_list NEVER carries an absolute path anywhere", !containsInternalAttachmentFields(listed));
    await mgrClient2.close();

    const wakes = new WakeService({ db, pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null }, resume: () => {} });
    const taskServer = new TaskMcpRouter(db, wakes).buildServer(projId, mgrId);
    const taskClient = await connectedClient(taskServer, "attachment-read-surfaces-task");
    const taskGet = await callTool(taskClient, "task_request_get", { id: questionId, taskId });
    check("(E6) task_request_get carries the public attachments shape", taskGet?.attachments?.length === 1);
    check("(E7) task_request_get NEVER carries an absolute path anywhere", !containsInternalAttachmentFields(taskGet));
    await taskClient.close();

    const auditHomeId = "surf-audit-home";
    db.insertProject({ id: auditHomeId, name: "Audit Home", repoPath: repoRoot, vaultPath: "", config: {}, createdAt: now, archivedAt: null, reserved: true });
    const auditAgentId = "surf-audit-agent";
    db.insertAgent({ id: auditAgentId, projectId: auditHomeId, name: "Auditor", startupPrompt: "AUDIT", position: 0 });
    const auditorId = "surf-auditor";
    db.insertSession({
      id: auditorId, projectId: auditHomeId, agentId: auditAgentId, engineSessionId: null, title: null, cwd: repoRoot,
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: "auditor",
    });
    const auditServer = new AuditMcpRouter(db, {}).buildServer(auditorId);
    const auditClient = await connectedClient(auditServer, "attachment-read-surfaces-audit");
    const auditListed = await callTool(auditClient, "requests_list", {});
    const auditItem = (auditListed.items ?? []).find((q) => q.id === questionId);
    check("(E8) the Auditor's cross-project requests_list carries the public attachments shape", auditItem?.attachments?.length === 1);
    check("(E9) the Auditor's cross-project requests_list NEVER carries an absolute path anywhere", !containsInternalAttachmentFields(auditListed));
    await auditClient.close();
  }
} finally {
  try { db.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
  cleanupPathSync(scratch);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — question_ask attachments work end-to-end through the real manager/Lead MCP tools (accept + reject-outright for relative/outside-root paths), and every read surface (question_pull, requests_list manager+audit, task_request_get) carries the public shape with no absolute path ever reaching the response, with the answer flow itself unchanged."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
