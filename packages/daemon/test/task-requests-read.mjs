import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 988bb585: surface a task's connected Requests to agents working that task, and add a
// NON-consuming task-scoped request read pair. HERMETIC, claude-free — a REAL Db + the REAL
// TaskMcpRouter/OrchestrationMcpRouter over in-process MCP InMemoryTransports, no real claude/network/daemon.
//
// Covers:
//   (A) END-TO-END WIRING — a REAL question_ask call (through the manager MCP tool, not a raw db.insert)
//       with a taskId actually stamps task_id on the row.
//   (B) tasks_get's connected-requests summary — {total,answered,pending,items} — driven through the
//       REAL tasks_get tool (the "real-agent" check the DoD asks for), before and after an answer.
//   (C) task_requests_list — lightweight rows, title-altitude, all states.
//   (D) task_request_get — full body/options/recommendation/state + answer-by-type, for decision,
//       permission (pending -> answered), and credential (the never-leaks-secret_blob property).
//   (E) NON-CONSUMING — both new tools are re-readable across repeated calls AND after the asking agent's
//       own question_pull has already drained+consumed the row (question_pull's own drain is UNCHANGED).
//   (F) project/task scoping — a mismatched taskId errors; a cross-project request id is not-found; AND
//       the CR-flagged asymmetry: a FOREIGN-project question_ask carrying THIS project's task id (taskId
//       is agent-supplied + never validated against the asking session's own project) must NOT leak into
//       task_requests_list or tasks_get's summary, symmetric with task_request_get's own project guard.
//   (G) taskId accepts an unambiguous 8-char id-prefix (mirrors tasks_get).
//
// Run: 1) build (turbo builds shared first), 2) node test/task-requests-read.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-task-requests-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { encryptSecret } = await import("../dist/keys/envelope.js");
const { PERMISSION_ANSWERS } = await import("@loom/shared");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const dbFile = path.join(tmpHome, "tr.db");
const keyPath = path.join(tmpHome, "secret.key"); // isolated test key — NEVER the real SECRET_KEY_PATH
const db = new Db(dbFile);
const now = new Date().toISOString();
const projId = "tr-proj", otherProjId = "tr-proj-2", agentId = "tr-agent", mgrId = "tr-mgr";

// Task-scoped MCP client over a REAL in-process transport (mirrors tasks-get-taskid-alias.mjs).
async function taskClient(router, projectId, sessionId) {
  const server = router.buildServer(projectId, sessionId);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "task-requests-read-test", version: "0" });
  await client.connect(clientT);
  return {
    client,
    call: async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text),
    // task_requests_list mirrors tasks_list's NDJSON shape (one JSON object per line, not a JSON array) —
    // see server.ts's okLines / tasks-list-ndjson-filter.mjs.
    callList: async (name, args) => {
      const text = (await client.callTool({ name, arguments: args })).content[0].text;
      const rows = text.split("\n").filter(Boolean).map((l) => JSON.parse(l));
      return rows.length === 1 && "error" in rows[0] ? rows[0] : rows;
    },
  };
}

