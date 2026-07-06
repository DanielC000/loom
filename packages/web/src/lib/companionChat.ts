// Loom Companion in-app chat — the pure, dependency-free transport + message logic behind the cockpit
// chat panel (components/CompanionChat). Extracted OUT of the React component so it can be unit-tested
// hermetically (test/companionChat.mjs imports THIS source via Node type-stripping and asserts on plain
// objects — the same pattern as lib/companion.ts / lib/diff.ts). No React, no WebSocket, no DOM.
//
// THE WIRE CONTRACT (daemon: gateway/server.ts `/ws/companion/:sessionId` + companion/in-app.ts):
//   • OUTBOUND (we send):  {"type":"chat","text":"…"}
//   • INBOUND  (we receive): {"type":"chat","chatId":"…","text":"…"} — chatId == the companion session id.
//   • Any frame that is not a well-formed {type:"chat"} is IGNORED (the same session also carries — on a
//     SEPARATE route — terminal control frames; a stray/garbage frame here must never render as a bubble).
//
// VOICE INBOUND (Companion Voice epic, VOICE-P4 inbound):
//   • OUTBOUND (we send):    {"type":"audio","data":"<base64>","mimeType":"…"} — a recorded mic clip.
//   • INBOUND  (we receive): {"type":"transcript","chatId":"…","text":"…"} — the daemon's live echo of OUR
//     OWN clip once STT completes (a genuine round trip: unlike typed text, the client can't know the
//     transcript ahead of time). Kept as a DISTINCT frame type from a companion reply — see parseTranscript.
//
// VOICE OUTBOUND (Companion Voice epic, VOICE-P4 outbound): a companion reply frame MAY carry an optional
// `audio` field — {"type":"chat","chatId":"…","text":"…","audio":{"data":"<base64>","mimeType":"…"}} —
// present only when `/voice on` is active for this DM route and synthesis succeeded. Always a Kokoro
// OGG/Opus clip; absent on every plain text reply (the overwhelming default).

// The in-app channel name — mirrors IN_APP_CHANNEL in the daemon's companion/in-app.ts. Used to decide
// whether a companion is reachable in-app (its binding must be on THIS channel to get a reply frame).
export const IN_APP_CHANNEL = "in-app";

// Whether a companion has a LIVE in-app route among its (now possibly MULTIPLE) bindings. The cockpit chat
// panel only receives a reply frame when a binding exists on THIS channel whose chatId is the loopback
// self-address (chatId == the session id). Multi-channel (d23b4e32): one companion may hold an in-app AND a
// Telegram binding at once, so the "armed" check must scan the WHOLE binding list, not a single binding —
// a Telegram binding must never mask (or be mistaken for) the in-app one. Pure — hermetically unit-tested.
export function isArmedInApp(
  bindings: { channel: string; chatId: string }[],
  sessionId: string,
): boolean {
  return bindings.some((b) => b.channel === IN_APP_CHANNEL && b.chatId === sessionId);
}

// One rendered chat line. `author` drives the bubble side + tone; `id` is a per-panel-unique key (a
// monotonic counter in the component — never re-used, so React keys stay stable as the list grows).
export type ChatAuthor = "you" | "companion";
export interface ChatMessage {
  id: string;
  author: ChatAuthor;
  text: string;
  /** Provenance for the unified cross-channel chat (card 7d63e200) — which channel this turn happened on.
   *  Every LIVE message (this WS is in-app-only by construction) is `IN_APP_CHANNEL`; a history-seeded row
   *  (historyMessage) carries its own real channel (e.g. "telegram"), so a reload surfaces a per-bubble
   *  provenance badge for anything that didn't happen in this web panel. */
  channel: string;
  /** True only for a history-seeded row whose text is itself a voice-note STT transcript (e.g. a Telegram
   *  voice message) — the panel renders a small mic indicator alongside it. Never set on a live message. */
  voice?: boolean;
  /** Present only on a voiced companion reply (Companion Voice epic, VOICE-P4 outbound) — never persisted,
   *  never on a "you"/history bubble (audio is live-transport-only; text is what's stored/shown). */
  audio?: InboundAudio;
}

// Validate + frame an outbound send. Returns null for an empty/whitespace-only draft (nothing to send —
// mirrors the daemon's empty-body guard in normalizeInAppMessage, so we never emit a frame the gateway
// would just drop). On success: the trimmed display `text` (what the "you" bubble shows) plus the exact
// `frame` string to socket.send(). ONE function so the wire text and the rendered text can never diverge.
export function prepareSend(draft: string): { text: string; frame: string } | null {
  const text = draft.trim();
  if (!text) return null;
  return { text, frame: JSON.stringify({ type: "chat", text }) };
}

// Frame a recorded mic clip for the wire (Companion Voice epic, VOICE-P4 inbound). `base64` is the clip's
// raw bytes already base64-encoded by the caller (DOM/FileReader work — kept out of this pure module);
// `mimeType` is the browser's own MediaRecorder mimeType (e.g. "audio/webm;codecs=opus"), passed through
// verbatim so the daemon can pick a sensible temp-file extension. No client-side size/format validation
// here — the daemon is the single source of truth for the size cap (mirrors decodeInAppAudioToTempFile).
export function prepareSendAudio(base64: string, mimeType: string): string {
  return JSON.stringify({ type: "audio", data: base64, mimeType });
}

