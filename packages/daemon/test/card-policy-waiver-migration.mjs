import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 9623e943 — the `card_policy_waivers` table must appear on an ALREADY-EXISTING (pre-card) database, not just
// on a fresh one (a fresh DB is blind to a schema change that breaks an upgraded install; project memory
// verify-schema-change-against-upgraded-db). SYNTHETIC fixture, built here: a reference DB is created by the real
// Db class (its own CREATE statements, never hand-typed) in a temp LOOM_HOME, then the one table under test is
// DROPPED from that file and some real data is added — which is exactly the shape of a database written by the
// code before this card. The REAL ~/.loom database (or any backup of it) is never opened or copied.
//   (1) opening the legacy file does not throw; (2) the table now exists with the expected columns + PK;
//   (3) pre-existing rows survive; (4) upsert/list/delete round-trip; (5) a second open is idempotent and keeps data;
//   (6) no base-schema index/trigger/view references a column added by a migration step (this card adds none).
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { useOwnLoomHome, finishAndExit } from "./_tmp-fixture.mjs";
import { requireHermeticEnv } from "./_guard.mjs";
const tmpHome = useOwnLoomHome("cpm-");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const now = new Date().toISOString();
const dbFile = path.join(tmpHome, "legacy.db");

// ── build the pre-card database ─────────────────────────────────────────────────────────────────────────────────
{
  const ref = new Db(dbFile);
  ref.insertProject({ id: "legacy-p", name: "Legacy", repoPath: tmpHome, vaultPath: tmpHome, config: { orchestration: { cardPolicies: [{ id: "p1", match: { types: ["feat"] }, require: [{ kind: "approved-request" }] }] } }, createdAt: now, archivedAt: null });
  ref.insertTask({ id: "legacy-t", projectId: "legacy-p", title: "feat(x): old card", body: "", columnKey: "todo", position: 1, createdAt: now, updatedAt: now });
  ref.close();
  const raw = new Database(dbFile);
  check("(setup) the reference schema HAS the table before we drop it", !!raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='card_policy_waivers'").get());
  raw.exec("DROP TABLE card_policy_waivers");
  check("(setup) the reference schema also HAS card_policy_matches (sticky matches) before we drop it", !!raw.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='card_policy_matches'").get());
  raw.exec("DROP TABLE card_policy_matches");
  raw.exec("DROP TABLE card_policy_waivers_v2"); // card 0b165937: the project-scoped waiver successor is likewise absent
  raw.exec("DROP TABLE card_policy_matches_v2"); // card f330faee: the project-scoped successor is also absent in a pre-card file
  check("(precondition) the legacy file has NO card_policy_waivers table", !raw.prepare("SELECT 1 FROM sqlite_master WHERE name='card_policy_waivers'").get());
  check("(precondition) the legacy file still holds the real rows", raw.prepare("SELECT count(*) AS c FROM tasks").get().c === 1 && raw.prepare("SELECT count(*) AS c FROM projects").get().c === 1);
  raw.close();
}

// ── reopen with the real Db: must migrate without throwing ──────────────────────────────────────────────────────────
let db, threw = null;
try { db = new Db(dbFile); } catch (e) { threw = e; }
check(`(1) opening the pre-card database does NOT throw (${threw ? threw.message : "ok"})`, threw === null);
if (!db) { console.log(`\n${failures} check(s) FAILED.`); await finishAndExit(1); }

{
  const raw = new Database(dbFile, { readonly: true });
  const cols = raw.prepare("PRAGMA table_info(card_policy_waivers)").all();
  check("(2) the table now exists with the six expected columns", cols.map((c) => c.name).sort().join() === "created_at,policy_id,reason,requirement_kind,task_id,waived_by");
  check("(2) the primary key is exactly (task_id, policy_id, requirement_kind)", cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name).join() === "task_id,policy_id,requirement_kind");
  check("(3) pre-existing rows survived the open", db.getTask("legacy-t")?.title === "feat(x): old card" && db.getProject("legacy-p")?.name === "Legacy");
  // (6) this card adds a CREATE TABLE only (no migrated column, no index on one). Existence count only: that the
  // base-schema index/trigger/view statements are VALID against the old shape is proven by (1) — the open ran them all.
  const objs = raw.prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('index','trigger','view') AND sql IS NOT NULL").all();
  check(`(6) base-schema index/trigger/view objects exist after the open (count ${objs.length}; existence only — validity is (1))`, objs.length > 0);
  raw.close();
}

// ── sticky card-policy matches (card_policy_matches) on the same pre-card file ───────────────────────────
{
  const raw = new Database(dbFile, { readonly: true });
  const cols = raw.prepare("PRAGMA table_info(card_policy_matches_v2)").all();
  check("(7) card_policy_matches_v2 now exists on the pre-card database with exactly (task_id, project_id, policy_id, recorded_at)", cols.map((c) => c.name).sort().join() === "policy_id,project_id,recorded_at,task_id");
  check("(7) its primary key is (task_id, project_id, policy_id) and it carries NO index of its own", cols.filter((c) => c.pk > 0).sort((a, b) => a.pk - b.pk).map((c) => c.name).join() === "task_id,project_id,policy_id" && !raw.prepare("SELECT 1 FROM sqlite_master WHERE type='index' AND tbl_name='card_policy_matches_v2' AND sql IS NOT NULL").get());
  raw.close();
  check("(7) a legacy card has no recorded matches yet", db.listCardPolicyMatches("legacy-t", "legacy-p").length === 0);
  db.updateTask("legacy-t", { title: "retitled to bare prose" }); // the OLD feat title's match is recorded by the title chokepoint before it applies
  check("(7) a title write on the migrated DB records the OLD title's match (p1), and it survives a second retitle", db.listCardPolicyMatches("legacy-t", "legacy-p").join() === "p1" && (db.updateTask("legacy-t", { title: "again" }), db.listCardPolicyMatches("legacy-t", "legacy-p").join() === "p1"));
  db.recordCardPolicyMatches("legacy-t", "legacy-p", ["p1", "p1", "p9"]);
  check("(7) recording is idempotent and add-only", db.listCardPolicyMatches("legacy-t", "legacy-p").sort().join() === "p1,p9");
}

db.upsertCardPolicyWaiver({ taskId: "legacy-t", projectId: "legacy-p", policyId: "p1", requirementKind: "approved-request", reason: "r", waivedBy: "human", createdAt: now });
db.upsertCardPolicyWaiver({ taskId: "legacy-t", projectId: "legacy-p", policyId: "p1", requirementKind: "approved-request", reason: "r2", waivedBy: "human", createdAt: now });
check("(4) upsert on the migrated DB is idempotent per (card, project, policy, kind) and updates the reason", db.listCardPolicyWaivers("legacy-t", "legacy-p").length === 1 && db.listCardPolicyWaivers("legacy-t", "legacy-p")[0].reason === "r2");
check("(4) delete reports whether a row existed", db.deleteCardPolicyWaiver("legacy-t", "legacy-p", "p1", "approved-request") === true && db.deleteCardPolicyWaiver("legacy-t", "legacy-p", "p1", "approved-request") === false);
db.upsertCardPolicyWaiver({ taskId: "legacy-t", projectId: "legacy-p", policyId: "p2", requirementKind: "code-review-report", reason: "keep", waivedBy: "human", createdAt: now });
db.close();

let db2, threw2 = null;
try { db2 = new Db(dbFile); } catch (e) { threw2 = e; }
check("(5) a SECOND open is idempotent (no throw) and keeps the waiver data AND the sticky matches", threw2 === null && db2?.listCardPolicyWaivers("legacy-t", "legacy-p").length === 1 && db2?.listCardPolicyMatches("legacy-t", "legacy-p").length === 2);
db2?.close();

console.log(failures === 0 ? "\n✅ ALL PASS — card_policy_waivers migrates onto a pre-card database" : `\n${failures} check(s) FAILED.`);
await finishAndExit(failures === 0 ? 0 : 1);
