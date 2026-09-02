import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// tasks_create / tasks_update / project_task_update ⇒ spill.ts migration (card f651aff0).
//
// Card 7aeea78b (tasks-get-body-spill.mjs) fixed the *_get READ tools' oversized-body gap. Its own
// sweep was scoped to "*_get tools", so it could never have found the WRITE tools that return the same
// unbounded full-task shape: `tasks_create`/`tasks_update` (mcp/server.ts) and the cross-project
// `project_task_update` (mcp/platform.ts) — `project_task_create` was already fixed alongside
// project_task_get's own read-side migration and needs no change here.
//
// The live specimen that filed this card: a `tasks_update` appendBody call returned a 71,434-char,
// ZERO-newline single-line blob through the HOST ENGINE's own opaque overflow-spill — the exact
// unpageable artifact `spillTextIfLarge` exists to prevent, on a WRITE tool instead of a read one.
//
// Proves:
//   (A) tasks_create on an oversized body ⇒ spills (id/title inline, body replaced by
//       bodyFile/bodyChars/note); a small create stays byte-identical to before.
//   (B) tasks_update's SUCCESSFUL body-touching writes ALSO spill — both `body` (with baseVersion) and
//       `appendBody` (which internally becomes a body write) — verified BYTE-IDENTICAL against the
//       actual persisted DB row, not a locally reconstructed guess (appendBody's server-stamped
//       timestamp is unpredictable from outside).
//   (C) tasks_update's FIELD-ONLY patch (a columnKey move on an already-oversized task) returns the
//       TRIMMED TaskUpdateAck — no `body` field at all, so there's nothing to spill and the ack carries
//       no bodyFile/bodyChars/note either (unaffected by this change, byte-identical to before).
//   (D) tasks_update's CONFLICT guard (stale/omitted baseVersion) and TRUNCATION guard (a destructive
//       body replace) both hand back `current: Task` — the UNCHANGED on-disk task — and that NESTED
//       `current` field spills too, not just a top-level body.
//   (E) a small (below-cap) tasks_update body write is byte-identical to before.
//   (F) project_task_update (the loom-platform cross-project sibling sharing updateProjectTask) gets the
//       identical treatment, on both its single-taskId path and its taskIds batch path.
//   (G) the OLD failure mode, demonstrated directly on a tasks_update result: a single-line host-spill
//       shape (`grep -c` returning 1 regardless of true content) would NOT show real per-line matches;
//       our spilled file does.
//
// DoD-3: every spill check below is a WHOLE-STRING comparison against the real DB row's own body — never
// a line count, a newline count, or agreement between two greps (all three are unsound in both
// directions — see tasks-get-body-spill.mjs's own header for why).
//
// HERMETIC, CLAUDE-FREE, NETWORK-FREE: an isolated LOOM_HOME + sandboxed HOME, a REAL Db, and the REAL
// TaskMcpRouter/PlatformMcpRouter over in-process MCP InMemoryTransports (no HTTP, no daemon, no pty).
//
// Run: 1) build (turbo builds shared first), 2) node test/tasks-write-body-spill.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-twbs-${Date.now()}-${process.pid}`);
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
const dbFile = path.join(tmpHome, "twbs.db");
const db = new Db(dbFile);
const projId = "p-writespill";
const SESSION_ID = "S-WRITESPILL";
db.insertProject({ id: projId, name: "Write Spill Project", repoPath: "C:/f", vaultPath: "C:/f", config: {}, createdAt: now, archivedAt: null, reserved: false });
const agentId = "writespill-agent";
db.insertAgent({ id: agentId, projectId: projId, name: "Manager", startupPrompt: "BRIEF", position: 0 });
db.insertSession({
  id: SESSION_ID, projectId: projId, agentId, engineSessionId: "eng-writespill", title: null, cwd: "C:/f",
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager",
});

// A ~57,000-char body, real line breaks inside it (not one giant paragraph) — same shape as
// tasks-get-body-spill.mjs's own fixture, so a naive "count newlines" check would be exercised too.
const BODY_LINE = "y".repeat(200);
const bigBody = Array.from({ length: 275 }, (_, i) => `${BODY_LINE}-L${i}`).join("\n");

