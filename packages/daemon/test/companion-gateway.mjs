// Loom Companion — ADAPTER-INTERFACE CONFORMANCE test for the Phase-1 ChatGateway subsystem. Fully
// hermetic: a FAKE ChannelAdapter (implementing the interface) drives the gateway; NO live network, NO
// real claude, NO daemon. Proves the card's conformance DoD:
//   • inbound normalize→route→submit lands on the RIGHT bound session (via the injected SubmitTurn spy);
//   • the allowlist REJECTS a foreign chat id AND a foreign channel — never submitted;
//   • a BUSY session (held in FIFO) is accepted (queued), NOT mistaken for a dead session;
//   • a DEAD session gets an error ACK back to the chat (dead-session ack path) — no silent vanish;
//   • chat_reply → the CORRECT adapter + chat id (multi-adapter registry routing);
//   • an outbound reply >4096 chars is CHUNKED into multiple sends (each ≤ the adapter's max);
//   • a transport-failure (send throws) → STRUCTURED { delivered:false, reason:"send-failed" }, no throw;
//   • adapter lifecycle: gateway.start()/stop() drive adapter.start()/stop();
//   • card dc5df70e: a HUNG tryAck transport send (never settles) does NOT hang the inbound turn — it times
//     out (bounded by the test-overridable ackSendTimeoutMs), aborts the signal it was given, and resolves
//     acked:false instead.
//   • card b343c5f0: a HUNG OUTBOUND transport send (deliverReply/sendVia, and sendToChannel) does NOT hang
//     the caller's turn — it times out (bounded by the test-overridable sendTimeoutMs), aborts the signal it
//     was given, and resolves the DISTINCT { delivered:false, reason:"timeout" } (never collapsed into
//     "send-failed", never a false "delivered"). A multi-chunk reply that times out on a later chunk records
//     only the CONFIRMED-sent prefix — the timed-out chunk's own text is never optimistically included. A
//     late resolution/rejection of an already-timed-out send changes nothing (no onReplyDelivered at all,
//     no extra history record, no unhandled rejection) — round 2 (Code Review ac892fe4, ruling a) made
//     onReplyDelivered NEVER fire on a timeout (unlike route-flagged/route-unbound); the zero-reply-detector
//     trip proof for N consecutive timeouts lives in companion-zero-reply.mjs, not here.
// Run: 1) build, 2) node test/companion-gateway.mjs
import { ChatGateway, chunkText } from "../dist/companion/chat-gateway.js";

let failures = 0;
const check = (label, cond) => { console.log(`${cond ? "PASS" : "FAIL"}  ${label}`); if (!cond) failures++; };

// A conformant fake ChannelAdapter: records sends + lifecycle calls; can be told to FAIL its send, either
// on every call (`fail`) or only from the (1-indexed) `failAfter`+1'th call onward — simulating a chunked
// reply whose first `failAfter` chunks reach the transport before it dies mid-stream.
function makeAdapter(name, { maxMessageLength = 4096, fail = false, failAfter = null } = {}) {
  const sent = [];
  let started = 0, stopped = 0, calls = 0;
  return {
    sent,
    get started() { return started; },
    get stopped() { return stopped; },
    adapter: {
      name,
      maxMessageLength,
      start() { started++; },
      async stop() { stopped++; },
      async send(chatId, text) {
        calls++;
        if (fail || (failAfter != null && calls > failAfter)) throw new Error("simulated transport failure");
        sent.push({ chatId, text });
      },
    },
  };
}

// chatIsDirect:true — this file tests ADAPTER-PLUMBING (routing/chunking/lifecycle), not the dm-scope
// authorization boundary itself (that's companion-authz.mjs's job); every inbound here represents an
// already-authorized chat, so it must confirm private (card b4f124d8 — dm-scope authorization now
// requires it) to keep exercising the plumbing these tests actually cover.
const inbound = (channel, chatId, body) => ({ channel, chatId, body, chatIsDirect: true });

// --- Adapter lifecycle: gateway drives start()/stop() -------------------------------------------
{
  const tg = makeAdapter("telegram");
  const gw = new ChatGateway(() => ({ delivered: true }), []);
  gw.registerAdapter(tg.adapter);
  gw.start();
  check("lifecycle: gateway.start() started the adapter", tg.started === 1);
  await gw.stop();
  check("lifecycle: gateway.stop() stopped the adapter", tg.stopped === 1);
}

