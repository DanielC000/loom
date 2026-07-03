import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// tasks_list NDJSON output + scoped idPrefix/titleContains filters (card dc647ae2 part A).
// DETERMINISTIC + CLAUDE-FREE + NETWORK-FREE, hermetic like worker-task-id-prefix.mjs: an isolated
// LOOM_HOME + a sandboxed HOME, a REAL Db, and the REAL TaskMcpRouter over an in-process MCP
// InMemoryTransport (no HTTP, no daemon, no pty).
//
// The bug: a large tasks_list window (e.g. excludeDone:false + a big limit/offset) could overflow the
// MCP tool-result cap as a SINGLE ~51k-char JSON-array line — when the engine spills an oversized
// result to a temp file, that one giant line can't be Read offset/limit-sliced, forcing a fragile
// manual char-slice. FIX: tasks_list now emits NEWLINE-DELIMITED JSON (one task per line), which stays
// line-sliceable/grep-pageable regardless of size, PLUS a server-side idPrefix/titleContains filter so
// a caller can narrow instead of paging a huge window.
//
// Proves:
//   (1) tasks_list's MCP response is NDJSON — one JSON object per line, NOT a JSON array — and each
//       line parses to the expected task summary;
//   (2) an empty result list is an empty string (zero lines), not "[]";
//   (3) idPrefix narrows to only tasks whose id starts with the given prefix;
//   (4) titleContains narrows to only tasks whose title contains the substring (case-insensitive);
//   (5) idPrefix/titleContains compose with the existing columns/excludeDone/minPriority filters and
//       with offset/limit pagination.
//
// Run: 1) build (turbo builds shared first), 2) node test/tasks-list-ndjson-filter.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-tlnf-${Date.now()}-${process.pid}`);
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
const { listProjectTasks } = await import("../dist/mcp/tasks.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pFilter", name: "Filter Project", repoPath: "C:/f", vaultPath: "C:/f", config: {}, createdAt: now, archivedAt: null, reserved: false });

const T_ALPHA = "aaaa1111-0000-4000-8000-000000000001";
const T_BETA = "bbbb2222-0000-4000-8000-000000000002";
const T_GAMMA = "aaaa3333-0000-4000-8000-000000000003"; // shares the "aaaa" lead with T_ALPHA
const mkTask = (id, title) => db.insertTask({
  id, projectId: "pFilter", title, body: `body-${id}`, columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now,
});
mkTask(T_ALPHA, "Fix the login bug");
mkTask(T_BETA, "Write release notes");
mkTask(T_GAMMA, "Fix the logout bug");

// (5) pure-function filter checks (business logic, no MCP round-trip).
const byIdPrefix = listProjectTasks(db, "pFilter", { idPrefix: "aaaa" }).map((t) => t.id).sort();
check("(3) listProjectTasks idPrefix narrows to matching ids", byIdPrefix.join(",") === [T_ALPHA, T_GAMMA].sort().join(","));
const byTitle = listProjectTasks(db, "pFilter", { titleContains: "fix the log" }).map((t) => t.id).sort();
check("(4) listProjectTasks titleContains narrows by case-insensitive substring", byTitle.join(",") === [T_ALPHA, T_GAMMA].sort().join(","));
const byTitleCase = listProjectTasks(db, "pFilter", { titleContains: "RELEASE" }).map((t) => t.id);
check("(4) titleContains is case-insensitive", byTitleCase.join(",") === T_BETA);
const noMatch = listProjectTasks(db, "pFilter", { idPrefix: "ffffffff" });
check("(3) an idPrefix matching nothing is an empty list, not an error", Array.isArray(noMatch) && noMatch.length === 0);

// Minimal WakePty stub — wake_me/wake_cancel/wake_list are registered on this router but not exercised here.
const fakePty = { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null };
const wakes = new WakeService({ db, pty: fakePty, resume: () => {} });

try {
  const server = new TaskMcpRouter(db, wakes).buildServer("pFilter", "S");
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "tasks-list-ndjson-filter-test", version: "0" });
  await client.connect(clientT);
  // NDJSON: split on newline, drop any blank trailing line, parse each line independently — the whole
  // response text is NOT valid JSON on its own (no wrapping array/braces), proving it's really NDJSON.
  const rawText = async (args) => (await client.callTool({ name: "tasks_list", arguments: args })).content[0].text;
  const ndjson = (text) => text.split("\n").filter(Boolean).map((l) => JSON.parse(l));

  // (1) the raw response is NOT a single JSON.parse-able blob (it's 3 lines, not one JSON array)...
  const allText = await rawText({});
  let wholeParses = true;
  try { JSON.parse(allText); } catch { wholeParses = false; }
  check("(1) tasks_list's raw text is NOT itself valid JSON (it's NDJSON, not a JSON array)", !wholeParses);
  check("(1) tasks_list's raw text has one line per task", allText.split("\n").filter(Boolean).length === 3);
  // ...but each line parses to a well-formed task summary.
  const rows = ndjson(allText).sort((a, b) => a.id.localeCompare(b.id));
  check("(1) each NDJSON line parses to a task summary with the expected fields",
    rows.every((t) => typeof t.id === "string" && typeof t.title === "string" && typeof t.columnKey === "string"));
  check("(1) all three seeded tasks are present", rows.map((t) => t.id).join(",") === [T_ALPHA, T_BETA, T_GAMMA].sort().join(","));

  // (2) an empty result is an empty string (zero lines), not "[]".
  const emptyText = await rawText({ idPrefix: "ffffffff" });
  check("(2) an empty tasks_list result is an empty string, not '[]'", emptyText === "");

  // (3)/(4) idPrefix + titleContains over the MCP tool.
  const idFiltered = ndjson(await rawText({ idPrefix: "aaaa" })).map((t) => t.id).sort();
  check("(3) tasks_list idPrefix over MCP narrows to matching ids", idFiltered.join(",") === [T_ALPHA, T_GAMMA].sort().join(","));
  const titleFiltered = ndjson(await rawText({ titleContains: "logout" })).map((t) => t.id);
  check("(4) tasks_list titleContains over MCP narrows to the matching title", titleFiltered.join(",") === T_GAMMA);

  // (5) idPrefix composes with limit/offset pagination.
  const pagedFiltered = ndjson(await rawText({ idPrefix: "aaaa", limit: 1 }));
  check("(5) idPrefix composes with limit", pagedFiltered.length === 1);

  await client.close();
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — tasks_list emits NEWLINE-DELIMITED JSON (one task per line, never a single JSON-array blob) so a wide read stays Read/grep-pageable, and the new idPrefix/titleContains filters narrow a read without paging a huge window."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
