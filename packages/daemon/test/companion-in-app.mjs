import "./_guard.mjs"; // prod-guard: arms the Db backstop (sets LOOM_TEST=1; see _guard.mjs)
// Loom Companion — the IN-APP channel adapter (the DEFAULT companion transport). Fully hermetic: the
// in-app hub + a real ChatGateway + a fake WEB CLIENT (the InAppClient seam) — NO real browser, NO
// network, NO real claude, NO daemon. Proves the card DoD:
//   1. INBOUND routes to the bound companion session THROUGH the bindings-authoritative gateway (config is
//      NEVER a routing source — the gateway has no config at all; a foreign in-app chat with no binding is
//      rejected exactly like any other channel).
//   2. A companion chat_reply (OUTBOUND via deliverReply) reaches the in-app adapter.send and is FRAMED
//      ({ type:"chat", chatId, text }) for the web client; detach stops delivery; a reply with no attached
//      client is dropped (no throw).
//   3. NO token / NO pairing for the in-app channel; and the adapter creates NO companion / NO binding by
//      itself (an unbound in-app chat is rejected — the adapter never auto-provisions a route).
//   4. The controller's stable handleInAppInbound indirection: "companion-off" with no live gateway, and
//      once live it routes to the bound session (inbound=submitTurn) while deliverReply pushes OUT to the
//      attached web client (outbound) — not cross-wired.
// Run: 1) build (turbo builds shared first), 2) node test/companion-in-app.mjs
import { ChatGateway } from "../dist/companion/chat-gateway.js";
import { InAppChannel, IN_APP_CHANNEL, normalizeInAppMessage } from "../dist/companion/in-app.js";
import { CompanionController } from "../dist/companion/controller.js";
import { createCompanionGateway } from "../dist/companion/factory.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// A fake WEB CLIENT — the InAppClient seam the WS route wraps around a real socket. Records every frame.
const makeClient = () => { const frames = []; return { frames, client: { deliver: (f) => frames.push(f) } }; };

// The in-app binding shape (chatId == the bound session id — the loopback self-address).
const inAppBinding = (sessionId) => ({ sessionId, channel: IN_APP_CHANNEL, chatId: sessionId, scope: "dm" });

// --- 1) INBOUND routes to the bound session through the BINDINGS gate (config NOT consulted) -----------
{
  const submitted = [];
  const submit = (sid, text) => { submitted.push({ sid, text }); return { delivered: true }; };
  const inApp = new InAppChannel();
  // The gateway is constructed with ONLY (submit, bindings) — there is NO config object anywhere, so routing
  // CANNOT consult config; it matches purely on the (channel, chatId) binding.
  const gw = new ChatGateway(submit, [inAppBinding("sess-A")]);
  gw.registerAdapter(inApp.adapter);

  const msg = normalizeInAppMessage("sess-A", "typed in the cockpit");
  check("normalize: in-app inbound has channel=in-app, chatId=session, no sender", msg.channel === IN_APP_CHANNEL && msg.chatId === "sess-A" && msg.body === "typed in the cockpit" && msg.sender === undefined);

  const r = await gw.handleInbound(msg);
  check("inbound: bound in-app chat → accepted, submitted to the bound session", r.accepted === true && submitted.length === 1 && submitted[0].sid === "sess-A" && submitted[0].text === "typed in the cockpit");

  // A foreign in-app chat id with NO binding is rejected by the SAME bindings gate — proves routing is
  // bindings-authoritative for in-app too (not the config / not the channel name).
  const foreign = await gw.handleInbound(normalizeInAppMessage("sess-OTHER", "let me in"));
  check("inbound: an UNBOUND in-app chat is rejected (bindings-authoritative, not config)", foreign.accepted === false && foreign.reason === "chat-not-allowlisted");
  check("inbound: the rejected message was never submitted", submitted.length === 1);
}

