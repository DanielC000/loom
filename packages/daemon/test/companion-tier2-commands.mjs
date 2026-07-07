import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — Tier-2 slash commands, first slice: "/status" (in-chat state readout) and "/start"
// (Telegram's first-contact handshake, intercepted so it never leaks a raw agent turn). Fully hermetic: a
// REAL Db, a REAL InAppChannel wired like index.ts, and the REAL CompanionController + factory-built
// ChatGateway (createCompanionGateway) — NO network, NO real claude, NO daemon. Proves:
//   1. Both "/status" and "/start" are registered commands (COMMANDS map + COMMAND_MENU).
//   2. "/status" reads voiceReplies + ttsLang straight from the injected CompanionVoicePrefs and formats a
//      compact ack — both the default (unset) pref and an explicitly-set one.
//   3. "/start" returns a fixed friendly ack and needs no CommandDeps.
//   4. End-to-end via CompanionController.handleInAppInbound: both commands are swallowed (never become a
//      turn — accepted:false, reason:"command"), delivered live, but — unlike "/new"'s intentional
//      conversation-boundary marker — their ack is transport chrome and is NEVER persisted as history
//      (cross-channel ack-recording asymmetry fix).
//   5. An unrecognized "/word" is still NOT swallowed (falls through to the normal pipeline byte-identical).
//   6. "/voice on|auto" in a GROUP refuses ("not available in group chats yet") WITHOUT persisting a pref
//      the outbound path (always senderId:null) can never honor — "off" and a DM's "on" still persist,
//      unchanged (CR#2 N3).
// Run: 1) build (turbo builds shared first), 2) node test/companion-tier2-commands.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-tier2-${Date.now()}-${process.pid}`);
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
const { commandHandler, registeredCommandNames, COMMAND_MENU } = await import("../dist/companion/commands.js");
const { inMemoryVoicePrefs } = await import("../dist/companion/voice-prefs.js");

const dbFile = path.join(tmpHome, "loom.db");
const db = new Db(dbFile);

const makeClient = () => { const frames = []; return { frames, client: { deliver: (f) => frames.push(f) } }; };

// A minimal real project/agent/session trio so companion_messages' FK (session_id REFERENCES sessions(id))
// is satisfiable — mirrors companion-new.mjs's seeding.
const now0 = new Date().toISOString();
const projId = randomUUID();
db.insertProject({ id: projId, name: "Tier2-Commands", repoPath: projId, vaultPath: projId, config: {}, createdAt: now0, archivedAt: null });
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

function makeController(sid) {
  const inApp = new InAppChannel({
    record: (s, author, text) => db.insertCompanionMessage({ id: randomUUID(), sessionId: s, channel: IN_APP_CHANNEL, chatId: s, author, text, createdAt: new Date().toISOString() }),
  });
  const { frames, client } = makeClient();
  inApp.attach(sid, client);
  const submitted = [];
  const submitSpy = (s, text, route) => { submitted.push({ s, text, route }); return { delivered: true }; };
  const cfg = {
    botToken: null, allowedChatId: sid, sessionId: sid, chatScope: "dm",
    homeChannel: IN_APP_CHANNEL, homeChatId: sid, heartbeatIntervalMinutes: 0, heartbeatPrompt: "p",
  };
  const controller = new CompanionController({
    db, submitTurn: submitSpy,
    pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getPending: () => [] },
    hooks: { companionSessionIds: new Set() }, env: {}, inApp, resolveEffective: () => [cfg],
  });
  return { controller, frames, submitted };
}

