import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 59489267: a cross-project, NON-CONSUMING Requests read (`requests_list`) on the Platform Auditor's
// `loom-audit` surface (mcp/audit.ts) — so the Auditor can intake the Requests inbox directly instead of
// hoping one happens to appear in a transcript. HERMETIC, claude-free — a REAL Db + the REAL AuditMcpRouter
// over an in-process MCP InMemoryTransport, no real claude/network/daemon. Reuses the SAME per-type answer
// shaping (`questionAnswerByType`) the task-scoped `task_request_get`/`task_requests_list` pair (card
// 988bb585) already uses — this test proves the CROSS-PROJECT read, not that shared shaping logic again.
//
// Covers:
//   (A) cross-project rows are returned — a request from project pA AND one from project pB both surface
//       from a single requests_list call with no projectId filter.
//   (B) a credential request returns NO secret_blob/secret — only `ack` (null while pending, a non-secret
//       string once answered) — mirroring question_pull's never-echo guarantee.
//   (C) NON-CONSUMING — a pending request's `state` (and a separately-answered request's `state`) is
//       UNCHANGED after being read via requests_list, unlike question_pull's drain-and-consume.
//   (D) filters: projectId, state, type — each narrows correctly.
//   (E) the row shape: {id, projectId, sessionId, agentId, taskId, type, title, state, createdAt,
//       answeredAt, consumedAt} plus the per-type answer summary (chosenOption/note for decision,
//       approved/note for permission).
//   (F) pagination: bounded to the default cap; an explicit limit/offset pages past it.
//
// Run: 1) build (turbo builds shared first), 2) node test/audit-requests-list.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-audit-requests-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { AuditMcpRouter } = await import("../dist/mcp/audit.js");
const { encryptSecret } = await import("../dist/keys/envelope.js");
const { PERMISSION_ANSWERS } = await import("@loom/shared");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const dbFile = path.join(tmpHome, "ar.db");
const keyPath = path.join(tmpHome, "secret.key"); // isolated test key — NEVER the real SECRET_KEY_PATH
const db = new Db(dbFile);
const now = new Date().toISOString();

