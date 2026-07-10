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
//
// CROSS-CHANNEL LIVE PUSH (live-push card, closing a unified cross-channel chat gap, card 7d63e200):
//   • INBOUND (we receive): {"type":"cross-channel","chatId":"…","id":"…","channel":"telegram","author":
//     "user"|"companion","text":"…","viaVoice":bool} — a turn that happened on a NON-in-app channel (e.g.
//     Telegram), pushed the moment the daemon persists it. `id` is the companion_messages row id — the
//     SAME id a later history reload (GET /api/companion/messages/:sessionId) returns for this row, so the
//     panel can dedup a live-pushed row against its own reload instead of rendering it twice.
//
// MEDIA-OUT IN-APP DELIVERY (the `media-out` lever's in-app fast-follow, card 9ec79b52):
//   • INBOUND (we receive): {"type":"media","chatId":"…","data":"<base64>","mimeType":"…","fileName":"…"} —
//     a file the companion delivered via `send_media` (a mockup, a screenshot, …). Base64-inlined (mirrors
//     the VOICE-P4 outbound `audio` field) since the in-app transport has no separate file-serving route.
//     NEVER persisted to chat history (mirrors the daemon's own `ChatGateway.deliverMedia` doc) — a reload
//     will not show it again; it exists only for this live session.

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
  /** ISO timestamp for this turn — a history-seeded row carries the stored `createdAt`; a LIVE message is
   *  stamped at send/receive by the panel. Drives the day dividers, per-group timestamps, and grouping-gap
   *  in {@link buildTimeline}. Optional so an un-stamped message still renders (it just never anchors a day
   *  divider or a per-group time) and so the pure builders stay byte-identical when no timestamp is passed. */
  ts?: string;
  /** True only for a history-seeded row whose text is itself a voice-note STT transcript (e.g. a Telegram
   *  voice message) — the panel renders a small mic indicator alongside it. Never set on a live message. */
  voice?: boolean;
  /** Present only on a voiced companion reply (Companion Voice epic, VOICE-P4 outbound) — never persisted,
   *  never on a "you"/history bubble (audio is live-transport-only; text is what's stored/shown). */
  audio?: InboundAudio;
  /** Present only on a `send_media` delivery (the `media-out` lever's in-app fast-follow, card 9ec79b52) —
   *  never persisted, never on a "you"/history bubble (media is live-transport-only, exactly like `audio`). */
  media?: InboundMedia;
  /** A non-bubble timeline SENTINEL rather than a real turn. `"reset"` marks a "/new" conversation boundary
   *  (see {@link resetMarker}) so the panel draws an inline reset divider where the conversation was reset,
   *  instead of silently emptying. {@link buildTimeline} routes a marker to its own timeline item and never a
   *  chat bubble. */
  marker?: "reset";
  /** A proactive / unsolicited companion turn (a heartbeat, a fired reminder, an attention-push alert) —
   *  rendered as a distinct amber EVENT LINE, not a chat bubble (see {@link buildTimeline}'s `event` item).
   *  NOTE: no live producer sets this yet — a proactive reply currently reaches the in-app panel as an
   *  ordinary `{type:"chat"}` frame the daemon does NOT tag (companion/in-app.ts). Wiring it needs a small
   *  daemon change to mark a proactive-origin reply on the frame + history row; the render + grouping path
   *  here is complete and unit-tested against that flag ahead of it. */
  proactive?: boolean;
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

