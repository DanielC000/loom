import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// question_amend + the requests_list `stale` flag (card 5ea0153c). Before this, a pending Request could
// only be edited by cancel-and-refiling it as a brand new row — 6 of 20 asks were superseded this way,
// each costing the owner their queue position and the surrounding context. This adds:
//   (1) `question_amend(questionId, {title?, body?, options?})` — updates the pending row IN PLACE and
//       fires a `question_amended` event (the same notification twin `question_ask` fires for a fresh
//       ask), on both the manager surface (mcp/orchestration.ts) and the Lead surface (mcp/platform.ts),
//       sharing mcp/questionTool.ts's amendQuestionForAgent verbatim.
//   (2) `requests_list`'s `stale` flag — true only for a still-pending row whose CURRENT routing session
//       isn't live right now (a SOFT flag, never an auto-cancel — the auto-reap defect).
//
// HERMETIC + CLAUDE-FREE — a REAL Db on a throwaway SQLite file, REAL OrchestrationMcpRouter/
// PlatformMcpRouter tool handlers invoked directly. No pty, no real claude, no network.
//
// Covers:
//   (A) db.amendQuestion — the core write: partial patch (each field independently optional), clearing
//       options back to null, THROWS naming the row's actual state when it isn't pending.
//   (B) question_amend (manager surface) — a manager amending its OWN pending ask succeeds; a DIFFERENT
//       agent's pending ask is rejected (ownership); a fresh successor session on the SAME agent lineage
//       may still amend a predecessor's still-pending ask.
//   (C) THE RACE — a question answered between the caller's decision and the amend call landing: the
//       amend FAILS and the answer is completely untouched.
//   (D) amending an already-cancelled / unknown question is rejected without changing anything.
//   (E) options can only be amended on a type:"decision" request.
//   (F) at least one of title/body/options is required.
//   (G) question_amend is ALSO registered on the Lead (platform) surface, sharing identical behavior.
//   (H) a successful amend fires a durable `question_amended` event carrying the POST-amend title.
//   (I) attention-push's classify()/alertLine() handle `question_amended` (decision-pending, "amended"
//       wording distinct from question_asked's "needed" wording).
//   (J) requests_list's `stale` flag: pending + live routing session -> false; pending + non-live -> true;
//       answered + non-live -> false (never "moot" once resolved).
//
// Run: 1) build (turbo builds shared first), 2) node test/question-amend.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-question-amend-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { classify, alertLine } = await import("../dist/companion/attention-push.js");

const dbFile = path.join(tmpHome, "qa.db");
const db = new Db(dbFile);
const now = new Date().toISOString();

