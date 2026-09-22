import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card eec70b79 — emit newline-delimited JSON from every spill-capable read (the cross-cutting sweep).
//
// tasks_list/task_requests_list (mcp/server.ts's okLinesSpillable) and list_all_tasks
// (list-all-tasks-ndjson-spill.mjs) already proactively spill an oversized array as NDJSON through the
// shared spillTextIfLarge primitive. The rest of the MCP surface did NOT: a large result fell through to
// the host engine's own opaque single-line overflow-spill instead, which JSON-escapes embedded newlines
// into ONE unpageable line — `Read`'s offset/limit (line-based) and `Grep` both defeated. Reproduced live
// (per the card): events_search returned 81,070/87,980 chars on one line twice in one session, and
// project_task_get({taskIds:[...11 ids]}) returned 87,761 chars on one line a third time, on a DIFFERENT
// tool — proving this isn't events_search-specific.
//
// FIX: `spillRowsIfLarge` (spill.ts) — the shared NDJSON-list-spill primitive this card adds, factoring
// out the "JSON.stringify each row, join on \n, spillTextIfLarge, format a note" pattern that existed
// three times over (okLinesSpillable, list_all_tasks's inline copy, this card's own new call sites) —
// applied to FIVE more spill-capable reads: events_search on BOTH the manager surface (mcp/orchestration.ts)
// and the platform surface (mcp/platform.ts, same eventsSearchQuery), project_task_get's `taskIds` batch,
// project_task_update's `taskIds` batch, and agent_clone_batch — all of which return an ARRAY whose
// aggregate size (not necessarily any single row) can cross the inline budget.
//
// HERMETIC, CLAUDE-FREE, NETWORK-FREE: a REAL Db + SessionService against a FAKE pty (mirrors
// events-search-manager-surface.mjs's minimal ptyStub — no spawn is ever reached by any tool this file
// calls), the REAL OrchestrationMcpRouter/PlatformMcpRouter driven over in-process MCP InMemoryTransport.
// Every seeded project uses repoPath:"" (falsy) so `resolveMergedInfo` short-circuits to {merged:null}
// without ever touching git — no repo fixture needed for this file's own reads.
//
// Proves, per site:
//   (A) events_search (MANAGER surface): a 50-row default page with sizable `detail` blobs spills —
//       `events` is ABSENT, replaced by eventsFile/eventsChars/eventsCount/note; total/returned/offset/
//       nextOffset/limit survive; the spilled file is real NDJSON, one event per line, Read/grep-pageable.
//       A small (few-row) read stays byte-identical: `events` present, no spill fields anywhere.
//   (B) events_search (PLATFORM/cross-project surface): same spill shape, reusing the SAME query path.
//   (C) project_task_get's `taskIds` batch: many tasks each UNDER their own per-task spill cap, whose
//       AGGREGATE still crosses the inline budget, spill the whole `results` array as NDJSON
//       (resultsFile/resultsChars/resultsCount/note) instead of a bare array. A 2-id batch stays bare.
//   (D) project_task_update's `taskIds` batch: same aggregate-spill gap on the WRITE-ack side (each ack
//       is small, but up to 200 of them can still sum past the budget).
//   (E) agent_clone_batch: each cloned agent carries its FULL startupPrompt inline (no per-target cap at
//       all) — a handful of sizable prompts crosses the budget on their own.
//
// Run: 1) build (turbo builds shared first), 2) node test/spill-ndjson-cross-cutting-reads.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { useOwnLoomHome } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME/USERPROFILE. Set BEFORE importing dist (paths.ts reads
// LOOM_HOME at import) — no ambient host state, per this project's own test-hermeticity doctrine. ---
useOwnLoomHome("loom-spill-ndjson-home-");
const sandboxHome = path.join(process.env.LOOM_HOME, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const db = new Db();

// --- Seed projects (repoPath:"" ⇒ resolveMergedInfo short-circuits to {merged:null}, no git touched). ---
db.insertProject({ id: "p1", name: "P1", repoPath: "", vaultPath: "", config: {}, createdAt: now, archivedAt: null });
db.insertProject({ id: "p2", name: "P2", repoPath: "", vaultPath: "", config: {}, createdAt: now, archivedAt: null });
for (let i = 0; i < 5; i++) {
  db.insertProject({ id: `clone-target-${i}`, name: `Clone Target ${i}`, repoPath: "", vaultPath: "", config: {}, createdAt: now, archivedAt: null });
}

db.insertAgent({ id: "a1", projectId: "p1", name: "dev-1", startupPrompt: "", position: 0, profileId: null });
db.insertAgent({ id: "srcAgent", projectId: "p1", name: "Cloneable", startupPrompt: "x".repeat(12_000), position: 1, profileId: null });

db.insertSession({
  id: "MGR1", projectId: "p1", agentId: "a1", engineSessionId: null, title: null, cwd: "/tmp/p1",
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager",
});
db.insertSession({
  id: "PL", projectId: "p1", agentId: "a1", engineSessionId: null, title: null, cwd: "/tmp/p1",
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform",
});

// --- Events: 50 rows (the default page size) each with a sizable `detail` blob — big enough that the
// default page's NDJSON crosses SPILL_INLINE_BUDGET_CHARS (48,000) deterministically. ---
const EVT_N = 50;
for (let i = 0; i < EVT_N; i++) {
  db.appendEvent({
    id: randomUUID(), ts: new Date(Date.now() - (EVT_N - i) * 1000).toISOString(),
    managerSessionId: "MGR1", workerSessionId: null, taskId: null, kind: "kill_switch",
    detail: { note: `event-detail-marker-${String(i).padStart(3, "0")}-${"lorem ipsum forensics payload ".repeat(28)}` },
  });
}
// A couple of small events on a DIFFERENT project — proves the spill never spuriously fires on a tiny read.
db.appendEvent({ id: randomUUID(), ts: now, managerSessionId: "MGR1", workerSessionId: null, taskId: null, kind: "recycle_begin", detail: { tiny: true } });

// --- Tasks for project_task_get / project_task_update batch spill: 100 tasks, moderate bodies. Each
// TaskWithRequests row carries enough fixed overhead (requests/incomingDeferredItems/merged/etc.) that
// 100 rows of a ~250-char body comfortably crosses the budget. ---
const TASK_N = 100;
const taskIds = [];
for (let i = 0; i < TASK_N; i++) {
  const id = `p1-task-${String(i).padStart(3, "0")}`;
  taskIds.push(id);
  db.insertTask({
    id, projectId: "p1", title: `Task ${i}`, body: `body detail ${"lorem ipsum ".repeat(15)}MARKER-${i}`,
    columnKey: "backlog", position: i, priority: "p2", createdAt: now, updatedAt: now,
  });
}
// A 2-task control set — stays bare/inline.
const smallTaskIds = taskIds.slice(0, 2);

// --- MCP wiring (minimal fake pty — mirrors events-search-manager-surface.mjs; no spawn is ever reached). ---
const ptyStub = { stop() {}, isAlive() { return false; }, enqueueStdin() {} };
const sessions = new SessionService(db, ptyStub, new OrchestrationControl(), {});

const orchServer = new OrchestrationMcpRouter(db, sessions).buildServer("MGR1", "manager");
const [oClientT, oServerT] = InMemoryTransport.createLinkedPair();
await orchServer.connect(oServerT);
const orchClient = new Client({ name: "spill-ndjson-orch", version: "0" });
await orchClient.connect(oClientT);
const callOrch = async (name, args) => JSON.parse((await orchClient.callTool({ name, arguments: args ?? {} })).content[0].text);

const platServer = new PlatformMcpRouter(db, sessions).buildServer("PL");
const [pClientT, pServerT] = InMemoryTransport.createLinkedPair();
await platServer.connect(pServerT);
const platClient = new Client({ name: "spill-ndjson-plat", version: "0" });
await platClient.connect(pClientT);
const callPlatform = async (name, args) => JSON.parse((await platClient.callTool({ name, arguments: args ?? {} })).content[0].text);

try {
  // ===================== (A) events_search — MANAGER surface =====================
  const mgrEvents = await callOrch("events_search", {});
  check("(A) oversized manager events_search spills: `events` absent, eventsFile present", mgrEvents.events === undefined && typeof mgrEvents.eventsFile === "string");
  check("(A) spill pointer carries eventsChars/eventsCount/note", typeof mgrEvents.eventsChars === "number" && mgrEvents.eventsCount === EVT_N && typeof mgrEvents.note === "string");
  check("(A) pagination envelope survives the spill: total/returned/offset/nextOffset/limit", mgrEvents.total === EVT_N + 1 && mgrEvents.returned === EVT_N && mgrEvents.offset === 0 && typeof mgrEvents.limit === "number");
  check("(A) spilled file lives under MGR1's own scratch dir", mgrEvents.eventsFile.includes(path.sep + "MGR1" + path.sep) || mgrEvents.eventsFile.includes("/MGR1/"));
  check("(A) spilled file exists", fs.existsSync(mgrEvents.eventsFile));
  const mgrSpilledText = fs.readFileSync(mgrEvents.eventsFile, "utf8");
  check("(A) spilled byte-length matches eventsChars", Buffer.byteLength(mgrSpilledText, "utf8") === mgrEvents.eventsChars);
  const mgrLines = mgrSpilledText.split("\n").filter(Boolean);
  check("(A) ONE real line per event (not one giant escaped line)", mgrLines.length === EVT_N);
  let mgrAllParse = true;
  const mgrMarkers = new Set();
  for (const line of mgrLines) {
    try { mgrMarkers.add(JSON.parse(line).detail.note); } catch { mgrAllParse = false; }
  }
  check("(A) every spilled line parses as a well-formed event row", mgrAllParse);
  check("(A) a mid-file slice (mirrors Read's offset/limit) lands on the expected row", JSON.parse(mgrLines[10]).detail.note.includes("event-detail-marker-"));
  const mgrGrepHits = mgrLines.filter((l) => l.includes("event-detail-marker-007"));
  check("(A) a grep for ONE marker returns a scoped hit, not the whole file", mgrGrepHits.length === 1);

  // Small control: a kind-filtered read (1 row) stays byte-identical — bare `events`, no spill fields.
  const mgrSmall = await callOrch("events_search", { kind: ["recycle_begin"] });
  check("(B-control) a small manager events_search stays inline: `events` present, no spill fields", Array.isArray(mgrSmall.events) && mgrSmall.events.length === 1 && mgrSmall.eventsFile === undefined);

  // ===================== (B) events_search — PLATFORM/cross-project surface =====================
  const platEvents = await callPlatform("events_search", { projectId: "p1" });
  check("(B) oversized platform events_search spills the same way: `events` absent, eventsFile present", platEvents.events === undefined && typeof platEvents.eventsFile === "string");
  check("(B) spill pointer carries eventsChars/eventsCount/note", typeof platEvents.eventsChars === "number" && platEvents.eventsCount === EVT_N && typeof platEvents.note === "string");
  check("(B) spilled file exists and is real NDJSON", fs.existsSync(platEvents.eventsFile) && fs.readFileSync(platEvents.eventsFile, "utf8").split("\n").filter(Boolean).length === EVT_N);
  check("(B) spilled file lives under PL's own scratch dir (platform's own caller session)", platEvents.eventsFile.includes(path.sep + "PL" + path.sep) || platEvents.eventsFile.includes("/PL/"));

  // ===================== (C) project_task_get — taskIds batch =====================
  const taskGetBatch = await callPlatform("project_task_get", { projectId: "p1", taskIds });
  check("(C) oversized project_task_get batch spills: bare array replaced by resultsFile pointer", !Array.isArray(taskGetBatch) && typeof taskGetBatch.resultsFile === "string");
  check("(C) pointer carries resultsChars/resultsCount/note", typeof taskGetBatch.resultsChars === "number" && taskGetBatch.resultsCount === TASK_N && typeof taskGetBatch.note === "string");
  check("(C) spilled file exists under PL's own scratch dir", fs.existsSync(taskGetBatch.resultsFile) && (taskGetBatch.resultsFile.includes(path.sep + "PL" + path.sep) || taskGetBatch.resultsFile.includes("/PL/")));
  const taskGetLines = fs.readFileSync(taskGetBatch.resultsFile, "utf8").split("\n").filter(Boolean);
  check("(C) ONE real line per batch result", taskGetLines.length === TASK_N);
  let taskGetAllParse = true;
  const taskGetSeenIds = new Set();
  for (const line of taskGetLines) {
    try { const row = JSON.parse(line); taskGetSeenIds.add(row.taskId); } catch { taskGetAllParse = false; }
  }
  check("(C) every spilled line parses, and every seeded taskId is present", taskGetAllParse && taskIds.every((id) => taskGetSeenIds.has(id)));

  // Small control: a 2-id batch stays a bare array.
  const taskGetSmall = await callPlatform("project_task_get", { projectId: "p1", taskIds: smallTaskIds });
  check("(C-control) a small project_task_get batch stays a bare array, no spill fields", Array.isArray(taskGetSmall) && taskGetSmall.length === 2 && taskGetSmall.every((r) => r.task !== undefined) && taskGetSmall.resultsFile === undefined);

  // ===================== (D) project_task_update — taskIds batch =====================
  // Build a genuine 200-id set (max batch size) by seeding 100 MORE small tasks, so the update-ack
  // aggregate (small acks, no body) still crosses the budget the way up to 200 real acks would.
  const moreIds = [];
  for (let i = TASK_N; i < 200; i++) {
    const id = `p1-task-${String(i).padStart(3, "0")}`;
    moreIds.push(id);
    db.insertTask({ id, projectId: "p1", title: `Task ${i}`, body: "", columnKey: "backlog", position: i, priority: "p2", createdAt: now, updatedAt: now });
  }
  const allTaskIds = taskIds.concat(moreIds);
  check("(D setup) 200 real task ids assembled for the update batch", allTaskIds.length === 200 && new Set(allTaskIds).size === 200);

  const taskUpdateBatch = await callPlatform("project_task_update", { projectId: "p1", taskIds: allTaskIds, priority: "p1" });
  check("(D) oversized project_task_update batch (200 acks) spills: bare array replaced by resultsFile pointer", !Array.isArray(taskUpdateBatch) && typeof taskUpdateBatch.resultsFile === "string");
  check("(D) pointer carries resultsChars/resultsCount/note", typeof taskUpdateBatch.resultsChars === "number" && taskUpdateBatch.resultsCount === 200 && typeof taskUpdateBatch.note === "string");
  const taskUpdateLines = fs.readFileSync(taskUpdateBatch.resultsFile, "utf8").split("\n").filter(Boolean);
  check("(D) ONE real line per batch ack, all 200 present", taskUpdateLines.length === 200);
  const updatedTask0 = db.getTask("p1-task-000");
  check("(D) the batch write actually applied (priority patched)", updatedTask0.priority === "p1");

  // Small control: a 2-id update batch stays bare.
  const taskUpdateSmall = await callPlatform("project_task_update", { projectId: "p1", taskIds: smallTaskIds, priority: "p3" });
  check("(D-control) a small project_task_update batch stays a bare array, no spill fields", Array.isArray(taskUpdateSmall) && taskUpdateSmall.length === 2 && taskUpdateSmall.resultsFile === undefined);

  // ===================== (E) agent_clone_batch =====================
  const cloneTargets = Array.from({ length: 5 }, (_, i) => ({ targetProjectId: `clone-target-${i}` }));
  const cloneBatch = await callPlatform("agent_clone_batch", { sourceAgentId: "srcAgent", targets: cloneTargets });
  check("(E) oversized agent_clone_batch (5 large prompts) spills: bare array replaced by resultsFile pointer", !Array.isArray(cloneBatch) && typeof cloneBatch.resultsFile === "string");
  check("(E) pointer carries resultsChars/resultsCount/note", typeof cloneBatch.resultsChars === "number" && cloneBatch.resultsCount === 5 && typeof cloneBatch.note === "string");
  const cloneLines = fs.readFileSync(cloneBatch.resultsFile, "utf8").split("\n").filter(Boolean);
  check("(E) ONE real line per clone result, all 5 present", cloneLines.length === 5);
  let cloneAllParse = true;
  const clonedPromptsOk = [];
  for (const line of cloneLines) {
    try { const row = JSON.parse(line); clonedPromptsOk.push(row.agent?.startupPrompt?.length === 12_000); } catch { cloneAllParse = false; }
  }
  check("(E) every spilled line parses and carries the FULL 12,000-char cloned prompt (not truncated)", cloneAllParse && clonedPromptsOk.every(Boolean));

  // Small control: a single-target clone stays a bare array.
  const cloneSmall = await callPlatform("agent_clone_batch", { sourceAgentId: "a1", targets: [{ targetProjectId: "clone-target-0", nameOverride: "tiny-clone" }] });
  check("(E-control) a single-target agent_clone_batch stays a bare array, no spill fields", Array.isArray(cloneSmall) && cloneSmall.length === 1 && cloneSmall.resultsFile === undefined);
} finally {
  await orchClient.close();
  await platClient.close();
  db.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — events_search (manager AND platform surfaces), project_task_get's taskIds batch, project_task_update's taskIds batch, and agent_clone_batch all now proactively spill an oversized result array as real NDJSON (one row per line, Read/grep-pageable) through the shared spillRowsIfLarge primitive, instead of falling through to the host engine's own opaque single-line overflow-spill — while every below-cap call on each tool stays byte-identical to before (bare array/envelope, no spill fields)."
  : `\n❌ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
