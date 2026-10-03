import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 82b22817 — hermetic (no real spawn) coverage for the credential->sessionEnv delivery mechanism:
//   (A) Db.listCredentialSessionEnvSources scopes correctly — only answered/consumed 'credential' rows
//       with a declared credentialEnvVar and NO provisionTarget, only for the requested project, oldest-
//       answered-first; a pending row, a provisioned row, and another project's row are all excluded.
//   (B) resolveCredentialSessionEnv decrypts correctly, is fail-closed per row (a corrupt blob is skipped,
//       never thrown, and never blocks a sibling row's delivery), and a rotated env-var name (asked twice)
//       resolves to the MOST RECENT answer.
// The real-spawn proof that this reaches an actual OS child process env lives in
// test/credential-sessionenv-spawn.mjs — this file only proves the DB read + decrypt-merge logic.
//
// Run: 1) build (turbo builds shared first), 2) node test/credential-session-env.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-credential-session-env-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildQuestionAsk } = await import("../dist/mcp/questionTool.js");
const { encryptSecret } = await import("../dist/keys/envelope.js");
const { resolveCredentialSessionEnv } = await import("../dist/keys/credentialSessionEnv.js");

const dbFile = path.join(tmpHome, "cse.db");
const db = new Db(dbFile);
const now = new Date().toISOString();

function mkProject(id) {
  db.insertProject({ id, name: id, repoPath: id, vaultPath: id, config: {}, createdAt: now, archivedAt: null });
  const agentId = `${id}-agent`, mgrId = `${id}-mgr`;
  db.insertAgent({ id: agentId, projectId: id, name: "t", startupPrompt: "", position: 0 });
  db.insertSession({
    id: mgrId, projectId: id, agentId, engineSessionId: `eng-${id}`, title: null, cwd: id,
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role: "manager",
  });
  return { projectId: id, agentId, mgrId };
}

function askAndAnswer(proj, { id, envVar, secret, provisionTo, answeredAt }) {
  const built = buildQuestionAsk(
    { type: "credential", title: "t", body: "b", envVar, provisionTo },
    { sessionId: proj.mgrId, projectId: proj.projectId, db, role: "manager" },
  );
  if ("error" in built) throw new Error(`unexpected buildQuestionAsk error: ${built.error}`);
  const q = { ...built.question, id };
  db.insertQuestion(q);
  // A fake connectionId is sufficient here — answerCredentialQuestion just stores it; this file never
  // exercises the Connections domain (see credential-provisioning.mjs for that).
  const provision = provisionTo ? { connectionId: `conn-${id}`, bindingState: "none" } : undefined;
  db.answerCredentialQuestion(id, {
    secretBlob: provisionTo ? null : encryptSecret(secret),
    answeredAt: answeredAt ?? new Date().toISOString(),
    provision,
  });
}

// ===== (A) listCredentialSessionEnvSources scoping =====
{
  const proj = mkProject("cse-scope");
  const other = mkProject("cse-scope-other");

  askAndAnswer(proj, { id: "cse-a1", envVar: "SCOPE_VAR", secret: "sk-scope-1", answeredAt: "2026-01-01T00:00:00.000Z" });

  // A PENDING (unanswered) credential ask never reaches this list.
  const pendingBuilt = buildQuestionAsk(
    { type: "credential", title: "t", body: "b", envVar: "PENDING_VAR" },
    { sessionId: proj.mgrId, projectId: proj.projectId, db, role: "manager" },
  );
  db.insertQuestion({ ...pendingBuilt.question, id: "cse-pending" });

  // A PROVISIONED row (provisionTo set) must be excluded — its secret lives in a Connection instead,
  // gated by its own deliberate profile-binding grant (Direction B); this path must never bypass that.
  askAndAnswer(proj, { id: "cse-provisioned", envVar: "PROVISIONED_VAR", secret: "sk-should-not-appear", provisionTo: { connection: { name: "Some Conn", host: "example.com" } } });

  // ANOTHER PROJECT's row, even with the same env-var name, must never leak across projects.
  askAndAnswer(other, { id: "cse-other-proj", envVar: "SCOPE_VAR", secret: "sk-other-project" });

  const rows = db.listCredentialSessionEnvSources(proj.projectId);
  const byVar = Object.fromEntries(rows.map((r) => [r.credentialEnvVar, r]));

  check("(A) the answered plain row IS included", "SCOPE_VAR" in byVar);
  check("(A) the pending row is excluded", !("PENDING_VAR" in byVar));
  check("(A) the provisioned row is excluded", !("PROVISIONED_VAR" in byVar));
  check("(A) exactly one row for this project", rows.length === 1);
}

