import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 432765ab, Code Review round 1 minor 11 — an HTTP-LEVEL test of the two REST routes the web inbox
// reads (GET /api/questions, GET /api/questions/:id), asserting no absolute path or store filename ever
// reaches the JSON. Uses fastify's own `app.inject()` (the SAME hermetic pattern web-static-serve.mjs
// already uses for this exact class of REST-route test) rather than a real bound TCP port + child
// process + captured pid: `.inject()` drives the REAL route handler, REAL serialization, and REAL
// `toQuestion`/`toQuestionInboxItem` projection — the thing actually under test — without the extra
// hermetic-port/pid-management machinery a real socket would need for no added assurance here. Flagging
// this choice explicitly rather than silently substituting it for what was asked.
//
// Run: 1) build (turbo builds shared first), 2) node packages/daemon/test/attachment-rest-redaction.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-attach-rest-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { questionAttachmentDir } = await import("../dist/paths.js");

const dbFile = path.join(tmpHome, "rest.db");
const db = new Db(dbFile);
const now = new Date().toISOString();

/** Deep-scan a JSON-decoded response for a stray internal field or an absolute-path-shaped string
 *  anywhere in the object tree. */
function findLeak(value, originalPath, storedFilename) {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string" && (value === originalPath || value.includes(storedFilename))) return `string value leaked: ${value}`;
    return null;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const leak = findLeak(v, originalPath, storedFilename);
      if (leak) return leak;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value)) {
    if (k === "originalPath" || k === "storedFilename") return `internal key leaked: ${k}`;
    const leak = findLeak(v, originalPath, storedFilename);
    if (leak) return leak;
  }
  return null;
}

try {
  const projId = "rest-proj";
  const agentId = "rest-agent";
  const mgrId = "rest-mgr";
  db.insertProject({ id: projId, name: "Rest", repoPath: projId, vaultPath: "", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "Manager", startupPrompt: "BRIEF", position: 0 });
  db.insertSession({
    id: mgrId, projectId: projId, agentId, engineSessionId: "eng-rest-mgr", title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });

  const questionId = "rest-q1";
  const storeDir = questionAttachmentDir(questionId);
  fs.mkdirSync(storeDir, { recursive: true });
  const storedFilename = "0-secret-looking-name.png";
  fs.writeFileSync(path.join(storeDir, storedFilename), Buffer.from([1, 2, 3]));
  const originalPath = "C:\\Users\\someone\\very\\secret\\worktree\\path\\mockup.png";
  const stored = [{
    id: "0", label: "Mockup", kind: "image", sizeBytes: 3,
    imageDimensions: { width: 1, height: 1 }, storedFilename, originalPath, openedAt: null,
  }];
  db.insertQuestion({
    id: questionId, sessionId: mgrId, filedBySessionId: mgrId, projectId: projId, type: "decision",
    title: "Review this", body: "see attached",
    options: ["approve", "reject"], recommendation: null, taskId: null,
    permissionAction: null, permissionScopeHint: null, permissionExpiresAt: null,
    decidedScope: null, decidedExpiresAt: null, credentialEnvVar: null, credentialByteLength: null,
    provisionTarget: null, fulfillmentTarget: null, provisionConnectionId: null, provisionBindingState: "none",
    state: "pending", chosenOption: null, note: null,
    createdAt: now, answeredAt: null, consumedAt: null,
    cancelledReason: null, cancelledBy: null, cancelledAt: null,
    escalatedAt: null, acknowledgedUntil: null, readAt: null,
    attachments: [],
  }, stored);

  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
  try {
    const listRes = await app.inject({ method: "GET", url: "/api/questions" });
    check("(1) GET /api/questions -> 200", listRes.statusCode === 200);
    const listBody = JSON.parse(listRes.body);
    const listItem = listBody.find((q) => q.id === questionId);
    check("(1) the question is present in the list", !!listItem);
    check("(1) its attachments carry the public shape", listItem?.attachments?.length === 1 && listItem.attachments[0].label === "Mockup");
    check("(1) GET /api/questions NEVER leaks the absolute originalPath or storedFilename anywhere in the response", findLeak(listBody, originalPath, storedFilename) === null);

    const oneRes = await app.inject({ method: "GET", url: `/api/questions/${questionId}` });
    check("(2) GET /api/questions/:id -> 200", oneRes.statusCode === 200);
    const oneBody = JSON.parse(oneRes.body);
    check("(2) its attachments carry the public shape", oneBody?.attachments?.length === 1 && oneBody.attachments[0].kind === "image");
    check("(2) GET /api/questions/:id NEVER leaks the absolute originalPath or storedFilename anywhere in the response", findLeak(oneBody, originalPath, storedFilename) === null);
  } finally {
    await app.close();
  }
} finally {
  try { db.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — GET /api/questions and /api/questions/:id both carry the public attachment shape and never leak an absolute original path or store filename."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
