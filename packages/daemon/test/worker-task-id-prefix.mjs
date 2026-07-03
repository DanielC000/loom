import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Unambiguous task-id-PREFIX resolution on the WORKER-facing project-scoped loom-tasks surface
// (card 342e433d, filed from the platform batch — two workers on cards 2ecef3c5/6accee44 pasted an
// 8-char task id into tasks_get and hit "task not found in this project"). DETERMINISTIC +
// CLAUDE-FREE + NETWORK-FREE, hermetic like project-task-id-prefix.mjs: an isolated LOOM_HOME + a
// sandboxed HOME, a REAL Db, and the REAL TaskMcpRouter over an in-process MCP InMemoryTransport
// (no HTTP, no daemon, no pty).
//
// The bug: platform.ts's project_task_get/update already resolve an unambiguous PROJECT-id prefix
// (98c4aa23/66eb29d), but neither the platform nor the in-project loom-tasks tasks_get/tasks_update
// resolved a TASK-id prefix — an exact lookup only. Workers cite/paste the displayed 8-char short id
// everywhere (kickoffs, reports), so the full-UUID requirement was pure friction.
//
// Proves, for BOTH tasks_get and tasks_update on the project-scoped loom-tasks surface:
//   (1) an unambiguous 8-char task-id prefix resolves to the right card;
//   (2) an AMBIGUOUS prefix is rejected, the error naming BOTH candidate ids (never a silent pick),
//       and an ambiguous tasks_update does NOT mutate either candidate;
//   (3) an unknown id/prefix still 404s "task not found in this project" (regression);
//   (4) the exact full id still resolves (regression);
//   (5) tasks_update resolves the prefix to the FULL id before writing (the patch lands on the right row);
//   (6) a FULL id that exists on ANOTHER project's board gets a DISTINCT scope-error message (card
//       dc647ae2 part B) instead of the same bare "not found" a truly-missing id gets — a worker handed
//       an out-of-scope id can tell "wrong board" from "typo'd/gone".
//
// Run: 1) build (turbo builds shared first), 2) node test/worker-task-id-prefix.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-wtip-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pWorker", name: "Worker Project", repoPath: "C:/w", vaultPath: "C:/w", config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "pOther", name: "Other Project", repoPath: "C:/o", vaultPath: "C:/o", config: {}, createdAt: now, archivedAt: null, reserved: false });

// CRAFTED UUID-shaped task ids: one with a UNIQUE 8-char prefix, two that SHARE an 8-char prefix
// (all within pWorker, since resolution is scoped to the CALLING session's OWN project).
const T_SOLO = "12ab34cd-0000-4000-8000-000000000001"; // unique prefix "12ab34cd"
const T_DUP_A = "feedface-0000-4000-8000-00000000000a"; // shares prefix "feedface" with…
const T_DUP_B = "feedface-0000-4000-8000-00000000000b"; // …this one
const T_OTHER = "aabbccdd-0000-4000-8000-000000000009"; // lives on pOther — cross-project guard
const mkTask = (id, projectId, title) => db.insertTask({
  id, projectId, title, body: `body-${id}`, columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now,
});
mkTask(T_SOLO, "pWorker", "solo card");
mkTask(T_DUP_A, "pWorker", "dup A");
mkTask(T_DUP_B, "pWorker", "dup B");
mkTask(T_OTHER, "pOther", "other project's card");

// Minimal WakePty stub — wake_me/wake_cancel/wake_list are registered on this router but not exercised here.
const fakePty = { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null };
const wakes = new WakeService({ db, pty: fakePty, resume: () => {} });

try {
  const server = new TaskMcpRouter(db, wakes).buildServer("pWorker", "S");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "worker-task-id-prefix-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  // ===================== tasks_get =====================
  const got = await call("tasks_get", { id: "12ab34cd" });
  check("(1) tasks_get: unambiguous 8-char prefix resolves to the right card", got.id === T_SOLO && got.title === "solo card" && !got.error);

  const gotExact = await call("tasks_get", { id: T_SOLO });
  check("(4) tasks_get: exact full id still resolves (regression)", gotExact.id === T_SOLO && !gotExact.error);

  const ambGet = await call("tasks_get", { id: "feedface" });
  check("(2) tasks_get: ambiguous prefix rejected, naming BOTH candidate ids",
    typeof ambGet.error === "string" && ambGet.error.includes("ambiguous") && ambGet.error.includes(T_DUP_A) && ambGet.error.includes(T_DUP_B));

  const unknownGet = await call("tasks_get", { id: "99999999" });
  check("(3) tasks_get: unknown 8-char prefix -> 'task not found in this project' (regression)", unknownGet.error === "task not found in this project");

  const shortGet = await call("tasks_get", { id: "ghost" });
  check("(3) tasks_get: too-short/non-matching id -> 'task not found in this project' (regression)", shortGet.error === "task not found in this project");

  const crossGet = await call("tasks_get", { id: T_OTHER });
  check("(6) cross-project guard: another project's FULL id is NOT readable via this session, and the error is a DISTINCT scope error (not the bare 'not found' an unknown id gets)",
    crossGet.error === `task '${T_OTHER}' not found in this project — it exists on another project's board (out of scope for this session)`);

  // ===================== tasks_update =====================
  const upd = await call("tasks_update", { id: "12ab34cd", priority: "p0" });
  check("(1) tasks_update: unambiguous 8-char prefix resolves, patch applied to the FULL id", upd.id === T_SOLO && upd.priority === "p0" && !upd.error);
  check("(5) tasks_update: prefix resolved to the full id before writing — persisted to the DB row", db.getTask(T_SOLO).priority === "p0");

  const ambUpdate = await call("tasks_update", { id: "feedface", priority: "p3" });
  check("(2) tasks_update: ambiguous prefix rejected, naming BOTH candidate ids",
    typeof ambUpdate.error === "string" && ambUpdate.error.includes("ambiguous") && ambUpdate.error.includes(T_DUP_A) && ambUpdate.error.includes(T_DUP_B));
  check("(2) tasks_update: the ambiguous call mutated NEITHER candidate", db.getTask(T_DUP_A).priority === "p2" && db.getTask(T_DUP_B).priority === "p2");

  const unknownUpdate = await call("tasks_update", { id: "99999999", priority: "p1" });
  check("(3) tasks_update: unknown prefix -> 'task not found in this project' (regression)", unknownUpdate.error === "task not found in this project");

  const updExact = await call("tasks_update", { id: T_DUP_A, priority: "p1" });
  check("(4) tasks_update: exact full id still resolves (regression)", updExact.id === T_DUP_A && updExact.priority === "p1" && !updExact.error);
  check("(4) exact-id update persisted only to the targeted card", db.getTask(T_DUP_A).priority === "p1" && db.getTask(T_DUP_B).priority === "p2");

  const crossUpdate = await call("tasks_update", { id: T_OTHER, priority: "p0" });
  check("(6) cross-project guard: another project's FULL id is NOT editable via this session, and the error is the same distinct scope error",
    crossUpdate.error === `task '${T_OTHER}' not found in this project — it exists on another project's board (out of scope for this session)`);
  check("cross-project guard: the other project's card was NOT mutated", db.getTask(T_OTHER).priority === "p2");

  await client.close();
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the worker-facing loom-tasks tasks_get/tasks_update accept an unambiguous 8-char task-id prefix (mirrors project_get), reject an ambiguous prefix by naming both candidate ids without mutating anything, resolve the prefix to the FULL id before writing, still 404 'task not found in this project' on an unknown id/prefix (regressions preserved), and now give a cross-project FULL id a DISTINCT scope-error message instead of the same bare not-found."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
