import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Companion Capability & Permission-Lever Framework — `transcript-read` (Companion→Platform-Lead epic
// ccdb1e0c, lever 1, Tier R). A pure read-only `transcript_read` tool mirroring the Platform Lead's own
// `session_transcript` (mcp/platform.ts) for the READ itself — archived-auto-detect + pagination
// envelope, reusing readTranscript/readArchivedTranscript/pageTranscript verbatim. NEVER touches the
// Companion Trust Window. Fully hermetic: a REAL Db on a temp LOOM_HOME + a sandboxed HOME (so
// readTranscript's os.homedir()-derived ~/.claude/projects lookup resolves inside the temp dir) + the
// REAL OrchestrationMcpRouter over an in-memory MCP transport. NO network, NO real claude, NO daemon.
//
// Covers the card's DoD:
//   (a) no grant ⇒ transcript_read is NOT registered (inert + invisible).
//   (b) a read grant on project X ⇒ transcript_read returns the transcript turns for an in-scope
//       session in X, on an owner-authored DM turn.
//   (c) a session in an UNGRANTED project ⇒ {error} (not the transcript) — per-project resolve-then-
//       scope, never a collapsed scope check.
//   (d) DM-only + Primitive A, the TWO mandatory co-gates (CR hardening — neither alone is enough):
//       - a GROUP-route turn (non-null senderId) ⇒ {error}, even when owner-authored.
//       - a PROACTIVE turn (null senderId, NO owner text) ⇒ {error} — the DM-only check alone would let
//         this through, since getActiveTurnSenderId is also null for a proactive/heartbeat/reminder
//         turn, not just a genuine DM; Primitive A is what closes that gap.
//       - an owner-authored DM turn (null senderId, owner text present) ⇒ succeeds.
//   (e) the archived branch (s.archivedAt != null ⇒ readArchivedTranscript, no live engine file needed).
//   (f) the pagination envelope (offset/limit/turnRange + nextOffset paging to completion).
//   (g) an ambiguous / too-short id-prefix ⇒ AMBIGUOUS_ID_ERROR; a prefix ambiguous only ACROSS an
//       out-of-scope session is NOT surfaced as ambiguous (filtered to in-scope matches only).
//   (h) a defensive null-projectId session row is rejected (belt-and-suspenders — unreachable through
//       the real Db's NOT NULL project_id column, so driven directly through the exported
//       COMPANION_CAPABILITIES registry entry with a minimal stub db/server).
// Run: 1) build (turbo builds shared first), 2) node test/companion-transcript-read.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + a sandboxed HOME (nothing touches the real ~/.loom or ~/.claude). Set BEFORE
// importing dist (paths.ts reads LOOM_HOME at import time; engineTranscriptPath resolves off os.homedir()). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-transcript-read-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { OrchestrationMcpRouter } = await import("../dist/mcp/orchestration.js");
const { COMPANION_CAPABILITIES } = await import("../dist/companion/capabilities.js");
const { engineTranscriptPath, archivedTranscriptPath } = await import("../dist/sessions/transcript.js");
const { InMemoryTransport } = await import("@modelcontextprotocol/sdk/inMemory.js");
const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");

async function connect(server) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  await server.connect(serverT);
  const client = new Client({ name: "companion-transcript-read-test", version: "0" });
  await client.connect(clientT);
  return client;
}
const listOf = async (server) => { const c = await connect(server); const names = (await c.listTools()).tools.map((t) => t.name); await c.close(); return names; };
const call = async (client, name, args) => JSON.parse((await client.callTool({ name, arguments: args })).content[0].text);

const now = new Date().toISOString();
function seedProject(db, id, name) {
  db.insertProject({ id, name, repoPath: id, vaultPath: id, config: {}, createdAt: now, archivedAt: null });
}
function seedSession(db, id, projectId, role, opts = {}) {
  const agentId = `a-${id}`;
  db.insertAgent({ id: agentId, projectId, name: role, startupPrompt: "", position: 0 });
  db.insertSession({
    id, projectId, agentId, engineSessionId: opts.engineSessionId ?? null, title: null, cwd: projectId,
    processState: opts.processState ?? "live", resumability: "resumable", busy: false,
    createdAt: now, lastActivity: now, lastError: null, role,
  });
}
function writeLiveTranscript(cwd, engineSessionId, turnTexts) {
  const file = engineTranscriptPath(cwd, engineSessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, turnTexts.map((t, i) =>
    JSON.stringify({ type: i % 2 === 0 ? "user" : "assistant", message: { content: [{ type: "text", text: t }] } })
  ).join("\n") + "\n");
}
function writeArchivedTranscript(projectId, sessionId, turnTexts) {
  const file = archivedTranscriptPath(projectId, sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, turnTexts.map((t, i) =>
    JSON.stringify({ type: i % 2 === 0 ? "user" : "assistant", message: { content: [{ type: "text", text: t }] } })
  ).join("\n") + "\n");
}
/** senderId: null = DM route, a string = GROUP route (see GrantPty's own doc). ownerText: null = NOT
 *  owner-authored (a proactive/heartbeat/reminder turn), a string = Primitive A passes. */
