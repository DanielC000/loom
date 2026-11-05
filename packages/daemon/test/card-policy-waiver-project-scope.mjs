import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 0b165937 — card-policy waivers are scoped to the project whose config named the policy id.
//   (A)  relocate A→B: A's waiver for "p1" does NOT clear B's same-named "p1" requirement.
//   (A2) A→B→A: A's waiver applies again (source rows stay behind under the source project).
//   (R)  the human REST waiver route writes (and revokes) under the card's CURRENT project.
//   (U)  upgrade: a pre-fix DB (rows only in the legacy table) is backfilled under the card's current project.
//   (V)  the backfill is ONE-SHOT: a relocate between two boots is not re-attributed on the second boot.
// Synthetic fixtures only: every Db file lives in a temp LOOM_HOME; the real ~/.loom DB is never opened.
import path from "node:path";
import Database from "better-sqlite3";
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";
const tmpHome = useOwnLoomHome("cpwp-");
process.env.LOOM_PORT = String(hermeticPort());
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { relocateProjectTask } = await import("../dist/mcp/tasks.js");
const { buildServer } = await import("../dist/gateway/server.js");
const cp = await import("../dist/orchestration/card-policy.js");
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const now = new Date().toISOString();
const KIND = "approved-request";

const mkProject = (db, id) => db.insertProject({ id, name: id, repoPath: tmpHome, vaultPath: tmpHome, config: { orchestration: { cardPolicies: [{ id: "p1", match: { types: ["feat"] }, require: [{ kind: KIND }] }] } }, createdAt: now, archivedAt: null });
const mkTask = (db, id, projectId, title) => db.insertTask({ id, projectId, title, body: "", columnKey: "todo", position: 1, createdAt: now, updatedAt: now });
const waive = (db, taskId, projectId, reason = "owner ok") => db.upsertCardPolicyWaiver({ taskId, projectId, policyId: "p1", requirementKind: KIND, reason, waivedBy: "human", createdAt: now });
// Is the requirement waived, read exactly as the enforcement sites read it (dbPolicyEvidence, scoped to the evaluated project)?
const waivedFor = (db, taskId, pid) => cp.dbPolicyEvidence(db, pid).waived(taskId, "p1", KIND);

// ── (A)/(A2) relocate ────────────────────────────────────────────────────────────────────────────────────────
{
  const db = new Db(path.join(tmpHome, "scope.db"));
  mkProject(db, "A"); mkProject(db, "B");
  mkTask(db, "t1", "A", "feat(x): card one");
  waive(db, "t1", "A");
  check("(setup) A's waiver clears A's p1", waivedFor(db, "t1", "A") === true);
  const moved = relocateProjectTask(db, "t1", "B");
  check("(A setup) relocate A→B succeeded", !("error" in moved) && db.getTask("t1").projectId === "B");
  check("(A) A's waiver does NOT clear B's same-named p1 requirement", waivedFor(db, "t1", "B") === false);
  check("(A) B lists no waivers for the card; A's row is still held under A", db.listCardPolicyWaivers("t1", "B").length === 0 && db.listCardPolicyWaivers("t1", "A").length === 1);
  relocateProjectTask(db, "t1", "A");
  check("(A2) A→B→A: A's waiver applies again", db.getTask("t1").projectId === "A" && waivedFor(db, "t1", "A") === true);
  relocateProjectTask(db, "t1", "B");
  waive(db, "t1", "B", "b only");
  check("(A) a waiver granted under B clears B", waivedFor(db, "t1", "B") === true);
  check("(A) delete is project-scoped: deleting under B leaves A's row", db.deleteCardPolicyWaiver("t1", "B", "p1", KIND) === true && waivedFor(db, "t1", "B") === false && waivedFor(db, "t1", "A") === true);
  db.close();
}

