import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Arg-name aliases across the loom MCP surface (card fix(mcp): accept arg-name aliases so an obvious
// wrong first call succeeds). Platform Auditor evidence (session 4be57743 + others) showed 4 distinct
// -32602 first-call failures — worker_spawn({kickoff}), platform_escalate({title,body}),
// worker_message({message}), tasks_update({taskId}) — plus a manager's own idle_report({status})
// self-report. Fix: each tool now ALSO accepts the obvious sibling name as an alias, coerced onto the
// canonical field via the ONE shared `resolveAlias` helper (mcp/arg-alias.ts) — the canonical param
// keeps working unchanged (no regression), and neither given still errors clearly (never a schema-
// validation throw, and an unrelated/unknown field never masquerades as the required one).
//
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like recycle-param-alias.mjs /
// tasks-get-taskid-alias.mjs: isolated temp DB(s), the REAL routers over in-process MCP
// InMemoryTransports (no HTTP, no daemon, no pty). `sessions` is a STUB SessionService for the
// OrchestrationMcpRouter tools (records what it was called with) — this proves the ALIAS RESOLUTION at
// the tool boundary, in isolation from the real (heavy, worktree/pty-driving) mechanics already covered
// elsewhere (worker-spawn-*.mjs, platform-escalate-dedup.mjs, idle-report.mjs). tasks_update is driven
// against a REAL Db + TaskMcpRouter (it isn't a `sessions` call).
//
// Run: 1) build (turbo builds shared first), 2) node test/arg-name-aliases.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

function tmpDbFile(tag) {
  return path.join(os.tmpdir(), `loom-alias-${tag}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
}
function rmDb(file) { for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(file + ext, { force: true }); } catch { /* ignore */ } } }

const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// ============================ ORCHESTRATION-SURFACE ALIASES ============================
// worker_spawn(kickoff→kickoffPrompt), worker_message/worker_redirect(message→text),
// platform_escalate(body→detail), question_ask(detail→body), idle_report(status→state).
{
  const file = tmpDbFile("orch");
  const db = new Db(file);
  const now = new Date().toISOString();
  db.insertProject({ id: "pA", name: "Alias Proj", repoPath: "/a", vaultPath: "/a", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentA", projectId: "pA", name: "Mgr", startupPrompt: "", position: 0 });
  db.insertSession({
    id: "mgrA", projectId: "pA", agentId: "agentA", engineSessionId: null, title: null, cwd: "/a",
    processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });

  // A stub SessionService: records exactly what each service method was called with, so these tests
  // assert the ALIAS RESOLUTION happening at the tool boundary (orchestration.ts), not the real (heavy)
  // spawn/message/escalate/idle mechanics — mirrors recycle-param-alias.mjs's pattern exactly.
  const calls = { spawnWorkerTracked: [], messageWorker: [], redirectWorker: [], platformEscalate: [], recordIdleReport: [] };
  let spawnSeq = 0;
  const sessions = {
    async spawnWorkerTracked(managerSessionId, opts) {
      calls.spawnWorkerTracked.push({ managerSessionId, opts });
      spawnSeq++;
      return { settled: true, ok: true, value: { id: `worker-${spawnSeq}`, branch: `loom/worker-${spawnSeq}`, worktreePath: `/wt/${spawnSeq}` } };
    },
    messageWorker(managerSessionId, workerSessionId, text) {
      calls.messageWorker.push({ managerSessionId, workerSessionId, text });
      return { delivered: true };
    },
    redirectWorker(managerSessionId, workerSessionId, text) {
      calls.redirectWorker.push({ managerSessionId, workerSessionId, text });
      return { delivered: true };
    },
    platformEscalate(managerSessionId, input) {
      calls.platformEscalate.push({ managerSessionId, input });
      return { taskId: "plat-task-1", projectId: "pHome", deliveryStatus: "boarded" };
    },
    recordIdleReport(sessionId, state, opts) {
      calls.recordIdleReport.push({ sessionId, state, opts });
      return { recorded: true, state, policy: "watching", snoozeUntil: null, unanswered: 0 };
    },
  };

  const server = new OrchestrationMcpRouter(db, sessions).buildServer("mgrA", "manager");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "arg-name-aliases-orch-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  // ----------------------------- worker_spawn: kickoff → kickoffPrompt -----------------------------
  const ws1 = await call("worker_spawn", { agentId: "agentA", kickoffPrompt: "KP-canonical" });
  check("worker_spawn({kickoffPrompt}) still works (regression)", ws1.workerSessionId === "worker-1" && !ws1.error);
  check("worker_spawn({kickoffPrompt}) — sessions.spawnWorkerTracked got the canonical text",
    calls.spawnWorkerTracked[0].opts.kickoffPrompt === "KP-canonical");

  const ws2 = await call("worker_spawn", { agentId: "agentA", kickoff: "KP-alias" });
  check("worker_spawn({kickoff}) — alias accepted, no schema-validation error", ws2.workerSessionId === "worker-2" && !ws2.error);
  check("worker_spawn({kickoff}) — the aliased text reached spawnWorkerTracked as kickoffPrompt",
    calls.spawnWorkerTracked[1].opts.kickoffPrompt === "KP-alias");

  const ws3 = await call("worker_spawn", { agentId: "agentA", kickoffPrompt: "KP-wins", kickoff: "KP-loses" });
  check("worker_spawn({kickoffPrompt, kickoff}) — kickoffPrompt (canonical) wins",
    calls.spawnWorkerTracked[2].opts.kickoffPrompt === "KP-wins");

  const ws4 = await call("worker_spawn", { agentId: "agentA" });
  check("worker_spawn({}) — neither param → explicit error naming both",
    typeof ws4.error === "string" && ws4.error.includes("kickoffPrompt") && ws4.error.includes("kickoff"));
  check("worker_spawn({}) — spawnWorkerTracked was NOT called for the missing-param case", calls.spawnWorkerTracked.length === 3);

  // ----------------------------- worker_message: message → text -----------------------------
  const wm1 = await call("worker_message", { workerSessionId: "wkr1", text: "T-canonical" });
  check("worker_message({text}) still works (regression)", wm1.delivered === true && !wm1.error);
  check("worker_message({text}) — sessions.messageWorker got the canonical text", calls.messageWorker[0].text === "T-canonical");

  const wm2 = await call("worker_message", { workerSessionId: "wkr2", message: "M-alias" });
  check("worker_message({message}) — alias accepted, no schema-validation error", wm2.delivered === true && !wm2.error);
  check("worker_message({message}) — the aliased text reached messageWorker as text", calls.messageWorker[1].text === "M-alias");

  const wm3 = await call("worker_message", { workerSessionId: "wkr3", text: "T-wins", message: "M-loses" });
  check("worker_message({text, message}) — text (canonical) wins", calls.messageWorker[2].text === "T-wins");

  const wm4 = await call("worker_message", { workerSessionId: "wkr4" });
  check("worker_message({}) — neither param → explicit error naming both",
    typeof wm4.error === "string" && wm4.error.includes("text") && wm4.error.includes("message"));
  check("worker_message({}) — messageWorker was NOT called for the missing-param case", calls.messageWorker.length === 3);

  // ----------------------------- worker_redirect: message → text -----------------------------
  const wr1 = await call("worker_redirect", { workerSessionId: "wkr1", text: "T-canonical" });
  check("worker_redirect({text}) still works (regression)", wr1.delivered === true && !wr1.error);
  check("worker_redirect({text}) — sessions.redirectWorker got the canonical text", calls.redirectWorker[0].text === "T-canonical");

  const wr2 = await call("worker_redirect", { workerSessionId: "wkr2", message: "M-alias" });
  check("worker_redirect({message}) — alias accepted, no schema-validation error", wr2.delivered === true && !wr2.error);
  check("worker_redirect({message}) — the aliased text reached redirectWorker as text", calls.redirectWorker[1].text === "M-alias");

  const wr4 = await call("worker_redirect", { workerSessionId: "wkr4" });
  check("worker_redirect({}) — neither param → explicit error naming both",
    typeof wr4.error === "string" && wr4.error.includes("text") && wr4.error.includes("message"));
  check("worker_redirect({}) — redirectWorker was NOT called for the missing-param case", calls.redirectWorker.length === 2);

  // ----------------------------- platform_escalate: body → detail -----------------------------
  const pe1 = await call("platform_escalate", { title: "T1", detail: "D-canonical" });
  check("platform_escalate({detail}) still works (regression)", pe1.taskId === "plat-task-1" && !pe1.error);
  check("platform_escalate({detail}) — sessions.platformEscalate got the canonical detail",
    calls.platformEscalate[0].input.detail === "D-canonical");

  const pe2 = await call("platform_escalate", { title: "T2", body: "B-alias" });
  check("platform_escalate({body}) — alias accepted, no schema-validation error", pe2.taskId === "plat-task-1" && !pe2.error);
  check("platform_escalate({body}) — the aliased text reached platformEscalate as detail",
    calls.platformEscalate[1].input.detail === "B-alias");

  const pe3 = await call("platform_escalate", { title: "T3", detail: "D-wins", body: "B-loses" });
  check("platform_escalate({detail, body}) — detail (canonical) wins", calls.platformEscalate[2].input.detail === "D-wins");

  const pe4 = await call("platform_escalate", { title: "T4" });
  check("platform_escalate({title only}) — neither detail nor body → explicit error naming both",
    typeof pe4.error === "string" && pe4.error.includes("detail") && pe4.error.includes("body"));
  check("platform_escalate({title only}) — platformEscalate was NOT called for the missing-param case", calls.platformEscalate.length === 3);

  // ----------------------------- question_ask: detail → body -----------------------------
  const qa1 = await call("question_ask", { title: "Q1", body: "QB-canonical" });
  check("question_ask({body}) still works (regression)", typeof qa1.questionId === "string" && !qa1.error);
  check("question_ask({body}) — the stored question's body is the canonical text", db.getQuestion(qa1.questionId)?.body === "QB-canonical");

  const qa2 = await call("question_ask", { title: "Q2", detail: "QD-alias" });
  check("question_ask({detail}) — alias accepted, no schema-validation error", typeof qa2.questionId === "string" && !qa2.error);
  check("question_ask({detail}) — the stored question's body is the aliased text", db.getQuestion(qa2.questionId)?.body === "QD-alias");

  const qa3 = await call("question_ask", { title: "Q3", body: "QB-wins", detail: "QD-loses" });
  check("question_ask({body, detail}) — body (canonical) wins", db.getQuestion(qa3.questionId)?.body === "QB-wins");

  const qa4 = await call("question_ask", { title: "Q4" });
  check("question_ask({title only}) — neither body nor detail → explicit error naming both",
    typeof qa4.error === "string" && qa4.error.includes("body") && qa4.error.includes("detail"));

  // ----------------------------- idle_report: status → state -----------------------------
  const ir1 = await call("idle_report", { state: "working" });
  check("idle_report({state}) still works (regression)", ir1.recorded === true && !ir1.error);
  check("idle_report({state}) — sessions.recordIdleReport got the canonical state", calls.recordIdleReport[0].state === "working");

  const ir2 = await call("idle_report", { status: "waiting", minutes: 5 });
  check("idle_report({status}) — alias accepted, no schema-validation error", ir2.recorded === true && !ir2.error);
  check("idle_report({status}) — the aliased value reached recordIdleReport as state", calls.recordIdleReport[1].state === "waiting");

  const ir3 = await call("idle_report", { state: "done", status: "waiting" });
  check("idle_report({state, status}) — state (canonical) wins", calls.recordIdleReport[2].state === "done");

  const ir4 = await call("idle_report", { detail: "no state given" });
  check("idle_report({detail only}) — neither state nor status → explicit error naming both",
    typeof ir4.error === "string" && ir4.error.includes("state") && ir4.error.includes("status"));
  check("idle_report({detail only}) — recordIdleReport was NOT called for the missing-param case", calls.recordIdleReport.length === 3);

  await client.close();
  db.close();
  rmDb(file);
}

// ============================ tasks_update: taskId → id ============================
// A real Db + the REAL TaskMcpRouter (tasks_update isn't a `sessions` call — it writes straight
// through updateProjectTask), mirroring tasks-get-taskid-alias.mjs's pattern for its sibling tool.
{
  const file = tmpDbFile("tasks");
  const db = new Db(file);
  const now = new Date().toISOString();
  db.insertProject({ id: "pT", name: "Tasks Alias Proj", repoPath: "/t", vaultPath: "/t", config: {}, createdAt: now, archivedAt: null });
  const T = "bbbbbbbb-0000-4000-8000-000000000001";
  db.insertTask({ id: T, projectId: "pT", title: "aliased card", body: "b", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

  const fakePty = { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null };
  const wakes = new WakeService({ db, pty: fakePty, resume: () => {} });

  const server = new TaskMcpRouter(db, wakes).buildServer("pT", "S");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "arg-name-aliases-tasks-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  const tu1 = await call("tasks_update", { id: T, priority: "p1" });
  check("tasks_update({id}) still works (regression)", tu1.id === T && tu1.priority === "p1" && !tu1.error);

  const tu2 = await call("tasks_update", { taskId: T, priority: "p0" });
  check("tasks_update({taskId}) — alias accepted, resolves + updates the SAME card", tu2.id === T && tu2.priority === "p0" && !tu2.error);

  const tu3 = await call("tasks_update", { id: T, taskId: "not-a-real-id", priority: "p3" });
  check("tasks_update({id, taskId}) — id (canonical) wins when both are given", tu3.id === T && tu3.priority === "p3" && !tu3.error);

  const before = db.getTask(T).priority;
  const tu4 = await call("tasks_update", { priority: "p2" });
  check("tasks_update({}) — neither id nor taskId → explicit error naming both",
    typeof tu4.error === "string" && tu4.error.includes("id") && tu4.error.includes("taskId"));
  check("tasks_update({}) — no write happened for the missing-id case", db.getTask(T).priority === before);

  await client.close();
  db.close();
  rmDb(file);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_spawn/worker_message/worker_redirect/platform_escalate/question_ask/idle_report/tasks_update each accept their documented alias, mapped onto the existing canonical arg via the ONE shared resolveAlias helper; every canonical param still works unchanged, both-given always resolves to the canonical value, and omitting both errors clearly (naming both names) instead of throwing a schema-validation error or silently accepting an unrelated field."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