// --- Inbound normalize→route→submit + allowlist -------------------------------------------------
{
  const submitted = [];
  const submit = (sid, text) => { submitted.push({ sid, text }); return { delivered: true }; };
  const tg = makeAdapter("telegram");
  const gw = new ChatGateway(submit, [{ sessionId: "sess-A", channel: "telegram", chatId: "111" }]);
  gw.registerAdapter(tg.adapter);

  const ok = await gw.handleInbound(inbound("telegram", "111", "hi there"));
  check("inbound: allowlisted → accepted, not queued", ok.accepted === true && ok.queued === false);
  check("inbound: submitted to the bound session", submitted.length === 1 && submitted[0].sid === "sess-A" && submitted[0].text === "hi there");

  const foreignChat = await gw.handleInbound(inbound("telegram", "999", "let me in"));
  check("allowlist: foreign chat id rejected", foreignChat.accepted === false && foreignChat.reason === "chat-not-allowlisted");

  const foreignChannel = await gw.handleInbound(inbound("whatsapp", "111", "wrong channel"));
  check("allowlist: right chat id but WRONG channel rejected", foreignChannel.accepted === false && foreignChannel.reason === "chat-not-allowlisted");

  check("allowlist: neither foreign message was submitted", submitted.length === 1);
}

// --- Busy session (held in FIFO) is accepted+queued, NOT dead ------------------------------------
{
  const tg = makeAdapter("telegram");
  // delivered:false WITH a position → the pty held it (busy/not-ready), a live session.
  const gw = new ChatGateway(() => ({ delivered: false, position: 3 }), [{ sessionId: "sess-A", channel: "telegram", chatId: "111" }]);
  gw.registerAdapter(tg.adapter);
  const r = await gw.handleInbound(inbound("telegram", "111", "queued please"));
  check("busy session: accepted + queued (position surfaced)", r.accepted === true && r.queued === true && r.position === 3);
  check("busy session: NO error ack sent (it's alive, just busy)", tg.sent.length === 0);
}

// --- Dead session → error ACK back to the chat (no silent vanish) --------------------------------
{
  const tg = makeAdapter("telegram");
  // delivered:false WITHOUT a position → the session is not alive (dead).
  const gw = new ChatGateway(() => ({ delivered: false }), [{ sessionId: "sess-A", channel: "telegram", chatId: "111" }]);
  gw.registerAdapter(tg.adapter);
  const r = await gw.handleInbound(inbound("telegram", "111", "anyone home?"));
  check("dead session: reported as session-dead", r.accepted === false && r.reason === "session-dead" && r.sessionId === "sess-A");
  check("dead session: ack was sent", r.acked === true && tg.sent.length === 1 && tg.sent[0].chatId === "111");
  check("dead session: ack text is a user-facing error", /currently running/i.test(tg.sent[0].text));
}

// --- tryAck ack-send timeout (card dc5df70e): a HUNG adapter.send never blocks the inbound turn --------
// RED on pre-fix code: `tryAck` used to `await adapter.send(...)` with no timeout, so this script's own
// top-level `await gw.handleInbound(...)` below would itself never settle. With nothing else left
// pending in the event loop, Node detects that unsettled top-level await and exits with code 13 — it
// does NOT hang the process forever.
{
  let sendCalls = 0;
  let sawSignal = null;
  let wasAborted = false;
  const hangingAdapter = {
    name: "telegram",
    maxMessageLength: 4096,
    start() {},
    async stop() {},
    send(chatId, text, opts) {
      sendCalls++;
      sawSignal = opts?.signal ?? null;
      sawSignal?.addEventListener("abort", () => { wasAborted = true; });
      return new Promise(() => { /* never settles — simulates a hung transport call */ });
    },
  };
  // delivered:false WITHOUT a position → dead session → tryAck fires the error ack (same path as the
  // "dead session" block above), except this adapter's send never resolves.
  // inboundQueueMaxWaitMs is left at its DEFAULT (~150s, see INBOUND_QUEUE_MAX_WAIT_MS) deliberately: it
  // is the per-route fallback card 986bdddd already guarantees, and a prompt result below could otherwise
  // be explained by THAT bound instead of the ack bound this test actually targets (Task 1, card
  // dc5df70e). Only ackSendTimeoutMs is overridden, to a tiny value, so the test doesn't wait a real
  // ACK_SEND_TIMEOUT_MS (15s).
  const gw = new ChatGateway(
    () => ({ delivered: false }),
    [{ sessionId: "sess-A", channel: "telegram", chatId: "111" }],
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined,
    undefined, // inboundQueueMaxWaitMs — default, see comment above
    20, // ackSendTimeoutMs
  );
  gw.registerAdapter(hangingAdapter);
  const startedAt = Date.now();
  const r = await gw.handleInbound(inbound("telegram", "111", "anyone home?"));
  const elapsedMs = Date.now() - startedAt;
  check("ack timeout: the inbound turn resolves promptly, NOT hung on the stuck send", elapsedMs < 5000);
  check("ack timeout: the turn still reports session-dead, with acked:false (never thrown)", r.accepted === false && r.reason === "session-dead" && r.acked === false);
  check("ack timeout: the adapter's send was actually invoked", sendCalls === 1);
  check("ack timeout: tryAck passed a real AbortSignal", sawSignal instanceof AbortSignal);
  check("ack timeout: the signal was aborted (no lingering request)", wasAborted === true);

  // --- Task 1 (card dc5df70e): the CARD'S MAIN CLAIM, tested directly — a hung ack must not freeze the
  // per-route queue (card 986bdddd) for a LATER message on the SAME route. Fire a second inbound on route
  // ("telegram","111") WITHOUT awaiting the first — so it genuinely queues behind the first's still-hung
  // ack — and confirm it resolves promptly instead of waiting out the much larger inboundQueueMaxWaitMs
  // fallback above. RED on pre-fix code: an unbounded tryAck send never settles processInboundOnce(msg1),
  // so msg2 would sit blocked until the ~150s fallback elapses, not resolve promptly like this.
  const queueStartedAt = Date.now();
  const p1 = gw.handleInbound(inbound("telegram", "111", "first on the route, again"));
  const p2 = gw.handleInbound(inbound("telegram", "111", "second on the SAME route, queued behind p1"));
  const [r1, r2] = await Promise.all([p1, p2]);
  const queueElapsedMs = Date.now() - queueStartedAt;
  check("queue not frozen: both same-route inbounds settle promptly (well under the ~150s fallback)", queueElapsedMs < 5000);
  check("queue not frozen: the first (queued ahead) still resolves session-dead/acked:false", r1.accepted === false && r1.reason === "session-dead" && r1.acked === false);
  check("queue not frozen: the SECOND, same-route message also resolves session-dead/acked:false", r2.accepted === false && r2.reason === "session-dead" && r2.acked === false);
  check("queue not frozen: the second message's own ack send was actually attempted (route genuinely advanced, not just timed out waiting)", sendCalls === 3);
}

