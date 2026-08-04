import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// TaskSummary inline-capacity guard (card 23471268).
//
// `TaskSummary` (mcp/tasks.ts) is the PER-ROW shape of tasks_list's default (summary) read — the
// hottest read in the manager tool surface. Every field added to it lengthens EVERY row, so the
// number of cards that fit inline before tasks_list spills to a scratch file (spill.ts,
// SPILL_INLINE_BUDGET_CHARS) drops for EVERY project, permanently, with NO signal to whoever added
// the field — a passing suite gives no indication they just cost every large board some inline
// capacity. Card c90e9525 added two nullable fields (deferredAt, deferredReason) and that alone
// tipped a bulk test fixture over the budget; this guard exists so the NEXT field addition is a
// deliberate choice (lower MIN_ROWS_PER_PAGE below, explicitly) instead of a silent one.
//
// MEASURED 2026-08-04 (card 23471268): Loom's own board (default tasks_list, excludeDone:true) is
// 94 non-terminal rows at 40,459 chars — 84.3% of the 48,000-char budget, ~430 chars/row average
// (13-field TaskSummary, avg title 131 chars). Headroom is ~17 more average-sized rows before this
// project's OWN board would spill — thin, not comfortable. The two fields c90e9525 added cost ~44
// chars/row (~4,150 chars total across 94 rows), which alone shrank capacity from ~124 rows to ~111.
//
// ⛔ Do NOT raise SPILL_INLINE_BUDGET_CHARS to make this test pass — that trades one invisible limit
// for a larger invisible one. If capacity has genuinely shrunk, lower MIN_ROWS_PER_PAGE below and
// say why in a comment (what field, which card) — the point is a deliberate, visible decision.
//
// HERMETIC, CLAUDE-FREE, NETWORK-FREE: mirrors tasks-list-ndjson-spill.mjs's harness (isolated
// LOOM_HOME + sandboxed HOME, a REAL Db, the REAL TaskMcpRouter over an in-process MCP
// InMemoryTransport) so the measured row shape is the REAL toTaskSummary output, not a hand-rolled
// approximation that would silently drift from production the next time a field is added.
//
// Run: 1) build (turbo builds shared first), 2) node test/task-summary-inline-capacity.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-tsic-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { SPILL_INLINE_BUDGET_CHARS } = await import("../dist/spill.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const dbFile = path.join(tmpHome, "tsic.db");
const db = new Db(dbFile);
const projId = "p-cap";
const SESSION_ID = "S-CAP";
db.insertProject({ id: projId, name: "Capacity Project", repoPath: "C:/f", vaultPath: "C:/f", config: {}, createdAt: now, archivedAt: null, reserved: false });
const agentId = "cap-agent";
db.insertAgent({ id: agentId, projectId: projId, name: "Manager", startupPrompt: "BRIEF", position: 0 });
db.insertSession({
  id: SESSION_ID, projectId: projId, agentId, engineSessionId: "eng-cap", title: null, cwd: "C:/f",
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager",
});

// A representative title length (131 chars — Loom's own board average, measured 2026-08-04 across 94
// non-terminal cards) rather than a short placeholder: a short synthetic title would understate real
// per-row cost and let this guard pass even as capacity quietly erodes for boards with real titles.
const REPRESENTATIVE_TITLE =
  "fix(orchestration): a representative card title, sized to Loom own measured average card-title length, for this capacity guard test";
if (REPRESENTATIVE_TITLE.length !== 131) throw new Error(`REPRESENTATIVE_TITLE drifted to ${REPRESENTATIVE_TITLE.length} chars — keep it at 131 (Loom's measured average) or update that comment too`);
const N_TASKS = 50; // enough to average out any one row's noise, small enough this call itself stays under budget
const ids = [];
for (let i = 0; i < N_TASKS; i++) {
  const id = `cap-task-${String(i).padStart(4, "0")}`;
  ids.push(id);
  db.insertTask({
    id, projectId: projId, title: REPRESENTATIVE_TITLE, body: "b",
    columnKey: "backlog", position: 1785800000000 + i, priority: "p2", createdAt: now, updatedAt: now,
  });
}

const fakePty = { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null };
const wakes = new WakeService({ db, pty: fakePty, resume: () => {} });

try {
  const server = new TaskMcpRouter(db, wakes).buildServer(projId, SESSION_ID);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "task-summary-inline-capacity-test", version: "0" });
  await client.connect(clientT);

  // Default summary shape, well under the spill budget for this N — measures the REAL per-row cost.
  const text = (await client.callTool({ name: "tasks_list", arguments: { limit: N_TASKS } })).content[0].text;
  check("response is bare NDJSON, not a spill pointer (this call is sized to stay under budget)", !text.includes("rowsFile"));

  const lines = text.split("\n").filter(Boolean);
  check(`all ${N_TASKS} seeded rows are present`, lines.length === N_TASKS);
  const rows = lines.map((l) => JSON.parse(l));
  check("every row has NO body (default summary projection)", rows.every((r) => r.body === undefined));

  const bytesPerRow = text.length / lines.length;
  const capacityRows = Math.floor(SPILL_INLINE_BUDGET_CHARS / bytesPerRow);

  console.log(`\nTaskSummary inline capacity: ${bytesPerRow.toFixed(1)} chars/row (title len ${REPRESENTATIVE_TITLE.length}) ⇒ ${capacityRows} rows fit inline before spilling (budget ${SPILL_INLINE_BUDGET_CHARS} chars).`);

  // The stated floor: measured capacity at TaskSummary's CURRENT field count is ~111 rows (see header
  // comment). 100 leaves ~10% slack for incidental noise (id/position/timestamp width) without masking
  // a genuine field addition — card 23471268 measured a single 2-field addition costs ~13 rows of
  // capacity, well over that slack.
  const MIN_ROWS_PER_PAGE = 100;
  check(`at least ${MIN_ROWS_PER_PAGE} rows fit inline (this project's own board — 94 non-terminal rows as of 2026-08-04 — needs headroom above its own row count)`,
    capacityRows >= MIN_ROWS_PER_PAGE);

  await client.close();
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — TaskSummary's current field count leaves enough inline-spill capacity for this project's own board; the next field added to TaskSummary that erodes it below the stated floor will fail this test instead of shrinking silently."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