// ===== (B) resolveCredentialSessionEnv: decrypt + fail-closed + rotation =====
{
  const proj = mkProject("cse-resolve");

  askAndAnswer(proj, { id: "cse-b1", envVar: "GOOD_VAR", secret: "the-real-secret-value", answeredAt: "2026-01-01T00:00:00.000Z" });

  // A rotated credential: the SAME env-var name asked and answered a second time, later. The most
  // RECENT answer must win.
  askAndAnswer(proj, { id: "cse-b2-old", envVar: "ROTATED_VAR", secret: "old-value", answeredAt: "2026-01-01T00:00:00.000Z" });
  askAndAnswer(proj, { id: "cse-b2-new", envVar: "ROTATED_VAR", secret: "new-value", answeredAt: "2026-02-01T00:00:00.000Z" });

  // A corrupt row — hand-corrupt the stored ciphertext directly (the only way to produce this state; the
  // real answer boundary always writes a well-formed envelope). This proves fail-closed: it must not
  // throw and must not block GOOD_VAR/ROTATED_VAR from resolving. Card af08f7e8: delivery now reads from
  // the DECOUPLED delivered_credentials table (see db.ts's own doc), not questions directly, so the
  // corruption must target THAT row — corrupting questions.secret_blob alone would no longer reach the
  // resolver at all, since it never reads that column post-answer.
  askAndAnswer(proj, { id: "cse-b3-corrupt", envVar: "CORRUPT_VAR", secret: "irrelevant", answeredAt: "2026-01-15T00:00:00.000Z" });
  db.db.prepare("UPDATE delivered_credentials SET secret_blob = 'not-a-real-envelope' WHERE source_question_id = 'cse-b3-corrupt'").run();

  let resolved;
  let threw = false;
  try {
    resolved = resolveCredentialSessionEnv(db, proj.projectId);
  } catch {
    threw = true;
  }

  check("(B) resolveCredentialSessionEnv never throws even with a corrupt row present", !threw);
  check("(B) a plain credential decrypts to the exact original value", resolved?.GOOD_VAR === "the-real-secret-value");
  check("(B) a rotated env-var name resolves to the MOST RECENT answer", resolved?.ROTATED_VAR === "new-value");
  check("(B) a corrupt row is DROPPED, not merged as garbage", !("CORRUPT_VAR" in (resolved ?? {})));
  check("(B) the corrupt row's failure never blocked its siblings from resolving", resolved?.GOOD_VAR !== undefined && resolved?.ROTATED_VAR !== undefined);
}