// --- Submit primitive THROWS → contained (a racy inbound can't crash the daemon) ----------------
{
  const tg = makeAdapter("telegram");
  // enqueueStdin can throw (fail-loud M1/M2 guards, or pty.write racing a dying session). handleInbound
  // is fire-and-forget, so an escaping throw becomes an unhandled rejection → daemon process.exit(1).
  const gw = new ChatGateway(() => { throw new Error("pty.write on a dead session (raced restart)"); }, [
    { sessionId: "sess-A", channel: "telegram", chatId: "111" },
  ]);
  gw.registerAdapter(tg.adapter);
  let threw = false;
  let r;
  try { r = await gw.handleInbound(inbound("telegram", "111", "racy message")); } catch { threw = true; }
  check("submit-throws: handleInbound did NOT throw/reject (daemon can't be crashed by a racy inbound)", threw === false);
  check("submit-throws: structured submit-failed result", r && r.accepted === false && r.reason === "submit-failed" && r.sessionId === "sess-A");
  check("submit-throws: an error ack was sent to the chat", r && r.acked === true && tg.sent.length === 1 && tg.sent[0].chatId === "111");
}

// deliverReply now routes PURELY by the session's in-flight turn ORIGIN (an injected resolver simulating the
// pty's getActiveTurnOrigin) — NOT by bindings. Each block below injects an origin map as the 5th ChatGateway
// arg; a session with no origin ⇒ `no-target` (delivers nowhere).
const originOf = (map) => (sid) => map[sid] ?? null;

// --- chat_reply → the CORRECT adapter + chat id (multi-adapter registry routing) -----------------
{
  const tg = makeAdapter("telegram");
  const other = makeAdapter("fakechat");
  const gw = new ChatGateway(() => ({ delivered: true }), [
    { sessionId: "sess-A", channel: "telegram", chatId: "111" },
    { sessionId: "sess-B", channel: "fakechat", chatId: "222" },
  ], undefined, undefined, originOf({ "sess-A": { channel: "telegram", chatId: "111" }, "sess-B": { channel: "fakechat", chatId: "222" } }));
  gw.registerAdapter(tg.adapter);
  gw.registerAdapter(other.adapter);

  const dA = await gw.deliverReply("sess-A", "for A");
  check("routing: reply to sess-A delivered", dA.delivered === true && dA.chunks === 1);
  check("routing: sess-A reply hit the TELEGRAM adapter + chat 111", tg.sent.length === 1 && tg.sent[0].chatId === "111" && tg.sent[0].text === "for A");
  check("routing: the OTHER adapter got nothing", other.sent.length === 0);

  const dB = await gw.deliverReply("sess-B", "for B");
  check("routing: sess-B reply hit the FAKECHAT adapter + chat 222", other.sent.length === 1 && other.sent[0].chatId === "222" && other.sent[0].text === "for B");
  check("routing: telegram adapter still only has its one send", tg.sent.length === 1);

  const unknown = await gw.deliverReply("sess-Z", "nobody");
  check("routing: a session with NO in-flight-turn origin → structured no-target, nothing sent", unknown.delivered === false && unknown.reason === "no-target");
}

