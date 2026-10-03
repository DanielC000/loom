import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card d56c6ef0 finding 1 — tasks_list's `parentId` filter used a raw `t.parentId.startsWith(parentId)`
// with NO 8-char minimum and NO ambiguity check, unlike every other id-prefix resolver in this codebase
// (tasks_get/worker_spawn's own id args, both backed by `resolveIdPrefix`/`resolveProjectTaskId`). Two
// concrete failure modes followed:
//   - a prefix SHORTER than 8 chars, shared by two different parent tasks, silently POOLED both parents'
//     children into one result — no error, no signal, just the wrong (merged) child set.
//   - an 8-char-or-longer prefix that is still genuinely ambiguous (two parents share it) silently picked
//     whichever parent's children happened to match first, instead of erroring.
//
// FIX: `parentId` now resolves through `resolveParentIdFilter` (mcp/tasks.ts), which wraps the SAME
// shared `resolveIdPrefix` resolver `tasks_get`/`worker_spawn` already use — exact id always wins, an
// 8+-char unambiguous prefix resolves to the one real parent, an ambiguous prefix is reported as an error
// naming every candidate, and anything else (too short, or no match at all) resolves to "no match" (zero
// children), never a silent cross-parent pool. The `tasks_list` tool handler (mcp/server.ts) checks this
// BEFORE either the row-fetch or the countsOnly path, so both surfaces get the SAME ambiguity error.
//
// HERMETIC, CLAUDE-FREE, NETWORK-FREE: isolated LOOM_HOME + sandboxed HOME, a REAL Db, the REAL
// TaskMcpRouter over an in-process MCP InMemoryTransport (no HTTP, no daemon, no pty) for the tool-level
// ambiguity-error assertions, plus direct calls into the built `mcp/tasks.js` module for the lower-level
// resolver + filter correctness assertions. Mirrors tasks-get-body-spill.mjs's harness shape.
//
// Proves:
//   (R) resolveParentIdFilter: exact id always wins; an unambiguous 8-char prefix resolves to the full
//       parent id; an ambiguous 8-char prefix (two parents share it) returns {error} naming BOTH
//       candidates; a too-short (<8 char) ref and a well-formed but non-existent id both resolve to
//       `{parentId:null}` (never an error, never a silent pick).
//   (B) THE BUG, directly: a short (<8 char) prefix shared by two real, DIFFERENT parents — given to the
//       OLD naive `startsWith` filter — would have pooled both parents' children into one list. The FIXED
//       filter returns ZERO children for it instead (too short to safely resolve), never the wrongly
//       merged set.
//   (C) a full parent id, and an unambiguous 8-char prefix of it, both return EXACTLY that parent's own
//       direct children — never a sibling parent's.
//   (N) a well-formed but non-existent parentId is a plain empty result, not an error (mirrors idPrefix's
//       own "no match ⇒ empty" convention).
//   (A) the `tasks_list` MCP tool: an ambiguous parentId prefix returns {error} naming both candidate
//       parent ids, on BOTH the normal row-fetch path and the countsOnly path — and never silently
//       returns rows/counts for either.
//
// Run: 1) build (turbo builds shared first), 2) node test/tasks-list-parentid-prefix-resolve.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-tlppr-${Date.now()}-${process.pid}`);
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
const { resolveParentIdFilter, listProjectTasks } = await import("../dist/mcp/tasks.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const dbFile = path.join(tmpHome, "tlppr.db");
const db = new Db(dbFile);
const projId = "p-parentid";
const SESSION_ID = "S-PARENTID";
db.insertProject({ id: projId, name: "ParentId Project", repoPath: "C:/f", vaultPath: "C:/f", config: {}, createdAt: now, archivedAt: null, reserved: false });
const agentId = "parentid-agent";
db.insertAgent({ id: agentId, projectId: projId, name: "Manager", startupPrompt: "BRIEF", position: 0 });
db.insertSession({
  id: SESSION_ID, projectId: projId, agentId, engineSessionId: "eng-parentid", title: null, cwd: "C:/f",
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now,
  lastError: null, role: "manager",
});

// Two DIFFERENT parents sharing the SAME 8-char prefix "aaaaaaaa" — the ambiguous case.
const P1 = "aaaaaaaa-1111-4000-8000-000000000001";
const P2 = "aaaaaaaa-2222-4000-8000-000000000002";
// A third parent with its OWN unambiguous prefix.
const P3 = "bbbbbbbb-3333-4000-8000-000000000003";
db.insertTask({ id: P1, projectId: projId, title: "Parent One", body: "", columnKey: "backlog", position: 1, priority: "p2", createdAt: now, updatedAt: now });
db.insertTask({ id: P2, projectId: projId, title: "Parent Two", body: "", columnKey: "backlog", position: 2, priority: "p2", createdAt: now, updatedAt: now });
db.insertTask({ id: P3, projectId: projId, title: "Parent Three", body: "", columnKey: "backlog", position: 3, priority: "p2", createdAt: now, updatedAt: now });

const C1 = "cccccccc-0000-4000-8000-000000000011";
const C2 = "dddddddd-0000-4000-8000-000000000012";
const C3 = "eeeeeeee-0000-4000-8000-000000000013";
db.insertTask({ id: C1, projectId: projId, title: "Child of P1", body: "", columnKey: "backlog", position: 11, priority: "p2", createdAt: now, updatedAt: now, parentId: P1 });
db.insertTask({ id: C2, projectId: projId, title: "Child of P2", body: "", columnKey: "backlog", position: 12, priority: "p2", createdAt: now, updatedAt: now, parentId: P2 });
db.insertTask({ id: C3, projectId: projId, title: "Child of P3", body: "", columnKey: "backlog", position: 13, priority: "p2", createdAt: now, updatedAt: now, parentId: P3 });

const fakePty = { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getActiveTurnOrigin: () => null };
const wakes = new WakeService({ db, pty: fakePty, resume: () => {} });

try {
  // ═══════════════════════════ (R) resolveParentIdFilter — direct unit checks ═══════════════════════════
  const exact = resolveParentIdFilter(db, projId, P1);
  check("(R) an EXACT full id always resolves, any length", !("error" in exact) && exact.parentId === P1);

  const unambiguousPrefix = resolveParentIdFilter(db, projId, P3.slice(0, 8));
  check("(R) an unambiguous 8-char prefix resolves to the full parent id", !("error" in unambiguousPrefix) && unambiguousPrefix.parentId === P3);

  const ambiguous = resolveParentIdFilter(db, projId, "aaaaaaaa");
  check("(R) an ambiguous 8-char prefix returns {error}, never a silent pick", "error" in ambiguous);
  check("(R) the ambiguous error names BOTH candidate parent ids", ambiguous.error.includes(P1) && ambiguous.error.includes(P2));

  const tooShort = resolveParentIdFilter(db, projId, "aaaaaaa"); // 7 chars — below MIN_ID_PREFIX_LEN
  check("(R) a too-short (<8 char) ref resolves to {parentId:null}, not an error", !("error" in tooShort) && tooShort.parentId === null);

  const noMatch = resolveParentIdFilter(db, projId, "ffffffff-0000-4000-8000-000000000099");
  check("(R) a well-formed but non-existent id resolves to {parentId:null}, not an error", !("error" in noMatch) && noMatch.parentId === null);

  // ═══════════════════════ (B) THE BUG, directly: a short shared prefix pools nothing (not everything) ═══
  const shortPrefixRows = await listProjectTasks(db, projId, { parentId: "aaaaaaa" }); // 7 chars, shared by P1 AND P2
  check(
    "(B) THE FIX: a too-short prefix shared by two real parents returns ZERO children — the OLD naive " +
    "startsWith filter would have pooled BOTH P1's and P2's children (C1 AND C2) into this result",
    shortPrefixRows.length === 0,
  );

  // ═══════════════════════ (C) a real parent's children, by full id and by unambiguous prefix ═══════════
  const byFullId = await listProjectTasks(db, projId, { parentId: P1 });
  check("(C) a full parent id returns EXACTLY that parent's own children", byFullId.length === 1 && byFullId[0].id === C1);

  const byPrefix = await listProjectTasks(db, projId, { parentId: P3.slice(0, 8) });
  check("(C) an unambiguous 8-char prefix returns EXACTLY that parent's own children", byPrefix.length === 1 && byPrefix[0].id === C3);

  const p2Rows = await listProjectTasks(db, projId, { parentId: P2 });
  check("(C) a DIFFERENT parent's full id returns ONLY its own child, never a sibling's", p2Rows.length === 1 && p2Rows[0].id === C2);

  // ═══════════════════════════════ (N) non-existent parentId ⇒ plain empty, not an error ═══════════════
  const nonExistentRows = await listProjectTasks(db, projId, { parentId: "ffffffff-0000-4000-8000-000000000099" });
  check("(N) a well-formed but non-existent parentId is a plain empty result", Array.isArray(nonExistentRows) && nonExistentRows.length === 0);

  // ═══════════════════════════════ (A) the tasks_list MCP tool boundary ═══════════════════════════════
  const server = new TaskMcpRouter(db, wakes).buildServer(projId, SESSION_ID);
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "tasks-list-parentid-prefix-resolve-test", version: "0" });
  await client.connect(clientT);
  // tasks_list's genuinely-complete, non-explicit-paged response is bare NDJSON (one task object per
  // line, NOT a JSON array) — an {error} response, by contrast, is always a single JSON object. Parse
  // defensively: try whole-text JSON.parse first (catches an {error} object OR a single-row NDJSON
  // response, which happens to also be valid JSON); fall back to NDJSON line-splitting otherwise.
  const rawText = async (args) => (await client.callTool({ name: "tasks_list", arguments: args })).content[0].text;
  const parseResult = (text) => {
    try { return { whole: JSON.parse(text) }; } catch { /* fall through to NDJSON */ }
    return { rows: text.split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
  };

  const ambiguousText = await rawText({ parentId: "aaaaaaaa" });
  const ambiguousParsed = parseResult(ambiguousText);
  check("(A) tasks_list: an ambiguous parentId prefix returns {error}, never rows", !!ambiguousParsed.whole && typeof ambiguousParsed.whole.error === "string");
  check("(A) tasks_list: the error names BOTH candidate parent ids", ambiguousParsed.whole.error.includes(P1) && ambiguousParsed.whole.error.includes(P2));

  const ambiguousCountsText = await rawText({ parentId: "aaaaaaaa", countsOnly: true });
  const ambiguousCountsParsed = JSON.parse(ambiguousCountsText);
  check("(A) tasks_list countsOnly: the SAME ambiguous parentId ALSO returns {error}, never a (wrong) count", typeof ambiguousCountsParsed.error === "string" && ambiguousCountsParsed.total === undefined);

  const okText = await rawText({ parentId: P1 });
  const okParsed = parseResult(okText);
  const rowsOk = okParsed.rows ?? (Array.isArray(okParsed.whole) ? okParsed.whole : [okParsed.whole]);
  check("(A) tasks_list: an unambiguous full parentId still returns the real rows (not swallowed by the new check)", Array.isArray(rowsOk) && rowsOk.length === 1 && rowsOk[0].id === C1);

  await client.close();
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — tasks_list's `parentId` now resolves through the SAME shared id-prefix resolver tasks_get/worker_spawn use: an unambiguous full id or 8-char prefix resolves to exactly that parent's children, an ambiguous prefix errors naming every candidate (on both the row-fetch and countsOnly paths), and a too-short or non-existent prefix is a plain empty result rather than silently pooling two different parents' children."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
