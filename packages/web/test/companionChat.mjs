// Hermetic unit test for the in-app companion CHAT transport logic in src/lib/companionChat.ts — the pure,
// dependency-free helpers behind components/CompanionChat.tsx (the wire framing the panel SENDS, the frame
// parsing that decides what renders as a companion bubble, and the you/companion message builders). No
// daemon, no claude, no WebSocket, no DOM: it imports the TS source directly via Node's type stripping and
// asserts on plain objects, so it exercises the REAL shipped helpers and can't drift from a copy.
//
// This is the "component/interaction test (mock the WS)" for send + render-reply, reduced to its pure core:
// a typed message must emit exactly {type:"chat",text}, and an inbound {type:"chat"} frame must become a
// companion bubble while any non-chat frame is ignored. The live render + real WS connect + real frame
// emission are covered by the Playwright self-verify pass (see the worker report).
//
// Like companion.mjs, the web package has no test runner, so this is a self-contained node script wired into
// @loom/web's `build` script (which CI runs via `pnpm build`). Run it standalone with:
//   node --experimental-strip-types packages/web/test/companionChat.mjs
import assert from "node:assert/strict";
import {
  IN_APP_CHANNEL, companionMessage, historyMessage, isArmedInApp, parseInbound, parseTranscript, prepareSend,
  prepareSendAudio, youMessage,
} from "../src/lib/companionChat.ts";

let pass = 0;
const check = (name, fn) => { fn(); pass++; console.log(`ok   ${name}`); };

// ── OUTBOUND: prepareSend frames a typed message as exactly {type:"chat",text} ───────────────────────

// 1) A typed message emits the correct wire frame + a matching display text (the one-source-of-truth rule).
check("prepareSend: a typed message emits {type:\"chat\",text} and the display text", () => {
  const res = prepareSend("hello there");
  assert.ok(res, "a non-empty draft prepares a send");
  assert.equal(res.text, "hello there");
  assert.deepEqual(JSON.parse(res.frame), { type: "chat", text: "hello there" }, "the wire frame is exactly {type:chat,text}");
});

// 2) The draft is trimmed for BOTH the frame and the display text — they can never diverge.
check("prepareSend: trims the draft for both the frame and the display text", () => {
  const res = prepareSend("  spaced  ");
  assert.equal(res.text, "spaced");
  assert.equal(JSON.parse(res.frame).text, "spaced");
});

// 3) An empty / whitespace-only draft prepares NOTHING (no frame emitted — mirrors the daemon's empty guard).
check("prepareSend: an empty or whitespace-only draft returns null (nothing to send)", () => {
  assert.equal(prepareSend(""), null);
  assert.equal(prepareSend("   \n  "), null);
});

// ── INBOUND: parseInbound accepts only a well-formed {type:"chat"} frame, else null (ignored) ────────

// 4) A well-formed chat frame is parsed to { chatId, text } — this is what renders as a companion bubble.
check("parseInbound: a {type:\"chat\"} frame yields { chatId, text }", () => {
  assert.deepEqual(
    parseInbound(JSON.stringify({ type: "chat", chatId: "sess-1", text: "hi from the companion" })),
    { chatId: "sess-1", text: "hi from the companion" },
  );
});

// 5) A missing chatId defaults to "" (still renders; the panel keys on the socket, not chatId).
check("parseInbound: a chat frame with no chatId defaults chatId to \"\"", () => {
  assert.deepEqual(parseInbound(JSON.stringify({ type: "chat", text: "no id" })), { chatId: "", text: "no id" });
});

// 6) A NON-chat frame is ignored (null) — the same session multiplexes control frames the panel must drop.
check("parseInbound: a non-chat frame is ignored (null)", () => {
  assert.equal(parseInbound(JSON.stringify({ type: "geometry", cols: 120, rows: 40 })), null);
  assert.equal(parseInbound(JSON.stringify({ type: "data", data: "raw" })), null);
  assert.equal(parseInbound(JSON.stringify({ type: "chat" })), null, "a chat frame with no text string is not a renderable reply");
  assert.equal(parseInbound(JSON.stringify({ type: "chat", text: 42 })), null, "a non-string text is rejected");
});

// 7) Malformed / non-object payloads never throw and never render (defensive against untrusted transport).
check("parseInbound: malformed JSON or a non-object never throws, returns null", () => {
  assert.equal(parseInbound("not json {"), null);
  assert.equal(parseInbound("null"), null);
  assert.equal(parseInbound("\"a string\""), null);
  assert.equal(parseInbound("[1,2,3]"), null, "an array is not a chat frame");
});

