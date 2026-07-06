import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — cross-channel transport-ack recording asymmetry fix (in-app.ts's `adapter.send` used to
// record EVERY outbound send unconditionally, so `tryAck` — which routes command/error/pairing acks through
// that SAME `send` — persisted /status/help-style acks as in-app companion history rows, while the identical
// Telegram acks were never recorded, since telegram.send doesn't record at all). Fully hermetic: a REAL Db, a
// REAL InAppChannel wired exactly like index.ts, and the REAL CompanionController + factory-built ChatGateway
// (createCompanionGateway) — NO network, NO real claude, NO daemon. Proves, on the SAME session/channel:
//   1. A transport-chrome command ack ("/status") is delivered live but NEVER persisted as a history row.
//   2. The "/new" conversation-boundary marker ack IS still persisted (the one deliberate exception).
//   3. A REAL agent reply (deliverReply) is still persisted, exactly as before.
// Run: 1) build (turbo builds shared first), 2) node test/companion-ack-not-recorded.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-ack-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome;
process.env.HOME = sandboxHome;

const { requireHermeticEnv } = await import("./_guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { InAppChannel, IN_APP_CHANNEL } = await import("../dist/companion/in-app.js");
const { CompanionController } = await import("../dist/companion/controller.js");

const dbFile = path.join(tmpHome, "loom.db");
const db = new Db(dbFile);

const makeClient = () => { const frames = []; return { frames, client: { deliver: (f) => frames.push(f) } }; };

// A minimal real project/agent/session trio so companion_messages' FK (session_id REFERENCES sessions(id))
// is satisfiable — mirrors companion-new.mjs's seeding.
const now0 = new Date().toISOString();
const projId = randomUUID();
db.insertProject({ id: projId, name: "Ack-Not-Recorded", repoPath: projId, vaultPath: projId, config: {}, createdAt: now0, archivedAt: null });
const agentId = randomUUID();
db.insertAgent({ id: agentId, projectId: projId, name: "Companion", startupPrompt: "P", position: 0, profileId: null, endpoint: false, ioSchema: null });
const sessionId = randomUUID();
db.insertSession({
  id: sessionId, projectId: projId, agentId, engineSessionId: `eng-${sessionId}`, title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now0, lastActivity: now0, lastError: null, role: "assistant",
});
// In-app binding minted directly (mirrors the provision endpoint — factory.ts never seeds one for a
// botToken:null / in-app-only companion). Without this, handleInAppInbound rejects as chat-not-allowlisted.
db.upsertCompanionBinding({ sessionId, channel: IN_APP_CHANNEL, chatId: sessionId, scope: "dm" });

const inApp = new InAppChannel({
  record: (sid, author, text) => db.insertCompanionMessage({ id: randomUUID(), sessionId: sid, channel: IN_APP_CHANNEL, chatId: sid, author, text, createdAt: new Date().toISOString() }),
});
const { client } = makeClient();
inApp.attach(sessionId, client);

const submitted = [];
const submitSpy = (sid, text, route) => { submitted.push({ sid, text, route }); return { delivered: true }; };
const cfg = {
  botToken: null, allowedChatId: sessionId, sessionId, chatScope: "dm",
  homeChannel: IN_APP_CHANNEL, homeChatId: sessionId, heartbeatIntervalMinutes: 0, heartbeatPrompt: "p",
};
const controller = new CompanionController({
  db, submitTurn: submitSpy,
  pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getPending: () => [] },
  hooks: { companionSessionIds: new Set() }, env: {}, inApp, resolveEffective: () => [cfg],
  // A real chat_reply always targets the in-flight turn's origin (pty.getActiveTurnOrigin); this harness
  // has no live pty turn, so fake a fixed route — mirrors companion-messages.mjs's ChatGateway-level test.
  originResolver: (sid) => (sid === sessionId ? { channel: IN_APP_CHANNEL, chatId: sessionId } : null),
});

try {
  await controller.reconcile(); // OFF → ON: builds the REAL gateway via factory.ts's createCompanionGateway

  // ============ 1 — "/status" is transport chrome: delivered live, never a history row ============
  {
    const r = await controller.handleInAppInbound(sessionId, "/status");
    check("/status: swallowed as a command (never a turn)", r.accepted === false && r.reason === "command" && r.command === "status");
    check("/status: acked", r.acked === true);
    const rows = db.listCompanionMessages(sessionId, IN_APP_CHANNEL);
    check("/status: the ack is NOT recorded as a companion history row", !rows.some((m) => m.author === "companion" && m.text.includes("Voice replies")));
  }

  // ============ 2 — a REAL agent reply is still recorded (unaffected by the ack fix) ============
  {
    const replyText = "a genuine agent reply, not an ack";
    const result = await controller.deliverReply(sessionId, replyText);
    check("real reply: delivered", result.delivered === true);
    const rows = db.listCompanionMessages(sessionId, IN_APP_CHANNEL);
    check("real reply: IS recorded as a companion history row", rows.some((m) => m.author === "companion" && m.text === replyText));
  }

  // ============ 3 — "/new" is the ONE command ack that IS the conversation-boundary marker ============
  {
    const r = await controller.handleInAppInbound(sessionId, "/new");
    check("/new: swallowed as a command (never a turn)", r.accepted === false && r.reason === "command" && r.command === "new");
    check("/new: acked", r.acked === true);
    const current = db.listCurrentCompanionMessages(sessionId);
    check("/new: the marker IS recorded in the new (now-current) conversation", current.some((m) => m.author === "companion" && m.text === "🆕 Started a fresh conversation."));
  }
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a transport-chrome command ack ('/status') is delivered but never persisted as history, a real agent reply is still recorded, and the '/new' conversation-boundary marker is still recorded — the in-app and Telegram channels now agree on what counts as history."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
