import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// tasks_get / project_task_get ⇒ spill.ts migration (card 7aeea78b).
//
// BEFORE this change, an oversized tasks_get/project_task_get result relied ENTIRELY on the HOST
// ENGINE's own opaque overflow-spill: the full task (title+body+metadata) was returned inline no matter
// its size. The host's own spill of a single giant JSON-object line has ZERO real newlines — so
// `grep -c <pattern>` (which counts matching LINES) returns 1 on that file regardless of the TRUE
// occurrence count, silently defeating the most natural way to sanity-check its content. FIX: both
// tools now proactively spill the ALREADY-SHAPED plain text (title, a blank line, then body — never
// JSON.stringify'd) through the SAME shared `spillTextIfLarge` primitive tasks_list/task_requests_list
// already use, so the spilled file has real line breaks and is genuinely grep/Read-pageable — mirrors
// tasks-list-ndjson-spill.mjs's harness shape.
//
// Proves:
//   (A) tasks_get on an oversized body ⇒ the response keeps every other field inline (id, title,
//       columnKey, …) but replaces `body` with `bodyFile`/`bodyChars`/`note`; the pointed-at file is
//       real, lives under the CALLING session's own scratch dir, and is BYTE-IDENTICAL to the exact
//       plain text handed to the spill (`${title}\n\n${body}`) — not merely equal in line count or
//       newline count (both were tried and rejected — see the card's §CORRECTIONS).
//   (B) a small (below-cap) tasks_get call is BYTE-IDENTICAL to before: bare task object, `body` present,
//       no bodyFile/bodyChars/note anywhere.
//   (C) a repeat pull of the SAME oversized task re-uses the SAME deterministic scratch path (overwrite,
//       not accumulation).
//   (D) TWO DIFFERENT oversized tasks spill to DIFFERENT files and neither clobbers the other.
//   (E) project_task_get (the loom-platform cross-project sibling that reuses the SAME getProjectTask
//       read) gets the identical treatment on BOTH its single-taskId path and its batch taskIds path.
//   (F) the OLD failure mode, demonstrated directly: `grep -c` (counts LINES) on the spilled file
//       returns a count equal to the file's own real line count, not 1 — i.e. the spilled file is NOT
//       the single-line artifact the host's own opaque spill would have produced.
//
// HERMETIC, CLAUDE-FREE, NETWORK-FREE: an isolated LOOM_HOME + sandboxed HOME, a REAL Db, and the REAL
// TaskMcpRouter/PlatformMcpRouter over in-process MCP InMemoryTransports (no HTTP, no daemon, no pty).
//
// Run: 1) build (turbo builds shared first), 2) node test/tasks-get-body-spill.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-tgbs-${Date.now()}-${process.pid}`);
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
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { PtyHost } = await import("../dist/pty/host.js");
const { createSeamHost } = await import("./_seam-host-fixture.mjs");
const { SessionService } = await import("../dist/sessions/service.js");
const { OrchestrationControl } = await import("../dist/orchestration/control.js");
const { SPILL_INLINE_BUDGET_CHARS } = await import("../dist/spill.js");
const { sessionScratchDir } = await import("../dist/paths.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const dbFile = path.join(tmpHome, "tgbs.db");
const db = new Db(dbFile);
const projId = "p-getspill";
const SESSION_ID = "S-GETSPILL";
db.insertProject({ id: projId, name: "Get Spill Project", repoPath: "C:/f", vaultPath: "C:/f", config: {}, createdAt: now, archivedAt: null, reserved: false });
const agentId = "getspill-agent";
db.insertAgent({ id: agentId, projectId: projId, name: "Manager", startupPrompt: "BRIEF", position: 0 });
db.insertSession({
  id: SESSION_ID, projectId: projId, agentId, engineSessionId: "eng-getspill", title: null, cwd: "C:/f",
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager",
});

// A ~55,000-char body — real line breaks INSIDE it too, so a naive "count newlines" check (rejected in
// the card's §CORRECTIONS) would be exercised, not merely a giant single-paragraph blob.
const BODY_LINE = "y".repeat(200);
const bigBody = Array.from({ length: 275 }, (_, i) => `${BODY_LINE}-L${i}`).join("\n");
const TASK_A = "getspill-task-a";
db.insertTask({ id: TASK_A, projectId: projId, title: "Big Card A", body: bigBody, columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
const TASK_B = "getspill-task-b";
const bigBodyB = Array.from({ length: 275 }, (_, i) => `${BODY_LINE}-B${i}`).join("\n");
db.insertTask({ id: TASK_B, projectId: projId, title: "Big Card B", body: bigBodyB, columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now });
const SMALL = "getspill-task-small";
db.insertTask({ id: SMALL, projectId: projId, title: "Small Card", body: "just a short body", columnKey: "backlog", position: 3, priority: "p2", createdAt: now, updatedAt: now });

const fakePty = { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null };
const wakes = new WakeService({ db, pty: fakePty, resume: () => {} });

try {
  const server = new TaskMcpRouter(db, wakes).buildServer(projId, SESSION_ID);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "tasks-get-body-spill-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  // ═══════════════════════════════ (A) tasks_get — OVERSIZED, spills ═══════════════════════════════
  const gotA = await call("tasks_get", { id: TASK_A });
  check("(A) oversized tasks_get keeps id/title/columnKey inline", gotA.id === TASK_A && gotA.title === "Big Card A" && gotA.columnKey === "backlog");
  check("(A) oversized tasks_get replaces body with bodyFile/bodyChars/note", gotA.body === undefined && typeof gotA.bodyFile === "string" && typeof gotA.bodyChars === "number" && typeof gotA.note === "string");
  check("(A) bodyChars exceeds the spill budget", gotA.bodyChars > SPILL_INLINE_BUDGET_CHARS);
  check("(A) the spilled file lives under THIS session's own scratch dir", gotA.bodyFile.startsWith(sessionScratchDir(SESSION_ID)));
  check("(A) the spilled file exists and is non-empty", fs.existsSync(gotA.bodyFile) && fs.statSync(gotA.bodyFile).size > 0);

  const expectedTextA = `Big Card A\n\n${bigBody}`;
  const spilledTextA = fs.readFileSync(gotA.bodyFile, "utf8");
  // DoD-4: BYTE IDENTITY — the ONE sound check (line count and newline-agreement were both tried and
  // disproved in the card's §CORRECTIONS: a trailing-newline difference or a mangled-but-same-newline-
  // count body can both fool those). No counting, no pattern — a single whole-string comparison.
  check("(A) DoD-4: spilled file is BYTE-IDENTICAL to the exact text handed to the spill", spilledTextA === expectedTextA);
  check("(A) bodyChars matches the spilled text's own length", gotA.bodyChars === spilledTextA.length);

  // ═══════════════════════════════ (B) small (below-cap) call — byte-identical to before ═══════════════
  const gotSmall = await call("tasks_get", { id: SMALL });
  check("(B) below-cap tasks_get keeps body inline, no pointer fields", gotSmall.body === "just a short body" && gotSmall.bodyFile === undefined && gotSmall.bodyChars === undefined && gotSmall.note === undefined);

  // ═══════════════════════════ (C) repeat pull — deterministic key, overwrites ══════════════════════
  const gotA2 = await call("tasks_get", { id: TASK_A });
  check("(C) tasks_get repeat pull re-uses the SAME deterministic scratch path (no accumulation)", gotA2.bodyFile === gotA.bodyFile);

  // ═══════════════ (D) two DIFFERENT oversized tasks must NOT collide on one scratch file ═════════
  const gotB = await call("tasks_get", { id: TASK_B });
  check("(D) a second oversized task ALSO spills (its own pointer)", typeof gotB.bodyFile === "string" && gotB.bodyChars > SPILL_INLINE_BUDGET_CHARS);
  check("(D) the two DIFFERENT tasks spill to DIFFERENT files (keyed by task id, not fixed)", gotB.bodyFile !== gotA.bodyFile);
  const spilledTextAAfter = fs.readFileSync(gotA.bodyFile, "utf8");
  check("(D) task A's spilled file is untouched by task B's spill", spilledTextAAfter === expectedTextA);
  const spilledTextB = fs.readFileSync(gotB.bodyFile, "utf8");
  check("(D) task B's spilled file is byte-identical to ITS OWN text, not A's", spilledTextB === `Big Card B\n\n${bigBodyB}`);

  // ═══════════════════ (F) the OLD failure mode, demonstrated directly ═══════════════════
  // The defect this card fixes: the host engine's own opaque overflow-spill writes a JSON.stringify'd
  // blob as a SINGLE line, so `grep -c <marker>` (which counts LINES, not occurrences) returns 1
  // regardless of the true count. Our spilled file must NOT have that shape: it has one real line per
  // body-line, so a grep-style per-line count matches the body's own line structure.
  const linesA = spilledTextA.split("\n");
  check("(F) the spilled file has MANY real lines (not the single-line host-spill shape)", linesA.length === bigBody.split("\n").length + 2); // title + blank + body's own lines
  const markerLines = linesA.filter((l) => l.includes("-L137"));
  check("(F) a line-scoped marker search returns exactly ONE line, not the whole file", markerLines.length === 1);

  await client.close();
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ═══════════════════════ (E) project_task_get — the loom-platform sibling ═══════════════════════
const dbFile2 = path.join(tmpHome, "tgbs-platform.db");
const db2 = new Db(dbFile2);
db2.insertProject({ id: "pHome", name: "Loom Platform", repoPath: "C:/f", vaultPath: "C:/f", config: {}, createdAt: now, archivedAt: null, reserved: true });
db2.insertProject({ id: "pTarget", name: "Target", repoPath: "C:/f", vaultPath: "C:/f", config: {}, createdAt: now, archivedAt: null, reserved: false });
db2.insertAgent({ id: "agentLead", projectId: "pHome", name: "Lead", startupPrompt: "LEAD", position: 0 });
db2.insertSession({
  id: "PL", projectId: "pHome", agentId: "agentLead", engineSessionId: null, title: null, cwd: "C:/f",
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform",
});
const TASK_C = "getspill-task-c";
const bigBodyC = Array.from({ length: 275 }, (_, i) => `${BODY_LINE}-C${i}`).join("\n");
db2.insertTask({ id: TASK_C, projectId: "pTarget", title: "Big Card C", body: bigBodyC, columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
const TASK_D_SMALL = "getspill-task-d-small";
db2.insertTask({ id: TASK_D_SMALL, projectId: "pTarget", title: "Small Card D", body: "tiny", columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now });

class SeamHost extends createSeamHost(PtyHost) { stop() {} }
const host2 = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc2 = new SessionService(db2, host2, new OrchestrationControl());

try {
  const platServer = new PlatformMcpRouter(db2, svc2).buildServer("PL");
  const [clientT2, serverT2] = InMemoryTransport.createLinkedPair();
  await platServer.connect(serverT2);
  const platClient = new Client({ name: "project-task-get-body-spill-test", version: "0" });
  await platClient.connect(clientT2);
  const platCall = async (name, args) => JSON.parse((await platClient.callTool({ name, arguments: args })).content[0].text);

  // (E1) single-taskId path
  const single = await platCall("project_task_get", { projectId: "pTarget", taskId: TASK_C });
  check("(E1) project_task_get single path is the bare row (not {taskId,task})", !("taskId" in single) || single.id === TASK_C);
  check("(E1) project_task_get single path spills the oversized body", single.body === undefined && typeof single.bodyFile === "string" && typeof single.bodyChars === "number");
  const expectedTextC = `Big Card C\n\n${bigBodyC}`;
  check("(E1) project_task_get's spilled file is byte-identical to the exact text", fs.readFileSync(single.bodyFile, "utf8") === expectedTextC);
  check("(E1) project_task_get's spilled file lives under the CALLER session's ('PL') scratch dir", single.bodyFile.startsWith(sessionScratchDir("PL")));

  // (E2) batch taskIds path — one oversized, one small, in the SAME call.
  const batch = await platCall("project_task_get", { projectId: "pTarget", taskIds: [TASK_C, TASK_D_SMALL] });
  check("(E2) batch path returns one {taskId,task} entry per id, in order", Array.isArray(batch) && batch.length === 2 && batch[0].taskId === TASK_C && batch[1].taskId === TASK_D_SMALL);
  check("(E2) the oversized entry in the batch ALSO spills", batch[0].task.body === undefined && typeof batch[0].task.bodyFile === "string");
  check("(E2) the small entry in the batch stays inline (byte-identical to before)", batch[1].task.body === "tiny" && batch[1].task.bodyFile === undefined);
  check("(E2) the batch's spilled file for the oversized entry matches the single-path read (same key)", batch[0].task.bodyFile === single.bodyFile);

  await platClient.close();
} finally {
  try { db2.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile2 + ext, { force: true }); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — tasks_get and project_task_get now spill an oversized body through the shared spillTextIfLarge primitive (ALREADY-SHAPED plain text: title, blank line, body — never JSON.stringify'd), instead of relying on the host engine's own opaque overflow-spill that would collapse it to one unpageable line; the spilled file is byte-identical to the exact text handed to the spill; below-cap reads stay byte-identical to before; two different oversized tasks never collide on one scratch file; and repeat pulls of the same task overwrite rather than accumulate."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
