import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// question_cancel + the human dismiss route (card feat(orchestration): question_cancel + dismiss). Before
// this, a pending Request could ONLY leave the human's inbox by being ANSWERED — a moot/superseded ask
// (the SAME agent re-asking with fresher info) sat pending forever. This adds ONE terminal 'cancelled'
// state reachable from 'pending' via TWO entry points: the agent-lineage-scoped `question_cancel` MCP tool
// (both the manager surface, mcp/orchestration.ts, and the Lead surface, mcp/platform.ts — sharing
// mcp/questionTool.ts's cancelQuestionForAgent verbatim) and the human-only REST dismiss route
// (POST /api/questions/:id/dismiss, mirroring the preset-suggestion store's existing Adopt/Dismiss pair).
//
// HERMETIC + CLAUDE-FREE — a REAL Db on a throwaway SQLite file, REAL OrchestrationMcpRouter/
// PlatformMcpRouter tool handlers invoked directly, and the REAL gateway buildServer for the REST dismiss
// route via app.inject. No pty, no real claude, no network.
//
// Covers:
//   (A) db.cancelQuestion — the core write: cancels a pending row, stamps reason/cancelledBy/cancelledAt;
//       THROWS naming the row's actual current state when it isn't pending; the THROW never touches the
//       row (no clobber of an existing answer).
//   (B) question_cancel (manager surface) — a manager cancelling its OWN pending ask succeeds; a DIFFERENT
//       agent's pending ask is rejected (ownership); a fresh successor session on the SAME agent lineage
//       may still cancel a predecessor's still-pending ask (mirrors question_pull's lineage scoping).
//   (C) THE RACE — a question answered between the caller's decision and the cancel call landing: the
//       cancel FAILS, names that an answer is now available, and the answer's chosenOption/note are
//       completely UNTOUCHED (never clobbered, never silently discarded).
//   (D) cancelling an already-cancelled / unknown question is rejected without changing anything.
//   (E) question_cancel is ALSO registered on the Lead (platform) surface, sharing the identical behavior.
//   (F) requests_list — 'cancelled' is excluded by default (like 'consumed'), surfaced via includeConsumed
//       or an explicit state:"cancelled" filter, and the row carries answer fields as null (never a
//       misleading false-ish credential/permission derivation) plus cancelledReason/cancelledBy.
//   (G) POST /api/questions/:id/dismiss — 404 on an unknown id; 200 + the cancelled Question on a pending
//       row; 409 (naming the actual state) on an already-answered OR already-cancelled row, in BOTH cases
//       never mutating the row; the cancelled row is retained via GET /api/questions?includeConsumed=true
//       but excluded from the default GET /api/questions.
//
// Run: 1) build (turbo builds shared first), 2) node test/question-cancel.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-question-cancel-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { buildServer } = await import("../dist/gateway/server.js");

const dbFile = path.join(tmpHome, "qc.db");
const db = new Db(dbFile);
const now = new Date().toISOString();