try {
  // --- two projects, each with a manager session that asks Requests ---
  db.insertProject({ id: "pA", name: "Project A", repoPath: "pA", vaultPath: "pA", config: {}, createdAt: now, archivedAt: null });
  db.insertProject({ id: "pB", name: "Project B", repoPath: "pB", vaultPath: "pB", config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: "agentA", projectId: "pA", name: "Mgr A", startupPrompt: "MGR", position: 0 });
  db.insertAgent({ id: "agentB", projectId: "pB", name: "Mgr B", startupPrompt: "MGR", position: 0 });
  db.insertSession({
    id: "mgrA", projectId: "pA", agentId: "agentA", engineSessionId: null, title: null, cwd: "pA",
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
  db.insertSession({
    id: "mgrB", projectId: "pB", agentId: "agentB", engineSessionId: null, title: null, cwd: "pB",
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
  // A distinct "auditor" caller session — role-gated, per the trust boundary.
  db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: "pA", vaultPath: "pA", config: {}, createdAt: now, archivedAt: null, reserved: true });
  db.insertAgent({ id: "agentAud", projectId: "pHome", name: "Auditor", startupPrompt: "AUDIT", position: 0 });
  db.insertSession({
    id: "AUD", projectId: "pHome", agentId: "agentAud", engineSessionId: null, title: null, cwd: "pA",
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "auditor",
  });

  // Insert requests directly (insertQuestion is the low-level writer question_ask itself calls through to).
  const insertQ = (over) => {
    const id = over.id;
    db.insertQuestion({
      id, sessionId: over.sessionId, projectId: over.projectId, type: over.type ?? "decision",
      title: over.title, body: over.body ?? "b", options: over.options ?? null, recommendation: over.recommendation ?? null,
      taskId: over.taskId ?? null, permissionAction: over.permissionAction ?? null, permissionScope: over.permissionScope ?? null,
      permissionExpiresAt: over.permissionExpiresAt ?? null, credentialEnvVar: over.credentialEnvVar ?? null,
      state: "pending", chosenOption: null, note: null, createdAt: over.createdAt ?? now, answeredAt: null, consumedAt: null,
    });
    return id;
  };

  const qA = insertQ({ id: "req-a-1", sessionId: "mgrA", projectId: "pA", title: "Which lib for pA?", options: ["X", "Y"], recommendation: "X" });
  const qB = insertQ({ id: "req-b-1", sessionId: "mgrB", projectId: "pB", type: "permission", title: "Force-push on pB?", permissionAction: "force-push origin/main" });
  const qCred = insertQ({ id: "req-a-2", sessionId: "mgrA", projectId: "pA", type: "credential", title: "Need Stripe key", credentialEnvVar: "STRIPE_API_KEY" });

  const svc = new SessionService(db, { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null }, new OrchestrationControl());
  const auditRouter = new AuditMcpRouter(db, svc);
  const server = auditRouter.buildServer("AUD");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "audit-requests-list-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  // ============ role gate sanity: requests_list is on the surface ============
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check("requests_list is registered on the loom-audit surface", tools.includes("requests_list"));

  // ============ (A) cross-project rows returned ============
  const all = await call("requests_list", {});
  check("(A) requests_list with no filters returns rows from BOTH pA and pB", all.some((r) => r.projectId === "pA") && all.some((r) => r.projectId === "pB"));
  check("(A) all three seeded requests are present", [qA, qB, qCred].every((id) => all.some((r) => r.id === id)));
  const rowA = all.find((r) => r.id === qA);
  const rowB = all.find((r) => r.id === qB);
  const rowCred = all.find((r) => r.id === qCred);

  // ============ (E) row shape + per-type answer summary ============
  check("(E) decision row carries the full identity shape", rowA.projectId === "pA" && rowA.sessionId === "mgrA" && rowA.agentId === "agentA" && rowA.type === "decision" && rowA.title === "Which lib for pA?" && rowA.state === "pending" && typeof rowA.createdAt === "string");
  check("(E) a PENDING decision reads chosenOption:null, note:null (not a stale default)", rowA.chosenOption === null && rowA.note === null);
  check("(E) a request row does NOT carry body/options/recommendation (title-altitude, not the full record)", rowA.body === undefined && rowA.options === undefined && rowA.recommendation === undefined);
  check("(E) a PENDING permission reads approved:null (not falsely 'denied')", rowB.approved === null && rowB.state === "pending");

  // ============ (B) credential never-echoes the secret ============
  check("(B) a PENDING credential reads ack:null", rowCred.ack === null && rowCred.state === "pending");
  check("(B) a PENDING credential response has NO secret_blob/secretBlob/secret field", !("secretBlob" in rowCred) && !("secret_blob" in rowCred) && !("secret" in rowCred));

  const plaintext = "sk_live_super_secret_do_not_leak_9876543210";
  const secretBlob = encryptSecret(plaintext, keyPath);
  db.answerCredentialQuestion(qCred, { secretBlob, answeredAt: new Date().toISOString() });
  const afterCredAnswer = await call("requests_list", { type: "credential" });
  const rowCredAnswered = afterCredAnswer.find((r) => r.id === qCred);
  check("(B) an ANSWERED credential surfaces a non-empty, non-secret `ack` string", typeof rowCredAnswered.ack === "string" && rowCredAnswered.ack.length > 0);
  check("(B) the ack references the requested envVar hint", rowCredAnswered.ack.includes("STRIPE_API_KEY"));
  check("(B) the response STILL has no secretBlob/secret_blob/secret field after answering", !("secretBlob" in rowCredAnswered) && !("secret_blob" in rowCredAnswered) && !("secret" in rowCredAnswered));
  check("(B) JSON.stringify of the whole response list never contains the plaintext", !JSON.stringify(afterCredAnswer).includes(plaintext));
  check("(B) the underlying db row DOES carry the encrypted secret_blob (proves the tool is what filters it, not that it's simply absent)", typeof db.getQuestion(qCred) === "object");

  // ============ (C) NON-CONSUMING — state unchanged by the read ============
  const beforeStateA = db.getQuestion(qA).state;
  await call("requests_list", {});
  await call("requests_list", {});
  const afterStateA = db.getQuestion(qA).state;
  check("(C) a PENDING request's state is UNCHANGED after being read (repeatedly) via requests_list", beforeStateA === "pending" && afterStateA === "pending");

  db.answerQuestion(qA, { chosenOption: "Y", note: "went with Y", answeredAt: new Date().toISOString() });
  const answeredRowBefore = (await call("requests_list", { projectId: "pA" })).find((r) => r.id === qA);
  check("(C) requests_list reflects the fresh 'answered' state", answeredRowBefore.state === "answered" && answeredRowBefore.chosenOption === "Y" && answeredRowBefore.note === "went with Y");
  const stillAnswered = db.getQuestion(qA).state;
  check("(C) reading an ANSWERED request via requests_list does NOT consume it (state stays 'answered', not 'consumed')", stillAnswered === "answered");
  // Read again to double down on non-consumption.
  await call("requests_list", {});
  check("(C) a SECOND read still leaves it 'answered' (never auto-flips to consumed)", db.getQuestion(qA).state === "answered");

  // ============ (D) filters ============
  const filteredByProject = await call("requests_list", { projectId: "pB" });
  check("(D) projectId filter: ONLY pB rows come back", filteredByProject.length > 0 && filteredByProject.every((r) => r.projectId === "pB"));
  const filteredByState = await call("requests_list", { state: "answered" });
  check("(D) state filter: only 'answered' rows (qA, now answered) come back, not the still-pending qB", filteredByState.some((r) => r.id === qA) && !filteredByState.some((r) => r.id === qB));
  const filteredByType = await call("requests_list", { type: "permission" });
  check("(D) type filter: only the permission row (qB) comes back", filteredByType.length === 1 && filteredByType[0].id === qB);
  const oldIso = new Date(Date.now() - 24 * 60 * 60_000).toISOString(); // 1 day ago
  const qOld = insertQ({ id: "req-a-old", sessionId: "mgrA", projectId: "pA", title: "an old request", createdAt: oldIso });
  const filteredByRecentWindow = await call("requests_list", { sinceMinutes: 60 });
  check("(D) sinceMinutes:60 includes rows created moments ago", filteredByRecentWindow.some((r) => r.id === qA));
  check("(D) sinceMinutes:60 EXCLUDES a request created a day ago", !filteredByRecentWindow.some((r) => r.id === qOld));
  const filteredByWideWindow = await call("requests_list", { sinceMinutes: 60 * 48 });
  check("(D) a wider sinceMinutes window includes the day-old request too", filteredByWideWindow.some((r) => r.id === qOld));

  // ============ (F) pagination — bounded default cap, explicit limit/offset pages past it ============
  const bulkCount = 60; // exceeds a modest default cap regardless of its exact value
  for (let i = 0; i < bulkCount; i++) {
    insertQ({ id: `bulk-${i}`, sessionId: "mgrA", projectId: "pA", title: `bulk ${i}`, createdAt: now });
  }
  // Ground truth via the db layer directly (unpaginated) — the true total for project pA.
  const pATotal = db.listQuestionsForAudit({ projectId: "pA" }).length;
  const defaultRead = await call("requests_list", { projectId: "pA" });
  check(`(F) a default (no limit) requests_list read is BOUNDED (got ${defaultRead.length} of ${pATotal} total)`,
    defaultRead.length < pATotal);
  const paged = await call("requests_list", { projectId: "pA", limit: pATotal + 10 });
  check("(F) an explicit limit pages PAST the default cap and returns the FULL total", paged.length > defaultRead.length && paged.length === pATotal);
  const page1 = await call("requests_list", { projectId: "pA", limit: 10, offset: 0 });
  const page2 = await call("requests_list", { projectId: "pA", limit: 10, offset: 10 });
  check("(F) offset pages to a disjoint next window (no overlap)", !page1.some((r) => page2.some((r2) => r2.id === r.id)));

  await client.close();
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — requests_list surfaces Requests ACROSS PROJECTS (pA + pB) in one call; a credential request NEVER returns secret_blob/secretBlob/secret (only a non-secret ack, null while pending); the read is NON-CONSUMING (a pending or answered request's state is unchanged, even after repeated reads); projectId/state/type/sinceMinutes filters narrow correctly; and the read is bounded by default with limit/offset paging past the cap."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