try {
  db.insertProject({ id: projId, name: "TR", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: otherProjId, name: "TR2", repoPath: otherProjId, vaultPath: otherProjId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "Manager", startupPrompt: "BRIEF", position: 0 });
  db.insertSession({
    id: mgrId, projectId: projId, agentId, engineSessionId: "eng-tr", title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });

  const T = "bbbbbbbb-0000-4000-8000-000000000001";
  db.insertTask({ id: T, projectId: projId, title: "card with requests", body: "b", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
  const emptyTaskId = "cccccccc-0000-4000-8000-000000000002";
  db.insertTask({ id: emptyTaskId, projectId: projId, title: "card with NO requests", body: "b", columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now });
  // A same-prefix pair, distinct from T/emptyTaskId, purely to exercise question_ask's AMBIGUOUS
  // taskId-prefix rejection (card 9be9784a part H) without disturbing section (G)'s use of T's prefix.
  const ambigA = "dddddddd-0000-4000-8000-000000000003";
  const ambigB = "dddddddd-0000-4000-8000-000000000004";
  db.insertTask({ id: ambigA, projectId: projId, title: "ambiguous prefix A", body: "b", columnKey: "backlog", position: 3, priority: "p2", createdAt: now, updatedAt: now });
  db.insertTask({ id: ambigB, projectId: projId, title: "ambiguous prefix B", body: "b", columnKey: "backlog", position: 4, priority: "p2", createdAt: now, updatedAt: now });

  const wakes = new WakeService({ db, pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null }, resume: () => {} });
  const taskRouter = new TaskMcpRouter(db, wakes);
  const orchRouter = new OrchestrationMcpRouter(db, { purgeAnsweredQuestionNudges() {} });

  const { client: tClient, call: tCall, callList: tCallList } = await taskClient(taskRouter, projId, mgrId);
  const mgrServer = orchRouter.buildServer(mgrId, "manager");
  const askParse = (r) => JSON.parse(r.content[0].text);
  const ask = async (args) => askParse(await mgrServer._registeredTools["question_ask"].handler(args));

  // ============================ (A) end-to-end wiring: question_ask really stamps task_id ============
  const askResult = await ask({
    type: "decision", title: "Which library?", body: "pick one", options: ["A", "B"], recommendation: "A", taskId: T,
  });
  check("(A) question_ask returns a questionId", typeof askResult.questionId === "string");
  const q1 = db.getQuestion(askResult.questionId);
  check("(A) the REAL question_ask call actually stamped task_id on the row", q1.taskId === T);

  // ============================ (B) tasks_get connected-requests summary (real tool, pre-answer) ======
  const taskPending = await tCall("tasks_get", { id: T });
  check("(B) tasks_get returns the task (no error)", !taskPending.error && taskPending.id === T);
  check("(B) requests.total is 1", taskPending.requests?.total === 1);
  check("(B) requests.pending is 1, answered is 0 (not yet answered)", taskPending.requests.pending === 1 && taskPending.requests.answered === 0);
  check("(B) requests.items carries {id,type,title,state}", taskPending.requests.items[0].id === askResult.questionId && taskPending.requests.items[0].type === "decision" && taskPending.requests.items[0].title === "Which library?" && taskPending.requests.items[0].state === "pending");
  const taskEmpty = await tCall("tasks_get", { id: emptyTaskId });
  check("(B) a task with NO connected requests reads {total:0,pending:0,answered:0,items:[]}", taskEmpty.requests.total === 0 && taskEmpty.requests.pending === 0 && taskEmpty.requests.answered === 0 && Array.isArray(taskEmpty.requests.items) && taskEmpty.requests.items.length === 0);

  // Answer it (mirrors the human-only REST route) — flips pending -> answered.
  db.answerQuestion(askResult.questionId, { chosenOption: "B", note: "went with B", answeredAt: new Date().toISOString() });

  const taskAnswered = await tCall("tasks_get", { id: T });
  check("(B) after answering, requests.answered is 1 and pending is 0 ('answered' folds into the answered bucket)", taskAnswered.requests.answered === 1 && taskAnswered.requests.pending === 0);
  check("(B) requests.items reflects the new state", taskAnswered.requests.items[0].state === "answered");

  // ============================ (C) task_requests_list — lightweight rows, all states =================
  const listed = await tCallList("task_requests_list", { taskId: T });
  check("(C) task_requests_list returns exactly one row", Array.isArray(listed) && listed.length === 1);
  check("(C) the row is title-altitude: {id,type,title,state,answeredAt}", listed[0].id === askResult.questionId && listed[0].type === "decision" && listed[0].title === "Which library?" && listed[0].state === "answered" && typeof listed[0].answeredAt === "string");
  check("(C) the row does NOT carry body/options (title-altitude only)", listed[0].body === undefined && listed[0].options === undefined);

  // ============================ (D) task_request_get — full body + answer-by-type ======================
  const gotten = await tCall("task_request_get", { id: askResult.questionId });
  check("(D) full body/options/recommendation/state round-trip", gotten.body === "pick one" && JSON.stringify(gotten.options) === JSON.stringify(["A", "B"]) && gotten.recommendation === "A" && gotten.state === "answered");
  check("(D) decision answer surfaces {chosenOption,note}", gotten.chosenOption === "B" && gotten.note === "went with B");
  check("(D) taskId round-trips on the full read", gotten.taskId === T);

  // --- permission, pending then answered: `approved` is null while pending, not a false-ish derivation ---
  const permAsk = await ask({ type: "permission", title: "Force-push?", body: "recovering a bad merge", action: "force-push origin/main", taskId: T });
  const permPending = await tCall("task_request_get", { id: permAsk.questionId });
  check("(D) a PENDING permission reads approved:null (not falsely 'denied')", permPending.approved === null && permPending.state === "pending");
  db.answerQuestion(permAsk.questionId, { chosenOption: PERMISSION_ANSWERS[0], note: "go ahead", answeredAt: new Date().toISOString() });
  const permAnswered = await tCall("task_request_get", { id: permAsk.questionId });
  check("(D) an ANSWERED permission surfaces {approved:true,note}, not a raw chosenOption string", permAnswered.approved === true && permAnswered.note === "go ahead");

  // --- credential: THE never-leaks-secret_blob property ---
  const plaintext = "sk_live_super_secret_do_not_leak_1234567890";
  const credAsk = await ask({ type: "credential", title: "Need the Stripe key", body: "for billing", envVar: "STRIPE_API_KEY", taskId: T });
  const credPending = await tCall("task_request_get", { id: credAsk.questionId });
  check("(D) a PENDING credential reads ack:null (not yet provided)", credPending.ack === null && credPending.state === "pending");
  const secretBlob = encryptSecret(plaintext, keyPath);
  db.answerCredentialQuestion(credAsk.questionId, { secretBlob, answeredAt: new Date().toISOString() });
  const credAnswered = await tCall("task_request_get", { id: credAsk.questionId });
  check("(D) an ANSWERED credential surfaces a non-empty `ack` string", typeof credAnswered.ack === "string" && credAnswered.ack.length > 0);
  check("(D) the ack references the requested envVar hint", credAnswered.ack.includes("STRIPE_API_KEY"));
  check("(D) the response has NO secretBlob/secret_blob/secret key at all", !("secretBlob" in credAnswered) && !("secret_blob" in credAnswered) && !("secret" in credAnswered));
  check("(D) JSON.stringify of the response never contains the plaintext", !JSON.stringify(credAnswered).includes(plaintext));
  check("(D) the ack text itself does not contain the plaintext", !credAnswered.ack.includes(plaintext));

  // ============================ (E) NON-CONSUMING: re-readable, incl. after question_pull drains =======
  // (D) added a permission + credential ask on the SAME task since `listed` was captured, so T now has 3
  // connected requests — don't compare against the now-stale `listed`; prove non-consuming by reading
  // TWICE in a row and asserting the two reads are identical (a consuming read would differ/shrink).
  const listedTwiceA = await tCallList("task_requests_list", { taskId: T });
  const listedTwiceB = await tCallList("task_requests_list", { taskId: T });
  check("(E) two consecutive task_requests_list reads return the identical rows (non-consuming)", listedTwiceA.length === 3 && JSON.stringify(listedTwiceA) === JSON.stringify(listedTwiceB));
  const gottenAgain = await tCall("task_request_get", { id: askResult.questionId });
  check("(E) a SECOND task_request_get read on the SAME id still returns it, state unchanged", gottenAgain.state === "answered" && gottenAgain.chosenOption === "B");
  check("(E) the underlying db row is STILL 'answered' (task_request_get never flips state)", db.getQuestion(askResult.questionId).state === "answered");

  // question_pull (the asking manager's OWN drain) is UNCHANGED — it still consumes.
  const pulled = askParse(await mgrServer._registeredTools["question_pull"].handler({}));
  check("(E) question_pull still drains the answered questions (its own semantics untouched)", pulled.questions.length >= 1);
  check("(E) question_pull flips the row to 'consumed'", db.getQuestion(askResult.questionId).state === "consumed");

  // The new read pair still sees it — even now 'consumed' — because it reads by task_id, not agent-pull-state.
  const afterPullList = await tCallList("task_requests_list", { taskId: T });
  check("(E) task_requests_list STILL surfaces the now-consumed row (title-altitude read is state-agnostic)", afterPullList.some((r) => r.id === askResult.questionId && r.state === "consumed"));
  const afterPullGet = await tCall("task_request_get", { id: askResult.questionId });
  check("(E) task_request_get STILL reads the now-consumed row in full, answer intact", afterPullGet.state === "consumed" && afterPullGet.chosenOption === "B" && afterPullGet.note === "went with B");

  // ============================ (F) project/task scoping =================================================
  const wrongTask = await tCall("task_request_get", { id: askResult.questionId, taskId: emptyTaskId });
  check("(F) task_request_get with a MISMATCHED taskId errors instead of silently returning it", typeof wrongTask.error === "string");

  // A request that belongs to a DIFFERENT project must not be readable from this project's session.
  const otherAgentId = "tr2-agent", otherMgrId = "tr2-mgr";
  db.insertAgent({ id: otherAgentId, projectId: otherProjId, name: "Other Manager", startupPrompt: "", position: 0 });
  db.insertSession({
    id: otherMgrId, projectId: otherProjId, agentId: otherAgentId, engineSessionId: "eng-tr2", title: null, cwd: otherProjId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager",
  });
  const otherServer = orchRouter.buildServer(otherMgrId, "manager");
  const otherAsk = askParse(await otherServer._registeredTools["question_ask"].handler({ title: "Other project ask", body: "b" }));
  const crossProjectRead = await tCall("task_request_get", { id: otherAsk.questionId });
  check("(F) a request from ANOTHER project resolves to not-found (cross-project scoping)", typeof crossProjectRead.error === "string");

  const unknownTaskList = await tCallList("task_requests_list", { taskId: "not-a-real-task-id" });
  check("(F) task_requests_list on an unknown taskId errors (task not found), not an empty list", typeof unknownTaskList.error === "string");

  // CR follow-up, now closed by card 9be9784a: `question_ask`'s `taskId` USED to be agent-supplied and
  // NEVER validated against the asking session's own project (questionTool.ts's buildQuestionAsk), so a
  // manager in a DIFFERENT project could file a request that carried THIS project's task id, T — a
  // foreign-project row that would leak (metadata only, never the secret) into both the list and the
  // tasks_get summary if the READ side ever slipped. Since 9be9784a, `buildQuestionAsk` resolves `taskId`
  // via `resolveIdPrefix` scoped to the CALLER's OWN project tasks (`ctx.db.listTasks(ctx.projectId)`) —
  // the same scoping `resolveProjectTaskId` uses for every other `loom-tasks` tool — so a taskId from
  // another project no longer resolves at all: the write itself is now rejected, closing the gap at the
  // source instead of relying solely on the read-side project guard below.
  const beforeLeakCounts = await tCall("tasks_get", { id: T });
  const foreignSameTaskId = askParse(await otherServer._registeredTools["question_ask"].handler({
    title: "Foreign-project ask carrying THIS project's task id", body: "b", taskId: T,
  }));
  check("(F) the foreign question_ask is REJECTED — taskId no longer resolves outside the caller's own project", typeof foreignSameTaskId.error === "string");
  const summaryAfterForeign = await tCall("tasks_get", { id: T });
  check("(F) tasks_get's requests summary total is UNCHANGED (the foreign ask never created a row)", summaryAfterForeign.requests.total === beforeLeakCounts.requests.total);

  // ============================ (G) taskId accepts an unambiguous 8-char id-prefix =======================
  const prefix = T.slice(0, 8);
  const byPrefix = await tCallList("task_requests_list", { taskId: prefix });
  check("(G) task_requests_list resolves an 8-char taskId prefix", Array.isArray(byPrefix) && byPrefix.length >= 1);

  // ============================ (H) card 9be9784a: question_ask resolves an 8-char taskId PREFIX ========
  // Before the fix, `taskId` was stored VERBATIM (the raw prefix), so the connected-requests read (which
  // matches on the FULL task id) never found it — a silent no-op that LOOKED like it worked (question_ask
  // still returned a questionId, no error).
  const prefixAsk = await ask({ title: "Prefix-linked ask", body: "b", taskId: prefix });
  check("(H) question_ask with an 8-char taskId PREFIX returns a questionId (no error)", typeof prefixAsk.questionId === "string");
  check("(H) the stored row's taskId is the RESOLVED FULL id, not the raw prefix", db.getQuestion(prefixAsk.questionId).taskId === T);
  const taskAfterPrefixAsk = await tCall("tasks_get", { id: T });
  check("(H) the Request now appears in tasks_get's connected-requests summary for the full-id task", taskAfterPrefixAsk.requests.items.some((it) => it.id === prefixAsk.questionId));
  const prefixLinkedList = await tCallList("task_requests_list", { taskId: T });
  check("(H) the Request appears in the task-scoped task_requests_list read too", prefixLinkedList.some((r) => r.id === prefixAsk.questionId));

  // Ambiguous prefix → clean rejection (does NOT silently pick one, does NOT store a dead link).
  const ambigPrefix = ambigA.slice(0, 8);
  const ambigAsk = await ask({ title: "Ambiguous prefix ask", body: "b", taskId: ambigPrefix });
  check("(H) an AMBIGUOUS taskId prefix is cleanly rejected, not silently stored", typeof ambigAsk.error === "string" && ambigAsk.error.includes("ambiguous"));

  // Unknown (well-formed, 8+ char) prefix → clean rejection, not silently stored as a dead link.
  const unknownAsk = await ask({ title: "Unknown taskId ask", body: "b", taskId: "ffffffff" });
  check("(H) an UNKNOWN taskId is cleanly rejected", typeof unknownAsk.error === "string");

  // ============================ (I) card feat(orchestration): question_cancel + dismiss ==================
  // summarizeTaskRequests used to derive `answered: questions.length - pending` — a pending-as-proxy bug
  // that silently counted a CANCELLED request (never answered at all) as answered once that third state
  // existed. Dedicated task so this section's counts are independent of T's prior mutations above.
  const cancelledTaskId = "eeeeeeee-0000-4000-8000-000000000005";
  db.insertTask({ id: cancelledTaskId, projectId: projId, title: "card with a cancelled request", body: "b", columnKey: "backlog", position: 5, priority: "p2", createdAt: now, updatedAt: now });
  const pendingOnCard = await ask({ title: "Still pending", body: "b", taskId: cancelledTaskId });
  const answeredOnCard = await ask({ title: "Really answered", body: "b", taskId: cancelledTaskId });
  db.answerQuestion(answeredOnCard.questionId, { chosenOption: null, note: "yep", answeredAt: new Date().toISOString() });
  const cancelledOnCard = await ask({ title: "Withdrawn as moot", body: "b", taskId: cancelledTaskId });
  db.cancelQuestion(cancelledOnCard.questionId, { reason: "superseded", cancelledBy: "agent" });

  const taskWithCancelled = await tCall("tasks_get", { id: cancelledTaskId });
  check("(I) requests.total counts all three rows", taskWithCancelled.requests.total === 3);
  check("(I) requests.pending counts ONLY the still-pending row", taskWithCancelled.requests.pending === 1);
  check("(I) requests.answered counts ONLY the really-answered row — the cancelled row is NOT folded in", taskWithCancelled.requests.answered === 1);
  check("(I) requests.cancelled counts the cancelled row separately", taskWithCancelled.requests.cancelled === 1);
  check("(I) the three buckets sum to total (no row double-counted or dropped)", taskWithCancelled.requests.pending + taskWithCancelled.requests.answered + taskWithCancelled.requests.cancelled === taskWithCancelled.requests.total);
  check("(I) requests.items reflects the cancelled row's real state", taskWithCancelled.requests.items.find((it) => it.id === cancelledOnCard.questionId)?.state === "cancelled");
  const cancelledCardList = await tCallList("task_requests_list", { taskId: cancelledTaskId });
  check("(I) task_requests_list also surfaces the cancelled row (pending+answered+consumed+cancelled alike)", cancelledCardList.some((r) => r.id === cancelledOnCard.questionId && r.state === "cancelled"));

  await tClient.close();
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a REAL question_ask call stamps task_id end-to-end; tasks_get's connected-requests summary ({total,answered,pending,cancelled,items}) is correct before/after an answer (real-agent MCP tool calls, not just unit tests); task_requests_list/task_request_get are NON-CONSUMING (re-readable across repeated calls AND after the asking agent's own question_pull has drained+consumed the row, whose own semantics stay unchanged); task_request_get never returns secret_blob/secret for a credential request (only a non-secret ack, null while pending); a pending permission reads approved:null rather than a misleading false; project/task scoping rejects a mismatched taskId and a cross-project request id — INCLUDING a foreign-project question_ask carrying another project's task id, now REJECTED OUTRIGHT at write time (card 9be9784a: taskId resolution is scoped to the caller's own project); task_requests_list resolves an unambiguous 8-char taskId prefix; question_ask itself resolves an 8-char taskId PREFIX to the full id and stores THAT — so the soft-link actually connects — while an ambiguous or unknown prefix is cleanly rejected instead of silently stored as a dead link; AND a CANCELLED connected request (question_cancel/dismiss) is counted in its OWN `cancelled` bucket, never folded into `answered` (the pending-as-proxy bug `total - pending` used to cause)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
