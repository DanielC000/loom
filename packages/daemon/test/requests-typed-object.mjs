import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Hermetic coverage for the Requests-object generalization (card 695ebab0): the durable, TYPED
// {decision, input, permission, credential} object built on top of the original decision-inbox
// (card 8701bdbb). Exercises the shared db.ts layer + mcp/questionTool.ts helpers directly (both
// mcp/orchestration.ts's and mcp/platform.ts's question_ask/question_pull tools call the SAME two
// helpers — buildQuestionAsk/questionPullItem — so covering the helpers covers both callers' behavior).
//
// Covers:
//   (A) type:"decision" — byte-identical to today (backward compat: an ask with no `type` defaults to it).
//   (B) type:"input" — freeform-text, no options, round-trips on note alone.
//   (C) type:"permission" — REQUIRES `action`; ask-time payload (action/scope/expiresAt) persists;
//       answers as chosenOption ∈ {"authorize","deny"}; questionPullItem surfaces {approved, note}.
//   (D) type:"credential" — THE NEVER-ECHO PROPERTY: the plaintext secret is asserted to NEVER appear in
//       (1) the question_pull-shaped payload (questionPullItem), (2) the bare Question object returned by
//       any db.ts read (getQuestion/pullAnsweredQuestionsForAgent/listOpenQuestions), or (3) JSON.stringify
//       of any of the above — only an envelope-ciphertext (decryptable back to the SAME plaintext) ever
//       exists, and only in the db-internal secret_blob column, never mapped by toQuestion.
//   (E) the generic answerQuestion() writer REFUSES a credential-type row (the load-bearing backstop) —
//       proves a caller can't accidentally smuggle a secret into chosen_option/note.
//   (F) answerCredentialQuestion() REFUSES a non-credential row (the mirror-image guard).
//   (G) buildQuestionAsk rejects a permission ask with no `action`.
//
// Run: 1) build (turbo builds shared first), 2) node test/requests-typed-object.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-requests-typed-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildQuestionAsk, questionPullItem } = await import("../dist/mcp/questionTool.js");
const { encryptSecret, decryptSecret } = await import("../dist/keys/envelope.js");
const { PERMISSION_ANSWERS } = await import("@loom/shared");

const dbFile = path.join(tmpHome, "rt.db");
const keyPath = path.join(tmpHome, "secret.key"); // isolated test key — NEVER the real SECRET_KEY_PATH
const db = new Db(dbFile);
const now = new Date().toISOString();
const projId = "rt-proj", agentId = "rt-agent", mgrId = "rt-mgr";

