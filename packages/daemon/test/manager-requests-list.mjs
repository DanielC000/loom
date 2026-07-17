import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// A non-consuming, board-wide manager `requests_list({state?,type?,includeConsumed?,mine?})` on the
// `loom-orchestration` surface (mcp/orchestration.ts), scoped SERVER-SIDE to the caller's own project —
// the gap between question_pull (consumes, answered-only) and task_requests_list/task_request_get
// (task-scoped only): a request answered with NO taskId, or a board-wide survey including
// pending/answered/consumed (asked by a predecessor manager on the same project) was previously
// unreachable via MCP. Mirrors the Platform Auditor's cross-project `requests_list` (mcp/audit.ts,
// audit-requests-list.mjs) — same per-type answer shaping (questionTool.ts's auditRequestItem/
// questionAnswerByType) so the credential never-echo guarantee can't drift between the two read
// surfaces — but scoped to ONE project, with NO projectId param, plus an `includeConsumed` toggle.
//
// `mine` (task f724d65a) is the NON-CONSUMING counterpart to question_pull for a scheduled/autonomous
// agent to dedup before re-filing: narrows the board-wide read down to ONLY this caller's own AGENT
// LINEAGE's requests — the identical ownership scope `question_pull`/`pullAnsweredQuestionsForAgent`
// consume from (db.ts's `listQuestionsForAudit` `agentId` filter), so a fresh successor session on the
// same agent still sees a predecessor's still-pending/answered-but-unpulled requests. Chosen over adding
// a brand-new tool: it reuses the exact same query/shaping code as the existing board-wide read, just one
// more optional filter — see orchestration.ts's requests_list registration for the design note.
//
// HERMETIC — a REAL Db + SessionService + OrchestrationMcpRouter, tool handlers invoked directly (no pty,
// no real claude/network/daemon). Mirrors question-answer-nudge-purge.mjs's router setup.
//
// Covers:
//   (A) state + type filtering narrows correctly.
//   (B) includeConsumed: consumed rows are excluded by default, included when includeConsumed:true; an
//       explicit state:"consumed" always shows consumed rows regardless of the flag.
//   (C) NON-CONSUMING — calling requests_list twice returns the same records; a pending/answered row's
//       state is unchanged after being read.
//   (D) own-project scoping — a request from a DIFFERENT project never surfaces, and there is no
//       projectId param to widen the read.
//   (E) credential never-echo — a credential row carries only {ack}, never secret_blob/secretBlob/secret,
//       and the raw stored secret_blob is genuinely ciphertext (proves the tool is what filters it).
//   (F) mine — returns BOTH of the caller's own pending+answered requests, excludes another agent's
//       request on the SAME project (proves it's narrower than plain project scoping) and another
//       project's request; is non-consuming (repeat call + a still-pending question_pull afterward both
//       see it unchanged); a subsequent REAL question_pull call still finds + consumes the answered one.
//
// Run: 1) build (turbo builds shared first), 2) node test/manager-requests-list.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-mgr-requests-list-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { DEFAULT_REQUESTS_LIST_CAP } = await import("../dist/mcp/audit.js");
const { encryptSecret } = await import("../dist/keys/envelope.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const dbFile = path.join(tmpHome, "mrl.db");
const keyPath = path.join(tmpHome, "secret.key"); // isolated test key — NEVER the real SECRET_KEY_PATH
const db = new Db(dbFile);
const now = new Date().toISOString();

try {
  // --- two projects: pA (the caller's own) and pOther (must never surface) ---
  db.insertProject({ id: "pA", name: "Project A", repoPath: "pA", vaultPath: "pA", config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: "pOther", name: "Other Project", repoPath: "pOther", vaultPath: "pOther", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentA", projectId: "pA", name: "Mgr A", startupPrompt: "MGR", position: 0 });
  db.insertAgent({ id: "agentOther", projectId: "pOther", name: "Mgr Other", startupPrompt: "MGR", position: 0 });
  db.insertSession({
    id: "mgrA", projectId: "pA", agentId: "agentA", engineSessionId: null, title: null, cwd: "pA",
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
  db.insertSession({
    id: "mgrOther", projectId: "pOther", agentId: "agentOther", engineSessionId: null, title: null, cwd: "pOther",
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });

  const insertQ = (over) => {
    const id = over.id;
    db.insertQuestion({
      id, sessionId: over.sessionId, projectId: over.projectId, type: over.type ?? "decision",
      title: over.title, body: over.body ?? "b", options: over.options ?? null, recommendation: over.recommendation ?? null,
      taskId: over.taskId ?? null, permissionAction: over.permissionAction ?? null, permissionScope: over.permissionScope ?? null,
      permissionExpiresAt: over.permissionExpiresAt ?? null, credentialEnvVar: over.credentialEnvVar ?? null,
      state: over.state ?? "pending", chosenOption: over.chosenOption ?? null, note: over.note ?? null,
      createdAt: over.createdAt ?? now, answeredAt: over.answeredAt ?? null, consumedAt: over.consumedAt ?? null,
    });
    return id;
  };

  // pA: a pending decision (no taskId), an answered permission, a pending credential, and a CONSUMED
  // decision (as if pulled by a predecessor manager on this same project — a3f1319f's gap case).
  const qPendingDecision = insertQ({ id: "req-a-pending", sessionId: "mgrA", projectId: "pA", title: "Which lib?", options: ["X", "Y"] });
  const qAnsweredPermission = insertQ({ id: "req-a-perm", sessionId: "mgrA", projectId: "pA", type: "permission", title: "Force-push?", permissionAction: "force-push origin/main", state: "answered", chosenOption: "approve", answeredAt: now });
  const qCred = insertQ({ id: "req-a-cred", sessionId: "mgrA", projectId: "pA", type: "credential", title: "Need Stripe key", credentialEnvVar: "STRIPE_API_KEY" });
  const qConsumed = insertQ({ id: "req-a-consumed", sessionId: "mgrA", projectId: "pA", title: "Old decision", state: "consumed", chosenOption: "Y", answeredAt: now, consumedAt: now });

  // pOther: a request that must NEVER surface for mgrA.
  const qOther = insertQ({ id: "req-other-1", sessionId: "mgrOther", projectId: "pOther", title: "Other project's ask" });

  const sessions = new SessionService(db, { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null, purgeQueuedByQuestionIds: () => [] }, new OrchestrationControl());
  const router = new OrchestrationMcpRouter(db, sessions);
  const mgrServer = router.buildServer("mgrA", "manager");
  // (card a193398f) requests_list now returns {items, total, returned, offset, hasMore} instead of a bare
  // array — `call` unwraps `.items` so every EXISTING array-shaped assertion below stays unchanged;
  // `callRaw` (used by the new (G) cap/paging checks) returns the full envelope.
  const callRaw = async (args) => JSON.parse((await mgrServer._registeredTools["requests_list"].handler(args ?? {})).content[0].text);
  const call = async (args) => (await callRaw(args)).items;

  check("requests_list is registered on the loom-orchestration surface", "requests_list" in mgrServer._registeredTools);

  // ============ (D) own-project scoping ============
  const defaultRead = await call({});
  check("(D) default read excludes consumed by default (see (B)) but never leaks pOther's row", !defaultRead.some((r) => r.id === qOther));
  const allStates = [
    ...await call({}),
    ...await call({ state: "consumed" }),
  ];
  check("(D) no combination of filters surfaces another project's request", !allStates.some((r) => r.id === qOther) && !allStates.some((r) => r.projectId === "pOther"));

  // Introspect the REAL MCP tool schema (not the closed-over handler) via a real client/server pair —
  // proves there is no projectId param an agent could pass to widen the read past its own project.
  {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const introspectServer = router.buildServer("mgrA", "manager");
    await introspectServer.connect(serverT);
    const mcpClient = new Client({ name: "manager-requests-list-schema-test", version: "0" });
    await mcpClient.connect(clientT);
    const tool = (await mcpClient.listTools()).tools.find((t) => t.name === "requests_list");
    const props = tool?.inputSchema?.properties ?? {};
    check("(D) requests_list has NO projectId param to widen the read", !("projectId" in props));
    check("(D) requests_list exposes exactly state/type/includeConsumed/mine/limit/offset", ["state", "type", "includeConsumed", "mine", "limit", "offset"].every((k) => k in props) && Object.keys(props).length === 6);
    await mcpClient.close();
  }

  // ============ (A) state + type filtering ============
  const filteredByState = await call({ state: "pending" });
  check("(A) state:pending returns only pending rows", filteredByState.length > 0 && filteredByState.every((r) => r.state === "pending") && filteredByState.some((r) => r.id === qPendingDecision) && filteredByState.some((r) => r.id === qCred));
  const filteredByType = await call({ type: "permission" });
  check("(A) type:permission returns only the permission row", filteredByType.length === 1 && filteredByType[0].id === qAnsweredPermission);
  const filteredByBoth = await call({ state: "answered", type: "permission" });
  check("(A) state+type AND together", filteredByBoth.length === 1 && filteredByBoth[0].id === qAnsweredPermission);

  // ============ (B) includeConsumed ============
  const noFlag = await call({});
  check("(B) includeConsumed omitted (default false): consumed row is EXCLUDED", !noFlag.some((r) => r.id === qConsumed) && noFlag.some((r) => r.id === qPendingDecision));
  const withFlag = await call({ includeConsumed: true });
  check("(B) includeConsumed:true folds the consumed row in alongside the rest", withFlag.some((r) => r.id === qConsumed) && withFlag.some((r) => r.id === qPendingDecision));
  const explicitConsumedState = await call({ state: "consumed" });
  check("(B) an explicit state:\"consumed\" always shows consumed rows, includeConsumed unset", explicitConsumedState.length === 1 && explicitConsumedState[0].id === qConsumed);
  const explicitConsumedStateFalseFlag = await call({ state: "consumed", includeConsumed: false });
  check("(B) explicit state:\"consumed\" wins even when includeConsumed:false", explicitConsumedStateFalseFlag.length === 1 && explicitConsumedStateFalseFlag[0].id === qConsumed);

  // ============ (C) NON-CONSUMING ============
  const beforeState = db.getQuestion(qAnsweredPermission).state;
  await call({});
  await call({});
  const afterState = db.getQuestion(qAnsweredPermission).state;
  check("(C) reading an ANSWERED request via requests_list never flips it to consumed", beforeState === "answered" && afterState === "answered");
  const firstRead = await call({ includeConsumed: true });
  const secondRead = await call({ includeConsumed: true });
  check("(C) calling requests_list twice returns the SAME records (stable double-call)", JSON.stringify(firstRead.map((r) => r.id).sort()) === JSON.stringify(secondRead.map((r) => r.id).sort()));
  const pendingStateAfter = db.getQuestion(qPendingDecision).state;
  check("(C) a PENDING row's state is unchanged after being read", pendingStateAfter === "pending");

  // ============ (E) credential never-echo ============
  const credRowPending = (await call({ type: "credential" })).find((r) => r.id === qCred);
  check("(E) a PENDING credential reads ack:null", credRowPending.ack === null && credRowPending.state === "pending");
  check("(E) a PENDING credential response has NO secret_blob/secretBlob/secret field", !("secretBlob" in credRowPending) && !("secret_blob" in credRowPending) && !("secret" in credRowPending));

  const plaintext = "sk_live_super_secret_do_not_leak_9876543210";
  const secretBlob = encryptSecret(plaintext, keyPath);
  db.answerCredentialQuestion(qCred, { secretBlob, answeredAt: new Date().toISOString() });
  const credRowAnswered = (await call({ type: "credential" })).find((r) => r.id === qCred);
  check("(E) an ANSWERED credential surfaces a non-empty, non-secret `ack` string", typeof credRowAnswered.ack === "string" && credRowAnswered.ack.length > 0);
  check("(E) the ack references the requested envVar hint, not the secret", credRowAnswered.ack.includes("STRIPE_API_KEY") && !credRowAnswered.ack.includes(plaintext));
  check("(E) the response STILL has no secretBlob/secret_blob/secret field after answering", !("secretBlob" in credRowAnswered) && !("secret_blob" in credRowAnswered) && !("secret" in credRowAnswered));
  const allRowsIncludingCred = await call({ includeConsumed: true });
  check("(E) JSON.stringify of the whole response list never contains the plaintext", !JSON.stringify(allRowsIncludingCred).includes(plaintext));
  const rawCredRow = db.db.prepare("SELECT secret_blob FROM questions WHERE id = ?").get(qCred);
  check("(E) the underlying db row DOES carry a non-empty encrypted secret_blob (proves the tool is what filters it, not that it's simply absent)", typeof rawCredRow?.secret_blob === "string" && rawCredRow.secret_blob.length > 0);
  check("(E) the raw stored secret_blob is genuinely ciphertext, not the plaintext secret", rawCredRow.secret_blob !== plaintext && !rawCredRow.secret_blob.includes(plaintext));

  // ============ (F) mine — agent-lineage "my own requests" dedup read (task f724d65a) ============
  // A second agent (agentA2) on the SAME project pA — proves `mine` narrows past project-scoping alone.
  db.insertAgent({ id: "agentA2", projectId: "pA", name: "Mgr A2", startupPrompt: "MGR", position: 1 });
  db.insertSession({
    id: "mgrA2", projectId: "pA", agentId: "agentA2", engineSessionId: null, title: null, cwd: "pA",
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
  const qOtherAgentSameProject = insertQ({ id: "req-a2-pending", sessionId: "mgrA2", projectId: "pA", title: "Another agent's ask on the same project" });

  // File mgrA's own two requests through the REAL question_ask tool, so ownership is stamped exactly the
  // way production does (mcp/questionTool.ts's buildQuestionAsk sets sessionId: ctx.sessionId server-side).
  const askMine = async (args) => JSON.parse((await mgrServer._registeredTools["question_ask"].handler(args)).content[0].text);
  const pendingMineId = (await askMine({ title: "Mine — still pending", body: "b" })).questionId;
  const answeredMineId = (await askMine({ title: "Mine — answered, not yet pulled", body: "b" })).questionId;
  db.answerQuestion(answeredMineId, { chosenOption: null, note: "yep", answeredAt: new Date().toISOString() });

  const mineRead1 = await call({ mine: true });
  check(
    "(F) mine:true returns BOTH of this agent's own requests, with correct states",
    mineRead1.some((r) => r.id === pendingMineId && r.state === "pending") &&
      mineRead1.some((r) => r.id === answeredMineId && r.state === "answered"),
  );
  check("(F) mine:true does NOT return another agent's request on the SAME project", !mineRead1.some((r) => r.id === qOtherAgentSameProject));
  check("(F) mine:true does NOT return another project's request either", !mineRead1.some((r) => r.id === qOther));
  check("(F) plain requests_list (no mine) DOES see the other agent's request — proves mine is narrower, not just project-scoped", (await call({})).some((r) => r.id === qOtherAgentSameProject));

  const mineRead2 = await call({ mine: true });
  check("(F) mine:true is NON-CONSUMING — a second call returns the same ids", JSON.stringify(mineRead1.map((r) => r.id).sort()) === JSON.stringify(mineRead2.map((r) => r.id).sort()));
  check("(F) mine:true reading an answered row never flips its state", db.getQuestion(answeredMineId).state === "answered");

  const pull = async () => JSON.parse((await mgrServer._registeredTools["question_pull"].handler({})).content[0].text);
  const pulled = await pull();
  check("(F) a subsequent question_pull still finds the answered request unconsumed by the earlier mine:true reads", pulled.questions.some((q) => q.questionId === answeredMineId));
  check("(F) after question_pull, the request is now consumed", db.getQuestion(answeredMineId).state === "consumed");
  const mineRead3 = await call({ mine: true });
  check("(F) mine:true (excludeConsumed default) no longer shows the now-consumed request", !mineRead3.some((r) => r.id === answeredMineId));
  const mineRead3WithConsumed = await call({ mine: true, includeConsumed: true });
  check("(F) mine:true with includeConsumed:true still shows it, correctly state:consumed", mineRead3WithConsumed.some((r) => r.id === answeredMineId && r.state === "consumed"));

  // ============ (G) cap + paging (card a193398f) ============
  // Seed a known-size batch of FRESH pending rows so the paging math below is deterministic regardless of
  // exactly what earlier sections left behind — e.g. (F)'s REAL question_pull call drains every ANSWERED
  // request for that agent lineage, not just the one it was targeting, so the pre-existing pending/
  // answered count at this point is intentionally not hardcoded here.
  for (let i = 0; i < 6; i++) insertQ({ id: `req-page-${i}`, sessionId: "mgrA", projectId: "pA", title: `page filler ${i}` });

  const capBaseline = await callRaw({});
  const total = capBaseline.total; // >= 6 (the filler above) + whatever else is still pending/answered
  check(
    "(G) response envelope includes total/returned/offset/hasMore alongside items",
    typeof capBaseline.total === "number" && typeof capBaseline.returned === "number" &&
      capBaseline.offset === 0 && typeof capBaseline.hasMore === "boolean",
  );
  check(
    "(G) total/returned/items.length agree when under the cap",
    capBaseline.total === capBaseline.items.length && capBaseline.returned === capBaseline.items.length && capBaseline.hasMore === false,
  );

  const limited = await callRaw({ limit: 2 });
  check(
    "(G) an explicit limit caps items/returned without changing total",
    limited.items.length === 2 && limited.returned === 2 && limited.total === total && limited.hasMore === true,
  );

  const page2 = await callRaw({ limit: 2, offset: 2 });
  check("(G) offset pages forward — no overlap with the first page", page2.items.length === 2 && !page2.items.some((r) => limited.items.some((r2) => r2.id === r.id)));
  check("(G) hasMore reflects whether rows remain past this page", page2.hasMore === (2 + 2 < total));

  // offset = total-1 guarantees EXACTLY one row left, regardless of total's exact value (which depends on
  // however many pending/answered rows earlier sections left behind).
  const lastPage = await callRaw({ limit: 2, offset: total - 1 });
  check(
    "(G) the final page is short and hasMore flips false once every row has been paged through",
    lastPage.items.length === 1 && lastPage.hasMore === false,
  );

  // Exceed DEFAULT_REQUESTS_LIST_CAP so the DEFAULT (no explicit limit) call is PROVABLY truncated, not
  // just theoretically bounded — the whole point of the guardrail (never leave a manager silently blind
  // to requests beyond the cap).
  for (let i = 0; i < DEFAULT_REQUESTS_LIST_CAP + 5; i++) {
    insertQ({ id: `req-cap-${i}`, sessionId: "mgrA", projectId: "pA", title: `cap filler ${i}` });
  }
  const overCap = await callRaw({});
  check(
    `(G) the DEFAULT read is truncated to ${DEFAULT_REQUESTS_LIST_CAP} rows once the project has more matching requests than that`,
    overCap.items.length === DEFAULT_REQUESTS_LIST_CAP && overCap.returned === DEFAULT_REQUESTS_LIST_CAP,
  );
  check("(G) total still reports the FULL matching count even though items is truncated", overCap.total === capBaseline.total + DEFAULT_REQUESTS_LIST_CAP + 5);
  check("(G) hasMore is true once the project exceeds the default cap", overCap.hasMore === true);
  const overCapAllPaged = await callRaw({ limit: overCap.total });
  check(
    "(G) an explicit limit at/above total reaches every row — the cap is pageable-past, not a hard ceiling",
    overCapAllPaged.items.length === overCap.total && overCapAllPaged.hasMore === false,
  );
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the manager's requests_list correctly filters by state+type, folds in consumed rows only via includeConsumed (an explicit state:\"consumed\" always wins), never consumes/flips state on read (stable across repeated calls), never surfaces another project's requests (and has no projectId param to widen the read), a credential request's secret is never present in the output (only a non-secret ack), and mine:true correctly narrows to the caller's own agent lineage — excluding another agent's request on the same project — while staying non-consuming alongside a REAL question_pull."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