// --- Outbound >4096 → chunked into multiple sends (each ≤ max) -----------------------------------
{
  const tg = makeAdapter("telegram", { maxMessageLength: 4096 });
  const gw = new ChatGateway(() => ({ delivered: true }), [{ sessionId: "sess-A", channel: "telegram", chatId: "111" }], undefined, undefined, originOf({ "sess-A": { channel: "telegram", chatId: "111" } }));
  gw.registerAdapter(tg.adapter);

  const long = "a".repeat(10000); // no boundaries → hard cuts; concatenation must be lossless
  const d = await gw.deliverReply("sess-A", long);
  check("chunking: delivered", d.delivered === true);
  check("chunking: split into ceil(10000/4096)=3 sends", d.chunks === 3 && tg.sent.length === 3);
  check("chunking: every chunk ≤ 4096 chars", tg.sent.every((s) => s.text.length <= 4096));
  check("chunking: no-boundary text reassembles losslessly", tg.sent.map((s) => s.text).join("") === long);
  check("chunking: all chunks routed to the bound chat id", tg.sent.every((s) => s.chatId === "111"));

  // A reply UNDER the limit is a single send.
  const d2 = await gw.deliverReply("sess-A", "short");
  check("chunking: a short reply is a single send", d2.chunks === 1);
}

// --- Outbound chunking on WHITESPACE/NEWLINE boundaries is byte-LOSSLESS -------------------------
{
  const tg = makeAdapter("telegram", { maxMessageLength: 30 });
  const gw = new ChatGateway(() => ({ delivered: true }), [{ sessionId: "sess-A", channel: "telegram", chatId: "111" }], undefined, undefined, originOf({ "sess-A": { channel: "telegram", chatId: "111" } }));
  gw.registerAdapter(tg.adapter);
  // Text WITH spaces + newlines that forces boundary splits (the case the hard-cut test can't cover).
  const withBreaks = "line one goes here\nline two goes there\n" + "word ".repeat(15).trim();
  const d = await gw.deliverReply("sess-A", withBreaks);
  check("chunking(boundary): split into multiple sends, each ≤ max", d.chunks > 1 && tg.sent.every((s) => s.text.length <= 30));
  check("chunking(boundary): reassembly is byte-LOSSLESS (boundary chars kept)", tg.sent.map((s) => s.text).join("") === withBreaks);
}

// --- tryAck (slash-command ack) chunks a long ack to the adapter's max length (bugfix: a long /export
// or /help ack could exceed Telegram's 4096-char cap in one send call — tryAck now reuses chunkText
// exactly like sendVia) -------------------------------------------------------------------------
{
  const longText = "word ".repeat(20).trim(); // 99 chars, boundary-splitting (same shape as the sendVia tests)
  const messages = [{ id: "1", sessionId: "sess-A", channel: "telegram", chatId: "111", author: "user", text: longText, createdAt: "2026-01-01T00:00:00.000Z" }];
  const expectedAck = `📤 Conversation export (1 message):\n\n**You** (2026-01-01T00:00:00.000Z):\n${longText}`;

  const tg = makeAdapter("telegram", { maxMessageLength: 30 });
  const gw = new ChatGateway(
    () => ({ delivered: true }),
    [{ sessionId: "sess-A", channel: "telegram", chatId: "111" }],
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { read: () => messages },
  );
  gw.registerAdapter(tg.adapter);
  const r = await gw.handleInbound(inbound("telegram", "111", "/export"));
  check("tryAck chunking: /export recognized as a command, not submitted as a turn", r.accepted === false && r.reason === "command" && r.command === "export");
  check("tryAck chunking: ack reported delivered", r.acked === true);
  check("tryAck chunking: a long ack is split into MULTIPLE sends", tg.sent.length > 1);
  check("tryAck chunking: every chunk ≤ the adapter's max", tg.sent.every((s) => s.text.length <= 30));
  check("tryAck chunking: every chunk lands on the SAME chat, IN ORDER", tg.sent.every((s) => s.chatId === "111"));
  check("tryAck chunking: reassembly is byte-lossless (matches sendVia's own contract)", tg.sent.map((s) => s.text).join("") === expectedAck);
}