const TASK_MOVE = "writespill-task-move";
db.insertTask({ id: TASK_MOVE, projectId: projId, title: "Field-Only Move Card", body: bigBody, columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
const TASK_BODY = "writespill-task-body";
db.insertTask({ id: TASK_BODY, projectId: projId, title: "Direct Body Write Card", body: "starts small", columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now });
const TASK_APPEND = "writespill-task-append";
db.insertTask({ id: TASK_APPEND, projectId: projId, title: "Append Card", body: "starts small too", columnKey: "backlog", position: 3, priority: "p2", createdAt: now, updatedAt: now });
const TASK_TRUNCATE = "writespill-task-truncate";
db.insertTask({ id: TASK_TRUNCATE, projectId: projId, title: "Truncate-Guard Card", body: bigBody, columnKey: "backlog", position: 4, priority: "p2", createdAt: now, updatedAt: now });
const TASK_CONFLICT = "writespill-task-conflict";
db.insertTask({ id: TASK_CONFLICT, projectId: projId, title: "Conflict-Guard Card", body: bigBody, columnKey: "backlog", position: 5, priority: "p2", createdAt: now, updatedAt: now });
const TASK_SMALL_UPDATE = "writespill-task-small-update";
db.insertTask({ id: TASK_SMALL_UPDATE, projectId: projId, title: "Small Update Card", body: "tiny", columnKey: "backlog", position: 6, priority: "p2", createdAt: now, updatedAt: now });

const fakePty = { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null };
const wakes = new WakeService({ db, pty: fakePty, resume: () => {} });

try {
  const server = new TaskMcpRouter(db, wakes).buildServer(projId, SESSION_ID);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "tasks-write-body-spill-test", version: "0" });
  await client.connect(clientT);
  const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

  // ═══════════════════════════════ (A) tasks_create ═══════════════════════════════
  const createdBig = await call("tasks_create", { title: "Big New Card", body: bigBody });
  check("(A) oversized tasks_create keeps id/title inline", typeof createdBig.id === "string" && createdBig.title === "Big New Card");
  check("(A) oversized tasks_create replaces body with bodyFile/bodyChars/note", createdBig.body === undefined && typeof createdBig.bodyFile === "string" && typeof createdBig.bodyChars === "number" && typeof createdBig.note === "string");
  check("(A) bodyChars exceeds the spill budget", createdBig.bodyChars > SPILL_INLINE_BUDGET_CHARS);
  check("(A) the spilled file lives under THIS session's own scratch dir", createdBig.bodyFile.startsWith(sessionScratchDir(SESSION_ID)));
  const expectedTextCreatedBig = `Big New Card\n\n${bigBody}`;
  const spilledTextCreatedBig = fs.readFileSync(createdBig.bodyFile, "utf8");
  check("(A) DoD-3: spilled file is BYTE-IDENTICAL to the exact text handed to the spill", spilledTextCreatedBig === expectedTextCreatedBig);
  check("(A) bodyChars matches the spilled text's own length", createdBig.bodyChars === spilledTextCreatedBig.length);

  const createdSmall = await call("tasks_create", { title: "Small New Card", body: "short body" });
  check("(A) below-cap tasks_create stays byte-identical to before (body inline, no pointer fields)", createdSmall.body === "short body" && createdSmall.bodyFile === undefined && createdSmall.bodyChars === undefined && createdSmall.note === undefined);

  // ═══════════════════════════════ (B) tasks_update — successful body-touching writes ═══════════════════════════════
  // (B1) a direct `body` write (with baseVersion) that grows past the cap.
  const bodyResult = await call("tasks_update", { id: TASK_BODY, body: bigBody, baseVersion: 1 });
  check("(B1) a body-touching tasks_update replaces body with bodyFile/bodyChars/note", bodyResult.body === undefined && typeof bodyResult.bodyFile === "string" && typeof bodyResult.bodyChars === "number");
  check("(B1) bodyChars exceeds the spill budget", bodyResult.bodyChars > SPILL_INLINE_BUDGET_CHARS);
  const dbRowAfterBody = db.getTask(TASK_BODY);
  check("(B1) the write actually landed on the DB row", dbRowAfterBody.body === bigBody);
  const expectedTextBody = `${dbRowAfterBody.title}\n\n${dbRowAfterBody.body}`;
  const spilledTextBody = fs.readFileSync(bodyResult.bodyFile, "utf8");
  check("(B1) DoD-3: spilled file is BYTE-IDENTICAL to the ACTUAL PERSISTED DB row (title+body)", spilledTextBody === expectedTextBody);

  // (B2) appendBody — pushes an initially-small body past the cap. Byte-identity is checked against the
  // REAL DB row (not a locally reconstructed guess) because appendBody's heading carries a server-stamped
  // timestamp this test cannot predict.
  const appendText = bigBody; // large enough alone to push the result over the spill cap
  const appendResult = await call("tasks_update", { id: TASK_APPEND, appendBody: appendText });
  check("(B2) appendBody past the cap ALSO spills (not just a plain `body` write)", appendResult.body === undefined && typeof appendResult.bodyFile === "string" && appendResult.bodyChars > SPILL_INLINE_BUDGET_CHARS);
  const dbRowAfterAppend = db.getTask(TASK_APPEND);
  check("(B2) the appended text actually landed in the DB row's body", dbRowAfterAppend.body.includes("starts small too") && dbRowAfterAppend.body.includes(appendText) && dbRowAfterAppend.body.includes("Triage note"));
  const expectedTextAppend = `${dbRowAfterAppend.title}\n\n${dbRowAfterAppend.body}`;
  const spilledTextAppend = fs.readFileSync(appendResult.bodyFile, "utf8");
  check("(B2) DoD-3: spilled file is BYTE-IDENTICAL to the ACTUAL PERSISTED DB row (title+body)", spilledTextAppend === expectedTextAppend);

  // ═══════════════════════════════ (C) tasks_update — field-only patch (TaskUpdateAck) ═══════════════════════════════
  // TASK_MOVE already carries an oversized body — a columnKey-only move must still return the TRIMMED
  // ack (never a body, spilled or otherwise) — byte-identical to before this card.
  const moveResult = await call("tasks_update", { id: TASK_MOVE, columnKey: "in_progress" });
  check("(C) field-only patch returns the trimmed ack with NO body field at all", !("body" in moveResult));
  check("(C) field-only patch's ack carries NO bodyFile/bodyChars/note (nothing to spill)", moveResult.bodyFile === undefined && moveResult.bodyChars === undefined && moveResult.note === undefined);
  check("(C) the ack still reflects the move", moveResult.columnKey === "in_progress" && Array.isArray(moveResult.changed) && moveResult.changed.includes("columnKey"));

  // ═══════════════════════════════ (D) tasks_update — conflict / truncation guards ═══════════════════════════════
  // (D1) TRUNCATION guard: a destructive body replace on TASK_TRUNCATE's big body, no allowTruncate.
  const truncResult = await call("tasks_update", { id: TASK_TRUNCATE, body: "oops, replaced almost everything" });
  check("(D1) truncation guard fires", truncResult.truncation === true && typeof truncResult.error === "string");
  check("(D1) truncation guard's `current` spills its oversized body", truncResult.current.body === undefined && typeof truncResult.current.bodyFile === "string" && truncResult.current.bodyChars > SPILL_INLINE_BUDGET_CHARS);
  const dbRowTruncate = db.getTask(TASK_TRUNCATE);
  check("(D1) TASK_TRUNCATE was NOT actually modified (guard rejected the write)", dbRowTruncate.body === bigBody);
  const expectedTextTrunc = `${dbRowTruncate.title}\n\n${dbRowTruncate.body}`;
  const spilledTextTrunc = fs.readFileSync(truncResult.current.bodyFile, "utf8");
  check("(D1) DoD-3: truncation guard's spilled `current` is BYTE-IDENTICAL to the unchanged DB row", spilledTextTrunc === expectedTextTrunc);

  // (D2) CONFLICT guard: an omitted baseVersion on a title/body write to TASK_CONFLICT's big body — the
  // replacement body is comparably sized (>=25% of current), so this hits the CONFLICT gate, not
  // truncation, isolating the two guards' spill wiring from one another.
  const conflictResult = await call("tasks_update", { id: TASK_CONFLICT, body: `${bigBody} (edited, no baseVersion)` });
  check("(D2) conflict guard fires (stale/omitted baseVersion)", conflictResult.conflict === true && typeof conflictResult.error === "string");
  check("(D2) conflict guard's `current` spills its oversized body", conflictResult.current.body === undefined && typeof conflictResult.current.bodyFile === "string" && conflictResult.current.bodyChars > SPILL_INLINE_BUDGET_CHARS);
  const dbRowConflict = db.getTask(TASK_CONFLICT);
  check("(D2) TASK_CONFLICT was NOT actually modified (guard rejected the write)", dbRowConflict.body === bigBody);
  const expectedTextConflict = `${dbRowConflict.title}\n\n${dbRowConflict.body}`;
  const spilledTextConflict = fs.readFileSync(conflictResult.current.bodyFile, "utf8");
  check("(D2) DoD-3: conflict guard's spilled `current` is BYTE-IDENTICAL to the unchanged DB row", spilledTextConflict === expectedTextConflict);
  // Two DIFFERENT tasks' spilled `current` must not collide on one scratch file.
  check("(D3) truncation's and conflict's spilled `current` files are DIFFERENT (keyed by task id)", truncResult.current.bodyFile !== conflictResult.current.bodyFile);

  // ═══════════════════════════════ (E) tasks_update — small (below-cap) body write ═══════════════════════════════
  const smallUpdateResult = await call("tasks_update", { id: TASK_SMALL_UPDATE, body: "still tiny", baseVersion: 1 });
  check("(E) below-cap tasks_update body write stays byte-identical to before (body inline, no pointer fields)", smallUpdateResult.body === "still tiny" && smallUpdateResult.bodyFile === undefined && smallUpdateResult.bodyChars === undefined && smallUpdateResult.note === undefined);

  // ═══════════════════════════════ (G) the OLD failure mode, demonstrated directly ═══════════════════
  const linesBody = spilledTextBody.split("\n");
  check("(G) the spilled file has MANY real lines (not the single-line host-spill shape)", linesBody.length === bigBody.split("\n").length + 2); // title + blank + body's own lines
  const markerLines = linesBody.filter((l) => l.includes("-L137"));
  check("(G) a line-scoped marker search returns exactly ONE line, not the whole file", markerLines.length === 1);

  await client.close();
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
}

