import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// session_transcript (Platform Lead surface, mcp/platform.ts) — CROSS-PROJECT by sessionId ALONE, no
// projectId/parent-child scoping (card 95cc7ee3: the Lead stands ABOVE all projects, unlike the
// manager's lineage-scoped worker_transcript). HERMETIC, CLAUDE-FREE, NETWORK-FREE: seeds a real Db
// (TWO projects, sessions only) + REAL transcript files on disk (a live engine JSONL for one session, an
// archived SNAPSHOT for another), and drives session_transcript in-process over an MCP InMemoryTransport
// through the REAL PlatformMcpRouter — mirrors worker-transcript-paging.mjs's transcript-on-disk harness
// and platform-mgmt-surface.mjs's PlatformMcpRouter wiring.
//
// Proves the DoD:
//   (a) session_transcript is registered on the platform surface, and reads a session by id ALONE —
//       across projects, with NO projectId argument at all (unlike the auditor's transcript_read);
//   (b) it shares the SAME bounded page envelope {turns, totalTurns, offset, returned, nextOffset} the
//       auditor's transcript_read / the manager's worker_transcript already use: page 1 -> nextOffset ->
//       page 2 -> ... -> null covers the whole transcript exactly once, totalTurns is authoritative;
//   (c) a small transcript with no paging arg stays byte-shape backward-compatible (bare array); an
//       explicit paging arg still returns the envelope even though it fits one page; lastN still works
//       and takes PRECEDENCE over offset/limit/turnRange;
//   (d) live vs. archived is AUTO-DETECTED from the session row's own archivedAt — an archived session
//       (no live engine file at all) still reads its captured snapshot, with no `archived` flag passed;
//   (e) id-prefix resolution mirrors transcript_read's own: an unambiguous 8-char prefix resolves, a
//       too-short prefix and a genuinely ambiguous prefix both return the distinct error (not a
//       misleading "session not found"), and a well-formed-but-unknown id returns "session not found".
//
// Run: 1) build (turbo builds shared first), 2) node test/platform-transcript.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (nothing touches the real ~/.loom or ~/.claude). Set BEFORE
// importing dist (paths.ts reads LOOM_HOME at import time; archivedTranscriptPath resolves under it). ---
const tmpHome = path.join(os.tmpdir(), `loom-pt-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv(); // confirm LOOM_HOME is the temp dir (no port — this test runs no HTTP daemon)

const { Db } = await import("../dist/db.js");
const { PlatformMcpRouter } = await import("../dist/mcp/platform.js");
const { engineTranscriptPath, archivedTranscriptPath } = await import("../dist/sessions/transcript.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");

const now = new Date().toISOString();
const db = new Db();

// --- TWO projects, so a cross-project read proves session_transcript needs no projectId at all. ---
const repo1 = path.join(tmpHome, "repo1");
const repo2 = path.join(tmpHome, "repo2");
fs.mkdirSync(repo1, { recursive: true });
fs.mkdirSync(repo2, { recursive: true });
db.insertProject({ id: "p1", name: "P1", repoPath: repo1, vaultPath: repo1, config: {}, createdAt: now, archivedAt: null });
db.insertProject({ id: "p2", name: "P2", repoPath: repo2, vaultPath: repo2, config: {}, createdAt: now, archivedAt: null });
db.insertAgent({ id: "a1", projectId: "p1", name: "Agent1", startupPrompt: "x", position: 0 });
db.insertAgent({ id: "a2", projectId: "p2", name: "Agent2", startupPrompt: "x", position: 0 });

// S-BIG: LIVE, project p1 — a large transcript so a default call MUST page (mirrors worker-transcript-paging.mjs).
db.insertSession({
  id: "11111111-big-live", projectId: "p1", agentId: "a1", engineSessionId: "eng-big", title: null, cwd: repo1,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: null,
});
const BIG_TURN_COUNT = 10;
const bigFile = engineTranscriptPath(repo1, "eng-big");
fs.mkdirSync(path.dirname(bigFile), { recursive: true });
fs.writeFileSync(bigFile, Array.from({ length: BIG_TURN_COUNT }, (_, i) =>
  JSON.stringify({ type: i % 2 === 0 ? "user" : "assistant", message: { content: [{ type: "text", text: `turn-${i}-` + "x".repeat(10_000) }] } })
).join("\n") + "\n");

// S-SMALL: LIVE, project p2 (a DIFFERENT project than S-BIG) — small transcript, fits one page.
db.insertSession({
  id: "22222222-small-live", projectId: "p2", agentId: "a2", engineSessionId: "eng-small", title: null, cwd: repo2,
  processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: null,
});
const smallFile = engineTranscriptPath(repo2, "eng-small");
fs.mkdirSync(path.dirname(smallFile), { recursive: true });
fs.writeFileSync(smallFile, Array.from({ length: 3 }, (_, i) =>
  JSON.stringify({ type: i % 2 === 0 ? "user" : "assistant", message: { content: [{ type: "text", text: `small-turn-${i}` }] } })
).join("\n") + "\n");

// S-ARCHIVED: archivedAt set, project p2, NO engineSessionId / NO live engine file at all — proves
// auto-detection reads the captured SNAPSHOT purely off the session row's archivedAt, not a live file.
db.insertSession({
  id: "33333333-archived", projectId: "p2", agentId: "a2", engineSessionId: null, title: null, cwd: repo2,
  processState: "exited", resumability: "dead", busy: false, createdAt: now, lastActivity: now, lastError: null, role: null,
});
db.archiveSession("33333333-archived");
const archFile = archivedTranscriptPath("p2", "33333333-archived");
fs.mkdirSync(path.dirname(archFile), { recursive: true });
fs.writeFileSync(archFile, Array.from({ length: 4 }, (_, i) =>
  JSON.stringify({ type: i % 2 === 0 ? "user" : "assistant", message: { content: [{ type: "text", text: `arch-turn-${i}` }] } })
).join("\n") + "\n");

// Two sessions sharing an identical 8-char id-prefix — the AMBIGUOUS resolution fixture.
db.insertSession({
  id: "aaaaaaaa-one", projectId: "p1", agentId: "a1", engineSessionId: null, title: null, cwd: repo1,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: null,
});
db.insertSession({
  id: "aaaaaaaa-two", projectId: "p1", agentId: "a1", engineSessionId: null, title: null, cwd: repo1,
  processState: "live", resumability: "unknown", busy: false, createdAt: now, lastActivity: now, lastError: null, role: null,
});

// session_transcript reads only `db` — a minimal stub covers PlatformMcpRouter's unrelated SessionService param.
const router = new PlatformMcpRouter(db, /** @type {any} */ ({}));
const server = router.buildServer();
const [clientT, serverT] = InMemoryTransport.createLinkedPair();
await server.connect(serverT);
const client = new Client({ name: "platform-transcript-test", version: "0" });
await client.connect(clientT);
const parse = (res) => JSON.parse(res.content[0].text);
const call = async (name, args) => parse(await client.callTool({ name, arguments: args }));

try {
  // (a) registered on the platform surface
  const tools = (await client.listTools()).tools.map((t) => t.name);
  check("(a) session_transcript is registered on the platform surface", tools.includes("session_transcript"));

  // (a)+(b) cross-project: a default call on the LARGE transcript (project p1) returns a BOUNDED first
  // page, not the whole thing — with NO projectId argument passed.
  const firstPage = await call("session_transcript", { sessionId: "11111111-big-live" });
  check("(a) session_transcript(S-BIG) no args -> a page envelope (NOT the bare full array)",
    !Array.isArray(firstPage) && Array.isArray(firstPage.turns));
  check(`(b) session_transcript(S-BIG) first page: totalTurns=${BIG_TURN_COUNT}, offset=0, bounded < total (got ${JSON.stringify({ totalTurns: firstPage.totalTurns, offset: firstPage.offset, returned: firstPage.returned, nextOffset: firstPage.nextOffset })})`,
    firstPage.totalTurns === BIG_TURN_COUNT && firstPage.offset === 0 &&
    firstPage.returned > 0 && firstPage.returned < BIG_TURN_COUNT && typeof firstPage.nextOffset === "number");

  // (b) page 1 -> nextOffset -> page 2 -> ... -> null covers the WHOLE transcript, no gaps/overlaps
  let off = 0, seen = 0, pages = 0;
  while (off !== null) {
    const pg = await call("session_transcript", { sessionId: "11111111-big-live", offset: off });
    check(`(b) session_transcript(S-BIG, offset:${off}) returns a page`, !Array.isArray(pg) && pg.offset === off);
    seen += pg.returned;
    pages++;
    if (pg.nextOffset === null) { off = null; } else {
      check(`(b) page @${off}: nextOffset advances exactly past this page (no overlap, no gap)`, pg.nextOffset === off + pg.returned);
      off = pg.nextOffset;
    }
    if (pages > 20) { check("(b) paging terminates (runaway guard)", false); break; }
  }
  check(`(b) paging S-BIG start->nextOffset->...->null covered all ${BIG_TURN_COUNT} turns exactly once (got ${seen} across ${pages} pages)`,
    seen === BIG_TURN_COUNT && pages >= 2);

  // (c) a SMALL transcript (a DIFFERENT project, p2) with no paging arg stays bare-array backward-compat;
  // an explicit paging arg still returns the envelope even though it fits one page.
  const smallDefault = await call("session_transcript", { sessionId: "22222222-small-live" });
  check("(c) session_transcript(S-SMALL, project p2) no args, fits one page -> bare turns array, no projectId needed",
    Array.isArray(smallDefault) && smallDefault.length === 3);
  const smallPaged = await call("session_transcript", { sessionId: "22222222-small-live", offset: 0 });
  check("(c) session_transcript(S-SMALL, offset:0) explicit paging arg -> envelope even though it fits one page",
    !Array.isArray(smallPaged) && smallPaged.totalTurns === 3 && smallPaged.nextOffset === null);

  // (c) lastN: bare array, takes PRECEDENCE over paging args passed alongside it
  const last2 = await call("session_transcript", { sessionId: "11111111-big-live", lastN: 2 });
  check("(c) session_transcript(S-BIG, lastN:2) returns a bare array of the last 2 turns",
    Array.isArray(last2) && last2.length === 2 && last2[1].text.startsWith("turn-9-"));
  const lastWithOffset = await call("session_transcript", { sessionId: "11111111-big-live", lastN: 1, offset: 5 });
  check("(c) session_transcript(S-BIG, lastN:1, offset:5) — lastN wins, still a bare 1-element array",
    Array.isArray(lastWithOffset) && lastWithOffset.length === 1 && lastWithOffset[0].text.startsWith("turn-9-"));

  // (d) ARCHIVED auto-detection: the row has NO engineSessionId / no live file at all — session_transcript
  // still returns the captured SNAPSHOT content, with no `archived` flag passed by the caller.
  const archRead = await call("session_transcript", { sessionId: "33333333-archived" });
  check("(d) session_transcript(S-ARCHIVED) auto-detects archived and reads the captured snapshot (no live file exists)",
    Array.isArray(archRead) && archRead.length === 4 && archRead[0].text === "arch-turn-0");

  // (e) id-prefix resolution: an unambiguous 8-char prefix resolves to the same session.
  const prefixRead = await call("session_transcript", { sessionId: "11111111", lastN: 100 });
  check("(e) session_transcript: an unambiguous 8-char id-prefix resolves (lastN clamps to all 10 turns)",
    Array.isArray(prefixRead) && prefixRead.length === BIG_TURN_COUNT);

  // (e) a genuinely ambiguous 8-char prefix (two sessions share it) -> the distinct error.
  const ambig = await call("session_transcript", { sessionId: "aaaaaaaa" });
  check("(e) session_transcript: an ambiguous 8-char id-prefix returns the distinct error",
    typeof ambig.error === "string" && /ambiguous/i.test(ambig.error));

  // (e) a too-short (<8 char) prefix -> the SAME distinct error, not a misleading "session not found".
  const tooShort = await call("session_transcript", { sessionId: "1111" });
  check("(e) session_transcript: a too-short id-prefix (<8 chars) returns the distinct error",
    typeof tooShort.error === "string" && /ambiguous/i.test(tooShort.error));

  // (e) a well-formed but genuinely unknown id -> "session not found".
  const unknown = await call("session_transcript", { sessionId: "ffffffff-doesnotexist" });
  check("(e) session_transcript: a well-formed but unknown id returns 'session not found'",
    unknown.error === "session not found");

  await client.close();
} finally {
  db.close();
  try { fs.rmSync(tmpHome, { recursive: true, force: true }); } catch { /* best-effort */ }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — session_transcript reads ANY session's transcript cross-project by sessionId alone (no projectId/parent scoping), shares the same bounded page envelope as transcript_read/worker_transcript with no gaps/overlaps, stays backward-compatible on a small transcript, lastN still works and takes precedence, live vs. archived is auto-detected off the session row, and id-prefix resolution (unambiguous/ambiguous/too-short/unknown) mirrors transcript_read's own — claude-free, network-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
