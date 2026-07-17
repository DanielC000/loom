import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// question_ask's explicit `supersedes:<questionId>` param (card feat(orchestration): add an explicit
// supersedes:<id> param to question_ask that auto-cancels the named prior pending ask). Follow-up to
// question_cancel (card feat(orchestration): question_cancel + a human dismiss route for pending
// Requests, becc758) — this closes the gap where an asker had the ABILITY to cancel a moot ask but had
// to remember to do it as a SEPARATE call; `supersedes` lets the asker name the exact prior ask it's
// replacing, explicitly, in the SAME question_ask call. The originating card floated an AUTO-supersede
// heuristic ("this new ask obviously replaces that old one") — deliberately REJECTED as a guess that will
// eventually cancel a live owner ask; this is the safe, non-heuristic version only.
//
// HERMETIC + CLAUDE-FREE — a REAL Db on a throwaway SQLite file, REAL OrchestrationMcpRouter/
// PlatformMcpRouter tool handlers invoked directly. No pty, no real claude, no network.
//
// Covers:
//   (1) Happy path — supersedes a still-pending prior ask asked by the SAME agent lineage: the prior lands
//       'cancelled' with a reason linking the new question, and the new ask is filed; response carries
//       {questionId, supersede:{cancelled:true, questionId}}.
//   (2) Ownership violation — `supersedes` names ANOTHER agent's pending ask: the cancel is refused (the
//       foreign row stays untouched/pending), but the NEW ask is still filed regardless — reported back via
//       `supersede:{error}`, never silently swallowed and never blocking the caller's real ask.
//   (3) THE RACE — the named prior ask was ANSWERED between the caller's decision and this call landing:
//       the cancel is refused, the answer is completely untouched, and the new ask is STILL filed
//       (`supersede:{error}` naming that an answer is now available).
//   (4) Omitted `supersedes` — BYTE-IDENTICAL response shape to before this param existed: {questionId}
//       only, no `supersede` key at all.
//   (5) The Lead (platform) surface shares the identical behavior (happy path + ownership).
//
// Run: 1) build (turbo builds shared first), 2) node test/question-ask-supersede.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-question-ask-supersede-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");

const dbFile = path.join(tmpHome, "qas.db");
const db = new Db(dbFile);
const now = new Date().toISOString();

