import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Code Review BLOCKER (post-af08f7e8) — hermetic DB-level coverage for the rotation fix, complementing the
// REAL-spawn proof in test/credential-sessionenv-spawn.mjs's section (E) (that one proves the end-to-end
// spawn behavior; this one pins the exact DB CONTRACT: `effective`/`shadowedBy` on DeliveredCredentialSummary,
// and revokeDeliveredCredential's bulk-by-env-var semantics).
//
// THE BUG: rotation (the same credentialEnvVar answered twice — a designed, validated flow) leaves two live
// rows. Before this fix, revoking only the ONE row a human clicked left its sibling live — in the worst
// real case (rotating because the old key leaked), the next spawn re-injected the LEAKED key, with nothing
// in the list surface warning it could happen.
//
// Covers:
//   (A) a single answered credential is `effective:true`, `shadowedBy:null`.
//   (B) rotation (same env var, two answers): the OLDER row is `effective:false, shadowedBy:<newer id>`;
//       the NEWER row is `effective:true, shadowedBy:null`. Both `revokedAt:null`.
//   (C) revoking via the OLDER (shadowed) row's id ALSO revokes the NEWER (effective) sibling — the env var
//       is the revocation unit, not the row. Both end up `revokedAt` non-null, `effective:false`.
//   (D) [negative control] revoking one env var never touches a DIFFERENT env var's live row, even in the
//       same project.
//   (E) [negative control] revoking a row already revoked (a genuine double-click on the SAME id) throws,
//       naming the row's real state, mirroring cancelQuestion's own discipline.
//   (F) a revoked row is always `effective:false, shadowedBy:null` — a revoked row is excluded from
//       delivery on its own; nothing "shadows" a row that was never going to deliver anyway.
//
// Run: 1) build (turbo builds shared first), 2) node test/delivered-credentials-rotation.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-delivered-credentials-rotation-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildQuestionAsk } = await import("../dist/mcp/questionTool.js");
const { encryptSecret } = await import("../dist/keys/envelope.js");

const dbFile = path.join(tmpHome, "rotation.db");
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

function askAndAnswer(proj, { id, envVar, secret, answeredAt }) {
  const built = buildQuestionAsk(
    { type: "credential", title: "t", body: "b", envVar },
    { sessionId: proj.mgrId, projectId: proj.projectId, db, role: "manager" },
  );
  if ("error" in built) throw new Error(`unexpected buildQuestionAsk error: ${built.error}`);
  db.insertQuestion({ ...built.question, id });
  db.answerCredentialQuestion(id, { secretBlob: encryptSecret(secret), answeredAt: answeredAt ?? new Date().toISOString() });
}

// ===== (A) a single answered credential is effective, unshadowed =====
{
  const proj = mkProject("rot-single");
  askAndAnswer(proj, { id: "rot-a-q1", envVar: "SINGLE_VAR", secret: "sk-single" });
  const rows = db.listDeliveredCredentials(proj.projectId);
  check("(A) exactly one row", rows.length === 1);
  check("(A) it's effective", rows[0]?.effective === true);
  check("(A) it's not shadowed", rows[0]?.shadowedBy === null);
  check("(A) getDeliveredCredential agrees", db.getDeliveredCredential(rows[0].id)?.effective === true);
}