// ═══════════════════════ (F) project_task_update — the loom-platform sibling ═══════════════════════
const dbFile2 = path.join(tmpHome, "twbs-platform.db");
const db2 = new Db(dbFile2);
db2.insertProject({ id: "pHome", name: "Loom Platform", repoPath: "C:/f", vaultPath: "C:/f", config: {}, createdAt: now, archivedAt: null, reserved: true });
db2.insertProject({ id: "pTarget", name: "Target", repoPath: "C:/f", vaultPath: "C:/f", config: {}, createdAt: now, archivedAt: null, reserved: false });
db2.insertAgent({ id: "agentLead", projectId: "pHome", name: "Lead", startupPrompt: "LEAD", position: 0 });
db2.insertSession({
  id: "PL", projectId: "pHome", agentId: "agentLead", engineSessionId: null, title: null, cwd: "C:/f",
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "platform",
});
const TASK_PLAT_BODY = "writespill-plat-task-body";
db2.insertTask({ id: TASK_PLAT_BODY, projectId: "pTarget", title: "Plat Body Card", body: "small on target", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
const TASK_PLAT_MOVE = "writespill-plat-task-move";
db2.insertTask({ id: TASK_PLAT_MOVE, projectId: "pTarget", title: "Plat Move Card", body: bigBody, columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now });

class SeamHost extends createSeamHost(PtyHost) { stop() {} }
const host2 = new SeamHost({ onEngineSessionId() {}, onBusy() {}, onContextStats() {}, onRateLimited() {}, onExit() {} });
const svc2 = new SessionService(db2, host2, new OrchestrationControl());

try {
  const platServer = new PlatformMcpRouter(db2, svc2).buildServer("PL");
  const [clientT2, serverT2] = InMemoryTransport.createLinkedPair();
  await platServer.connect(serverT2);
  const platClient = new Client({ name: "project-task-update-body-spill-test", version: "0" });
  await platClient.connect(clientT2);
  const platCall = async (name, args) => JSON.parse((await platClient.callTool({ name, arguments: args })).content[0].text);

  // (F1) single-taskId path — a body write that grows past the cap.
  const single = await platCall("project_task_update", { projectId: "pTarget", taskId: TASK_PLAT_BODY, body: bigBody, baseVersion: 1 });
  check("(F1) project_task_update single path spills the oversized body", single.body === undefined && typeof single.bodyFile === "string" && single.bodyChars > SPILL_INLINE_BUDGET_CHARS);
  const dbRowPlatBody = db2.getTask(TASK_PLAT_BODY);
  check("(F1) the write actually landed on the DB row", dbRowPlatBody.body === bigBody);
  const expectedTextPlat = `${dbRowPlatBody.title}\n\n${dbRowPlatBody.body}`;
  check("(F1) project_task_update's spilled file is byte-identical to the actual persisted DB row", fs.readFileSync(single.bodyFile, "utf8") === expectedTextPlat);
  check("(F1) project_task_update's spilled file lives under the CALLER session's ('PL') scratch dir", single.bodyFile.startsWith(sessionScratchDir("PL")));

  // (F2) batch taskIds path — a field-only move on an already-oversized task stays the trimmed ack.
  const batch = await platCall("project_task_update", { projectId: "pTarget", taskIds: [TASK_PLAT_MOVE], columnKey: "in_progress" });
  check("(F2) batch path returns one {taskId,task} entry per id", Array.isArray(batch) && batch.length === 1 && batch[0].taskId === TASK_PLAT_MOVE);
  check("(F2) a field-only batch move stays the trimmed ack (no body, nothing to spill)", !("body" in batch[0].task) && batch[0].task.bodyFile === undefined);

  await platClient.close();
} finally {
  try { db2.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile2 + ext, { force: true }); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — tasks_create, tasks_update, and project_task_update now spill an oversized body (including the nested `current` on a conflict/truncation refusal) through the shared spillTextIfLarge primitive instead of the host engine's own opaque single-line overflow-spill; every spilled write-path file is byte-identical to the ACTUAL PERSISTED DB row; a field-only patch's trimmed ack is untouched (never spilled, since it never carries a body); and below-cap writes stay byte-identical to before."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
