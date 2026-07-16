import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// toBoardTasks projection test (card 4fa2c146 — the 2026-07-16 perf profile found the REST board route
// shipping every DONE card's full markdown body every 4s poll: 2.79MB / 1263 tasks). HERMETIC like
// tasks-filter.mjs: no daemon, no real claude — drives the built projection (dist/mcp/tasks.js) against a
// throwaway SQLite Db. Asserts: (1) a LIVE (non-terminal-column) task keeps its full body; (2) a DONE
// (terminal-column) task's body is dropped to a `hasBody` flag; (3) `hasBody` is accurate in both cases,
// incl. an empty/whitespace-only body; (4) an undefined terminalKey (columnKeyForRole's contract: this
// happens ONLY for a genuinely empty column list — a real board always resolves "terminal" via its
// last-column fallback, see column-lifecycle.mjs) drops nothing. Run: 1) build daemon,
// 2) node test/board-task-projection.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { toBoardTasks } from "../dist/mcp/tasks.js";
import { resolveConfig, columnKeyForRole } from "@loom/shared";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const file = path.join(os.tmpdir(), `loom-board-task-projection-${Date.now()}.db`);
const db = new Db(file);
const now = new Date().toISOString();

try {
  // Default board: terminal column is "done" (config-derived below, never hardcoded).
  db.insertProject({ id: "projA", name: "Alpha", repoPath: "C:/a", vaultPath: "C:/a", config: {}, createdAt: now, archivedAt: null });

  const mk = (id, projectId, columnKey, body) => db.insertTask({
    id, projectId, title: `T-${id}`, body, columnKey, position: 1, createdAt: now, updatedAt: now,
  });
  mk("a-live", "projA", "backlog", "a live card's full body");
  mk("a-done", "projA", "done", "a done card's body — should be dropped");
  mk("a-done-empty", "projA", "done", "   "); // whitespace-only — hasBody must read false, not throw

  const colsA = resolveConfig(db.getProject("projA").config).kanbanColumns;
  const terminalA = columnKeyForRole(colsA, "terminal");
  const boardA = toBoardTasks(db.listTasks("projA"), terminalA);
  const liveRow = boardA.find((t) => t.id === "a-live");
  const doneRow = boardA.find((t) => t.id === "a-done");
  const doneEmptyRow = boardA.find((t) => t.id === "a-done-empty");

  check("a LIVE task keeps its full body", liveRow?.body === "a live card's full body");
  check("a LIVE task's hasBody is accurate", liveRow?.hasBody === true);
  check("a DONE task's body is dropped (not present on the row)", doneRow && !("body" in doneRow));
  check("a DONE task's hasBody still reads true (derived server-side, not from the dropped body)", doneRow?.hasBody === true);
  check("a DONE task with a whitespace-only body: hasBody is false, body still dropped",
    doneEmptyRow?.hasBody === false && !("body" in doneEmptyRow));

  // toBoardTasks's own contract for an undefined terminalKey — exercised directly (not via
  // resolveConfig/columnKeyForRole, whose "terminal" role always falls back to the LAST column on a
  // real board — see column-lifecycle.mjs — so this input never actually arises from a real board).
  const liveTasks = db.listTasks("projA").filter((t) => t.columnKey !== "done");
  const boardNoTerminal = toBoardTasks(liveTasks, undefined);
  check("undefined terminalKey: every row keeps its full body (nothing is ever dropped)",
    boardNoTerminal.every((t) => typeof t.body === "string" && t.body.length > 0));
} finally {
  db.close();
  fs.rmSync(file, { force: true });
  fs.rmSync(`${file}-wal`, { force: true });
  fs.rmSync(`${file}-shm`, { force: true });
}

console.log(failures === 0
  ? "\n✅ ALL PASS — toBoardTasks keeps a LIVE task's full body, drops a DONE task's body to a hasBody flag (accurate even for a whitespace-only body), and drops nothing when terminalKey is undefined."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
