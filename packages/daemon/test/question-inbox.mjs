import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Manager→human DECISION INBOX (card 8701bdbb, daemon core / child A). HERMETIC, claude-free — a REAL
// Db on a temp file + the REAL OrchestrationMcpRouter/buildServer, NO real claude / no network / no daemon.
//
// Three layers:
//   (D) DB    — insertQuestion/getQuestion/answerQuestion/pullAnsweredQuestions: pending -> answered ->
//               consumed, a non-pending re-answer is a no-op, a pure-blocker (no options) round-trips on
//               note alone, and pullAnsweredQuestions atomically consumes (a second pull returns []).
//   (T) TOOL  — question_ask/question_pull are registered MANAGER-only (never on the worker surface —
//               the depth-1 gate), and actually asking/pulling through the real tool handlers behaves.
//   (R) REST  — the human-only POST /api/questions/:id/answer route: 404 unknown id, 400 on a bad
//               chosenOption (not in options[], or non-null on a pure-blocker), 400 re-answering a
//               non-pending question, 200 on a valid answer (persists chosenOption/note/answeredAt) —
//               AND the push-on-answer nudge is enqueued into the asking manager's pty via the SAME
//               enqueueStdin(kind:"agent") rail POST /input uses.
//
// Run: 1) build (turbo builds shared first), 2) node test/question-inbox.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { OrchestrationMcpRouter } from "../dist/mcp/orchestration.js";
import { buildServer } from "../dist/gateway/server.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-question-inbox-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

