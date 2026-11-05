import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card f330faee — sticky card-policy matches are scoped to the project whose config named the policy id.
//   (R1) relocate A→B: B's same-named policy applies by ITS OWN selector only (A's sticky p1 does not leak).
//   (R2) A→B→A with a retitle in B: A's original title-derived p1 still applies on return (no shedding by round trip).
//   (R3) relocate records the DESTINATION's current-title matches (in relocateTask's own transaction).
//   (U)  upgrade: a pre-fix DB (rows only in the legacy table, none in card_policy_matches_v2) is backfilled on open,
//        the backfill is idempotent across boots, and new writes never touch the legacy table.
// Synthetic fixtures only: the Db class creates every file in a temp LOOM_HOME; the real ~/.loom DB is never opened.
import path from "node:path";
import Database from "better-sqlite3";
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
const tmpHome = useOwnLoomHome("cpsp-");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { relocateProjectTask } = await import("../dist/mcp/tasks.js");
const cp = await import("../dist/orchestration/card-policy.js");
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const now = new Date().toISOString();
const dbFile = path.join(tmpHome, "scope.db");

const pol = (types) => [{ id: "p1", match: { types }, require: [{ kind: "approved-request" }] }];
const mkProject = (db, id, types) => db.insertProject({ id, name: id, repoPath: tmpHome, vaultPath: tmpHome, config: { orchestration: { cardPolicies: pol(types) } }, createdAt: now, archivedAt: null });
const mkTask = (db, id, projectId, title) => db.insertTask({ id, projectId, title, body: "", columnKey: "todo", position: 1, createdAt: now, updatedAt: now });
const ev = { authorizedPermissionRequest: () => ({ met: false, detail: "none" }), codeReview: () => ({ met: false, detail: "none" }), checkpoint: () => ({ met: false, detail: "none" }), waived: () => false };
// Does project `pid`'s policy list apply to the card, exactly as the enforcement sites compute it (live title UNION project-scoped sticky)?
const applies = async (db, taskId, pid) => {
  const t = db.getTask(taskId);
  const raw = db.getProject(pid).config.orchestration.cardPolicies;
  const r = await cp.evaluateCardPolicies({ rawPolicies: raw, task: { id: t.id, title: t.title }, phase: "spawn", evidence: ev, stickyPolicyIds: new Set(db.listCardPolicyMatches(taskId, pid)) });
  return r.verdicts.length > 0;
};

{
  const db = new Db(dbFile);
  mkProject(db, "A", ["feat"]);   // A.p1 selects feat
  mkProject(db, "B", ["docs"]);   // B.p1 (same id!) selects docs only
  mkTask(db, "t1", "A", "feat(x): card one");
  check("(setup) A.p1 recorded for the feat card under A", db.listCardPolicyMatches("t1", "A").join() === "p1");
  db.updateTask("t1", { title: "chore(x): card one" });
  check("(setup) retitled out of A.p1's selector: A.p1 still applies (sticky)", await applies(db, "t1", "A"));

  // R1
  const moved = relocateProjectTask(db, "t1", "B");
  check("(R1) relocate succeeded", !("error" in moved) && db.getTask("t1").projectId === "B");
  check("(R1) B.p1 (docs only) does NOT apply to the chore card — A's sticky p1 did not leak", (await applies(db, "t1", "B")) === false);
  check("(R1) B has no sticky rows for the card; A's row is still held under A", db.listCardPolicyMatches("t1", "B").length === 0 && db.listCardPolicyMatches("t1", "A").join() === "p1");

  // R2: shed attempt — retitle inside B, move back
  db.updateTask("t1", { title: "bare prose title" });
  relocateProjectTask(db, "t1", "A");
  check("(R2) A→B→A with a retitle in B: A.p1 applies again from its original sticky match", await applies(db, "t1", "A"));

  // R3: relocate records the destination's own current-title matches
  mkTask(db, "t2", "A", "docs(x): doc card");
  check("(R3 setup) the docs card is not subject to A.p1", db.listCardPolicyMatches("t2", "A").length === 0);
  relocateProjectTask(db, "t2", "B");
  check("(R3) relocate recorded B.p1 for the docs card at relocate time", db.listCardPolicyMatches("t2", "B").join() === "p1");
  db.close();
}

