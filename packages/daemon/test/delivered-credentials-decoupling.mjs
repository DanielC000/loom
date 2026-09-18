import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card af08f7e8 — the CORE claim this card exists to prove: deleting the asking SESSION or AGENT no longer
// destroys a delivered credential's audit trail, because delivered_credentials has no FK tie to either.
// Before this card, deleteSession/deleteAgent hard-deleted every `questions` row for that session/agent in
// ANY state — including an answered credential's secret_blob and full history — as a side effect of an
// ordinary Archive-tab delete, with zero warning. This is the "accidental, destructive path" the triage
// note on this card identified; this file is the negative proof that it no longer exists for delivery.
//
// Covers:
//   (A) deleteSession removes the `questions` row (unchanged, existing behavior — the decision-inbox ask
//       itself is still cleaned up) but the delivered_credentials row SURVIVES, unrevoked, still delivering.
//   (B) deleteAgent (which cascades its sessions) has the SAME property.
//   (C) [negative control / contrast] deletePROJECT — which genuinely removes the project itself — DOES
//       cascade delivered_credentials (project_id is a NOT NULL FK; leaving it behind would abort the
//       whole transaction with a foreign-key violation, not silently orphan it).
//
// Run: 1) build (turbo builds shared first), 2) node test/delivered-credentials-decoupling.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-delivered-credentials-decoupling-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildQuestionAsk } = await import("../dist/mcp/questionTool.js");
const { encryptSecret } = await import("../dist/keys/envelope.js");

const dbFile = path.join(tmpHome, "decoupling.db");
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

function askAndAnswer(proj, { id, envVar, secret }) {
  const built = buildQuestionAsk(
    { type: "credential", title: "t", body: "b", envVar },
    { sessionId: proj.mgrId, projectId: proj.projectId, db, role: "manager" },
  );
  if ("error" in built) throw new Error(`unexpected buildQuestionAsk error: ${built.error}`);
  const q = { ...built.question, id };
  db.insertQuestion(q);
  db.answerCredentialQuestion(id, { secretBlob: encryptSecret(secret), answeredAt: new Date().toISOString() });
}

// ===== (A) deleteSession never touches delivered_credentials =====
{
  const proj = mkProject("dcpl-session");
  askAndAnswer(proj, { id: "dcpl-a-q1", envVar: "A_VAR", secret: "sk-a" });

  const beforeQuestion = db.getQuestion("dcpl-a-q1");
  const beforeDelivered = db.listDeliveredCredentials(proj.projectId);
  // Code Review finding: the earlier version of this check compared ROW IDS (`toDeliveredCredentialSummary`
  // never carries the ciphertext by design, so comparing ids proves row-identity continuity, NOT ciphertext
  // integrity — its own label overclaimed). The ACTUAL ciphertext lives only in
  // listCredentialSessionEnvSources's `secretBlob` field; compare that instead to make the label true.
  const beforeSecretBlob = db.listCredentialSessionEnvSources(proj.projectId).find((s) => s.credentialEnvVar === "A_VAR")?.secretBlob;
  check("(A) setup: the question exists before delete", beforeQuestion !== undefined);
  check("(A) setup: exactly one delivered_credentials row exists before delete", beforeDelivered.length === 1);
  check("(A) setup: the real delivery read path has a ciphertext for A_VAR before delete", typeof beforeSecretBlob === "string" && beforeSecretBlob.length > 0);

  db.deleteSession(proj.mgrId);

  check("(A) the questions row IS gone after deleteSession (existing, unchanged decision-inbox cleanup)", db.getQuestion("dcpl-a-q1") === undefined);
  const afterDelivered = db.listDeliveredCredentials(proj.projectId);
  check("(A) the delivered_credentials row SURVIVES deleteSession — same count", afterDelivered.length === 1);
  check("(A) it's still UNREVOKED (still delivering) after the session that asked for it is gone", afterDelivered[0]?.revokedAt === null);
  check("(A) it's the SAME row (row-identity continuity, not a re-created one)", afterDelivered[0]?.id === beforeDelivered[0]?.id);
  const afterSecretBlob = db.listCredentialSessionEnvSources(proj.projectId).find((s) => s.credentialEnvVar === "A_VAR")?.secretBlob;
  check("(A) its ciphertext is untouched, byte-for-byte, after the session that asked for it is gone", afterSecretBlob === beforeSecretBlob);
}

// ===== (B) deleteAgent (cascades its sessions) has the same property =====
{
  const proj = mkProject("dcpl-agent");
  askAndAnswer(proj, { id: "dcpl-b-q1", envVar: "B_VAR", secret: "sk-b" });

  check("(B) setup: exactly one delivered_credentials row exists before delete", db.listDeliveredCredentials(proj.projectId).length === 1);

  db.deleteAgent(proj.agentId);

  check("(B) the questions row IS gone after deleteAgent", db.getQuestion("dcpl-b-q1") === undefined);
  const afterDelivered = db.listDeliveredCredentials(proj.projectId);
  check("(B) the delivered_credentials row SURVIVES deleteAgent — same count", afterDelivered.length === 1);
  check("(B) it's still UNREVOKED after the agent that asked for it is gone", afterDelivered[0]?.revokedAt === null);
}

// ===== (C) [contrast] deleteProject DOES cascade delivered_credentials, and doesn't throw doing it =====
{
  const proj = mkProject("dcpl-project");
  askAndAnswer(proj, { id: "dcpl-c-q1", envVar: "C_VAR", secret: "sk-c" });
  check("(C) setup: exactly one delivered_credentials row exists before delete", db.listDeliveredCredentials(proj.projectId).length === 1);

  let threw = false;
  try { db.deleteProject(proj.projectId); } catch { threw = true; }
  check("(C) deleteProject does not throw an FK-violation with a delivered_credentials row present", !threw);
  check("(C) deleteProject DOES cascade the delivered_credentials row (the project itself is gone)", db.listDeliveredCredentials(proj.projectId).length === 0);
}

try { db.close(); } catch { /* ignore */ }
for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — deleteSession/deleteAgent no longer touch delivered_credentials at all (the decoupling this card exists to ship): the asking session/agent's own questions row is cleaned up as before, but the delivered credential survives, unrevoked, still delivering. deleteProject (which genuinely removes the project) correctly cascades it without an FK violation."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