try {
  // --- fixtures: two projects, two agents (A, A2 sharing NO lineage with each other), a recycle
  // successor session on agent A's lineage, and a reserved Platform home for the Lead surface. ---
  db.insertProject({ id: "pA", name: "Project A", repoPath: "pA", vaultPath: "pA", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentA", projectId: "pA", name: "Mgr A", startupPrompt: "MGR", position: 0 });
  db.insertAgent({ id: "agentA2", projectId: "pA", name: "Mgr A2", startupPrompt: "MGR", position: 1 });
  db.insertSession({
    id: "mgrA", projectId: "pA", agentId: "agentA", engineSessionId: null, title: null, cwd: "pA",
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
  // A fresh (non-recycle) SUCCESSOR session on the SAME agent lineage as mgrA — proves lineage scoping,
  // not exact-session-id scoping (mirrors question_pull/requests_list({mine:true})'s ownership definition).
  db.insertSession({
    id: "mgrA-successor", projectId: "pA", agentId: "agentA", engineSessionId: null, title: null, cwd: "pA",
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

  const insertQ = (id, over) => {
    db.insertQuestion({
      id, sessionId: over.sessionId, projectId: over.projectId, type: over.type ?? "decision",
      title: over.title ?? `Q ${id}`, body: over.body ?? "b", options: over.options ?? null,
      recommendation: over.recommendation ?? null, taskId: over.taskId ?? null,
      permissionAction: over.permissionAction ?? null, permissionScope: over.permissionScope ?? null,
      permissionExpiresAt: over.permissionExpiresAt ?? null, credentialEnvVar: over.credentialEnvVar ?? null,
      provisionTarget: null, provisionConnectionId: null, provisionBindingState: "none",
      state: over.state ?? "pending", chosenOption: over.chosenOption ?? null, note: over.note ?? null,
      createdAt: over.createdAt ?? now, answeredAt: over.answeredAt ?? null, consumedAt: over.consumedAt ?? null,
      cancelledReason: null, cancelledBy: null, cancelledAt: null,
    });
    return id;
  };

  // ============ (A) db.cancelQuestion — the core write ============
  insertQ("a1", { sessionId: "mgrA", projectId: "pA", title: "Deploy timing?" });
  const cancelled1 = db.cancelQuestion("a1", { reason: "superseded by a fresher ask", cancelledBy: "agent" });
  check("(A) cancelQuestion returns the updated row", cancelled1.state === "cancelled");
  check("(A) reason/cancelledBy/cancelledAt are stamped", cancelled1.cancelledReason === "superseded by a fresher ask" && cancelled1.cancelledBy === "agent" && typeof cancelled1.cancelledAt === "string");
  check("(A) chosenOption/note stay null — a cancelled row was never answered", cancelled1.chosenOption === null && cancelled1.note === null);

  insertQ("a2", { sessionId: "mgrA", projectId: "pA", title: "Already answered" });
  db.answerQuestion("a2", { chosenOption: null, note: "go ahead", answeredAt: now });
  let threwA2;
  try { db.cancelQuestion("a2", { reason: "too late", cancelledBy: "agent" }); }
  catch (e) { threwA2 = e; }
  check("(A) cancelQuestion THROWS naming the actual state when not pending", threwA2 && threwA2.message.includes("already answered"));
  check("(A) the throw never touched the answered row — note/chosenOption intact", db.getQuestion("a2").note === "go ahead" && db.getQuestion("a2").state === "answered");

  check("(A) cancelQuestion returns undefined for an unknown id", db.cancelQuestion("no-such-id", { reason: null, cancelledBy: "agent" }) === undefined);

  // ============ MCP surfaces ============
  const sessions = new SessionService(db, { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null, purgeQueuedByQuestionIds: () => [] }, new OrchestrationControl());
  const router = new OrchestrationMcpRouter(db, sessions);
  const mgrServer = router.buildServer("mgrA", "manager");
  const call = async (server, name, args) => JSON.parse((await server._registeredTools[name].handler(args ?? {})).content[0].text);

  check("(B) question_cancel is registered on the manager surface", "question_cancel" in mgrServer._registeredTools);

  // ============ (B) own-ask cancel + ownership scoping ============
  insertQ("b1", { sessionId: "mgrA", projectId: "pA", title: "Mine to cancel" });
  const ownCancel = await call(mgrServer, "question_cancel", { questionId: "b1", reason: "moot now" });
  check("(B) cancelling your own pending ask succeeds", ownCancel.cancelled === true && ownCancel.questionId === "b1");
  check("(B) the row is now cancelled with the given reason", db.getQuestion("b1").state === "cancelled" && db.getQuestion("b1").cancelledReason === "moot now");

  insertQ("b2", { sessionId: "mgrA2", projectId: "pA", title: "Not yours" });
  const foreignCancel = await call(mgrServer, "question_cancel", { questionId: "b2" });
  check("(B) cancelling ANOTHER agent's pending ask is REJECTED", typeof foreignCancel.error === "string" && !foreignCancel.cancelled);
  check("(B) the foreign row is untouched (still pending)", db.getQuestion("b2").state === "pending");

  // A fresh successor session on the SAME agent lineage can still cancel a predecessor's pending ask.
  insertQ("b3", { sessionId: "mgrA", projectId: "pA", title: "Filed by the predecessor" });
  const successorServer = router.buildServer("mgrA-successor", "manager");
  const successorCancel = await call(successorServer, "question_cancel", { questionId: "b3" });
  check("(B) a fresh successor session on the SAME agent lineage may cancel a predecessor's pending ask", successorCancel.cancelled === true);
  check("(B) the row is cancelled", db.getQuestion("b3").state === "cancelled");

  // ============ (C) THE RACE — answered between the decision to cancel and the call landing ============
  insertQ("c1", { sessionId: "mgrA", projectId: "pA", title: "Racing the human's answer" });
  // Simulate the human's answer landing (the real REST answer route would do this) BEFORE the cancel call.
  db.answerQuestion("c1", { chosenOption: null, note: "the human's real decision", answeredAt: new Date().toISOString() });
  const racedCancel = await call(mgrServer, "question_cancel", { questionId: "c1" });
  check("(C) the cancel FAILS once an answer has landed", typeof racedCancel.error === "string" && !racedCancel.cancelled);
  check("(C) the error tells the caller an answer is now available (never a generic rejection)", racedCancel.error.includes("question_pull"));
  const c1After = db.getQuestion("c1");
  check("(C) the answer is COMPLETELY UNTOUCHED — never clobbered by the failed cancel", c1After.state === "answered" && c1After.note === "the human's real decision");
  check("(C) the row was never marked cancelled by the raced call", c1After.cancelledBy === null && c1After.cancelledReason === null);

  // ============ (D) already-cancelled / unknown ============
  const doubleCancel = await call(mgrServer, "question_cancel", { questionId: "b1" }); // b1 already cancelled above
  check("(D) cancelling an already-cancelled question is rejected (idempotent terminal state)", typeof doubleCancel.error === "string");
  const unknownCancel = await call(mgrServer, "question_cancel", { questionId: "does-not-exist" });
  check("(D) cancelling an unknown id is rejected", typeof unknownCancel.error === "string");

  // ============ (E) the Lead (platform) surface shares the identical behavior ============
  const platform = new PlatformMcpRouter(db, sessions);
  const leadServer = platform.buildServer("PL");
  check("(E) question_cancel is registered on the platform (Lead) surface", "question_cancel" in leadServer._registeredTools);
  insertQ("e1", { sessionId: "PL", projectId: "pHome", title: "Lead's own pending ask" });
  const leadCancel = await call(leadServer, "question_cancel", { questionId: "e1", reason: "no longer relevant" });
  check("(E) the Lead can cancel its own pending ask", leadCancel.cancelled === true);
  check("(E) cancelledBy is 'agent' on the Lead path too (the Lead is still an agent relative to the human)", db.getQuestion("e1").cancelledBy === "agent");
  // Ownership still applies on the Lead surface: it can't cancel a manager's ask.
  insertQ("e2", { sessionId: "mgrA", projectId: "pA", title: "Not the Lead's" });
  const leadForeignCancel = await call(leadServer, "question_cancel", { questionId: "e2" });
  check("(E) the Lead cannot cancel a manager's pending ask (ownership still scoped by agent lineage)", typeof leadForeignCancel.error === "string");

  // ============ (F) requests_list surfacing ============
  insertQ("f1", { sessionId: "mgrA", projectId: "pA", title: "For requests_list" });
  await call(mgrServer, "question_cancel", { questionId: "f1", reason: "listed check" });
  const defaultList = await call(mgrServer, "requests_list", {});
  check("(F) requests_list EXCLUDES cancelled by default (like consumed)", !defaultList.items.some((r) => r.id === "f1"));
  const withIncludeConsumed = await call(mgrServer, "requests_list", { includeConsumed: true });
  check("(F) includeConsumed:true folds cancelled rows in too", withIncludeConsumed.items.some((r) => r.id === "f1"));
  const explicitCancelled = await call(mgrServer, "requests_list", { state: "cancelled" });
  check("(F) an explicit state:\"cancelled\" filter surfaces it regardless of includeConsumed", explicitCancelled.items.some((r) => r.id === "f1"));
  const f1Row = explicitCancelled.items.find((r) => r.id === "f1");
  check("(F) the row carries chosenOption/note as null (never answered)", f1Row.chosenOption === null && f1Row.note === null);
  check("(F) the row carries the cancellation reason + actor", f1Row.cancelledReason === "listed check" && f1Row.cancelledBy === "agent");

  // A cancelled credential/permission row must never derive a false-ish "answered" reading either.
  insertQ("f2", { sessionId: "mgrA", projectId: "pA", title: "Cancelled credential", type: "credential", credentialEnvVar: "X" });
  await call(mgrServer, "question_cancel", { questionId: "f2" });
  const f2Row = (await call(mgrServer, "requests_list", { state: "cancelled" })).items.find((r) => r.id === "f2");
  check("(F) a cancelled CREDENTIAL never fabricates an ack (stays null, never claims 'provided')", f2Row.ack === null);
  insertQ("f3", { sessionId: "mgrA", projectId: "pA", title: "Cancelled permission", type: "permission", permissionAction: "rm -rf /tmp/x" });
  await call(mgrServer, "question_cancel", { questionId: "f3" });
  const f3Row = (await call(mgrServer, "requests_list", { state: "cancelled" })).items.find((r) => r.id === "f3");
  check("(F) a cancelled PERMISSION reads approved:null (never a false 'denied')", f3Row.approved === null);

  // ============ (G) POST /api/questions/:id/dismiss ============
  const stub = {};
  const app = await buildServer({ db, pty: { enqueueStdin: () => ({ delivered: false }) }, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
  try {
    const missing = await app.inject({ method: "POST", url: "/api/questions/no-such-id/dismiss" });
    check("(G) dismiss on an unknown id -> 404", missing.statusCode === 404);

    insertQ("g1", { sessionId: "mgrA", projectId: "pA", title: "Human dismiss target" });
    const dismissed = await app.inject({ method: "POST", url: "/api/questions/g1/dismiss", payload: { reason: "duplicate ask" } });
    check("(G) dismiss on a pending row -> 200", dismissed.statusCode === 200);
    const dismissedBody = dismissed.json();
    check("(G) returns the cancelled Question with cancelledBy:\"human\"", dismissedBody.state === "cancelled" && dismissedBody.cancelledBy === "human" && dismissedBody.cancelledReason === "duplicate ask");

    // 409 on an already-answered row — and the answer must survive completely untouched.
    insertQ("g2", { sessionId: "mgrA", projectId: "pA", title: "Already answered, human tries to dismiss" });
    db.answerQuestion("g2", { chosenOption: null, note: "the real answer", answeredAt: new Date().toISOString() });
    const dismissAnswered = await app.inject({ method: "POST", url: "/api/questions/g2/dismiss" });
    check("(G) dismiss on an ALREADY-ANSWERED row -> 409 (never silently discards the answer)", dismissAnswered.statusCode === 409);
    check("(G) the 409 names the row's actual state", dismissAnswered.json().error.includes("answered"));
    check("(G) the answer is untouched after the rejected dismiss", db.getQuestion("g2").state === "answered" && db.getQuestion("g2").note === "the real answer");

    // 409 on an already-cancelled row (double-dismiss is a no-op, not a silent success).
    const doubleDismiss = await app.inject({ method: "POST", url: "/api/questions/g1/dismiss" });
    check("(G) dismissing an already-cancelled row -> 409", doubleDismiss.statusCode === 409);
    check("(G) the 409 names 'cancelled'", doubleDismiss.json().error.includes("cancelled"));

    // Retained in history: excluded from the default inbox, present via includeConsumed=true.
    const defaultInbox = await app.inject({ method: "GET", url: "/api/questions" });
    check("(G) the default GET /api/questions EXCLUDES the cancelled row", !defaultInbox.json().some((q) => q.id === "g1"));
    const historyInbox = await app.inject({ method: "GET", url: "/api/questions?includeConsumed=true" });
    const g1History = historyInbox.json().find((q) => q.id === "g1");
    check("(G) GET /api/questions?includeConsumed=true RETAINS the cancelled row", !!g1History && g1History.state === "cancelled");
    check("(G) the retained row still carries its reason + actor", g1History.cancelledReason === "duplicate ask" && g1History.cancelledBy === "human");
  } finally {
    await app.close();
  }
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — question_cancel (manager + Lead surfaces) and the human dismiss route both land ONE terminal 'cancelled' state, agent-lineage-scoped ownership is enforced, an already-answered/already-cancelled row is REFUSED on both paths without ever clobbering what it already became (the answer race), and a cancelled row is retained in history (excluded by default, surfaced via includeConsumed/an explicit state filter) with its reason + actor intact."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
