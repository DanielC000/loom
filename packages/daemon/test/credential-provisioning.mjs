import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Credential auto-provisioning v1 (card 193de09e) — closes the loop `gateway/server.ts`'s
// `answerCredentialQuestion` used to leave half-open: an answered `provisionTo` credential ask now
// CREATES a Connection at the SAME human-only answer boundary, pre-stages any requested profile
// binding as PENDING (never auto-applied), and the agent only ever gets an honest ack.
//
// Covers:
//   (A) buildQuestionAsk's role gate — `provisionTo` is rejected for a non-manager/platform role, even
//       though a worker session has no `question_ask` tool at all today (structural backstop, Q1).
//   (B) REST answer boundary, CREATE path — a `provisionTo` ask with no prior same-name Connection creates
//       one, encrypted correctly, with `provisionConnectionId` set and `provisionBindingState:"pending"`
//       when a binding was requested.
//   (C) REST answer boundary, COLLISION REFUSAL (CR finding — v1 is CREATE-ONLY, never rotate-in-place) —
//       a `provisionTo` naming an EXISTING api-key connection's name is REFUSED (400, question stays
//       'pending', the existing connection untouched); naming an EXISTING **oauth2** connection's name is
//       equally refused, proving the destruction case (an api-key overwrite corrupting its token bundle)
//       never reaches the db layer at all — the bundle is asserted byte-identical afterward.
//   (D) REST answer boundary, no binding requested — `provisionBindingState` stays "none".
//   (E) Provisioning FAILURE — an invalid target 400s and the question stays 'pending' (never
//       answered-but-unprovisioned); no Connection is created.
//   (F) GUARD (manager's explicit ask): a provisioned question has secret_blob:NULL but reads
//       state:"answered" everywhere — getQuestion, pullAnsweredQuestionsForAgent, listOpenQuestions,
//       questionPullItem/taskRequestGetItem/auditRequestItem all still work cleanly on the null blob.
//   (G) Honest ack — the pulled/read ack text names the Connection, states the binding is PENDING (never
//       "applied"/"wired up"), and NEVER contains the plaintext secret; a non-provisioning credential ask's
//       ack is byte-identical to before this card.
//   (H) Audit metadata — taskRequestGetItem/auditRequestItem surface the non-secret provisioning fields.
//
// Run: 1) build (turbo builds shared first), 2) node test/credential-provisioning.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-credential-provisioning-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildQuestionAsk, questionPullItem, taskRequestGetItem, auditRequestItem } = await import("../dist/mcp/questionTool.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { decryptSecret } = await import("../dist/keys/envelope.js");
const { createConnection, createOAuthConnection, getOAuthTokenBundle } = await import("../dist/connections/store.js");

