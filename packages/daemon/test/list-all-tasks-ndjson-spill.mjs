import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 9798200c — list_all_tasks (loom-platform) ⇒ spill.ts migration + countsOnly.
//
// FRESH EVIDENCE that carded this: a single `list_all_tasks` for Loom's `backlog` column returned
// 56,847 characters on ONE line and was refused for exceeding the token cap — the overflow handler's own
// advice ("use Read's offset/limit") doesn't work on that output, because the whole thing is ONE line.
// tasks_list (the in-project sibling, mcp/server.ts) ALREADY proactively spills through spillTextIfLarge
// (see tasks-list-ndjson-spill.mjs) — the live gap was list_all_tasks (mcp/platform.ts), which still
// returned a single JSON.stringify(...) blob no matter how many rows it carried. FIX: list_all_tasks now
// renders its `tasks` page as NDJSON and spills it through the SAME spillTextIfLarge primitive once it
// would exceed SPILL_INLINE_BUDGET_CHARS, preserving its existing pagination envelope
// {total,returned,offset,nextOffset}. Also adds countsOnly:true to BOTH list_all_tasks and tasks_list —
// the server-computed counts (columns/priority) the incident's own caller wanted, answered in a few
// hundred bytes instead of the row set.
//
// HERMETIC, CLAUDE-FREE, NETWORK-FREE: mirrors platform-cross-project-task.mjs's harness — a REAL Db +
// SessionService against a FAKE pty (PtyHost createPty() seam), the REAL PlatformMcpRouter/TaskMcpRouter
// driven over in-process MCP InMemoryTransport (no HTTP, no external daemon).
//
// Proves:
//   (A) list_all_tasks over enough rows (106, matching the incident's own total) to exceed the spill
//       budget ⇒ the response is a SINGLE JSON pointer carrying rowsFile/rowsChars/rowCount/note PLUS the
//       preserved pagination fields (total/returned/offset/nextOffset); the pointed-at file is real NDJSON
//       — one task per line, real line breaks — Read/grep-pageable exactly like tasks_list's own spill,
//       not the single unpageable line the host's own opaque overflow-spill produced before this fix.
//   (B) a small (below-cap) list_all_tasks call is BYTE-IDENTICAL to before: a bare array, no pointer
//       fields anywhere — the spill never spuriously fires on a small board.
//   (C) countsOnly:true on list_all_tasks answers "how many, by column/priority" in a tiny payload,
//       summed correctly across MULTIPLE projects, without ever fetching a row body.
//   (D) countsOnly:true on tasks_list (in-project) answers the same question for one project's board.
//   (E) countsOnly is additive: omitting it leaves the existing row-returning behavior untouched.
//
// Run: 1) build (turbo builds shared first), 2) node test/list-all-tasks-ndjson-spill.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-lats-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { TaskMcpRouter } = await import("../dist/mcp/server.js");
const { WakeService } = await import("../dist/orchestration/wake.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

// --- a real temp git repo so a spawn (never reached here) would have a valid cwd; createPty is faked ---
const repo = path.join(os.tmpdir(), `loom-lats-repo-${Date.now()}-${process.pid}`);
fs.mkdirSync(repo, { recursive: true });
fs.writeFileSync(path.join(repo, "README.md"), "# list_all_tasks spill test repo\n");
execSync("git init -q && git add . && git -c user.email=x@loom -c user.name=x commit -q -m init", { cwd: repo });

const now = new Date().toISOString();
const db = new Db();
db.insertProject({ id: "pHome", name: "Loom Platform", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: true });
db.insertProject({ id: "pLoom", name: "Loom-like", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertProject({ id: "pSmall", name: "Small board", repoPath: repo, vaultPath: repo, config: {}, createdAt: now, archivedAt: null, reserved: false });
db.insertAgent({ id: "agentLead", projectId: "pHome", name: "Lead", startupPrompt: "LEAD", position: 0, profileId: null });
db.insertAgent({ id: "agentLoom", projectId: "pLoom", name: "Work", startupPrompt: "WORK", position: 0, profileId: null });
db.insertSession({
  id: "PL", projectId: "pHome", agentId: "agentLead", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "platform", parentSessionId: null,
});
db.insertSession({
  id: "S-INPROJ", projectId: "pLoom", agentId: "agentLoom", engineSessionId: null, title: null, cwd: repo,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null,
  role: "manager", parentSessionId: null,
});

// 106 cards in "backlog" — matches the incident's own total. Titles are long enough (~450 chars) that
// 106 rows' NDJSON crosses SPILL_INLINE_BUDGET_CHARS deterministically, mirroring a REAL board's heavier
// titles rather than this repo's own synthetic-fixture-sized ones (task-summary-inline-capacity.mjs
// measures ~402 chars/row on ITS OWN small fixture titles — a real board's titles run longer).
const N = 106;
const longTitle = (i) => `Card ${i}: ${"lorem ipsum board triage detail ".repeat(12)}MARKER-${String(i).padStart(3, "0")}`;
for (let i = 0; i < N; i++) {
  db.insertTask({
    id: `loom-bl-${String(i).padStart(3, "0")}`, projectId: "pLoom", title: longTitle(i), body: "",
    columnKey: "backlog", position: i, priority: i % 3 === 0 ? "p1" : "p2", createdAt: now, updatedAt: now,
  });
}
// A few cards in a different column + priority, so countsOnly has more than one bucket to prove it sums right.
db.insertTask({ id: "loom-rev-000", projectId: "pLoom", title: "in review", body: "", columnKey: "review", position: 0, priority: "p0", createdAt: now, updatedAt: now });
db.insertTask({ id: "loom-rev-001", projectId: "pLoom", title: "in review 2", body: "", columnKey: "review", position: 1, priority: "p3", createdAt: now, updatedAt: now });

// A small, well-under-budget board on a DIFFERENT project — proves the spill never spuriously fires.
db.insertTask({ id: "small-000", projectId: "pSmall", title: "tiny", body: "", columnKey: "backlog", position: 0, priority: "p2", createdAt: now, updatedAt: now });

class SeamHost extends createSeamHost(PtyHost) { stop() {} }
const host = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc = new SessionService(db, host, new OrchestrationControl());
const wakes = new WakeService({ db, pty: host, resume: () => {} });

const platServer = new PlatformMcpRouter(db, svc).buildServer("PL");
const [pClientT, pServerT] = InMemoryTransport.createLinkedPair();
await platServer.connect(pServerT);
const platClient = new Client({ name: "lats-platform", version: "0" });
await platClient.connect(pClientT);
const callPlatform = async (name, args) => JSON.parse((await platClient.callTool({ name, arguments: args })).content[0].text);

try {
  // ===================== (A) list_all_tasks spills a 106-row backlog read =====================
  // Mirrors the incident's own call: scope to the backlog column, ask for the TRUE total (an explicit
  // limit above the DEFAULT cap — the shape a caller asking "how many cards are in this column" reaches
  // for when the default-capped page alone can't answer that honestly).
  const backlogRead = await callPlatform("list_all_tasks", { projectId: "pLoom", columns: ["backlog"], limit: 200 });
  check("(A) the oversized read is a spill pointer (rowsFile present), not bare tasks", typeof backlogRead.rowsFile === "string" && backlogRead.tasks === undefined);
  check("(A) pointer carries rowsFile/rowsChars/rowCount/note", typeof backlogRead.rowsChars === "number" && backlogRead.rowCount === N && typeof backlogRead.note === "string");
  check("(A) the pagination envelope survives the spill: total/returned/offset/nextOffset", backlogRead.total === N && backlogRead.returned === N && backlogRead.offset === 0 && backlogRead.nextOffset === null);
  check("(A) the spilled file lives under THIS session's (PL) own scratch dir", backlogRead.rowsFile.includes(path.sep + "PL" + path.sep) || backlogRead.rowsFile.includes("/PL/"));
  check("(A) the spilled file exists", fs.existsSync(backlogRead.rowsFile));
  const spilledText = fs.readFileSync(backlogRead.rowsFile, "utf8");
  check("(A) spilled byte-length matches rowsChars", Buffer.byteLength(spilledText, "utf8") === backlogRead.rowsChars);
  const lines = spilledText.split("\n").filter(Boolean);
  check("(A) the spilled file has ONE real line per task (not one giant escaped line)", lines.length === N);
  let allParse = true;
  const seenMarkers = new Set();
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      seenMarkers.add(row.id);
    } catch { allParse = false; }
  }
  check("(A) every spilled line parses as a well-formed task row", allParse);
  check("(A) all 106 seeded backlog ids are present in the spill", Array.from({ length: N }, (_, i) => `loom-bl-${String(i).padStart(3, "0")}`).every((id) => seenMarkers.has(id)));
  // The exact failure this fixes: Read's offset/limit (line-based) actually works on the spilled file —
  // demonstrate a mid-file slice lands on exactly the expected rows, the same operation the overflow
  // handler's own advice claimed would work and didn't (because the OLD output was one line).
  const midSlice = lines.slice(40, 45);
  check("(A) a line-offset slice (mirrors Read's offset/limit) returns exactly the expected 5 rows", midSlice.length === 5 && JSON.parse(midSlice[0]).id === "loom-bl-040" && JSON.parse(midSlice[4]).id === "loom-bl-044");
  const grepHits = lines.filter((l) => l.includes("MARKER-057"));
  check("(A) a grep for ONE marker returns a scoped hit (its own line), not the whole file", grepHits.length === 1);

  // ===================== (B) a small board stays a bare array — byte-identical to before =====================
  const smallRead = await callPlatform("list_all_tasks", { projectId: "pSmall" });
  check("(B) a small board's list_all_tasks is a bare array (unchanged shape)", Array.isArray(smallRead));
  check("(B) below-cap response has no spill/envelope fields anywhere", smallRead.length === 1 && smallRead[0].id === "small-000" && !("rowsFile" in smallRead[0]));

  // ===================== (C) countsOnly on list_all_tasks — cross-project, no row bodies =====================
  const counts = await callPlatform("list_all_tasks", { projectId: "pLoom", countsOnly: true });
  check("(C) countsOnly returns a small payload with no `tasks`/`rowsFile` field", counts.tasks === undefined && counts.rowsFile === undefined);
  check("(C) countsOnly total matches the FULL matching set (106 backlog + 2 review), ignoring the row cap", counts.total === N + 2);
  check("(C) countsOnly byColumn is exact", counts.byColumn.backlog === N && counts.byColumn.review === 2);
  const expectedP1 = Array.from({ length: N }, (_, i) => i).filter((i) => i % 3 === 0).length;
  check("(C) countsOnly byPriority is exact", counts.byPriority.p1 === expectedP1 && counts.byPriority.p2 === N - expectedP1 && counts.byPriority.p0 === 1 && counts.byPriority.p3 === 1);
  const countsAllProjects = await callPlatform("list_all_tasks", { countsOnly: true });
  check("(C) countsOnly with NO projectId sums across every project (>= pLoom's own total)", countsAllProjects.total >= N + 2 + 1);

  // ===================== (D) countsOnly on tasks_list (in-project) =====================
  const ipServer = new TaskMcpRouter(db, wakes).buildServer("pLoom", "S-INPROJ");
  const [ipClientT, ipServerT] = InMemoryTransport.createLinkedPair();
  await ipServer.connect(ipServerT);
  const ipClient = new Client({ name: "lats-inproj", version: "0" });
  await ipClient.connect(ipClientT);
  const ipCounts = JSON.parse((await ipClient.callTool({ name: "tasks_list", arguments: { countsOnly: true } })).content[0].text);
  check("(D) tasks_list countsOnly matches list_all_tasks's per-project counts", ipCounts.total === N + 2 && ipCounts.byColumn.backlog === N && ipCounts.byColumn.review === 2);
  const ipCountsFiltered = JSON.parse((await ipClient.callTool({ name: "tasks_list", arguments: { countsOnly: true, columns: ["review"] } })).content[0].text);
  check("(D) tasks_list countsOnly respects the columns filter", ipCountsFiltered.total === 2 && ipCountsFiltered.byColumn.review === 2 && ipCountsFiltered.byColumn.backlog === undefined);
  await ipClient.close();

  // ===================== (E) countsOnly is additive — omitting it is unaffected =====================
  const rowsStill = await callPlatform("list_all_tasks", { projectId: "pSmall" });
  check("(E) omitting countsOnly leaves list_all_tasks's row-returning behavior untouched", Array.isArray(rowsStill) && rowsStill.length === 1);
} finally {
  await platClient.close();
}

console.log(failures === 0
  ? "\n✅ ALL PASS — list_all_tasks now proactively spills an oversized `tasks` page through the SAME spillTextIfLarge primitive tasks_list's okLinesSpillable uses (real NDJSON, Read/grep-pageable, pagination envelope preserved), stays byte-identical on a small board, and both list_all_tasks + tasks_list gained a countsOnly mode answering \"how many, by column/priority\" without ever fetching a row body."
  : `\n❌ ${failures} check(s) failed`);
process.exit(failures === 0 ? 0 : 1);
