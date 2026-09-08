import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0ad1ca68 (half 2) — "an owner hold that outlives its request has no durable representation."
// Real specimen (session `bb707b3f`): a multi-harness epic was held by an already-CONSUMED 2026-08-27
// answer, with no open request left in the owner's inbox — the owner couldn't find "which request is
// related to multi-harness epic" because the link lived only in body prose, invisible to any mechanical
// surface. `Task.heldRequestId` (mcp/tasks.ts's `updateProjectTask` + `resolveHeldRequestState`) is the
// fix: a standing, agent-settable annotation naming WHICH Request a card's hold traces back to, resolved
// LIVE (never cached) at read time — so the link survives the Request moving through
// pending → answered → consumed, or even being deleted (fail-visible, never silently dropped).
//
// HERMETIC, claude-free — a REAL Db + the REAL TaskMcpRouter/OrchestrationMcpRouter over in-process MCP
// InMemoryTransports (mirrors task-requests-read.mjs), no real claude/network/daemon.
//
// Covers:
//   (A) set-time validation: a bogus/foreign heldRequestId is REJECTED, nothing written.
//   (B) tasks_get resolves heldRequestState LIVE while the linked request is still pending.
//   🔴 (C) THE POINT OF THE CARD: the request is answered, THEN consumed (question_pull) — the link
//       (heldRequestId) and its live-resolved state REMAIN mechanically visible via tasks_get, not just
//       in prose. This is the negative control too: prove the OLD read (the ordinary taskId-linked
//       `requests` summary) would ALSO show a consumed row when linked by taskId — the new field's value
//       is specifically that a request NOT tied to this card's own taskId still resolves.
//   (D) heldRequestId survives independently of the request's own (different, or absent) taskId link —
//       the exact shape the specimen needed: a project-wide (taskId:null) owner decision gating a card
//       it was never itself linked to.
//   (E) clearing (heldRequestId:null) removes the link; a dangling reference (request since deleted)
//       degrades to a fail-visible {notFound:true}, never silently vanishes.
//   (F) the trimmed tasks_update ack echoes heldRequestId (a field-only patch, no body).
//
// Run: 1) build (turbo builds shared first), 2) node test/held-request-link.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-held-request-link-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const dbFile = path.join(tmpHome, "hrl.db");
const db = new Db(dbFile);
const now = new Date().toISOString();
const projId = "hrl-proj", otherProjId = "hrl-proj-2", agentId = "hrl-agent", mgrId = "hrl-mgr";

async function taskClient(router, projectId, sessionId) {
  const server = router.buildServer(projectId, sessionId);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "held-request-link-test", version: "0" });
  await client.connect(clientT);
  return { client, call: async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text) };
}

