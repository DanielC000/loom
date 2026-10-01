import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — OUTBOUND SUPPRESSION to a dm-scope binding flagged as non-private (card 7578dea2,
// closing the OUTBOUND half of card b4f124d8's finding — READ closed by b4f124d8 itself; db49891d closed
// the WRITE side). b4f124d8 refused to AUTHORIZE an inbound on a dm binding the channel does not confirm
// as private, but every OUTBOUND producer still pushed to such a route regardless — every member of a
// group chat mistakenly/legacy-bound as "dm" would see the owner's words and the agent's replies.
//
// Fully hermetic: a REAL Db (proves persistence) + REAL ChatGateway/createCompanionGateway/
// CompanionController wiring (the SAME production wiring path factory.ts/index.ts use) driven with FAKE
// channel adapters — NO live network, NO real claude, NO daemon.
//
// Covers the card's DoD:
//   1. Once `warnUnconfirmedDirectInbound` observes a dm binding as non-private, EVERY outbound producer
//      named on the card is suppressed: chat_reply (a), heartbeat/reminder/attention-push (b — the SAME
//      deliverReply call path, proven with proactiveResolver:true), deliverMedia (c), and the
//      in-app→other-channel mirror / sendToChannel (Part 2).
//   2. NEGATIVE CONTROL: an ORDINARY (unflagged) dm binding is UNAFFECTED — suppression is targeted, not a
//      global outbound break.
//   3. PERSISTENCE: the flag survives in the db (`CompanionBinding.flaggedNonPrivate`) and a FRESH
//      ChatGateway built from a db read (no new inbound needed) still suppresses — the restart-survival
//      requirement.
//   4. REMEDY: re-binding the SAME route (`upsertCompanionBinding`) clears the flag and restores delivery.
// Run: 1) build (turbo builds shared first), 2) node test/companion-outbound-suppression.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// --- Hermetic LOOM_HOME + sandboxed HOME. Set BEFORE importing dist (paths.ts reads LOOM_HOME at import). ---
const tmpHome = path.join(os.tmpdir(), `loom-companion-outbound-suppression-${Date.now()}-${process.pid}`);
fs.mkdirSync(path.join(tmpHome, "logs"), { recursive: true });
process.env.LOOM_HOME = tmpHome;
const sandboxHome = path.join(tmpHome, "home");
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.USERPROFILE = sandboxHome; // Windows: os.homedir() reads USERPROFILE
process.env.HOME = sandboxHome;        // POSIX: os.homedir() reads HOME

const { requireHermeticEnv } = await import("./_guard.mjs");
const { cleanupPathSync } = await import("./_tmp-fixture.mjs");
const { pollUntil } = await import("./_timing-guard.mjs");
requireHermeticEnv();

const { Db } = await import("../dist/db.js");
const { ChatGateway } = await import("../dist/companion/chat-gateway.js");
const { createDbCompanionAuth } = await import("../dist/companion/auth.js");
const { createCompanionGateway } = await import("../dist/companion/factory.js");
const { CompanionController } = await import("../dist/companion/controller.js");
const { IN_APP_CHANNEL } = await import("../dist/companion/in-app.js");
const { TELEGRAM_CHANNEL } = await import("../dist/companion/telegram.js");
const { inMemoryVoicePrefs } = await import("../dist/companion/voice-prefs.js");

const dbFile = path.join(tmpHome, "loom.db");
const db = new Db(dbFile);

// A conformant fake ChannelAdapter recording sends (no network).
function fakeAdapter(name) {
  const sent = [];
  return { name, maxMessageLength: name === TELEGRAM_CHANNEL ? 4096 : undefined, start() {}, async stop() {}, async send(chatId, text) { sent.push({ chatId, text }); }, async sendMedia(chatId, filePath) { sent.push({ chatId, filePath }); }, sent };
}

// createCompanionGateway wires a REAL db-backed chat-history recorder, whose insertCompanionMessage has a
// sessions(id) FK — a bare string session id with no real row makes that recorder fail (contained/logged,
// never breaking delivery, but noisy). Seed a minimal real project/agent/session per id used with the real
// factory below (mirrors companion-proactive-tagging.mjs's makeCompanionSession).
const now0 = new Date().toISOString();
function seedSession(id) {
  const projectId = randomUUID();
  db.insertProject({ id: projectId, name: id, repoPath: projectId, vaultPath: projectId, config: {}, createdAt: now0, archivedAt: null });
  const agentId = randomUUID();
  db.insertAgent({ id: agentId, projectId, name: "Companion", startupPrompt: "", position: 0 });
  db.insertSession({
    id, projectId, agentId, engineSessionId: `eng-${id}`, title: null, cwd: projectId,
    processState: "live", resumability: "resumable", busy: false,
    createdAt: now0, lastActivity: now0, lastError: null, role: "assistant", taskId: null,
  });
}

try {
  // ============ Part 1 — deliverReply (chat_reply + heartbeat/reminder/attention-push) + deliverMedia ======
  {
    const sess = "sess-flagged";
    const other = "sess-ordinary"; // negative control: a SEPARATE, never-flagged dm binding.
    seedSession(sess);
    seedSession(other);
    db.upsertCompanionBinding({ sessionId: sess, channel: TELEGRAM_CHANNEL, chatId: "100100111", scope: "dm" });
    db.upsertCompanionBinding({ sessionId: other, channel: TELEGRAM_CHANNEL, chatId: "300300300", scope: "dm" });

    const submitted = [];
    const submit = (sid, text) => { submitted.push({ sid, text }); return { delivered: true }; };
    const bindings = db.listCompanionBindings().map((b) => ({ sessionId: b.sessionId, channel: b.channel, chatId: b.chatId, scope: b.scope, flaggedNonPrivate: b.flaggedNonPrivate }));
    const gw = new ChatGateway(
      submit, bindings, createDbCompanionAuth(db), undefined,
      (sid) => (sid === sess ? { channel: TELEGRAM_CHANNEL, chatId: "100100111" } : sid === other ? { channel: TELEGRAM_CHANNEL, chatId: "300300300" } : null), // originResolver
      undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
      (sid) => sid === sess, // proactiveResolver: sess's in-flight turn IS heartbeat/reminder/attention-push-originated
      undefined, undefined,
      (b) => db.flagCompanionBindingNonPrivate(b.sessionId, b.channel), // flagNonPrivateBinding (factory.ts's real wiring)
    );
    const tg = fakeAdapter(TELEGRAM_CHANNEL);
    gw.registerAdapter(tg);

    // Negative control FIRST (proves the instrument can pass before we make it fail): the ORDINARY binding
    // delivers fine, before either binding has been touched.
    const preA = await gw.deliverReply(other, "hi from the real owner");
    check("(control) an ordinary, never-flagged dm binding delivers normally", preA.delivered === true && tg.sent.length === 1 && tg.sent[0].chatId === "300300300");

    // Trigger the SAME real security detector b4f124d8 shipped: an inbound the channel does NOT confirm as
    // private, on the `sess` dm binding — auth.ts refuses it AND warnUnconfirmedDirectInbound flags it.
    const rejected = await gw.handleInbound({ channel: TELEGRAM_CHANNEL, chatId: "100100111", body: "not really a dm", sender: { id: "member" }, chatIsDirect: false });
    check("trigger: the unconfirmed-direct inbound is itself refused (b4f124d8, unchanged)", rejected.accepted === false && rejected.reason === "sender-not-authorized");
    check("trigger: it was never submitted as a turn", submitted.length === 0);

    // (a) chat_reply (an ordinary, non-proactive deliverReply) is now suppressed.
    const rA = await gw.deliverReply(sess, "hello group, this should never arrive");
    check("(a) chat_reply to the flagged route is suppressed", rA.delivered === false && rA.reason === "route-flagged-non-private");
    check("(a) NOTHING was sent to the flagged chat", tg.sent.length === 1); // still just the control's earlier send

    // (b) heartbeat/reminder/attention-push — the SAME deliverReply call, but proactiveResolver(sess)===true,
    // proving there is no separate producer code path that could have been missed.
    const rB = await gw.deliverReply(sess, "your heartbeat check-in — should never arrive either");
    check("(b) a PROACTIVE (heartbeat/reminder/attention-push) reply to the flagged route is ALSO suppressed", rB.delivered === false && rB.reason === "route-flagged-non-private");
    check("(b) still nothing sent to the flagged chat", tg.sent.length === 1);

    // (c) deliverMedia (media-out lever) is suppressed too.
    const rC = await gw.deliverMedia(sess, path.join(tmpHome, "would-be-a-real-file.png"));
    check("(c) deliverMedia to the flagged route is suppressed", rC.delivered === false && rC.reason === "route-flagged-non-private");
    check("(c) still nothing sent to the flagged chat", tg.sent.length === 1);

    // The negative control is UNAFFECTED by flagging the other session's route — suppression is targeted.
    const postA = await gw.deliverReply(other, "still fine, right?");
    check("(control) the ordinary binding still delivers AFTER the other route got flagged", postA.delivered === true && tg.sent.length === 2 && tg.sent[1].chatId === "300300300");

    // PERSISTENCE (card 7578dea2's own "persist it if needed so it survives a restart"): the flag reached
    // the db row, not just the in-memory routing map.
    const persisted = db.listCompanionBindings().find((b) => b.sessionId === sess && b.channel === TELEGRAM_CHANNEL);
    check("persistence: the db row is flagged", persisted?.flaggedNonPrivate === true);
    const persistedOther = db.listCompanionBindings().find((b) => b.sessionId === other && b.channel === TELEGRAM_CHANNEL);
    check("persistence: the OTHER (control) binding's row is NOT flagged", persistedOther?.flaggedNonPrivate === false);

    // RESTART SURVIVAL: build BRAND-NEW gateways via createCompanionGateway (the REAL production factory,
    // NOT a hand-built bindings array) — no new inbound, no warnUnconfirmedDirectInbound call this time —
    // and confirm the flagged route STILL suppresses while the control route is unaffected. Using the real
    // factory (which internally reads db.listCompanionBindings() and maps each row through its OWN
    // toSessionBinding) is load-bearing here, not cosmetic: a hand-built bindings array that separately
    // re-lists `flaggedNonPrivate` (as Part 1's FIRST gateway above legitimately does, to test ChatGateway's
    // constructor contract directly) would keep passing even if toSessionBinding itself regressed and
    // silently dropped the field — this section exists specifically to catch THAT regression. One gateway
    // per session, exactly like production (createCompanionGateway loads bindings SCOPED to cfg.sessionId,
    // @decision sha:55f1b628 — one companion's gateway can never hold another's binding).
    const submitted2 = [];
    const submit2 = (sid, text) => { submitted2.push({ sid, text }); return { delivered: true }; };
    const cfgSess = { botToken: "fake-token", allowedChatId: "100100111", sessionId: sess, chatScope: "dm", homeChannel: TELEGRAM_CHANNEL, homeChatId: "100100111", heartbeatIntervalMinutes: 0, heartbeatPrompt: "" };
    const gw2 = createCompanionGateway(cfgSess, submit2, db, undefined, (sid) => (sid === sess ? { channel: TELEGRAM_CHANNEL, chatId: "100100111" } : null));
    const tg2 = fakeAdapter(TELEGRAM_CHANNEL);
    gw2.registerAdapter(tg2); // overwrites createCompanionGateway's own real Telegram adapter registration (same "telegram" key) — no network ever armed, since gw2.start() is never called

    const cfgOther = { botToken: "fake-token", allowedChatId: "300300300", sessionId: other, chatScope: "dm", homeChannel: TELEGRAM_CHANNEL, homeChatId: "300300300", heartbeatIntervalMinutes: 0, heartbeatPrompt: "" };
    const gwOther2 = createCompanionGateway(cfgOther, submit2, db, undefined, (sid) => (sid === other ? { channel: TELEGRAM_CHANNEL, chatId: "300300300" } : null));
    const tgOther2 = fakeAdapter(TELEGRAM_CHANNEL);
    gwOther2.registerAdapter(tgOther2);

    const rRestart = await gw2.deliverReply(sess, "surely THIS restart cleared it?");
    check("restart-survival: a FRESH gateway built via createCompanionGateway (real toSessionBinding path) still suppresses the flagged route", rRestart.delivered === false && rRestart.reason === "route-flagged-non-private" && tg2.sent.length === 0);
    const rRestartOther = await gwOther2.deliverReply(other, "and the control still works post-restart");
    check("restart-survival: the control route (its OWN fresh gateway) is unaffected post-restart too", rRestartOther.delivered === true && tgOther2.sent.length === 1);

    // REMEDY: re-binding the SAME (channel, chatId) route resets the flag (upsertCompanionBinding, card
    // 7578dea2) — the DoD's own stated fix path. Live-sync it into gw2 exactly like the REST bind handler
    // does (gateway/server.ts), then confirm delivery resumes.
    const rebound = db.upsertCompanionBinding({ sessionId: sess, channel: TELEGRAM_CHANNEL, chatId: "100100111", scope: "group" });
    check("remedy: re-binding resets flaggedNonPrivate in the db", rebound.flaggedNonPrivate === false);
    gw2.bind({ sessionId: rebound.sessionId, channel: rebound.channel, chatId: rebound.chatId, scope: rebound.scope, flaggedNonPrivate: rebound.flaggedNonPrivate });
    // Now group-scoped — deliverReply itself doesn't care about scope, only the flag; this just proves the
    // flag-clear (not a scope side-effect) is what restored delivery.
    const rResumed = await gw2.deliverReply(sess, "re-bound as group, delivery resumes");
    check("remedy: delivery resumes after re-binding clears the flag", rResumed.delivered === true && tg2.sent.length === 1);
  }

  // ============ Part 2 — the in-app→other-channel MIRROR (controller.ts mirrorWebInputToOtherChannels) =====
  {
    const sess = "sess-mirror-flagged";
    seedSession(sess);
    db.upsertCompanionBinding({ sessionId: sess, channel: IN_APP_CHANNEL, chatId: sess, scope: "dm" });
    db.upsertCompanionBinding({ sessionId: sess, channel: TELEGRAM_CHANNEL, chatId: "100100222", scope: "dm" });

    const cfg = { botToken: "fake-token", allowedChatId: "100100222", sessionId: sess, chatScope: "dm", homeChannel: TELEGRAM_CHANNEL, homeChatId: "100100222", heartbeatIntervalMinutes: 0, heartbeatPrompt: "" };
    const submit = () => ({ delivered: true });
    const gw = createCompanionGateway(cfg, submit, db, undefined, (sid) => (sid === sess ? { channel: IN_APP_CHANNEL, chatId: sess } : null));
    const tg = fakeAdapter(TELEGRAM_CHANNEL);
    gw.registerAdapter(tg);

    const controller = new CompanionController({
      db: { listEnabledCompanionReminders: () => [] },
      submitTurn: submit,
      pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getPending: () => [] },
      hooks: { companionSessionIds: new Set() },
      env: {},
      buildGateway: () => gw,
    });
    await controller.startInitial([{ ...cfg, homeChannel: TELEGRAM_CHANNEL, homeChatId: "100100222" }]);

    // Negative control FIRST: an unflagged Telegram binding mirrors the web turn normally. The mirror is
    // fire-and-forget from handleInAppInbound's perspective, so DETERMINISTICALLY observe it landing —
    // poll (fail-fast, no guessed fixed wait) rather than sleep-then-look-once.
    const preRes = await controller.handleInAppInbound(sess, "hello from the cockpit");
    const preSettled = await pollUntil(() => tg.sent.length >= 1, { timeoutMs: 500, intervalMs: 10 });
    check("(control) mirror to an unflagged Telegram binding delivers", preRes.accepted === true && preSettled && tg.sent.length === 1 && tg.sent[0].text.endsWith("— via web chat"));

    // Flag the Telegram route via a real unconfirmed-direct inbound on it.
    const rejected = await gw.handleInbound({ channel: TELEGRAM_CHANNEL, chatId: "100100222", body: "not a dm", sender: { id: "x" }, chatIsDirect: false });
    check("trigger: unconfirmed-direct inbound on the telegram route refused", rejected.accepted === false);

    const baseline = tg.sent.length;
    const postRes = await controller.handleInAppInbound(sess, "this should NOT reach the group");
    // The suppression happens SYNCHRONOUSLY inside sendToChannel (mayDeliverTo, before any await) — a real
    // violation would show up within the first poll tick, not after a guessed delay; pollUntil fails FAST
    // on a violation instead of looking only once at the end of a blind sleep.
    const grewAnyway = await pollUntil(() => tg.sent.length > baseline, { timeoutMs: 200, intervalMs: 10 });
    check("mirror: a web turn no longer mirrors to the NOW-flagged Telegram route", postRes.accepted === true && grewAnyway === false && tg.sent.length === baseline);

    const persisted = db.listCompanionBindings().find((b) => b.sessionId === sess && b.channel === TELEGRAM_CHANNEL);
    check("mirror: the flag persisted to the db for the mirror-target route too", persisted?.flaggedNonPrivate === true);

    await controller.stop();
  }

  // ============ Part 3 — MID-FLIGHT hardening: a flag flip DURING an in-progress reply stops the rest ======
  {
    // 3a. sendVia's per-chunk recheck: a long reply chunked into several adapter.send calls must stop
    // sending further chunks the instant the route is flagged mid-stream, even though deliverReply's own
    // up-front mayDeliverTo check passed (the binding was NOT yet flagged when the reply started).
    const sess = "sess-midflight-chunks";
    const binding = { sessionId: sess, channel: TELEGRAM_CHANNEL, chatId: "600600001", scope: "dm" };
    const gw = new ChatGateway(
      () => ({ delivered: true }), [binding], undefined, undefined,
      (sid) => (sid === sess ? { channel: TELEGRAM_CHANNEL, chatId: "600600001" } : null),
    );
    const chunkSent = [];
    // maxMessageLength:10 forces a 3-chunk split for a 25-char text (chunkText splits on whole words/
    // boundaries within the cap, so the exact split shape doesn't matter — only that there's more than one).
    const chunkyAdapter = {
      name: TELEGRAM_CHANNEL, maxMessageLength: 10, start() {}, async stop() {},
      async send(chatId, text) {
        chunkSent.push({ chatId, text });
        // Simulate a CONCURRENT inbound flagging this exact binding object mid-flight, right after the
        // FIRST chunk lands — the same object reference `gw`'s routing map holds (addBinding stores the
        // array's own objects, never a clone), so this mutation is visible to the NEXT mayDeliverTo call.
        if (chunkSent.length === 1) binding.flaggedNonPrivate = true;
      },
    };
    gw.registerAdapter(chunkyAdapter);
    const rChunk = await gw.deliverReply(sess, "one two three four five six");
    check("(3a) mid-flight flag flip stops sendVia after the chunk already in flight", rChunk.delivered === false && rChunk.reason === "route-flagged-non-private");
    check("(3a) exactly ONE chunk reached the adapter — the rest were stopped by the per-chunk recheck", chunkSent.length === 1);

    // 3b. tryDeliverVoice's pre-sendVoice recheck: a flag flip during the (async) synth step must stop the
    // voice send outright — proven by a synth() that itself flips the flag, so an unpatched deliverReply
    // would otherwise call adapter.sendVoice with a route that just got flagged mid-synth.
    const sessV = "sess-midflight-voice";
    const bindingV = { sessionId: sessV, channel: TELEGRAM_CHANNEL, chatId: "600600002", scope: "dm" };
    const prefs = inMemoryVoicePrefs();
    prefs.setVoiceReplies({ sessionId: sessV, channel: TELEGRAM_CHANNEL, chatId: "600600002", senderId: null }, "on");
    const voiceSent = [];
    const textSent = [];
    const voiceAdapter = {
      name: TELEGRAM_CHANNEL, maxMessageLength: 4096, start() {}, async stop() {},
      async send(chatId, text) { textSent.push({ chatId, text }); },
      async sendVoice(chatId, filePath) { voiceSent.push({ chatId, filePath }); },
    };
    const synth = {
      isReady: () => true,
      async synthesize() {
        // The flag flips DURING synth (the async step tryDeliverVoice's own comment calls out) — before
        // its post-synth mayDeliverTo recheck runs.
        bindingV.flaggedNonPrivate = true;
        return { filePath: "/tmp/would-be-voice-reply.ogg", cleanup: async () => {} };
      },
    };
    const gwV = new ChatGateway(
      () => ({ delivered: true }), [bindingV], undefined, undefined,
      (sid) => (sid === sessV ? { channel: TELEGRAM_CHANNEL, chatId: "600600002" } : null),
      prefs, undefined, synth,
    );
    gwV.registerAdapter(voiceAdapter);
    const rVoice = await gwV.deliverReply(sessV, "should never be spoken or texted");
    check("(3b) mid-synth flag flip is caught BEFORE sendVoice is called", voiceSent.length === 0);
    check("(3b) the text fallback ALSO never fires (sendVia's own recheck catches it too)", textSent.length === 0);
    check("(3b) the overall reply correctly reports suppression, not a false success", rVoice.delivered === false && rVoice.reason === "route-flagged-non-private");
  }
} finally {
  db.close();
  cleanupPathSync(tmpHome);
}

console.log(failures === 0
  ? "\n✅ ALL PASS — once a dm-scope binding is observed receiving a confirmed-non-private inbound, EVERY outbound producer (chat_reply, heartbeat/reminder/attention-push replies, deliverMedia, and the in-app→other-channel mirror) is suppressed for that route, silently and durably (the flag persists to the db and survives a fresh gateway build with no new inbound), an unflagged binding is completely unaffected, and re-binding the route clears the flag and restores delivery."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