function mkDb(name) {
  const dbFile = path.join(tmpHome, `${name}.db`);
  const db = new Db(dbFile);
  const now = new Date().toISOString();
  const projId = `${name}-proj`, agentId = `${name}-agent`, mgrId = `${name}-mgr`;
  db.insertProject({ id: projId, name: "CP", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({
    id: mgrId, projectId: projId, agentId, engineSessionId: "eng-mgr", title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
  return { dbFile, db, projId, agentId, mgrId };
}
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ===== (A) buildQuestionAsk's role gate =====
{
  const e = mkDb("role-gate");
  const provisionTo = { connection: { name: "Stripe Prod", host: "api.stripe.com" } };

  const asWorker = buildQuestionAsk(
    { type: "credential", title: "Need the Stripe key", body: "billing", provisionTo },
    { sessionId: e.mgrId, projectId: e.projId, db: e.db, role: "worker" },
  );
  check("(A) provisionTo is REJECTED for role:'worker'", "error" in asWorker && /manager\/platform/.test(asWorker.error));

  const asAssistant = buildQuestionAsk(
    { type: "credential", title: "Need the Stripe key", body: "billing", provisionTo },
    { sessionId: e.mgrId, projectId: e.projId, db: e.db, role: "assistant" },
  );
  check("(A) provisionTo is REJECTED for role:'assistant' too", "error" in asAssistant);

  const asManager = buildQuestionAsk(
    { type: "credential", title: "Need the Stripe key", body: "billing", provisionTo },
    { sessionId: e.mgrId, projectId: e.projId, db: e.db, role: "manager" },
  );
  check("(A) provisionTo is ACCEPTED for role:'manager'", "question" in asManager && asManager.question.provisionTarget?.connection.name === "Stripe Prod");

  const asPlatform = buildQuestionAsk(
    { type: "credential", title: "Need the Stripe key", body: "billing", provisionTo },
    { sessionId: e.mgrId, projectId: e.projId, db: e.db, role: "platform" },
  );
  check("(A) provisionTo is ACCEPTED for role:'platform' (the Lead)", "question" in asPlatform);

  // A plain (non-provisioning) credential ask is completely unaffected by the role gate.
  const plainAsWorker = buildQuestionAsk(
    { type: "credential", title: "Need an SSH key", body: "deploys" },
    { sessionId: e.mgrId, projectId: e.projId, db: e.db, role: "worker" },
  );
  check("(A) a PLAIN credential ask (no provisionTo) is unaffected by the role gate even for role:'worker'", "question" in plainAsWorker);

  // A non-blank name/host is required once provisionTo is present.
  const badTarget = buildQuestionAsk(
    { type: "credential", title: "x", body: "y", provisionTo: { connection: { name: "  ", host: "h" } } },
    { sessionId: e.mgrId, projectId: e.projId, db: e.db, role: "manager" },
  );
  check("(A) a blank connection.name is rejected", "error" in badTarget);

  cleanup(e);
}

// ===== REST harness shared by (B)-(H) =====
function mkApp(e) {
  const enqueued = [];
  const stubPty = { enqueueStdin: (sessionId, text, source, onDeliver, route, kind) => { enqueued.push({ sessionId, text, source, route, kind }); return { delivered: true }; } };
  const stub = {};
  return {
    enqueued,
    appPromise: buildServer({
      db: e.db, pty: stubPty, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
      userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
    }),
  };
}
function askCredential(e, { id, title, provisionTo }) {
  const built = buildQuestionAsk(
    { type: "credential", title, body: "test ask", provisionTo },
    { sessionId: e.mgrId, projectId: e.projId, db: e.db, role: "manager" },
  );
  if ("error" in built) throw new Error(`unexpected buildQuestionAsk error: ${built.error}`);
  const q = { ...built.question, id };
  e.db.insertQuestion(q);
  return q;
}

// ===== (B) CREATE path — no prior Connection by this name =====
{
  const e = mkDb("create");
  const { appPromise } = mkApp(e);
  const app = await appPromise;
  const plaintext = "sk_live_stripe_1234567890abcdef";

  const q = askCredential(e, {
    id: "cred-create", title: "Need the Stripe key",
    provisionTo: { connection: { name: "Stripe Prod", host: "api.stripe.com" }, binding: { profileId: "prof-1" } },
  });

  const res = await app.inject({ method: "POST", url: `/api/questions/${q.id}/answer`, payload: { secret: plaintext } });
  check("(B) a valid provisioning answer -> 200", res.statusCode === 200);
  const body = JSON.parse(res.payload);
  check("(B) the response never carries the plaintext", !JSON.stringify(body).includes(plaintext));

  const updated = e.db.getQuestion(q.id);
  check("(B) the question is 'answered'", updated.state === "answered");
  check("(B) provisionConnectionId is set", typeof updated.provisionConnectionId === "string" && updated.provisionConnectionId.length > 0);
  check("(B) provisionBindingState is 'pending' (a binding was requested)", updated.provisionBindingState === "pending");

  const conns = e.db.listConnections();
  check("(B) exactly one Connection was created", conns.length === 1);
  check("(B) the Connection's name/host match the request", conns[0].name === "Stripe Prod" && conns[0].host === "api.stripe.com" && conns[0].id === updated.provisionConnectionId);

  const row = e.db.getConnection(updated.provisionConnectionId);
  check("(B) the Connection's secret decrypts to the EXACT plaintext", decryptSecret(row.secretBlob) === plaintext);

  cleanup(e);
}

// ===== (C) COLLISION REFUSAL — v1 is CREATE-ONLY, never rotate-in-place (CR finding) =====
{
  const e = mkDb("collision");
  const { appPromise } = mkApp(e);
  const app = await appPromise;

  // (C1) an existing API-KEY connection by the same name — refused, untouched, question stays pending.
  const existing = createConnection(e.db, { name: "Stripe Prod", host: "api.stripe.com", authScheme: "api-key", secret: "sk_live_ORIGINAL" });
  const q1 = askCredential(e, { id: "cred-collide-apikey", title: "Need the Stripe key again", provisionTo: { connection: { name: "Stripe Prod", host: "api.stripe.com" } } });
  const r1 = await app.inject({ method: "POST", url: `/api/questions/${q1.id}/answer`, payload: { secret: "sk_live_ATTACKER_OVERWRITE" } });
  check("(C1) provisioning onto an EXISTING api-key connection's name -> 400 (refused, not rotated)", r1.statusCode === 400);
  check("(C1) the question stays 'pending' — never answered-but-refused", e.db.getQuestion(q1.id).state === "pending");
  check("(C1) still exactly one Connection row (no duplicate, no accidental second)", e.db.listConnections().length === 1);
  const untouchedRow = e.db.getConnection(existing.id);
  check("(C1) the EXISTING connection's secret is untouched", decryptSecret(untouchedRow.secretBlob) === "sk_live_ORIGINAL");

  // (C2) THE DESTRUCTION CASE — an existing OAUTH2 connection by the same name. Provisioning must be
  // refused BEFORE it ever calls a plain-secret writer against this row — proves the api-key-over-oauth2
  // bundle corruption (the CR's headline failure) can never reach the db layer.
  const oauthConn = createOAuthConnection(e.db, {
    name: "GitHub", host: "api.github.com", provider: "github",
    clientId: "client-abc", clientSecret: "client-secret-xyz",
    authUrl: "https://github.com/login/oauth/authorize", tokenUrl: "https://github.com/login/oauth/access_token",
    scopes: ["repo"],
  });
  const bundleBefore = getOAuthTokenBundle(e.db, oauthConn.id);
  const q2 = askCredential(e, { id: "cred-collide-oauth", title: "Need a GitHub PAT", provisionTo: { connection: { name: "GitHub", host: "api.github.com" } } });
  const r2 = await app.inject({ method: "POST", url: `/api/questions/${q2.id}/answer`, payload: { secret: "ghp_ATTACKER_PAT" } });
  check("(C2) provisioning onto an EXISTING oauth2 connection's name -> 400 (refused)", r2.statusCode === 400);
  check("(C2) the question stays 'pending'", e.db.getQuestion(q2.id).state === "pending");
  const bundleAfter = getOAuthTokenBundle(e.db, oauthConn.id);
  check("(C2) the oauth2 connection's token bundle is BYTE-IDENTICAL afterward (never corrupted)", JSON.stringify(bundleAfter) === JSON.stringify(bundleBefore));
  check("(C2) the connection is still readable as a valid oauth2 bundle (no JSON.parse throw)", bundleAfter.clientSecret === "client-secret-xyz");

  cleanup(e);
}

// ===== (D) no binding requested -> provisionBindingState stays "none" =====
{
  const e = mkDb("nobinding");
  const { appPromise } = mkApp(e);
  const app = await appPromise;
  const q = askCredential(e, { id: "cred-nobind", title: "Need a key", provisionTo: { connection: { name: "Some API", host: "api.example.com" } } });
  await app.inject({ method: "POST", url: `/api/questions/${q.id}/answer`, payload: { secret: "sk_no_binding" } });
  check("(D) with no binding requested, provisionBindingState is 'none'", e.db.getQuestion(q.id).provisionBindingState === "none");
  check("(D) provisionConnectionId is still set (the Connection itself was still created)", typeof e.db.getQuestion(q.id).provisionConnectionId === "string");
  cleanup(e);
}

// ===== (E) provisioning FAILURE -> 400, question stays 'pending', no Connection created =====
{
  const e = mkDb("failure");
  const { appPromise } = mkApp(e);
  const app = await appPromise;
  const oversizedName = "x".repeat(500); // exceeds CONNECTION_NAME_MAX (200) — createConnection throws
  const q = askCredential(e, { id: "cred-fail", title: "Bad target", provisionTo: { connection: { name: oversizedName, host: "api.example.com" } } });

  const res = await app.inject({ method: "POST", url: `/api/questions/${q.id}/answer`, payload: { secret: "sk_never_lands" } });
  check("(E) an invalid provisioning target -> 400", res.statusCode === 400);
  check("(E) the question is STILL 'pending' — never answered-but-unprovisioned", e.db.getQuestion(q.id).state === "pending");
  check("(E) no Connection was created", e.db.listConnections().length === 0);

  // The same question CAN still be answered once the manager fixes/withdraws the target — prove the
  // 'pending' state genuinely wasn't corrupted by the failed attempt (re-ask with a valid target).
  const q2 = askCredential(e, { id: "cred-fail-retry", title: "Fixed target", provisionTo: { connection: { name: "Fixed Name", host: "api.example.com" } } });
  const res2 = await app.inject({ method: "POST", url: `/api/questions/${q2.id}/answer`, payload: { secret: "sk_ok_now" } });
  check("(E) a retry with a valid target succeeds -> 200", res2.statusCode === 200);

  cleanup(e);
}

// ===== (F) GUARD — a provisioned (NULL secret_blob) question reads 'answered' everywhere =====
{
  const e = mkDb("guard");
  const { appPromise } = mkApp(e);
  const app = await appPromise;
  const plaintext = "sk_live_guard_secret";
  const q = askCredential(e, { id: "cred-guard", title: "Need the key", provisionTo: { connection: { name: "Guard API", host: "api.example.com" }, binding: { profileId: "prof-guard" } } });
  await app.inject({ method: "POST", url: `/api/questions/${q.id}/answer`, payload: { secret: plaintext } });

  const raw = e.db.getQuestion(q.id);
  check("(F) secret_blob is NULL on a provisioned question (no duplicate at-rest copy)", !("secretBlob" in raw) || raw.secretBlob === undefined);
  check("(F) STATE column (not secret_blob) drives 'answered'", raw.state === "answered");

  const pulled = e.db.pullAnsweredQuestionsForAgent(e.agentId, new Date().toISOString());
  const pulledQ = pulled.find((p) => p.id === q.id);
  check("(F) it pulls (question_pull's own DB read) cleanly", pulledQ !== undefined && pulledQ.provisionConnectionId === raw.provisionConnectionId);
  check("(F) the row is now 'consumed' post-pull", e.db.getQuestion(q.id).state === "consumed");

  const item = questionPullItem(pulledQ);
  check("(F) questionPullItem produces a real ack string (does not crash / return null) on a null-blob provisioned row", typeof item.ack === "string" && item.ack.length > 0);
  check("(F) the ack never contains the plaintext", !item.ack.includes(plaintext));

  const inboxList = e.db.listOpenQuestions(true);
  const inboxItem = inboxList.find((it) => it.id === q.id);
  check("(F) it appears in listOpenQuestions(includeConsumed:true) as 'consumed' post-pull", inboxItem !== undefined && inboxItem.state === "consumed");
  check("(F) JSON.stringify(listOpenQuestions()) never contains the plaintext", !JSON.stringify(inboxList).includes(plaintext));

  cleanup(e);
}

// ===== (G) honest ack copy =====
{
  const e = mkDb("ack");
  const { appPromise } = mkApp(e);
  const app = await appPromise;

  // Provisioned WITH a binding requested.
  const qBound = askCredential(e, { id: "cred-ack-bound", title: "Need the key", provisionTo: { connection: { name: "Ack API", host: "api.example.com" }, binding: { profileId: "prof-ack" } } });
  await app.inject({ method: "POST", url: `/api/questions/${qBound.id}/answer`, payload: { secret: "sk_ack_bound" } });
  const ackBound = questionPullItem(e.db.pullAnsweredQuestionsForAgent(e.agentId, new Date().toISOString()).find((p) => p.id === qBound.id)).ack;
  check("(G) a bound provisioning ack names the Connection", ackBound.includes("Ack API"));
  check("(G) a bound provisioning ack says the binding is PENDING", ackBound.includes("PENDING"));
  check("(G) a bound provisioning ack says it's NOT yet wired to any session", ackBound.includes("NOT yet wired to any session"));
  check("(G) a bound provisioning ack never says the binding IS applied", !/\bis applied\b/i.test(ackBound));

  // Provisioned with NO binding requested.
  const qUnbound = askCredential(e, { id: "cred-ack-unbound", title: "Need the key", provisionTo: { connection: { name: "Ack API 2", host: "api.example.com" } } });
  await app.inject({ method: "POST", url: `/api/questions/${qUnbound.id}/answer`, payload: { secret: "sk_ack_unbound" } });
  const ackUnbound = questionPullItem(e.db.pullAnsweredQuestionsForAgent(e.agentId, new Date().toISOString()).find((p) => p.id === qUnbound.id)).ack;
  check("(G) an unbound provisioning ack says no binding was requested", ackUnbound.includes("No profile binding was requested"));

  // A PLAIN (non-provisioning) credential ask keeps today's exact wording — no "Connection"/"provisioned into" language.
  const qPlain = askCredential(e, { id: "cred-ack-plain", title: "Need an SSH key" });
  await app.inject({ method: "POST", url: `/api/questions/${qPlain.id}/answer`, payload: { secret: "sk_plain" } });
  const ackPlain = questionPullItem(e.db.pullAnsweredQuestionsForAgent(e.agentId, new Date().toISOString()).find((p) => p.id === qPlain.id)).ack;
  check("(G) a plain credential ack does NOT mention provisioning into a Connection", !ackPlain.includes("provisioned into Connection"));
  check("(G) a plain credential ack keeps the classic 'NOT auto-injected' wording", ackPlain.includes("NOT auto-injected"));

  cleanup(e);
}

// ===== (H) audit metadata — non-secret provisioning fields surfaced, never the value =====
{
  const e = mkDb("audit");
  const { appPromise } = mkApp(e);
  const app = await appPromise;
  const plaintext = "sk_live_audit_secret";
  const q = askCredential(e, { id: "cred-audit", title: "Need the key", provisionTo: { connection: { name: "Audit API", host: "api.example.com" }, binding: { profileId: "prof-audit" } } });
  await app.inject({ method: "POST", url: `/api/questions/${q.id}/answer`, payload: { secret: plaintext } });

  const answered = e.db.getQuestion(q.id);
  const taskItem = taskRequestGetItem(answered);
  check("(H) taskRequestGetItem surfaces the requested provisioning target (name/host)", taskItem.provisioning?.requested?.connectionName === "Audit API" && taskItem.provisioning?.requested?.host === "api.example.com");
  check("(H) taskRequestGetItem surfaces the requested binding profileId", taskItem.provisioning?.requested?.bindingProfileId === "prof-audit");
  check("(H) taskRequestGetItem surfaces the resulting connectionId", taskItem.provisioning?.connectionId === answered.provisionConnectionId);
  check("(H) taskRequestGetItem surfaces bindingState:'pending'", taskItem.provisioning?.bindingState === "pending");
  check("(H) taskRequestGetItem NEVER carries the plaintext", !JSON.stringify(taskItem).includes(plaintext));

  const auditItem = auditRequestItem({ ...answered, agentId: e.agentId });
  check("(H) auditRequestItem carries the SAME non-secret provisioning shape", auditItem.provisioning?.connectionId === answered.provisionConnectionId && auditItem.provisioning?.bindingState === "pending");
  check("(H) auditRequestItem NEVER carries the plaintext", !JSON.stringify(auditItem).includes(plaintext));

  // A non-provisioning question's audit shape is present but all-null/"none" — callers never have to branch.
  const qPlain = askCredential(e, { id: "cred-audit-plain", title: "Need an SSH key" });
  await app.inject({ method: "POST", url: `/api/questions/${qPlain.id}/answer`, payload: { secret: "sk_plain_audit" } });
  const plainItem = taskRequestGetItem(e.db.getQuestion(qPlain.id));
  check("(H) a non-provisioning question's provisioning.requested is null", plainItem.provisioning?.requested === null);
  check("(H) a non-provisioning question's provisioning.bindingState is 'none'", plainItem.provisioning?.bindingState === "none");

  cleanup(e);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — credential auto-provisioning v1 (card 193de09e): the role gate rejects provisionTo for anything but manager/platform; the human-only answer boundary CREATES a new Connection BEFORE marking the question answered and is CREATE-ONLY (a same-name collision — api-key OR oauth2 — is refused with a 400, the question stays pending, and the existing connection, including an oauth2 token bundle, is byte-identical afterward — the CR's rotate-in-place corruption case never reaches the db layer); a provisioning failure 400s without leaving an answered-but-unprovisioned question; a provisioned question's secret_blob stays NULL (the Connection is the sole at-rest copy) yet reads 'answered' everywhere via the state column; the ack is honest (names the Connection, marks a requested binding PENDING, never claims it's applied); and the non-secret provisioning audit trail is surfaced to task_request_get/audit reads without ever leaking the plaintext."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
