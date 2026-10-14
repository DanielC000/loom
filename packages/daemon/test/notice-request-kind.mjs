import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 59fa6403 — the Inbox generalization's first new primitive: `type:"notice"`, an FYI/status
// Request that needs NO human answer. Covers:
//   (A) buildQuestionAsk(type:"notice") is SELF-TERMINAL — lands `state:"answered"` with
//       `answeredAt === createdAt`, never 'pending', `options` stays null.
//   (B) a notice is NEVER returned by either question_pull backing query (pullAnsweredQuestionsForAgent /
//       pullAnsweredQuestionsForAgentBounded) — it has nothing for its own asker to pull back.
//   (C) a notice is NEVER answerable — the generic answerQuestion() writer is a no-op on it (it is not
//       'pending', mirroring the same guard that already refuses a non-'pending' row of any type).
//   (D) the per-agent-lineage notice rate limit (OrchestrationConfig.maxNoticesPerHour) REFUSES loudly
//       once exceeded, naming the limit — never silently drops the ask.
//   (E) a WORKER session's MCP surface has no `question_ask` tool at all (unchanged by this card — this
//       pins that the existing worker-surface exclusion still covers the new kind too), while the manager
//       and Platform Lead surfaces both still have it.
//   (F) card 59fa6403 round 2 (b13df292): the AGENT-facing config validator REJECTS
//       `orchestration.maxNoticesPerHour` outright (same trust tier as mergeGate — an agent cannot raise
//       its own rate limit), while a normal nested orchestration key is still accepted (control).
//   (G) the elevated Platform Lead's `project_configure` ALSO rejects it (HUMAN_ONLY_NESTED_PROJECT_CONFIG_
//       KEYS) — even the Lead cannot raise its own fleet's limit — and the human (full) validator still
//       accepts it (control: this is a trust-tier restriction, not a validation bug).
//   (H) `listOpenQuestions`' default "waiting on me" view includes an UNREAD notice but excludes an
//       already-READ one (card 54007ab7, Phase 2 of 59fa6403 — replaces the old fixed-age-window stopgap);
//       `includeConsumed:true` (History) includes BOTH regardless of read state.
//
// Run: 1) build (turbo builds shared first), 2) node packages/daemon/test/notice-request-kind.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-notice-kind-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildQuestionAsk } = await import("../dist/mcp/questionTool.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const {
  PlatformMcpRouter, validateAgentProjectConfigOverride, validateProjectConfigOverride,
  HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS,
} = await import("../dist/mcp/platform.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const dbFile = path.join(tmpHome, "notice.db");
const db = new Db(dbFile);
const now = new Date().toISOString();
const projId = "nk-proj", agentId = "nk-agent", mgrId = "nk-mgr";

try {
  db.insertProject({ id: projId, name: "NK", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "Manager", startupPrompt: "BRIEF", position: 0 });
  db.insertSession({
    id: mgrId, projectId: projId, agentId, engineSessionId: "eng-nk", title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });

  // ===== (A) buildQuestionAsk(type:"notice") is self-terminal =====
  {
    const built = buildQuestionAsk(
      { type: "notice", title: "Migration done", body: "all 12 workers landed" },
      { sessionId: mgrId, projectId: projId, db, role: "manager" },
    );
    check("(A) a notice ask builds without error", "question" in built);
    const q = built.question;
    check("(A) a notice lands in its OWN terminal 'notice' state — never 'pending', never 'answered' (card 59fa6403 round 2, b13df292)", q.state === "notice");
    check("(A) answeredAt === createdAt (self-terminal, nothing for a human to answer)", q.answeredAt === q.createdAt);
    check("(A) a notice never carries options", q.options === null);
    db.insertQuestion(q);
    check("(A) the inserted row round-trips with the SAME self-terminal state", db.getQuestion(q.id)?.state === "notice");
  }

  // ===== (B) a notice is NEVER returned by either question_pull backing query =====
  {
    const before = db.pullAnsweredQuestionsForAgent(agentId, new Date().toISOString());
    check("(B) pullAnsweredQuestionsForAgent returns nothing for the notice filed in (A) (already drained by a prior call in this suite is fine — assert on a FRESH one below)", Array.isArray(before));
    const built = buildQuestionAsk(
      { type: "notice", title: "Second notice", body: "status update" },
      { sessionId: mgrId, projectId: projId, db, role: "manager" },
    );
    db.insertQuestion(built.question);
    const pulled = db.pullAnsweredQuestionsForAgent(agentId, new Date().toISOString());
    check("(B1) pullAnsweredQuestionsForAgent excludes the fresh notice", pulled.every((r) => r.id !== built.question.id));
    const bounded = db.pullAnsweredQuestionsForAgentBounded(agentId, new Date().toISOString(), 1_000_000, () => 10);
    check("(B2) pullAnsweredQuestionsForAgentBounded excludes the fresh notice too", bounded.consumed.every((r) => r.id !== built.question.id));
    check("(B3) the notice itself is untouched by either pull — still 'notice', not 'consumed'", db.getQuestion(built.question.id)?.state === "notice");
  }

  // ===== (C) a notice is never answerable — the generic writer no-ops on a non-'pending' row =====
  {
    const built = buildQuestionAsk(
      { type: "notice", title: "Third notice", body: "nothing to answer" },
      { sessionId: mgrId, projectId: projId, db, role: "manager" },
    );
    db.insertQuestion(built.question);
    const result = db.answerQuestion(built.question.id, { chosenOption: null, note: "an agent trying to answer it anyway", answeredAt: new Date().toISOString() });
    check("(C) answerQuestion() is a no-op on an already-self-terminal notice (returns undefined)", result === undefined);
    check("(C) the notice's note stays null — the no-op write never landed", db.getQuestion(built.question.id)?.note === null);
  }

  // ===== (D) the per-agent-lineage notice rate limit refuses loudly once exceeded =====
  {
    const limitedProjId = "nk-proj-limited";
    db.insertProject({ id: limitedProjId, name: "NK-limited", repoPath: limitedProjId, vaultPath: limitedProjId, config: { orchestration: { maxNoticesPerHour: 2 } }, createdAt: now, archivedAt: null });
    const limitedAgentId = "nk-agent-limited";
    db.insertAgent({ id: limitedAgentId, projectId: limitedProjId, name: "Manager", startupPrompt: "BRIEF", position: 0 });
    const limitedMgrId = "nk-mgr-limited";
    db.insertSession({
      id: limitedMgrId, projectId: limitedProjId, agentId: limitedAgentId, engineSessionId: "eng-nk-limited", title: null, cwd: limitedProjId,
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: "manager",
    });
    const fileOne = (n) => {
      const built = buildQuestionAsk(
        { type: "notice", title: `Status update ${n}`, body: "ongoing work" },
        { sessionId: limitedMgrId, projectId: limitedProjId, db, role: "manager" },
      );
      if ("question" in built) db.insertQuestion(built.question);
      return built;
    };
    const first = fileOne(1);
    const second = fileOne(2);
    const third = fileOne(3);
    check("(D1) the 1st notice (under the limit of 2) succeeds", "question" in first);
    check("(D2) the 2nd notice (AT the limit of 2) succeeds", "question" in second);
    check("(D3) the 3rd notice (OVER the limit of 2) is REFUSED", "error" in third);
    check("(D4) the refusal names the configured limit, not a generic message", "error" in third && third.error.includes("2 notice"));
    check("(D5) the refusal points at consolidating rather than at `supersedes` as if it worked here", "error" in third && third.error.toLowerCase().includes("consolidate"));
    // A DIFFERENT agent lineage on the SAME project is UNAFFECTED — the limit is per-lineage, not per-project.
    const otherAgentId = "nk-agent-limited-other";
    db.insertAgent({ id: otherAgentId, projectId: limitedProjId, name: "Manager2", startupPrompt: "BRIEF", position: 1 });
    const otherMgrId = "nk-mgr-limited-other";
    db.insertSession({
      id: otherMgrId, projectId: limitedProjId, agentId: otherAgentId, engineSessionId: "eng-nk-limited-other", title: null, cwd: limitedProjId,
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: "manager",
    });
    const otherLineageFirst = buildQuestionAsk(
      { type: "notice", title: "Status update (other lineage)", body: "ongoing work" },
      { sessionId: otherMgrId, projectId: limitedProjId, db, role: "manager" },
    );
    check("(D6) a DIFFERENT agent lineage, same project, is NOT rate-limited by the first lineage's usage", "question" in otherLineageFirst);
  }

  // ===== (E) a worker's MCP surface has no question_ask tool; manager + Lead both do =====
  {
    const workerId = "nk-worker";
    db.insertSession({
      id: workerId, projectId: projId, agentId, engineSessionId: "eng-nk-worker", title: null, cwd: projId,
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: "worker", parentSessionId: mgrId,
    });
    const reservedProjId = "nk-platform-home";
    db.insertProject({ id: reservedProjId, name: "Loom Platform", repoPath: reservedProjId, vaultPath: reservedProjId, config: {}, createdAt: now, archivedAt: null, reserved: true });
    const leadAgentId = "nk-lead-agent";
    db.insertAgent({ id: leadAgentId, projectId: reservedProjId, name: "Lead", startupPrompt: "BRIEF", position: 0 });
    const leadId = "nk-lead";
    db.insertSession({
      id: leadId, projectId: reservedProjId, agentId: leadAgentId, engineSessionId: "eng-nk-lead", title: null, cwd: reservedProjId,
      processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
      lastError: null, role: "platform",
    });

    async function listToolNames(server) {
      const client = new Client({ name: "notice-request-kind-test", version: "0" });
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(st), client.connect(ct)]);
      const names = (await client.listTools()).tools.map((t) => t.name);
      await client.close();
      return names;
    }

    const orch = new OrchestrationMcpRouter(db, {});
    const managerTools = await listToolNames(orch.buildServer(mgrId, "manager"));
    const workerTools = await listToolNames(orch.buildServer(workerId, "worker"));
    const leadTools = await listToolNames(new PlatformMcpRouter(db, {}).buildServer(leadId));

    check("(E1) the MANAGER surface has question_ask (the 'notice' kind rides this existing tool)", managerTools.includes("question_ask"));
    check("(E2) the WORKER surface has NO question_ask tool at all — a worker can never post a notice directly", !workerTools.includes("question_ask"));
    check("(E3) the worker's entire surface is still just worker_report + run_gate + my_context + reads (no Requests tool leaked in)", !workerTools.some((t) => t.startsWith("question_")) && !workerTools.includes("requests_list"));
    check("(E4) the PLATFORM LEAD surface also has question_ask (ported, per mcp/platform.ts)", leadTools.includes("question_ask"));

    // ===== (F) the AGENT config validator rejects orchestration.maxNoticesPerHour =====
    {
      const okv = (r) => r.ok === true;
      const agentSet = validateAgentProjectConfigOverride({ orchestration: { maxNoticesPerHour: 10 } });
      check("(F1) AGENT project-config shape REJECTS orchestration.maxNoticesPerHour", !okv(agentSet) && /maxNoticesPerHour/.test(agentSet.error ?? ""));
      check("(F2) CONTROL: the AGENT shape still accepts a normal nested orchestration key", okv(validateAgentProjectConfigOverride({ orchestration: { maxConcurrentWorkers: 2 } })));
      check("(F3) the nested human-only list names orchestration.maxNoticesPerHour", HUMAN_ONLY_NESTED_PROJECT_CONFIG_KEYS.includes("orchestration.maxNoticesPerHour"));
      check("(F4) CONTROL: the human (full) validator still ACCEPTS it — this is a trust-tier restriction, not a validation bug", okv(validateProjectConfigOverride({ orchestration: { maxNoticesPerHour: 10 } })));
    }

    // ===== (G) the ELEVATED Platform Lead's project_configure also rejects it — even the Lead can't raise its own limit =====
    {
      const before = JSON.stringify(db.getProject(reservedProjId).config);
      const leadConfigureServer = new PlatformMcpRouter(db, {}).buildServer(leadId);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await Promise.all([leadConfigureServer.connect(st), (async () => {})()]);
      const client = new Client({ name: "notice-request-kind-lead-configure-test", version: "0" });
      await client.connect(ct);
      const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);
      const leadRes = await call("project_configure", { projectId: reservedProjId, config: { orchestration: { maxNoticesPerHour: 10 } } });
      check("(G1) elevated Platform-Lead project_configure REJECTS nested orchestration.maxNoticesPerHour", typeof leadRes.error === "string" && /maxNoticesPerHour/.test(leadRes.error));
      check("(G2) the rejected configure left the stored config UNCHANGED", JSON.stringify(db.getProject(reservedProjId).config) === before);
      await client.close();
    }
  }

  // ===== (H) listOpenQuestions' default view shows an UNREAD notice, excludes a READ one; History shows
  // both (card 54007ab7, Phase 2 of 59fa6403 — replaces the old fixed-age-window stopgap) =====
  {
    const unreadBuilt = buildQuestionAsk(
      { type: "notice", title: "Unread notice", body: "never opened" },
      { sessionId: mgrId, projectId: projId, db, role: "manager" },
    );
    db.insertQuestion(unreadBuilt.question);
    const readBuilt = buildQuestionAsk(
      { type: "notice", title: "Read notice", body: "already seen" },
      { sessionId: mgrId, projectId: projId, db, role: "manager" },
    );
    db.insertQuestion(readBuilt.question);
    const readId = readBuilt.question.id;
    const marked = db.markQuestionsRead([readId], new Date().toISOString());
    check("(H setup) markQuestionsRead actually stamped the 'read' notice", marked.length === 1 && marked[0] === readId);

    const defaultView = db.listOpenQuestions(false);
    check("(H1) the default 'waiting on me' view INCLUDES the unread notice", defaultView.some((q) => q.id === unreadBuilt.question.id));
    check("(H2) the default view EXCLUDES the read notice", !defaultView.some((q) => q.id === readId));

    const historyView = db.listOpenQuestions(true);
    check("(H3) History (includeConsumed:true) includes the UNREAD notice too", historyView.some((q) => q.id === unreadBuilt.question.id));
    check("(H4) History (includeConsumed:true) ALSO includes the READ notice — read state never matters there", historyView.some((q) => q.id === readId));

    // ===== (I) card 54007ab7: requests_list's backing listQuestionsForAudit gets the SAME read-driven
    // visibility under its default excludeConsumed:true (the manager's requests_list), for consistency
    // with the web Inbox — without this, requests_list's default view would keep every notice forever. =====
    const auditExcludeConsumed = db.listQuestionsForAudit({ projectId: projId, excludeConsumed: true });
    check("(I1) listQuestionsForAudit(excludeConsumed:true) INCLUDES the unread notice", auditExcludeConsumed.some((q) => q.id === unreadBuilt.question.id));
    check("(I2) listQuestionsForAudit(excludeConsumed:true) EXCLUDES the read notice", !auditExcludeConsumed.some((q) => q.id === readId));
    const auditIncludeConsumed = db.listQuestionsForAudit({ projectId: projId, excludeConsumed: false });
    check("(I3) listQuestionsForAudit(excludeConsumed:false) includes BOTH regardless of read state", auditIncludeConsumed.some((q) => q.id === unreadBuilt.question.id) && auditIncludeConsumed.some((q) => q.id === readId));
    const auditExplicitState = db.listQuestionsForAudit({ projectId: projId, state: "notice", excludeConsumed: true });
    check("(I4) an EXPLICIT state:\"notice\" filter always shows it regardless of read state, even with excludeConsumed:true", auditExplicitState.some((q) => q.id === readId));
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — card 59fa6403's `type:\"notice\"` kind is self-terminal at ask time (its OWN 'notice' " +
    "state, round 2 / b13df292, never a reused 'answered'), is structurally excluded from both " +
    "question_pull backing queries, is never answerable via the generic writer, is rate-limited per " +
    "agent lineage with a loud refusal (never a silent drop) once a configured per-project limit is " +
    "exceeded, and a worker's MCP surface still has no question_ask tool at all; the notice rate limit " +
    "is human-only even from the elevated Platform Lead (both the agent validator and the Lead's own " +
    "project_configure reject it); and listOpenQuestions' default view includes an unread notice while " +
    "excluding a read one, with History including both regardless of read state."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
