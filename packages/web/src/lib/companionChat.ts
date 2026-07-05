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

// Parse an inbound WS frame. Returns the companion reply { chatId, text } ONLY for a well-formed
// {type:"chat"} frame; returns null for malformed JSON, a non-object, or any non-chat frame (which the
// panel silently ignores). Defensive by construction — the socket payload is untrusted transport data.
export function parseInbound(raw: string): { chatId: string; text: string } | null {
  let msg: unknown;
  try {
    msg = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof msg !== "object" || msg === null) return null;
  const m = msg as { type?: unknown; chatId?: unknown; text?: unknown };
  if (m.type !== "chat" || typeof m.text !== "string") return null;
  return { chatId: typeof m.chatId === "string" ? m.chatId : "", text: m.text };
}

// Build a "you" (local) bubble from a prepared send. Split out so the send path is one testable step.
export function youMessage(text: string, id: string): ChatMessage {
  return { id, author: "you", text };
}

// Build a "companion" (remote) bubble from a parsed inbound reply.
export function companionMessage(text: string, id: string): ChatMessage {
  return { id, author: "companion", text };
}

// The panel's connection lifecycle — drives the status pill + whether Send is enabled. `reconnecting`
// is the transient gap between a drop and the next open (auto-reconnect), distinct from a never-yet-open
// `connecting` so the pill copy can differ ("connecting" vs "reconnecting").
export type ChatConnState = "connecting" | "connected" | "reconnecting";

// ── Chat HISTORY seed (bug 0f01f234 — the "reload loses the whole conversation" fix) ───────────────────
// One row as served by GET /api/companion/messages/:sessionId (daemon: db.ts CompanionMessage, minus the
// session/channel/chatId/createdAt columns the panel doesn't render).
export interface CompanionHistoryRow {
  id: string;
  author: "user" | "companion";
  text: string;
}

// Map ONE stored row to a rendered bubble — the daemon's "user"/"companion" author maps to this panel's
// "you"/"companion" ChatAuthor (mirrors youMessage/companionMessage's author values). The component fetches
// history BEFORE opening the WebSocket (load-then-connect), so there is no live frame that could arrive
// before this seed — no separate dedup step is needed here, just the correct author mapping.
export function historyMessage(row: CompanionHistoryRow): ChatMessage {
  return { id: row.id, author: row.author === "user" ? "you" : "companion", text: row.text };
}