// --- tryAck: a SHORT ack (fits in one chunk) is still a single send — additive/byte-identical ---------
{
  const tg = makeAdapter("telegram", { maxMessageLength: 4096 });
  const gw = new ChatGateway(() => ({ delivered: true }), [{ sessionId: "sess-A", channel: "telegram", chatId: "111" }]);
  gw.registerAdapter(tg.adapter);
  const r = await gw.handleInbound(inbound("telegram", "111", "/whoami"));
  check("tryAck chunking: a short ack is still a single send", tg.sent.length === 1);
  check("tryAck chunking: short ack text unaffected", tg.sent[0].text.includes("Channel: telegram"));
}

// --- tryAck: the IN-APP adapter (no maxMessageLength) is unaffected — never chunked -------------------
{
  const longText = "word ".repeat(20).trim();
  const messages = [{ id: "1", sessionId: "sess-A", channel: "in-app", chatId: "sess-A", author: "user", text: longText, createdAt: "2026-01-01T00:00:00.000Z" }];
  const expectedAck = `📤 Conversation export (1 message):\n\n**You** (2026-01-01T00:00:00.000Z):\n${longText}`;
  const app = makeAdapter("in-app", { maxMessageLength: 0 }); // 0 ⇒ falsy, mirrors a real adapter with no maxMessageLength
  const gw = new ChatGateway(
    () => ({ delivered: true }),
    [{ sessionId: "sess-A", channel: "in-app", chatId: "sess-A" }],
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    { read: () => messages },
  );
  gw.registerAdapter(app.adapter);
  await gw.handleInbound(inbound("in-app", "sess-A", "/export"));
  check("tryAck chunking: in-app (no maxMessageLength) delivers a long ack as ONE send, untruncated", app.sent.length === 1 && app.sent[0].text === expectedAck);
}

// --- Transport failure → structured result, NEVER throws ----------------------------------------
{
  const tg = makeAdapter("telegram", { fail: true });
  const gw = new ChatGateway(() => ({ delivered: true }), [{ sessionId: "sess-A", channel: "telegram", chatId: "111" }], undefined, undefined, originOf({ "sess-A": { channel: "telegram", chatId: "111" } }));
  gw.registerAdapter(tg.adapter);
  let threw = false;
  let res;
  try { res = await gw.deliverReply("sess-A", "will fail"); } catch { threw = true; }
  check("transport-failure: deliverReply did NOT throw", threw === false);
  check("transport-failure: structured { delivered:false, reason:'send-failed' }", res && res.delivered === false && res.reason === "send-failed");
}

// --- Partial chunked send failure → chunks 1..k-1 that already reached the chat ARE recorded (CR#2 L1) ---
{
  const withBreaks = ("word ".repeat(20)).trim(); // same 99-char, boundary-splitting text as the unit test below
  const allParts = chunkText(withBreaks, 30);
  check("partial-send setup: the test text chunks into >2 parts (so a 3rd-chunk failure is genuinely PARTIAL)", allParts.length > 2);

  const tg = makeAdapter("telegram", { maxMessageLength: 30, failAfter: 2 }); // chunks 1-2 succeed, chunk 3 throws
  const recorded = [];
  const recorder = { record(sessionId, channel, chatId, author, text) { recorded.push({ sessionId, channel, chatId, author, text }); } };
  const gw = new ChatGateway(
    () => ({ delivered: true }),
    [{ sessionId: "sess-A", channel: "telegram", chatId: "111" }],
    undefined, undefined,
    originOf({ "sess-A": { channel: "telegram", chatId: "111" } }),
    undefined, undefined, undefined, undefined,
    recorder,
  );
  gw.registerAdapter(tg.adapter);

  const res = await gw.deliverReply("sess-A", withBreaks);
  check("partial-send: deliverReply still reports the failure", res.delivered === false && res.reason === "send-failed");
  check("partial-send: exactly the first 2 chunks reached the transport", tg.sent.length === 2);
  check("partial-send: the chunks that DID reach Telegram are NOT silently dropped from history", recorded.length === 1);
  check("partial-send: recorded as a companion outbound row on the right session/route", recorded[0]?.sessionId === "sess-A" && recorded[0]?.channel === "telegram" && recorded[0]?.chatId === "111" && recorded[0]?.author === "companion");
  check("partial-send: recorded text is EXACTLY the sent prefix (join of the successful chunks)", recorded[0]?.text === tg.sent.map((s) => s.text).join(""));
}

// --- A fully-failed send (chunk 1 itself throws) records NOTHING — no partial reached the chat ----------
{
  const tg = makeAdapter("telegram", { fail: true });
  const recorded = [];
  const recorder = { record(sessionId, channel, chatId, author, text) { recorded.push({ sessionId, channel, chatId, author, text }); } };
  const gw = new ChatGateway(
    () => ({ delivered: true }), [{ sessionId: "sess-A", channel: "telegram", chatId: "111" }],
    undefined, undefined, originOf({ "sess-A": { channel: "telegram", chatId: "111" } }),
    undefined, undefined, undefined, undefined, recorder,
  );
  gw.registerAdapter(tg.adapter);
  const res = await gw.deliverReply("sess-A", "will fail entirely");
  check("total-failure: still reports send-failed", res.delivered === false && res.reason === "send-failed");
  check("total-failure: nothing reached the chat, so nothing is recorded", recorded.length === 0);
}

