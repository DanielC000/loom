// tasks_list filters/summary + tasks_get project-scoping test. HERMETIC like config-bounds.mjs:
// no daemon, no real claude — drives the built business logic (dist/mcp/tasks.js) against a throwaway
// SQLite Db. Asserts: (1) tasks_list defaults to a lightweight, done-excluded SUMMARY; (2) columns /
// excludeDone / includeBody filters; (3) the terminal ("done") column is DERIVED from resolveConfig
// (last kanban column), not hardcoded; (4) tasks_get returns one FULL project-scoped task and a
// cross-project id resolves to not-found. Run: 1) build daemon, 2) node test/tasks-filter.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { listProjectTasks, getProjectTask } from "../dist/mcp/tasks.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const file = path.join(os.tmpdir(), `loom-tasks-filter-${Date.now()}.db`);
const db = new Db(file);
const now = new Date().toISOString();

try {
  // Two projects. projA uses the DEFAULT board (last column "done"); projB overrides the board so its
  // terminal column is "archived" — proves excludeDone is config-derived, never the literal "done".
  db.insertProject({ id: "projA", name: "Alpha", repoPath: "C:/a", vaultPath: "C:/a", config: {}, createdAt: now, archivedAt: null });
  db.insertProject({
    id: "projB", name: "Beta", repoPath: "C:/b", vaultPath: "C:/b",
    config: { kanbanColumns: [{ key: "todo", label: "To Do" }, { key: "archived", label: "Archived" }] },
    createdAt: now, archivedAt: null,
  });

  const mk = (id, projectId, columnKey, pos) => db.insertTask({
    id, projectId, title: `T-${id}`, body: `BODY-${id}`, columnKey, position: pos, createdAt: now, updatedAt: now,
  });
  mk("a-backlog", "projA", "backlog", 1);
  mk("a-review", "projA", "review", 2);
  mk("a-done", "projA", "done", 3);          // terminal on the default board
  mk("b-todo", "projB", "todo", 1);
  mk("b-archived", "projB", "archived", 2);  // terminal on projB's overridden board

  // (1) DEFAULT: lightweight summary (no body) + done-excluded.
  const def = listProjectTasks(db, "projA");
  const defIds = def.map((t) => t.id).sort();
  check("default drops the terminal/done card (a-done absent)", !defIds.includes("a-done"));
  check("default keeps non-terminal cards (a-backlog, a-review)", defIds.join(",") === "a-backlog,a-review");
  check("default is a SUMMARY — no body field", def.every((t) => !("body" in t)));
  check("summary rows carry {id,title,columnKey,position,updatedAt}",
    def.every((t) => t.id && t.title && t.columnKey && typeof t.position === "number" && t.updatedAt));

  // (3) terminal column is DERIVED from resolveConfig, not the literal "done": projB's terminal is
  // "archived" — so b-archived is dropped while a "done"-less board has nothing special about "done".
  const bDef = listProjectTasks(db, "projB").map((t) => t.id).sort();
  check("config-derived terminal: projB drops b-archived (its last column), keeps b-todo",
    bDef.join(",") === "b-todo");

  // (2a) excludeDone:false includes the terminal card.
  const withDone = listProjectTasks(db, "projA", { excludeDone: false }).map((t) => t.id).sort();
  check("excludeDone:false includes a-done", withDone.join(",") === "a-backlog,a-done,a-review");

  // (2b) columns filter restricts to the given column keys (and still summary by default).
  const onlyReview = listProjectTasks(db, "projA", { columns: ["review"] });
  check("columns:['review'] returns only a-review", onlyReview.length === 1 && onlyReview[0].id === "a-review");
  // columns + excludeDone compose: asking for ['done'] alone yields nothing while done is excluded.
  check("columns:['done'] with default excludeDone yields nothing",
    listProjectTasks(db, "projA", { columns: ["done"] }).length === 0);
  check("columns:['done'] + excludeDone:false yields a-done",
    listProjectTasks(db, "projA", { columns: ["done"], excludeDone: false }).map((t) => t.id).join(",") === "a-done");

  // (2c) includeBody:true returns full rows WITH body.
  const full = listProjectTasks(db, "projA", { includeBody: true });
  check("includeBody:true returns full rows with body", full.every((t) => typeof t.body === "string" && t.body.startsWith("BODY-")));
  check("includeBody:true still respects excludeDone (a-done absent)", !full.some((t) => t.id === "a-done"));

  // (4) tasks_get: one FULL task, project-scoped.
  const got = getProjectTask(db, "projA", "a-done");
  check("tasks_get returns the full task (title + body), even a done card", got.id === "a-done" && got.body === "BODY-a-done" && got.title === "T-a-done");
  const cross = getProjectTask(db, "projA", "b-todo"); // projB's task, queried as projA
  check("tasks_get is project-scoped: cross-project id → not-found", !!cross.error && !("id" in cross));
  const missing = getProjectTask(db, "projA", "does-not-exist");
  check("tasks_get unknown id → not-found", !!missing.error);
} finally {
  db.close();
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — tasks_list defaults to a lightweight done-excluded summary, honors columns/excludeDone/includeBody with a config-derived terminal column, and tasks_get returns one full project-scoped task (cross-project id → not-found)."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
