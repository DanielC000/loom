import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import {
  companionMessage, parseInbound, prepareSend, youMessage,
  type ChatConnState, type ChatMessage,
} from "../lib/companionChat";
import { Button, StatusPill } from "./ui";
import { color, font, radius } from "../theme";

/**
 * Companion chat surface — a companion's DEFAULT face in the cockpit (NOT the raw session terminal). A
 * friendly chat-bubble panel over the dedicated in-app WebSocket `/ws/companion/:sessionId` (separate from
 * the terminal route `/ws/term/:sessionId`; see daemon companion/in-app.ts). You type → the panel sends
 * {type:"chat",text}; the companion's reply arrives as a {type:"chat",chatId,text} frame and renders as a
 * companion bubble. All wire framing + parsing lives in the pure, unit-tested lib/companionChat.
 *
 * Connection lifecycle mirrors Terminal.tsx's discipline (open/close/reconnect, and the CONNECTING-state
 * close guard so a pane abandoned mid-handshake never logs a spurious close) — but with JSON chat framing,
 * never raw pty bytes.
 *
 * `armed` (optional) is whether this companion actually has an in-app route. When false, we surface a
 * gentle "not wired" notice: a message to an unbound companion gets no reply frame, so we must not imply it
 * was delivered. Unknown (undefined) ⇒ no upfront notice, but the reply-timeout backstop still applies.
 */

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 10000;
// If a sent message draws no reply within this window, stop the "typing" affordance and surface a gentle
// "no reply yet" hint — the companion may be offline / not yet provisioned (never a fake "delivered").
const REPLY_TIMEOUT_MS = 25000;