// ===== (C) resolve-time backstop for a reserved/invalid env-var name — code-review fix 1 =====
// buildQuestionAsk now REJECTS a reserved name at ask time (see credential-provisioning.mjs's (A2)), but
// a row written BEFORE that check existed (or by any future second writer) must still be caught here —
// the resolver is the structural guarantee, ask-time validation is the cheap early rejection on top of it.
{
  const proj = mkProject("cse-backstop");

  // Simulate a pre-existing/legacy row: insertQuestion + answerCredentialQuestion bypass buildQuestionAsk
  // entirely, exactly like a row that predates this validation would look in a real DB.
  const now2 = new Date().toISOString();
  db.insertQuestion({
    id: "cse-c1-path", sessionId: proj.mgrId, filedBySessionId: proj.mgrId, projectId: proj.projectId,
    type: "credential", title: "t", body: "b", options: null, recommendation: null, taskId: null,
    permissionAction: null, permissionScopeHint: null, permissionExpiresAt: null,
    decidedScope: null, decidedExpiresAt: null,
    credentialEnvVar: "PATH", credentialByteLength: null, provisionTarget: null, fulfillmentTarget: null,
    provisionConnectionId: null, provisionBindingState: "none",
    state: "pending", chosenOption: null, note: null, createdAt: now2, answeredAt: null, consumedAt: null,
    cancelledReason: null, cancelledBy: null, cancelledAt: null, escalatedAt: null, acknowledgedUntil: null,
  });
  db.answerCredentialQuestion("cse-c1-path", { secretBlob: encryptSecret("/bin/evil"), answeredAt: now2 });

  // A legitimate, well-formed credential in the SAME project, so the test proves the reserved row is
  // dropped WITHOUT taking its sibling down with it.
  askAndAnswer(proj, { id: "cse-c2-good", envVar: "SAFE_VAR", secret: "safe-value", answeredAt: now2 });

  // Card f44cc187, item 4: the backstop above only ever exercised ONE exact-match, uppercase name (PATH).
  // Seed two more legacy rows in LOWERCASE, one hitting the ANTHROPIC_ PREFIX class and one hitting the
  // HTTP_PROXY EXACT class (both added by the prior card, 08f2c7ce) — proving the lowercase-normalization
  // + prefix-match paths are ALSO covered by this backstop, not just the uppercase-exact case.
  function seedLegacyReserved(id, envVar, secret) {
    db.insertQuestion({
      id, sessionId: proj.mgrId, filedBySessionId: proj.mgrId, projectId: proj.projectId,
      type: "credential", title: "t", body: "b", options: null, recommendation: null, taskId: null,
      permissionAction: null, permissionScopeHint: null, permissionExpiresAt: null,
      decidedScope: null, decidedExpiresAt: null,
      credentialEnvVar: envVar, credentialByteLength: null, provisionTarget: null, fulfillmentTarget: null,
      provisionConnectionId: null, provisionBindingState: "none",
      state: "pending", chosenOption: null, note: null, createdAt: now2, answeredAt: null, consumedAt: null,
      cancelledReason: null, cancelledBy: null, cancelledAt: null, escalatedAt: null, acknowledgedUntil: null,
    });
    db.answerCredentialQuestion(id, { secretBlob: encryptSecret(secret), answeredAt: now2 });
  }
  seedLegacyReserved("cse-c3-anthropic-lower", "anthropic_api_key", "sk-ant-should-not-appear");
  seedLegacyReserved("cse-c4-httpproxy-lower", "http_proxy", "http://evil:8080");
  // card 0ab1593a — same backstop proof for the newly-widened CODEX_ prefix and one of the new exact
  // names, confirming the resolve-time backstop catches these too, not just the ask-time rejection
  // credential-provisioning.mjs already covers.
  seedLegacyReserved("cse-c5-codex-lower", "codex_api_key", "sk-codex-should-not-appear");
  seedLegacyReserved("cse-c6-pathext", "PATHEXT", ".EXE;.COM;.EVIL");

  const resolvedBackstop = resolveCredentialSessionEnv(db, proj.projectId);
  check("(C) a legacy row with a reserved env-var name (PATH) is NEVER surfaced by the resolver", !("PATH" in resolvedBackstop));
  check("(C) its sibling, well-formed credential still resolves", resolvedBackstop.SAFE_VAR === "safe-value");
  check("(C) a lowercase legacy row hitting the ANTHROPIC_ prefix (anthropic_api_key) is dropped", !("anthropic_api_key" in resolvedBackstop) && !("ANTHROPIC_API_KEY" in resolvedBackstop));
  check("(C) a lowercase legacy row hitting the HTTP_PROXY exact name (http_proxy) is dropped", !("http_proxy" in resolvedBackstop) && !("HTTP_PROXY" in resolvedBackstop));
  check("(C) a lowercase legacy row hitting the CODEX_ prefix (codex_api_key) is dropped", !("codex_api_key" in resolvedBackstop) && !("CODEX_API_KEY" in resolvedBackstop));
  check("(C) a legacy row hitting the PATHEXT exact name is dropped", !("PATHEXT" in resolvedBackstop));
}

