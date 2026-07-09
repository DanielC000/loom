import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_transcript PAGE ENVELOPE — mirrors the auditor's transcript_read paging so a large worker
// transcript can never overflow into an unreadable 1-line spill file. HERMETIC, NO claude, NO external
// daemon: seeds a real Db (sessions only) + a REAL transcript JSONL on disk (under a sandboxed HOME so
// nothing touches ~/.claude), and drives worker_transcript in-process over an InMemoryTransport,
// mirroring worker-lineage-scope.mjs's harness.
//
// The bug this guards: worker_transcript took only {workerSessionId, lastN?} and returned the RAW turns
// array (or a bare slice(-lastN)) — absent lastN it serialized the ENTIRE transcript, which overflows the
// MCP tool-result cap on a large transcript and spills to a 1-line temp file a manager's Read tool can't
// page. This proves the fix: worker_transcript now shares the SAME bounded page envelope {turns,
// totalTurns, offset, returned, nextOffset} the auditor's transcript_read already uses, offset/limit
// pages it deterministically with no gaps/overlaps, a default call on a small transcript stays
// byte-shape backward-compatible (bare array), and lastN keeps working (and takes precedence).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { OrchestrationMcpRouter } from "../dist/mcp/orchestration.js";
import { engineTranscriptPath } from "../dist/sessions/transcript.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- sandbox HOME so engineTranscriptPath's ~/.claude/projects/... never touches the real one ---
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-wtp-home-"));
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

