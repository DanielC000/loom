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
//       answers as chosenOption ∈ {"authorize","deny"}; questionPullItem surfaces {approved, note}, plus
//       (fix(mcp): persist and surface permission scope/expiry) the human's ANSWER-time decidedScope/
//       decidedExpiresAt — distinct from the ask-time hint — as {scope, expiresAt, lapsed}: a future
//       expiry surfaces lapsed:false, a past expiry surfaces lapsed:true, and a row with no decided grant
//       at all (pre-this-card / a "deny") surfaces {scope:null, expiresAt:null, lapsed:false} — never a
//       crash, never a false lapsed. questionAnswerByType (task_request_get/audit's shared shaper)
//       surfaces the identical fields for the non-consuming read path.
//   (C2) card 3880f783 — grant-fulfilment observation: an OPTIONAL ask-time `fulfillmentTarget`
//       ({profileId, key, expectedValue?}) drives a read-time `fulfillment: {state, detail}` on every
//       permission entry (questionPullItem AND questionAnswerByType), computed FRESH on every call, never
//       cached on the row. Four DISJOINT states: "unknown" (no target declared — the default, and every
//       (C) case above), "not_yet_done" (declared + checked, live value doesn't match — a MEASURED false),
//       "fulfilled" (matches — both via the generic presence check and an explicit expectedValue), and
//       "unwritable" (a bad profile key, or a profileId that no longer resolves — `detail` says which,
//       never confused with "not_yet_done"). Also proves fulfillmentTarget is silently dropped on a
//       non-"permission" type, and that it's checkable even on a still-`pending` (unanswered) request.
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
import { cleanupPathSync } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-requests-typed-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildQuestionAsk, questionPullItem, questionAnswerByType } = await import("../dist/mcp/questionTool.js");
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
    const item = questionPullItem(pulled[0], db);
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
    const item = questionPullItem(pulled[0], db);
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
    check("(C) the ask-time payload persists on the built Question", q.permissionAction === "force-push origin/main" && q.permissionScopeHint === "once" && q.permissionExpiresAt === "2026-08-01T00:00:00.000Z");
    check("(C) decidedScope/decidedExpiresAt are null at ask time — an ANSWER-time payload only", q.decidedScope === null && q.decidedExpiresAt === null);
    db.insertQuestion(q);
    // The REST route only ever writes chosenOption ∈ PERMISSION_ANSWERS ("authorize"/"deny") for a
    // permission — simulate an "authorize, standing, expires in the future" answer exactly as the gateway
    // route now composes it (fix(mcp): persist and surface permission scope/expiry — the human's ACTUAL
    // decided grant, distinct from the ask-time scope/expiresAt hint above).
    const futureExpiry = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    db.answerQuestion(q.id, {
      chosenOption: PERMISSION_ANSWERS[0], note: "go ahead, ping me after", answeredAt: new Date().toISOString(),
      decidedScope: "standing", decidedExpiresAt: futureExpiry,
    });
    const pulled = db.pullAnsweredQuestionsForAgent(agentId, new Date().toISOString());
    const item = questionPullItem(pulled[0], db);
    check("(C) questionPullItem surfaces {approved:true, note}, not a raw chosenOption string", item.type === "permission" && item.approved === true && item.note === "go ahead, ping me after");
    check("(C) questionPullItem surfaces the human's ACTUAL decided scope, not the ask-time hint", item.scope === "standing");
    check("(C) questionPullItem surfaces the decided expiresAt verbatim", item.expiresAt === futureExpiry);
    check("(C) a FUTURE expiry surfaces lapsed:false", item.lapsed === false);
    check("(C) a permission with no declared fulfillmentTarget surfaces fulfillment:{state:\"unknown\"}", item.fulfillment?.state === "unknown" && item.fulfillment?.detail === null);
    // task_request_get's non-consuming shaper (questionAnswerByType) must surface the identical grant.
    const reread = db.getQuestion(q.id);
    const answerShape = questionAnswerByType(reread, db);
    check("(C) questionAnswerByType (task_request_get's shaper) surfaces the same {scope, expiresAt, lapsed}", answerShape.scope === "standing" && answerShape.expiresAt === futureExpiry && answerShape.lapsed === false);

    // A denied permission ask — nothing was granted, so decidedScope/decidedExpiresAt must stay null.
    const built2 = buildQuestionAsk({ type: "permission", title: "Delete the staging DB?", body: "cleanup", action: "drop database staging" }, { sessionId: mgrId, projectId: projId });
    db.insertQuestion(built2.question);
    db.answerQuestion(built2.question.id, { chosenOption: PERMISSION_ANSWERS[1], note: null, answeredAt: new Date().toISOString() });
    const pulled2 = db.pullAnsweredQuestionsForAgent(agentId, new Date().toISOString());
    const deniedItem = questionPullItem(pulled2[0], db);
    check("(C) a denied permission surfaces approved:false", deniedItem.approved === false);
    check("(C) a denied permission has no grant to surface — {scope:null, expiresAt:null, lapsed:false}", deniedItem.scope === null && deniedItem.expiresAt === null && deniedItem.lapsed === false);

    // A PAST expiry (a standing grant that has since lapsed) surfaces lapsed:true.
    const built3 = buildQuestionAsk({ type: "permission", title: "Rotate the deploy key?", body: "quarterly rotation", action: "rotate deploy key" }, { sessionId: mgrId, projectId: projId });
    db.insertQuestion(built3.question);
    const pastExpiry = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    db.answerQuestion(built3.question.id, {
      chosenOption: PERMISSION_ANSWERS[0], note: null, answeredAt: new Date().toISOString(),
      decidedScope: "standing", decidedExpiresAt: pastExpiry,
    });
    const pulled3 = db.pullAnsweredQuestionsForAgent(agentId, new Date().toISOString());
    const lapsedItem = questionPullItem(pulled3[0], db);
    check("(C) a PAST expiry surfaces lapsed:true — advisory only, nothing is auto-revoked", lapsedItem.approved === true && lapsedItem.lapsed === true);

    // An OLD-FORMAT row (fix(mcp): NULL-safety guardrail) — an authorize answered exactly as pre-this-card
    // code would (never passing decidedScope/decidedExpiresAt at all): must surface cleanly, never crash,
    // and never mislabel the missing grant record as lapsed.
    const built4 = buildQuestionAsk({ type: "permission", title: "Restart the worker?", body: "legacy answer path", action: "restart worker" }, { sessionId: mgrId, projectId: projId });
    db.insertQuestion(built4.question);
    db.answerQuestion(built4.question.id, { chosenOption: PERMISSION_ANSWERS[0], note: null, answeredAt: new Date().toISOString() });
    const pulled4 = db.pullAnsweredQuestionsForAgent(agentId, new Date().toISOString());
    const legacyItem = questionPullItem(pulled4[0], db);
    check("(C) a legacy (pre-card) authorized row with no decided grant surfaces {scope:null, expiresAt:null, lapsed:false}, never lapsed:true", legacyItem.approved === true && legacyItem.scope === null && legacyItem.expiresAt === null && legacyItem.lapsed === false);
  }

  // ===== (C2) card 3880f783 — fulfillmentTarget / computeFulfillment: the four disjoint states =====
  {
    db.insertProfile({ id: "fulfillProf", name: "FulfillTest", role: "worker", description: "", allowDelta: [], skills: null, model: null, icon: null });

    // "not_yet_done" — a real profile field, no expectedValue (generic presence check), currently absent.
    const builtPending = buildQuestionAsk({
      type: "permission", title: "Switch FulfillTest to codex?", body: "multi-harness pilot", action: "set harness to codex",
      fulfillmentTarget: { profileId: "fulfillProf", key: "harness" },
    }, { sessionId: mgrId, projectId: projId });
    check("(C2) buildQuestionAsk persists the declared fulfillmentTarget", builtPending.question.fulfillmentTarget?.profileId === "fulfillProf" && builtPending.question.fulfillmentTarget?.key === "harness");
    db.insertQuestion(builtPending.question);
    db.answerQuestion(builtPending.question.id, { chosenOption: PERMISSION_ANSWERS[0], note: null, answeredAt: new Date().toISOString() });
    const notYetDoneItem = questionPullItem(db.getQuestion(builtPending.question.id), db);
    check("(C2) a declared target not yet set on the live profile reads not_yet_done, never unknown", notYetDoneItem.fulfillment?.state === "not_yet_done" && notYetDoneItem.fulfillment?.detail === null);

    // "fulfilled" — the SAME row, recomputed AFTER the human write actually lands (never cached).
    db.updateProfile("fulfillProf", { harness: "codex" });
    const fulfilledItem = questionPullItem(db.getQuestion(builtPending.question.id), db);
    check("(C2) the SAME row flips to fulfilled once the live profile value matches, with NO row write of its own", fulfilledItem.fulfillment?.state === "fulfilled" && fulfilledItem.fulfillment?.detail === null);

    // "fulfilled" via an explicit expectedValue that does NOT match a bare-presence read (a boolean field
    // set to a non-default value that presence alone wouldn't distinguish from "on").
    const builtExpected = buildQuestionAsk({
      type: "permission", title: "Confirm FulfillTest vaultWrite is off?", body: "compliance check", action: "leave vaultWrite disabled",
      fulfillmentTarget: { profileId: "fulfillProf", key: "vaultWrite", expectedValue: false },
    }, { sessionId: mgrId, projectId: projId });
    db.insertQuestion(builtExpected.question);
    db.answerQuestion(builtExpected.question.id, { chosenOption: PERMISSION_ANSWERS[0], note: null, answeredAt: new Date().toISOString() });
    const expectedFalseItem = questionPullItem(db.getQuestion(builtExpected.question.id), db);
    check("(C2) an expectedValue:false target is fulfilled against the (default-false) live value, not misread via the generic presence check", expectedFalseItem.fulfillment?.state === "fulfilled");

    // "unwritable" — key is not a real Profile field (a typo), never mistaken for not_yet_done.
    const builtBadKey = buildQuestionAsk({
      type: "permission", title: "Set a bogus field?", body: "typo'd key", action: "set nonexistentField",
      fulfillmentTarget: { profileId: "fulfillProf", key: "nonexistentField" },
    }, { sessionId: mgrId, projectId: projId });
    db.insertQuestion(builtBadKey.question);
    db.answerQuestion(builtBadKey.question.id, { chosenOption: PERMISSION_ANSWERS[0], note: null, answeredAt: new Date().toISOString() });
    const badKeyItem = questionPullItem(db.getQuestion(builtBadKey.question.id), db);
    check("(C2) an unrecognized profile key reads unwritable, with a detail naming the key", badKeyItem.fulfillment?.state === "unwritable" && badKeyItem.fulfillment?.detail?.includes("nonexistentField"));

    // "unwritable" — profileId no longer resolves to an existing profile (deleted after the ask was filed).
    const builtDeadProfile = buildQuestionAsk({
      type: "permission", title: "Grant harness on a soon-deleted profile?", body: "will be deleted", action: "set harness",
      fulfillmentTarget: { profileId: "willBeDeleted", key: "harness" },
    }, { sessionId: mgrId, projectId: projId });
    db.insertQuestion(builtDeadProfile.question);
    db.answerQuestion(builtDeadProfile.question.id, { chosenOption: PERMISSION_ANSWERS[0], note: null, answeredAt: new Date().toISOString() });
    const deadProfileItem = questionPullItem(db.getQuestion(builtDeadProfile.question.id), db);
    check("(C2) a target naming a nonexistent profileId reads unwritable, with a detail naming the profile id", deadProfileItem.fulfillment?.state === "unwritable" && deadProfileItem.fulfillment?.detail?.includes("willBeDeleted"));

    // fulfillmentTarget is PERMISSION-ONLY — silently dropped on every other type, same convention as
    // options/recommendation/provisionTo.
    const builtWrongType = buildQuestionAsk({
      type: "decision", title: "Not a permission ask", body: "sneaking in a target", options: ["a", "b"],
      fulfillmentTarget: { profileId: "fulfillProf", key: "harness" },
    }, { sessionId: mgrId, projectId: projId });
    check("(C2) fulfillmentTarget is silently dropped on a non-permission type", builtWrongType.question.fulfillmentTarget === null);

    // task_request_get's non-consuming shaper (questionAnswerByType) surfaces the identical fulfillment,
    // reachable even BEFORE the request is answered (a declared target is observable pre-answer too).
    const builtUnanswered = buildQuestionAsk({
      type: "permission", title: "Still-pending fulfillment check", body: "not answered yet", action: "set harness",
      fulfillmentTarget: { profileId: "fulfillProf", key: "harness", expectedValue: "claude" },
    }, { sessionId: mgrId, projectId: projId });
    db.insertQuestion(builtUnanswered.question);
    const unansweredShape = questionAnswerByType(db.getQuestion(builtUnanswered.question.id), db);
    check("(C2) a still-pending permission's declared target is still checkable — fulfillment is independent of `approved`", unansweredShape.approved === null && unansweredShape.fulfillment?.state === "not_yet_done");
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

    const item = questionPullItem(credPulled, db);
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
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the Requests-object generalization (card 695ebab0) round-trips ask→answer→pull for all four types (decision/input/permission/credential) via the shared buildQuestionAsk/questionPullItem helpers both mcp surfaces call; a permission ask requires `action`; and the credential NEVER-ECHO property holds end-to-end — the plaintext secret is provably absent from every agent-reachable payload and from the bare Question object at every read path, appearing ONLY as a decryptable envelope ciphertext in the db-internal secret_blob column. The two type-mismatch backstops (answerQuestion refusing credential, answerCredentialQuestion refusing everything else) both hold. fix(mcp): persist and surface permission scope/expiry — a permission's ANSWER-time decidedScope/decidedExpiresAt (distinct from the ask-time hint) persists on the row and surfaces as {scope, expiresAt, lapsed} via both questionPullItem and questionAnswerByType; lapsed is read-time-derived (future→false, past→true) and a legacy/no-grant row (denied, or answered before this card) surfaces {null,null,false} cleanly, never a crash or a false lapsed."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
