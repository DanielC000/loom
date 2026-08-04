import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card d0978321 — tasks_update replaced a card body with NO baseVersion gating, so two concurrent
// editors could silently destroy each other's prose (no error, no warning, no diff). This brings the
// SAME optimistic-concurrency mechanism `memory_write` already has (card a5f98bb4) to `updateProjectTask`:
// `tasks_get`/`tasks_list` now return a `version`; a title/body write requires `baseVersion` to match it;
// a stale-or-omitted base is REJECTED with the current task returned instead of overwriting.
//
// HERMETIC: no daemon, no real claude — drives the built business logic (dist/) against a throwaway
// SQLite Db, mirroring task-update-trimmed-ack.mjs's harness style.
//
// Proves the DoD:
//   (1) POSITIVE CONTROL, both directions: two writers both reading version N, both writing — the
//       SECOND is refused and receives the CURRENT body (not the stale writer's own guess); AND a
//       field-only move still succeeds with NO baseVersion at all (the common path is unbroken).
//   (2) a STALE base is rejected the same way an OMITTED base is (existing row, no exceptions) —
//       mirrors memory_write's "omission is deliberately treated the same as staleness".
//   (3) `version` is a CONTENT counter, not a row counter (card d0978321's own design decision,
//       approved by the manager): a field-only move does NOT advance it, so a body-composer's
//       baseVersion survives an unrelated concurrent column/priority/held move untouched — proven by
//       actually interleaving a field-only move between two reads and showing the SECOND still applies.
//   (4) title-only patches are gated identically to body-only patches (both carry irreplaceable text).
//   (5) structural backstop: updateTaskChecked compares on `.version`, not `.updatedAt` (same discipline
//       as project-memory-version-guard.mjs — an integer counter can't collide on a coarse/colliding
//       clock the way a timestamp CAS could).
// Run: 1) build daemon, 2) node test/task-version-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Db } from "../dist/db.js";
import { createProjectTask, updateProjectTask } from "../dist/mcp/tasks.js";
import ts from "typescript";