// --- hermetic Db (own temp file) ---
const dbFile = path.join(os.tmpdir(), `loom-wtp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const now = "2026-07-09T12:00:00.000Z";
const projId = "proj-wtp";
const agentId = "agent-wtp";
const cwd = path.join(sandboxHome, "repo");
fs.mkdirSync(cwd, { recursive: true });
db.insertProject({ id: projId, name: "WTP", repoPath: cwd, vaultPath: cwd, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

db.insertSession({
  id: "M", projectId: projId, agentId, engineSessionId: "eng-M", title: null, cwd, processState: "live",
  resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager",
});
db.insertSession({
  id: "W-BIG", projectId: projId, agentId, engineSessionId: "eng-w-big", title: null, cwd, processState: "live",
  resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker",
  parentSessionId: "M", taskId: "tk-big", branch: "loom/w-big",
});
db.insertSession({
  id: "W-SMALL", projectId: projId, agentId, engineSessionId: "eng-w-small", title: null, cwd, processState: "live",
  resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker",
  parentSessionId: "M", taskId: "tk-small", branch: "loom/w-small",
});

// --- a LARGE transcript on disk: 10 turns of ~10KB text each — big enough that the default page budget
// (~48KB) can't fit them all in one shot, so worker_transcript() with NO args must return a page
// envelope, not the whole array. ---
const BIG_TURN_COUNT = 10;
const bigFile = engineTranscriptPath(cwd, "eng-w-big");
fs.mkdirSync(path.dirname(bigFile), { recursive: true });
fs.writeFileSync(bigFile, Array.from({ length: BIG_TURN_COUNT }, (_, i) =>
  JSON.stringify({ type: i % 2 === 0 ? "user" : "assistant", message: { content: [{ type: "text", text: `turn-${i}-` + "x".repeat(10_000) }] } })
).join("\n") + "\n");

// --- a SMALL transcript: 3 short turns, fits comfortably in one page — worker_transcript() with no args
// must stay backward-compatible and return the bare turns array (today's shape). ---
const smallFile = engineTranscriptPath(cwd, "eng-w-small");
fs.mkdirSync(path.dirname(smallFile), { recursive: true });
fs.writeFileSync(smallFile, Array.from({ length: 3 }, (_, i) =>
  JSON.stringify({ type: i % 2 === 0 ? "user" : "assistant", message: { content: [{ type: "text", text: `small-turn-${i}` }] } })
).join("\n") + "\n");

// --- drive the REAL manager MCP tools in-process (worker_transcript only reads `db`; `sessions` is
// unused by it, so a minimal stub covering the OTHER read tools' needs is enough). ---
const sessionsStub = {
  peekPendingMerge() { return undefined; },
  listPendingSpawns() { return []; },
};
const router = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub));
const server = router.buildServer("M", "manager");
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "worker-transcript-paging-test", version: "0" });
await client.connect(clientT);
const parse = (res) => JSON.parse(res.content[0].text);
const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

// ============================ (1) NO overflow: a default call on a LARGE transcript returns a BOUNDED
// first page, not the whole thing ============================
const firstPage = await call("worker_transcript", { workerSessionId: "W-BIG" });
check("worker_transcript(W-BIG) no args -> a page envelope (NOT the bare full array)",
  !Array.isArray(firstPage) && Array.isArray(firstPage.turns));
check(`worker_transcript(W-BIG) first page: totalTurns=${BIG_TURN_COUNT}, offset=0, bounded < total (got ${JSON.stringify({ totalTurns: firstPage.totalTurns, offset: firstPage.offset, returned: firstPage.returned, nextOffset: firstPage.nextOffset })})`,
  firstPage.totalTurns === BIG_TURN_COUNT && firstPage.offset === 0 &&
  firstPage.returned > 0 && firstPage.returned < BIG_TURN_COUNT && typeof firstPage.nextOffset === "number");

// ============================ (2) paging via offset walks the WHOLE transcript, no gaps/overlaps, last
// page nextOffset:null ============================
let off = 0, seen = 0, pages = 0;
while (off !== null) {
  const pg = await call("worker_transcript", { workerSessionId: "W-BIG", offset: off });
  check(`worker_transcript(W-BIG, offset:${off}) returns a page`, !Array.isArray(pg) && pg.offset === off);
  seen += pg.returned;
  pages++;
  if (pg.nextOffset === null) { off = null; } else {
    check(`page @${off}: nextOffset advances exactly past this page (no overlap, no gap)`, pg.nextOffset === off + pg.returned);
    off = pg.nextOffset;
  }
  if (pages > 20) { check("paging terminates (runaway guard)", false); break; }
}
check(`paging W-BIG start->nextOffset->...->null covered all ${BIG_TURN_COUNT} turns exactly once (got ${seen} across ${pages} pages)`,
  seen === BIG_TURN_COUNT && pages >= 2);

// ============================ (3) lastN still works (backward-compat), returns a bare array, and takes
// PRECEDENCE over any paging args passed alongside it ============================
const last2 = await call("worker_transcript", { workerSessionId: "W-BIG", lastN: 2 });
check("worker_transcript(W-BIG, lastN:2) returns a bare array of the last 2 turns",
  Array.isArray(last2) && last2.length === 2 && last2[1].text.startsWith("turn-9-"));

const lastWithOffset = await call("worker_transcript", { workerSessionId: "W-BIG", lastN: 1, offset: 5 });
check("worker_transcript(W-BIG, lastN:1, offset:5) — lastN wins, still a bare 1-element array",
  Array.isArray(lastWithOffset) && lastWithOffset.length === 1 && lastWithOffset[0].text.startsWith("turn-9-"));

// ============================ (4) a SMALL transcript with no paging arg stays byte-shape backward-compat:
// the bare turns array, not an envelope — but an EXPLICIT paging arg still returns the envelope even
// though it fits in one page ============================
const smallDefault = await call("worker_transcript", { workerSessionId: "W-SMALL" });
check("worker_transcript(W-SMALL) no args, fits one page -> bare turns array (backward-compat)",
  Array.isArray(smallDefault) && smallDefault.length === 3);

const smallPaged = await call("worker_transcript", { workerSessionId: "W-SMALL", offset: 0 });
check("worker_transcript(W-SMALL, offset:0) explicit paging arg -> envelope even though it fits one page",
  !Array.isArray(smallPaged) && smallPaged.totalTurns === 3 && smallPaged.nextOffset === null);

await client.close();
try { db.close(); } catch { /* ignore */ }
for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
try { fs.rmSync(sandboxHome, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_transcript pages a large transcript in bounded envelopes (no overflow), offset paging covers the whole transcript with no gaps/overlaps, a small transcript stays backward-compatible, and lastN still works and takes precedence."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