// --- Card b343c5f0: a HUNG OUTBOUND send (deliverReply/sendVia) does NOT hang the caller's turn ---------
// RED on pre-fix code: `sendVia` used to `await adapter.send(...)` with no timeout, so this block's own
// `await gw.deliverReply(...)` would itself never settle.
{
  let sendCalls = 0;
  let sawSignal = null;
  let wasAborted = false;
  const hangingAdapter = {
    name: "telegram",
    maxMessageLength: 4096,
    start() {},
    async stop() {},
    send(chatId, text, opts) {
      sendCalls++;
      sawSignal = opts?.signal ?? null;
      sawSignal?.addEventListener("abort", () => { wasAborted = true; });
      return new Promise(() => { /* never settles — simulates a hung transport call */ });
    },
  };
  const delivered = [];
  const gw = new ChatGateway(
    () => ({ delivered: true }), [{ sessionId: "sess-A", channel: "telegram", chatId: "111" }],
    undefined, undefined, originOf({ "sess-A": { channel: "telegram", chatId: "111" } }),
    undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined,
    (sid) => delivered.push(sid), // onReplyDelivered
    undefined, undefined, undefined,
    undefined, // inboundQueueMaxWaitMs
    undefined, // ackSendTimeoutMs
    20, // sendTimeoutMs
  );
  gw.registerAdapter(hangingAdapter);
  const startedAt = Date.now();
  const res = await gw.deliverReply("sess-A", "this send will hang forever");
  const elapsedMs = Date.now() - startedAt;
  check("outbound timeout: deliverReply resolves promptly, NOT hung on the stuck send", elapsedMs < 5000);
  check("outbound timeout: structured { delivered:false, reason:'timeout' } (never a false 'delivered')", res.delivered === false && res.reason === "timeout");
  check("outbound timeout: the adapter's send was actually invoked", sendCalls === 1);
  check("outbound timeout: sendVia passed a real AbortSignal", sawSignal instanceof AbortSignal);
  check("outbound timeout: the signal was aborted (no lingering request)", wasAborted === true);
  // Round 2 (Code Review ac892fe4, ruling a): FLIPPED from round 1 — onReplyDelivered must NOT fire on a
  // timeout, unlike route-flagged-non-private/route-unbound (whose cause IS surfaced elsewhere). A
  // timeout's cause is diagnosed nowhere else, so it is treated like send-failed here; the detector-TRIP
  // proof for N consecutive timeouts lives in companion-zero-reply.mjs.
  check("outbound timeout: onReplyDelivered does NOT fire (unlike route-flagged/route-unbound) — a timeout's cause is undiagnosed, so it must still count toward the zero-reply streak", delivered.length === 0);
}

// --- Card b343c5f0: sendToChannel (the web-chat mirror path) reports the SAME distinct "timeout" reason,
// never collapsed into the generic "send-failed" ----------------------------------------------------------
{
  const hangingAdapter = {
    name: "telegram", maxMessageLength: 4096, start() {}, async stop() {},
    send() { return new Promise(() => { /* never settles */ }); },
  };
  const gw = new ChatGateway(
    () => ({ delivered: true }), [{ sessionId: "sess-A", channel: "telegram", chatId: "111" }],
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, 20, // sendTimeoutMs
  );
  gw.registerAdapter(hangingAdapter);
  const res = await gw.sendToChannel("sess-A", "telegram", "111", "mirrored text");
  check("sendToChannel timeout: resolves promptly with the distinct 'timeout' reason (not 'send-failed')", res.delivered === false && res.reason === "timeout");
}