function classMethodBodyText(srcText, srcPath, methodName) {
  const sourceFile = ts.createSourceFile(srcPath, srcText, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  let found;
  const visit = (node) => {
    if (!found && ts.isMethodDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === methodName && node.body) {
      found = node.body;
    }
    if (!found) ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found ? found.getText(sourceFile) : null;
}

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const file = path.join(os.tmpdir(), `loom-task-version-guard-${Date.now()}-${process.pid}.db`);
const now = new Date().toISOString();

try {
  const db = new Db(file);
  db.insertProject({ id: "projV", name: "Version Guard", repoPath: "C:/v", vaultPath: "C:/v", config: {}, createdAt: now, archivedAt: null, reserved: false });

  const card = createProjectTask(db, "projV", { title: "race card", body: "original body (v1)", columnKey: "backlog" });
  check("(setup) a fresh card starts at version 1", card.version === 1);

  // ===== (1a) two writers both read version 1; the FIRST body write succeeds and bumps to version 2 =====
  const w1 = await updateProjectTask(db, "projV", card.id, { body: "writer 1's edit (v2)" }, undefined, card.version);
  check("(1a) writer 1 (holding version 1) succeeds", !w1.error);
  check("(1a) version bumps to 2 on a real content change", w1.version === 2);

  // ===== (1a continued) the SECOND writer, ALSO holding the now-stale version 1 it read at the same
  // time as writer 1, is REFUSED — and receives the CURRENT (writer 1's) body, not its own guess =====
  const w2Stale = await updateProjectTask(db, "projV", card.id, { body: "writer 2's clobber attempt" }, undefined, card.version);
  check("(1a) THE FIX: writer 2 (stale base, version 1) is REJECTED", w2Stale.conflict === true && typeof w2Stale.error === "string");
  check("(1a) the rejection returns the CURRENT task, not writer 2's guess", w2Stale.current?.body === "writer 1's edit (v2)");
  check("(1a) the rejection's current version is 2 (writer 1's)", w2Stale.current?.version === 2);
  check("(1a) writer 2's clobber never persisted", db.getTask(card.id).body === "writer 1's edit (v2)");

  // ===== (1b) a field-only move needs NO baseVersion at all — the common board-repair path is unbroken =====
  const fieldMove = await updateProjectTask(db, "projV", card.id, { columnKey: "review" });
  check("(1b) field-only move with NO baseVersion succeeds", !fieldMove.error);
  check("(1b) field-only move applied", db.getTask(card.id).columnKey === "review");

  // ===== (2) an OMITTED base is rejected identically to a STALE one, on an EXISTING row =====
  const omitted = await updateProjectTask(db, "projV", card.id, { body: "no base supplied at all" });
  check("(2) an omitted baseVersion on an existing task's body write is REJECTED", omitted.conflict === true);
  check("(2) omitted-base rejection also returns the current body", omitted.current?.body === "writer 1's edit (v2)");

  // ===== (3) THE CONTENT-ONLY COUNTER: version advanced to 2 by the body write above; the field-only
  // move in (1b) must NOT have advanced it — proving a concurrent unrelated field move never invalidates
  // a body-composer's baseVersion. Demonstrated by actually applying a SECOND field-only move (priority)
  // interleaved here, then showing a body write still succeeds against the version from BEFORE either
  // field move. =====
  check("(3) version is STILL 2 after the field-only columnKey move — field moves don't bump it", db.getTask(card.id).version === 2);
  const secondFieldMove = await updateProjectTask(db, "projV", card.id, { priority: "p0", held: true });
  check("(3) a second field-only move also succeeds with no baseVersion", !secondFieldMove.error);
  check("(3) version is STILL 2 after TWO interleaved field-only moves", db.getTask(card.id).version === 2);
  const bodyAfterFieldMoves = await updateProjectTask(db, "projV", card.id, { body: "v3 body — composed across the field moves above" }, undefined, 2);
  check("(3) a body write holding the ORIGINAL version (2) succeeds DESPITE two field-only moves happening in between", !bodyAfterFieldMoves.error);
  check("(3) version now advances to 3 (the real content change)", bodyAfterFieldMoves.version === 3);
  check("(3) the interleaved field moves (columnKey/priority/held) all survived the body write", bodyAfterFieldMoves.columnKey === "review" && bodyAfterFieldMoves.priority === "p0" && bodyAfterFieldMoves.held === true);

  // ===== (4) title-only patches are gated the SAME way body-only patches are =====
  const titleStale = await updateProjectTask(db, "projV", card.id, { title: "a stale title rewrite" }, undefined, 2);
  check("(4) a title-only write with a STALE version (2, current is 3) is REJECTED", titleStale.conflict === true);
  const titleOk = await updateProjectTask(db, "projV", card.id, { title: "a correctly-based title rewrite" }, undefined, 3);
  check("(4) a title-only write with the CURRENT version succeeds", !titleOk.error);
  check("(4) title-only write bumps version too (title carries irreplaceable text, same as body)", titleOk.version === 4);
  check("(4) title-only write returns the TRIMMED ack (no body key) — orthogonal to the gate, unchanged behavior", !("body" in titleOk));

  // ===== (5) structural backstop: the compiled guard compares on `.version`, never `.updatedAt` =====
  const dbPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "dist", "db.js");
  const dbSrc = fs.readFileSync(dbPath, "utf8");
  const guardBody = classMethodBodyText(dbSrc, dbPath, "updateTaskChecked");
  check("(5) structural: updateTaskChecked compares on `.version`", guardBody !== null && /existing\.version\s*!==\s*baseVersion/.test(guardBody));
  check("(5) structural: updateTaskChecked's compare-and-set never references `.updatedAt`", guardBody !== null && !/existing\.updatedAt/.test(guardBody));

  db.close();
} finally {
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — tasks_update's optimistic-concurrency guard (card d0978321) rejects a stale-or-omitted baseVersion on a title/body write and returns the current task to reconcile against, while a field-only move (columnKey/priority/held/deferred) needs no baseVersion and never advances the version counter — so a body-composer's baseVersion survives concurrent unrelated field moves untouched. Backed by a structural source check that the guard compares on the monotonic `.version` INTEGER, never `.updatedAt`."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
