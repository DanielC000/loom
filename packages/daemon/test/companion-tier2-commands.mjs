import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — Tier-2 slash commands (card 9db7d09c): "/status" (in-chat state readout), "/start"
// (Telegram's first-contact handshake, intercepted so it never leaks a raw agent turn), "/whoami" (a
// route/identity readout), and "/export" (an in-chat markdown dump of the current conversation). Fully
// hermetic: a REAL Db, a REAL InAppChannel wired like index.ts, and the REAL CompanionController +
// factory-built ChatGateway (createCompanionGateway) — NO network, NO real claude, NO daemon. Proves:
//   1. All four are registered commands (COMMANDS map + COMMAND_MENU).
//   2. "/status" reads voiceReplies + ttsLang straight from the injected CompanionVoicePrefs and formats a
//      compact ack — both the default (unset) pref and an explicitly-set one.
//   3. "/start" returns a fixed friendly ack and needs no CommandDeps.
//   4. End-to-end via CompanionController.handleInAppInbound: every command here is swallowed (never
//      becomes a turn — accepted:false, reason:"command"), delivered live, but — unlike "/new"'s
//      intentional conversation-boundary marker — their ack is transport chrome and is NEVER persisted as
//      history (cross-channel ack-recording asymmetry fix).
//   5. An unrecognized "/word" is still NOT swallowed (falls through to the normal pipeline byte-identical).
//   6. "/voice on|auto" in a GROUP refuses ("not available in group chats yet") WITHOUT persisting a pref
//      the outbound path (always senderId:null) can never honor — "off" and a DM's "on" still persist,
//      unchanged (CR#2 N3).
//   7. "/whoami" reads ONLY the route (channel/chatId/senderId) already threaded through every handler —
//      no new CommandDeps — and reports a DM's null sender differently from a group's authenticated one.
//   8. "/export" formats `deps.exportConversation`'s messages into a chronological, speaker-labeled dump
//      (empty ⇒ a friendly "nothing to export" ack, not an error); end-to-end it dumps exactly the
//      session's CURRENT conversation and is never itself recorded as a history row (which would corrupt
//      the next export).
//   9. "/new", "/reset", "/lock" and "/refresh" (card 5307c09f) all refuse on a GROUP route — mirroring
//      "/export"'s own card-5f9b0580 refusal — since resetConversation/closeTrustWindow/refreshPersona are
//      session-wide primitives with no channel dimension to scope a group-only variant against; a DM route
//      is unaffected by every refusal, each proven with its own independent call counter.
//  10. COMMAND_MENU + "/help" flag all five DM-only commands ("/export" too) as "(DM only)" so a group
//      member sees the restriction before even trying the command.
//  11. Round 2 MAJOR fix: "/new"/"/reset" set `CommandResult.boundary` on their SUCCESS branch ONLY — the
//      gateway reads THIS, never the parsed command name, to decide whether to record the ack as the
//      conversation-boundary marker. Proven through a REAL ChatGateway.handleInbound call on a GROUP
//      binding with a real db-backed recorder: a group "/new"/"/reset" refusal records ZERO history rows
//      and triggers ZERO live pushes, while the DM success path still records + pushes exactly one.
// Run: 1) build (turbo builds shared first), 2) node test/companion-tier2-commands.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { cleanupPathSync } from "./_tmp-fixture.mjs";

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
const { commandHandler, registeredCommandNames, registeredDmOnlyCommandNames, COMMAND_MENU, GROUP_COMMAND_MENU } = await import("../dist/companion/commands.js");
const { ChatGateway } = await import("../dist/companion/chat-gateway.js");
const { createDbCompanionAuth } = await import("../dist/companion/auth.js");
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

  // ============ 7 — '/whoami' and '/export' are registered (Tier-2, second slice) ============
  {
    const names = registeredCommandNames();
    const menuNames = COMMAND_MENU.map((c) => c.command);
    check("registeredCommandNames includes 'whoami' and 'export'", names.includes("whoami") && names.includes("export"));
    check("COMMAND_MENU advertises both 'whoami' and 'export'", menuNames.includes("whoami") && menuNames.includes("export"));
  }

  // ============ 8 — '/whoami' reads ONLY the route (channel/chat/sender) — no CommandDeps needed ============
  {
    const dmRoute = { sessionId: "s", channel: "in-app", chatId: "chat-1", senderId: null };
    const dmResult = commandHandler("whoami")(undefined, dmRoute, inMemoryVoicePrefs(), {});
    check("/whoami (DM): reports the channel", dmResult.ack.includes("in-app"));
    check("/whoami (DM): reports the chat id", dmResult.ack.includes("chat-1"));
    check("/whoami (DM): omits a Sender line (a DM's senderId is always null)", !dmResult.ack.includes("Sender:"));

    const groupRoute = { sessionId: "s", channel: "telegram", chatId: "chat-2", senderId: "user-42" };
    const groupResult = commandHandler("whoami")(undefined, groupRoute, inMemoryVoicePrefs(), {});
    check("/whoami (group): reports the channel", groupResult.ack.includes("telegram"));
    check("/whoami (group): reports the authenticated sender id", groupResult.ack.includes("user-42"));
  }

  // ============ 9 — '/export' formats deps.exportConversation's messages; an empty conversation is a friendly ack ============
  {
    const route = { sessionId: "s", channel: "in-app", chatId: "s", senderId: null };

    const emptyResult = commandHandler("export")(undefined, route, inMemoryVoicePrefs(), { exportConversation: () => [] });
    check("/export (empty conversation): a friendly 'nothing to export' ack, not an error", /nothing to export/i.test(emptyResult.ack));

    const messages = [
      { id: "1", sessionId: "s", channel: "in-app", chatId: "s", author: "user", text: "hello there", createdAt: "2026-07-08T00:00:00.000Z", viaVoice: false },
      { id: "2", sessionId: "s", channel: "in-app", chatId: "s", author: "companion", text: "hi! how can I help?", createdAt: "2026-07-08T00:00:01.000Z", viaVoice: false },
    ];
    const result = commandHandler("export")(undefined, route, inMemoryVoicePrefs(), { exportConversation: () => messages });
    check("/export: reports the message count", result.ack.includes("2 messages"));
    check("/export: includes the user's message text verbatim", result.ack.includes("hello there"));
    check("/export: includes the companion's reply text verbatim", result.ack.includes("hi! how can I help?"));
    check("/export: labels each speaker (You / Companion)", result.ack.includes("You") && result.ack.includes("Companion"));
    check("/export: messages appear in chronological order (user's turn before the reply)", result.ack.indexOf("hello there") < result.ack.indexOf("hi! how can I help?"));

    const singular = commandHandler("export")(undefined, route, inMemoryVoicePrefs(), { exportConversation: () => [messages[0]] });
    check("/export: singular count reads '1 message' (no trailing s)", singular.ack.includes("1 message)"));
  }

  // ============ 9b — '/export' refuses on a GROUP route (card 5f9b0580): never leaks the cross-channel
  //                   conversation to an authenticated-but-non-owner group member ============
  {
    const groupRoute = { sessionId: "s", channel: "telegram", chatId: "chat-9", senderId: "user-1" }; // group: senderId set
    let calls = 0;
    const spyDeps = {
      exportConversation: () => {
        calls++;
        return [{ id: "1", sessionId: "s", channel: "telegram", chatId: "chat-9", author: "user", text: "leaked secret", createdAt: "2026-07-08T00:00:00.000Z", viaVoice: false }];
      },
    };

    const groupResult = commandHandler("export")(undefined, groupRoute, inMemoryVoicePrefs(), spyDeps);
    check("/export (group): the exporter is never called", calls === 0);
    check("/export (group): refuses with the exact approved DM-only ack (no DM-retry invitation — a non-owner's own DM isn't authorized either)", groupResult.ack === "📤 /export only works in a private chat with me — it isn't available in group chats.");
    check("/export (group): the refusal never contains the (unread) conversation text", !groupResult.ack.includes("leaked secret"));

    // DM route is a REGRESSION GUARD: completely unaffected by the group check — still calls the
    // exporter and dumps the real conversation, exactly as before this fix.
    const dmRoute = { sessionId: "s", channel: "in-app", chatId: "s", senderId: null };
    const dmResult = commandHandler("export")(undefined, dmRoute, inMemoryVoicePrefs(), spyDeps);
    check("/export (DM): unaffected by the group-scope fix — exporter called and the real dump is returned", calls === 1 && dmResult.ack.includes("leaked secret"));
  }

  // ============ 9c — '/new'/'/reset' refuse on a GROUP route (card 5307c09f): any allowlisted group
  //                   member could otherwise wipe the owner's entire cross-channel companion memory as a
  //                   griefing/DoS vector — resetConversation/closeTrustWindow are both session-wide with
  //                   no channel dimension to scope a "reset just this group" variant against ============
  {
    const groupRoute = { sessionId: "s", channel: "telegram", chatId: "chat-10", senderId: "user-1" }; // group: senderId set
    // A FRESH, group-call-only counter — independent of the DM regression check's own counter below (round
    // 2 NIT), so neither check's pass/fail can ever be masked by the other's call count.
    let groupResetCalls = 0;
    const groupSpyDeps = { resetConversation: async () => { groupResetCalls++; } };

    const newGroupResult = await commandHandler("new")(undefined, groupRoute, inMemoryVoicePrefs(), groupSpyDeps);
    check("/new (group): resetConversation is never called", groupResetCalls === 0);
    check(
      "/new (group): refuses with the shared group-route refusal wording (no DM-retry invitation)",
      newGroupResult.ack === "🆕 Starting a fresh conversation only works in a private chat with me — it isn't available in group chats.",
    );
    check("/new (group): the refusal carries NO boundary flag (round 2 — would otherwise record a fake boundary row)", !newGroupResult.boundary);

    const resetGroupResult = await commandHandler("reset")(undefined, groupRoute, inMemoryVoicePrefs(), groupSpyDeps);
    check("/reset (group): resetConversation is never called (same handler object as /new)", groupResetCalls === 0);
    check("/reset (group): refuses with the SAME wording as /new (the shared handler can't tell the aliases apart, by design)", resetGroupResult.ack === newGroupResult.ack);
    check("/reset (group): the refusal carries NO boundary flag either", !resetGroupResult.boundary);

    // DM route is a REGRESSION GUARD: completely unaffected by the group check — still calls
    // resetConversation and returns the real ack. Its OWN independent counter (round 2 NIT).
    let dmResetCalls = 0;
    const dmSpyDeps = { resetConversation: async () => { dmResetCalls++; } };
    const dmRoute = { sessionId: "s", channel: "in-app", chatId: "s", senderId: null };
    const dmResult = await commandHandler("new")(undefined, dmRoute, inMemoryVoicePrefs(), dmSpyDeps);
    check("/new (DM): unaffected by the group-scope fix — resetConversation called and the real ack returned", dmResetCalls === 1 && dmResult.ack === "🆕 Started a fresh conversation.");
    check("/new (DM): the SUCCESS result sets boundary:true (round 2 — the ONLY signal the gateway now reads)", dmResult.boundary === true);
  }

  // ============ 9d — '/lock' refuses on a GROUP route (card 5307c09f): closeCompanionTrustWindow revokes
  //                   EVERY route/sender's trust window + any live grant, session-wide — no channel
  //                   dimension to scope a "lock just this group" variant against ============
  {
    const groupRoute = { sessionId: "s", channel: "telegram", chatId: "chat-11", senderId: "user-1" };
    // Independent of the DM regression check's own counter below (round 2 NIT — same reasoning as 9c).
    let groupCloseCalls = 0;
    const groupSpyDeps = { closeTrustWindow: () => { groupCloseCalls++; } };

    const groupResult = commandHandler("lock")(undefined, groupRoute, inMemoryVoicePrefs(), groupSpyDeps);
    check("/lock (group): closeTrustWindow is never called", groupCloseCalls === 0);
    check(
      "/lock (group): refuses with the shared group-route refusal wording (no DM-retry invitation)",
      groupResult.ack === "🔒 /lock only works in a private chat with me — it isn't available in group chats.",
    );

    // DM route is a REGRESSION GUARD: completely unaffected by the group check — still calls
    // closeTrustWindow and returns the real "Locked" ack. Its OWN independent counter (round 2 NIT).
    let dmCloseCalls = 0;
    const dmSpyDeps = { closeTrustWindow: () => { dmCloseCalls++; } };
    const dmRoute = { sessionId: "s", channel: "in-app", chatId: "s", senderId: null };
    const dmResult = commandHandler("lock")(undefined, dmRoute, inMemoryVoicePrefs(), dmSpyDeps);
    check("/lock (DM): unaffected by the group-scope fix — closeTrustWindow called and the real ack returned", dmCloseCalls === 1 && dmResult.ack === "🔒 Locked — I'll need your confirmation again before I take any action.");
  }

  // ============ 9e — '/refresh' refuses on a GROUP route too (card 5307c09f round 2, lead ruling): same
  //                   idiom — a group member could otherwise burn the owner's companion turns on demand ============
  {
    const groupRoute = { sessionId: "s", channel: "telegram", chatId: "chat-12", senderId: "user-1" };
    let groupRefreshCalls = 0;
    const groupSpyDeps = { refreshPersona: () => { groupRefreshCalls++; return true; } };

    const groupResult = commandHandler("refresh")(undefined, groupRoute, inMemoryVoicePrefs(), groupSpyDeps);
    check("/refresh (group): refreshPersona is never called", groupRefreshCalls === 0);
    check(
      "/refresh (group): refuses with the shared group-route refusal wording (no DM-retry invitation)",
      groupResult.ack === "🔄 /refresh only works in a private chat with me — it isn't available in group chats.",
    );

    // DM route is a REGRESSION GUARD: completely unaffected by the group check — still calls
    // refreshPersona and returns the real ack. Its OWN independent counter.
    let dmRefreshCalls = 0;
    const dmSpyDeps = { refreshPersona: () => { dmRefreshCalls++; return true; } };
    const dmRoute = { sessionId: "s", channel: "in-app", chatId: "s", senderId: null };
    const dmResult = commandHandler("refresh")(undefined, dmRoute, inMemoryVoicePrefs(), dmSpyDeps);
    check("/refresh (DM): unaffected by the group-scope fix — refreshPersona called and the real ack returned", dmRefreshCalls === 1 && dmResult.ack === "🔄 Reloaded my instructions and memory — our conversation continues.");
  }

  // ============ 9f — '/help' and the Telegram COMMAND_MENU flag EVERY DM-only command (card 5307c09f
  //                   round 2 Minor 3): a group member sees the restriction before even trying it ============
  {
    const dmOnlyNames = registeredDmOnlyCommandNames();
    check("dmOnly set: exactly new/reset/lock/export/refresh (sanity on the flag, not a hand-maintained list)",
      new Set(dmOnlyNames).size === 5 && ["new", "reset", "lock", "export", "refresh"].every((n) => dmOnlyNames.includes(n)));
    const helpAck = commandHandler("help")(undefined, {}, {}).ack;
    for (const name of dmOnlyNames) {
      const entry = COMMAND_MENU.find((c) => c.command === name);
      check(`COMMAND_MENU: '/${name}' description flags it as DM only`, !!entry && /DM only/i.test(entry.description));
      // Independent of COMMAND_MENU's own description text — a dedicated per-LINE check (anchored with "m")
      // so this can't pass merely because /help and COMMAND_MENU derive from the same (possibly-wrong)
      // source; it would fail if /help's rendering ever dropped the "(DM only)" suffix on its own.
      check(`/help: '/${name}' line is marked (DM only)`, new RegExp(`^/${name} .*\\(DM only\\)$`, "m").test(helpAck));
    }
  }

  // ============ 9f' — GROUP_COMMAND_MENU (card d100843f) omits exactly the dmOnly set and nothing else;
  //                    the dmOnly FLAG itself matches each handler's REAL group-route refusal, so the
  //                    advertised menu and the actual refusal behavior can't drift apart (same bug class
  //                    5307c09f fixed for the single global menu — this is its two-scoped-menu successor) ===
  {
    const dmOnlyNames = registeredDmOnlyCommandNames();
    const allNames = registeredCommandNames();
    const groupMenuNames = GROUP_COMMAND_MENU.map((c) => c.command);
    check("GROUP_COMMAND_MENU: omits every dmOnly command", dmOnlyNames.every((n) => !groupMenuNames.includes(n)));
    check("GROUP_COMMAND_MENU: includes every non-dmOnly command", allNames.filter((n) => !dmOnlyNames.includes(n)).every((n) => groupMenuNames.includes(n)));
    check("GROUP_COMMAND_MENU: size === total minus dmOnly (no extra omissions, no extra inclusions)", groupMenuNames.length === allNames.length - dmOnlyNames.length);

    // The parity check itself: for every command except "/voice" (a documented, deliberate exception —
    // its group restriction is CONDITIONAL on args, not a blanket refusal, so it never carries `dmOnly`),
    // drive the REAL handler on a group route and confirm whether it produces the shared group-route
    // refusal — then assert THAT boolean matches the dmOnly flag. Deps are spies that throw if ever
    // reached, so a false "refuses" never passes merely because a deps call happened to also throw.
    const GROUP_REFUSAL_RE = /only works in a private chat with me — it isn't available in group chats\./;
    const groupRoute = { sessionId: "s", channel: "in-app", chatId: "g", senderId: "member-1" };
    const unreachableDeps = {
      resetConversation: async () => { throw new Error("resetConversation must not be reached on a group refusal"); },
      exportConversation: () => { throw new Error("exportConversation must not be reached on a group refusal"); },
      refreshPersona: () => { throw new Error("refreshPersona must not be reached on a group refusal"); },
      closeTrustWindow: () => { throw new Error("closeTrustWindow must not be reached on a group refusal"); },
    };
    for (const name of allNames.filter((n) => n !== "voice")) {
      // Code Review 3fb91c99 nit: a deps-spy throw (a dmOnly-parity mismatch that lets a handler reach an
      // "unreachable" dep) must record exactly one FAIL naming the offending command, never abort the
      // whole loop — an uncaught throw here would silently skip every check for every command after it.
      try {
        const result = await commandHandler(name)(undefined, groupRoute, inMemoryVoicePrefs(), unreachableDeps);
        const refuses = GROUP_REFUSAL_RE.test(result.ack);
        check(`dmOnly parity: '/${name}' handler's real group-route refusal (${refuses}) matches its dmOnly flag (${dmOnlyNames.includes(name)})`,
          refuses === dmOnlyNames.includes(name));
      } catch (err) {
        check(`dmOnly parity: '/${name}' handler threw instead of returning an ack (${err?.message ?? err})`, false);
      }
    }
  }

  // ============ 9g — handleInbound on a GROUP binding, REAL db-backed recorder (card 5307c09f round 2
  //                   MAJOR): a group "/new"/"/reset" refusal must NEVER be recorded as the conversation-
  //                   boundary marker — that would let a non-owner group member spam fake boundary rows
  //                   into the owner's history and push them live to an attached viewer, the SAME griefing
  //                   class the refusal itself exists to stop. The gateway must read `result.boundary` from
  //                   the handler, never infer it from the parsed command name. ============
  {
    const groupSessionId = randomUUID();
    db.insertSession({
      id: groupSessionId, projectId: projId, agentId, engineSessionId: `eng-${groupSessionId}`, title: null, cwd: projId,
      processState: "live", resumability: "resumable", busy: false, createdAt: now0, lastActivity: now0, lastError: null, role: "assistant",
    });
    const groupChatId = "grp-9g";
    db.addAllowedSender({ sessionId: groupSessionId, channel: "telegram", senderId: "member-1" });

    let pushCalls = 0;
    const realRecorder = {
      // The SAME shape (and the SAME db.insertCompanionMessage call) as the production recorder in
      // companion/factory.ts — a real db-backed recorder, not a spy/mock, per round 2's explicit DoD.
      record(sid, channel, chatId, author, text, viaVoice, id, proactive) {
        if (channel === IN_APP_CHANNEL) return;
        db.insertCompanionMessage({ id: id ?? randomUUID(), sessionId: sid, channel, chatId, author, text, createdAt: new Date().toISOString(), viaVoice, proactive });
      },
    };
    const livePush = { push() { pushCalls++; } };
    const sent = [];
    const fakeTelegramAdapter = {
      name: "telegram",
      maxMessageLength: undefined,
      start() {},
      async stop() {},
      async send(chatId, text) { sent.push({ chatId, text }); },
    };

    const gw = new ChatGateway(
      () => ({ delivered: false }), // submitTurn — never reached: every command here is intercepted pre-submit
      [{ sessionId: groupSessionId, channel: "telegram", chatId: groupChatId, scope: "group" }],
      createDbCompanionAuth(db),
      undefined, undefined, undefined, undefined, undefined, undefined,
      realRecorder,
      undefined,
      livePush,
      undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      undefined, undefined, undefined, undefined, undefined,
      groupSessionId,
    );
    gw.registerAdapter(fakeTelegramAdapter);

    const r1 = await gw.handleInbound({ channel: "telegram", chatId: groupChatId, sender: { id: "member-1" }, body: "/new", chatIsDirect: false });
    check("/new (group, via handleInbound): never becomes a turn", r1.accepted === false && r1.reason === "command" && r1.command === "new");
    check("/new (group, via handleInbound): acked with the refusal, not the success ack", sent.length === 1 && sent[0].text.includes("only works in a private chat"));
    check("/new (group, via handleInbound): ZERO history rows recorded (no fake boundary row)", db.listAllCompanionMessages(groupSessionId).length === 0);
    check("/new (group, via handleInbound): ZERO live pushes", pushCalls === 0);

    const r2 = await gw.handleInbound({ channel: "telegram", chatId: groupChatId, sender: { id: "member-1" }, body: "/reset", chatIsDirect: false });
    check("/reset (group, via handleInbound): never becomes a turn either", r2.accepted === false && r2.reason === "command" && r2.command === "reset");
    check("/reset (group, via handleInbound): ZERO history rows recorded either", db.listAllCompanionMessages(groupSessionId).length === 0);
    check("/reset (group, via handleInbound): ZERO live pushes either", pushCalls === 0);

    // DM success path is a REGRESSION GUARD: re-bind the SAME session to a DM route — the real boundary
    // marker must still be recorded + pushed, completely unaffected by this fix.
    gw.unbind(groupSessionId, "telegram");
    gw.bind({ sessionId: groupSessionId, channel: "telegram", chatId: "dm-9g", scope: "dm" });
    const r3 = await gw.handleInbound({ channel: "telegram", chatId: "dm-9g", body: "/new", chatIsDirect: true });
    check("/new (DM, via handleInbound): never becomes a turn", r3.accepted === false && r3.reason === "command" && r3.command === "new");
    check("/new (DM, via handleInbound): acked with the real success ack", sent.some((s) => s.text === "🆕 Started a fresh conversation."));
    // EXACT count, not .some() — a double-write would pass a .some() check; this matches the decision
    // record's own "exactly one" claim for the DM regression leg.
    check(
      "/new (DM, via handleInbound): the boundary marker IS recorded EXACTLY ONCE this time",
      db.listAllCompanionMessages(groupSessionId).filter((m) => m.text === "🆕 Started a fresh conversation.").length === 1,
    );
    check("/new (DM, via handleInbound): the boundary marker IS pushed live", pushCalls === 1);
  }

  // ============ 10 — end-to-end via CompanionController.handleInAppInbound: '/export'/'/whoami' swallowed ============
  {
    // Seed a real exchange into the session's CURRENT conversation so "/export" has something to dump.
    db.insertCompanionMessage({ id: randomUUID(), sessionId, channel: IN_APP_CHANNEL, chatId: sessionId, author: "user", text: "export-test message one", createdAt: new Date().toISOString() });
    db.insertCompanionMessage({ id: randomUUID(), sessionId, channel: IN_APP_CHANNEL, chatId: sessionId, author: "companion", text: "export-test reply one", createdAt: new Date().toISOString() });

    const { controller, frames, submitted } = makeController(sessionId);
    await controller.reconcile();

    const r = await controller.handleInAppInbound(sessionId, "/export");
    check("/export: never becomes a turn (a command result, not accepted)", r.accepted === false && r.reason === "command" && r.command === "export");
    check("/export: acked", r.acked === true);
    check("/export: no turn ever submitted", submitted.length === 0);
    check("/export: the delivered ack contains the seeded conversation's messages", frames.some((f) => f.type === "chat" && f.text.includes("export-test message one") && f.text.includes("export-test reply one")));

    const after = db.listCompanionMessages(sessionId, IN_APP_CHANNEL);
    check("/export: the ack is transport chrome — NOT recorded as a companion history row (would corrupt a later export)", !after.some((m) => m.text.includes("Conversation export")));
  }

  {
    const { controller, frames, submitted } = makeController(sessionId);
    await controller.reconcile();

    const r = await controller.handleInAppInbound(sessionId, "/whoami");
    check("/whoami: never becomes a turn (a command result, not accepted)", r.accepted === false && r.reason === "command" && r.command === "whoami");
    check("/whoami: acked", r.acked === true);
    check("/whoami: no turn ever submitted", submitted.length === 0);
    check("/whoami: the delivered ack reports the in-app channel and this chat's id", frames.some((f) => f.type === "chat" && f.text.includes(IN_APP_CHANNEL) && f.text.includes(sessionId)));

    const after = db.listCompanionMessages(sessionId, IN_APP_CHANNEL);
    check("/whoami: the ack is transport chrome — NOT recorded as a companion history row", !after.some((m) => m.text.includes("Channel:")));
  }
} finally {
  try { db.close(); } catch { /* ignore */ }
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — '/status' reads voice-replies + language from the injected CompanionVoicePrefs, '/start' acks a fixed greeting with no deps, '/whoami' reads only the route, '/export' dumps the current conversation via deps.exportConversation, all four are swallowed end-to-end (never a turn) and their acks are never persisted as history, an unrecognized '/word' still falls through unchanged, and '/voice on|auto' in a group refuses WITHOUT persisting a dead pref."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