try {
  // --- fixtures: two projects, two agents (A, A2 sharing NO lineage), a reserved Platform home. ---
  db.insertProject({ id: "pA", name: "Project A", repoPath: "pA", vaultPath: "pA", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentA", projectId: "pA", name: "Mgr A", startupPrompt: "MGR", position: 0 });
  db.insertAgent({ id: "agentA2", projectId: "pA", name: "Mgr A2", startupPrompt: "MGR", position: 1 });
  db.insertSession({
    id: "mgrA", projectId: "pA", agentId: "agentA", engineSessionId: null, title: null, cwd: "pA",
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
  db.insertSession({
    id: "mgrA2", projectId: "pA", agentId: "agentA2", engineSessionId: null, title: null, cwd: "pA",
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
  db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: "pHome", vaultPath: "pHome", config: {}, createdAt: now, archivedAt: null, reserved: true });
  db.insertAgent({ id: "agentLead", projectId: "pHome", name: "Lead", startupPrompt: "LEAD", position: 0 });
  db.insertSession({
    id: "PL", projectId: "pHome", agentId: "agentLead", engineSessionId: null, title: null, cwd: "pHome",
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "platform",
  });

  const sessions = new SessionService(db, { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null, purgeQueuedByQuestionIds: () => [] }, new OrchestrationControl());
  const router = new OrchestrationMcpRouter(db, sessions);
  const mgrServer = router.buildServer("mgrA", "manager");
  const mgrA2Server = router.buildServer("mgrA2", "manager");
  const call = async (server, name, args) => JSON.parse((await server._registeredTools[name].handler(args ?? {})).content[0].text);

  // ============ (1) happy path ============
  const priorAsk = await call(mgrServer, "question_ask", { title: "Deploy timing?", body: "when should this land" });
  check("(1) filing the prior ask succeeds", typeof priorAsk.questionId === "string");
  const priorId = priorAsk.questionId;

  const newAsk = await call(mgrServer, "question_ask", {
    title: "Deploy timing (fresher info)?", body: "actually let's do it now", supersedes: priorId,
  });
  check("(1) the new ask is filed", typeof newAsk.questionId === "string" && newAsk.questionId !== priorId);
  check("(1) the response carries a supersede outcome", newAsk.supersede && newAsk.supersede.cancelled === true && newAsk.supersede.questionId === priorId);
  const priorRow = db.getQuestion(priorId);
  check("(1) the prior ask is now cancelled", priorRow.state === "cancelled");
  check("(1) the cancelledReason links the new question", priorRow.cancelledReason.includes(newAsk.questionId));
  check("(1) cancelledBy is 'agent'", priorRow.cancelledBy === "agent");
  const newRow = db.getQuestion(newAsk.questionId);
  check("(1) the new ask is a real pending row", !!newRow && newRow.state === "pending");

  // ============ (2) ownership violation — supersedes another agent's pending ask ============
  const foreignAsk = await call(mgrA2Server, "question_ask", { title: "A2's own ask", body: "b" });
  const foreignId = foreignAsk.questionId;
  const attemptForeign = await call(mgrServer, "question_ask", {
    title: "mgrA tries to supersede A2's ask", body: "b", supersedes: foreignId,
  });
  check("(2) the new ask is STILL filed despite the ownership violation", typeof attemptForeign.questionId === "string");
  check("(2) the supersede outcome reports an error, not silently swallowed", typeof attemptForeign.supersede?.error === "string");
  check("(2) the foreign row is UNTOUCHED (still pending)", db.getQuestion(foreignId).state === "pending");

  // ============ (3) THE RACE — answered between the decision to supersede and this call landing ============
  const raceAsk = await call(mgrServer, "question_ask", { title: "Racing the human's answer", body: "b" });
  const raceId = raceAsk.questionId;
  // Simulate the human's answer landing (the real REST answer route would do this) BEFORE the supersede call.
  db.answerQuestion(raceId, { chosenOption: null, note: "the human's real decision", answeredAt: new Date().toISOString() });
  const raceNewAsk = await call(mgrServer, "question_ask", {
    title: "Re-asking, unaware it was just answered", body: "b", supersedes: raceId,
  });
  check("(3) the new ask is STILL filed despite the raced supersede", typeof raceNewAsk.questionId === "string");
  check("(3) the supersede is refused, naming that an answer is now available", typeof raceNewAsk.supersede?.error === "string" && raceNewAsk.supersede.error.includes("question_pull"));
  const raceRow = db.getQuestion(raceId);
  check("(3) the answer is COMPLETELY UNTOUCHED — never clobbered by the failed supersede", raceRow.state === "answered" && raceRow.note === "the human's real decision");
  check("(3) the raced row was never marked cancelled", raceRow.cancelledBy === null && raceRow.cancelledReason === null);

  // ============ (4) omitted `supersedes` — byte-identical to before this param existed ============
  const plainAsk = await call(mgrServer, "question_ask", { title: "Plain ask, no supersedes", body: "b" });
  check("(4) the response is EXACTLY {questionId} — no supersede key at all", Object.keys(plainAsk).sort().join(",") === "questionId" && typeof plainAsk.questionId === "string");

  // ============ (5) the Lead (platform) surface shares the identical behavior ============
  const platform = new PlatformMcpRouter(db, sessions);
  const leadServer = platform.buildServer("PL");
  const leadPrior = await call(leadServer, "question_ask", { title: "Lead's own prior ask", body: "b" });
  const leadNew = await call(leadServer, "question_ask", { title: "Lead re-asks", body: "b", supersedes: leadPrior.questionId });
  check("(5) the Lead surface auto-cancels its own named prior ask", leadNew.supersede?.cancelled === true);
  check("(5) the Lead's prior row is cancelled", db.getQuestion(leadPrior.questionId).state === "cancelled");
  // Ownership still applies on the Lead surface: it can't supersede a manager's ask.
  const mgrOwnAsk = await call(mgrServer, "question_ask", { title: "Not the Lead's to supersede", body: "b" });
  const leadForeignAttempt = await call(leadServer, "question_ask", { title: "Lead tries anyway", body: "b", supersedes: mgrOwnAsk.questionId });
  check("(5) the Lead superseding a manager's ask is refused but still files its own new ask", typeof leadForeignAttempt.questionId === "string" && typeof leadForeignAttempt.supersede?.error === "string");
  check("(5) the manager's row is untouched", db.getQuestion(mgrOwnAsk.questionId).state === "pending");

  // ============ (6) THE ORDERING GUARANTEE — insertQuestion fails AFTER a working cancel would have run ============
  // Proves the call-order contract in questionTool.ts's applySupersede doc: insert-before-cancel means a
  // failed insert leaves the prior ask completely untouched (still pending) rather than cancelled with no
  // replacement filed. Simulated by monkey-patching db.insertQuestion to throw once — the ONLY way to force
  // this real failure mode in a hermetic test without a genuine disk/constraint fault.
  const orderingPrior = await call(mgrServer, "question_ask", { title: "Prior ask for the ordering test", body: "b" });
  const orderingPriorId = orderingPrior.questionId;
  const realInsertQuestion = db.insertQuestion.bind(db);
  db.insertQuestion = () => { throw new Error("simulated insertQuestion failure"); };
  let orderingThrew;
  try {
    await call(mgrServer, "question_ask", { title: "Replacement that never lands", body: "b", supersedes: orderingPriorId });
  } catch (e) {
    orderingThrew = e;
  } finally {
    db.insertQuestion = realInsertQuestion;
  }
  check("(6) the simulated insert failure actually threw (the fixture is real)", !!orderingThrew);
  check("(6) the prior ask is STILL PENDING — never cancelled when the replacement failed to file", db.getQuestion(orderingPriorId).state === "pending");
  check("(6) no replacement question was left behind by the failed call", db.listQuestionsForAudit({ projectId: "pA" }).filter((q) => q.title === "Replacement that never lands").length === 0);
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — question_ask's explicit supersedes:<questionId> param atomically cancels the named prior pending ask (same ownership + pending-only + answer-race rules as question_cancel) while ALWAYS filing the new ask regardless of the supersede outcome, on both the manager and Lead surfaces, and omitting it stays byte-identical to before this param existed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
