import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — CONVERSATION HISTORY (card 85f62475): companion_messages grouped into conversations
// (one per "/new"/"/reset" boundary), retained + browsable rather than deleted. This is the sibling of
// companion-new.mjs (which covers the end-to-end "/new"/"/reset" command path) — this file covers the DATA
// MODEL in isolation: grouping/tagging, the retention-count eviction, legacy-row migration, and the two new
// human-only history REST routes. Fully hermetic: a temp LOOM_HOME + a REAL Db + the REAL buildServer
// (app.inject) for the REST portion. NO network, NO real claude, NO daemon. Proves:
//   1. Every companion_messages row is tagged conversationSeq; a brand-new session lazily opens conversation
//      1 on its first message (no special-casing needed).
//   2. db.startNewCompanionConversation closes the current conversation (endedAt set) and opens the next
//      (seq+1); listCompanionConversations lists both, newest-first, each with a correct message count and a
//      truncated single-line preview of its first message.
//   3. "/new"-SPAM (consecutive "new conversation" calls with nothing sent between them) is a pure no-op: it
//      does NOT close/reopen (an empty open conversation is REUSED, not abandoned), so it never mints a
//      phantom empty conversation and never consumes a retention slot — a burst of "/new" can't silently
//      evict real, browsable history. The eventual next message lands in the SAME still-open conversation.
//   4. RETENTION CAP: once a session holds more than the retained-conversation cap, the OLDEST conversations
//      are evicted WHOLESALE (their companion_messages rows AND their companion_conversations row) — never a
//      partial/mid-conversation prune, and the currently-open conversation is never touched by eviction.
//   5. MIGRATION: a session with companion_messages rows but no companion_conversations row (the pre-upgrade
//      shape) gets exactly one OPEN conversation-1 backfilled on the next Db open, started_at = its earliest
//      message; idempotent (a further reopen does not duplicate/alter it); a session with ZERO messages ever
//      is left alone.
//   6. REST: GET /api/companion/conversations/:sessionId lists conversations (excluding a same-session in-
//      progress OTHER companion's rows — isolation); GET .../:sessionId/:seq fetches one conversation's full
//      unified message list; 404 on an unknown session, a non-integer seq, or a seq the session never had.
// Run: 1) build (turbo builds shared first), 2) node test/companion-conversation-history.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-conv-history-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { IN_APP_CHANNEL } = await import("../dist/companion/in-app.js");

const dbFile = path.join(tmpHome, "loom.db");
let db = new Db(dbFile);

const now0 = new Date().toISOString();
const projId = randomUUID();
db.insertProject({ id: projId, name: "Conv History", repoPath: projId, vaultPath: projId, config: {}, createdAt: now0, archivedAt: null });
const makeCompanionSession = (name) => {
  const agentId = randomUUID();
  db.insertAgent({ id: agentId, projectId: projId, name, position: 0, startupPrompt: "P", profileId: null, endpoint: false, ioSchema: null });
  const sessId = randomUUID();
  db.insertSession({
    id: sessId, projectId: projId, agentId, engineSessionId: `eng-${sessId}`, title: null, cwd: projId,
    processState: "live", resumability: "resumable", busy: false, createdAt: now0, lastActivity: now0, lastError: null, role: "assistant",
  });
  return sessId;
};

