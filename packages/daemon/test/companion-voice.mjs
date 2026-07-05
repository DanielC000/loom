import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — VOICE-P1 (the voice epic's FOUNDATION phase: routing + preference plumbing, NO
// STT/TTS model work). Fully hermetic: a REAL Db + a REAL ChatGateway driven with FAKE adapters/spies, and
// the REAL buildServer (app.inject) for the human-only read — NO live network, NO real claude, NO daemon.
// Proves:
//   1. parseCommand is a pure "/command [args]" matcher — recognizes /lang, /voice, an "@bot" suffix, and
//      an ARBITRARY "/word" (which the router only intercepts if a handler exists); plain text never
//      parses as a command.
//   2. ChatGateway intercepts a leading "/lang"/"/voice" from an ALREADY-authorized route BEFORE
//      submitTurn: it never becomes a turn, it acks via the adapter, and it writes the per-route pref
//      (companion/voice-prefs.ts) — /voice never clobbers a prior /lang and vice versa (partial write).
//   3. GATING PARITY (the load-bearing security property): the command intercept sits AFTER route+authz,
//      so an unbound chat or an unauthorized group sender's "/lang"/"/voice" is rejected EXACTLY like
//      text — no pref write, no ack path reached via the command branch. A GROUP binding keys the pref by
//      the per-message sender id (two members of the same group get independent settings).
//   4. An UNRECOGNIZED "/word" (no handler) falls through unchanged to the normal submit path — only
//      /lang and /voice are ever swallowed. Plain text (no leading "/") is untouched (byte-identical).
//   5. The db-backed store (createDbCompanionVoicePrefs) round-trips through a REAL Db: default-unset
//      resolves to {sttLang:null,ttsLang:null,ttsVoice:null,voiceReplies:false}; a partial write preserves
//      the other fields; a DM route (senderId:null) and a group member's route on the SAME chat are
//      independent rows.
//   6. The human-only REST read (GET /api/companion/voice-prefs/:sessionId) lists a session's rows,
//      isolates across sessions, and 404s/400s on an unknown/non-assistant session (mirrors the reminders
//      REST surface).
//   7. Telegram's setMyCommands is registered on start() (best-effort, `?.`-guarded — a bot that doesn't
//      implement it, like the existing companion-telegram.mjs fake, must not throw).
// Run: 1) build (turbo builds shared first), 2) node test/companion-voice.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };
const tick = () => new Promise((r) => setTimeout(r, 15));

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-voice-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

import { requireHermeticEnv } from "./_guard.mjs";
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { buildServer } = await import("../dist/gateway/server.js");
const { ChatGateway } = await import("../dist/companion/chat-gateway.js");
const { inMemoryVoicePrefs, createDbCompanionVoicePrefs, DEFAULT_VOICE_PREF } = await import("../dist/companion/voice-prefs.js");
const { parseCommand, commandHandler, COMMAND_MENU, registeredCommandNames } = await import("../dist/companion/commands.js");
const { createTelegramAdapter } = await import("../dist/companion/telegram.js");

function fakeAdapter(name, sent) {
  return { name, maxMessageLength: 4096, start() {}, async stop() {}, async send(chatId, text) { sent.push({ chatId, text }); } };
}

try {
  // ============ Part 1 — parseCommand: pure "/command [args]" matcher ============
  {
    check("parseCommand: /lang en", JSON.stringify(parseCommand("/lang en")) === JSON.stringify({ name: "lang", args: "en" }));
    check("parseCommand: /lang (no args)", JSON.stringify(parseCommand("/lang")) === JSON.stringify({ name: "lang" }));
    check("parseCommand: trims surrounding whitespace", JSON.stringify(parseCommand("  /voice   on  ")) === JSON.stringify({ name: "voice", args: "on" }));
    check("parseCommand: an '@bot' suffix (group-chat form) is stripped", JSON.stringify(parseCommand("/lang@LoomBot es")) === JSON.stringify({ name: "lang", args: "es" }));
    check("parseCommand: name is lower-cased", parseCommand("/LANG en")?.name === "lang");
    check("parseCommand: an ARBITRARY '/word' still parses (the router decides whether a handler exists)", JSON.stringify(parseCommand("/unknown foo")) === JSON.stringify({ name: "unknown", args: "foo" }));
    check("parseCommand: plain text never parses as a command", parseCommand("hello there") === null);
    check("parseCommand: a bare '/' never parses", parseCommand("/") === null);
    check("parseCommand: multi-line body (more than just the command line) never parses", parseCommand("/lang en\nextra line") === null);
  }

  // ============ Part 1b — menu/handler drift guard (belt-and-suspenders on top of the by-construction fix) ============
  {
    const names = registeredCommandNames();
    const menuNames = COMMAND_MENU.map((c) => c.command);
    check("commands: every registered name has a handler", names.every((n) => typeof commandHandler(n) === "function"));
    check("commands: every registered name appears in COMMAND_MENU (no unadvertised handler)", names.every((n) => menuNames.includes(n)));
    check("commands: every COMMAND_MENU entry has a real handler (no advertised-but-unhandled command)", menuNames.every((n) => typeof commandHandler(n) === "function"));
    check("commands: the handler key-set === the menu command-set (no drift either direction)", names.length === menuNames.length && new Set(names).size === new Set(menuNames).size && names.every((n) => menuNames.includes(n)));
  }

  // ============ Part 2 — DM-scope intercept: /lang + /voice write the pref, never submit a turn ============
  {
    const submitted = [];
    const submit = (sid, text) => { submitted.push({ sid, text }); return { delivered: true }; };
    const prefs = inMemoryVoicePrefs();
    const bindings = [{ sessionId: "sess-A", channel: "telegram", chatId: "111", scope: "dm" }];
    const gw = new ChatGateway(submit, bindings, undefined, undefined, undefined, prefs);
    const sent = [];
    gw.registerAdapter(fakeAdapter("telegram", sent));
    const route = { sessionId: "sess-A", channel: "telegram", chatId: "111", senderId: null };

    const rLang = await gw.handleInbound({ channel: "telegram", chatId: "111", body: "/lang en" });
    check("/lang: NOT accepted as a turn", rLang.accepted === false && rLang.reason === "command" && rLang.command === "lang");
    check("/lang: acked via the adapter", rLang.acked === true && sent.length === 1 && /Language set to en/.test(sent[0].text));
    check("/lang: never submitted a turn", submitted.length === 0);
    check("/lang: wrote sttLang+ttsLang for the route", JSON.stringify(prefs.resolve(route)) === JSON.stringify({ sttLang: "en", ttsLang: "en", ttsVoice: null, voiceReplies: false }));

    sent.length = 0;
    const rVoice = await gw.handleInbound({ channel: "telegram", chatId: "111", body: "/voice on" });
    check("/voice on: NOT accepted as a turn", rVoice.accepted === false && rVoice.reason === "command" && rVoice.command === "voice");
    check("/voice on: acked", sent.length === 1 && /turned on/.test(sent[0].text));
    check("/voice on: toggles voiceReplies WITHOUT clobbering the /lang setting (partial write)", JSON.stringify(prefs.resolve(route)) === JSON.stringify({ sttLang: "en", ttsLang: "en", ttsVoice: null, voiceReplies: true }));
    check("/voice on: still never submitted a turn", submitted.length === 0);

    // Case-normalization: primary lower, subtag upper.
    sent.length = 0;
    await gw.handleInbound({ channel: "telegram", chatId: "111", body: "/lang PT-br" });
    check("/lang normalizes case (primary lower, region upper)", /Language set to pt-BR/.test(sent[0].text) && prefs.resolve(route).sttLang === "pt-BR");

    // Invalid args → usage ack, no write.
    sent.length = 0;
    await gw.handleInbound({ channel: "telegram", chatId: "111", body: "/lang" });
    check("/lang with no code → usage ack, pref unchanged", /Usage: \/lang/.test(sent[0].text) && prefs.resolve(route).sttLang === "pt-BR");
    sent.length = 0;
    await gw.handleInbound({ channel: "telegram", chatId: "111", body: "/lang english" });
    check("/lang with an unrecognized code shape → usage ack, pref unchanged", /Usage: \/lang/.test(sent[0].text) && prefs.resolve(route).sttLang === "pt-BR");
    sent.length = 0;
    await gw.handleInbound({ channel: "telegram", chatId: "111", body: "/voice maybe" });
    check("/voice with neither on|off → usage ack, pref unchanged", /Usage: \/voice on\|off/.test(sent[0].text) && prefs.resolve(route).voiceReplies === true);

    // Unrecognized command → falls through unchanged to the normal submit path.
    const rUnknown = await gw.handleInbound({ channel: "telegram", chatId: "111", body: "/help me" });
    check("an unrecognized '/word' falls through: accepted as a normal turn", rUnknown.accepted === true);
    check("an unrecognized '/word' is submitted VERBATIM (never swallowed)", submitted.length === 1 && submitted[0].text === "/help me");

    // Plain text (byte-identical) — the existing pipeline is untouched.
    const rText = await gw.handleInbound({ channel: "telegram", chatId: "111", body: "hello there" });
    check("plain text: accepted as a normal turn", rText.accepted === true);
    check("plain text: submitted verbatim", submitted.length === 2 && submitted[1].text === "hello there");
  }

  // ============ Part 3 — gating parity: an unbound / unauthorized sender's command is rejected like text ============
  {
    const submitted = [];
    const submit = (sid, text) => { submitted.push({ sid, text }); return { delivered: true }; };
    const gw = new ChatGateway(submit, []); // no bindings at all
    const r = await gw.handleInbound({ channel: "telegram", chatId: "unbound-1", body: "/lang en" });
    check("unbound chat's /command is rejected exactly like text (chat-not-allowlisted)", r.accepted === false && r.reason === "chat-not-allowlisted");
    check("unbound chat's /command never reached submitTurn", submitted.length === 0);
  }
  {
    const submitted = [];
    const submit = (sid, text) => { submitted.push({ sid, text }); return { delivered: true }; };
    const prefs = inMemoryVoicePrefs();
    const allowed = new Set(["allowed-sender"]);
    const auth = { isSenderAuthorized(binding, sender) { return binding.scope !== "group" || (!!sender?.id && allowed.has(sender.id)); } };
    const bindings = [{ sessionId: "sess-G", channel: "telegram", chatId: "999", scope: "group" }];
    const gw = new ChatGateway(submit, bindings, auth, undefined, undefined, prefs);
    const sent = [];
    gw.registerAdapter(fakeAdapter("telegram", sent));

    // An UNAUTHORIZED group sender's /lang is rejected exactly like text — no ack via the command path, no pref write.
    const rDenied = await gw.handleInbound({ channel: "telegram", chatId: "999", body: "/lang es", sender: { id: "outsider" } });
    check("unauthorized group sender's /lang → sender-not-authorized (same as text)", rDenied.accepted === false && rDenied.reason === "sender-not-authorized");
    check("unauthorized group sender's /lang never submitted a turn", submitted.length === 0);
    check("unauthorized group sender's /lang never acked (no command-path ack)", sent.length === 0);
    check("unauthorized group sender's /lang never wrote a pref", JSON.stringify(prefs.resolve({ sessionId: "sess-G", channel: "telegram", chatId: "999", senderId: "outsider" })) === JSON.stringify(DEFAULT_VOICE_PREF));

    // An AUTHORIZED group sender's /lang works and keys the pref by THEIR OWN sender id.
    const rAllowed = await gw.handleInbound({ channel: "telegram", chatId: "999", body: "/lang es", sender: { id: "allowed-sender" } });
    check("authorized group sender's /lang is intercepted (command, not a turn)", rAllowed.accepted === false && rAllowed.reason === "command");
    check("authorized group sender's /lang wrote a pref keyed by their sender id", prefs.resolve({ sessionId: "sess-G", channel: "telegram", chatId: "999", senderId: "allowed-sender" }).sttLang === "es");
    check("a DIFFERENT sender in the SAME group chat still resolves to the default (per-sender keying)", JSON.stringify(prefs.resolve({ sessionId: "sess-G", channel: "telegram", chatId: "999", senderId: "someone-else" })) === JSON.stringify(DEFAULT_VOICE_PREF));
    check("still never submitted a turn across either group message", submitted.length === 0);
  }

  // ============ Part 4 — default ctor (no explicit voicePrefs arg) still works — the default is NOT a no-op ============
  {
    const submitted = [];
    const submit = (sid, text) => { submitted.push({ sid, text }); return { delivered: true }; };
    const gw = new ChatGateway(submit, [{ sessionId: "sess-D", channel: "telegram", chatId: "42", scope: "dm" }]);
    const sent = [];
    gw.registerAdapter(fakeAdapter("telegram", sent));
    const r = await gw.handleInbound({ channel: "telegram", chatId: "42", body: "/voice on" });
    check("default (bare) ChatGateway ctor still intercepts /voice", r.reason === "command" && sent.some((s) => /turned on/.test(s.text)));
    const r2 = await gw.handleInbound({ channel: "telegram", chatId: "42", body: "plain text unaffected" });
    check("default (bare) ChatGateway ctor: plain text still submits (byte-identical)", r2.accepted === true && submitted.some((s) => s.text === "plain text unaffected"));
  }

  // ============ Part 4b — in-memory routeKey delimiter can't be spoofed by a space-containing component ============
  {
    // Under a naive SPACE-joined key these two distinct routes would collide:
    //   {sessionId:"a", channel:"b c", chatId:"d"} → "a" + " " + "b c" + " " + "d" + " " + "" == "a b c d "
    //   {sessionId:"a b", channel:"c", chatId:"d"} → "a b" + " " + "c" + " " + "d" + " " + "" == "a b c d "
    const prefs = inMemoryVoicePrefs();
    const routeA = { sessionId: "a", channel: "b c", chatId: "d", senderId: null };
    const routeB = { sessionId: "a b", channel: "c", chatId: "d", senderId: null };
    prefs.setLang(routeA, "en");
    prefs.setLang(routeB, "fr");
    check("in-memory routeKey: a space-containing channel/sessionId does not collide two distinct routes", prefs.resolve(routeA).sttLang === "en" && prefs.resolve(routeB).sttLang === "fr");
  }

  // ============ Part 5 — db-backed store round-trips through a REAL Db ============
  {
    const dbFile = path.join(tmpHome, "voice-prefs.db");
    const db = new Db(dbFile);
    const store = createDbCompanionVoicePrefs(db);
    const dmRoute = { sessionId: "s1", channel: "telegram", chatId: "1", senderId: null };
    check("db-backed store: unset route resolves to the default", JSON.stringify(store.resolve(dmRoute)) === JSON.stringify(DEFAULT_VOICE_PREF));

    store.setLang(dmRoute, "en");
    store.setVoiceReplies(dmRoute, true);
    check("db-backed store: a voiceReplies write preserves the earlier /lang write (partial upsert)", JSON.stringify(store.resolve(dmRoute)) === JSON.stringify({ sttLang: "en", ttsLang: "en", ttsVoice: null, voiceReplies: true }));

    const groupRoute = { sessionId: "s1", channel: "telegram", chatId: "1", senderId: "sender-1" };
    store.setLang(groupRoute, "fr");
    check("db-backed store: a group member's route is INDEPENDENT of the same chat's DM (null-sender) route", store.resolve(dmRoute).sttLang === "en" && store.resolve(groupRoute).sttLang === "fr");

    check("db.getCompanionVoicePref reads the raw row", db.getCompanionVoicePref("s1", "telegram", "1", null)?.sttLang === "en");
    check("db.listCompanionVoicePrefsForSession lists every route for the session", db.listCompanionVoicePrefsForSession("s1").length === 2);
    db.close();
  }

  // ============ Part 6 — human-only REST read (GET /api/companion/voice-prefs/:sessionId) ============
  {
    const dbFile = path.join(tmpHome, "voice-prefs-rest.db");
    const db = new Db(dbFile);
    const stub = {};
    const app = await buildServer({ db, pty: stub, sessions: stub, mcp: stub, orchMcp: stub, platformMcp: stub, auditMcp: stub, userAuditMcp: stub, setupMcp: stub, runMcp: stub, control: stub, usageStatus: stub });

    const now = new Date().toISOString();
    const projId = randomUUID();
    db.insertProject({ id: projId, name: "Voice REST", repoPath: projId, vaultPath: projId, config: {}, createdAt: now, archivedAt: null });
    const agentId = randomUUID();
    db.insertAgent({ id: agentId, projectId: projId, name: "Companion", startupPrompt: "P", position: 0, profileId: null, endpoint: false, ioSchema: null });
    const sessId = randomUUID();
    db.insertSession({ id: sessId, projectId: projId, agentId, engineSessionId: "eng-1", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant" });

    const otherAgentId = randomUUID();
    db.insertAgent({ id: otherAgentId, projectId: projId, name: "Companion 2", startupPrompt: "P2", position: 1, profileId: null, endpoint: false, ioSchema: null });
    const otherSessId = randomUUID();
    db.insertSession({ id: otherSessId, projectId: projId, agentId: otherAgentId, engineSessionId: "eng-2", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant" });

    const workerAgentId = randomUUID();
    db.insertAgent({ id: workerAgentId, projectId: projId, name: "Worker", startupPrompt: "W", position: 2, profileId: null, endpoint: false, ioSchema: null });
    const workerSessId = randomUUID();
    db.insertSession({ id: workerSessId, projectId: projId, agentId: workerAgentId, engineSessionId: "eng-3", title: null, cwd: projId, processState: "live", resumability: "resumable", busy: false, createdAt: now, lastActivity: now, lastError: null, role: "worker" });

    db.upsertCompanionVoicePref({ sessionId: sessId, channel: "telegram", chatId: "chat-1", senderId: null, sttLang: "en", ttsLang: "en" });
    db.upsertCompanionVoicePref({ sessionId: otherSessId, channel: "telegram", chatId: "chat-2", senderId: null, sttLang: "de", ttsLang: "de" });

    try {
      const res = await app.inject({ method: "GET", url: `/api/companion/voice-prefs/${sessId}` });
      const body = JSON.parse(res.payload);
      check("voice-prefs GET: 200", res.statusCode === 200);
      check("voice-prefs GET: includes the seeded row", body.prefs.some((p) => p.chatId === "chat-1" && p.sttLang === "en" && p.voiceReplies === false));
      check("voice-prefs GET: does NOT include the other session's row (isolation)", !body.prefs.some((p) => p.chatId === "chat-2"));

      const notFound = await app.inject({ method: "GET", url: `/api/companion/voice-prefs/${randomUUID()}` });
      check("voice-prefs GET: unknown sessionId → 404", notFound.statusCode === 404);
      const wrongRole = await app.inject({ method: "GET", url: `/api/companion/voice-prefs/${workerSessId}` });
      check("voice-prefs GET: a non-assistant (worker) session → 400", wrongRole.statusCode === 400);
    } finally {
      await app.close();
      db.close();
    }
  }

  // ============ Part 7 — Telegram setMyCommands registration on start() ============
  {
    function makeFakeBot({ withCommands = true } = {}) {
      const sends = [];
      const commandCalls = [];
      let messageHandler = null, errorHandler = null, running = false;
      const api = { async sendMessage(chatId, text) { sends.push({ chatId, text }); } };
      if (withCommands) api.setMyCommands = async (commands) => { commandCalls.push(commands); };
      return {
        sends, commandCalls,
        bot: {
          api,
          on(_f, h) { messageHandler = h; },
          catch(h) { errorHandler = h; },
          async start(opts) { running = true; opts?.onStart?.({ username: "loombot" }); await new Promise(() => {}); },
          async stop() { running = false; },
          isRunning() { return running; },
        },
      };
    }
    {
      const fake = makeFakeBot();
      const adapter = createTelegramAdapter("tok", () => {}, { bot: fake.bot, sleep: async () => {} });
      adapter.start();
      await tick();
      check("telegram start(): registers the '/' command menu", fake.commandCalls.length === 1);
      check("telegram start(): menu includes /lang and /voice", fake.commandCalls[0]?.some((c) => c.command === "lang") && fake.commandCalls[0]?.some((c) => c.command === "voice"));
      check("telegram start(): the registered menu IS the shared COMMAND_MENU (menu/handlers never drift)", JSON.stringify(fake.commandCalls[0]) === JSON.stringify(COMMAND_MENU));
      await adapter.stop();
    }
    {
      // A bot without setMyCommands (the existing companion-telegram.mjs fake shape) must not throw.
      const fake = makeFakeBot({ withCommands: false });
      let threw = false;
      try {
        const adapter = createTelegramAdapter("tok", () => {}, { bot: fake.bot, sleep: async () => {} });
        adapter.start();
        await tick();
        await adapter.stop();
      } catch { threw = true; }
      check("a bot with no setMyCommands (legacy fake shape) does not throw (guarded with ?.)", threw === false);
    }
  }
} finally {
  for (let i = 0; i < 5; i++) { try { fs.rmSync(tmpHome, { recursive: true, force: true }); break; } catch { /* WAL handle retry */ } }
}

console.log(failures === 0
  ? "\n✅ ALL PASS — VOICE-P1: the '/' command router intercepts /lang//voice pre-submit (never a turn), gated identically to text (unbound/unauthorized never write a pref, group routes key per-sender), an unrecognized command and all plain text stay byte-identical, the db-backed store partial-upserts correctly, the human-only REST read is session-isolated, and Telegram's setMyCommands is registered — claude-free."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
