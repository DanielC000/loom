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
  GROUP_GAP_MS, IN_APP_CHANNEL, buildTimeline, companionMessage, crossChannelMessage, formatDayLabel, formatTime,
  historyMessage, isArmedInApp, mediaMessage, parseCrossChannel, parseInbound, parseMedia, parseTranscript,
  prepareSend, prepareSendAudio, resetMarker, youMessage,
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

// ── parseCrossChannel / crossChannelMessage: the live-push card's NON-in-app-channel live frame ─────────
check("parseCrossChannel: a well-formed frame parses every field, including viaVoice/proactive defaulting to false", () => {
  assert.deepEqual(
    parseCrossChannel(JSON.stringify({ type: "cross-channel", chatId: "sess-1", id: "row-9", channel: "telegram", author: "user", text: "hi" })),
    { chatId: "sess-1", id: "row-9", channel: "telegram", author: "user", text: "hi", viaVoice: false, proactive: false },
  );
});
check("parseCrossChannel: viaVoice:true is preserved", () => {
  const parsed = parseCrossChannel(JSON.stringify({ type: "cross-channel", chatId: "s", id: "r1", channel: "telegram", author: "user", text: "a voice note transcript", viaVoice: true }));
  assert.equal(parsed.viaVoice, true);
});
check("parseCrossChannel: proactive:true is preserved (a heartbeat/reminder/attention-push-tagged Telegram reply)", () => {
  const parsed = parseCrossChannel(JSON.stringify({ type: "cross-channel", chatId: "s", id: "r1b", channel: "telegram", author: "companion", text: "proactive check-in", proactive: true }));
  assert.equal(parsed.proactive, true);
});
check("parseCrossChannel: a companion-authored frame parses too", () => {
  const parsed = parseCrossChannel(JSON.stringify({ type: "cross-channel", chatId: "s", id: "r2", channel: "telegram", author: "companion", text: "reply" }));
  assert.equal(parsed.author, "companion");
});
check("parseCrossChannel: any other frame type / malformed shape returns null (never rendered)", () => {
  assert.equal(parseCrossChannel(JSON.stringify({ type: "chat", chatId: "s", text: "t" })), null, "a plain chat frame is not a cross-channel frame");
  assert.equal(parseCrossChannel(JSON.stringify({ type: "cross-channel", chatId: "s", channel: "telegram", author: "user", text: "t" })), null, "missing id");
  assert.equal(parseCrossChannel(JSON.stringify({ type: "cross-channel", chatId: "s", id: "r", author: "user", text: "t" })), null, "missing channel");
  assert.equal(parseCrossChannel(JSON.stringify({ type: "cross-channel", chatId: "s", id: "r", channel: "telegram", author: "nobody", text: "t" })), null, "bogus author");
  assert.equal(parseCrossChannel("not json"), null);
  assert.equal(parseCrossChannel(JSON.stringify(null)), null);
});
check("crossChannelMessage: maps to the SAME shape historyMessage would for an equivalent row (same id, dedupable)", () => {
  const live = crossChannelMessage({ id: "row-9", channel: "telegram", author: "user", text: "sent from my phone", viaVoice: false });
  const seeded = historyMessage({ id: "row-9", author: "user", text: "sent from my phone", channel: "telegram", viaVoice: false });
  assert.deepEqual(live, seeded, "a live-pushed row and its later history-reload produce an IDENTICAL ChatMessage, keyed on the same id");
});
check("crossChannelMessage: viaVoice:true tags the bubble voice:true; a companion author maps to the companion bubble", () => {
  assert.deepEqual(
    crossChannelMessage({ id: "r1", channel: "telegram", author: "user", text: "a voice note transcript", viaVoice: true }),
    { id: "r1", author: "you", text: "a voice note transcript", channel: "telegram", voice: true },
  );
  assert.deepEqual(
    crossChannelMessage({ id: "r2", channel: "telegram", author: "companion", text: "reply", viaVoice: false }),
    { id: "r2", author: "companion", text: "reply", channel: "telegram" },
  );
});