try {
  // ============ 1 — lazy-open conversation 1; every row tagged ============
  {
    const sess = makeCompanionSession("Companion 1");
    db.insertCompanionMessage({ id: randomUUID(), sessionId: sess, channel: IN_APP_CHANNEL, chatId: sess, author: "user", text: "hi", createdAt: now0 });
    db.insertCompanionMessage({ id: randomUUID(), sessionId: sess, channel: IN_APP_CHANNEL, chatId: sess, author: "companion", text: "hello!", createdAt: now0 });
    const current = db.listCurrentCompanionMessages(sess);
    check("(1) both rows lazily land in conversation 1 (no special-casing for a brand-new session)", current.length === 2 && current.every((m) => m.conversationSeq === 1));
  }

  // ============ 2 — startNewCompanionConversation closes+opens; history list newest-first, count + preview ============
  let sess2;
  {
    sess2 = makeCompanionSession("Companion 2");
    const longMultilineFirstMessage = "line one\nline two\n".repeat(10) + "END"; // 193 chars, well past the 120-char preview cap
    db.insertCompanionMessage({ id: randomUUID(), sessionId: sess2, channel: IN_APP_CHANNEL, chatId: sess2, author: "user", text: longMultilineFirstMessage, createdAt: now0 });
    db.insertCompanionMessage({ id: randomUUID(), sessionId: sess2, channel: IN_APP_CHANNEL, chatId: sess2, author: "companion", text: "hi Daniel!", createdAt: now0 });
    db.startNewCompanionConversation(sess2);
    db.insertCompanionMessage({ id: randomUUID(), sessionId: sess2, channel: IN_APP_CHANNEL, chatId: sess2, author: "companion", text: "🆕 Started a fresh conversation.", createdAt: new Date().toISOString() });

    const conversations = db.listCompanionConversations(sess2);
    check("(2) history list shows BOTH conversations, newest-first", conversations.length === 2 && conversations[0].seq === 2 && conversations[1].seq === 1);
    check("(2) conversation 1 is CLOSED (endedAt set), conversation 2 is OPEN (endedAt null)", conversations[1].endedAt !== null && conversations[0].endedAt === null);
    check("(2) conversation 1's message count is 2", conversations[1].messageCount === 2);
    check("(2) conversation 2's message count is 1 (just the ack so far)", conversations[0].messageCount === 1);
    check("(2) preview collapses newlines/whitespace to single spaces and is truncated (no raw newline, capped length)", !conversations[1].preview.includes("\n") && conversations[1].preview.length <= 121 && conversations[1].preview.endsWith("…"));
  }

  // ============ 3 — "/new"-SPAM (consecutive calls with nothing sent between) is a pure no-op, retention-slot-free ============
  {
    const before = db.listCompanionConversations(sess2).length; // conv1 (2 msgs) + conv2 (1 msg, the ack) = 2
    db.startNewCompanionConversation(sess2); // conv2 is NON-empty (1 msg) → real archive: closes conv2, opens conv3 (empty)
    const maxSeqAfterFirst = db.listCompanionConversations(sess2); // conv3 still empty, not yet listed
    check("(3) closing a NON-empty conversation still archives it normally (now 2 real conversations, conv3 not yet listed — it's empty)", maxSeqAfterFirst.length === before);

    // A burst of MORE "/new" calls with nothing sent in between: conv3 is open and EMPTY every time, so each
    // is a NO-OP — no new seq is minted, no retention slot is consumed, no empty conversation is left behind.
    for (let i = 0; i < 5; i++) db.startNewCompanionConversation(sess2);
    const afterSpam = db.listCompanionConversations(sess2);
    check("(3) a burst of /new-spam changes NOTHING in the history list (still just 2 real conversations)", afterSpam.length === before);
    check("(3) /new-spam never mints a phantom empty conversation seq (still just conv3 open, not conv4..conv8)", !afterSpam.some((c) => c.seq > 2));

    db.insertCompanionMessage({ id: randomUUID(), sessionId: sess2, channel: IN_APP_CHANNEL, chatId: sess2, author: "user", text: "finally, a message", createdAt: new Date().toISOString() });
    const current = db.listCurrentCompanionMessages(sess2);
    check("(3) the next real message reuses the SAME still-open conversation (seq 3) the spam never advanced past", current.length === 1 && current[0].conversationSeq === 3);
    const afterMessage = db.listCompanionConversations(sess2);
    check("(3) THAT conversation only now becomes visible in the history list (3 real conversations total)", afterMessage.length === before + 1 && afterMessage[0].seq === 3);
  }

  // ============ 4 — retention cap: oldest conversations evicted WHOLESALE past the cap ============
  {
    // Mirrors MAX_RETAINED_CONVERSATIONS in db.ts (20) — not exported, so asserted against here by count.
    const RETAIN_CAP = 20;
    const sess = makeCompanionSession("Retention");
    for (let i = 1; i <= RETAIN_CAP + 5; i++) {
      db.insertCompanionMessage({ id: randomUUID(), sessionId: sess, channel: IN_APP_CHANNEL, chatId: sess, author: "user", text: `conv-${i}-msg`, createdAt: new Date().toISOString() });
      db.startNewCompanionConversation(sess);
    }
    // One more message so the FINAL (still-open) conversation is non-empty too, and thus visible in the list.
    db.insertCompanionMessage({ id: randomUUID(), sessionId: sess, channel: IN_APP_CHANNEL, chatId: sess, author: "user", text: "the current one", createdAt: new Date().toISOString() });

    const conversations = db.listCompanionConversations(sess);
    check(`(4) retained conversations are capped at ${RETAIN_CAP}`, conversations.length === RETAIN_CAP);
    check("(4) the OLDEST conversations (seq 1..5) were evicted", !conversations.some((c) => c.seq <= 5));
    check("(4) the newest (still-open) conversation survives, holding its own message", conversations[0].endedAt === null && conversations[0].preview === "the current one");
    // Confirm eviction is WHOLESALE: an evicted conversation's messages are gone too, not just its list row.
    check("(4) an evicted conversation's own companion_messages rows are gone (not just its conversations row)", db.listCompanionMessagesForConversation(sess, 1).length === 0);
    // The still-open, most-recent conversation was never itself a target of eviction.
    const openSeq = RETAIN_CAP + 6; // 25 closes (seq 1..25) then the final still-open conversation is seq 26
    check("(4) the currently-open conversation is never evicted", db.listCompanionMessagesForConversation(sess, openSeq).length === 1);
  }

  // ============ 5 — MIGRATION: a pre-upgrade session (messages, no companion_conversations row) is backfilled ============
  {
    const sess = makeCompanionSession("Legacy");
    const t0 = "2026-01-01T00:00:00.000Z";
    const t1 = "2026-01-01T00:00:05.000Z";
    db.insertCompanionMessage({ id: randomUUID(), sessionId: sess, channel: IN_APP_CHANNEL, chatId: sess, author: "user", text: "old message 1", createdAt: t0 });
    db.insertCompanionMessage({ id: randomUUID(), sessionId: sess, channel: IN_APP_CHANNEL, chatId: sess, author: "companion", text: "old message 2", createdAt: t1 });

    // A session with ZERO messages ever — the migration must leave it alone (no phantom conversation).
    const emptySess = makeCompanionSession("Never Chatted");

    db.close();
    // Simulate the pre-upgrade shape directly on disk: strip the (already auto-opened) companion_conversations
    // row for `sess`, mirroring a DB that predates this feature (its rows already default conversation_seq=1
    // via the additive ALTER; only the companion_conversations table is genuinely new/empty on such a DB).
    const raw = new Database(dbFile);
    raw.prepare("DELETE FROM companion_conversations WHERE session_id = ?").run(sess);
    raw.close();

    // Reopening Db runs the migration in its constructor.
    db = new Db(dbFile);
    const backfilled = db.listCompanionConversations(sess);
    check("(5) migration backfills exactly ONE open conversation for the legacy session", backfilled.length === 1 && backfilled[0].seq === 1 && backfilled[0].endedAt === null);
    check("(5) its startedAt is the session's EARLIEST message time, not 'now'", backfilled[0].startedAt === t0);
    check("(5) its message count reflects both legacy rows", backfilled[0].messageCount === 2);
    check("(5) a session with ZERO messages ever gets NO phantom conversation", db.listCompanionConversations(emptySess).length === 0);

    // Idempotency: a further reopen must not duplicate or alter the backfilled row.
    db.close();
    db = new Db(dbFile);
    const again = db.listCompanionConversations(sess);
    check("(5) idempotent — a further reopen does not duplicate or alter the backfilled conversation", again.length === 1 && again[0].seq === 1 && again[0].startedAt === t0);
  }

  // ============ 6 — REST: list + fetch-one, isolation, 404s ============
  {
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub });
    try {
      const sessA = makeCompanionSession("REST A");
      const sessB = makeCompanionSession("REST B");
      const workerAgentId = randomUUID();
      db.insertAgent({ id: workerAgentId, projectId: projId, name: "Worker", position: 9, startupPrompt: "W", profileId: null, endpoint: false, ioSchema: null });
      const workerSess = randomUUID();
      db.insertSession({
        id: workerSess, projectId: projId, agentId: workerAgentId, engineSessionId: "eng-worker", title: null, cwd: projId,
        processState: "live", resumability: "resumable", busy: false, createdAt: now0, lastActivity: now0, lastError: null, role: "worker",
      });

      db.insertCompanionMessage({ id: randomUUID(), sessionId: sessA, channel: IN_APP_CHANNEL, chatId: sessA, author: "user", text: "conversation one, message one", createdAt: now0 });
      db.startNewCompanionConversation(sessA);
      db.insertCompanionMessage({ id: randomUUID(), sessionId: sessA, channel: IN_APP_CHANNEL, chatId: sessA, author: "user", text: "conversation two, message one", createdAt: new Date().toISOString() });
      db.insertCompanionMessage({ id: randomUUID(), sessionId: sessB, channel: IN_APP_CHANNEL, chatId: sessB, author: "user", text: "belongs to the other companion", createdAt: now0 });

      const listRes = await app.inject({ method: "GET", url: `/api/companion/conversations/${sessA}` });
      const listBody = JSON.parse(listRes.payload);
      check("(6) conversations list: 200, two entries, newest-first, per-session isolated", listRes.statusCode === 200 && listBody.conversations.length === 2 && listBody.conversations[0].seq === 2 && !listBody.conversations.some((c) => c.preview?.includes("other companion")));

      const oneRes = await app.inject({ method: "GET", url: `/api/companion/conversations/${sessA}/1` });
      const oneBody = JSON.parse(oneRes.payload);
      check("(6) fetch-one: 200, returns conversation meta + its full message list", oneRes.statusCode === 200 && oneBody.conversation.seq === 1 && oneBody.messages.length === 1 && oneBody.messages[0].text === "conversation one, message one");

      const unknownSessRes = await app.inject({ method: "GET", url: `/api/companion/conversations/${randomUUID()}` });
      check("(6) unknown session → 404", unknownSessRes.statusCode === 404);

      const wrongRoleRes = await app.inject({ method: "GET", url: `/api/companion/conversations/${workerSess}` });
      check("(6) a non-assistant (worker) session → 400", wrongRoleRes.statusCode === 400);

      const unknownSeqRes = await app.inject({ method: "GET", url: `/api/companion/conversations/${sessA}/999` });
      check("(6) an unknown seq for a real session → 404", unknownSeqRes.statusCode === 404);

      const badSeqRes = await app.inject({ method: "GET", url: `/api/companion/conversations/${sessA}/not-a-number` });
      check("(6) a non-integer seq → 400", badSeqRes.statusCode === 400);
    } finally {
      await app.close();
    }
  }
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — conversation grouping/tagging, close+open, the empty-conversation-never-listed guard, the retention-count eviction (wholesale, never mid-conversation, never the open one), the legacy-row migration (idempotent, earliest-message started_at, zero-message sessions untouched), and the history REST surface (list + fetch-one, isolated, 404s) all hold."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
