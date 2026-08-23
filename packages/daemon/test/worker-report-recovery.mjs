import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Card 68d85015: `worker_transcript` truncated every rendered tool-call ARGUMENT at a fixed 200 chars
// (sessions/transcript.ts `extractText`, the `tool_use` branch) — a `worker_report` body IS a tool-call
// argument, so a manager reaching for the documented recovery ("pull worker_transcript(lastN:2)") got a
// 200-char stump of an 11K-char report. HERMETIC, NO daemon, NO claude: sandboxed HOME (nothing touches
// ~/.claude), a real Db, and the REAL OrchestrationMcpRouter driven in-process over InMemoryTransport —
// mirrors worker-transcript-paging.mjs / transcript-turns-spill.mjs's harness.
//
// Proves:
//   (RED)  The pre-fix shape (a bare `.slice(0, 200)` of the stringified tool-call input) genuinely
//          destroys a report body well past that point — demonstrated directly (not asserted) by
//          reproducing that exact slice here.
//   (A)    POST-FIX: the SAME oversized tool-call argument survives intact through `readTranscript` and
//          through the real `worker_transcript` MCP tool — no truncation, no cap re-introduced at a
//          bigger number.
//   (B)    The NEW `worker_report_get` tool recovers a filed report BYTE-IDENTICAL to what was filed,
//          straight from durable event storage — independent of transcript rendering entirely. Exceeds
//          200 chars by a wide margin (DoD-4's positive control: a short body could never fail this).
//   (C)    `eventId` (full id or an unambiguous 8-char prefix) selects a SPECIFIC earlier report, not
//          just the latest one.
//   (D)    Negative controls: no report filed, an unmatched eventId, and a worker outside the caller's
//          lineage all return a plain `{error}`, never a partial/best-effort result.
//   (E)    OVERSIZE: a summary past the shared inline-spill budget is written verbatim to the manager's
//          OWN scratch dir (byte-identical on disk) instead of being truncated at any fixed number.
// Run: 1) build daemon (pnpm build), 2) node test/worker-report-recovery.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- sandbox HOME so engineTranscriptPath's ~/.claude/projects/... never touches the real one, AND so
// sessionScratchDir's ~/.loom/tmp/scratch/... spill files land in a throwaway LOOM_HOME. ---
const sandboxHome = mkdtempManaged("loom-wrr-home-");
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME
process.env.LOOM_HOME = path.join(sandboxHome, ".loom");
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { readTranscript, engineTranscriptPath } = await import("../dist/sessions/transcript.js");
const { SPILL_INLINE_BUDGET_CHARS } = await import("../dist/spill.js");
const { sessionScratchDir } = await import("../dist/paths.js");

