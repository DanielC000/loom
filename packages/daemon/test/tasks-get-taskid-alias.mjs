import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// tasks_get arg-shape alias (card 316231ce): every sibling task tool keys on `taskId` (+ optional
// `projectId`), but tasks_get keys on a bare `id` — agents habitually call it with `taskId` and eat a
// validation round-trip. Fix: tasks_get now accepts `taskId` as an ALIAS for `id` (an optional
// `projectId` is tolerated but ignored — this tool is already scoped to the caller's own project),
// while `id` keeps working unchanged (no regression). DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE,
// hermetic like worker-task-id-prefix.mjs: an isolated LOOM_HOME + sandboxed HOME, a REAL Db, and the
// REAL TaskMcpRouter over an in-process MCP InMemoryTransport (no HTTP, no daemon, no pty).
//
// Run: 1) build (turbo builds shared first), 2) node test/tasks-get-taskid-alias.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-tgta-${Date.now()}-${process.pid}`);
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
db.insertProject({ id: "pAlias", name: "Alias Project", repoPath: "C:/a", vaultPath: "C:/a", config: {}, createdAt: now, archivedAt: null, reserved: false });

const T = "aaaaaaaa-0000-4000-8000-000000000001";
db.insertTask({ id: T, projectId: "pAlias", title: "aliased card", body: "b", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });

const fakePty = { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null };
const wakes = new WakeService({ db, pty: fakePty, resume: () => {} });

try {
  const server = new TaskMcpRouter(db, wakes).buildServer("pAlias", "S");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "tasks-get-taskid-alias-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  // (1) The ORIGINAL `id` param still works unchanged (no regression).
  const byId = await call("tasks_get", { id: T });
  check("(1) tasks_get({id}) still resolves the card (regression)", byId.id === T && byId.title === "aliased card" && !byId.error);

  // (2) The NEW `taskId` alias resolves the SAME card.
  const byTaskId = await call("tasks_get", { taskId: T });
  check("(2) tasks_get({taskId}) resolves the SAME card via the alias", byTaskId.id === T && byTaskId.title === "aliased card" && !byTaskId.error);

  // (3) A tolerated, ignored `projectId` alongside `taskId` doesn't break resolution (this tool is
  // already scoped server-side to the caller's own project — the passed value is never consulted).
  const withProjectId = await call("tasks_get", { taskId: T, projectId: "someOtherProject" });
  check("(3) tasks_get({taskId, projectId}) — projectId tolerated + ignored, still resolves", withProjectId.id === T && !withProjectId.error);

  // (4) Neither `id` nor `taskId` supplied → a clear error, not a schema-validation throw.
  const neither = await call("tasks_get", {});
  check("(4) tasks_get({}) — neither id nor taskId → explicit error naming both params", typeof neither.error === "string" && neither.error.includes("id") && neither.error.includes("taskId"));

  // (5) If somehow both are given, `id` (the tool's own canonical param) wins.
  const bothGiven = await call("tasks_get", { id: T, taskId: "not-a-real-id" });
  check("(5) tasks_get({id, taskId}) — id (canonical) wins when both are given", bothGiven.id === T && !bothGiven.error);

  await client.close();
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — tasks_get accepts `taskId` as an alias for `id` (tolerating an ignored `projectId`), the original `id` param still works unchanged, and omitting both errors clearly instead of throwing a schema-validation error."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