function makeFakePty(senderId, ownerText = null) {
  return {
    getActiveTurnOwnerText() { return ownerText; },
    getActiveTurnOrigin() { return null; },
    getActiveTurnSenderId() { return senderId; },
    enqueueStdin() { return { delivered: false, reason: "held" }; },
  };
}
const tmpDb = () => new Db(path.join(tmpHome, `${randomUUID()}.db`));

try {
  // ============ (a) no grant ⇒ transcript_read is NOT registered ============
  {
    const db = tmpDb();
    const proj = "proj-no-grant";
    seedProject(db, proj, "No grant");
    const companionSess = "companion-no-grant";
    seedSession(db, companionSess, proj, "assistant");

    const orch = new OrchestrationMcpRouter(db, {}, {}, makeFakePty(null, "the owner said: hi"));
    const tools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("(a) an ungranted companion does NOT have transcript_read", !tools.includes("transcript_read"));
    db.close();
  }

  // ============ (b) a read grant on project X ⇒ returns the transcript turns for an in-scope session ============
  {
    const db = tmpDb();
    const proj = "proj-read";
    seedProject(db, proj, "Read");
    const companionSess = "companion-read";
    seedSession(db, companionSess, proj, "assistant");
    seedSession(db, "target-in-scope", proj, "manager", { engineSessionId: "eng-in-scope" });
    writeLiveTranscript(proj, "eng-in-scope", ["hello there", "hi back"]);
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "transcript-read", projectId: proj, mode: "read" });

    // Owner-authored DM turn: null senderId (DM route) AND non-null owner text (Primitive A passes).
    const orch = new OrchestrationMcpRouter(db, {}, {}, makeFakePty(null, "the owner said: read target-in-scope"));
    const tools = await listOf(orch.buildServer(companionSess, "assistant"));
    check("(b) a granted companion HAS transcript_read", tools.includes("transcript_read"));

    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const result = await call(client, "transcript_read", { sessionId: "target-in-scope" });
    check("(b) returns the in-scope session's transcript turns",
      Array.isArray(result) && result.length === 2 && result[0].text === "hello there" && result[1].text === "hi back");
    await client.close();
    db.close();
  }

  // ============ (c) a session in an UNGRANTED project ⇒ {error}, never a collapsed scope check ============
  {
    const db = tmpDb();
    const projGranted = "proj-c-granted", projOther = "proj-c-other";
    seedProject(db, projGranted, "Granted");
    seedProject(db, projOther, "Other");
    const companionSess = "companion-scope";
    seedSession(db, companionSess, projGranted, "assistant");
    seedSession(db, "target-out-of-scope", projOther, "manager", { engineSessionId: "eng-out-of-scope" });
    writeLiveTranscript(projOther, "eng-out-of-scope", ["should never be readable"]);
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "transcript-read", projectId: projGranted, mode: "read" });

    const orch = new OrchestrationMcpRouter(db, {}, {}, makeFakePty(null, "the owner said: read it"));
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const result = await call(client, "transcript_read", { sessionId: "target-out-of-scope" });
    check("(c) an ungranted-project session returns {error}, not the transcript",
      typeof result.error === "string" && !Array.isArray(result));
    await client.close();
    db.close();
  }

  // ============ (d) DM-only + Primitive A — TWO mandatory co-gates ============
  {
    const db = tmpDb();
    const proj = "proj-dm";
    seedProject(db, proj, "DM");
    const companionSess = "companion-dm";
    seedSession(db, companionSess, proj, "assistant");
    seedSession(db, "target-dm", proj, "manager", { engineSessionId: "eng-dm" });
    writeLiveTranscript(proj, "eng-dm", ["dm-only content"]);
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "transcript-read", projectId: proj, mode: "read" });

    // GROUP route, owner-authored: still refused (senderId non-null wins regardless of owner text).
    const orchGroup = new OrchestrationMcpRouter(db, {}, {}, makeFakePty("group-sender-1", "the owner said: read it"));
    const clientGroup = await connect(orchGroup.buildServer(companionSess, "assistant"));
    const groupResult = await call(clientGroup, "transcript_read", { sessionId: "target-dm" });
    check("(d) a GROUP-route turn (non-null senderId) is refused with {error}, even when owner-authored",
      typeof groupResult.error === "string" && !Array.isArray(groupResult) && /DM-only|group/i.test(groupResult.error));
    await clientGroup.close();

    // PROACTIVE turn: null senderId (looks like a DM route) but NO owner text — the gap DM-only alone
    // would miss (a self-initiated proactive/heartbeat/reminder turn also has a null senderId).
    const orchProactive = new OrchestrationMcpRouter(db, {}, {}, makeFakePty(null, null));
    const clientProactive = await connect(orchProactive.buildServer(companionSess, "assistant"));
    const proactiveResult = await call(clientProactive, "transcript_read", { sessionId: "target-dm" });
    check("(d) a PROACTIVE turn (null senderId, NO owner text) is refused with {error} — Primitive A closes the DM-only gap",
      typeof proactiveResult.error === "string" && !Array.isArray(proactiveResult) && /owner/i.test(proactiveResult.error));
    await clientProactive.close();

    // Genuine owner-authored DM turn: null senderId AND owner text present — succeeds.
    const orchDm = new OrchestrationMcpRouter(db, {}, {}, makeFakePty(null, "the owner said: read target-dm"));
    const clientDm = await connect(orchDm.buildServer(companionSess, "assistant"));
    const dmResult = await call(clientDm, "transcript_read", { sessionId: "target-dm" });
    check("(d) an owner-authored DM turn (null senderId, owner text present) succeeds",
      Array.isArray(dmResult) && dmResult.length === 1 && dmResult[0].text === "dm-only content");
    await clientDm.close();

    db.close();
  }

  // ============ (e) the archived branch reads the captured snapshot, no live engine file needed ============
  {
    const db = tmpDb();
    const proj = "proj-archived";
    seedProject(db, proj, "Archived");
    const companionSess = "companion-archived";
    seedSession(db, companionSess, proj, "assistant");
    seedSession(db, "target-archived", proj, "manager", { engineSessionId: null, processState: "exited" });
    db.archiveSession("target-archived");
    writeArchivedTranscript(proj, "target-archived", ["archived turn one", "archived turn two"]);
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "transcript-read", projectId: proj, mode: "read" });

    const orch = new OrchestrationMcpRouter(db, {}, {}, makeFakePty(null, "the owner said: read the archived one"));
    const client = await connect(orch.buildServer(companionSess, "assistant"));
    const result = await call(client, "transcript_read", { sessionId: "target-archived" });
    check("(e) an archived session (archivedAt set, no live engine file) reads its captured snapshot",
      Array.isArray(result) && result.length === 2 && result[0].text === "archived turn one");
    await client.close();
    db.close();
  }

  // ============ (f) pagination envelope: offset/limit/turnRange + nextOffset paging to completion ============
  {
    const db = tmpDb();
    const proj = "proj-page";
    seedProject(db, proj, "Page");
    const companionSess = "companion-page";
    seedSession(db, companionSess, proj, "assistant");
    seedSession(db, "target-big", proj, "manager", { engineSessionId: "eng-big" });
    const BIG_TURN_COUNT = 10;
    writeLiveTranscript(proj, "eng-big", Array.from({ length: BIG_TURN_COUNT }, (_, i) => `turn-${i}-` + "x".repeat(10_000)));
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "transcript-read", projectId: proj, mode: "read" });

    const orch = new OrchestrationMcpRouter(db, {}, {}, makeFakePty(null, "the owner said: read the big one"));
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const firstPage = await call(client, "transcript_read", { sessionId: "target-big" });
    check("(f) a large transcript with no paging arg returns a page envelope (not the bare full array)",
      !Array.isArray(firstPage) && Array.isArray(firstPage.turns) && firstPage.totalTurns === BIG_TURN_COUNT);

    let off = 0, seen = 0, pages = 0;
    while (off !== null) {
      const pg = await call(client, "transcript_read", { sessionId: "target-big", offset: off });
      seen += pg.returned;
      pages++;
      off = pg.nextOffset === null ? null : pg.nextOffset;
      if (pages > 20) { check("(f) paging terminates (runaway guard)", false); break; }
    }
    check(`(f) offset paging start->nextOffset->...->null covers all ${BIG_TURN_COUNT} turns exactly once (got ${seen} across ${pages} pages)`,
      seen === BIG_TURN_COUNT && pages >= 2);

    const ranged = await call(client, "transcript_read", { sessionId: "target-big", turnRange: [2, 5] });
    check("(f) turnRange:[2,5] bounds the addressable window to 3 turns",
      !Array.isArray(ranged) && ranged.offset === 2 && ranged.turns.length === 3 && ranged.turns[0].text.startsWith("turn-2-"));

    const limited = await call(client, "transcript_read", { sessionId: "target-big", offset: 0, limit: 2 });
    check("(f) limit:2 bounds this page to 2 turns", !Array.isArray(limited) && limited.returned === 2 && limited.nextOffset === 2);

    const last3 = await call(client, "transcript_read", { sessionId: "target-big", lastN: 3 });
    check("(f) lastN:3 returns a bare array of the last 3 turns", Array.isArray(last3) && last3.length === 3 && last3[2].text.startsWith("turn-9-"));

    await client.close();
    db.close();
  }

  // ============ (g) ambiguous/too-short id-prefix ⇒ AMBIGUOUS_ID_ERROR, filtered to IN-SCOPE matches ============
  {
    const db = tmpDb();
    const projGranted = "proj-g-granted", projOther = "proj-g-other";
    seedProject(db, projGranted, "G-Granted");
    seedProject(db, projOther, "G-Other");
    const companionSess = "companion-prefix";
    seedSession(db, companionSess, projGranted, "assistant");
    // Two in-scope sessions sharing an 8-char prefix — genuinely ambiguous WITHIN scope.
    seedSession(db, "bbbbbbbb-one", projGranted, "manager", { engineSessionId: "eng-b1" });
    seedSession(db, "bbbbbbbb-two", projGranted, "manager", { engineSessionId: "eng-b2" });
    // An out-of-scope session sharing a DIFFERENT 8-char prefix with only ONE in-scope session — must
    // resolve unambiguously (the out-of-scope match is invisible to the ambiguity check).
    seedSession(db, "cccccccc-scoped", projGranted, "manager", { engineSessionId: "eng-c1" });
    seedSession(db, "cccccccc-other", projOther, "manager", { engineSessionId: "eng-c2" });
    writeLiveTranscript(projGranted, "eng-c1", ["resolves unambiguously"]);
    db.upsertCompanionCapabilityGrant({ sessionId: companionSess, capability: "transcript-read", projectId: projGranted, mode: "read" });

    const orch = new OrchestrationMcpRouter(db, {}, {}, makeFakePty(null, "the owner said: read it"));
    const client = await connect(orch.buildServer(companionSess, "assistant"));

    const tooShort = await call(client, "transcript_read", { sessionId: "1111" });
    check("(g) a too-short (<8 char) prefix returns AMBIGUOUS_ID_ERROR", typeof tooShort.error === "string" && /ambiguous/i.test(tooShort.error));

    const ambiguous = await call(client, "transcript_read", { sessionId: "bbbbbbbb" });
    check("(g) a prefix ambiguous among TWO in-scope sessions returns AMBIGUOUS_ID_ERROR", typeof ambiguous.error === "string" && /ambiguous/i.test(ambiguous.error));

    const scopedUnambiguous = await call(client, "transcript_read", { sessionId: "cccccccc" });
    check("(g) a prefix shared with an OUT-OF-SCOPE session (but unique in-scope) resolves unambiguously — the out-of-scope match is filtered out first",
      Array.isArray(scopedUnambiguous) && scopedUnambiguous.length === 1 && scopedUnambiguous[0].text === "resolves unambiguously");

    await client.close();
    db.close();
  }

  // ============ (h) defensive null-projectId session row is rejected (unreachable via the real Db's
  // NOT NULL project_id column — driven directly through the exported COMPANION_CAPABILITIES entry) ============
  {
    const transcriptReadCap = COMPANION_CAPABILITIES.find((c) => c.slug === "transcript-read");
    check("(h) transcript-read is registered in COMPANION_CAPABILITIES", !!transcriptReadCap);

    const tools = new Map();
    const fakeServer = { registerTool(name, _def, handler) { tools.set(name, handler); } };
    const fakeDb = {
      getSession(id) {
        if (id !== "sess-null-project") return undefined;
        return { id, projectId: null, cwd: "x", engineSessionId: null, archivedAt: null };
      },
      findSessionsByIdPrefix() { return []; },
    };
    const ctx = {
      sessionId: "companion-null-project",
      scope: { projectIds: new Set(["some-project"]), modeFor: () => undefined, mayAct: () => false, configFor: () => ({}) },
      attest: { getActiveTurnOwnerText: () => "the owner said: read it" },
      pty: { getActiveTurnOrigin: () => null, getActiveTurnSenderId: () => null, enqueueStdin: () => ({ delivered: false }) },
      outbound: {},
      sessions: {},
      trustWindow: {},
    };
    transcriptReadCap.register(fakeServer, ctx, fakeDb);
    const handler = tools.get("transcript_read");
    const raw = await handler({ sessionId: "sess-null-project" });
    const result = JSON.parse(raw.content[0].text);
    check("(h) a session row with a null projectId is rejected with {error}, not read",
      typeof result.error === "string");
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — transcript_read registers ONLY behind a transcript-read grant, requires BOTH an owner-authored turn (Primitive A) and a DM route before any db lookup, resolves an in-scope session by id or an in-scope-filtered id-prefix (collapsing out-of-scope/not-found into one message), reads live or archived transcripts, and pages a large transcript deterministically."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