// ── (U) upgrade from a pre-fix shape ───────────────────────────────────────────────────────────────────────────
const upFile = path.join(tmpHome, "legacy.db");
{
  const ref = new Db(upFile);
  mkProject(ref, "A", ["feat"]);
  mkTask(ref, "lt", "A", "feat(x): legacy");
  ref.close();
  const raw = new Database(upFile);
  raw.exec("DROP TABLE card_policy_matches_v2; DELETE FROM card_policy_matches; DELETE FROM app_meta WHERE key = 'card_policy_matches_v2_backfill_done'"); // a real pre-fix DB has no marker
  raw.prepare("INSERT INTO card_policy_matches (task_id, policy_id, recorded_at) VALUES ('lt','p1',?),('orphan-task','p1',?)").run(now, now);
  check("(U setup) pre-fix shape: no v2 table, legacy row present", !raw.prepare("SELECT 1 FROM sqlite_master WHERE name='card_policy_matches_v2'").get() && raw.prepare("SELECT count(*) AS c FROM card_policy_matches").get().c === 2);
  raw.close();
}
{
  let threw = null, db;
  try { db = new Db(upFile); } catch (e) { threw = e; }
  check(`(U) opening the pre-fix DB does not throw (${threw ? threw.message : "ok"})`, threw === null);
  check("(U) legacy row backfilled under the card's current project; a row with no task is not carried", db.listCardPolicyMatches("lt", "A").join() === "p1" && db.listCardPolicyMatches("orphan-task", "A").length === 0);
  check("(U) the backfilled row is not visible under another project", db.listCardPolicyMatches("lt", "B").length === 0);
  db.recordCardPolicyMatches("lt", "A", ["p7"]);
  db.close();
  const db2 = new Db(upFile); // second boot: idempotent
  check("(U) a second boot is idempotent and keeps new rows", db2.listCardPolicyMatches("lt", "A").sort().join() === "p1,p7");
  db2.close();
  const raw = new Database(upFile, { readonly: true });
  check("(U) new writes never touched the legacy table", raw.prepare("SELECT count(*) AS c FROM card_policy_matches").get().c === 2);
  raw.close();
}

// ── (V) the backfill is ONE-SHOT: a relocate after the first boot must not be re-attributed on the next boot ───
const vFile = path.join(tmpHome, "oneshot.db");
{
  const ref = new Db(vFile);
  mkProject(ref, "A", ["feat"]);   // A.p1 selects feat
  mkProject(ref, "B", ["docs"]);   // B.p1 selects docs only
  mkTask(ref, "t", "A", "chore(x): legacy card");
  ref.close();
  const raw = new Database(vFile);
  raw.exec("DROP TABLE card_policy_matches_v2; DELETE FROM card_policy_matches; DELETE FROM app_meta WHERE key = 'card_policy_matches_v2_backfill_done'");
  raw.prepare("INSERT INTO card_policy_matches (task_id, policy_id, recorded_at) VALUES ('t','p1',?)").run(now);
  raw.close();
}
{
  const db1 = new Db(vFile); // boot 1: backfills (t, A, p1)
  check("(V) boot 1 backfilled the legacy row under A", db1.listCardPolicyMatches("t", "A").join() === "p1");
  const moved = relocateProjectTask(db1, "t", "B");
  check("(V) relocate A→B succeeded and B has no sticky p1", !("error" in moved) && db1.getTask("t").projectId === "B" && db1.listCardPolicyMatches("t", "B").length === 0);
  db1.close();
  const db2 = new Db(vFile); // boot 2: must NOT re-derive (t, B, p1) from the never-consumed legacy table
  check("(V) boot 2: B still has NO p1 (the legacy table is not re-read)", db2.listCardPolicyMatches("t", "B").length === 0);
  check("(V) boot 2: A still holds p1", db2.listCardPolicyMatches("t", "A").join() === "p1");
  check("(V) boot 2: B.p1 (docs only) does not apply to the chore card", (await applies(db2, "t", "B")) === false);
  db2.close();
}

console.log(failures === 0 ? "\n✅ ALL PASS — sticky card-policy matches are project-scoped" : `\n${failures} check(s) FAILED.`);
await finishAndExit(failures === 0 ? 0 : 1);
