import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 9c8e256e: the idle nudge's delta digest (idle-watcher.ts / board-read.ts) is anchored to the
// RECIPIENT'S OWN last genuine board read — this proves the anchor is actually recorded where it says it
// is: mcp/server.ts's REAL `tasks_list` MCP tool handler, over a REAL TaskMcpRouter + in-process MCP
// transport (no HTTP, no daemon, no pty) — mirrors tasks-list-ndjson-spill.mjs's harness.
//
// Proves:
//   (A) a MANAGER session calling tasks_list records a board-read snapshot readable via computeBoardDelta
//       (indirectly — through the SAME app_meta key board-read.ts writes/reads).
//   (B) a PLATFORM session gets the same treatment.
//   (C) a WORKER session calling tasks_list does NOT record one — idle-watcher never nudges workers, so
//       recording for every role would be pure waste; this is the deliberate scope fence.
//   (D) `countsOnly:true` does NOT record — no card was actually seen, only a count.
//   (E) the snapshot captures the WHOLE non-terminal board, independent of THIS call's own filter — a
//       narrowly-filtered tasks_list call still anchors a delta against the full board, never a partial
//       view (the false-positive "created" trap a naively-scoped snapshot would produce).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

const tmpHome = path.join(os.tmpdir(), `loom-tlbr-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { computeBoardDelta } = await import("../dist/orchestration/board-read.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const dbFile = path.join(tmpHome, "tlbr.db");
const db = new Db(dbFile);
const projId = "p-board-read";
db.insertProject({ id: projId, name: "Board Read", repoPath: "C:/f", vaultPath: "C:/f", config: {}, createdAt: now, archivedAt: null, reserved: false });
const agentId = "board-read-agent";
db.insertAgent({ id: agentId, projectId: projId, name: "Agent", startupPrompt: "BRIEF", position: 0 });

function seedSession(id, role) {
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: "eng-" + id, title: null, cwd: "C:/f",
    processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
    lastError: null, role,
  });
}
const MGR = "S-MGR";
const PLATFORM = "S-PLATFORM";
const WORKER = "S-WORKER";
seedSession(MGR, "manager");
seedSession(PLATFORM, "platform");
seedSession(WORKER, "worker");

db.insertTask({ id: "brd-a", projectId: projId, title: "A", body: "", columnKey: "todo", priority: "p2", position: 0, createdAt: now, updatedAt: now });
db.insertTask({ id: "brd-b", projectId: projId, title: "B", body: "", columnKey: "in_progress", priority: "p1", position: 0, createdAt: now, updatedAt: now });
db.insertTask({ id: "brd-c", projectId: projId, title: "C (backlog, excluded by an idPrefix filter below)", body: "", columnKey: "backlog", priority: "p2", position: 0, createdAt: now, updatedAt: now });

const fakePty = { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null };
const wakes = new WakeService({ db, pty: fakePty, resume: () => {} });

async function callTasksList(sessionId, args = {}) {
  const server = new TaskMcpRouter(db, wakes).buildServer(projId, sessionId);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "tasks-list-records-board-read-test", version: "0" });
  await client.connect(clientT);
  await client.callTool({ name: "tasks_list", arguments: args });
  await client.close();
}

try {
  // ═══════════════════════════ (A) manager → recorded ═══════════════════════════
  check("(A) before any tasks_list call, a manager's delta is NOT COMPUTED",
    computeBoardDelta(db, MGR, projId, db.listTasks(projId)).computed === false);
  await callTasksList(MGR);
  check("(A) after a tasks_list call, the manager's delta IS computed",
    computeBoardDelta(db, MGR, projId, db.listTasks(projId)).computed === true);

  // ═══════════════════════════ (B) platform → recorded ═══════════════════════════
  check("(B) before any tasks_list call, a platform session's delta is NOT COMPUTED",
    computeBoardDelta(db, PLATFORM, projId, db.listTasks(projId)).computed === false);
  await callTasksList(PLATFORM);
  check("(B) after a tasks_list call, the platform session's delta IS computed",
    computeBoardDelta(db, PLATFORM, projId, db.listTasks(projId)).computed === true);

  // ═══════════════════════════ (C) worker → NOT recorded (deliberate scope fence) ═══════════════════════
  await callTasksList(WORKER);
  check("(C) a WORKER's tasks_list call does NOT record a board-read snapshot (idle-watcher never nudges workers)",
    computeBoardDelta(db, WORKER, projId, db.listTasks(projId)).computed === false);

  // ═══════════════════════════ (D) countsOnly → NOT recorded ═══════════════════════
  const MGR2 = "S-MGR-COUNTSONLY";
  seedSession(MGR2, "manager");
  await callTasksList(MGR2, { countsOnly: true });
  check("(D) a countsOnly:true call does NOT record a board-read snapshot (no card contents were seen)",
    computeBoardDelta(db, MGR2, projId, db.listTasks(projId)).computed === false);

  // ═══════ (E) the snapshot covers the WHOLE non-terminal board, not just this call's filtered view ═════
  const MGR3 = "S-MGR-FILTERED";
  seedSession(MGR3, "manager");
  // Filtered to ONLY "todo" — brd-b and brd-c are excluded from what this call actually returns.
  await callTasksList(MGR3, { columns: ["todo"] });
  const nonTerminal = db.listTasks(projId).filter((t) => t.columnKey !== "done");
  const delta = computeBoardDelta(db, MGR3, projId, nonTerminal);
  check("(E) delta computed after a FILTERED tasks_list call", delta.computed === true);
  check("(E) a card the filtered call never returned (brd-b) is STILL in the snapshot — no false 'created' next time",
    delta.computed && delta.createdCount === 0);
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — tasks_list records a per-session board-read snapshot for manager/platform sessions only (never workers, never a countsOnly-only call), and the snapshot always covers the WHOLE non-terminal board regardless of that call's own filter."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
