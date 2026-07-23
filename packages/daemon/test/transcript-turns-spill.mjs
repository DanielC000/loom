import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_transcript / transcript_read OVERSIZED-TURN spill (card 605988ab, gap (c) of auditor finding
// 8a942a95). HERMETIC, NO daemon, NO claude: sandboxed HOME (nothing touches ~/.claude), a real Db, and
// the REAL OrchestrationMcpRouter + registerTranscriptReadTools driven in-process over InMemoryTransport /
// a bare McpServer — mirrors worker-transcript-paging.mjs's harness.
//
// THE BUG IT GUARDS: `pageTranscript` bounds a page's SIZE but always includes >=1 turn regardless of
// that turn's own size (a single message can legitimately carry many/large batched tool_result blocks —
// e.g. several browser_snapshot calls). worker_transcript/transcript_read handed such a turn straight to
// `JSON.stringify` (the `ok()` envelope), which escapes every real newline INSIDE the turn's own
// already-rendered text (a tool_result body is human-readable, often multi-line YAML) into a literal
// two-char `\n` — so once the response is big enough for the host engine's own overflow-spill to kick in,
// the spilled file is ONE giant unpageable line: `Read` can't offset/limit it, and a line-scoped `grep`
// for one marker pulls back the ENTIRE blob instead of just that turn.
//
// FIX: `spillableTurnsResponse` (sessions/transcript.ts) proactively spills an oversized turns payload to
// the RECIPIENT session's own scratch dir as plain text (real per-turn line breaks preserved verbatim,
// explicit UTF-8) BEFORE the engine ever sees it, returning a small {turnsFile,turnsChars,note} pointer
// instead — generalizing the same pattern `SessionService.spillMergePatch` already used for worker_merge's
// fullDiff, onto the ACTUAL live gap (worker_transcript/transcript_read never got that treatment before).
//
// Proves:
//   (RED) The PRE-FIX shape (plain `JSON.stringify` of the turns) genuinely defeats line-scoped access on
//         an oversized turn — demonstrated directly (not asserted) by reproducing that exact
//         serialization here and showing a marker search can't be scoped to one line.
//   (A)   SMALL transcript — response BYTE-IDENTICAL to before: bare turns array, no spill fields.
//   (B)   OVERSIZED single turn (a realistic batched-tool-result turn, >40K chars, well under any
//         individual tool_result's own 2KB cap so nothing here is truncated by that separate mechanism)
//         — `turns` replaced by a pointer; envelope metadata (when present) stays inline.
//   (C)   The spilled file lives under the RECIPIENT session's own scratch dir and is ACTUALLY
//         grep/Read-pageable: real per-turn line breaks, a targeted marker resolves to its OWN line
//         without pulling in the other markers, and non-ASCII content round-trips.
//   (D)   Repeat pulls overwrite the same deterministic path (no scratch-dir accumulation).
//   (E)   The SAME fix, reached via transcript_read (registerTranscriptReadTools) — proves the "shared
//         writer" premise: one function, two independent call sites, not a per-tool patch.
// Run: 1) build daemon (pnpm build), 2) node test/transcript-turns-spill.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- sandbox HOME so engineTranscriptPath's ~/.claude/projects/... never touches the real one, AND so
// sessionScratchDir's ~/.loom/tmp/scratch/... spill files land in a throwaway LOOM_HOME. ---
const sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), "loom-tts-home-"));
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME
process.env.LOOM_HOME = path.join(sandboxHome, ".loom");
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { registerTranscriptReadTools } = await import("../dist/mcp/transcript-read.js");
const { engineTranscriptPath, TRANSCRIPT_PAGE_CHAR_BUDGET } = await import("../dist/sessions/transcript.js");
const { sessionScratchDir } = await import("../dist/paths.js");