// Parse an inbound {type:"cross-channel"} frame (live-push card) — a turn that happened on a NON-in-app
// channel (e.g. Telegram), pushed live the moment the daemon persists it. Returns null for malformed JSON,
// a non-object, a non-cross-channel frame, or a malformed shape (missing/wrong-typed id/channel/text/
// author) — defensive by construction, like every other frame parser here.
export function parseCrossChannel(
  raw: string,
): { chatId: string; id: string; channel: string; author: "user" | "companion"; text: string; viaVoice: boolean } | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as { type?: unknown; chatId?: unknown; id?: unknown; channel?: unknown; author?: unknown; text?: unknown; viaVoice?: unknown };
  if (m.type !== "cross-channel" || typeof m.id !== "string" || typeof m.channel !== "string" || typeof m.text !== "string") return null;
  if (m.author !== "user" && m.author !== "companion") return null;
  return { chatId: typeof m.chatId === "string" ? m.chatId : "", id: m.id, channel: m.channel, author: m.author, text: m.text, viaVoice: m.viaVoice === true };
}

// Build a "you" (local) bubble from a prepared send. Split out so the send path is one testable step. This
// WS is in-app-only by construction, so every live message is tagged IN_APP_CHANNEL. `ts` (the panel's
// send-time stamp) is attached only when passed, so an un-stamped call stays byte-identical.
export function youMessage(text: string, id: string, ts?: string): ChatMessage {
  const m: ChatMessage = { id, author: "you", text, channel: IN_APP_CHANNEL };
  if (ts) m.ts = ts;
  return m;
}

// Build a "companion" (remote) bubble from a parsed inbound reply. `audio` (VOICE-P4 outbound) is present
// only for a voiced reply, `ts` only when the panel stamps it — each omitted from the returned object when
// absent (never `audio: undefined` / `ts: undefined`).
export function companionMessage(text: string, id: string, audio?: InboundAudio, ts?: string): ChatMessage {
  const m: ChatMessage = { id, author: "companion", text, channel: IN_APP_CHANNEL };
  if (audio) m.audio = audio;
  if (ts) m.ts = ts;
  return m;
}

// Build a non-bubble RESET sentinel (a "/new"/"/reset" conversation boundary) for the live transcript, so
// the panel draws an inline reset divider where the conversation was reset instead of silently emptying.
// `buildTimeline` routes `marker:"reset"` to its own timeline item; the empty text never renders as a bubble.
export function resetMarker(id: string, ts?: string): ChatMessage {
  const m: ChatMessage = { id, author: "companion", text: "", channel: IN_APP_CHANNEL, marker: "reset" };
  if (ts) m.ts = ts;
  return m;
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
  /** The stored `createdAt` (ISO) — the daemon serves the full CompanionMessage row (db.ts), so this is on
   *  the wire; the panel threads it onto the bubble's `ts` for the day dividers + per-group timestamps.
   *  Optional so a row without it still renders (older/partial seeds), just without a time anchor. */
  createdAt?: string;
}

// Map ONE stored row to a rendered bubble — the daemon's "user"/"companion" author maps to this panel's
// "you"/"companion" ChatAuthor (mirrors youMessage/companionMessage's author values). The component fetches
// history BEFORE opening the WebSocket (load-then-connect), so there is no live frame that could arrive
// before this seed — no separate dedup step is needed here, just the correct author mapping. `channel`
// carries the row's real provenance (e.g. "telegram") so the panel can badge a non-in-app bubble; `voice`
// is set only when the row is a voice-note transcript (card 7d63e200).
export function historyMessage(row: CompanionHistoryRow): ChatMessage {
  const m: ChatMessage = { id: row.id, author: row.author === "user" ? "you" : "companion", text: row.text, channel: row.channel };
  if (row.viaVoice) m.voice = true;
  if (row.createdAt) m.ts = row.createdAt;
  return m;
}

// A file delivered via `send_media` (the `media-out` lever's in-app fast-follow, card 9ec79b52) — base64
// bytes + enough metadata for the panel to decide image-inline vs. attachment-card rendering.
export interface InboundMedia {
  data: string;
  mimeType: string;
  fileName: string;
}