// --- 2) OUTBOUND chat_reply reaches adapter.send and is FRAMED for the web client ---------------------
{
  const inApp = new InAppChannel();
  const gw = new ChatGateway(() => ({ delivered: true }), [inAppBinding("sess-A")]);
  gw.registerAdapter(inApp.adapter);

  // A web client attaches to the in-app chat (chatId == sess-A) — this is the "simulate the WS client".
  const { frames, client } = makeClient();
  const unsub = inApp.attach("sess-A", client);
  check("attach: hub reports the client attached", inApp.hasClients("sess-A") === true);

  const d = await gw.deliverReply("sess-A", "hello from the companion");
  check("outbound: deliverReply delivered (single frame — no chunking for in-app)", d.delivered === true && d.chunks === 1);
  check("outbound: the web client received exactly one FRAMED chat message", frames.length === 1 && frames[0].type === "chat" && frames[0].chatId === "sess-A" && frames[0].text === "hello from the companion");

  // Detach → deliveries stop; a reply with no attached client is DROPPED (in-app has no store-and-forward)
  // but deliverReply still returns delivered:true and NEVER throws.
  unsub();
  check("detach: hub reports no client", inApp.hasClients("sess-A") === false);
  let threw = false; let d2;
  try { d2 = await gw.deliverReply("sess-A", "nobody is watching"); } catch { threw = true; }
  check("outbound(no client): deliverReply did not throw + no new frame delivered", threw === false && frames.length === 1);

  // Multiple viewers of the same companion chat each get the reply.
  const a = makeClient(); const b = makeClient();
  inApp.attach("sess-A", a.client); inApp.attach("sess-A", b.client);
  await gw.deliverReply("sess-A", "fan-out");
  check("outbound(multi-viewer): every attached client got the frame", a.frames.length === 1 && b.frames.length === 1 && a.frames[0].text === "fan-out" && b.frames[0].text === "fan-out");
}

// --- 3) NO token / NO pairing; the adapter creates NO companion / NO binding by itself ----------------
{
  // Constructing the in-app channel takes NO bot token (contrast createTelegramAdapter(botToken, …)).
  const inApp = new InAppChannel();
  check("no-token: adapter constructed with no token, name=in-app, no chunking cap", inApp.adapter.name === IN_APP_CHANNEL && inApp.adapter.maxMessageLength === undefined);

  // The hub holds NO db and NO binding store — it cannot mint a companion or a binding. An inbound for an
  // in-app chat with NO binding is rejected: the adapter did NOT auto-provision a route to make it flow.
  const submitted = [];
  const gw = new ChatGateway((sid, text) => { submitted.push({ sid, text }); return { delivered: true }; }, [] /* EMPTY bindings */);
  gw.registerAdapter(inApp.adapter);
  const r = await gw.handleInbound(normalizeInAppMessage("sess-unprovisioned", "hi"));
  check("no-binding: an in-app chat with no binding is rejected (adapter creates no binding)", r.accepted === false && r.reason === "chat-not-allowlisted");
  check("no-binding: nothing was submitted (no self-provisioned route)", submitted.length === 0);
  // No pairing: the default gateway uses the no-op pairing coordinator, so a rejected unbound in-app chat is
  // plainly "chat-not-allowlisted" — never a pairing redemption (in-app needs no enrollment code).
  check("no-pairing: rejection is a plain allowlist deny, not a pairing outcome", r.reason === "chat-not-allowlisted");

  // Empty / non-string body normalizes to null (nothing to submit) — never a crash, never a route.
  check("normalize: empty body → null", normalizeInAppMessage("sess-A", "") === null);
  check("normalize: non-string body → null", normalizeInAppMessage("sess-A", undefined) === null);
}

