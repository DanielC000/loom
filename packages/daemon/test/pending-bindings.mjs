import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Credential auto-provisioning v1 — the BINDING UX read surface (card 12dc7fc9, "Direction B"). The
// pending-binding data model landed in card 193de09e (a credential answer stores the secret + creates a
// Connection + records a PENDING profile→connection binding, never auto-applied). This card adds the
// human-only read the Settings "Pending bindings" queue + Connections page consume:
//   GET /api/pending-bindings   → every answered/consumed credential Question whose binding is 'pending',
//                                 enriched with connection name/host, requested profile name, asking agent,
//                                 project name, and whether the connection is ALREADY on the allowlist.
//   GET /api/connections        → now folds an `autoProvisioned` flag onto each ConnectionMetadata.
//
// Covers:
//   (A) a provisioned ask WITH a binding surfaces exactly one pending-binding row, correctly enriched.
//   (B) GET /api/connections marks the auto-provisioned connection true, a hand-created one false.
//   (C) the GRANT boundary reconciles a pending binding to 'applied' so it LEAVES the queue: a PUT that
//       adds the connection to the profile's allowlist flips provision_binding_state 'pending'->'applied'
//       and the binding no longer appears in listPendingBindings (the queue clears). 'applied' is terminal
//       (removing the connection later never reverts it). Grant done purely through the existing human-only
//       profile-edit path (no new write surface).
//   (D) a provisioning ask with NO binding never appears in the queue (but IS auto-provisioned).
//   (E) the binding stays in the queue after the answer is CONSUMED (the queue is state-independent —
//       it keys off provision_binding_state='pending', NOT the open-question filter).
//   (F) profile/agent fallbacks — a since-deleted profile degrades to its id, not a throw.
//
// Run: 1) build (turbo builds shared first), 2) node test/pending-bindings.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-pending-bindings-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildQuestionAsk } = await import("../dist/mcp/questionTool.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { createConnection } = await import("../dist/connections/store.js");