// Parse an inbound {type:"media"} frame. Returns null for malformed JSON, a non-object, a non-media frame,
// or a malformed shape (missing/empty/wrong-typed data/mimeType/fileName) — defensive by construction, like
// every other frame parser here.
export function parseMedia(raw: string): { chatId: string; data: string; mimeType: string; fileName: string } | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as { type?: unknown; chatId?: unknown; data?: unknown; mimeType?: unknown; fileName?: unknown };
  if (m.type !== "media" || typeof m.data !== "string" || m.data.length === 0) return null;
  if (typeof m.mimeType !== "string" || typeof m.fileName !== "string" || m.fileName.length === 0) return null;
  return { chatId: typeof m.chatId === "string" ? m.chatId : "", data: m.data, mimeType: m.mimeType, fileName: m.fileName };
}

// Build a "companion" bubble from a parsed {type:"media"} delivery — no text (the file IS the message,
// mirrors a voice-only reply having empty accompanying prose in practice, though `audio` always rides
// alongside reply text; media never does).
export function mediaMessage(media: InboundMedia, id: string, ts?: string): ChatMessage {
  const m: ChatMessage = { id, author: "companion", text: "", channel: IN_APP_CHANNEL, media };
  if (ts) m.ts = ts;
  return m;
}

// Build a rendered bubble from a parsed {type:"cross-channel"} live push (live-push card) — the SAME shape
// historyMessage produces (down to using the row's own persisted `id` as the ChatMessage id, never a local
// counter), so a live-pushed row and the same row's later history-reload are structurally identical and can
// be deduped by id alone: the panel drops one when it already holds a message with that id (see
// CompanionChat's ws handler).
export function crossChannelMessage(msg: { id: string; channel: string; author: "user" | "companion"; text: string; viaVoice: boolean }, ts?: string): ChatMessage {
  const m: ChatMessage = { id: msg.id, author: msg.author === "user" ? "you" : "companion", text: msg.text, channel: msg.channel };
  if (msg.viaVoice) m.voice = true;
  if (ts) m.ts = ts;
  return m;
}

// ══ Timeline assembly (the "real chat" structure) ════════════════════════════════════════════════════
// Turn a flat `ChatMessage[]` into a structured timeline the panel renders — the anti-"endless wall"
// mechanics live HERE, in one pure, unit-tested function, so the component stays a thin view over it:
//   • DAY DIVIDERS   — a divider before the first message of each calendar day.
//   • GROUPING       — a run of same-author + same-channel messages within GROUP_GAP_MS collapses under ONE
//                      header (name + time); only the group's LAST bubble shows the delivery/channel meta.
//   • RESET MARKERS  — a `marker:"reset"` sentinel becomes an inline "/new" boundary (and breaks a run).
//   • EVENT LINES    — a `proactive:true` turn becomes an amber event line, never a bubble (and breaks a run).
//   • DELIVERY STATE — a "you" group-end bubble is "delivered" when a later turn proves the round trip, else
//                      "sent" (it's on the wire, no reply yet). Honest: no fabricated read-receipt.

/** Max gap between two same-author + same-channel messages for them to still GROUP under one header. Beyond
 *  it a fresh header (name + time) is drawn even for the same sender — mirrors how mainstream chats re-stamp
 *  a sender after a lull. */
export const GROUP_GAP_MS = 5 * 60 * 1000;

export type TimelineItem =
  | { kind: "day"; id: string; label: string }
  | { kind: "reset"; id: string }
  | { kind: "event"; id: string; msg: ChatMessage; time: string }
  | {
      kind: "message";
      id: string;
      msg: ChatMessage;
      /** Continues the previous same-sender run — the view suppresses the avatar + header. */
      grouped: boolean;
      /** Last message of its run — the view shows the delivery/channel meta + the bubble "tail" corner. */
      groupEnd: boolean;
      /** Formatted clock time for the group header (empty when the message carries no timestamp). */
      time: string;
      /** For a "you" group-end bubble only: whether a later turn proves the round trip. */
      delivery?: "sent" | "delivered";
    };

/** Local calendar-day key for a timestamp (never a UTC key — dividers must match the viewer's own day
 *  boundaries), or null when there's no/an unparseable timestamp. */