// ===== (B) rotation: older shadowed, newer effective =====
let rotProj, olderId, newerId;
{
  rotProj = mkProject("rot-two");
  askAndAnswer(rotProj, { id: "rot-b-old", envVar: "ROT_VAR", secret: "sk-old", answeredAt: "2026-01-01T00:00:00.000Z" });
  askAndAnswer(rotProj, { id: "rot-b-new", envVar: "ROT_VAR", secret: "sk-new", answeredAt: "2026-02-01T00:00:00.000Z" });
  const rows = db.listDeliveredCredentials(rotProj.projectId);
  const older = rows.find((r) => r.sourceQuestionId === "rot-b-old");
  const newer = rows.find((r) => r.sourceQuestionId === "rot-b-new");
  olderId = older?.id; newerId = newer?.id;
  check("(B) both rows are still unrevoked", older?.revokedAt === null && newer?.revokedAt === null);
  check("(B) the OLDER row is shadowed (not effective)", older?.effective === false);
  check("(B) the OLDER row names the NEWER row as its shadowedBy", older?.shadowedBy === newerId);
  check("(B) the NEWER row is effective", newer?.effective === true);
  check("(B) the NEWER row has no shadowedBy", newer?.shadowedBy === null);
  check("(B) getDeliveredCredential agrees for the older row", db.getDeliveredCredential(olderId)?.shadowedBy === newerId);
}

// ===== (C) revoking via the OLDER (shadowed) row's id revokes its NEWER (effective) sibling too =====
{
  const revoked = db.revokeDeliveredCredential(olderId, { revokedBy: "human", revokedReason: "rotation test" });
  check("(C) both siblings come back in the revoke result", revoked?.length === 2);
  check("(C) the returned ids are exactly {older, newer}", new Set(revoked.map((r) => r.id)).size === 2
    && revoked.some((r) => r.id === olderId) && revoked.some((r) => r.id === newerId));
  for (const r of revoked) {
    check(`(C) row ${r.id === olderId ? "(older)" : "(newer)"} is now revoked`, r.revokedAt !== null);
    check(`(C) row ${r.id === olderId ? "(older)" : "(newer)"} is no longer effective`, r.effective === false);
  }
  const afterOlder = db.getDeliveredCredential(olderId);
  const afterNewer = db.getDeliveredCredential(newerId);
  check("(C) re-reading the OLDER row shows it revoked", afterOlder?.revokedAt !== null);
  check("(C) re-reading the NEWER row shows it ALSO revoked (the actual fix)", afterNewer?.revokedAt !== null);
}

// ===== (D) [negative control] a DIFFERENT env var in the SAME project is untouched by that revoke =====
{
  askAndAnswer(rotProj, { id: "rot-d-q1", envVar: "UNRELATED_VAR", secret: "sk-unrelated" });
  const unrelated = db.listDeliveredCredentials(rotProj.projectId).find((r) => r.credentialEnvVar === "UNRELATED_VAR");
  check("(D) [negative control] the unrelated env var is still live/unrevoked", unrelated?.revokedAt === null);
  check("(D) [negative control] the unrelated env var is effective", unrelated?.effective === true);
}

// ===== (E) [negative control] revoking an already-revoked row (same id, second click) throws =====
{
  let threw = null;
  try { db.revokeDeliveredCredential(olderId, { revokedBy: "human", revokedReason: "second click" }); }
  catch (e) { threw = e; }
  check("(E) [negative control] revoking an already-revoked row throws", threw instanceof Error);
  check("(E) [negative control] the error names the row's real state", /already revoked/i.test(threw?.message ?? ""));
}

// ===== (F) a revoked row is always effective:false, shadowedBy:null =====
{
  const older = db.getDeliveredCredential(olderId);
  const newer = db.getDeliveredCredential(newerId);
  check("(F) the revoked OLDER row has no shadowedBy (it's excluded on its own)", older?.shadowedBy === null);
  check("(F) the revoked NEWER row has no shadowedBy (it's excluded on its own)", newer?.shadowedBy === null);
}

try { db.close(); } catch { /* ignore */ }
for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }

console.log(failures === 0
  ? "\n✅ ALL PASS — DeliveredCredentialSummary correctly marks the currently-delivering row per env var as `effective` and any live-but-superseded sibling as `shadowedBy`; revokeDeliveredCredential correctly revokes EVERY live row sharing an env var (not just the one clicked), leaves an unrelated env var in the same project untouched, and refuses a genuine double-revoke of the same row naming its real state — the env var is the revocation unit."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