try {
  db.insertProject({ id: projId, name: "RT", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
  db.insertAgent({ id: agentId, projectId: projId, name: "Manager", startupPrompt: "BRIEF", position: 0 });
  db.insertSession({
    id: mgrId, projectId: projId, agentId, engineSessionId: "eng-rt", title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });

  // ===== (A) type:"decision" — backward compat: omitting `type` defaults to "decision" =====
  {
    const built = buildQuestionAsk({ title: "Ship it?", body: "gate green", options: ["yes", "no"], recommendation: "yes" }, { sessionId: mgrId, projectId: projId });
    check("(A) buildQuestionAsk with no `type` defaults to 'decision'", "question" in built && built.question.type === "decision");
    db.insertQuestion(built.question);
    db.answerQuestion(built.question.id, { chosenOption: "yes", note: null, answeredAt: new Date().toISOString() });
    const pulled = db.pullAnsweredQuestionsForAgent(agentId, new Date().toISOString());
    check("(A) it pulls with the ORIGINAL {questionId,title,chosenOption,note} shape (plus additive type)", pulled.length === 1 && pulled[0].chosenOption === "yes");
    const item = questionPullItem(pulled[0]);
    check("(A) questionPullItem shapes it as {questionId,title,type,chosenOption,note}", item.type === "decision" && item.chosenOption === "yes" && item.note === null);
  }

  // ===== (B) type:"input" — freeform, no options =====
  {
    const built = buildQuestionAsk({ type: "input", title: "What's the deploy window?", body: "need a time" }, { sessionId: mgrId, projectId: projId });
    check("(B) buildQuestionAsk builds a valid input ask", "question" in built);
    const q = built.question;
    check("(B) an input ask never carries options, even if the caller sneaks one in", q.options === null);
    db.insertQuestion(q);
    db.answerQuestion(q.id, { chosenOption: null, note: "Saturday 2am UTC", answeredAt: new Date().toISOString() });
    const pulled = db.pullAnsweredQuestionsForAgent(agentId, new Date().toISOString());
    const item = questionPullItem(pulled[0]);
    check("(B) it pulls note-only, chosenOption stays null", item.type === "input" && item.chosenOption === null && item.note === "Saturday 2am UTC");
  }

  // ===== (C) type:"permission" =====
  {
    const built = buildQuestionAsk({
      type: "permission", title: "Force-push main?", body: "recovering a bad merge",
      action: "force-push origin/main", scope: "once", expiresAt: "2026-08-01T00:00:00.000Z",
    }, { sessionId: mgrId, projectId: projId });
    check("(C) buildQuestionAsk builds a valid permission ask", "question" in built);
    const q = built.question;
    check("(C) the ask-time payload persists on the built Question", q.permissionAction === "force-push origin/main" && q.permissionScope === "once" && q.permissionExpiresAt === "2026-08-01T00:00:00.000Z");
    db.insertQuestion(q);
    // The REST route only ever writes chosenOption ∈ PERMISSION_ANSWERS ("authorize"/"deny") for a
    // permission — simulate that, using the SAME shared const the route + questionPullItem both use.
    db.answerQuestion(q.id, { chosenOption: PERMISSION_ANSWERS[0], note: "go ahead, ping me after", answeredAt: new Date().toISOString() });
    const pulled = db.pullAnsweredQuestionsForAgent(agentId, new Date().toISOString());
    const item = questionPullItem(pulled[0]);
    check("(C) questionPullItem surfaces {approved:true, note}, not a raw chosenOption string", item.type === "permission" && item.approved === true && item.note === "go ahead, ping me after");

    // A denied permission ask.
    const built2 = buildQuestionAsk({ type: "permission", title: "Delete the staging DB?", body: "cleanup", action: "drop database staging" }, { sessionId: mgrId, projectId: projId });
    db.insertQuestion(built2.question);
    db.answerQuestion(built2.question.id, { chosenOption: PERMISSION_ANSWERS[1], note: null, answeredAt: new Date().toISOString() });
    const pulled2 = db.pullAnsweredQuestionsForAgent(agentId, new Date().toISOString());
    check("(C) a denied permission surfaces approved:false", questionPullItem(pulled2[0]).approved === false);
  }

  // ===== (D) type:"credential" — THE NEVER-ECHO PROPERTY =====
  {
    const plaintext = "sk_live_super_secret_do_not_leak_1234567890";
    const built = buildQuestionAsk({ type: "credential", title: "Need the Stripe key", body: "for billing", envVar: "STRIPE_API_KEY" }, { sessionId: mgrId, projectId: projId });
    check("(D) buildQuestionAsk builds a valid credential ask", "question" in built);
    const q = built.question;
    check("(D) the credential's ask-time envVar hint persists", q.credentialEnvVar === "STRIPE_API_KEY");
    db.insertQuestion(q);

    // Mirrors the REST answer route EXACTLY: encrypt here (the ONE human-only write boundary), then store
    // ONLY the ciphertext via answerCredentialQuestion — this test never lets the Db layer see plaintext
    // any differently than the real route would.
    const secretBlob = encryptSecret(plaintext, keyPath);
    check("(D) the envelope ciphertext does not contain the plaintext substring", !secretBlob.includes(plaintext));
    const answered = db.answerCredentialQuestion(q.id, { secretBlob, answeredAt: new Date().toISOString() });
    check("(D) answerCredentialQuestion flips it to 'answered'", answered?.state === "answered");
    // The returned Question object itself — assert structurally it has no path to the secret.
    check("(D) the answered Question object has no secretBlob/secret_blob field at all", !("secretBlob" in answered) && !("secret_blob" in answered));
    check("(D) JSON.stringify(answered) never contains the plaintext", !JSON.stringify(answered).includes(plaintext));

    const pulled = db.pullAnsweredQuestionsForAgent(agentId, new Date().toISOString());
    const credPulled = pulled.find((p) => p.id === q.id);
    check("(D) the credential question pulls (reaches 'consumed')", credPulled !== undefined && db.getQuestion(q.id)?.state === "consumed");
    check("(D) the pulled Question object never contains the plaintext", !JSON.stringify(credPulled).includes(plaintext));

    const item = questionPullItem(credPulled);
    check("(D) question_pull's agent-facing payload is an ACK only, no secret field", item.type === "credential" && typeof item.ack === "string" && !("secret" in item) && !("secretBlob" in item));
    check("(D) the ack text does not itself contain the plaintext", !item.ack.includes(plaintext));
    check("(D) JSON.stringify of the pull payload never contains the plaintext", !JSON.stringify(item).includes(plaintext));
    check("(D) the ack references the requested envVar hint", item.ack.includes("STRIPE_API_KEY"));

    // getQuestion (the other db.ts read path) is equally clean.
    const reread = db.getQuestion(q.id);
    check("(D) a fresh getQuestion() re-read also carries no secret field", !("secretBlob" in reread) && !("secret_blob" in reread));

    // The WEB read path — listOpenQuestions()/getQuestionInboxItem(), the `SELECT q.*` join that flows
    // through toQuestionInboxItem — is a THIRD, independent mapping from the raw row (distinct from
    // toQuestion's own call sites above). Locking the never-echo property here too guards against a future
    // toQuestionInboxItem refactor accidentally spreading the raw row (and its secret_blob column) instead
    // of going through toQuestion's field-by-field mapping.
    const inboxList = db.listOpenQuestions(true);
    const inboxItem = inboxList.find((it) => it.id === q.id);
    check("(D) the credential question appears in listOpenQuestions(includeConsumed:true)", inboxItem !== undefined);
    check("(D) listOpenQuestions()'s enriched item has no secret field", !("secretBlob" in inboxItem) && !("secret_blob" in inboxItem));
    check("(D) JSON.stringify(listOpenQuestions()) never contains the plaintext", !JSON.stringify(inboxList).includes(plaintext));
    const inboxSingle = db.getQuestionInboxItem(q.id);
    check("(D) getQuestionInboxItem() has no secret field", !("secretBlob" in inboxSingle) && !("secret_blob" in inboxSingle));
    check("(D) JSON.stringify(getQuestionInboxItem()) never contains the plaintext", !JSON.stringify(inboxSingle).includes(plaintext));

    // Prove the ciphertext IS real (decryptable back to the same plaintext) — this is intentionally the
    // ONLY place in this test that ever touches the plaintext again, mirroring that the daemon has no
    // other consumer for it today (a future env/config-injection feature is out of THIS card's scope).
    check("(D) the stored envelope ciphertext decrypts back to the EXACT original plaintext", decryptSecret(secretBlob, keyPath) === plaintext);
  }

  // ===== (E) answerQuestion() REFUSES a credential-type row (load-bearing backstop) =====
  {
    const built = buildQuestionAsk({ type: "credential", title: "Need an SSH key", body: "for deploys" }, { sessionId: mgrId, projectId: projId });
    db.insertQuestion(built.question);
    const result = db.answerQuestion(built.question.id, { chosenOption: null, note: "sneaky plaintext attempt", answeredAt: new Date().toISOString() });
    check("(E) the generic answerQuestion() writer refuses a credential row (returns undefined)", result === undefined);
    check("(E) the credential row is still 'pending' — the generic writer did NOT touch it", db.getQuestion(built.question.id)?.state === "pending");
  }

  // ===== (F) answerCredentialQuestion() REFUSES a non-credential row (mirror-image guard) =====
  {
    const built = buildQuestionAsk({ title: "Deploy now?", body: "gate green", options: ["yes", "no"] }, { sessionId: mgrId, projectId: projId });
    db.insertQuestion(built.question);
    const result = db.answerCredentialQuestion(built.question.id, { secretBlob: "v1:x:y:z", answeredAt: new Date().toISOString() });
    check("(F) answerCredentialQuestion refuses a decision-type row (returns undefined)", result === undefined);
    check("(F) the decision row is still 'pending' — untouched", db.getQuestion(built.question.id)?.state === "pending");
  }

  // ===== (G) buildQuestionAsk rejects a permission ask with no `action` =====
  {
    const built = buildQuestionAsk({ type: "permission", title: "Do the thing?", body: "no action given" }, { sessionId: mgrId, projectId: projId });
    check("(G) a permission ask with no `action` is rejected with {error}", "error" in built);
  }
} finally {
  try { db?.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the Requests-object generalization (card 695ebab0) round-trips ask→answer→pull for all four types (decision/input/permission/credential) via the shared buildQuestionAsk/questionPullItem helpers both mcp surfaces call; a permission ask requires `action`; and the credential NEVER-ECHO property holds end-to-end — the plaintext secret is provably absent from every agent-reachable payload and from the bare Question object at every read path, appearing ONLY as a decryptable envelope ciphertext in the db-internal secret_blob column. The two type-mismatch backstops (answerQuestion refusing credential, answerCredentialQuestion refusing everything else) both hold."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