// ── parseMedia / mediaMessage: the `media-out` lever's in-app delivery (card 9ec79b52) ──────────────────
check("parseMedia: a well-formed {type:\"media\"} frame parses every field", () => {
  assert.deepEqual(
    parseMedia(JSON.stringify({ type: "media", chatId: "sess-1", data: "QUJD", mimeType: "image/png", fileName: "mockup.png" })),
    { chatId: "sess-1", data: "QUJD", mimeType: "image/png", fileName: "mockup.png" },
  );
});
check("parseMedia: a missing chatId defaults to \"\"", () => {
  const parsed = parseMedia(JSON.stringify({ type: "media", data: "QUJD", mimeType: "application/pdf", fileName: "report.pdf" }));
  assert.equal(parsed.chatId, "");
});
check("parseMedia: any other frame type / malformed shape returns null (never rendered)", () => {
  assert.equal(parseMedia(JSON.stringify({ type: "chat", chatId: "s", text: "t" })), null, "a plain chat frame is not a media frame");
  assert.equal(parseMedia(JSON.stringify({ type: "media", chatId: "s", mimeType: "image/png", fileName: "x.png" })), null, "missing data");
  assert.equal(parseMedia(JSON.stringify({ type: "media", chatId: "s", data: "", mimeType: "image/png", fileName: "x.png" })), null, "empty data");
  assert.equal(parseMedia(JSON.stringify({ type: "media", chatId: "s", data: "QUJD", fileName: "x.png" })), null, "missing mimeType");
  assert.equal(parseMedia(JSON.stringify({ type: "media", chatId: "s", data: "QUJD", mimeType: "image/png" })), null, "missing fileName");
  assert.equal(parseMedia(JSON.stringify({ type: "media", chatId: "s", data: "QUJD", mimeType: "image/png", fileName: "" })), null, "empty fileName");
  assert.equal(parseMedia("not json {"), null);
  assert.equal(parseMedia(JSON.stringify(null)), null);
});
check("parseInbound never mistakes a media frame for a companion text reply (the two frame types are disjoint)", () => {
  assert.equal(parseInbound(JSON.stringify({ type: "media", chatId: "s", data: "QUJD", mimeType: "image/png", fileName: "x.png" })), null);
});
check("mediaMessage: builds a companion bubble with empty text, carrying the media payload", () => {
  const media = { data: "QUJD", mimeType: "image/png", fileName: "mockup.png" };
  assert.deepEqual(mediaMessage(media, "1"), { id: "1", author: "companion", text: "", channel: "in-app", media });
});

// ── Timestamp threading: the "real chat" rebuild (card bbd1ced9) — every builder attaches `ts` ONLY when
// passed, so an un-stamped call stays byte-identical while a stamped live/history turn carries a time. ─────
check("youMessage / companionMessage / mediaMessage / crossChannelMessage: a passed ts is attached; omitted otherwise", () => {
  assert.equal("ts" in youMessage("m", "1"), false, "no ts arg → no ts key");
  assert.equal(youMessage("m", "1", "2026-07-10T09:00:00.000Z").ts, "2026-07-10T09:00:00.000Z");
  assert.equal(companionMessage("m", "2", undefined, "2026-07-10T09:01:00.000Z").ts, "2026-07-10T09:01:00.000Z");
  // audio + ts coexist, and the plain reply still carries neither key.
  const voiced = companionMessage("v", "3", { data: "QUJD", mimeType: "audio/ogg" }, "2026-07-10T09:02:00.000Z");
  assert.deepEqual(voiced, { id: "3", author: "companion", text: "v", channel: "in-app", audio: { data: "QUJD", mimeType: "audio/ogg" }, ts: "2026-07-10T09:02:00.000Z" });
  assert.equal(mediaMessage({ data: "QUJD", mimeType: "image/png", fileName: "x.png" }, "4", "2026-07-10T09:03:00.000Z").ts, "2026-07-10T09:03:00.000Z");
  assert.equal(crossChannelMessage({ id: "5", channel: "telegram", author: "user", text: "t", viaVoice: false }, "2026-07-10T09:04:00.000Z").ts, "2026-07-10T09:04:00.000Z");
});

check("historyMessage: the row's stored createdAt threads onto the bubble's ts; absent → no ts key", () => {
  assert.equal(historyMessage({ id: "h1", author: "user", text: "x", channel: "in-app", createdAt: "2026-07-10T09:00:00.000Z" }).ts, "2026-07-10T09:00:00.000Z");
  assert.equal("ts" in historyMessage({ id: "h2", author: "user", text: "x", channel: "in-app" }), false);
});

check("resetMarker: a non-bubble '/new' sentinel carrying marker:'reset' (empty text, never a bubble)", () => {
  assert.deepEqual(resetMarker("r1"), { id: "r1", author: "companion", text: "", channel: "in-app", marker: "reset" });
  assert.equal(resetMarker("r2", "2026-07-10T09:00:00.000Z").ts, "2026-07-10T09:00:00.000Z");
});

// ── buildTimeline: the anti-"endless wall" structure — day dividers, consecutive-sender grouping, per-group
// timestamps, reset markers, proactive event lines, and the honest sent/delivered state. Deterministic given
// an injected `now`; timestamps are built from LOCAL Date parts so the Today/Yesterday labels are TZ-stable. ─
const NOW = new Date(2026, 6, 10, 15, 0, 0); // local noon-ish on 2026-07-10 — stable day boundaries
const at = (h, m = 0) => new Date(2026, 6, 10, h, m, 0).toISOString(); // Today
const atY = (h, m = 0) => new Date(2026, 6, 9, h, m, 0).toISOString(); // Yesterday
const kinds = (items) => items.map((i) => i.kind);