export function CompanionChat({ sessionId, title, armed }: { sessionId: string; title?: string; armed?: boolean }) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conn, setConn] = useState<ChatConnState>("connecting");
  const [draft, setDraft] = useState("");
  const [awaitingReply, setAwaitingReply] = useState(false);
  const [replyTimedOut, setReplyTimedOut] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(0);
  const replyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const nextId = () => String(++idRef.current);

  // ── WebSocket lifecycle: connect, ingest chat frames, auto-reconnect with backoff. ─────────────
  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let backoff = RECONNECT_MIN_MS;

    const clearReplyTimer = () => { clearTimeout(replyTimer.current); replyTimer.current = undefined; };

    // Belongs-in-the-unit invariant: a sessionId change is a FRESH conversation — clear the transcript +
    // pending-reply state here so no bubbles bleed across companions even if a caller reuses this component
    // without a keyed parent (the parent keys on sessionId today, but the no-bleed rule shouldn't depend on it).
    setMessages([]);
    setConn("connecting");
    setAwaitingReply(false);
    setReplyTimedOut(false);
    clearReplyTimer();

    const connect = () => {
      if (disposed) return;
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/ws/companion/${sessionId}`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (disposed) return;
        backoff = RECONNECT_MIN_MS; // reset the backoff once a connection actually establishes
        setConn("connected");
      };
      ws.onmessage = (e) => {
        if (disposed || typeof e.data !== "string") return;
        const reply = parseInbound(e.data);
        if (!reply) return; // ignore any non-{type:"chat"} frame (control/garbage) — never render it
        clearReplyTimer();
        setAwaitingReply(false);
        setReplyTimedOut(false);
        setMessages((m) => [...m, companionMessage(reply.text, nextId())]);
      };
      ws.onclose = () => {
        if (disposed) return;
        wsRef.current = null;
        setConn("reconnecting");
        reconnectTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, RECONNECT_MAX_MS); // exponential backoff, capped
      };
      // onerror is followed by onclose; let onclose own the reconnect so we don't double-schedule.
    };

    connect();

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      clearReplyTimer();
      const ws = wsRef.current;
      wsRef.current = null;
      if (ws) {
        // Don't act on a socket abandoned mid-handshake — closing a CONNECTING socket logs a spurious
        // "closed before the connection is established". Detach handlers so no late frame lands on the
        // unmounted panel, then close once it opens (or immediately if already open). Mirrors Terminal.tsx.
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        if (ws.readyState === ws.CONNECTING) ws.onopen = () => ws.close();
        else { ws.onopen = null; ws.close(); }
      }
    };
  }, [sessionId]);

  // ── Autoscroll: stick to the bottom on a new message UNLESS the reader has scrolled up to read back. ──
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages, awaitingReply, replyTimedOut]);

  const send = () => {
    const prepared = prepareSend(draft);
    if (!prepared) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== ws.OPEN) return; // Send is disabled unless connected — belt & suspenders
    ws.send(prepared.frame);
    setMessages((m) => [...m, youMessage(prepared.text, nextId())]);
    setDraft("");
    setAwaitingReply(true);
    setReplyTimedOut(false);
    clearTimeout(replyTimer.current);
    replyTimer.current = setTimeout(() => setReplyTimedOut(true), REPLY_TIMEOUT_MS);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } // Shift+Enter = newline
  };

  const connected = conn === "connected";
  const canSend = connected && draft.trim().length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 420, gap: 12 }}>
      <ChatHeader title={title ?? "Companion"} conn={conn} />

      {armed === false && (
        <div style={notice("amber")} role="status">
          <span aria-hidden style={{ color: color.amber }}>▲</span>
          <span>
            This companion has no in-app route yet, so a message won't reach it — bind one under{" "}
            <strong style={{ color: color.text }}>Manage</strong> first.
          </span>
        </div>
      )}

      <div
        ref={scrollRef}
        style={{
          flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2,
          padding: "4px 2px",
        }}
      >
        {messages.length === 0 ? (
          <EmptyState connected={connected} title={title ?? "your companion"} />
        ) : (
          messages.map((m, i) => (
            <Bubble key={m.id} msg={m} title={title ?? "Companion"} grouped={messages[i - 1]?.author === m.author} />
          ))
        )}
        {awaitingReply && !replyTimedOut && <TypingIndicator title={title ?? "Companion"} />}
        {replyTimedOut && (
          <div style={{ ...notice("muted"), alignSelf: "center", marginTop: 6 }} role="status">
            No reply yet — {title ?? "this companion"} may be offline or not connected.
          </div>
        )}
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea
          className="loom-field"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={connected ? `Message ${title ?? "your companion"}…` : "Connecting…"}
          rows={2}
          spellCheck
          aria-label="Message"
          style={{
            flex: 1, resize: "none", fontFamily: font.mono, fontSize: 13, lineHeight: 1.5,
            background: color.panel2, color: color.text, border: `1px solid ${color.borderStrong}`,
            borderRadius: radius.base, padding: "8px 10px",
          }}
        />
        <Button variant="primary" disabled={!canSend} onClick={send} style={{ padding: "8px 14px", alignSelf: "stretch" }}>
          Send
        </Button>
      </div>
    </div>
  );
}

// ── Header: title + live connection pill ─────────────────────────────────────────
function ChatHeader({ title, conn }: { title: string; conn: ChatConnState }) {
  const pill =
    conn === "connected" ? { tone: "phosphor" as const, label: "connected", glow: true } :
    conn === "connecting" ? { tone: "amber" as const, label: "connecting", glow: false } :
    { tone: "red" as const, label: "reconnecting", glow: false };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <strong style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.08em", color: color.text }}>
        {title}
      </strong>
      <span style={{ flex: 1 }} />
      <StatusPill tone={pill.tone} label={pill.label} glow={pill.glow} />
    </div>
  );
}

// ── One chat bubble ──────────────────────────────────────────────────────────────
function Bubble({ msg, title, grouped }: { msg: ChatMessage; title: string; grouped: boolean }) {
  const you = msg.author === "you";
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: you ? "flex-end" : "flex-start", marginTop: grouped ? 0 : 8 }}>
      {!grouped && (
        <span style={{ fontFamily: font.mono, fontSize: 10, color: color.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 4px 3px" }}>
          {you ? "You" : title}
        </span>
      )}
      <div
        className="loom-chat-in"
        style={{
          maxWidth: "82%", padding: "7px 11px", borderRadius: 10, fontFamily: font.mono, fontSize: 13,
          lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: color.text,
          background: you ? color.phosphorDim : color.panel2,
          border: `1px solid ${you ? "transparent" : color.border}`,
          borderBottomRightRadius: you ? 3 : 10,
          borderBottomLeftRadius: you ? 10 : 3,
        }}
      >
        {msg.text}
      </div>
    </div>
  );
}

// ── Companion "typing" affordance while a reply is awaited ────────────────────────
function TypingIndicator({ title }: { title: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", marginTop: 8 }} aria-label={`${title} is replying`} role="status">
      <div style={{ display: "flex", gap: 4, alignItems: "center", padding: "9px 12px", borderRadius: 10, borderBottomLeftRadius: 3, background: color.panel2, border: `1px solid ${color.border}` }}>
        {[0, 1, 2].map((i) => (
          <span
            key={i}
            className="loom-typing-dot"
            style={{ width: 5, height: 5, borderRadius: 5, background: color.textDim, animationDelay: `${i * 0.18}s` }}
          />
        ))}
      </div>
    </div>
  );
}

// ── Empty state before the first message ──────────────────────────────────────────
function EmptyState({ connected, title }: { connected: boolean; title: string }) {
  return (
    <div style={{ margin: "auto", textAlign: "center", display: "flex", flexDirection: "column", gap: 8, color: color.textMuted, padding: 24, maxWidth: 320 }}>
      <span aria-hidden style={{ fontSize: 22, opacity: 0.7 }}>◇</span>
      <span style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12, color: color.textDim }}>
        Say hello
      </span>
      <span style={{ fontSize: 12, lineHeight: 1.6 }}>
        {connected
          ? `Start a conversation with ${title}. Messages and replies show up here as a chat.`
          : `Connecting to ${title}…`}
      </span>
    </div>
  );
}

// A small inline notice row (amber = attention, muted = quiet backstop).
function notice(t: "amber" | "muted"): CSSProperties {
  const c = t === "amber" ? color.amber : color.textMuted;
  return {
    display: "flex", gap: 8, alignItems: "center", padding: "7px 10px",
    border: `1px solid ${t === "amber" ? color.amber : color.border}`, borderRadius: radius.base,
    background: t === "amber" ? "rgba(255,178,62,0.06)" : color.panel2,
    fontFamily: font.mono, fontSize: 12, lineHeight: 1.5, color: c === color.amber ? color.textDim : color.textMuted,
  };
}