// --- 4) The controller's stable handleInAppInbound indirection (off → live), not cross-wired ----------
{
  const inApp = new InAppChannel();
  const submitted = [];
  const submitSpy = (sid, text) => { submitted.push({ sid, text }); return { delivered: true }; };
  // Injected gateway builder: a REAL ChatGateway over an in-app binding + the SAME hub's adapter (so the
  // real bind/route/deliver logic runs) — no Telegram, no long-poll, no network.
  const buildGateway = (_cfg, submit, _db) => {
    const gw = new ChatGateway(submit, [inAppBinding("sess-A")]);
    gw.registerAdapter(inApp.adapter);
    return gw;
  };
  const cfg = {
    botToken: "unused-by-in-app", allowedChatId: "sess-A", sessionId: "sess-A", chatScope: "dm",
    homeChannel: IN_APP_CHANNEL, homeChatId: "sess-A", heartbeatIntervalMinutes: 0, heartbeatPrompt: "p",
  };
  const hooks = { companionSessionId: null };
  const controller = new CompanionController({
    db: {}, // unused: resolveEffective + buildGateway are both injected
    submitTurn: submitSpy,
    pty: { isAlive: () => true, enqueueStdin: () => ({ delivered: true }), getPending: () => [] },
    hooks,
    env: {},
    inApp,
    buildGateway,
    resolveEffective: () => cfg,
  });

  // Before any gateway is live: handleInAppInbound is a safe "companion-off" (never throws, never routes).
  const off = await controller.handleInAppInbound("sess-A", "anyone?");
  check("controller: handleInAppInbound is companion-off before a gateway is live", off.accepted === false && off.reason === "companion-off");

  await controller.reconcile(); // OFF → ON: builds + starts the gateway
  check("controller: gateway live after reconcile, chat_reply gate points at the bound session", controller.snapshot().running === true && hooks.companionSessionId === "sess-A");

  const { frames, client } = makeClient();
  inApp.attach("sess-A", client);

  // INBOUND through the controller indirection → the SAME bindings gate → submitTurn to the bound session.
  const inb = await controller.handleInAppInbound("sess-A", "hello via controller");
  check("controller: inbound routes to the bound session (inbound = submitTurn)", inb.accepted === true && submitted.length === 1 && submitted[0].sid === "sess-A" && submitted[0].text === "hello via controller");

  // OUTBOUND through the controller → deliverReply → the in-app adapter → the web client. NOT cross-wired:
  // the reply is FRAMED to the client and does NOT submit a second turn.
  const out = await controller.deliverReply("sess-A", "reply via controller");
  check("controller: outbound reaches the web client, framed, with NO extra turn", out.delivered === true && frames.length === 1 && frames[0].type === "chat" && frames[0].text === "reply via controller" && submitted.length === 1);

  // Empty body via the controller → no-text, never a submit.
  const empty = await controller.handleInAppInbound("sess-A", "");
  check("controller: empty inbound → no-text, nothing submitted", empty.accepted === false && empty.reason === "no-text" && submitted.length === 1);
}

// --- 5) The REAL factory registers the in-app hub adapter (guards factory.ts line 63) ----------------
// Sections 1–4 register the hub adapter by hand; this one goes through createCompanionGateway so the
// PRODUCTION wiring is exercised — if `if (inApp) gateway.registerAdapter(inApp.adapter)` is deleted,
// deliverReply falls back to reason:"no-adapter" and this case FAILS (the coverage gap the review flagged).
{
  const inApp = new InAppChannel();
  // A minimal CompanionBindingStore: the factory reads listCompanionBindings() (non-empty ⇒ it does NOT
  // upsert) and lazily getCompanionHome(); auth/pairing wrap the store but touch nothing at construction,
  // and neither they nor the home resolver are consulted by an OUTBOUND deliverReply with a matched binding.
  const fakeStore = {
    listCompanionBindings: () => [{ sessionId: "sess-F", channel: IN_APP_CHANNEL, chatId: "sess-F", scope: "dm", createdAt: "2026-01-01T00:00:00.000Z" }],
    upsertCompanionBinding: (b) => ({ ...b, createdAt: "2026-01-01T00:00:00.000Z" }),
    getCompanionHome: () => null,
    isSenderAllowed: () => false,
    redeemPairingCode: () => ({ outcome: "rejected" }),
  };
  const cfg = {
    // A shaped (non-empty) token so the factory's real grammY Bot(cfg.botToken) constructs — no network is
    // touched (only gateway.start() would poll, which this case never calls).
    botToken: "123456789:AAfake-token-for-test", allowedChatId: "sess-F", sessionId: "sess-F", chatScope: "dm",
    homeChannel: IN_APP_CHANNEL, homeChatId: "sess-F", heartbeatIntervalMinutes: 0, heartbeatPrompt: "p",
  };
  const submitted = [];
  const gw = createCompanionGateway(cfg, (sid, text) => { submitted.push({ sid, text }); return { delivered: true }; }, fakeStore, inApp);

  const { frames, client } = makeClient();
  inApp.attach("sess-F", client);
  const d = await gw.deliverReply("sess-F", "framed by the real factory");
  check("factory: createCompanionGateway registered the in-app adapter (outbound delivered, not no-adapter)", d.delivered === true && d.reason === undefined);
  check("factory: the attached web client got the framed { type:'chat' } reply", frames.length === 1 && frames[0].type === "chat" && frames[0].chatId === "sess-F" && frames[0].text === "framed by the real factory");
}

console.log(failures === 0
  ? "\n✅ ALL PASS — the in-app channel carries companion traffic over the bindings-authoritative gateway with NO token/pairing: inbound routes to the bound session (config never consulted; an unbound chat is rejected — no self-provisioned route), a chat_reply reaches adapter.send framed for the web client, and the controller's stable indirection is off-safe and not cross-wired."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
