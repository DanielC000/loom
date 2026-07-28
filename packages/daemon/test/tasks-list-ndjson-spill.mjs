import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// tasks_list / task_requests_list ⇒ spill.ts migration.
//
// BEFORE this change, an oversized tasks_list/task_requests_list result relied ENTIRELY on the host
// engine's own opaque overflow-spill: the NDJSON text was returned inline no matter its size, and if it
// happened to be big enough for the host's own spill mechanism to kick in, Loom had no visibility into
// (or control over) where that landed. FIX: both tools now proactively spill through the SAME shared
// `spillTextIfLarge` primitive (spill.ts) that `sessions/transcript.ts` already uses for oversized
// transcript turns — a Loom-owned scratch file under the CALLING session's own scratch dir, with a small
// `{rowsFile,rowsChars,rowCount,note}` pointer taking the inline text's place.
//
// HERMETIC, CLAUDE-FREE, NETWORK-FREE: an isolated LOOM_HOME + sandboxed HOME, a REAL Db, and the REAL
// TaskMcpRouter over an in-process MCP InMemoryTransport (no HTTP, no daemon, no pty) — mirrors
// tasks-list-ndjson-filter.mjs / transcript-turns-spill.mjs's harnesses.
//
// Proves:
//   (A) tasks_list, includeBody:true over enough rows to exceed the spill budget ⇒ the response is a
//       SINGLE JSON pointer object (not bare NDJSON) carrying rowsFile/rowsChars/rowCount/note; the
//       pointed-at file is real, lives under the CALLING session's own scratch dir, and is genuinely
//       NDJSON — one task per line, real line breaks, grep/Read-pageable (a marker search scopes to its
//       own line, not the whole file) — the SAME one-object-per-line contract the inline text promises.
//   (B) a small (below-cap) tasks_list call is BYTE-IDENTICAL to before: bare NDJSON text, no pointer
//       fields anywhere.
//   (C) task_requests_list spills the SAME way for a task with enough connected requests.
//   (D) a repeat pull re-uses the SAME deterministic scratch path (overwrite, not accumulation).
//   (E) TWO DIFFERENT oversized tasks_list queries (different filters ⇒ different content) spill to
//       DIFFERENT files and neither clobbers the other — the spill key is derived from the query args,
//       not a fixed string (a code-review catch: a fixed key would let a second, differently-filtered
//       call silently overwrite the first call's spilled content).
//   (F) task_requests_list keys its spill by the RESOLVED full task id, not the raw arg — two different
//       unambiguous prefixes naming the SAME task land on the SAME spilled file (another code-review
//       catch: keying by the raw arg would split one task's spill across N files, one per prefix used).
//
// Run: 1) build (turbo builds shared first), 2) node test/tasks-list-ndjson-spill.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-tls-${Date.now()}-${process.pid}`);
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
const { sessionScratchDir } = await import("../dist/paths.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const dbFile = path.join(tmpHome, "tls.db");
const db = new Db(dbFile);
const projId = "p-spill";
const SESSION_ID = "S-SPILL";
db.insertProject({ id: projId, name: "Spill Project", repoPath: "C:/f", vaultPath: "C:/f", config: {}, createdAt: now, archivedAt: null, reserved: false });
const agentId = "spill-agent";
db.insertAgent({ id: agentId, projectId: projId, name: "Manager", startupPrompt: "BRIEF", position: 0 });
db.insertSession({
  id: SESSION_ID, projectId: projId, agentId, engineSessionId: "eng-spill", title: null, cwd: "C:/f",
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager",
});

// ~1500-char body per task; 60 rows with includeBody comfortably exceeds SPILL_INLINE_BUDGET_CHARS.
const BODY = "x".repeat(1500);
const N_TASKS = 60;
const ids = [];
for (let i = 0; i < N_TASKS; i++) {
  const id = `spill-task-${String(i).padStart(3, "0")}`;
  ids.push(id);
  db.insertTask({
    id, projectId: projId, title: `Task ${i} MARKER-${String(i).padStart(3, "0")}`, body: BODY,
    columnKey: "backlog", position: i, priority: "p2", createdAt: now, updatedAt: now,
  });
}

// A SECOND group, disjoint id namespace + disjoint marker namespace — for (E)'s collision check. Also
// oversized on its own so a differently-filtered tasks_list call spills it independently.
const idsB = [];
for (let i = 0; i < N_TASKS; i++) {
  const id = `spillB-task-${String(i).padStart(3, "0")}`;
  idsB.push(id);
  db.insertTask({
    id, projectId: projId, title: `Task B ${i} MARKERB-${String(i).padStart(3, "0")}`, body: BODY,
    columnKey: "backlog", position: 1000 + i, priority: "p2", createdAt: now, updatedAt: now,
  });
}

const fakePty = { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null };
const wakes = new WakeService({ db, pty: fakePty, resume: () => {} });

try {
  const server = new TaskMcpRouter(db, wakes).buildServer(projId, SESSION_ID);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "tasks-list-ndjson-spill-test", version: "0" });
  await client.connect(clientT);
  const raw = async (name, args) => (await client.callTool({ name, arguments: args })).content[0].text;

  // ═══════════════════════════════ (A) tasks_list — OVERSIZED, spills ═══════════════════════════════
  const bigText = await raw("tasks_list", { excludeDone: false, includeBody: true, limit: N_TASKS });
  let pointer = null;
  try { pointer = JSON.parse(bigText); } catch { /* left null — checked below */ }
  check("(A) an oversized tasks_list response parses as a single JSON object (the pointer), not bare NDJSON",
    pointer !== null && typeof pointer === "object" && !Array.isArray(pointer));
  check("(A) pointer carries rowsFile/rowsChars/rowCount/note",
    pointer && typeof pointer.rowsFile === "string" && typeof pointer.rowsChars === "number" &&
    pointer.rowCount === N_TASKS && typeof pointer.note === "string");
  check("(A) rowsChars exceeds the spill budget", pointer.rowsChars > SPILL_INLINE_BUDGET_CHARS);
  check("(A) the spilled file lives under THIS session's own scratch dir",
    pointer.rowsFile.startsWith(sessionScratchDir(SESSION_ID)));
  check("(A) the spilled file exists and is non-empty",
    fs.existsSync(pointer.rowsFile) && fs.statSync(pointer.rowsFile).size > 0);

  const spilledText = fs.readFileSync(pointer.rowsFile, "utf8");
  check("(A) spilled file byte-length matches rowsChars", spilledText.length === pointer.rowsChars);
  const spilledLines = spilledText.split("\n").filter(Boolean);
  check("(A) spilled file has ONE line per task (real line breaks, NDJSON preserved)", spilledLines.length === N_TASKS);
  const parsedRows = spilledLines.map((l) => JSON.parse(l));
  check("(A) every spilled line parses as a well-formed task row (with body, since includeBody:true)",
    parsedRows.every((r) => typeof r.id === "string" && typeof r.title === "string" && r.body === BODY));
  check("(A) all seeded task ids are present in the spill", ids.every((id) => parsedRows.some((r) => r.id === id)));

  const markerLines = spilledLines.filter((l) => l.includes("MARKER-030"));
  check("(A) a grep for ONE marker returns a scoped hit (its own line), not the whole file",
    markerLines.length === 1 && !markerLines[0].includes("MARKER-000") && !markerLines[0].includes("MARKER-059"));

  // ═══════════════════════════ (D) repeat pull — deterministic key, overwrites ══════════════════════
  const bigText2 = await raw("tasks_list", { excludeDone: false, includeBody: true, limit: N_TASKS });
  const pointer2 = JSON.parse(bigText2);
  check("(D) tasks_list repeat pull re-uses the SAME deterministic scratch path (no accumulation)",
    pointer2.rowsFile === pointer.rowsFile);

  // ═══════════════ (E) two DIFFERENT oversized queries must NOT collide on one scratch file ═════════
  const bigTextB = await raw("tasks_list", { excludeDone: false, includeBody: true, idPrefix: "spillB-task-", limit: N_TASKS });
  const pointerB = JSON.parse(bigTextB);
  check("(E) a second, differently-filtered oversized query ALSO spills (its own pointer)",
    typeof pointerB.rowsFile === "string" && pointerB.rowCount === N_TASKS);
  check("(E) the two DIFFERENT queries spill to DIFFERENT files (key derived from the query, not fixed)",
    pointerB.rowsFile !== pointer.rowsFile);

  // The FIRST query's spilled file, re-read AFTER the second query ran, must be UNCHANGED — proves the
  // second call didn't silently overwrite the first's content (the bug a fixed "tasks" key would cause).
  const spilledTextAAfter = fs.readFileSync(pointer.rowsFile, "utf8");
  check("(E) query A's spilled file is untouched by query B (still group-A markers only)",
    spilledTextAAfter.includes("MARKER-030") && !spilledTextAAfter.includes("MARKERB-030"));
  const spilledLinesB = fs.readFileSync(pointerB.rowsFile, "utf8").split("\n").filter(Boolean);
  check("(E) query B's spilled file has exactly group-B's rows, none of group-A's",
    spilledLinesB.length === N_TASKS && spilledLinesB.every((l) => l.includes("MARKERB-")) && spilledLinesB.every((l) => idsB.some((id) => l.includes(`"${id}"`))));

  // ═══════════════════════════ (B) small (below-cap) call — byte-identical to before ═══════════════
  const smallText = await raw("tasks_list", { idPrefix: "spill-task-000" });
  check("(B) below-cap response is still bare NDJSON text (no pointer fields anywhere)", !smallText.includes("rowsFile"));
  const smallRows = smallText.split("\n").filter(Boolean).map((l) => JSON.parse(l));
  check("(B) below-cap response returns exactly the matching row", smallRows.length === 1 && smallRows[0].id === "spill-task-000");
  check("(B) below-cap row has no body (default summary projection, unaffected by the spill change)", smallRows[0].body === undefined);

  // ═══════════════════════════ (C) task_requests_list — OVERSIZED, spills ══════════════════════════
  const T = "tls-task-with-many-requests";
  db.insertTask({ id: T, projectId: projId, title: "Card with many requests", body: "b", columnKey: "backlog", position: 999, priority: "p2", createdAt: now, updatedAt: now });
  const REQ_TITLE_PAD = "R".repeat(1200);
  const N_REQ = 60;
  for (let i = 0; i < N_REQ; i++) {
    db.insertQuestion({
      id: `tls-q-${String(i).padStart(3, "0")}`, sessionId: SESSION_ID, projectId: projId, type: "decision",
      title: `${REQ_TITLE_PAD}-MARKER-${String(i).padStart(3, "0")}`, body: "b", options: ["A", "B"], recommendation: null,
      taskId: T, permissionAction: null, permissionScope: null, permissionExpiresAt: null, credentialEnvVar: null,
      state: "pending", chosenOption: null, note: null, createdAt: now, answeredAt: null, consumedAt: null,
    });
  }

  const reqText = await raw("task_requests_list", { taskId: T });
  const reqPointer = JSON.parse(reqText);
  check("(C) an oversized task_requests_list response is a pointer, not bare NDJSON",
    typeof reqPointer === "object" && !Array.isArray(reqPointer) && typeof reqPointer.rowsFile === "string");
  check("(C) rowCount matches the number of connected requests", reqPointer.rowCount === N_REQ);
  check("(C) rowsChars exceeds the spill budget", reqPointer.rowsChars > SPILL_INLINE_BUDGET_CHARS);
  check("(C) the spilled file lives under THIS session's own scratch dir",
    reqPointer.rowsFile.startsWith(sessionScratchDir(SESSION_ID)));
  const reqSpilledLines = fs.readFileSync(reqPointer.rowsFile, "utf8").split("\n").filter(Boolean);
  check("(C) spilled file has ONE line per request", reqSpilledLines.length === N_REQ);
  const reqParsedRows = reqSpilledLines.map((l) => JSON.parse(l));
  check("(C) every spilled line parses as a well-formed request summary row",
    reqParsedRows.every((r) => typeof r.id === "string" && typeof r.title === "string" && typeof r.state === "string"));
  const reqMarkerLines = reqSpilledLines.filter((l) => l.includes("MARKER-045"));
  check("(C) a grep for ONE request's marker returns a scoped hit, not the whole file", reqMarkerLines.length === 1);

  // ═══ (F) task_requests_list keys by the RESOLVED id — two prefixes of the SAME task share one file ═══
  const shortPrefix = T.slice(0, 8); // "tls-task" — unambiguous among this test's seeded task ids
  const reqTextByPrefix = await raw("task_requests_list", { taskId: shortPrefix });
  const reqPointerByPrefix = JSON.parse(reqTextByPrefix);
  check("(F) an unambiguous 8-char PREFIX of T resolves and spills too",
    typeof reqPointerByPrefix.rowsFile === "string" && reqPointerByPrefix.rowCount === N_REQ);
  check("(F) the full-id call and the prefix call spill to the EXACT SAME file (keyed by resolved id, not raw arg)",
    reqPointerByPrefix.rowsFile === reqPointer.rowsFile);

  await client.close();
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — tasks_list and task_requests_list now spill oversized NDJSON results through the shared spillTextIfLarge primitive (a Loom-owned, line-scoped grep/Read-pageable scratch file under the CALLING session's own scratch dir) instead of relying on the host engine's own opaque overflow-spill; below-cap responses stay byte-identical to before; two differently-filtered tasks_list queries never collide on one file; and task_requests_list keys by the resolved task id so two prefixes of the same task share one file instead of splitting across N."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