try {
  db.insertProject({ id: projId, name: "HRL", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: otherProjId, name: "HRL2", repoPath: otherProjId, vaultPath: otherProjId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "Manager", startupPrompt: "BRIEF", position: 0 });
  db.insertSession({
    id: mgrId, projectId: projId, agentId, engineSessionId: "eng-hrl", title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });

  // Epic-shaped sibling card: the card that's HELD, but the owner's decision was filed against a
  // DIFFERENT card entirely (or no card at all) — the exact shape the real specimen needed.
  const epicId = "aaaaaaaa-0000-4000-8000-000000000010";
  db.insertTask({ id: epicId, projectId: projId, title: "epic decision card", body: "b", columnKey: "backlog", position: 0, priority: "p2", createdAt: now, updatedAt: now });
  const siblingId = "bbbbbbbb-0000-4000-8000-000000000011";
  db.insertTask({ id: siblingId, projectId: projId, title: "sibling card held by the epic's decision", body: "b", columnKey: "waiting", held: true, heldBy: "human", position: 1, priority: "p2", createdAt: now, updatedAt: now });

  const wakes = new WakeService({ db, pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null }, resume: () => {} });
  const taskRouter = new TaskMcpRouter(db, wakes);
  const orchRouter = new OrchestrationMcpRouter(db, { purgeAnsweredQuestionNudges() {} });
  const { client: tClient, call: tCall } = await taskClient(taskRouter, projId, mgrId);
  const mgrServer = orchRouter.buildServer(mgrId, "manager");
  const askParse = (r) => JSON.parse(r.content[0].text);
  const ask = async (args) => askParse(await mgrServer._registeredTools["question_ask"].handler(args));

  // A project-wide owner "decision" ask — taskId:null, tied to NEITHER card (mirrors real owner
  // decisions per idle-watcher.ts's own `hasPendingQuestionForSession` rationale).
  const decision = await ask({ type: "decision", title: "Which harness for the epic?", body: "pick one", options: ["A", "B"] });
  check("setup: the decision request is filed with no taskId", db.getQuestion(decision.questionId).taskId === null);

  // ============================ (A) set-time validation ============================
  const bogus = await tCall("tasks_update", { id: siblingId, heldRequestId: "not-a-real-request-id" });
  check("(A) an unresolvable heldRequestId is REJECTED", typeof bogus.error === "string");
  check("(A) nothing was written on rejection", (await tCall("tasks_get", { id: siblingId })).heldRequestId == null);

  // A request from a DIFFERENT project must not be linkable either (cross-project scoping).
  const otherAgentId = "hrl2-agent", otherMgrId = "hrl2-mgr";
  db.insertAgent({ id: otherAgentId, projectId: otherProjId, name: "Other Manager", startupPrompt: "", position: 0 });
  db.insertSession({
    id: otherMgrId, projectId: otherProjId, agentId: otherAgentId, engineSessionId: "eng-hrl2", title: null, cwd: otherProjId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager",
  });
  const otherServer = orchRouter.buildServer(otherMgrId, "manager");
  const foreignAsk = askParse(await otherServer._registeredTools["question_ask"].handler({ title: "Foreign project ask", body: "b" }));
  const foreignLink = await tCall("tasks_update", { id: siblingId, heldRequestId: foreignAsk.questionId });
  check("(A) a request from ANOTHER project cannot be linked (cross-project scoping)", typeof foreignLink.error === "string");

  // ============================ set the real link ============================
  const linked = await tCall("tasks_update", { id: siblingId, heldRequestId: decision.questionId });
  check("(F) the trimmed ack echoes heldRequestId", linked.heldRequestId === decision.questionId && Array.isArray(linked.changed) && linked.changed.includes("heldRequestId"));

  // ============================ (B) live-resolved while pending ============================
  const whilePending = await tCall("tasks_get", { id: siblingId });
  check("(B) heldRequestId round-trips", whilePending.heldRequestId === decision.questionId);
  check("(B) heldRequestState resolves LIVE, state:pending", whilePending.heldRequestState?.notFound === false && whilePending.heldRequestState.state === "pending");
  check("(B) heldRequestState carries the request's title", whilePending.heldRequestState.title === "Which harness for the epic?");

  // ============================ (D) survives being tied to NEITHER card via taskId ============================
  check("(D) the epic card's OWN ordinary requests summary does NOT show this decision (taskId:null)", (await tCall("tasks_get", { id: epicId })).requests.total === 0);
  check("(D) the sibling card's ORDINARY requests summary (taskId-linked) also does NOT show it", whilePending.requests.total === 0);
  check("(D) yet heldRequestState DOES surface it — this is the whole point of the field", whilePending.heldRequestState.state === "pending");

  // ============================ 🔴 (C) THE POINT: survives answer AND consumption ============================
  db.answerQuestion(decision.questionId, { chosenOption: "B", note: "went with B", answeredAt: new Date().toISOString() });
  const afterAnswer = await tCall("tasks_get", { id: siblingId });
  check("🔴 (C) after the request is ANSWERED, heldRequestId is still on the card", afterAnswer.heldRequestId === decision.questionId);
  check("🔴 (C) heldRequestState re-resolves to state:answered (LIVE, not stale)", afterAnswer.heldRequestState.state === "answered");

  // The asking manager drains it — the row flips to 'consumed', the terminal state a real owner decision
  // eventually reaches (mirrors task-requests-read.mjs's own (E) section).
  const pulled = askParse(await mgrServer._registeredTools["question_pull"].handler({}));
  check("setup: question_pull actually drained the answered decision", pulled.questions.some((q) => q.questionId === decision.questionId));
  check("setup: the underlying row is now 'consumed'", db.getQuestion(decision.questionId).state === "consumed");

  const afterConsumed = await tCall("tasks_get", { id: siblingId });
  check("🔴🔴 (C) THE CARD'S DoD: heldRequestId SURVIVES consumption — still on the card", afterConsumed.heldRequestId === decision.questionId);
  check("🔴🔴 (C) heldRequestState still mechanically resolves — state:consumed, not vanished", afterConsumed.heldRequestState?.notFound === false && afterConsumed.heldRequestState.state === "consumed");
  // Negative control for (C): the ORDINARY taskId-linked path (task_requests_list / the `requests`
  // summary) is KNOWN to survive consumption too (task-requests-read.mjs (E) already proves this for a
  // request LINKED BY taskId) — so this isn't "any field magically survives consumption", it's specifically
  // that heldRequestState resolves for a request this card was NEVER taskId-linked to in the first place.
  check("(C) negative control: the sibling's ordinary requests summary is STILL 0 (never taskId-linked)", afterConsumed.requests.total === 0);

  // ============================ (E) clear + dangling reference ============================
  const cleared = await tCall("tasks_update", { id: siblingId, heldRequestId: null });
  check("(E) heldRequestId clears to null", cleared.heldRequestId === null);
  const afterClear = await tCall("tasks_get", { id: siblingId });
  check("(E) heldRequestState reads null once cleared", afterClear.heldRequestState === null);

  // Re-link, then delete the underlying request row out from under it (simulates a hard-deleted request)
  // to prove a dangling reference degrades FAIL-VISIBLE rather than silently vanishing.
  await tCall("tasks_update", { id: siblingId, heldRequestId: decision.questionId });
  {
    const raw = new Database(dbFile);
    raw.prepare("DELETE FROM questions WHERE id = ?").run(decision.questionId);
    raw.close();
  }
  const afterDangling = await tCall("tasks_get", { id: siblingId });
  check("(E) a dangling heldRequestId is FAIL-VISIBLE ({notFound:true}), never silently dropped", afterDangling.heldRequestId === decision.questionId && afterDangling.heldRequestState?.notFound === true && afterDangling.heldRequestState.id === decision.questionId);

  await tClient.close();
} finally {
  try { db.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — Task.heldRequestId is a standing, agent-settable, project-scope-validated annotation naming which owner Request a card's hold traces back to; tasks_get resolves it LIVE (heldRequestState) via the REAL tasks_update/tasks_get MCP tools — surviving the linked request moving through pending → answered → consumed (the card's own DoD), independent of that request's own (different-or-absent) taskId link, degrading fail-visibly on a dangling reference instead of silently dropping, and echoed on the trimmed tasks_update ack."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