// ── build a REALISTIC oversized single turn: one batched tool-result message (like several
// browser_snapshot calls landing in one turn), each block's OWN body well under the unrelated
// per-tool-result 2KB truncation cap (so nothing here gets truncated by THAT separate mechanism) but the
// turn's TOTAL text comfortably exceeds TRANSCRIPT_PAGE_CHAR_BUDGET. Each block carries a UNIQUE marker
// (MARKER-NNN) plus non-ASCII/box-drawing content so line-scoped grep-ability and UTF-8 survival are both
// genuinely exercised, not just ASCII padding. ──────────────────────────────────────────────────────────
const N_BLOCKS = 30;
function toolResultBlock(n) {
  const tag = String(n).padStart(3, "0");
  const header = `page: /nav/step-${n} ⇒ λ\nurl: https://example.com/step-${n}\nelements:\n  - role: link\n    name: MARKER-${tag}\n`;
  const fillerLine = "  - text: ─── filler line padding this block to a realistic size ───\n";
  const need = 1700 - header.length;
  const repeats = Math.max(1, Math.ceil(need / fillerLine.length));
  return { type: "tool_result", tool_use_id: `toolu_${tag}`, content: header + fillerLine.repeat(repeats) };
}
const bigBlocks = Array.from({ length: N_BLOCKS }, (_, n) => toolResultBlock(n));
const bigMessageLine = JSON.stringify({ type: "user", message: { content: bigBlocks } });

// --- hermetic Db (own temp file) ---
const dbFile = path.join(os.tmpdir(), `loom-tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.db`);
const db = new Db(dbFile);
const now = "2026-07-23T12:00:00.000Z";
const projId = "proj-tts";
const agentId = "agent-tts";
const cwd = path.join(sandboxHome, "repo");
fs.mkdirSync(cwd, { recursive: true });
db.insertProject({ id: projId, name: "TTS", repoPath: cwd, vaultPath: cwd, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: agentId, projectId: projId, name: "t", startupPrompt: "orchestrate", position: 0 });

db.insertSession({
  id: "M", projectId: projId, agentId, engineSessionId: "eng-M", title: null, cwd, processState: "live",
  resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "manager",
});
db.insertSession({
  id: "W-HUGE-TURN", projectId: projId, agentId, engineSessionId: "eng-w-huge-turn", title: null, cwd, processState: "live",
  resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker",
  parentSessionId: "M", taskId: "tk-huge-turn", branch: "loom/w-huge-turn",
});
db.insertSession({
  id: "W-SMALL", projectId: projId, agentId, engineSessionId: "eng-w-small", title: null, cwd, processState: "live",
  resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker",
  parentSessionId: "M", taskId: "tk-small", branch: "loom/w-small",
});

// --- write the transcripts to disk ---
const hugeFile = engineTranscriptPath(cwd, "eng-w-huge-turn");
fs.mkdirSync(path.dirname(hugeFile), { recursive: true });
fs.writeFileSync(hugeFile, bigMessageLine + "\n"); // a SINGLE turn — the whole transcript is this one oversized turn

const smallFile = engineTranscriptPath(cwd, "eng-w-small");
fs.mkdirSync(path.dirname(smallFile), { recursive: true });
fs.writeFileSync(smallFile, Array.from({ length: 3 }, (_, i) =>
  JSON.stringify({ type: i % 2 === 0 ? "user" : "assistant", message: { content: [{ type: "text", text: `small-turn-${i}` }] } })
).join("\n") + "\n");

check(`fixture sanity: the single-turn transcript's raw JSONL is itself well over the inline cap (${bigMessageLine.length} > ${TRANSCRIPT_PAGE_CHAR_BUDGET})`,
  bigMessageLine.length > TRANSCRIPT_PAGE_CHAR_BUDGET);

