import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — the "/new"/"/reset" slash command (fresh conversation, card 85f62475: ARCHIVE not
// delete). Fully hermetic: a REAL Db, a REAL InAppChannel wired EXACTLY like index.ts (outbound record →
// db.insertCompanionMessage), and the REAL CompanionController + factory-built ChatGateway
// (createCompanionGateway) — NO network, NO real claude, NO daemon. A REAL interactive claude's own
// "/clear"-honoring behavior can't be observed hermetically (that's a live PTY runtime property) — see the
// worker report for the manual smoke result. Proves:
//   1. Both "/new" and "/reset" are registered, and are a LITERAL alias (the SAME handler function object)
//      — zero risk of the two drifting apart.
//   2. End-to-end via CompanionController.handleInAppInbound: "/new" (a) submits "/clear" via the injected
//      submitTurn (the context-reset half), (b) ARCHIVES the session's conversation ACROSS EVERY CHANNEL
//      (card 85f62475 — a seeded Telegram row is RETAINED, tagged with the now-closed conversation, not
//      deleted — superseding card 4124b61e's delete-everything behavior), and (c) pushes a live
//      {type:"cleared"} frame BEFORE the ack {type:"chat"} frame reaches an attached web client — in that
//      order, so an open panel empties before the ack bubble lands as the first message of the new,
//      still-empty-so-far conversation.
//   3. RETENTION: every pre-/new row is still readable (unpruned, unmutated) via
//      listCompanionMessagesForConversation(sessionId, 1); a NEW conversation (seq 2) opens and is what
//      listCurrentCompanionMessages/listCompanionConversations show as current going forward. The history
//      list (listCompanionConversations) shows BOTH conversations, newest-first, each with a correct
//      message count + first-message preview.
//   4. INVISIBILITY: the "/clear" text itself never becomes a companion_messages row and never reaches an
//      attached client as a frame — it is a command result (accepted:false), so it's never recorded by
//      controller.ts's accepted-only inbound hook, and chat-gateway's resetConversation never sends it
//      through any adapter.
//   5. The generalized CommandHandler contract stays BACKWARD-COMPATIBLE: /help, /lang, /voice still return
//      a plain (non-Promise) CommandResult when called with their original 3 args — byte-identical to
//      before this change.
//   6. An unrecognized "/word" is still not swallowed (falls through to the normal pipeline).
// Run: 1) build (turbo builds shared first), 2) node test/companion-new.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-new-${Date.now()}-${process.pid}`);
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
const { TELEGRAM_CHANNEL } = await import("../dist/companion/telegram.js");
const { CompanionController } = await import("../dist/companion/controller.js");
const { commandHandler, registeredCommandNames, COMMAND_MENU } = await import("../dist/companion/commands.js");
const { inMemoryVoicePrefs } = await import("../dist/companion/voice-prefs.js");

const dbFile = path.join(tmpHome, "loom.db");
const db = new Db(dbFile);

const makeClient = () => { const frames = []; return { frames, client: { deliver: (f) => frames.push(f) } }; };

// A minimal real project/agent/session trio so companion_messages' FK (session_id REFERENCES sessions(id))
// is satisfiable — mirrors companion-messages.mjs's seeding.
const now0 = new Date().toISOString();
const projId = randomUUID();
db.insertProject({ id: projId, name: "New-Command", repoPath: projId, vaultPath: projId, config: {}, createdAt: now0, archivedAt: null });
const agentId = randomUUID();
db.insertAgent({ id: agentId, projectId: projId, name: "Companion", startupPrompt: "P", position: 0, profileId: null, endpoint: false, ioSchema: null });
const sessionId = randomUUID();
db.insertSession({
  id: sessionId, projectId: projId, agentId, engineSessionId: `eng-${sessionId}`, title: null, cwd: projId,
  processState: "live", resumability: "resumable", busy: false, createdAt: now0, lastActivity: now0, lastError: null, role: "assistant",
});

try {
  // ============ 1 — /new and /reset: registered, and a LITERAL alias (same function object) ============
  {
    const names = registeredCommandNames();
    const menuNames = COMMAND_MENU.map((c) => c.command);
    check("registeredCommandNames includes 'new' and 'reset'", names.includes("new") && names.includes("reset"));
    check("COMMAND_MENU advertises both 'new' and 'reset'", menuNames.includes("new") && menuNames.includes("reset"));
    check("'/new' and '/reset' are the SAME handler function object (a literal alias — cannot drift apart)", commandHandler("new") === commandHandler("reset"));
  }

  // ============ 2/3/4 — end-to-end: seed history, "/new", assert context-reset + ARCHIVE + ordering + invisibility ============
  {
    // In-app binding minted directly (mirrors the provision endpoint — factory.ts never seeds one for a
    // botToken:null / in-app-only companion).
    db.upsertCompanionBinding({ sessionId, channel: IN_APP_CHANNEL, chatId: sessionId, scope: "dm" });

    // Seed EXISTING chat history — proves /new actually archives something, not just an already-empty table.
    db.insertCompanionMessage({ id: randomUUID(), sessionId, channel: IN_APP_CHANNEL, chatId: sessionId, author: "user", text: "my name is Daniel", createdAt: now0 });
    db.insertCompanionMessage({ id: randomUUID(), sessionId, channel: IN_APP_CHANNEL, chatId: sessionId, author: "companion", text: "hi Daniel!", createdAt: now0 });
    check("setup: history seeded before /new", db.listCompanionMessages(sessionId, IN_APP_CHANNEL).length === 2);
    // ALSO seed a Telegram row for the SAME session — proves /new's archive is cross-channel (card 85f62475),
    // not just in-app. This session has no Telegram binding, but the FK only cares about session_id.
    db.insertCompanionMessage({ id: randomUUID(), sessionId, channel: TELEGRAM_CHANNEL, chatId: "999", author: "user", text: "hey from telegram", createdAt: now0 });
    check("setup: a telegram-channel row also exists before /new", db.listAllCompanionMessages(sessionId).some((m) => m.channel === TELEGRAM_CHANNEL));
    check("setup: every seeded row lands in conversation 1 (the lazily-opened first conversation)", db.listAllCompanionMessages(sessionId).every((m) => m.conversationSeq === 1));

    // The SAME outbound-record wiring index.ts uses (bug 0f01f234) — an outbound in-app send persists.
    const inApp = new InAppChannel({
      record: (sid, author, text) => db.insertCompanionMessage({ id: randomUUID(), sessionId: sid, channel: IN_APP_CHANNEL, chatId: sid, author, text, createdAt: new Date().toISOString() }),
    });
    const { frames, client } = makeClient();
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
    });
    await controller.reconcile(); // OFF → ON: builds the REAL gateway via factory.ts's createCompanionGateway

    const r = await controller.handleInAppInbound(sessionId, "/new");
    check("/new: never becomes a turn (a command result, not accepted)", r.accepted === false && r.reason === "command" && r.command === "new");
    check("/new: acked", r.acked === true);

    check("/new: submitted '/clear' via the injected submitTurn (the context-reset half)", submitted.length === 1 && submitted[0].sid === sessionId && submitted[0].text === "/clear");
    check("/new: the '/clear' submit carries no route (never produces a chat_reply)", submitted[0].route === undefined);

    // --- RETENTION: the OLD conversation (seq 1) is untouched — every pre-/new row still readable ---
    const conv1 = db.listCompanionMessagesForConversation(sessionId, 1);
    check("/new: conversation 1's rows are ALL RETAINED (3 seeded rows, none deleted)", conv1.length === 3);
    check("/new: conversation 1's rows are still tagged conversationSeq 1 (immutable once archived)", conv1.every((m) => m.conversationSeq === 1));
    check("/new: the seeded TELEGRAM row is RETAINED in conversation 1 (archive is cross-channel, not just in-app)", conv1.some((m) => m.channel === TELEGRAM_CHANNEL));

    // --- ARCHIVE: a NEW conversation (seq 2) is now current, holding only the ack ---
    const current = db.listCurrentCompanionMessages(sessionId);
    check("/new: listCurrentCompanionMessages holds ONLY the in-app ack in the NEW conversation", current.length === 1 && current[0].author === "companion" && current[0].text === "🆕 Started a fresh conversation.");
    check("/new: the ack is tagged conversationSeq 2 (the newly-opened conversation)", current[0].conversationSeq === 2);

    const conversations = db.listCompanionConversations(sessionId);
    check("/new: the history list shows BOTH conversations, newest-first", conversations.length === 2 && conversations[0].seq === 2 && conversations[1].seq === 1);
    check("/new: conversation 1 is CLOSED (endedAt set) with its true message count + preview", conversations[1].endedAt !== null && conversations[1].messageCount === 3 && conversations[1].preview === "my name is Daniel");
    check("/new: conversation 2 is OPEN (endedAt null) holding just the ack so far", conversations[0].endedAt === null && conversations[0].messageCount === 1);

    check("/new: exactly TWO live frames reached the attached client — 'cleared' then the ack 'chat'", frames.length === 2 && frames[0].type === "cleared" && frames[0].chatId === sessionId && frames[1].type === "chat" && frames[1].text === "🆕 Started a fresh conversation.");

    check("/new: INVISIBLE — '/clear' never appears as a persisted message", !current.some((m) => m.text === "/clear") && !conv1.some((m) => m.text === "/clear"));
    check("/new: INVISIBLE — '/clear' never appears as a live frame", !frames.some((f) => f.text === "/clear"));
  }

  // ============ /reset: the SAME effect, re-verified end to end (archives conversation 2, opens 3) ============
  {
    db.insertCompanionMessage({ id: randomUUID(), sessionId, channel: IN_APP_CHANNEL, chatId: sessionId, author: "user", text: "a fresh message before /reset", createdAt: new Date().toISOString() });
    check("setup: a message exists right before /reset", db.listCurrentCompanionMessages(sessionId).some((m) => m.text === "a fresh message before /reset"));

    const inApp = new InAppChannel({
      record: (sid, author, text) => db.insertCompanionMessage({ id: randomUUID(), sessionId: sid, channel: IN_APP_CHANNEL, chatId: sid, author, text, createdAt: new Date().toISOString() }),
    });
    const { frames, client } = makeClient();
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
    });
    await controller.reconcile();

    const r = await controller.handleInAppInbound(sessionId, "/reset");
    check("/reset: never becomes a turn", r.accepted === false && r.reason === "command" && r.command === "reset");
    check("/reset: submitted '/clear' too (the same underlying mechanism as /new)", submitted.some((s) => s.text === "/clear"));

    const current = db.listCurrentCompanionMessages(sessionId);
    check("/reset: the NEW current conversation holds just the ack", current.length === 1 && current[0].text === "🆕 Started a fresh conversation." && current[0].conversationSeq === 3);
    const conv2 = db.listCompanionMessagesForConversation(sessionId, 2);
    check("/reset: conversation 2's rows (the ack + the pre-reset message) are RETAINED, not deleted", conv2.length === 2 && conv2.some((m) => m.text === "a fresh message before /reset"));
    check("/reset: pushed 'cleared' then the ack 'chat' frame, same as /new", frames.length === 2 && frames[0].type === "cleared" && frames[1].type === "chat");

    const conversations = db.listCompanionConversations(sessionId);
    check("/reset: the history list now shows THREE conversations total", conversations.length === 3);
  }

  // ============ 6 — the generalized contract keeps /help, /lang, /voice byte-identical (still SYNC) ============
  {
    const helpResult = commandHandler("help")(undefined, {}, {});
    check("/help: still returns a plain (non-Promise) CommandResult from its original 3-arg call", !(helpResult instanceof Promise) && typeof helpResult.ack === "string");

    const route = { sessionId: "s", channel: "c", chatId: "c", senderId: null };
    const langResult = commandHandler("lang")("en", route, inMemoryVoicePrefs());
    check("/lang: still returns a plain (non-Promise) CommandResult", !(langResult instanceof Promise) && langResult.ack.includes("en"));

    const voiceResult = commandHandler("voice")("on", { ...route, senderId: null }, inMemoryVoicePrefs());
    check("/voice: still returns a plain (non-Promise) CommandResult", !(voiceResult instanceof Promise) && typeof voiceResult.ack === "string");
  }

  // ============ 7 — an unrecognized "/word" is still not swallowed ============
  {
    check("an unregistered command name has no handler (falls through to the normal pipeline)", commandHandler("newx") === undefined && commandHandler("totallyunknown") === undefined);
  }
} finally {
  try { db.close(); } catch { /* ignore */ }
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — '/new'/'/reset' (literal alias) submit '/clear' via the existing submitTurn primitive, ARCHIVE the current conversation (retained, tagged, browsable) while opening a fresh one, push a live 'cleared' frame BEFORE the ack, never leak '/clear' into history/frames, and the generalized CommandHandler contract keeps /help//lang//voice byte-identical."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