function dayKeyOf(ts?: string): string | null {
  if (!ts) return null;
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

/** Epoch ms for a timestamp, or null when absent/unparseable (an un-stamped message never groups by gap). */
function tsMs(ts?: string): number | null {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  return Number.isNaN(t) ? null : t;
}

/** A per-group clock time, e.g. "9:14 AM" — locale/timezone of the viewer. Empty for a missing/bad stamp. */
export function formatTime(ts?: string): string {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** A day-divider label relative to `now`: "Today" / "Yesterday" / a short weekday+date this year / a full
 *  date otherwise. Relative labels are computed from local day boundaries so they're timezone-honest. */
export function formatDayLabel(ts: string, now: Date = new Date()): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const key = (x: Date) => `${x.getFullYear()}-${x.getMonth()}-${x.getDate()}`;
  if (key(d) === key(now)) return "Today";
  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (key(d) === key(yesterday)) return "Yesterday";
  return d.toLocaleDateString(
    undefined,
    d.getFullYear() === now.getFullYear()
      ? { weekday: "short", month: "short", day: "numeric" }
      : { year: "numeric", month: "short", day: "numeric" },
  );
}

/**
 * Assemble the rendered timeline from a flat message list. Pure + deterministic given `now` (defaulted for
 * the live panel; injected by the unit test) — the single source of truth for day dividers, consecutive-
 * sender grouping, reset boundaries, proactive event lines, and the honest sent/delivered state.
 */
export function buildTimeline(messages: ChatMessage[], now: Date = new Date()): TimelineItem[] {
  const items: TimelineItem[] = [];
  let lastDayKey: string | null = null;
  // The previous emitted plain-message run head, for grouping — cleared by any divider / reset / event.
  let prev: { author: ChatAuthor; channel: string; dayKey: string | null; ms: number | null; itemIndex: number } | null = null;

  for (const msg of messages) {
    const dk = dayKeyOf(msg.ts);
    // A day divider before the first DATED item of a new calendar day (an un-stamped item never anchors one).
    if (dk && dk !== lastDayKey) {
      items.push({ kind: "day", id: `day-${dk}-${msg.id}`, label: formatDayLabel(msg.ts as string, now) });
      lastDayKey = dk;
      prev = null; // a divider breaks a group run
    }

    if (msg.marker === "reset") {
      items.push({ kind: "reset", id: `reset-${msg.id}` });
      prev = null;
      continue;
    }
    if (msg.proactive) {
      items.push({ kind: "event", id: msg.id, msg, time: formatTime(msg.ts) });
      prev = null;
      continue;
    }

    const ms = tsMs(msg.ts);
    const grouped: boolean =
      prev !== null &&
      prev.author === msg.author &&
      prev.channel === msg.channel &&
      prev.dayKey === dk &&
      ms !== null &&
      prev.ms !== null &&
      ms - prev.ms <= GROUP_GAP_MS;

    const itemIndex: number = items.push({ kind: "message", id: msg.id, msg, grouped, groupEnd: true, time: formatTime(msg.ts) }) - 1;
    // Continuing a run demotes the previous head from group-end (only the LAST bubble carries the tail/meta).
    if (grouped && prev) {
      const p = items[prev.itemIndex];
      if (p && p.kind === "message") p.groupEnd = false;
    }
    prev = { author: msg.author, channel: msg.channel, dayKey: dk, ms, itemIndex };
  }

  // Delivery state (honest, position-derived — no fabricated read-receipt): a "you" group-end bubble is
  // "delivered" once ANY later timeline item exists (the conversation moved on ⇒ the turn landed), else it's
  // the trailing turn and shows "sent" (on the wire, no reply yet).
  const lastIndex = items.length - 1;
  items.forEach((it, i) => {
    if (it.kind === "message" && it.groupEnd && it.msg.author === "you") {
      it.delivery = i < lastIndex ? "delivered" : "sent";
    }
  });
  return items;
}
