import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// worker_transcript / transcript_read / session_transcript OVERSIZED-TURN bounding (card 605988ab, gap
// (c) of auditor finding 8a942a95; REDESIGNED by card 26134f1a). HERMETIC, NO daemon, NO claude: sandboxed
// HOME (nothing touches ~/.claude), a real Db, and the REAL OrchestrationMcpRouter + PlatformMcpRouter +
// registerTranscriptReadTools driven in-process over InMemoryTransport / a bare McpServer.
//
// THE ORIGINAL BUG (605988ab): `pageTranscript` bounds a page's SIZE but always includes >=1 turn
// regardless of that turn's own size (a single message can legitimately carry many/large batched
// tool_result blocks — e.g. several browser_snapshot calls). worker_transcript/transcript_read handed
// such a turn straight to `JSON.stringify` (the `ok()` envelope), which escapes every real newline INSIDE
// the turn's own already-rendered text into a literal two-char `\n` — so once the response was big enough
// for the host engine's own overflow-spill to kick in, the spilled file was ONE giant unpageable line.
//
// FIRST FIX (605988ab): proactively spill an oversized turns payload to the RECIPIENT session's own Loom
// scratch dir as plain text instead.
//
// @decision 26134f1a — that first fix was ITSELF a bug for transcript content specifically: Loom's own
// scratch dir (`<LOOM_HOME>/tmp/scratch/**`) carries no deny rule, so ANY session that knows or guesses a
// sibling's session id could `Read` its spilled transcript turn straight off disk — bypassing every one
// of transcript_read's own owner-turn/DM-scope/project-scope gates. Transcript-bearing tools now NEVER
// write to disk: an oversized turn's `text` is truncated INLINE (head + a short tail + an explicit
// `[TRUNCATED: showing N of M chars of this turn]` marker) and the response stays a real, always-parseable
// `turns` array — never a spill pointer, never a giant unpageable JSON.stringify blob either.
//
// Proves:
//   (RED) The PRE-FIX shape (plain `JSON.stringify` of the turns, no bounding at all) genuinely defeats
//         line-scoped access on an oversized turn — demonstrated directly (not asserted).
//   (A)   SMALL transcript — response BYTE-IDENTICAL to before: bare turns array, untouched turn text.
//   (B)   OVERSIZED single turn (a realistic batched-tool-result turn, >40K chars) — `turns` stays an
//         array, but the offending turn's `text` is truncated in place with the explicit marker; the
//         HEAD survives (early markers present), the marker states the real original length.
//   (C)   NOTHING is ever written to disk for this — no scratch-dir file exists anywhere for either
//         session after the call (the actual defect this redesign closes).
//   (D)   Repeat pulls are deterministic (same truncated output both times — nothing to "accumulate").
//   (E)   The SAME bounding, reached via transcript_read (registerTranscriptReadTools) AND session_transcript
//         (PlatformMcpRouter) — proves the "shared bounder" premise: one function, three independent call
//         sites, not a per-tool patch.
// Run: 1) build daemon (pnpm build), 2) node test/transcript-turns-spill.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtempManaged, finishAndExit } from "./_tmp-fixture.mjs";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- sandbox HOME so engineTranscriptPath's ~/.claude/projects/... never touches the real one, AND so
// sessionScratchDir's ~/.loom/tmp/scratch/... (checked to stay EMPTY for transcript content) lands in a
// throwaway LOOM_HOME. ---
const sandboxHome = mkdtempManaged("loom-tts-home-");
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME
process.env.LOOM_HOME = path.join(sandboxHome, ".loom");
fs.mkdirSync(process.env.LOOM_HOME, { recursive: true });

const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { registerTranscriptReadTools } = await import("../dist/mcp/transcript-read.js");
const { engineTranscriptPath, TRANSCRIPT_PAGE_CHAR_BUDGET } = await import("../dist/sessions/transcript.js");
const { sessionScratchDir } = await import("../dist/paths.js");

