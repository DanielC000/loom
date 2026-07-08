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
//   • adapter lifecycle: gateway.start()/stop() drive adapter.start()/stop().
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

const inbound = (channel, chatId, body) => ({ channel, chatId, body });

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