// --- Card b343c5f0: a MULTI-CHUNK reply that times out on a LATER chunk records ONLY the confirmed-sent
// prefix — the timed-out chunk's own text is never optimistically included (unconfirmed, not known-sent) ---
{
  const withBreaks = ("word ".repeat(20)).trim(); // same 99-char, boundary-splitting text as the earlier partial-send test
  const allParts = chunkText(withBreaks, 30);
  check("partial-timeout setup: the test text chunks into >2 parts (so a 3rd-chunk timeout is genuinely PARTIAL)", allParts.length > 2);

  let calls = 0;
  const sent = [];
  const hangOnThirdAdapter = {
    name: "telegram", maxMessageLength: 30, start() {}, async stop() {},
    send(chatId, text) {
      calls++;
      if (calls > 2) return new Promise(() => { /* chunk 3 hangs forever */ });
      sent.push({ chatId, text });
      return Promise.resolve();
    },
  };
  const recorded = [];
  const recorder = { record(sessionId, channel, chatId, author, text) { recorded.push({ sessionId, channel, chatId, author, text }); } };
  const gw = new ChatGateway(
    () => ({ delivered: true }), [{ sessionId: "sess-A", channel: "telegram", chatId: "111" }],
    undefined, undefined, originOf({ "sess-A": { channel: "telegram", chatId: "111" } }),
    undefined, undefined, undefined, undefined, recorder,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, 20, // sendTimeoutMs
  );
  gw.registerAdapter(hangOnThirdAdapter);
  const res = await gw.deliverReply("sess-A", withBreaks);
  check("partial-timeout: deliverReply reports the distinct timeout reason", res.delivered === false && res.reason === "timeout");
  check("partial-timeout: exactly the first 2 chunks reached the transport", sent.length === 2);
  check("partial-timeout: the confirmed-sent prefix IS recorded", recorded.length === 1);
  check("partial-timeout: recorded text is EXACTLY the confirmed prefix — the timed-out chunk's own text is NOT included", recorded[0]?.text === sent.map((s) => s.text).join(""));
}

// --- Card b343c5f0: a LATE RESOLUTION of an already-timed-out send changes NOTHING — no onReplyDelivered,
// no (extra) history record. The SETUP checks below (the timeout itself, and that onReplyDelivered did NOT
// fire — round 2 flip, see the "outbound timeout" block above) are ordinary falsifiable assertions against
// `sendVia`'s own timeout branch. The POST-release checks after the late resolve are a different kind of
// thing: `withTimeout` never reads a late settlement once its own timer has already won the race, so those
// are PROVABLE-BY-CONSTRUCTION — PINNED, not a falsifiable regression test (round 2, Code Review ac892fe4,
// item 3). They pass regardless of whether `sendVia`'s timeout branch is even correct; they exist to
// document the invariant a future refactor of `withTimeout` must preserve, not to catch a regression there.
// NOT a fixed-wait-then-negative-check: rather than sleep an arbitrary duration and hope it was "long
// enough", this awaits the EXACT promise `sendVia` handed to `withTimeout` (captured via the adapter) —
// `withTimeout` already attached its own `.catch(() => {})` to that SAME promise BEFORE this test's own
// `.catch` below, so by the time this test's await resolves, that swallow has deterministically already
// run (same microtask queue, FIFO per-promise reaction order) — no timer, no race, no guessed duration ---
{
  let releaseSend;
  let capturedSendPromise;
  const lateAdapter = {
    name: "telegram", maxMessageLength: 4096, start() {}, async stop() {},
    send() {
      capturedSendPromise = new Promise((resolve) => { releaseSend = resolve; });
      return capturedSendPromise;
    },
  };
  const delivered = [];
  const recorded = [];
  const recorder = { record(sessionId, channel, chatId, author, text) { recorded.push({ sessionId, channel, chatId, author, text }); } };
  const gw = new ChatGateway(
    () => ({ delivered: true }), [{ sessionId: "sess-A", channel: "telegram", chatId: "111" }],
    undefined, undefined, originOf({ "sess-A": { channel: "telegram", chatId: "111" } }),
    undefined, undefined, undefined, undefined, recorder,
    undefined, undefined, undefined, undefined, undefined,
    (sid) => delivered.push(sid), // onReplyDelivered
    undefined, undefined, undefined,
    undefined, undefined, 20, // sendTimeoutMs
  );
  gw.registerAdapter(lateAdapter);
  const res = await gw.deliverReply("sess-A", "will time out, then resolve late");
  check("late-resolution setup: the send genuinely timed out first", res.delivered === false && res.reason === "timeout");
  check("late-resolution setup: onReplyDelivered did NOT fire (round 2 — a timeout is not a diagnosed cause)", delivered.length === 0);
  check("late-resolution setup: nothing recorded yet (the only chunk never confirmed)", recorded.length === 0);

  // Let the hung send resolve LATE — after the timeout already won the race — then wait on the SAME
  // promise object (never a fresh timer) to prove the production swallow-handler has actually run.
  releaseSend(undefined);
  await capturedSendPromise.catch(() => {});
  check("late-resolution (PINNED, not falsifiable): still no onReplyDelivered after the late success", delivered.length === 0);
  check("late-resolution (PINNED, not falsifiable): no history record appeared after the late success", recorded.length === 0);
}