try {
  // ============ 1 — '/status' and '/start' are registered ============
  {
    const names = registeredCommandNames();
    const menuNames = COMMAND_MENU.map((c) => c.command);
    check("registeredCommandNames includes 'status' and 'start'", names.includes("status") && names.includes("start"));
    check("COMMAND_MENU advertises both 'status' and 'start'", menuNames.includes("status") && menuNames.includes("start"));
  }

  // ============ 2 — '/status' reads voiceReplies + ttsLang straight from CompanionVoicePrefs ============
  {
    const route = { sessionId: "s", channel: "c", chatId: "c", senderId: null };
    const prefs = inMemoryVoicePrefs();

    const defaultResult = commandHandler("status")(undefined, route, prefs, {});
    check("/status (default pref): reports voice replies off", defaultResult.ack.includes("Voice replies: off"));
    check("/status (default pref): reports auto-detect language", defaultResult.ack.includes("auto-detect"));

    prefs.setLang(route, "en");
    prefs.setVoiceReplies(route, "on");
    const setResult = commandHandler("status")(undefined, route, prefs, {});
    check("/status (set pref): reports voice replies on", setResult.ack.includes("Voice replies: on"));
    check("/status (set pref): reports the set language", setResult.ack.includes("en"));
  }

  // ============ 3 — '/start' returns a fixed friendly ack, no deps needed ============
  {
    const route = { sessionId: "s", channel: "c", chatId: "c", senderId: null };
    const result = commandHandler("start")(undefined, route, inMemoryVoicePrefs(), {});
    check("/start: returns a non-empty friendly ack", typeof result.ack === "string" && result.ack.length > 0);
  }

  // ============ 4 — end-to-end via CompanionController.handleInAppInbound: swallowed, never a turn ============
  {
    const { controller, submitted } = makeController(sessionId);
    await controller.reconcile(); // OFF → ON: builds the REAL gateway via factory.ts's createCompanionGateway

    const r = await controller.handleInAppInbound(sessionId, "/status");
    check("/status: never becomes a turn (a command result, not accepted)", r.accepted === false && r.reason === "command" && r.command === "status");
    check("/status: acked", r.acked === true);
    check("/status: no turn ever submitted", submitted.length === 0);

    const after = db.listCompanionMessages(sessionId, IN_APP_CHANNEL);
    check("/status: the ack is transport chrome — NOT recorded as a companion history row", !after.some((m) => m.author === "companion" && m.text.includes("Voice replies")));
  }

  {
    const { controller, submitted } = makeController(sessionId);
    await controller.reconcile();

    const r = await controller.handleInAppInbound(sessionId, "/start");
    check("/start: never becomes a turn (a command result, not accepted)", r.accepted === false && r.reason === "command" && r.command === "start");
    check("/start: acked", r.acked === true);
    check("/start: no turn ever submitted", submitted.length === 0);
  }

  // ============ 5 — an unrecognized "/word" is still not swallowed ============
  {
    check("an unregistered command name has no handler (falls through to the normal pipeline)", commandHandler("statusx") === undefined && commandHandler("totallyunknown") === undefined);

    const { controller, submitted } = makeController(sessionId);
    await controller.reconcile();
    const r = await controller.handleInAppInbound(sessionId, "/totallyunknown some args");
    check("an unrecognized '/word' is submitted as a normal turn (byte-identical fallthrough)", r.accepted === true && submitted.some((s) => s.text === "/totallyunknown some args"));
  }

  // ============ 6 — '/voice' GROUP path does NOT persist a dead pref before refusing (CR#2 N3) ============
  {
    // The outbound reply always resolves senderId:null (VOICE-P3 fork #3), so a per-sender GROUP row
    // (senderId set) is a write the outbound path can NEVER read back — a dead write. "on"/"auto" in a
    // group refuse with an ack saying so; that refusal must not be preceded by exactly the write it just
    // told the user didn't happen. "off" is unaffected (existing, unchanged behavior).
    let writes = 0;
    const base = inMemoryVoicePrefs();
    const spyPrefs = {
      resolve: (r) => base.resolve(r),
      setLang: (r, c) => base.setLang(r, c),
      setVoiceReplies: (r, m) => { writes++; return base.setVoiceReplies(r, m); },
    };
    const groupRoute = { sessionId: "s", channel: "c", chatId: "c", senderId: "user-1" }; // group: senderId set
    const dmRoute = { sessionId: "s", channel: "c", chatId: "c", senderId: null };

    const onResult = commandHandler("voice")("on", groupRoute, spyPrefs, {});
    check("/voice on (group): refused with the group-unavailable ack", /available in group chats/i.test(onResult.ack));
    check("/voice on (group): the dead pref write is skipped", writes === 0);

    const autoResult = commandHandler("voice")("auto", groupRoute, spyPrefs, {});
    check("/voice auto (group): also refused", /available in group chats/i.test(autoResult.ack));
    check("/voice auto (group): still no write", writes === 0);

    const offResult = commandHandler("voice")("off", groupRoute, spyPrefs, {});
    check("/voice off (group): unaffected by the fix — still persists as before", offResult.ack.includes("turned off") && writes === 1);

    const dmResult = commandHandler("voice")("on", dmRoute, spyPrefs, {});
    check("/voice on (DM): unaffected by the fix — still persists as before", dmResult.ack.includes("turned on") && writes === 2);
  }
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — '/status' reads voice-replies + language from the injected CompanionVoicePrefs, '/start' acks a fixed greeting with no deps, both are swallowed end-to-end (never a turn), an unrecognized '/word' still falls through unchanged, and '/voice on|auto' in a group refuses WITHOUT persisting a dead pref."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