// ═══════════════════════════════════ (RED) reproduce the PRE-FIX defeat directly ═══════════════════════
// This is exactly what `ok(turns)` used to hand back: `JSON.stringify` of the turns array, no spill, no
// line-break preservation. Demonstrate — not assert — that it defeats line-scoped access.
{
  const { readTranscript } = await import("../dist/sessions/transcript.js");
  const rawTurns = readTranscript(cwd, "eng-w-huge-turn");
  check("fixture sanity: parses to exactly ONE turn", rawTurns.length === 1);
  const preFixText = JSON.stringify(rawTurns); // the old `ok()` envelope's text field
  const preFixLines = preFixText.split("\n");
  check(`(RED) pre-fix JSON.stringify collapses the whole ${preFixText.length}-char turn into ONE line (got ${preFixLines.length} line(s))`,
    preFixLines.length === 1);
  // A "grep" for one specific marker on the pre-fix blob can only ever return the WHOLE line — there is
  // no way to scope it to just that marker's own content.
  const hitLines = preFixLines.filter((l) => l.includes("MARKER-015"));
  check("(RED) a line-scoped grep for one marker on the pre-fix blob returns the ENTIRE oversized blob, not a scoped hit",
    hitLines.length === 1 && hitLines[0].length === preFixText.length && hitLines[0].includes("MARKER-000") && hitLines[0].includes("MARKER-029"));
}

// ═══════════════════════════════════ drive the REAL worker_transcript tool ══════════════════════════════
const sessionsStub = { peekPendingMerge() { return undefined; }, listPendingSpawns() { return []; } };
const router = new OrchestrationMcpRouter(db, /** @type {any} */ (sessionsStub));
const server = router.buildServer("M", "manager");
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "transcript-turns-spill-test", version: "0" });
await client.connect(clientT);
const rawText = (res) => res.content[0].text;
const parse = (res) => JSON.parse(res.content[0].text);
const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

// ── (A) SMALL transcript — byte-identical to before: bare array, no spill fields anywhere. ─────────────
const smallRes = await client.callTool({ name: "worker_transcript", arguments: { workerSessionId: "W-SMALL" } });
const small = JSON.parse(rawText(smallRes));
check("(A) small transcript: bare turns array (unchanged shape)", Array.isArray(small) && small.length === 3);
check("(A) small transcript: no spill fields leak into a below-cap response", !rawText(smallRes).includes("turnsFile"));

// ── (B) OVERSIZED single turn, default call (no paging args) — pointer, not the inline array. ──────────
const hugeRes = await client.callTool({ name: "worker_transcript", arguments: { workerSessionId: "W-HUGE-TURN" } });
const huge = JSON.parse(rawText(hugeRes));
check("(B) oversized turn: NOT a bare array (spilled)", !Array.isArray(huge));
check("(B) oversized turn: turnsFile + turnsChars + note present, turns ABSENT",
  typeof huge.turnsFile === "string" && typeof huge.turnsChars === "number" && huge.turnsChars > TRANSCRIPT_PAGE_CHAR_BUDGET &&
  typeof huge.note === "string" && huge.turns === undefined);

// ── (C) the spilled file: lives under the MANAGER's (recipient's) own scratch dir, real line breaks,
// genuinely line-scoped grep-able, UTF-8 round-trips. ────────────────────────────────────────────────
check("(C) turnsFile lives under the RECIPIENT (manager M)'s own session scratch dir",
  huge.turnsFile.startsWith(sessionScratchDir("M")));
check("(C) the recipient can actually read the pointer (file exists, non-empty)",
  fs.existsSync(huge.turnsFile) && fs.statSync(huge.turnsFile).size > 0);

const spilledText = fs.readFileSync(huge.turnsFile, "utf8");
check("(C) spill file byte-length matches turnsChars", spilledText.length === huge.turnsChars);
const spilledLines = spilledText.split("\n");
check(`(C) spill file has REAL line breaks — many discrete lines, not one giant line (got ${spilledLines.length})`,
  spilledLines.length > 100);

// Line-scoped "grep": a single marker resolves to its OWN small set of lines, NOT the whole file.
const markerLines = spilledLines.filter((l) => l.includes("MARKER-015"));
check("(C) grep for ONE marker returns a SMALL, scoped hit (its own line), not the whole spill",
  markerLines.length === 1 && markerLines[0].length < 200);
check("(C) that scoped hit does NOT also contain unrelated markers (genuinely line-bounded)",
  !markerLines[0].includes("MARKER-000") && !markerLines[0].includes("MARKER-029"));