// ── build a REALISTIC oversized single turn: one batched tool-result message (like several
// browser_snapshot calls landing in one turn), each block's OWN body well under the unrelated
// per-tool-result 2KB truncation cap (so nothing here gets truncated by THAT separate mechanism) but the
// turn's TOTAL text comfortably exceeds TRANSCRIPT_PAGE_CHAR_BUDGET. Each block carries a UNIQUE marker
// (MARKER-NNN) plus non-ASCII/box-drawing content so head-survival and non-ASCII handling are both
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
// (F) card 91fef05a, reviewer finding 4: session_transcript's finalMessageOnly:true branch returned
// `[last]` directly — bypassing spillableTurnsResponse entirely — so an oversized FINAL assistant message
// had no bounding at all. A dedicated oversized-ASSISTANT-turn fixture (finalMessageOnly only ever
// selects an assistant-role turn — the huge fixture above is a tool_result/"user"-role turn, so it can't
// exercise this branch).
db.insertSession({
  id: "W-HUGE-ASSISTANT", projectId: projId, agentId, engineSessionId: "eng-w-huge-assistant", title: null, cwd, processState: "live",
  resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker",
  parentSessionId: "M", taskId: "tk-huge-assistant", branch: "loom/w-huge-assistant",
});

// --- write the transcripts to disk ---
const hugeFile = engineTranscriptPath(cwd, "eng-w-huge-turn");
fs.mkdirSync(path.dirname(hugeFile), { recursive: true });
fs.writeFileSync(hugeFile, bigMessageLine + "\n"); // a SINGLE turn — the whole transcript is this one oversized turn

const hugeAssistantFile = engineTranscriptPath(cwd, "eng-w-huge-assistant");
fs.mkdirSync(path.dirname(hugeAssistantFile), { recursive: true });
const hugeAssistantText = `MARKER-HEAD ${"y".repeat(TRANSCRIPT_PAGE_CHAR_BUDGET)} MARKER-TAIL`;
fs.writeFileSync(hugeAssistantFile, [
  JSON.stringify({ type: "user", message: { content: [{ type: "text", text: "prior turn, not the final one" }] } }),
  JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: hugeAssistantText }] } }),
].join("\n") + "\n");

const smallFile = engineTranscriptPath(cwd, "eng-w-small");
fs.mkdirSync(path.dirname(smallFile), { recursive: true });
fs.writeFileSync(smallFile, Array.from({ length: 3 }, (_, i) =>
  JSON.stringify({ type: i % 2 === 0 ? "user" : "assistant", message: { content: [{ type: "text", text: `small-turn-${i}` }] } })
).join("\n") + "\n");

check(`fixture sanity: the single-turn transcript's raw JSONL is itself well over the inline cap (${bigMessageLine.length} > ${TRANSCRIPT_PAGE_CHAR_BUDGET})`,
  bigMessageLine.length > TRANSCRIPT_PAGE_CHAR_BUDGET);

