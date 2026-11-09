import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// A non-finite `position` on a task update is refused on BOTH write paths, whole patch, nothing written:
//   - REST  POST /api/tasks/:id  -> 400 {error}
//   - MCP   updateProjectTask (the shared tasks_update / project_task_update chokepoint) -> {error}
// Refused: string, numeric string "5", NaN, Infinity, -Infinity, null (the column is NOT NULL REAL, so null is
// no "clear" — it would be a constraint throw). Accepted unchanged: any finite number, floats and negatives
// included (the web in-lane reorder writes midpoint floats).
//
// Run: 1) build, 2) node test/task-position-finite-guard.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { cleanupPathSync } from "./_tmp-fixture.mjs";
import { hermeticPort } from "./_hermetic-port.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-pos-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { createProjectTask, updateProjectTask } = await import("../dist/mcp/tasks.js");
const { buildServer } = await import("../dist/gateway/server.js");

const db = new Db(path.join(tmpHome, "pos.db"));
process.env.LOOM_PORT = String(hermeticPort());
const stub = {};
const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

try {
  db.insertProject({ id: "projP", name: "Pos", repoPath: "C:/p", vaultPath: "C:/p", config: {}, createdAt: new Date().toISOString(), archivedAt: null, reserved: false });
  const card = createProjectTask(db, "projP", { title: "fix(x): position card" });
  db.updateTask(card.id, { position: 7 });
  const startPriority = db.getTask(card.id).priority;
  const otherPriority = startPriority === "p0" ? "p3" : "p0";

  // Raw JSON bodies: NaN/Infinity are not JSON-representable, so a client can only send `1e999` (parses to
  // Infinity in JS) or null/strings; the MCP path takes real JS values.
  const restBad = [
    ['"abc"', '"abc"'], ['"5"', '"5"'], ["null", "null"], ["1e999", "1e999"], ["-1e999", "-1e999"],
    ["true", "true"], ["[1]", "[1]"], ["{}", "{}"],
  ];
  for (const [label, raw] of restBad) {
    const r = await app.inject({
      method: "POST", url: `/api/tasks/${card.id}`, headers: { "content-type": "application/json" },
      payload: `{"position":${raw},"priority":"${otherPriority}"}`,
    });
    check(`REST position=${label} -> 400`, r.statusCode === 400);
    const t = db.getTask(card.id);
    check(`REST position=${label} -> nothing written (position and same-patch priority untouched)`, t.position === 7 && t.priority === startPriority);
  }

  const mcpBad = [["string", "abc"], ['"5"', "5"], ["NaN", NaN], ["Infinity", Infinity], ["-Infinity", -Infinity], ["null", null]];
  for (const [label, v] of mcpBad) {
    const r = await updateProjectTask(db, "projP", card.id, { position: v, priority: otherPriority }, { sessionId: "s1" });
    check(`MCP position=${label} -> {error}`, typeof r.error === "string");
    const t = db.getTask(card.id);
    check(`MCP position=${label} -> nothing written`, t.position === 7 && t.priority === startPriority);
  }

  // Valid finite numbers keep working exactly as before.
  for (const v of [3.5, 0, -2, 1.5e12]) {
    const r = await app.inject({ method: "POST", url: `/api/tasks/${card.id}`, payload: { position: v } });
    check(`REST finite position=${v} -> 200 and lands`, r.statusCode === 200 && db.getTask(card.id).position === v);
    const m = await updateProjectTask(db, "projP", card.id, { position: v + 1 }, { sessionId: "s1" });
    check(`MCP finite position=${v + 1} -> no error and lands`, !m.error && db.getTask(card.id).position === v + 1);
  }
  const okMix = await app.inject({ method: "POST", url: `/api/tasks/${card.id}`, payload: { position: 42.25, priority: otherPriority } });
  check("REST valid position + other field in one patch both land", okMix.statusCode === 200 && db.getTask(card.id).position === 42.25 && db.getTask(card.id).priority === otherPriority);
} finally {
  await app.close();
  db.close();
  cleanupPathSync(tmpHome);
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
