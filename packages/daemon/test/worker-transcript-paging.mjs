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
//
// Also guards the two READ LEAKS closed by task 14aee044: (a) `lastN` used to bypass the page char
// budget entirely (a bare `turns.slice(-lastN)`) — a large lastN on a large-turn transcript could pull
// an unbounded amount; (b) sequential offset->nextOffset paging had no bound on the AGGREGATE across
// many chained calls — each page was capped, but nothing stopped walking the whole transcript page by
// page. Both are now bounded (lastNTurns / applyAggregateWalkCap in sessions/transcript.ts).
//
// Also guards card 6f8742f8: a manager called worker_transcript({tailLines:"40"}) — `tailLines` isn't a
// real param (the real one is `lastN`) — and the SDK silently stripped the unknown key, returning the
// offset-0 default page as if no arg had been given at all. worker_transcript's inputSchema is now a
// strictShape() (mcp/arg-alias.ts), so an unknown/mistyped param is hard-rejected naming the bad key +
// the real params, instead of vanishing.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Db } from "../dist/db.js";
import { OrchestrationMcpRouter } from "../dist/mcp/orchestration.js";
import { engineTranscriptPath, TRANSCRIPT_AGGREGATE_CHAR_BUDGET } from "../dist/sessions/transcript.js";
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
db.insertSession({
  id: "W-HUGE", projectId: projId, agentId, engineSessionId: "eng-w-huge", title: null, cwd, processState: "live",
  resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker",
  parentSessionId: "M", taskId: "tk-huge", branch: "loom/w-huge",
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

// --- a HUGE transcript: enough ~10KB turns to blow past TRANSCRIPT_AGGREGATE_CHAR_BUDGET (the 10-page
// aggregate walk cap) with turns left over — proves a sequential offset->nextOffset walk stops EARLY
// (truncated:true) instead of re-ingesting the whole thing, even though each individual page is fine. ---
const HUGE_TURN_TEXT_LEN = 10_000;
const APPROX_TURN_CHARS = HUGE_TURN_TEXT_LEN + 20 /* index/prefix slack */ + 40 /* role + JSON overhead */;
const HUGE_TURN_COUNT = Math.ceil(TRANSCRIPT_AGGREGATE_CHAR_BUDGET / APPROX_TURN_CHARS) + 20;
const hugeFile = engineTranscriptPath(cwd, "eng-w-huge");
fs.mkdirSync(path.dirname(hugeFile), { recursive: true });
fs.writeFileSync(hugeFile, Array.from({ length: HUGE_TURN_COUNT }, (_, i) =>
  JSON.stringify({ type: i % 2 === 0 ? "user" : "assistant", message: { content: [{ type: "text", text: `huge-${i}-` + "x".repeat(HUGE_TURN_TEXT_LEN) }] } })
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

// ============================ (3b) LEAK FIX: lastN is bounded by the page char budget too — a large
// lastN whose total size exceeds the budget must return FEWER than N turns (the MOST RECENT ones),
// never the raw unbounded slice ============================
const lastAllBig = await call("worker_transcript", { workerSessionId: "W-BIG", lastN: BIG_TURN_COUNT });
check(`worker_transcript(W-BIG, lastN:${BIG_TURN_COUNT}) is bounded by the page char budget (got ${Array.isArray(lastAllBig) ? lastAllBig.length : "non-array"}, not the full ${BIG_TURN_COUNT})`,
  Array.isArray(lastAllBig) && lastAllBig.length > 0 && lastAllBig.length < BIG_TURN_COUNT);
check("worker_transcript budget-bounded lastN result still ends on the MOST RECENT turn",
  Array.isArray(lastAllBig) && lastAllBig[lastAllBig.length - 1].text.startsWith(`turn-${BIG_TURN_COUNT - 1}-`));

// ============================ (3c) LEAK FIX: sequential offset->nextOffset chaining across MANY pages
// is bounded in AGGREGATE — it must stop (truncated:true, nextOffset:null) before re-ingesting an
// entire huge transcript, even though every individual page stays within its own page budget ============
let hoff = 0, hseen = 0, hpages = 0, hTruncated = false;
while (hoff !== null) {
  const pg = await call("worker_transcript", { workerSessionId: "W-HUGE", offset: hoff });
  hseen += pg.returned;
  hpages++;
  if (pg.truncated) {
    hTruncated = true;
    check("aggregate-capped page forces nextOffset:null", pg.nextOffset === null);
    hoff = null;
  } else {
    hoff = pg.nextOffset;
  }
  if (hpages > 30) { check("huge-transcript walk terminates (runaway guard)", false); break; }
}
check(`sequential offset-walk of a HUGE transcript (${HUGE_TURN_COUNT} turns, ~${HUGE_TURN_COUNT * APPROX_TURN_CHARS} chars) is capped in aggregate — stopped after ${hseen} turns / ${hpages} pages (truncated=${hTruncated}), NOT the whole transcript`,
  hTruncated && hseen > 0 && hseen < HUGE_TURN_COUNT);

// A FRESH walk (offset:0 again — NOT continuing the capped walk's nextOffset) must not be penalized by
// the prior walk's consumption; it gets its own budget from scratch.
const freshAfterCap = await call("worker_transcript", { workerSessionId: "W-HUGE", offset: 0 });
check("a fresh offset:0 read after a capped walk is NOT pre-truncated by the prior walk's consumption",
  freshAfterCap.truncated !== true && freshAfterCap.returned > 0);

// ============================ (4) a SMALL transcript with no paging arg stays byte-shape backward-compat:
// the bare turns array, not an envelope — but an EXPLICIT paging arg still returns the envelope even
// though it fits in one page ============================
const smallDefault = await call("worker_transcript", { workerSessionId: "W-SMALL" });
check("worker_transcript(W-SMALL) no args, fits one page -> bare turns array (backward-compat)",
  Array.isArray(smallDefault) && smallDefault.length === 3);

const smallPaged = await call("worker_transcript", { workerSessionId: "W-SMALL", offset: 0 });
check("worker_transcript(W-SMALL, offset:0) explicit paging arg -> envelope even though it fits one page",
  !Array.isArray(smallPaged) && smallPaged.totalTurns === 3 && smallPaged.nextOffset === null);

// ============================ (5) card 6f8742f8: a mistyped/unknown param (e.g. the real incident's
// `tailLines`, guessed instead of the real `lastN`) is HARD-REJECTED naming the bad key + the real
// params, instead of being silently stripped by the SDK and defaulting to the offset-0 page as if no
// arg had been given at all ============================
const mistyped = await client.callTool({ name: "worker_transcript", arguments: { workerSessionId: "W-SMALL", tailLines: "40" } });
check("worker_transcript(W-SMALL, tailLines:\"40\") is rejected (isError), not silently defaulted",
  mistyped.isError === true);
check("rejection names the bad param `tailLines`",
  typeof mistyped.content?.[0]?.text === "string" && mistyped.content[0].text.includes("tailLines"));
check("rejection also names the real params (workerSessionId, lastN, offset, limit, turnRange)",
  typeof mistyped.content?.[0]?.text === "string" &&
  ["workerSessionId", "lastN", "offset", "limit", "turnRange"].every((p) => mistyped.content[0].text.includes(p)));

// A genuine lastN call is unaffected by the strict schema.
const last2Again = await call("worker_transcript", { workerSessionId: "W-BIG", lastN: 2 });
check("worker_transcript(W-BIG, lastN:2) still works under the strict schema",
  Array.isArray(last2Again) && last2Again.length === 2 && last2Again[1].text.startsWith("turn-9-"));

await client.close();
try { db.close(); } catch { /* ignore */ }
for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
try { fs.rmSync(sandboxHome, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — worker_transcript pages a large transcript in bounded envelopes (no overflow), offset paging covers the whole transcript with no gaps/overlaps, a small transcript stays backward-compatible, lastN still works and takes precedence (and is itself budget-bounded), a sequential offset-walk of a huge transcript is capped in aggregate instead of re-ingesting it whole, and a mistyped/unknown param is hard-rejected naming the bad key + the real params instead of silently defaulting."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