// Every distinct block's marker is present SOMEWHERE (nothing silently dropped/truncated).
const allMarkersPresent = Array.from({ length: N_BLOCKS }, (_, n) => `MARKER-${String(n).padStart(3, "0")}`)
  .every((m) => spilledText.includes(m));
check("(C) every block's marker survived the spill (content preserved, not truncated)", allMarkersPresent);
check("(C) non-ASCII/box-drawing content round-tripped through the UTF-8 write",
  spilledText.includes("⇒") && spilledText.includes("λ") && spilledText.includes("─"));

// Read-offset/limit-style access: slicing an arbitrary line range around a known marker's line gets
// exactly that neighborhood, nothing more — proving genuine offset/limit pageability, not just grep.
{
  const idx = spilledLines.findIndex((l) => l.includes("MARKER-020"));
  check("(C) MARKER-020's line is locatable by index (Read offset/limit would land exactly here)", idx > 0);
  const slice = spilledLines.slice(Math.max(0, idx - 1), idx + 2).join("\n");
  check("(C) a small offset/limit slice around it excludes distant markers", !slice.includes("MARKER-000") && !slice.includes("MARKER-029"));
}

// ── (D) repeat pull — deterministic path, overwrites rather than accumulating scratch-dir garbage. ─────
const hugeRes2 = await client.callTool({ name: "worker_transcript", arguments: { workerSessionId: "W-HUGE-TURN" } });
const huge2 = JSON.parse(rawText(hugeRes2));
check("(D) repeat pull: same deterministic turnsFile path (no accumulation)", huge2.turnsFile === huge.turnsFile);

await client.close();

// ═══════════════════ (E) the SAME fix via transcript_read (registerTranscriptReadTools) — proves this is
// genuinely a SHARED writer (one function, two independent call sites), not a second per-tool patch. ════
const bareServer = new McpServer({ name: "loom-audit-test", version: "0.1.0" });
registerTranscriptReadTools(bareServer, db, { callerSessionId: "AUDITOR-1" });
const [auditClientT, auditServerT] = InMemoryTransport.createLinkedPair();
await bareServer.connect(auditServerT);
const auditClient = new Client({ name: "transcript-turns-spill-audit-test", version: "0" });
await auditClient.connect(auditClientT);

const auditRes = await auditClient.callTool({
  name: "transcript_read",
  arguments: { projectId: projId, sessionId: "W-HUGE-TURN", archived: false },
});
const audit = JSON.parse(auditRes.content[0].text);
check("(E) transcript_read: oversized single turn ALSO spills (shared function, not a per-tool patch)",
  !Array.isArray(audit) && typeof audit.turnsFile === "string" && typeof audit.turnsChars === "number");
check("(E) transcript_read's spill lands under the CALLING auditor's OWN scratch dir (not the manager's)",
  audit.turnsFile.startsWith(sessionScratchDir("AUDITOR-1")) && fs.existsSync(audit.turnsFile));
check("(E) transcript_read's spilled content is independently line-scoped grep-able too",
  fs.readFileSync(audit.turnsFile, "utf8").split("\n").filter((l) => l.includes("MARKER-007")).length === 1);

const auditSmallRes = await auditClient.callTool({
  name: "transcript_read",
  arguments: { projectId: projId, sessionId: "W-SMALL", archived: false },
});
const auditSmall = JSON.parse(auditSmallRes.content[0].text);
check("(E) transcript_read small transcript: unchanged bare-array shape", Array.isArray(auditSmall) && auditSmall.length === 3);

await auditClient.close();

try { db.close(); } catch { /* ignore */ }
for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
try { fs.rmSync(sandboxHome, { recursive: true, force: true }); } catch { /* ignore */ }

console.log(failures === 0
  ? "\n✅ ALL PASS — an oversized single transcript turn (the pageTranscript \"always take >=1\" edge case) " +
    "no longer collapses into one unpageable JSON.stringify line; worker_transcript AND transcript_read both " +
    "spill it to the RECIPIENT's own scratch dir as real, UTF-8, line-scoped grep/Read-pageable plain text via " +
    "the SAME shared spillableTurnsResponse — below-cap responses stay byte-identical."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