// --- hermetic Db (own temp file) ---
const dbFile = path.join(os.tmpdir(), `loom-wrr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const now = "2026-08-23T12:00:00.000Z";
const projId = "proj-wrr";
const agentId = "agent-wrr";
const cwd = path.join(sandboxHome, "repo");
fs.mkdirSync(cwd, { recursive: true });
db.insertProject({ id: projId, name: "WRR", repoPath: cwd, vaultPath: cwd, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

function seedSession(id, opts) {
  db.insertSession({
    id, projectId: projId, agentId, engineSessionId: `eng-${id}`, title: null, cwd, processState: "live",
    resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, ...opts,
  });
}
seedSession("M", { role: "manager" });
seedSession("M-OTHER", { role: "manager" }); // an unrelated manager, no lineage relation to M
seedSession("W-TX", { role: "worker", parentSessionId: "M", taskId: "tk-tx", branch: "loom/w-tx" });
seedSession("W", { role: "worker", parentSessionId: "M", taskId: "tk-w", branch: "loom/w" });
seedSession("W-EMPTY", { role: "worker", parentSessionId: "M", taskId: "tk-empty", branch: "loom/w-empty" });
seedSession("W-OTHER", { role: "worker", parentSessionId: "M-OTHER", taskId: "tk-other", branch: "loom/w-other" });

const ev = (workerId, mgrId, kind, detail) => {
  const evt = { id: randomUUID(), ts: now, managerSessionId: mgrId, workerSessionId: workerId, taskId: db.getSession(workerId)?.taskId ?? null, kind, detail };
  db.appendEvent(evt);
  return evt;
};

// ═══════════════════════════════ (RED) reproduce the PRE-FIX defeat directly ═══════════════════════════
const BIG_SUMMARY = "A".repeat(5_980) + "END-MARKER-ZZZ"; // 5994 chars — well past the old 200-char cap
const reportInput = { status: "done", summary: BIG_SUMMARY };
{
  const preFixSlice = JSON.stringify(reportInput).slice(0, 200);
  check("(RED) the pre-fix 200-char slice genuinely loses the tail of a real report body",
    !preFixSlice.includes("END-MARKER-ZZZ") && preFixSlice.length === 200);
}

// ═══════════════════════════ (A) POST-FIX: readTranscript + worker_transcript keep it whole ═══════════
const txFile = engineTranscriptPath(cwd, "eng-W-TX");
fs.mkdirSync(path.dirname(txFile), { recursive: true });
fs.writeFileSync(
  txFile,
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_bigreport01", name: "worker_report", input: reportInput }] },
  }) + "\n",
);
const parsedTurns = readTranscript(cwd, "eng-W-TX");
check("(A) fixture sanity: parses to exactly one turn", parsedTurns.length === 1);
check("(A) readTranscript keeps the FULL tool-call argument intact (marker survives)",
  parsedTurns[0]?.text.includes("END-MARKER-ZZZ"));
check("(A) readTranscript embeds the exact, complete stringified input — not a bigger-but-still-fixed cap",
  parsedTurns[0]?.text.includes(JSON.stringify(reportInput)));

const sessionsStub = { peekPendingMerge() { return undefined; }, listPendingSpawns() { return []; } };
const router = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub));
const server = router.buildServer("M", "manager");
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "worker-report-recovery-test", version: "0" });
await client.connect(clientT);
const parse = (res) => JSON.parse(res.content[0].text);
const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

const txResult = await call("worker_transcript", { workerSessionId: "W-TX" });
const txText = JSON.stringify(txResult);
check("(A) the real worker_transcript MCP tool ALSO returns the full argument, unmangled",
  txText.includes("END-MARKER-ZZZ") && txText.includes(JSON.stringify(reportInput).replace(/"/g, "\\\"")));

// ═══════════════════════════ (B) worker_report_get: byte-identical recovery ═══════════════════════════
// An OLDER report first (proves "latest wins" by default, and gives (C) something distinct to target).
const older = ev("W", "M", "worker_report", { status: "progress", summary: "first-checkpoint-marker-AAA" });
// The "lost" report: exceeds 200 chars by nearly 30x — a short body could never fail this control.
const LOST_BODY = "start-marker-" + "B".repeat(5_000) + "-mid-marker-" + "C".repeat(200) + "-end-marker-ZZZ";
check("(B) fixture sanity: the filed body is nowhere near the old 200-char cap", LOST_BODY.length > 5_000);
const newer = ev("W", "M", "worker_report", {
  status: "done", summary: LOST_BODY, prUrl: "https://example.com/pr/1", noChanges: true, managerTurnSeqAtReport: 42,
});

const latest = await call("worker_report_get", { workerSessionId: "W" });
check("(B) recovers the LATEST report by default", latest.eventId === newer.id);
check("(B) summary is BYTE-IDENTICAL to what was filed (===, not just substring)", latest.summary === LOST_BODY);
check("(B) status/prUrl/noChanges/managerTurnSeqAtReport all round-trip",
  latest.status === "done" && latest.prUrl === "https://example.com/pr/1" && latest.noChanges === true && latest.managerTurnSeqAtReport === 42);
check("(B) taskId carried through", latest.taskId === "tk-w");
check("(B) no spill fields on an inline-sized summary", latest.summaryFile === undefined && latest.summaryChars === undefined);

// ═══════════════════════════ (C) eventId selects a SPECIFIC earlier report ══════════════════════════════
const byFullId = await call("worker_report_get", { workerSessionId: "W", eventId: older.id });
check("(C) full eventId selects the OLDER report, not the latest", byFullId.eventId === older.id && byFullId.summary === "first-checkpoint-marker-AAA");
const byPrefix = await call("worker_report_get", { workerSessionId: "W", eventId: older.id.slice(0, 8) });
check("(C) an unambiguous 8-char id-prefix resolves the same way as the full id", byPrefix.eventId === older.id);

// ═══════════════════════════ (D) negative controls — plain {error}, never a partial result ═════════════
const noReports = await call("worker_report_get", { workerSessionId: "W-EMPTY" });
check("(D) a worker with zero worker_report events returns a plain error", typeof noReports.error === "string" && noReports.summary === undefined);

const badEventId = await call("worker_report_get", { workerSessionId: "W", eventId: "deadbeefdeadbeef" });
check("(D) an eventId matching nothing returns a plain error naming it", badEventId.error === "no worker_report event matching id deadbeefdeadbeef");

const notMine = await call("worker_report_get", { workerSessionId: "W-OTHER" });
check("(D) a worker outside the caller's lineage returns 'not your worker' (never leaks its report)", notMine.error === "not your worker");

// ═══════════════════════════ (E) OVERSIZE: spill, don't widen ═══════════════════════════════════════════
const HUGE_MARK_START = "HUGE-START-MARKER-";
const HUGE_MARK_END = "-HUGE-END-MARKER";
const HUGE_BODY = HUGE_MARK_START + "D".repeat(SPILL_INLINE_BUDGET_CHARS + 2_000) + HUGE_MARK_END;
const hugeEvt = ev("W", "M", "worker_report", { status: "done", summary: HUGE_BODY });
const hugeResult = await call("worker_report_get", { workerSessionId: "W", eventId: hugeEvt.id });
check("(E) an oversized summary is NOT inlined (no fixed-but-bigger cap)", hugeResult.summary === undefined);
check("(E) summaryFile + summaryChars + note are present instead",
  typeof hugeResult.summaryFile === "string" && hugeResult.summaryChars === HUGE_BODY.length && typeof hugeResult.note === "string");
check("(E) the spill file lives under the CALLING manager's own scratch dir",
  hugeResult.summaryFile.startsWith(sessionScratchDir("M")));
const spilledOnDisk = fs.readFileSync(hugeResult.summaryFile, "utf8");
check("(E) the spilled file is BYTE-IDENTICAL to the filed body — not truncated, not re-escaped",
  spilledOnDisk === HUGE_BODY);

await client.close();

try { db.close(); } catch { /* ignore */ }
for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
// sandboxHome cleanup is handled by mkdtempManaged (registered at process exit, card 995be21f).

console.log(failures === 0
  ? "\n✅ ALL PASS — an oversized tool-call argument (a worker_report body) is no longer truncated at a " +
    "fixed 200 chars by worker_transcript, and the new worker_report_get tool recovers a filed report " +
    "byte-identically straight from durable event storage, independent of transcript rendering, with " +
    "oversize bounded by spill (not a bigger fixed cap)."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