check("buildTimeline: a single dated message yields a day divider then the message", () => {
  const items = buildTimeline([companionMessage("hi", "1", undefined, at(10))], NOW);
  assert.deepEqual(kinds(items), ["day", "message"]);
  assert.equal(items[0].label, "Today");
  assert.equal(items[1].grouped, false);
  assert.equal(items[1].groupEnd, true);
});

check("buildTimeline: consecutive same-author+channel messages within the gap GROUP under one header", () => {
  const items = buildTimeline([
    companionMessage("first", "1", undefined, at(10, 0)),
    companionMessage("second", "2", undefined, at(10, 2)), // 2 min later, < GROUP_GAP_MS
  ], NOW);
  assert.deepEqual(kinds(items), ["day", "message", "message"]);
  assert.equal(items[1].grouped, false, "run head is not grouped");
  assert.equal(items[1].groupEnd, false, "run head is demoted from group-end once the run continues");
  assert.equal(items[2].grouped, true, "the continuation is grouped");
  assert.equal(items[2].groupEnd, true, "the last of the run is the group-end");
});

check("buildTimeline: an author change breaks the group", () => {
  const items = buildTimeline([
    companionMessage("theirs", "1", undefined, at(10, 0)),
    youMessage("mine", "2", at(10, 1)),
  ], NOW);
  assert.equal(items[2].grouped, false);
});

check("buildTimeline: a channel change breaks the group (same author, different channel)", () => {
  const items = buildTimeline([
    youMessage("in-app turn", "1", at(10, 0)),
    crossChannelMessage({ id: "2", channel: "telegram", author: "user", text: "phone turn", viaVoice: false }, at(10, 1)),
  ], NOW);
  assert.equal(items[2].grouped, false, "a telegram turn never groups with an in-app one");
});

check("buildTimeline: a gap beyond GROUP_GAP_MS breaks the group even for the same sender", () => {
  const gapMin = GROUP_GAP_MS / 60000 + 1;
  const items = buildTimeline([
    companionMessage("early", "1", undefined, at(10, 0)),
    companionMessage("much later", "2", undefined, at(10, gapMin)),
  ], NOW);
  assert.equal(items[2].grouped, false);
});

check("buildTimeline: messages spanning two days get a divider per day, labelled relative to now", () => {
  const items = buildTimeline([
    companionMessage("yesterday", "1", undefined, atY(9)),
    companionMessage("today", "2", undefined, at(10)),
  ], NOW);
  assert.deepEqual(kinds(items), ["day", "message", "day", "message"]);
  assert.equal(items[0].label, "Yesterday");
  assert.equal(items[2].label, "Today");
});

check("buildTimeline: a reset marker becomes a reset item and breaks grouping across it", () => {
  const items = buildTimeline([
    companionMessage("before", "1", undefined, at(10, 0)),
    resetMarker("r", at(10, 1)),
    companionMessage("after", "2", undefined, at(10, 2)),
  ], NOW);
  assert.deepEqual(kinds(items), ["day", "message", "reset", "message"]);
  assert.equal(items[3].grouped, false, "the message after a reset never groups with the one before it");
});

check("buildTimeline: a proactive turn becomes an amber EVENT item (never a bubble) and breaks grouping", () => {
  const proactive = { ...companionMessage("heartbeat check-in", "1", undefined, at(10, 0)), proactive: true };
  const items = buildTimeline([proactive, companionMessage("normal reply", "2", undefined, at(10, 1))], NOW);
  assert.deepEqual(kinds(items), ["day", "event", "message"]);
  assert.equal(items[1].time, formatTime(at(10, 0)), "the event line carries its formatted time");
  assert.equal(items[2].grouped, false, "a normal reply after an event line is not grouped into it");
});

check("buildTimeline: delivery state is honest — a trailing 'you' turn is 'sent'; one a reply follows is 'delivered'", () => {
  const trailing = buildTimeline([youMessage("no reply yet", "1", at(10, 0))], NOW);
  assert.equal(trailing[1].delivery, "sent");
  const answered = buildTimeline([
    youMessage("question", "1", at(10, 0)),
    companionMessage("answer", "2", undefined, at(10, 1)),
  ], NOW);
  assert.equal(answered[1].delivery, "delivered", "a later turn proves the round trip");
  assert.equal(answered[2].delivery, undefined, "a companion bubble carries no delivery state");
});

check("formatDayLabel: Today / Yesterday are computed relative to now", () => {
  assert.equal(formatDayLabel(at(9), NOW), "Today");
  assert.equal(formatDayLabel(atY(9), NOW), "Yesterday");
});

console.log(`\n${pass} passed`);