// Base64-encoded audio carried on a voiced companion reply (Companion Voice epic, VOICE-P4 outbound).
export interface InboundAudio {
  data: string;
  mimeType: string;
}

// Validate the optional `audio` field on a {type:"chat"} frame — both `data` and `mimeType` must be
// non-empty strings, else the field is DROPPED (never a half-shaped audio object reaches the player; the
// reply still renders as plain text, exactly as if synthesis hadn't been attempted).
function parseInboundAudio(raw: unknown): InboundAudio | null {
  if (typeof raw !== "object" || raw === null) return null;
  const a = raw as { data?: unknown; mimeType?: unknown };
  if (typeof a.data !== "string" || a.data.length === 0 || typeof a.mimeType !== "string" || a.mimeType.length === 0) return null;
  return { data: a.data, mimeType: a.mimeType };
}

// Parse an inbound WS frame. Returns the companion reply { chatId, text, audio? } ONLY for a well-formed
// {type:"chat"} frame (`audio` present only when the reply was voiced — VOICE-P4 outbound); returns null
// for malformed JSON, a non-object, or any non-chat frame (which the panel silently ignores). Defensive by
// construction — the socket payload is untrusted transport data.
export function parseInbound(raw: string): { chatId: string; text: string; audio?: InboundAudio } | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as { type?: unknown; chatId?: unknown; text?: unknown; audio?: unknown };
  if (m.type !== "chat" || typeof m.text !== "string") return null;
  const chatId = typeof m.chatId === "string" ? m.chatId : "";
  const audio = parseInboundAudio(m.audio);
  return audio ? { chatId, text: m.text, audio } : { chatId, text: m.text };
}

// Parse an inbound {type:"transcript"} frame (Companion Voice epic, VOICE-P4 inbound) — the daemon's live
// echo of YOUR OWN web-mic recording once STT completes. A typed message never needs this (the panel
// already knows what it sent and renders it locally without waiting on the server); a recorded clip does,
// since the transcript is only known server-side. Returns { chatId, text } only for a well-formed
// {type:"transcript"} frame; null for anything else (malformed, or any other frame type — incl. a
// companion reply, which parseInbound handles instead).
export function parseTranscript(raw: string): { chatId: string; text: string } | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as { type?: unknown; chatId?: unknown; text?: unknown };
  if (m.type !== "transcript" || typeof m.text !== "string") return null;
  return { chatId: typeof m.chatId === "string" ? m.chatId : "", text: m.text };
}

// Parse an inbound {type:"cleared"} frame — the "/new"/"/reset" slash command (daemon: companion/commands.ts
// + chat-gateway.ts's resetConversation). The daemon has already cleared the durable history by the time
// this arrives; the panel's only job is to empty its own live transcript so the reset is visible immediately
// instead of waiting for the next reload. Returns { chatId } for a well-formed frame, else null.
export function parseCleared(raw: string): { chatId: string } | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as { type?: unknown; chatId?: unknown };
  if (m.type !== "cleared") return null;
  return { chatId: typeof m.chatId === "string" ? m.chatId : "" };
}

// Build a "you" (local) bubble from a prepared send. Split out so the send path is one testable step. This
// WS is in-app-only by construction, so every live message is tagged IN_APP_CHANNEL.
export function youMessage(text: string, id: string): ChatMessage {
  return { id, author: "you", text, channel: IN_APP_CHANNEL };
}

// Build a "companion" (remote) bubble from a parsed inbound reply. `audio` (VOICE-P4 outbound) is present
// only for a voiced reply — omitted from the returned object when absent (never `audio: undefined`).
export function companionMessage(text: string, id: string, audio?: InboundAudio): ChatMessage {
  return audio ? { id, author: "companion", text, channel: IN_APP_CHANNEL, audio } : { id, author: "companion", text, channel: IN_APP_CHANNEL };
}

// The panel's connection lifecycle — drives the status pill + whether Send is enabled. `reconnecting`
// is the transient gap between a drop and the next open (auto-reconnect), distinct from a never-yet-open
// `connecting` so the pill copy can differ ("connecting" vs "reconnecting").
export type ChatConnState = "connecting" | "connected" | "reconnecting";

// ── Chat HISTORY seed (bug 0f01f234 — the "reload loses the whole conversation" fix; UNIFIED
// CROSS-CHANNEL CHAT, card 7d63e200 — every channel, not just in-app) ──────────────────────────────────
// One row as served by GET /api/companion/messages/:sessionId (daemon: db.ts CompanionMessage, minus the
// session/chatId/createdAt columns the panel doesn't render).
export interface CompanionHistoryRow {
  id: string;
  author: "user" | "companion";
  text: string;
  channel: string;
  viaVoice?: boolean;
}

// Map ONE stored row to a rendered bubble — the daemon's "user"/"companion" author maps to this panel's
// "you"/"companion" ChatAuthor (mirrors youMessage/companionMessage's author values). The component fetches
// history BEFORE opening the WebSocket (load-then-connect), so there is no live frame that could arrive
// before this seed — no separate dedup step is needed here, just the correct author mapping. `channel`
// carries the row's real provenance (e.g. "telegram") so the panel can badge a non-in-app bubble; `voice`
// is set only when the row is a voice-note transcript (card 7d63e200).
export function historyMessage(row: CompanionHistoryRow): ChatMessage {
  const base: ChatMessage = { id: row.id, author: row.author === "user" ? "you" : "companion", text: row.text, channel: row.channel };
  return row.viaVoice ? { ...base, voice: true } : base;
}