// ── The message builders that turn a send / a parsed reply into a rendered bubble ────────────────────

check("youMessage / companionMessage: build the correctly-authored bubble, tagged the in-app channel (this WS is in-app-only)", () => {
  assert.deepEqual(youMessage("mine", "1"), { id: "1", author: "you", text: "mine", channel: "in-app" });
  assert.deepEqual(companionMessage("theirs", "2"), { id: "2", author: "companion", text: "theirs", channel: "in-app" });
});

// End-to-end (pure): a send → a "you" bubble + the emitted frame; that frame, echoed back by a mock WS,
// parses and becomes a "companion" bubble. This is the send + render-reply interaction, WS mocked.
check("round-trip: send emits a frame; the echoed frame parses into a companion bubble", () => {
  const prepared = prepareSend("ping");
  const mine = youMessage(prepared.text, "1");
  assert.equal(mine.author, "you");
  // Mock WS echo: the daemon would reply with a chat frame carrying chatId == the session id.
  const echoed = JSON.stringify({ type: "chat", chatId: "sess-1", text: "pong" });
  const reply = parseInbound(echoed);
  assert.ok(reply, "the echoed frame is a valid chat reply");
  const theirs = companionMessage(reply.text, "2");
  assert.equal(theirs.author, "companion");
  assert.equal(theirs.text, "pong");
});

check("IN_APP_CHANNEL mirrors the daemon's channel name", () => {
  assert.equal(IN_APP_CHANNEL, "in-app");
});

// ── VOICE INBOUND (Companion Voice epic, VOICE-P4): prepareSendAudio + parseTranscript ─────────────────

check("prepareSendAudio: frames a recorded clip as exactly {type:\"audio\",data,mimeType}", () => {
  const frame = prepareSendAudio("QUJD", "audio/webm;codecs=opus");
  assert.deepEqual(JSON.parse(frame), { type: "audio", data: "QUJD", mimeType: "audio/webm;codecs=opus" });
});

check("parseTranscript: a {type:\"transcript\"} frame yields { chatId, text } — the daemon's live echo of OUR OWN mic clip", () => {
  assert.deepEqual(
    parseTranscript(JSON.stringify({ type: "transcript", chatId: "sess-1", text: "transcribed from the mic" })),
    { chatId: "sess-1", text: "transcribed from the mic" },
  );
});

check("parseTranscript: a missing chatId defaults to \"\"", () => {
  assert.deepEqual(parseTranscript(JSON.stringify({ type: "transcript", text: "no id" })), { chatId: "", text: "no id" });
});

check("parseTranscript: a non-transcript frame is ignored (null) — incl. a companion chat reply", () => {
  assert.equal(parseTranscript(JSON.stringify({ type: "chat", chatId: "sess-1", text: "a companion reply" })), null);
  assert.equal(parseTranscript(JSON.stringify({ type: "transcript" })), null, "no text string is not renderable");
  assert.equal(parseTranscript("not json {"), null);
  assert.equal(parseTranscript("[1,2,3]"), null);
});

check("parseInbound never mistakes a transcript frame for a companion reply (the two frame types are disjoint)", () => {
  assert.equal(parseInbound(JSON.stringify({ type: "transcript", chatId: "sess-1", text: "mine" })), null);
});

// ── VOICE OUTBOUND (Companion Voice epic, VOICE-P4): parseInbound's optional audio field ───────────────

check("parseInbound: a voiced reply carries the audio field through", () => {
  const frame = JSON.stringify({ type: "chat", chatId: "sess-1", text: "voiced reply", audio: { data: "QUJD", mimeType: "audio/ogg" } });
  assert.deepEqual(parseInbound(frame), { chatId: "sess-1", text: "voiced reply", audio: { data: "QUJD", mimeType: "audio/ogg" } });
});

check("parseInbound: a plain (non-voiced) reply has NO audio key at all (not even undefined)", () => {
  const parsed = parseInbound(JSON.stringify({ type: "chat", chatId: "sess-1", text: "plain reply" }));
  assert.deepEqual(parsed, { chatId: "sess-1", text: "plain reply" });
  assert.equal("audio" in parsed, false);
});

