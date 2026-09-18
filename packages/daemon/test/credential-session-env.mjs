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
  // throw and must not block GOOD_VAR/ROTATED_VAR from resolving.
  askAndAnswer(proj, { id: "cse-b3-corrupt", envVar: "CORRUPT_VAR", secret: "irrelevant", answeredAt: "2026-01-15T00:00:00.000Z" });
  db.db.prepare("UPDATE questions SET secret_blob = 'not-a-real-envelope' WHERE id = 'cse-b3-corrupt'").run();

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

  const resolvedBackstop = resolveCredentialSessionEnv(db, proj.projectId);
  check("(C) a legacy row with a reserved env-var name (PATH) is NEVER surfaced by the resolver", !("PATH" in resolvedBackstop));
  check("(C) its sibling, well-formed credential still resolves", resolvedBackstop.SAFE_VAR === "safe-value");
}

try { db.close(); } catch { /* ignore */ }
for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — Db.listCredentialSessionEnvSources scopes strictly to answered/consumed, un-provisioned, project-owned credential rows, and resolveCredentialSessionEnv decrypts them into a flat env map that is fail-closed per row (a corrupt blob is dropped, never thrown, never blocking a sibling) and resolves a rotated env-var name to its most recent answer."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