// --- Card b343c5f0: the SAME guarantee on the REJECTION side — a late-arriving throw from an
// already-timed-out send must never surface as an unhandled rejection or double-report anything. Same
// promise-anchored witness as the resolution case above (never a fixed sleep). Like the resolution block
// above, the setup check is ordinary and falsifiable; the post-rejection check is PINNED, not falsifiable
// (round 2, Code Review ac892fe4, item 3) — see that block's own comment for why ------------------------
{
  let releaseSend;
  let capturedSendPromise;
  const lateAdapter = {
    name: "telegram", maxMessageLength: 4096, start() {}, async stop() {},
    send() {
      capturedSendPromise = new Promise((_resolve, reject) => { releaseSend = reject; });
      return capturedSendPromise;
    },
  };
  const delivered = [];
  const gw = new ChatGateway(
    () => ({ delivered: true }), [{ sessionId: "sess-A", channel: "telegram", chatId: "111" }],
    undefined, undefined, originOf({ "sess-A": { channel: "telegram", chatId: "111" } }),
    undefined, undefined, undefined, undefined, undefined,
    undefined, undefined, undefined, undefined, undefined,
    (sid) => delivered.push(sid),
    undefined, undefined, undefined,
    undefined, undefined, 20, // sendTimeoutMs
  );
  gw.registerAdapter(lateAdapter);
  const res = await gw.deliverReply("sess-A", "will time out, then reject late");
  check("late-rejection setup: the send genuinely timed out first", res.delivered === false && res.reason === "timeout");
  check("late-rejection setup: onReplyDelivered did NOT fire (round 2 — a timeout is not a diagnosed cause)", delivered.length === 0);
  releaseSend(new Error("late transport error, after the client already gave up"));
  await capturedSendPromise.catch(() => {});
  // Reaching this line at all (rather than the process crashing on an unhandled rejection) IS part of the
  // proof — see withTimeout's own `promise.catch(() => {})` swallow, which this test's own `.catch` above
  // is guaranteed to run AFTER (same promise, FIFO reaction order).
  check("late-rejection (PINNED, not falsifiable): still no onReplyDelivered after the late rejection", delivered.length === 0);
}

// --- chunkText unit edges -----------------------------------------------------------------------
{
  check("chunkText: under limit → single chunk", chunkText("hello", 4096).length === 1);
  check("chunkText: exactly the limit → single chunk", chunkText("a".repeat(10), 10).length === 1);
  const withBreaks = ("word ".repeat(20)).trim(); // 99 chars with spaces
  const parts = chunkText(withBreaks, 30);
  check("chunkText: splits on whitespace, every chunk ≤ max", parts.every((p) => p.length <= 30) && parts.length > 1);
  check("chunkText: boundary split is byte-lossless (join === original)", parts.join("") === withBreaks);
  check("chunkText: max<=0 is a no-op single chunk", chunkText("abc", 0).length === 1);
}

// --- chunkText hard-cut does NOT split an astral emoji's UTF-16 surrogate pair (CR#2 N2) ------------------
{
  // "a".repeat(9) + an astral emoji (U+1F600, 2 UTF-16 code units) — with max=10 a naive hard cut at code
  // UNIT 10 lands exactly between the emoji's leading/trailing surrogate.
  const emoji = "\u{1F600}"; // 😀 — 2 code units
  const text = "a".repeat(9) + emoji + "a".repeat(9) + emoji; // no whitespace/newline boundary anywhere
  const parts = chunkText(text, 10);
  check("chunkText(surrogate): every chunk ≤ max", parts.every((p) => p.length <= 10));
  check("chunkText(surrogate): reassembly is lossless", parts.join("") === text);
  check("chunkText(surrogate): no chunk contains a lone (unpaired) surrogate", parts.every((p) => {
    // Scan at the UTF-16 code-UNIT level (the actual hazard): a leading surrogate whose next unit isn't
    // its trailing pair, or a trailing surrogate with no preceding leading pair, means the chunk boundary
    // split an astral character in two.
    for (let i = 0; i < p.length; i++) {
      const c = p.charCodeAt(i);
      if (c >= 0xd800 && c <= 0xdbff) { if (p.charCodeAt(i + 1) < 0xdc00 || p.charCodeAt(i + 1) > 0xdfff) return false; }
      else if (c >= 0xdc00 && c <= 0xdfff) { if (i === 0 || p.charCodeAt(i - 1) < 0xd800 || p.charCodeAt(i - 1) > 0xdbff) return false; }
    }
    return true;
  }));
}

console.log(failures === 0
  ? "\n✅ ALL PASS — a fake adapter drives the gateway: inbound routes to the bound session (allowlist rejects foreign chat/channel), busy≠dead, dead-session acks, chat_reply routes to the correct adapter+chat, long replies chunk, and a transport failure returns a structured result."
  : `\n❌ ${failures} FAILURE(S).`);
process.exit(failures === 0 ? 0 : 1);