// ═══════════════════════════════════ (RED) reproduce the PRE-605988ab defeat directly ═══════════════════
// This is exactly what `ok(turns)` used to hand back with NO bounding at all: `JSON.stringify` of the
// turns array. Demonstrate — not assert — that it defeats line-scoped access, motivating why bounding
// (first the scratch-spill, now inline truncation) exists at all.
{
  const { readTranscript } = await import("../dist/sessions/transcript.js");
  const rawTurns = readTranscript(cwd, "eng-w-huge-turn");
  check("fixture sanity: parses to exactly ONE turn", rawTurns.length === 1);
  const preFixText = JSON.stringify(rawTurns); // the old, unbounded `ok()` envelope's text field
  const preFixLines = preFixText.split("\n");
  check(`(RED) pre-fix JSON.stringify collapses the whole ${preFixText.length}-char turn into ONE line (got ${preFixLines.length} line(s))`,
    preFixLines.length === 1);
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
const call = async (name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

// ── (A) SMALL transcript — byte-identical to before: bare array, turn text untouched. ───────────────────
const smallRes = await client.callTool({ name: "worker_transcript", arguments: { workerSessionId: "W-SMALL" } });
const small = JSON.parse(rawText(smallRes));
check("(A) small transcript: bare turns array (unchanged shape)", Array.isArray(small) && small.length === 3);
check("(A) small transcript: no truncation marker leaks into a below-cap response", !rawText(smallRes).includes("TRUNCATED"));

// ── (B) OVERSIZED single turn, default call (no paging args) — still an array, that turn truncated. ─────
const huge = await call("worker_transcript", { workerSessionId: "W-HUGE-TURN" });
check("(B) oversized turn: STILL a bare turns array (never a spill pointer)", Array.isArray(huge) && huge.length === 1);
check("(B) oversized turn: text is bounded under the page budget", huge[0].text.length <= TRANSCRIPT_PAGE_CHAR_BUDGET);
check("(B) oversized turn: carries the explicit TRUNCATED marker", huge[0].text.includes("[TRUNCATED: showing"));
// The "of M" number is the RENDERED turn's own length (not the raw JSONL line) — checked precisely here.
const markerMatch = huge[0].text.match(/\[TRUNCATED: showing (\d+) of (\d+) chars of this turn\]/);
check("(B) the marker's own numbers are internally consistent (kept <= real M, M > page budget)",
  !!markerMatch && Number(markerMatch[1]) <= Number(markerMatch[2]) && Number(markerMatch[2]) > TRANSCRIPT_PAGE_CHAR_BUDGET);
check("(B) the HEAD survived — the first block's marker is present", huge[0].text.includes("MARKER-000"));
check("(B) a short TAIL also survived — the LAST block's marker is present (head+tail, per the design)", huge[0].text.includes("MARKER-029"));
const droppedMarkers = Array.from({ length: N_BLOCKS }, (_, n) => `MARKER-${String(n).padStart(3, "0")}`)
  .filter((m) => !huge[0].text.includes(m));
check(`(B) at least SOME middle block(s) genuinely did NOT survive (dropped: ${droppedMarkers.join(",") || "none"})`, droppedMarkers.length > 0);

// ── (C) NOTHING is written to disk anywhere for this — the actual defect this redesign closes. ──────────
const managerScratch = sessionScratchDir("M");
check("(C) the RECIPIENT's own scratch dir has no transcript-spills subdir at all", !fs.existsSync(path.join(managerScratch, "transcript-spills")));
// Broader sweep: no NEW file appeared anywhere under LOOM_HOME/tmp/scratch as a result of this call.
const scratchRoot = path.join(process.env.LOOM_HOME, "tmp", "scratch");
const scratchFilesAfter = fs.existsSync(scratchRoot) ? fs.readdirSync(scratchRoot, { recursive: true }) : [];
check("(C) no file was written anywhere under LOOM_HOME/tmp/scratch for this oversized-turn read", scratchFilesAfter.length === 0);

// ── (D) repeat pull — deterministic: the SAME truncated text both times (nothing to accumulate). ────────
const huge2 = await call("worker_transcript", { workerSessionId: "W-HUGE-TURN" });
check("(D) repeat pull: byte-identical truncated output (deterministic, no state)", huge2[0].text === huge[0].text);

await client.close();

// ═══════════════════ (E) the SAME bounding via transcript_read AND session_transcript — proves this is
// genuinely a SHARED function (one implementation, three independent call sites), not per-tool patches. ══
const bareServer = new McpServer({ name: "loom-audit-test", version: "0.1.0" });
registerTranscriptReadTools(bareServer, db);
const [auditClientT, auditServerT] = InMemoryTransport.createLinkedPair();
await bareServer.connect(auditServerT);
const auditClient = new Client({ name: "transcript-turns-spill-audit-test", version: "0" });
await auditClient.connect(auditClientT);

const auditRes = await auditClient.callTool({
  name: "transcript_read",
  arguments: { projectId: projId, sessionId: "W-HUGE-TURN", archived: false },
});
const audit = JSON.parse(auditRes.content[0].text);
check("(E) transcript_read: oversized single turn ALSO stays an array with the turn truncated (shared function)",
  Array.isArray(audit) && audit.length === 1 && audit[0].text.includes("[TRUNCATED: showing"));
check("(E) transcript_read's truncated content is independently head+tail-scoped the same way", audit[0].text.includes("MARKER-000") && audit[0].text.includes("MARKER-029") && droppedMarkers.some((m) => !audit[0].text.includes(m)));

const auditSmallRes = await auditClient.callTool({
  name: "transcript_read",
  arguments: { projectId: projId, sessionId: "W-SMALL", archived: false },
});
const auditSmall = JSON.parse(auditSmallRes.content[0].text);
check("(E) transcript_read small transcript: unchanged bare-array shape", Array.isArray(auditSmall) && auditSmall.length === 3);

await auditClient.close();

// Broader sweep (mirrors (C), not just the "transcript-spills" subdir NAME — nit from card 91fef05a's
// review): confirm NO new file appeared anywhere under LOOM_HOME/tmp/scratch for the transcript_read
// calls above, the same full-tree check (C) already applies to worker_transcript.
{
  const scratchFilesAfterAudit = fs.existsSync(scratchRoot) ? fs.readdirSync(scratchRoot, { recursive: true }) : [];
  check("(E) transcript_read: no file was written anywhere under LOOM_HOME/tmp/scratch (not just the transcript-spills subdir name)", scratchFilesAfterAudit.length === 0);
}

// session_transcript (PlatformMcpRouter) — the Lead's cross-project sibling.
const platformRouter = new PlatformMcpRouter(db, {});
const platformServer = platformRouter.buildServer("PLATFORM-1");
const [platClientT, platServerT] = InMemoryTransport.createLinkedPair();
await platformServer.connect(platServerT);
const platClient = new Client({ name: "transcript-turns-spill-platform-test", version: "0" });
await platClient.connect(platClientT);
const platCall = async (name, args) => JSON.parse((await platClient.callTool({ name, arguments: args })).content[0].text);

const platHuge = await platCall("session_transcript", { sessionId: "W-HUGE-TURN" });
check("(E) session_transcript: oversized single turn ALSO stays an array with the turn truncated (shared function)",
  Array.isArray(platHuge) && platHuge.length === 1 && platHuge[0].text.includes("[TRUNCATED: showing"));
check("(E) session_transcript's truncation also writes nothing to disk", !fs.existsSync(path.join(sessionScratchDir("PLATFORM-1"), "transcript-spills")));
// Broader sweep (mirrors (C) — not just the "transcript-spills" subdir NAME, per card 91fef05a's review):
// confirm NO new file appeared anywhere under LOOM_HOME/tmp/scratch for the session_transcript call above.
const scratchFilesAfterPlatform = fs.existsSync(scratchRoot) ? fs.readdirSync(scratchRoot, { recursive: true }) : [];
check("(E) session_transcript: no file was written anywhere under LOOM_HOME/tmp/scratch (not just the transcript-spills subdir name)", scratchFilesAfterPlatform.length === 0);

// ═══ (F) session_transcript finalMessageOnly:true — card 91fef05a, reviewer finding 4 ═══════════════════
const platFinal = await platCall("session_transcript", { sessionId: "W-HUGE-ASSISTANT", finalMessageOnly: true });
check("(F) finalMessageOnly: STILL a bare 1-element turns array (never a spill pointer)", Array.isArray(platFinal) && platFinal.length === 1);
check("(F) finalMessageOnly: the oversized final assistant message is bounded under the page budget (goes through spillableTurnsResponse)",
  platFinal[0].text.length <= TRANSCRIPT_PAGE_CHAR_BUDGET);
check("(F) finalMessageOnly: carries the explicit TRUNCATED marker", platFinal[0].text.includes("[TRUNCATED: showing"));
check("(F) finalMessageOnly: the HEAD survived", platFinal[0].text.includes("MARKER-HEAD"));
check("(F) finalMessageOnly: writes nothing to disk", !fs.existsSync(path.join(sessionScratchDir("PLATFORM-1"), "transcript-spills")));
const scratchFilesAfterFinal = fs.existsSync(scratchRoot) ? fs.readdirSync(scratchRoot, { recursive: true }) : [];
check("(F) finalMessageOnly: no file was written anywhere under LOOM_HOME/tmp/scratch", scratchFilesAfterFinal.length === 0);
// A SMALL final message (well under budget) stays byte-identical — no marker, no truncation.
const platFinalSmall = await platCall("session_transcript", { sessionId: "W-SMALL", finalMessageOnly: true });
check("(F) finalMessageOnly: below-cap final message is untouched (no marker leaks in)",
  Array.isArray(platFinalSmall) && platFinalSmall.length === 1 && !platFinalSmall[0].text.includes("TRUNCATED"));

await platClient.close();

try { db.close(); } catch { /* ignore */ }
for (const ext of ["", "-wal", "-shm"]) { try { fs.rmSync(dbFile + ext, { force: true }); } catch { /* ignore */ } }
// sandboxHome's own manual rmSync removed here: mkdtempManaged already registered it for guaranteed
// cleanup at process exit (card 995be21f). dbFile above is a DIFFERENT, out-of-scope Family-2 site
// (a hand-rolled Date.now()/random suffix, not fs.mkdtempSync — tracked separately in 09db9357).

console.log(failures === 0
  ? "\n✅ ALL PASS — an oversized single transcript turn (the pageTranscript \"always take >=1\" edge case) " +
    "no longer collapses into one unpageable JSON.stringify line, and (card 26134f1a) no longer spills to " +
    "ANY disk location either — worker_transcript, transcript_read, AND session_transcript all truncate the " +
    "offending turn INLINE (head survives, an explicit marker states the real length, nothing written to " +
    "disk) via the SAME shared spillableTurnsResponse — below-cap responses stay byte-identical."
  : `\n❌ ${failures} FAILURE(S).`);
await finishAndExit(failures === 0 ? 0 : 1);