// ── (R) the human REST route writes the card's current project ───────────────────────────────────────────────
{
  const db = new Db(path.join(tmpHome, "route.db"));
  mkProject(db, "A"); mkProject(db, "B");
  mkTask(db, "rt", "A", "feat(x): route card");
  const stub = {};
  const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
  const url = "/api/tasks/rt/policy-waivers";
  const body = { policyId: "p1", requirement: KIND, reason: "owner approved" };
  const r1 = await app.inject({ method: "POST", url, payload: body });
  check("(R) POST while the card is in A => 200 and the row is under A, not B", r1.statusCode === 200 && db.listCardPolicyWaivers("rt", "A").length === 1 && db.listCardPolicyWaivers("rt", "B").length === 0);
  relocateProjectTask(db, "rt", "B");
  check("(R) after relocate to B the A-granted waiver does not clear B", waivedFor(db, "rt", "B") === false);
  const r2 = await app.inject({ method: "POST", url, payload: { ...body, reason: "owner approved for B" } });
  check("(R) POST while the card is in B => row under B (A's row untouched)", r2.statusCode === 200 && db.listCardPolicyWaivers("rt", "B").length === 1 && db.listCardPolicyWaivers("rt", "A")[0].reason === "owner approved");
  const d = await app.inject({ method: "DELETE", url, payload: { policyId: "p1", requirement: KIND } });
  check("(R) DELETE while in B revokes B's row only", d.statusCode === 200 && d.json().removed === true && db.listCardPolicyWaivers("rt", "B").length === 0 && db.listCardPolicyWaivers("rt", "A").length === 1);
  await app.close?.();
  db.close();
}

// ── (U) upgrade from a pre-fix shape ─────────────────────────────────────────────────────────────────────────
const resetToPreFix = (file, rows) => {
  const raw = new Database(file);
  raw.exec("DROP TABLE card_policy_waivers_v2; DELETE FROM card_policy_waivers; DELETE FROM app_meta WHERE key = 'card_policy_waivers_v2_backfill_done'"); // a real pre-fix DB has no v2 table and no marker
  const ins = raw.prepare("INSERT INTO card_policy_waivers (task_id, policy_id, requirement_kind, reason, waived_by, created_at) VALUES (?, 'p1', ?, 'legacy', 'human', ?)");
  for (const id of rows) ins.run(id, KIND, now);
  raw.close();
};
const upFile = path.join(tmpHome, "legacy.db");
{
  const ref = new Db(upFile);
  mkProject(ref, "A");
  mkTask(ref, "lt", "A", "feat(x): legacy");
  ref.close();
  resetToPreFix(upFile, ["lt", "orphan-task"]);
  const raw = new Database(upFile, { readonly: true });
  check("(U setup) pre-fix shape: no v2 table, legacy rows present", !raw.prepare("SELECT 1 FROM sqlite_master WHERE name='card_policy_waivers_v2'").get() && raw.prepare("SELECT count(*) AS c FROM card_policy_waivers").get().c === 2);
  raw.close();
}
{
  let threw = null, db;
  try { db = new Db(upFile); } catch (e) { threw = e; }
  check(`(U) opening the pre-fix DB does not throw (${threw ? threw.message : "ok"})`, threw === null);
  check("(U) legacy waiver backfilled under the card's current project; a row with no task is not carried", db.listCardPolicyWaivers("lt", "A").length === 1 && db.listCardPolicyWaivers("lt", "A")[0].reason === "legacy" && db.listCardPolicyWaivers("orphan-task", "A").length === 0);
  check("(U) the backfilled waiver is not visible under another project", db.listCardPolicyWaivers("lt", "B").length === 0);
  db.close();
  const raw = new Database(upFile, { readonly: true });
  check("(U) the legacy table is left untouched (downgrade data)", raw.prepare("SELECT count(*) AS c FROM card_policy_waivers").get().c === 2);
  raw.close();
}

// ── (V) one-shot: relocate between two boots is not re-attributed ────────────────────────────────────────────
const vFile = path.join(tmpHome, "oneshot.db");
{
  const ref = new Db(vFile);
  mkProject(ref, "A"); mkProject(ref, "B");
  mkTask(ref, "t", "A", "feat(x): legacy card");
  ref.close();
  resetToPreFix(vFile, ["t"]);
}
{
  const db1 = new Db(vFile); // boot 1: backfills (t, A)
  check("(V) boot 1 backfilled the legacy waiver under A", db1.listCardPolicyWaivers("t", "A").length === 1);
  relocateProjectTask(db1, "t", "B");
  check("(V) relocate A→B: B has no waiver", db1.getTask("t").projectId === "B" && waivedFor(db1, "t", "B") === false);
  db1.close();
  const db2 = new Db(vFile); // boot 2: must NOT re-derive (t, B) from the never-consumed legacy table
  check("(V) boot 2: B still has NO waiver (the legacy table is not re-read)", db2.listCardPolicyWaivers("t", "B").length === 0 && waivedFor(db2, "t", "B") === false);
  check("(V) boot 2: A still holds its waiver", waivedFor(db2, "t", "A") === true);
  db2.close();
}

console.log(failures === 0 ? "\n✅ ALL PASS — card-policy waivers are project-scoped" : `\n${failures} check(s) FAILED.`);
await finishAndExit(failures === 0 ? 0 : 1);
