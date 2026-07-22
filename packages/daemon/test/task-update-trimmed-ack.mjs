import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// tasks_update patch-style ack (card 3be9389b). HERMETIC: no daemon, no real claude — drives the
// built business logic (dist/) against a throwaway SQLite Db. Asserts:
//   (1) a columnKey-only patch (no body) returns a TRIMMED ack: id + the small fields + `changed`,
//       with `body` OMITTED entirely (not undefined-but-present — the key itself is absent);
//   (2) a priority/held/deferred-only patch is trimmed the same way;
//   (3) a patch that DOES pass body returns the FULL task, body included;
//   (4) the trimmed ack still carries every small field a caller might read off it (id/title/
//       columnKey/priority/position/held/deferred/updatedAt) — a superset-compatible shape.
// Run: 1) build daemon, 2) node test/task-update-trimmed-ack.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { createProjectTask, updateProjectTask } from "../dist/mcp/tasks.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const file = path.join(os.tmpdir(), `loom-task-update-trimmed-ack-${Date.now()}.db`);
const now = new Date().toISOString();

try {
  const db = new Db(file);
  db.insertProject({ id: "projA", name: "Alpha", repoPath: "C:/a", vaultPath: "C:/a", config: {}, createdAt: now, archivedAt: null, reserved: false });

  const card = createProjectTask(db, "projA", {
    title: "board repair card",
    body: "A".repeat(400), // a heavy multi-hundred-char body, standing in for the multi-hundred-word case
    columnKey: "backlog",
  });
  check("setup: card created with a body", !card.error && card.body.length === 400);

  // (1) columnKey-only move: trimmed ack, body ABSENT (not just falsy).
  const moved = await updateProjectTask(db, "projA", card.id, { columnKey: "review" });
  check("(1) columnKey-only update: no error", !moved.error);
  check("(1) columnKey-only update: body key is ABSENT from the ack", !("body" in moved));
  check("(1) columnKey-only update: carries id + the changed field", moved.id === card.id && moved.columnKey === "review");
  check("(1) columnKey-only update: `changed` names the patched field", Array.isArray(moved.changed) && moved.changed.includes("columnKey") && moved.changed.length === 1);
  check("(1) columnKey-only update: persisted to the DB", db.getTask(card.id).columnKey === "review" && db.getTask(card.id).body.length === 400);

  // (2) priority/held/deferred-only patch: same trimmed shape.
  const reprioritized = await updateProjectTask(db, "projA", card.id, { priority: "p0", held: true, deferred: true });
  check("(2) priority/held/deferred-only update: body key is ABSENT", !("body" in reprioritized));
  check("(2) priority/held/deferred-only update: fields applied", reprioritized.priority === "p0" && reprioritized.held === true && reprioritized.deferred === true);
  check("(2) `changed` names all three patched fields", ["priority", "held", "deferred"].every((k) => reprioritized.changed.includes(k)) && reprioritized.changed.length === 3);

  // (4) the trimmed ack is a superset-compatible task-ish object: every small field present.
  check("(4) trimmed ack carries the full small-field set",
    "id" in reprioritized && "title" in reprioritized && "columnKey" in reprioritized && "priority" in reprioritized &&
    "position" in reprioritized && "held" in reprioritized && "deferred" in reprioritized && "updatedAt" in reprioritized);

  // (3) a patch that DOES pass body returns the FULL task, body included.
  const bodyEdit = await updateProjectTask(db, "projA", card.id, { body: "a deliberately edited body" });
  check("(3) body-editing update: no error", !bodyEdit.error);
  check("(3) body-editing update: returns the FULL task, body included", bodyEdit.body === "a deliberately edited body");
  check("(3) body-editing update: still carries the small fields too", bodyEdit.id === card.id && bodyEdit.columnKey === "review" && bodyEdit.priority === "p0");
  check("(3) body-editing update: persisted", db.getTask(card.id).body === "a deliberately edited body");

  db.close();
} finally {
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a body-untouched tasks_update patch returns a trimmed ack (body key absent) naming which fields changed, a body-editing patch still returns the full task, and the trimmed ack stays a superset-compatible task-ish shape."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