function mkDb(name) {
  const dbFile = path.join(tmpHome, `${name}.db`);
  const db = new Db(dbFile);
  const now = new Date().toISOString();
  const projId = `${name}-proj`;
  const agentId = `${name}-agent`;
  const mgrId = `${name}-mgr`;
  const wkrId = `${name}-wkr`;
  db.insertProject({ id: projId, name: "QI", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({
    id: mgrId, projectId: projId, agentId, engineSessionId: "eng-mgr", title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
  db.insertSession({
    id: wkrId, projectId: projId, agentId, engineSessionId: "eng-wkr", title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "worker",
  });
  return { dbFile, db, projId, agentId, mgrId, wkrId };
}
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ============================ (D) DB: insert/answer/pull lifecycle ============================
{
  const e = mkDb("db");
  const now = new Date().toISOString();

  // A question WITH options.
  const withOptions = {
    id: "q-opts", sessionId: e.mgrId, projectId: e.projId, title: "Which approach?", body: "pick one",
    options: ["A", "B"], recommendation: "A", state: "pending", chosenOption: null, note: null,
    createdAt: now, answeredAt: null, consumedAt: null,
  };
  e.db.insertQuestion(withOptions);
  check("(D) insertQuestion -> getQuestion round-trips as 'pending'", e.db.getQuestion("q-opts")?.state === "pending");
  check("(D) options/recommendation persisted", JSON.stringify(e.db.getQuestion("q-opts").options) === JSON.stringify(["A", "B"]) && e.db.getQuestion("q-opts").recommendation === "A");

  const answered = e.db.answerQuestion("q-opts", { chosenOption: "B", note: "went with B", answeredAt: now });
  check("(D) answerQuestion flips pending -> answered", answered?.state === "answered");
  check("(D) answerQuestion persists chosenOption + note + answeredAt", answered.chosenOption === "B" && answered.note === "went with B" && !!answered.answeredAt);

  const reAnswer = e.db.answerQuestion("q-opts", { chosenOption: "A", note: "overwrite?", answeredAt: now });
  check("(D) re-answering an already-answered question is a no-op (undefined, no overwrite)", reAnswer === undefined && e.db.getQuestion("q-opts").chosenOption === "B");

  const pulled = e.db.pullAnsweredQuestions(e.mgrId, now);
  check("(D) pullAnsweredQuestions returns the answered question", pulled.length === 1 && pulled[0].id === "q-opts" && pulled[0].chosenOption === "B");
  check("(D) pull flips it to 'consumed'", e.db.getQuestion("q-opts").state === "consumed");
  const pulledAgain = e.db.pullAnsweredQuestions(e.mgrId, now);
  check("(D) a second pull returns [] (already consumed, never double-delivered)", pulledAgain.length === 0);

  // A PURE-BLOCKER question (no options) round-trips on note alone.
  const blocker = {
    id: "q-blocker", sessionId: e.mgrId, projectId: e.projId, title: "Unblock me", body: "stuck on X",
    options: null, recommendation: null, state: "pending", chosenOption: null, note: null,
    createdAt: now, answeredAt: null, consumedAt: null,
  };
  e.db.insertQuestion(blocker);
  const blockerAnswered = e.db.answerQuestion("q-blocker", { chosenOption: null, note: "go ahead", answeredAt: now });
  check("(D) pure-blocker answers with chosenOption:null + a note", blockerAnswered.chosenOption === null && blockerAnswered.note === "go ahead" && blockerAnswered.state === "answered");
  const blockerPulled = e.db.pullAnsweredQuestions(e.mgrId, now);
  check("(D) pure-blocker pulls + consumes just like an options question", blockerPulled.length === 1 && blockerPulled[0].id === "q-blocker");

  cleanup(e);
}

// ============================ (T) TOOL SURFACE + real handler behavior ============================
{
  const e = mkDb("tool");
  const router = new OrchestrationMcpRouter(e.db, {}); // sessions is only captured into unrelated closures

  const toolsFor = (role) => router.buildServer("sid-unused", role)._registeredTools;
  const managerTools = toolsFor("manager");
  const workerTools = toolsFor("worker");
  check("(T) question_ask IS registered on the MANAGER surface", "question_ask" in managerTools);
  check("(T) question_pull IS registered on the MANAGER surface", "question_pull" in managerTools);
  check("(T) question_ask is NOT on the worker surface (depth-1 gate)", !("question_ask" in workerTools));
  check("(T) question_pull is NOT on the worker surface (depth-1 gate)", !("question_pull" in workerTools));

  // Real handlers, scoped to the real manager session id (server-derived, never agent-passed).
  const mgrServer = router.buildServer(e.mgrId, "manager");
  const parse = (r) => JSON.parse(r.content[0].text);

  const askResult = parse(await mgrServer._registeredTools["question_ask"].handler({
    title: "Ship v2 now?", body: "the migration looks green", options: ["yes", "no"], recommendation: "yes",
  }));
  check("(T) question_ask returns a questionId", typeof askResult.questionId === "string" && askResult.questionId.length > 0);
  const created = e.db.getQuestion(askResult.questionId);
  check("(T) the created row is scoped to THIS manager session (server-derived, never agent-passed)", created.sessionId === e.mgrId && created.projectId === e.projId);
  check("(T) the created row starts 'pending'", created.state === "pending");

  const pullEmpty = parse(await mgrServer._registeredTools["question_pull"].handler({}));
  check("(T) pulling before it's answered returns an empty list (still 'pending', not returned)", Array.isArray(pullEmpty.questions) && pullEmpty.questions.length === 0);

  // Simulate the human's answer (the REST path, exercised separately below) directly at the db layer,
  // then prove question_pull picks it up and consumes it.
  e.db.answerQuestion(askResult.questionId, { chosenOption: "yes", note: "go", answeredAt: new Date().toISOString() });
  const pullAfter = parse(await mgrServer._registeredTools["question_pull"].handler({}));
  check("(T) question_pull returns the now-answered question", pullAfter.questions.length === 1 && pullAfter.questions[0].questionId === askResult.questionId);
  check("(T) question_pull's entry carries chosenOption + note", pullAfter.questions[0].chosenOption === "yes" && pullAfter.questions[0].note === "go");
  check("(T) question_pull consumed it (a repeat pull is empty)", parse(await mgrServer._registeredTools["question_pull"].handler({})).questions.length === 0);
  check("(T) the underlying row is now 'consumed'", e.db.getQuestion(askResult.questionId).state === "consumed");

  cleanup(e);
}

// ============================ (R) REST: human-only answer endpoint + push-on-answer nudge ============================
{
  const e = mkDb("rest");
  const now = new Date().toISOString();

  const withOptions = {
    id: "r-opts", sessionId: e.mgrId, projectId: e.projId, title: "Deploy which channel?", body: "pick one",
    options: ["stable", "beta"], recommendation: "stable", state: "pending", chosenOption: null, note: null,
    createdAt: now, answeredAt: null, consumedAt: null,
  };
  e.db.insertQuestion(withOptions);
  const blocker = {
    id: "r-blocker", sessionId: e.mgrId, projectId: e.projId, title: "Unblock", body: "stuck",
    options: null, recommendation: null, state: "pending", chosenOption: null, note: null,
    createdAt: now, answeredAt: null, consumedAt: null,
  };
  e.db.insertQuestion(blocker);

  const enqueued = []; // { sessionId, text, source, route, kind }
  const stubPty = {
    enqueueStdin: (sessionId, text, source, onDeliver, route, kind) => {
      enqueued.push({ sessionId, text, source, route, kind });
      return { delivered: true };
    },
  };
  const stub = {};
  const app = await buildServer({
    db: e.db, pty: stubPty, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
    userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
  });
  const inject = (opts) => app.inject(opts);

  try {
    const notFound = await inject({ method: "POST", url: "/api/questions/nope/answer", payload: { chosenOption: "stable" } });
    check("(R) unknown question id -> 404", notFound.statusCode === 404);

    const badOption = await inject({ method: "POST", url: "/api/questions/r-opts/answer", payload: { chosenOption: "nightly" } });
    check("(R) chosenOption not in options[] -> 400", badOption.statusCode === 400);
    check("(R) the rejected answer left the row 'pending'", e.db.getQuestion("r-opts").state === "pending");

    const missingOption = await inject({ method: "POST", url: "/api/questions/r-opts/answer", payload: { note: "no option supplied" } });
    check("(R) an options-question answered with NO chosenOption -> 400", missingOption.statusCode === 400);

    const good = await inject({ method: "POST", url: "/api/questions/r-opts/answer", payload: { chosenOption: "beta", note: "ship beta" } });
    check("(R) a valid answer -> 200", good.statusCode === 200);
    const updated = JSON.parse(good.payload);
    check("(R) the response reflects the persisted answer", updated.state === "answered" && updated.chosenOption === "beta" && updated.note === "ship beta" && !!updated.answeredAt);
    check("(R) the db row is durably updated", e.db.getQuestion("r-opts").state === "answered" && e.db.getQuestion("r-opts").chosenOption === "beta");

    check("(R) the push-on-answer nudge was enqueued to the ASKING manager", enqueued.length === 1 && enqueued[0].sessionId === e.mgrId);
    check("(R) the nudge names the question's title", enqueued[0].text.includes("Deploy which channel?"));
    check("(R) the nudge uses the SAME rail POST /input uses: source 'human', kind 'agent'", enqueued[0].source === "human" && enqueued[0].kind === "agent");

    const reAnswer = await inject({ method: "POST", url: "/api/questions/r-opts/answer", payload: { chosenOption: "stable" } });
    check("(R) re-answering an already-'answered' question -> 400 (not silently overwritten)", reAnswer.statusCode === 400);
    check("(R) no second nudge was enqueued for the rejected re-answer", enqueued.length === 1);

    // Pure-blocker: chosenOption must stay null; a non-null chosenOption on a no-options question is rejected.
    const blockerBadOption = await inject({ method: "POST", url: "/api/questions/r-blocker/answer", payload: { chosenOption: "yes", note: "go" } });
    check("(R) a non-null chosenOption on a pure-blocker (no options) -> 400", blockerBadOption.statusCode === 400);

    // CR nitpick resolution: a pure-blocker answered with NOTHING (no chosenOption, no note) would flip
    // pending->answered with zero content for the manager to act on — reject it; the note is the ONLY
    // payload a pure-blocker carries, so it must be non-empty.
    const blockerEmpty = await inject({ method: "POST", url: "/api/questions/r-blocker/answer", payload: {} });
    check("(R) a pure-blocker answered with an EMPTY payload (no note) -> 400 (content-free ack rejected)", blockerEmpty.statusCode === 400);
    check("(R) the empty-payload rejection left it 'pending'", e.db.getQuestion("r-blocker").state === "pending");

    const blockerGood = await inject({ method: "POST", url: "/api/questions/r-blocker/answer", payload: { note: "go ahead, it's fine" } });
    check("(R) a pure-blocker answers cleanly with note-only (chosenOption omitted -> null) -> 200", blockerGood.statusCode === 200);
    const blockerUpdated = JSON.parse(blockerGood.payload);
    check("(R) the pure-blocker's chosenOption stays null", blockerUpdated.chosenOption === null && blockerUpdated.note === "go ahead, it's fine");
    check("(R) a second nudge was enqueued for the blocker's own answer", enqueued.length === 2 && enqueued[1].sessionId === e.mgrId);
  } finally {
    await app.close();
    cleanup(e);
  }
}

// ============================ (R2) CR MAJOR 1: the push-nudge is best-effort ============================
// A stub pty whose enqueueStdin THROWS (mirrors the narrow pty-teardown race the CR flagged — a torn-down
// asking-manager pty racing this exact request): the answer must STILL persist + return 200. A successful
// trust-boundary write (the human's answer) must never surface as a 500 just because the best-effort nudge
// failed; question_pull is the durable fallback if the nudge never lands.
{
  const e = mkDb("nudge-throws");
  const now = new Date().toISOString();
  e.db.insertQuestion({
    id: "throws-q", sessionId: e.mgrId, projectId: e.projId, title: "Race the teardown", body: "b",
    options: null, recommendation: null, state: "pending", chosenOption: null, note: null,
    createdAt: now, answeredAt: null, consumedAt: null,
  });

  const throwingPty = {
    enqueueStdin: () => { throw new Error("M1 invariant violated: submit() did not arm busy synchronously"); },
  };
  const stub = {};
  const app = await buildServer({
    db: e.db, pty: throwingPty, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
    userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
  });
  try {
    const res = await app.inject({ method: "POST", url: "/api/questions/throws-q/answer", payload: { note: "go ahead anyway" } });
    check("(R2) a THROWING enqueueStdin still returns 200 (best-effort nudge, not fatal)", res.statusCode === 200);
    const updated = JSON.parse(res.payload);
    check("(R2) the answer is reflected in the response despite the nudge throwing", updated.state === "answered" && updated.note === "go ahead anyway");
    check("(R2) the answer is DURABLY persisted (not rolled back by the nudge failure)", e.db.getQuestion("throws-q").state === "answered" && e.db.getQuestion("throws-q").note === "go ahead anyway");
  } finally {
    await app.close();
    cleanup(e);
  }
}

try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — questions go pending -> answered -> consumed (a pure-blocker requires a non-empty note and round-trips on it alone, a non-pending re-answer/re-pull is a safe no-op); question_ask/question_pull are MANAGER-only and behave against the real DB; the human-only REST answer route validates chosenOption against options[], rejects a non-pending re-answer, pushes the SAME enqueueStdin(kind:\"agent\") nudge rail POST /input uses into the asking manager's own session, and treats that nudge as BEST-EFFORT — a THROWING enqueueStdin (the pty-teardown race) never turns a persisted answer into a 500."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
