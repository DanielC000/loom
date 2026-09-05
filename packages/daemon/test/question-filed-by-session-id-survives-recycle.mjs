import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card cb7d6998 — FAIL-FIRST regression: `Question.sessionId` (surfaced as `loomSessionId` on both
// requests_list read surfaces) is a MUTABLE ROUTING target that `reparentQuestions` rewrites on every
// manager recycle — it is NOT provenance. A Codescape peer's own escalation misread it as "who filed
// this," and the Platform Lead traced the mechanism to `reparentQuestions`'s unconditional
// `UPDATE questions SET session_id = ?` (db.ts). The fix (Option A, per this card's manager ruling) adds
// an IMMUTABLE `filed_by_session_id` column, set once at `question_ask` and never touched again.
//
// This test files a question as a predecessor manager, recycles it TWICE (to prove the field survives an
// arbitrary number of hops, not just one), and asserts:
//   - `filedBySessionId` never changes, on the raw Db row AND on both requests_list surfaces — the
//     manager's own (mcp/orchestration.ts) and the Platform Auditor's (mcp/audit.ts, card DoD-3) — which
//     share the SAME `auditRequestItem` projection (questionTool.ts), so a fix to one is a fix to both.
//   - `sessionId`/`loomSessionId` correctly KEEPS walking forward to the current successor — reparenting
//     itself is unchanged and still load-bearing (a pending question must still nudge the LIVE seat).
//
// FAIL-FIRST: against pre-cb7d6998 code, `Question` carries no `filedBySessionId` field at all, so every
// `filedBySessionId === oldMgrId` assertion below reads `undefined === oldMgrId` and fails. Verified by
// reverting the fix (git checkout HEAD -- the changed files, before this test's own commit), rebuilding,
// and confirming this file goes RED — then restoring and confirming GREEN.
//
// HERMETIC — a REAL Db + SessionService + OrchestrationMcpRouter + AuditMcpRouter, tool handlers invoked
// directly (mirrors question-recycle-survival.mjs's PtyStub + manager-requests-list.mjs's direct-handler
// call style). No pty, no real claude/network/daemon.
//
// Run: 1) build (turbo builds shared first), 2) node test/question-filed-by-session-id-survives-recycle.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-q-filedby-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { AuditMcpRouter } = await import("../dist/mcp/audit.js");

// A contract-faithful PtyStub (mirrors question-recycle-survival.mjs) — spawn/stop/isAlive are enough for
// recycleManager's own teardown/wiring.
class PtyStub {
  constructor() { this.live = new Set(); this.spawned = []; this.stopped = []; this.enqueued = []; }
  spawn(opts) { this.spawned.push(opts); this.live.add(opts.sessionId); }
  stop(id) { this.stopped.push(id); this.live.delete(id); }
  isAlive(id) { return this.live.has(id); }
  flushPending() { return []; }
  getPending() { return []; }
  enqueueStdin(sessionId, text, source, onDeliver, route, kind) {
    this.enqueued.push({ sessionId, text, source, route, kind });
    return { delivered: true };
  }
}

const dbFile = path.join(tmpHome, "fb.db");
const db = new Db(dbFile);
const now = new Date().toISOString();
const projId = "fb-proj", agentId = "fb-agent", oldMgrId = "fb-mgr-old";

try {
  db.insertProject({ id: projId, name: "FB", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "Manager", startupPrompt: "BRIEF", position: 0 });
  db.insertSession({
    id: oldMgrId, projectId: projId, agentId, engineSessionId: "eng-old", title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });

  // --- (setup) the predecessor files a question via the REAL question_ask tool handler ---
  const routerPre = new OrchestrationMcpRouter(db, {});
  const askResult = JSON.parse((await routerPre.buildServer(oldMgrId, "manager")._registeredTools["question_ask"]
    .handler({ title: "Ship it?", body: "gate green", options: ["yes", "no"] })).content[0].text);
  const qid = askResult.questionId;
  check("(setup) filedBySessionId is set to the FILING session at ask time", db.getQuestion(qid).filedBySessionId === oldMgrId);
  check("(setup) sessionId also starts at the filing session", db.getQuestion(qid).sessionId === oldMgrId);

  // --- (setup, review fix) insertQuestion's `undefined` default must NEVER coerce an EXPLICIT null into
  // a fabricated filer — only a caller that OMITS the field entirely gets the sessionId default. A future
  // typed caller that genuinely can't attribute a filer (a webhook, an on-behalf-of ask) must be able to
  // say so via null without silently manufacturing false provenance. Bypasses buildQuestionAsk (which
  // always sets it) to call db.insertQuestion directly with an explicit null. ---
  const explicitNullId = randomUUID();
  db.insertQuestion({
    id: explicitNullId, sessionId: oldMgrId, filedBySessionId: null, projectId: projId, type: "decision",
    title: "On-behalf-of ask", body: "no attributable filer", options: null, recommendation: null, taskId: null,
    permissionAction: null, permissionScopeHint: null, permissionExpiresAt: null, decidedScope: null, decidedExpiresAt: null,
    credentialEnvVar: null, provisionTarget: null, provisionConnectionId: null, provisionBindingState: "none",
    state: "pending", chosenOption: null, note: null, createdAt: now, answeredAt: null, consumedAt: null,
    cancelledReason: null, cancelledBy: null, cancelledAt: null, escalatedAt: null,
  });
  check("(setup, review fix) an EXPLICIT null filedBySessionId is honored, NOT coerced to sessionId", db.getQuestion(explicitNullId).filedBySessionId === null);

  // --- (1) recycle the manager: sessionId (the routing target) is reparented onto the successor ---
  const pty = new PtyStub();
  pty.live.add(oldMgrId);
  const sessions = new SessionService(db, pty, new OrchestrationControl());
  const fresh = await sessions.recycleManager(oldMgrId, "successor: exercising filed_by_session_id immutability");
  check("(1) recycleManager minted a NEW session id (not the predecessor's)", fresh.id !== oldMgrId);

  const afterFirstRecycle = db.getQuestion(qid);
  check("(1) sessionId (the ROUTING target) WAS reparented onto the successor", afterFirstRecycle.sessionId === fresh.id);
  check("🔴 FAIL-FIRST: filedBySessionId (the FILER) is UNCHANGED — still the original predecessor", afterFirstRecycle.filedBySessionId === oldMgrId);
  // NOT independently fail-first (on pre-fix code, filedBySessionId is undefined, and undefined !==
  // fresh.id trivially holds either way) — the check right above already carries the fail-first claim by
  // pinning the value to oldMgrId exactly; this is a plain corollary of that, kept for readability.
  check("(1) filedBySessionId is NOT the successor's id — the exact bug this card fixes", afterFirstRecycle.filedBySessionId !== fresh.id);

  // --- (2) recycle a SECOND time, from the successor onward: sessionId walks forward again;
  // filedBySessionId must survive an ARBITRARY number of hops, not just one ---
  const pty2 = new PtyStub();
  pty2.live.add(fresh.id);
  const sessions2 = new SessionService(db, pty2, new OrchestrationControl());
  const fresh2 = await sessions2.recycleManager(fresh.id, "second recycle: prove filedBySessionId survives >1 hop");
  const afterSecondRecycle = db.getQuestion(qid);
  check("(2) a SECOND recycle moves sessionId again (now the second successor)", afterSecondRecycle.sessionId === fresh2.id);
  check("(2) filedBySessionId STILL names the ORIGINAL filer after two recycles", afterSecondRecycle.filedBySessionId === oldMgrId);

  // --- (3) the manager's own requests_list (mcp/orchestration.ts) surfaces both fields correctly ---
  const routerPost = new OrchestrationMcpRouter(db, { purgeAnsweredQuestionNudges() {} });
  const successorServer = routerPost.buildServer(fresh2.id, "manager");
  const mgrList = JSON.parse((await successorServer._registeredTools["requests_list"].handler({})).content[0].text);
  const mgrRow = mgrList.items.find((r) => r.id === qid);
  check("(3) manager requests_list: loomSessionId is the CURRENT routing target (2nd successor)", mgrRow?.loomSessionId === fresh2.id);
  check("(3) manager requests_list: filedBySessionId is the ORIGINAL filer, not either successor", mgrRow?.filedBySessionId === oldMgrId);

  // --- (4) card DoD-3: the Platform Auditor's OWN requests_list (mcp/audit.ts) shares the SAME
  // auditRequestItem projection — must carry the identical fix, not a second, independently-patched copy ---
  const auditRouter = new AuditMcpRouter(db, {});
  const auditServer = auditRouter.buildServer("some-auditor-session");
  const auditList = JSON.parse((await auditServer._registeredTools["requests_list"].handler({})).content[0].text);
  const auditRow = auditList.items.find((r) => r.id === qid);
  check("(4) Platform Auditor requests_list: loomSessionId is the CURRENT routing target", auditRow?.loomSessionId === fresh2.id);
  check("(4) Platform Auditor requests_list: filedBySessionId is the ORIGINAL filer (card DoD-3)", auditRow?.filedBySessionId === oldMgrId);
} finally {
  try { db.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — filedBySessionId is set once at ask time and survives ANY number of recycles unchanged, on both requests_list read surfaces, while sessionId/loomSessionId correctly keeps walking forward as the CURRENT routing target."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