function mkDb(name) {
  const dbFile = path.join(tmpHome, `${name}.db`);
  const db = new Db(dbFile);
  const now = new Date().toISOString();
  const projId = `${name}-proj`, agentId = `${name}-agent`, mgrId = `${name}-mgr`, profId = `${name}-prof`;
  db.insertProject({ id: projId, name: "PB Project", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "Billing Manager", startupPrompt: "", position: 0 });
  db.insertSession({
    id: mgrId, projectId: projId, agentId, engineSessionId: "eng-mgr", title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
  db.insertProfile({ id: profId, name: "Payments Worker", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, connections: [], capabilities: [] });
  return { dbFile, db, projId, agentId, mgrId, profId };
}
function cleanup(e) {
  try { e.db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(e.dbFile + ext, { force: true }); } catch { /* ignore */ } }
}
function mkApp(e) {
  const stubPty = { enqueueStdin: () => ({ delivered: true }) };
  const stub = {};
  return buildServer({
    db: e.db, pty: stubPty, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub,
    userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub,
  });
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
async function answer(app, id, secret) {
  return app.inject({ method: "POST", url: `/api/questions/${id}/answer`, payload: { secret } });
}
async function pendingBindings(app) {
  const res = await app.inject({ method: "GET", url: "/api/pending-bindings" });
  return { status: res.statusCode, rows: JSON.parse(res.payload) };
}
async function connections(app) {
  const res = await app.inject({ method: "GET", url: "/api/connections" });
  return JSON.parse(res.payload);
}

// ===== (A) a provisioned ask WITH a binding surfaces one enriched pending-binding row =====
{
  const e = mkDb("enrich");
  const app = await mkApp(e);
  const q = askCredential(e, {
    id: "cred-a", title: "Need the Stripe key",
    provisionTo: { connection: { name: "Stripe Prod", host: "api.stripe.com" }, binding: { profileId: e.profId } },
  });
  const ans = await answer(app, q.id, "sk_live_secret_A");
  check("(A) provisioning answer -> 200", ans.statusCode === 200);

  const { status, rows } = await pendingBindings(app);
  check("(A) GET /api/pending-bindings -> 200", status === 200);
  check("(A) exactly one pending binding", rows.length === 1);
  const b = rows[0] ?? {};
  const connId = e.db.getQuestion(q.id).provisionConnectionId;
  check("(A) questionId matches", b.questionId === q.id);
  check("(A) connectionId matches the provisioned connection", b.connectionId === connId);
  check("(A) connectionName resolved from the live row", b.connectionName === "Stripe Prod");
  check("(A) connectionHost resolved", b.connectionHost === "api.stripe.com");
  check("(A) profileId is the requested profile", b.profileId === e.profId);
  check("(A) profileName resolved from the profile store", b.profileName === "Payments Worker");
  check("(A) agentName is the asking agent", b.agentName === "Billing Manager");
  check("(A) projectName resolved", b.projectName === "PB Project");
  check("(A) alreadyGranted is false (nothing on the allowlist yet)", b.alreadyGranted === false);
  check("(A) requestedAt is set (the answer moment)", typeof b.requestedAt === "string" && b.requestedAt.length > 0);
  check("(A) the row NEVER carries the plaintext secret", !JSON.stringify(rows).includes("sk_live_secret_A"));
  cleanup(e);
}

// ===== (B) GET /api/connections folds autoProvisioned onto the metadata =====
{
  const e = mkDb("autoflag");
  const app = await mkApp(e);
  // A hand-created connection — must read autoProvisioned:false.
  const manual = createConnection(e.db, { name: "Manual Key", host: "api.manual.com", authScheme: "api-key", secret: "sk_manual" });
  const q = askCredential(e, {
    id: "cred-b", title: "Need an API key",
    provisionTo: { connection: { name: "Provisioned Key", host: "api.prov.com" }, binding: { profileId: e.profId } },
  });
  await answer(app, q.id, "sk_prov");
  const provId = e.db.getQuestion(q.id).provisionConnectionId;

  const conns = await connections(app);
  const manualRow = conns.find((c) => c.id === manual.id);
  const provRow = conns.find((c) => c.id === provId);
  check("(B) the hand-created connection reads autoProvisioned:false", manualRow && manualRow.autoProvisioned === false);
  check("(B) the auto-provisioned connection reads autoProvisioned:true", provRow && provRow.autoProvisioned === true);
  cleanup(e);
}

// ===== (C) the grant boundary reconciles pending->applied so the binding LEAVES the queue =====
{
  const e = mkDb("grant");
  const app = await mkApp(e);
  const q = askCredential(e, {
    id: "cred-c", title: "Need a token",
    provisionTo: { connection: { name: "Grant Me", host: "api.grant.com" }, binding: { profileId: e.profId } },
  });
  await answer(app, q.id, "sk_grant");
  const connId = e.db.getQuestion(q.id).provisionConnectionId;

  check("(C) present in the queue before the grant", (await pendingBindings(app)).rows.length === 1);
  check("(C) binding state is 'pending' before the grant", e.db.getQuestion(q.id).provisionBindingState === "pending");

  // The grant is the EXISTING human-only profile-edit REST (add the connection to the allowlist) — NOT a
  // new write surface, and NOT a side effect of answering. Direction B: binding is a deliberate owner Save.
  const put = await app.inject({ method: "PUT", url: `/api/profiles/${e.profId}`, payload: { connections: [connId] } });
  check("(C) granting via PUT /api/profiles/:id -> 200", put.statusCode === 200);
  check("(C) the connection is now on the profile's allowlist", (e.db.getProfile(e.profId).connections ?? []).includes(connId));

  check("(C) the binding transitioned 'pending'->'applied' at the grant boundary", e.db.getQuestion(q.id).provisionBindingState === "applied");
  check("(C) the binding LEFT the queue (listPendingBindings clears)", (await pendingBindings(app)).rows.length === 0);

  // 'applied' is terminal — removing the connection again does NOT revert it back to the queue.
  await app.inject({ method: "PUT", url: `/api/profiles/${e.profId}`, payload: { connections: [] } });
  check("(C) removing the connection is a separate action — the binding stays 'applied', never re-pends", e.db.getQuestion(q.id).provisionBindingState === "applied" && (await pendingBindings(app)).rows.length === 0);

  // A DIFFERENT profile saving the same connection must NOT flip a binding that targeted THIS profile —
  // markBindingsApplied confirms the profileId inside provision_target, not just the connection id.
  cleanup(e);
}

// ===== (C2) the reconcile matches the binding's OWN profileId, not just the connection id =====
{
  const e = mkDb("grant-otherprof");
  const app = await mkApp(e);
  // A second profile that will (wrongly, if the guard were missing) try to claim the same connection.
  e.db.insertProfile({ id: `${e.projId}-prof2`, name: "Other Worker", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null, connections: [], capabilities: [] });
  const q = askCredential(e, {
    id: "cred-c2", title: "Need a token",
    provisionTo: { connection: { name: "Shared Conn", host: "api.shared.com" }, binding: { profileId: e.profId } },
  });
  await answer(app, q.id, "sk_shared");
  const connId = e.db.getQuestion(q.id).provisionConnectionId;

  // The OTHER profile allowlists the connection — the binding targets `e.profId`, so it must stay pending.
  await app.inject({ method: "PUT", url: `/api/profiles/${e.projId}-prof2`, payload: { connections: [connId] } });
  check("(C2) a DIFFERENT profile granting the same connection does NOT apply this binding", e.db.getQuestion(q.id).provisionBindingState === "pending");
  check("(C2) the binding is still in the queue", (await pendingBindings(app)).rows.length === 1);

  // The correct profile grants it — now it applies.
  await app.inject({ method: "PUT", url: `/api/profiles/${e.profId}`, payload: { connections: [connId] } });
  check("(C2) the binding's OWN profile granting it applies it", e.db.getQuestion(q.id).provisionBindingState === "applied");
  cleanup(e);
}

// ===== (D) a provisioning ask with NO binding never appears (but IS auto-provisioned) =====
{
  const e = mkDb("nobinding");
  const app = await mkApp(e);
  const q = askCredential(e, { id: "cred-d", title: "No binding", provisionTo: { connection: { name: "Solo Conn", host: "api.solo.com" } } });
  await answer(app, q.id, "sk_solo");
  const { rows } = await pendingBindings(app);
  check("(D) a no-binding provisioning ask produces NO pending binding", rows.length === 0);
  const provId = e.db.getQuestion(q.id).provisionConnectionId;
  const conns = await connections(app);
  check("(D) but the connection IS still marked auto-provisioned", conns.find((c) => c.id === provId)?.autoProvisioned === true);
  cleanup(e);
}

// ===== (E) the binding stays in the queue after the answer is CONSUMED =====
{
  const e = mkDb("consumed");
  const app = await mkApp(e);
  const q = askCredential(e, {
    id: "cred-e", title: "Consume me",
    provisionTo: { connection: { name: "Persist Conn", host: "api.persist.com" }, binding: { profileId: e.profId } },
  });
  await answer(app, q.id, "sk_persist");
  check("(E) present while answered", (await pendingBindings(app)).rows.length === 1);
  // The asking agent pulls (consumes) the answer — the question flips answered->consumed.
  const pulled = e.db.pullAnsweredQuestionsForAgent(e.agentId, new Date().toISOString());
  check("(E) the answer was consumed", pulled.length === 1 && e.db.getQuestion(q.id).state === "consumed");
  const after = await pendingBindings(app);
  check("(E) the binding STILL appears after consume (queue is state-independent)", after.rows.length === 1 && after.rows[0].questionId === q.id);
  cleanup(e);
}

// ===== (F) a since-deleted profile degrades to its id, never a throw =====
{
  const e = mkDb("ghostprof");
  const app = await mkApp(e);
  const q = askCredential(e, {
    id: "cred-f", title: "Ghost profile",
    provisionTo: { connection: { name: "Ghost Conn", host: "api.ghost.com" }, binding: { profileId: "does-not-exist" } },
  });
  await answer(app, q.id, "sk_ghost");
  const { status, rows } = await pendingBindings(app);
  check("(F) endpoint still 200 with a dangling profileId", status === 200);
  check("(F) profileName falls back to the raw id", rows.length === 1 && rows[0].profileName === "does-not-exist");
  check("(F) alreadyGranted is false for a missing profile", rows[0].alreadyGranted === false);
  cleanup(e);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
process.exit(failures === 0 ? 0 : 1);