// ===== (D) card f44cc187 item 2: the owner-visible undeliverable signal =====
{
  const proj = mkProject("cse-undeliverable");
  const now3 = new Date().toISOString();

  // A normal, well-formed credential: must read deliverable:true, reason:null — unaffected by this card.
  askAndAnswer(proj, { id: "cse-d1-good", envVar: "GOOD_SIGNAL_VAR", secret: "fine", answeredAt: now3 });

  // A legacy row carrying a NOW-reserved name (same shape as section (C)'s seeding — bypasses
  // buildQuestionAsk's ask-time rejection to simulate a row answered BEFORE the deny-list widened).
  db.insertQuestion({
    id: "cse-d2-bad", sessionId: proj.mgrId, filedBySessionId: proj.mgrId, projectId: proj.projectId,
    type: "credential", title: "t", body: "b", options: null, recommendation: null, taskId: null,
    permissionAction: null, permissionScopeHint: null, permissionExpiresAt: null,
    decidedScope: null, decidedExpiresAt: null,
    credentialEnvVar: "SYSTEMROOT", credentialByteLength: null, provisionTarget: null, fulfillmentTarget: null,
    provisionConnectionId: null, provisionBindingState: "none",
    state: "pending", chosenOption: null, note: null, createdAt: now3, answeredAt: null, consumedAt: null,
    cancelledReason: null, cancelledBy: null, cancelledAt: null, escalatedAt: null, acknowledgedUntil: null,
  });
  db.answerCredentialQuestion("cse-d2-bad", { secretBlob: encryptSecret("C:\\Windows-evil"), answeredAt: now3 });

  const goodRowId = db.db.prepare("SELECT id FROM delivered_credentials WHERE source_question_id = ?").get("cse-d1-good").id;
  const badRowId = db.db.prepare("SELECT id FROM delivered_credentials WHERE source_question_id = ?").get("cse-d2-bad").id;

  // (D1) deliverable/reason are computed LIVE from the stored name — correct even BEFORE any spawn ever
  // resolves this project's env (i.e. before resolveCredentialSessionEnv has run at all for this project).
  const goodSummaryPre = db.getDeliveredCredential(goodRowId);
  const badSummaryPre = db.getDeliveredCredential(badRowId);
  check("(D1) a normal row reads deliverable:true BEFORE any resolve", goodSummaryPre.deliverable === true);
  check("(D1) a normal row reads reason:null BEFORE any resolve", goodSummaryPre.reason === null);
  check("(D1) a reserved-name row reads deliverable:false BEFORE any resolve", badSummaryPre.deliverable === false);
  check("(D1) a reserved-name row reads reason:\"reserved-name\" BEFORE any resolve", badSummaryPre.reason === "reserved-name");
  const listed = db.listDeliveredCredentials(proj.projectId);
  const goodListed = listed.find((r) => r.id === goodRowId);
  const badListed = listed.find((r) => r.id === badRowId);
  check("(D1) listDeliveredCredentials agrees: good row deliverable:true", goodListed?.deliverable === true);
  check("(D1) listDeliveredCredentials agrees: bad row deliverable:false, reason:\"reserved-name\"", badListed?.deliverable === false && badListed?.reason === "reserved-name");

  // (D1b) Code Review follow-up (card f44cc187, round 3): `effective` must AND in `deliverable` — a
  // reserved-name row is the SOLE live row for its env var (so it "wins" among siblings by construction)
  // but must still read effective:false, since nothing actually delivers it. Before this fix, `effective`
  // was computed purely from "wins among live siblings," so this would have read true — the REST summary
  // would have said a reserved row was the one currently delivering.
  check("(D1b) a normal row reads effective:true BEFORE any resolve", goodSummaryPre.effective === true);
  check("(D1b) a reserved-name row (sole live row for its env var) reads effective:false, not true just because it has no sibling to lose to", badSummaryPre.effective === false);
  check("(D1b) listDeliveredCredentials agrees: good row effective:true", goodListed?.effective === true);
  check("(D1b) listDeliveredCredentials agrees: bad row effective:false", badListed?.effective === false);

  // (D2) markCredentialUndeliverableNotified is a GENERIC dedupe primitive — it has no opinion on whether
  // a row is actually reserved (that's resolveCredentialSessionEnv's job, which only ever calls it for a
  // row it already found invalid — proven separately in (D3) below). So it returns true the FIRST call for
  // ANY row whose undeliverable_notified_at is still NULL — bad or good — and false every call after.
  check("(D2) markCredentialUndeliverableNotified returns true the first time for the bad row", db.markCredentialUndeliverableNotified(badRowId) === true);
  check("(D2) markCredentialUndeliverableNotified returns false the second time for the SAME row", db.markCredentialUndeliverableNotified(badRowId) === false);
  check("(D2) markCredentialUndeliverableNotified returns true the first time for ANY untouched row, good or bad (it does not itself judge reservedness)", db.markCredentialUndeliverableNotified(goodRowId) === true);
  check("(D2) a missing row id is a no-op false, never throws", db.markCredentialUndeliverableNotified("no-such-row") === false);

  // (D3) the durable event fires EXACTLY ONCE across TWO resolver calls — proving the dedupe actually
  // dedupes, not merely that it fires at all (the negative control: a THIRD call must still not add a second).
  function eventCountFor(deliveredCredentialId) {
    return db.db.prepare(
      "SELECT COUNT(*) AS n FROM orchestration_events WHERE kind = 'credential_undeliverable' AND json_extract(detail_json, '$.deliveredCredentialId') = ?",
    ).get(deliveredCredentialId).n;
  }
  // badRowId already has undeliverable_notified_at set from (D2) above — reset it to NULL so this section
  // proves the event-filing path fresh, independent of (D2)'s own direct markCredentialUndeliverableNotified calls.
  db.db.prepare("UPDATE delivered_credentials SET undeliverable_notified_at = NULL WHERE id = ?").run(badRowId);
  check("(D3) no credential_undeliverable event exists yet for the bad row", eventCountFor(badRowId) === 0);
  resolveCredentialSessionEnv(db, proj.projectId);
  check("(D3) exactly one credential_undeliverable event after the FIRST resolve", eventCountFor(badRowId) === 1);
  resolveCredentialSessionEnv(db, proj.projectId);
  resolveCredentialSessionEnv(db, proj.projectId);
  check("(D3) STILL exactly one credential_undeliverable event after TWO MORE resolves (deduped, not re-fired)", eventCountFor(badRowId) === 1);
  check("(D3) a normal row never gets a credential_undeliverable event", eventCountFor(goodRowId) === 0);
  const firedEvent = db.db.prepare("SELECT detail_json FROM orchestration_events WHERE kind = 'credential_undeliverable' AND json_extract(detail_json, '$.deliveredCredentialId') = ?").get(badRowId);
  const firedDetail = JSON.parse(firedEvent.detail_json);
  check("(D3) the fired event's detail carries the real projectId", firedDetail.projectId === proj.projectId);
  check("(D3) the fired event's detail carries the real credentialEnvVar", firedDetail.credentialEnvVar === "SYSTEMROOT");
  check("(D3) the fired event's detail carries reason:\"reserved-name\"", firedDetail.reason === "reserved-name");

  // (D4) Code Review follow-up (card f44cc187, round 3): mark-then-append used to be two separate calls
  // outside any transaction — if appendEvent ever threw, the row would be left permanently marked with NO
  // audit event, and the once-per-row gate would then never let a later resolve retry either half. Proves
  // the fix: a thrown appendEvent must roll the mark back too (row stays unmarked), the reserved row must
  // still be DROPPED regardless (that happens unconditionally, before this try/catch), its sibling must
  // still be DELIVERED, and a later resolve (once the fault clears) must retry BOTH halves successfully.
  db.insertQuestion({
    id: "cse-d4-bad-txn", sessionId: proj.mgrId, filedBySessionId: proj.mgrId, projectId: proj.projectId,
    type: "credential", title: "t", body: "b", options: null, recommendation: null, taskId: null,
    permissionAction: null, permissionScopeHint: null, permissionExpiresAt: null,
    decidedScope: null, decidedExpiresAt: null,
    credentialEnvVar: "LOCALAPPDATA", credentialByteLength: null, provisionTarget: null, fulfillmentTarget: null,
    provisionConnectionId: null, provisionBindingState: "none",
    state: "pending", chosenOption: null, note: null, createdAt: now3, answeredAt: null, consumedAt: null,
    cancelledReason: null, cancelledBy: null, cancelledAt: null, escalatedAt: null, acknowledgedUntil: null,
  });
  db.answerCredentialQuestion("cse-d4-bad-txn", { secretBlob: encryptSecret("C:\\evil"), answeredAt: now3 });
  const txnBadRowId = db.db.prepare("SELECT id FROM delivered_credentials WHERE source_question_id = ?").get("cse-d4-bad-txn").id;

  const originalAppendEvent = db.appendEvent.bind(db);
  db.appendEvent = () => { throw new Error("(D4) simulated appendEvent fault"); };
  let d4Resolved;
  let d4Threw = false;
  try {
    d4Resolved = resolveCredentialSessionEnv(db, proj.projectId);
  } catch {
    d4Threw = true;
  }
  check("(D4) resolveCredentialSessionEnv never throws even when appendEvent itself throws", !d4Threw);
  check("(D4) the reserved row is still DROPPED despite the audit fault", !("LOCALAPPDATA" in (d4Resolved ?? {})));
  check("(D4) its sibling, well-formed credential STILL resolves despite the audit fault", d4Resolved?.GOOD_SIGNAL_VAR === "fine");
  check("(D4) the row stays UNMARKED — the transaction rolled the mark back along with the failed append",
    db.db.prepare("SELECT undeliverable_notified_at FROM delivered_credentials WHERE id = ?").get(txnBadRowId).undeliverable_notified_at === null);
  check("(D4) no credential_undeliverable event was recorded for this row (the append that would have written it threw)", eventCountFor(txnBadRowId) === 0);

  db.appendEvent = originalAppendEvent;
  resolveCredentialSessionEnv(db, proj.projectId);
  check("(D4) once the fault clears, a later resolve retries BOTH halves: the row is now marked",
    db.db.prepare("SELECT undeliverable_notified_at FROM delivered_credentials WHERE id = ?").get(txnBadRowId).undeliverable_notified_at !== null);
  check("(D4) ...and the audit event now fires exactly once", eventCountFor(txnBadRowId) === 1);
}

try { db.close(); } catch { /* ignore */ }
for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — Db.listCredentialSessionEnvSources scopes strictly to answered/consumed, un-provisioned, project-owned credential rows, resolveCredentialSessionEnv decrypts them into a flat env map that is fail-closed per row (a corrupt blob is dropped, never thrown, never blocking a sibling) and resolves a rotated env-var name to its most recent answer, the resolve-time backstop drops a reserved legacy row regardless of case or exact-vs-prefix match, and the card f44cc187 undeliverable signal (deliverable/reason fields + the once-per-row credential_undeliverable audit event) is correct and deduped."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