try {
  // --- fixtures: two projects, two agents (A, A2 sharing NO lineage with each other), a recycle
  // successor session on agent A's lineage, an EXITED (non-live) session on its own lineage for the
  // staleness checks, and a reserved Platform home for the Lead surface. ---
  db.insertProject({ id: "pA", name: "Project A", repoPath: "pA", vaultPath: "pA", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentA", projectId: "pA", name: "Mgr A", startupPrompt: "MGR", position: 0 });
  db.insertAgent({ id: "agentA2", projectId: "pA", name: "Mgr A2", startupPrompt: "MGR", position: 1 });
  db.insertAgent({ id: "agentGone", projectId: "pA", name: "Mgr Gone", startupPrompt: "MGR", position: 2 });
  db.insertSession({
    id: "mgrA", projectId: "pA", agentId: "agentA", engineSessionId: null, title: null, cwd: "pA",
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
  // A fresh (non-recycle) SUCCESSOR session on the SAME agent lineage as mgrA — proves lineage scoping,
  // not exact-session-id scoping (mirrors question_cancel/question_pull's ownership definition).
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
  // Ended without a successor: 'exited', nobody ever reparented a question off it — the (J) staleness case.
  db.insertSession({
    id: "mgrGone", projectId: "pA", agentId: "agentGone", engineSessionId: null, title: null, cwd: "pA",
    processState: "exited", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
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
      permissionAction: over.permissionAction ?? null, permissionScopeHint: over.permissionScopeHint ?? null,
      permissionExpiresAt: over.permissionExpiresAt ?? null, credentialEnvVar: over.credentialEnvVar ?? null,
      provisionTarget: null, provisionConnectionId: null, provisionBindingState: "none",
      state: over.state ?? "pending", chosenOption: over.chosenOption ?? null, note: over.note ?? null,
      createdAt: over.createdAt ?? now, answeredAt: over.answeredAt ?? null, consumedAt: over.consumedAt ?? null,
      cancelledReason: null, cancelledBy: null, cancelledAt: null,
    });
    return id;
  };

  // ============ (A) db.amendQuestion — the core write ============
  insertQ("a1", { sessionId: "mgrA", title: "Original title", body: "original body", options: ["yes", "no"], projectId: "pA" });
  const amended1 = db.amendQuestion("a1", { title: "Corrected title" });
  check("(A) amending only title keeps body/options unchanged", amended1.title === "Corrected title" && amended1.body === "original body" && JSON.stringify(amended1.options) === JSON.stringify(["yes", "no"]));
  const amended2 = db.amendQuestion("a1", { options: [] });
  check("(A) amending options to an empty array clears them to null (pure-blocker)", amended2.options === null);
  check("(A) title/body from the earlier amend survive an unrelated later amend", amended2.title === "Corrected title" && amended2.body === "original body");

  insertQ("a2", { sessionId: "mgrA", title: "Already answered", projectId: "pA" });
  db.answerQuestion("a2", { chosenOption: null, note: "go ahead", answeredAt: now });
  let threwA2;
  try { db.amendQuestion("a2", { title: "too late" }); } catch (e) { threwA2 = e; }
  check("(A) amendQuestion THROWS naming the actual state when not pending", threwA2 && threwA2.message.includes("already answered"));
  check("(A) the throw never touched the answered row", db.getQuestion("a2").title === "Already answered" && db.getQuestion("a2").note === "go ahead");

  check("(A) amendQuestion returns undefined for an unknown id", db.amendQuestion("no-such-id", { title: "x" }) === undefined);

  // ============ MCP surfaces ============
  const sessions = new SessionService(db, { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null, purgeQueuedByQuestionIds: () => [] }, new OrchestrationControl());
  const router = new OrchestrationMcpRouter(db, sessions);
  const mgrServer = router.buildServer("mgrA", "manager");
  const call = async (server, name, args) => JSON.parse((await server._registeredTools[name].handler(args ?? {})).content[0].text);

  check("(B) question_amend is registered on the manager surface", "question_amend" in mgrServer._registeredTools);

  // ============ (B) own-ask amend + ownership scoping ============
  insertQ("b1", { sessionId: "mgrA", title: "Mine to amend", projectId: "pA" });
  const ownAmend = await call(mgrServer, "question_amend", { questionId: "b1", title: "Mine, corrected" });
  check("(B) amending your own pending ask succeeds", ownAmend.amended === true && ownAmend.questionId === "b1");
  check("(B) the row now carries the new title", db.getQuestion("b1").title === "Mine, corrected");
  check("(B) it is still the SAME row (id unchanged, still pending — no new row was created)", db.getQuestion("b1").state === "pending");

  insertQ("b2", { sessionId: "mgrA2", title: "Not yours", projectId: "pA" });
  const foreignAmend = await call(mgrServer, "question_amend", { questionId: "b2", title: "hijacked" });
  check("(B) amending ANOTHER agent's pending ask is REJECTED", typeof foreignAmend.error === "string" && !foreignAmend.amended);
  check("(B) the foreign row's title is untouched", db.getQuestion("b2").title === "Not yours");

  // A fresh successor session on the SAME agent lineage can still amend a predecessor's pending ask.
  insertQ("b3", { sessionId: "mgrA", title: "Filed by the predecessor", projectId: "pA" });
  const successorServer = router.buildServer("mgrA-successor", "manager");
  const successorAmend = await call(successorServer, "question_amend", { questionId: "b3", body: "updated by successor" });
  check("(B) a fresh successor session on the SAME agent lineage may amend a predecessor's pending ask", successorAmend.amended === true);
  check("(B) the row reflects the successor's edit", db.getQuestion("b3").body === "updated by successor");

  // ============ (C) THE RACE — answered between the decision to amend and the call landing ============
  insertQ("c1", { sessionId: "mgrA", title: "Racing the human's answer", projectId: "pA" });
  db.answerQuestion("c1", { chosenOption: null, note: "the human's real decision", answeredAt: new Date().toISOString() });
  const racedAmend = await call(mgrServer, "question_amend", { questionId: "c1", title: "too slow" });
  check("(C) the amend FAILS once an answer has landed", typeof racedAmend.error === "string" && !racedAmend.amended);
  check("(C) the error tells the caller an answer is now available", racedAmend.error.includes("question_pull"));
  const c1After = db.getQuestion("c1");
  check("(C) the answer is COMPLETELY UNTOUCHED — never clobbered by the failed amend", c1After.state === "answered" && c1After.note === "the human's real decision");
  check("(C) the title was never rewritten by the raced call", c1After.title === "Racing the human's answer");

  // ============ (D) already-cancelled / unknown ============
  insertQ("d1", { sessionId: "mgrA", title: "Will be cancelled", projectId: "pA" });
  await call(mgrServer, "question_cancel", { questionId: "d1" });
  const cancelledAmend = await call(mgrServer, "question_amend", { questionId: "d1", title: "too late" });
  check("(D) amending an already-cancelled question is rejected", typeof cancelledAmend.error === "string");
  const unknownAmend = await call(mgrServer, "question_amend", { questionId: "does-not-exist", title: "x" });
  check("(D) amending an unknown id is rejected", typeof unknownAmend.error === "string");

  // ============ (E) options only on type:"decision" ============
  insertQ("e1", { sessionId: "mgrA", title: "An input ask", projectId: "pA", type: "input" });
  const badOptionsAmend = await call(mgrServer, "question_amend", { questionId: "e1", options: ["a", "b"] });
  check('(E) amending `options` on a non-"decision" request is REJECTED', typeof badOptionsAmend.error === "string" && badOptionsAmend.error.includes("decision"));
  check("(E) the row is untouched", db.getQuestion("e1").options === null);

  // ============ (F) at least one field required ============
  insertQ("f1", { sessionId: "mgrA", title: "Nothing to amend", projectId: "pA" });
  const emptyAmend = await call(mgrServer, "question_amend", { questionId: "f1" });
  check("(F) an amend with no title/body/options is rejected", typeof emptyAmend.error === "string");

  // ============ (G) the Lead (platform) surface shares the identical behavior ============
  const platform = new PlatformMcpRouter(db, sessions);
  const leadServer = platform.buildServer("PL");
  check("(G) question_amend is registered on the platform (Lead) surface", "question_amend" in leadServer._registeredTools);
  insertQ("g1", { sessionId: "PL", title: "Lead's own pending ask", projectId: "pHome" });
  const leadAmend = await call(leadServer, "question_amend", { questionId: "g1", title: "Lead's corrected ask" });
  check("(G) the Lead can amend its own pending ask", leadAmend.amended === true);
  check("(G) the row reflects the Lead's edit", db.getQuestion("g1").title === "Lead's corrected ask");
  insertQ("g2", { sessionId: "mgrA", title: "Not the Lead's", projectId: "pA" });
  const leadForeignAmend = await call(leadServer, "question_amend", { questionId: "g2", title: "hijacked" });
  check("(G) the Lead cannot amend a manager's pending ask (ownership still scoped by agent lineage)", typeof leadForeignAmend.error === "string");

  // ============ (H) durable question_amended event, carrying the POST-amend title ============
  insertQ("h1", { sessionId: "mgrA", title: "Event check original", projectId: "pA" });
  await call(mgrServer, "question_amend", { questionId: "h1", title: "Event check amended" });
  const amendEvents = db.listEventsSince(0, 10_000).filter((e) => e.kind === "question_amended");
  const h1Event = amendEvents.find((e) => e.detail?.questionId === "h1");
  check("(H) a question_amended event was recorded", !!h1Event);
  check("(H) it carries the POST-amend title, not the original", !!h1Event && h1Event.detail.title === "Event check amended");

  // ============ (I) attention-push classify()/alertLine() ============
  check('(I) classify("question_amended") -> "decision-pending" (same class as a fresh ask)', classify("question_amended", {}) === "decision-pending");
  const amendedLine = alertLine(
    { kind: "question_amended", managerSessionId: "mgrA", detail: { questionId: "h1", title: "Event check amended" } },
    "decision-pending", "Project A",
  );
  check('(I) alertLine renders "amended" wording, distinct from question_asked\'s "needed"', amendedLine.includes("amended") && !amendedLine.includes("decision needed"));
  check("(I) alertLine carries the resolvable questionId", amendedLine.includes("question:h1"));

  // ============ (J) requests_list's `stale` flag ============
  insertQ("j1", { sessionId: "mgrA", title: "Pending, asker still live", projectId: "pA" });
  insertQ("j2", { sessionId: "mgrGone", title: "Pending, asker's session has exited", projectId: "pA" });
  insertQ("j3", { sessionId: "mgrGone", title: "Answered, asker's session has exited", projectId: "pA" });
  db.answerQuestion("j3", { chosenOption: null, note: "answered anyway", answeredAt: now });

  const listForStale = await call(mgrServer, "requests_list", { includeConsumed: true });
  const j1Row = listForStale.items.find((r) => r.id === "j1");
  const j2Row = listForStale.items.find((r) => r.id === "j2");
  const j3Row = listForStale.items.find((r) => r.id === "j3");
  check("(J) a pending row whose routing session is LIVE is NOT stale", j1Row && j1Row.stale === false);
  check("(J) a pending row whose routing session has EXITED is stale:true", j2Row && j2Row.stale === true);
  check("(J) an ANSWERED row is never stale, even with a non-live routing session", j3Row && j3Row.stale === false);
} finally {
  try { db.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — question_amend (manager + Lead surfaces) updates a still-pending ask IN PLACE (never a new row), agent-lineage-scoped ownership is enforced, an already-answered/already-cancelled row is REFUSED without ever clobbering what it already became (the answer race), options are gated to type:\"decision\", at least one field is required, a successful amend fires a durable question_amended event (attention-push classifies it decision-pending and renders it with distinct \"amended\" wording), and requests_list's stale flag correctly distinguishes a pending ask with a live asker from one whose asker's session has exited — never flagging an already-answered row."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