check("parseInbound: a malformed audio field (missing data/mimeType) is DROPPED, reply still renders as text", () => {
  assert.deepEqual(parseInbound(JSON.stringify({ type: "chat", chatId: "sess-1", text: "t", audio: { data: "" } })), { chatId: "sess-1", text: "t" });
  assert.deepEqual(parseInbound(JSON.stringify({ type: "chat", chatId: "sess-1", text: "t", audio: "not-an-object" })), { chatId: "sess-1", text: "t" });
  assert.deepEqual(parseInbound(JSON.stringify({ type: "chat", chatId: "sess-1", text: "t", audio: null })), { chatId: "sess-1", text: "t" });
});

check("companionMessage: with audio, the bubble carries it; without, the key is absent entirely", () => {
  assert.deepEqual(companionMessage("voiced", "1", { data: "QUJD", mimeType: "audio/ogg" }), { id: "1", author: "companion", text: "voiced", channel: "in-app", audio: { data: "QUJD", mimeType: "audio/ogg" } });
  const noAudio = companionMessage("plain", "2");
  assert.deepEqual(noAudio, { id: "2", author: "companion", text: "plain", channel: "in-app" });
  assert.equal("audio" in noAudio, false);
});

// ── historyMessage: the reload-persists seed (bug 0f01f234; UNIFIED CROSS-CHANNEL CHAT, card 7d63e200) —
// maps a stored row (now carrying its real channel + an optional voice-note flag) to a rendered bubble ───
check("historyMessage: a stored 'user' row becomes a 'you' bubble, carrying its channel", () => {
  assert.deepEqual(historyMessage({ id: "h1", author: "user", text: "typed earlier", channel: "in-app" }), { id: "h1", author: "you", text: "typed earlier", channel: "in-app" });
});
check("historyMessage: a stored 'companion' row becomes a 'companion' bubble", () => {
  assert.deepEqual(historyMessage({ id: "h2", author: "companion", text: "replied earlier", channel: "in-app" }), { id: "h2", author: "companion", text: "replied earlier", channel: "in-app" });
});
check("historyMessage: the row's own id is preserved as the bubble key (never re-derived)", () => {
  assert.equal(historyMessage({ id: "row-42", author: "user", text: "x", channel: "in-app" }).id, "row-42");
});
check("historyMessage: a Telegram row keeps its own channel (unified cross-channel chat, card 7d63e200)", () => {
  assert.deepEqual(
    historyMessage({ id: "h3", author: "user", text: "sent from my phone", channel: "telegram" }),
    { id: "h3", author: "you", text: "sent from my phone", channel: "telegram" },
  );
});
check("historyMessage: viaVoice:true tags the bubble with voice:true; absent/false omits it", () => {
  const voiced = historyMessage({ id: "h4", author: "user", text: "transcribed from a voice note", channel: "telegram", viaVoice: true });
  assert.deepEqual(voiced, { id: "h4", author: "you", text: "transcribed from a voice note", channel: "telegram", voice: true });
  const typed = historyMessage({ id: "h5", author: "user", text: "typed", channel: "telegram", viaVoice: false });
  assert.equal("voice" in typed, false, "a non-voice row never carries the voice key at all");
});

// ── isArmedInApp: the in-app route is detected among a companion's now-MULTIPLE bindings ──────────────
// Multi-channel (d23b4e32): a companion may hold an in-app AND a Telegram binding at once. "Armed" means it
// has a LIVE in-app route — a binding on the in-app channel whose chatId is the loopback self-address
// (chatId == the session id). A Telegram binding must NEITHER satisfy the check NOR mask a present in-app one.
check("isArmedInApp: true when an in-app binding (chatId == sessionId) is present among many", () => {
  const bindings = [
    { channel: "telegram", chatId: "999" },
    { channel: "in-app", chatId: "sess-1" },
  ];
  assert.equal(isArmedInApp(bindings, "sess-1"), true, "the in-app route is found even with a telegram binding alongside");
});

check("isArmedInApp: false when only a telegram binding exists (no in-app route)", () => {
  assert.equal(isArmedInApp([{ channel: "telegram", chatId: "999" }], "sess-1"), false);
  assert.equal(isArmedInApp([], "sess-1"), false, "no bindings → not armed");
});

check("isArmedInApp: an in-app binding whose chatId is NOT the session id does not arm (not the loopback self-address)", () => {
  assert.equal(isArmedInApp([{ channel: "in-app", chatId: "someone-else" }], "sess-1"), false);
});

console.log(`\n${pass} passed`);
