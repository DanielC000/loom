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
