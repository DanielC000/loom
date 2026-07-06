import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanionConversationSummary } from "@loom/shared";
import {
  companionMessage, crossChannelMessage, historyMessage, IN_APP_CHANNEL, parseCleared, parseCrossChannel, parseInbound, parseTranscript,
  prepareSend, prepareSendAudio, youMessage,
  type ChatConnState, type ChatMessage, type CompanionHistoryRow,
} from "../lib/companionChat";
import { api } from "../lib/api";
import { Button, Dot, SectionLabel, StatusPill } from "./ui";
import { color, font, radius } from "../theme";

// Feature-detect mic support ONCE at module load (Companion Voice epic, VOICE-P4 inbound) — Safari/older
// browsers or a non-HTTPS/non-loopback origin may lack getUserMedia or MediaRecorder entirely; the mic
// button simply doesn't render rather than throwing when clicked. The daemon's loopback origin (http on
// 127.0.0.1) is a getUserMedia-secure-context exception in every major browser, so this isn't gated further.
const MIC_SUPPORTED =
  typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";

// Convert a recorded Blob to a bare base64 string (no "data:...;base64," prefix) — DOM/FileReader work,
// kept out of the pure lib/companionChat module.
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Companion chat surface — a companion's DEFAULT face in the cockpit (NOT the raw session terminal). A
 * friendly chat-bubble panel over the dedicated in-app WebSocket `/ws/companion/:sessionId` (separate from
 * the terminal route `/ws/term/:sessionId`; see daemon companion/in-app.ts). You type → the panel sends
 * {type:"chat",text}; the companion's reply arrives as a {type:"chat",chatId,text} frame and renders as a
 * companion bubble. A turn that happened on a NON-in-app channel (e.g. Telegram) arrives as a
 * {type:"cross-channel",...} frame (live-push card) and renders with the same badge/mic treatment a
 * reload's history seed would give it. All wire framing + parsing lives in the pure, unit-tested
 * lib/companionChat.
 *
 * Connection lifecycle mirrors Terminal.tsx's discipline (open/close/reconnect, and the CONNECTING-state
 * close guard so a pane abandoned mid-handshake never logs a spurious close) — but with JSON chat framing,
 * never raw pty bytes.
 *
 * HISTORY (bug 0f01f234 — reload used to lose the whole conversation): on every sessionId mount, this LOADS
 * the durable history first (GET /api/companion/messages/:sessionId) and seeds `messages` from it, THEN
 * opens the WebSocket — load-then-connect, so no live frame can arrive before the history snapshot is
 * taken (no history/live overlap to dedup on THIS mount's initial seed). A cross-channel live push is still
 * deduped by its persisted row id (see the ws handler) — a defensive backstop for a reconnect or a duplicate
 * push, not for the initial seed. A fetch failure degrades to an empty seed and still connects live (never
 * blocks the chat on a history read).
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

export function CompanionChat({ sessionId, title, armed, onConversationArchived }: {
  sessionId: string; title?: string; armed?: boolean;
  // Fires when a "/new"/"/reset" archives the current conversation (a live `cleared` frame). The
  // history-browser parent uses it to refetch the conversation list so the just-archived one appears.
  onConversationArchived?: () => void;
}) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conn, setConn] = useState<ChatConnState>("connecting");
  const [draft, setDraft] = useState("");
  const [awaitingReply, setAwaitingReply] = useState(false);
  const [replyTimedOut, setReplyTimedOut] = useState(false);
  const [recording, setRecording] = useState(false); // Companion Voice epic, VOICE-P4 inbound

  // Held in a ref so the sessionId-keyed WS effect below always calls the LATEST callback without
  // re-subscribing the socket when the parent passes a fresh function each render.
  const onArchivedRef = useRef(onConversationArchived);
  onArchivedRef.current = onConversationArchived;

  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(0);
  const replyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
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
        if (reply) {
          clearReplyTimer();
          setAwaitingReply(false);
          setReplyTimedOut(false);
          setMessages((m) => [...m, companionMessage(reply.text, nextId(), reply.audio)]);
          if (reply.audio) {
            // Autoplay ONLY a LIVE reply (never a history-seeded row — that path never carries audio at
            // all, since audio is transport-only). Scoped to this interaction per the design note: the
            // user's own Send/mic press is the gesture that started this turn, so the browser's autoplay
            // policy (interaction-gated, not same-callstack-gated) allows it; a rendered <audio controls>
            // on the bubble is the fallback if a browser still blocks it.
            try {
              const audio = new Audio(`data:${reply.audio.mimeType};base64,${reply.audio.data}`);
              void audio.play().catch(() => { /* autoplay blocked — the bubble's own <audio controls> still lets the user play it */ });
            } catch { /* never let a playback attempt break the chat */ }
          }
          return;
        }
        // The daemon's live echo of OUR OWN web-mic recording once STT completes (Companion Voice epic,
        // VOICE-P4 inbound) — a recorded clip has no text to render locally at send time (unlike typed
        // text), so this is a genuine round trip. Render it as "your turn" and arm the SAME reply-await/
        // timeout `send()` arms for typed text, so a stalled STT/agent still surfaces the "no reply yet" hint.
        const transcript = parseTranscript(e.data);
        if (transcript) {
          setMessages((m) => [...m, youMessage(transcript.text, nextId())]);
          setAwaitingReply(true);
          setReplyTimedOut(false);
          clearReplyTimer();
          replyTimer.current = setTimeout(() => setReplyTimedOut(true), REPLY_TIMEOUT_MS);
          return;
        }
        // The "/new"/"/reset" command's live push (daemon has already cleared the durable history) — empty
        // the panel's own transcript + any pending-reply state right now, instead of waiting for a reload.
        const cleared = parseCleared(e.data);
        if (cleared) {
          setMessages([]);
          setAwaitingReply(false);
          setReplyTimedOut(false);
          clearReplyTimer();
          onArchivedRef.current?.(); // the just-ended conversation is now archived — refresh the history list
          return;
        }
        // A NON-in-app channel turn (e.g. Telegram), pushed live the moment the daemon persists it
        // (live-push card — closes the "only shows up after a reload" gap in the unified cross-channel
        // chat, card 7d63e200). Renders with the SAME historyMessage shape a reload would produce (the
        // "Telegram" badge + 🎤 for a voice transcript). Dedup by `id` (the companion_messages row id, the
        // SAME id a later reload's seed carries for this row): this load-then-connect panel can't seed the
        // same row twice within one mount, but a reconnect or a duplicate push could otherwise double-render.
        const crossChannel = parseCrossChannel(e.data);
        if (crossChannel) {
          setMessages((m) => (m.some((x) => x.id === crossChannel.id) ? m : [...m, crossChannelMessage(crossChannel)]));
          return;
        }
        // any other frame (control/garbage) is ignored — never rendered
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

    // Load-then-connect (bug 0f01f234): seed the durable history BEFORE opening the WS, so there is no
    // window where a live frame and a historical row could both land — nothing can arrive live until the
    // socket below opens, and that only happens after this resolves. `disposed` guards against a
    // fast sessionId swap (or unmount) landing a stale fetch's result on the NEW session's transcript.
    (async () => {
      try {
        const res = await fetch(`/api/companion/messages/${sessionId}`);
        if (res.ok) {
          const body = (await res.json()) as { messages?: CompanionHistoryRow[] };
          if (!disposed && Array.isArray(body.messages)) {
            setMessages(body.messages.map(historyMessage));
          }
        }
      } catch {
        // best-effort — an unreachable history endpoint just means an empty seed, never blocks live chat
      }
      if (!disposed) connect();
    })();

    return () => {
      disposed = true;
      clearTimeout(reconnectTimer);
      clearReplyTimer();
      // A sessionId swap or unmount mid-recording must release the mic (never leak an open stream) —
      // MediaRecorder's own onstop still fires and would otherwise try to send audio on the OLD/closing ws.
      mediaRecorderRef.current?.stop();
      mediaRecorderRef.current = null;
      setRecording(false); // else the NEXT session's mic button renders stuck on "■" until clicked
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

  // ── Mic recording (Companion Voice epic, VOICE-P4 inbound) ────────────────────────────────────
  const sendAudio = async (blob: Blob) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== ws.OPEN) return; // dropped silently — mirrors send()'s own connected guard
    const base64 = await blobToBase64(blob);
    ws.send(prepareSendAudio(base64, blob.type || "audio/webm"));
    // No local "you" bubble here (unlike send()) — the transcript isn't known yet; the daemon's
    // { type:"transcript" } echo renders it once STT completes. Still arm the SAME reply-await/timeout so a
    // silently-dropped clip (STT off / unsupported format) surfaces the existing "no reply yet" hint instead
    // of leaving the panel looking stuck.
    setAwaitingReply(true);
    setReplyTimedOut(false);
    clearTimeout(replyTimer.current);
    replyTimer.current = setTimeout(() => setReplyTimedOut(true), REPLY_TIMEOUT_MS);
  };

  const startRecording = async () => {
    if (!MIC_SUPPORTED || recording) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const chunks: BlobPart[] = [];
      const recorder = new MediaRecorder(stream);
      recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };
      recorder.onstop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void sendAudio(new Blob(chunks, { type: recorder.mimeType || "audio/webm" }));
      };
      mediaRecorderRef.current = recorder;
      recorder.start();
      setRecording(true);
    } catch {
      // Permission denied / no device / any getUserMedia failure — degrade silently to text-only; the mic
      // button just does nothing rather than breaking the panel (mirrors the !MIC_SUPPORTED guard below).
    }
  };

  const stopRecording = () => {
    mediaRecorderRef.current?.stop();
    mediaRecorderRef.current = null;
    setRecording(false);
  };

  const connected = conn === "connected";
  const canSend = connected && draft.trim().length > 0;

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, gap: 12 }}>
      <ChatHeader conn={conn} title={title ?? "Companion"} />

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
          // Inter-message spacing is single-sourced on each Bubble's marginTop (4px within a group,
          // 12px between authors) — the list itself adds no gap, so the two never compound.
          flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 0,
          padding: "4px 4px",
        }}
      >
        {messages.length === 0 ? (
          <EmptyState connected={connected} title={title ?? "your companion"} />
        ) : (
          messages.map((m, i) => (
            <Bubble
              key={m.id}
              msg={m}
              title={title ?? "Companion"}
              grouped={messages[i - 1]?.author === m.author && messages[i - 1]?.channel === m.channel}
            />
          ))
        )}
        {awaitingReply && !replyTimedOut && <TypingIndicator title={title ?? "Companion"} />}
        {replyTimedOut && (
          <div style={{ ...notice("muted"), alignSelf: "center", marginTop: 12 }} role="status">
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
            borderRadius: radius.base, padding: "8px 12px",
          }}
        />
        {MIC_SUPPORTED && (
          <Button
            variant={recording ? "danger" : "default"}
            disabled={!connected}
            onClick={recording ? stopRecording : startRecording}
            title={recording ? "Stop recording" : `Record a voice message to ${title ?? "your companion"}`}
            aria-pressed={recording}
            style={{ padding: "8px 12px", alignSelf: "stretch" }}
          >
            {recording ? "■" : "●"}
          </Button>
        )}
        <Button variant="primary" disabled={!canSend} onClick={send} style={{ padding: "8px 16px", alignSelf: "stretch" }}>
          Send
        </Button>
      </div>
    </div>
  );
}

// ── Header: companion name + live connection pill ────────────────────────────────
// Names the companion INSIDE the chat panel (left), with the live connection state right-aligned. The
// name reads in the panel's own header strip so it's present even once the empty state (which also names
// it) scrolls away — styled like the outer CompanionDetail header (font.head, uppercase) but dimmer, so
// the two agree without competing. Truncates with an ellipsis rather than wrapping the strip.
function ChatHeader({ conn, title }: { conn: ChatConnState; title: string }) {
  const pill =
    conn === "connected" ? { tone: "phosphor" as const, label: "connected", glow: true } :
    conn === "connecting" ? { tone: "amber" as const, label: "connecting", glow: false } :
    { tone: "red" as const, label: "reconnecting", glow: false };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <span
        style={{
          flex: 1, minWidth: 0, fontFamily: font.head, fontSize: 12, textTransform: "uppercase",
          letterSpacing: "0.08em", color: color.textDim,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}
      >
        {title}
      </span>
      <StatusPill tone={pill.tone} label={pill.label} glow={pill.glow} />
    </div>
  );
}

// Unified cross-channel chat (card 7d63e200): a subtle per-bubble provenance label for a channel other
// than in-app (the default, unlabeled web chat) — e.g. "Telegram". Falls back to title-casing an unknown
// future channel name rather than hiding it.
function channelLabel(channel: string): string | null {
  if (channel === IN_APP_CHANNEL) return null;
  if (channel === "telegram") return "Telegram";
  return channel.length > 0 ? channel.slice(0, 1).toUpperCase() + channel.slice(1) : null;
}

// ── One chat bubble ──────────────────────────────────────────────────────────────
function Bubble({ msg, title, grouped }: { msg: ChatMessage; title: string; grouped: boolean }) {
  const you = msg.author === "you";
  const badge = channelLabel(msg.channel);
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: you ? "flex-end" : "flex-start", marginTop: grouped ? 4 : 12 }}>
      {!grouped && (
        <span style={{ fontFamily: font.mono, fontSize: 10, color: color.textMuted, textTransform: "uppercase", letterSpacing: "0.06em", margin: "0 4px 4px" }}>
          {you ? "You" : title}
          {badge && <span style={{ opacity: 0.7 }}> · {badge}</span>}
        </span>
      )}
      <div
        className="loom-chat-in"
        style={{
          maxWidth: "82%", padding: "8px 12px", borderRadius: 10, fontFamily: font.mono, fontSize: 13,
          lineHeight: 1.55, whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: color.text,
          background: you ? color.phosphorDim : color.panel2,
          border: `1px solid ${you ? "transparent" : color.border}`,
          borderBottomRightRadius: you ? 3 : 10,
          borderBottomLeftRadius: you ? 10 : 3,
        }}
      >
        {msg.voice && <span aria-label="Voice message" title="Voice message">🎤 </span>}
        {msg.text}
        {msg.audio && (
          // Companion Voice epic, VOICE-P4 outbound — the manual play/pause/replay affordance (the ws
          // handler already attempted a one-shot autoplay on arrival; this stays regardless of whether
          // that succeeded, and gives a replay control either way).
          <audio
            controls
            src={`data:${msg.audio.mimeType};base64,${msg.audio.data}`}
            style={{ display: "block", marginTop: 8, height: 32, width: "100%" }}
          />
        )}
      </div>
    </div>
  );
}

// ── Companion "typing" affordance while a reply is awaited ────────────────────────
function TypingIndicator({ title }: { title: string }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", marginTop: 12 }} aria-label={`${title} is replying`} role="status">
      <div style={{ display: "flex", gap: 4, alignItems: "center", padding: "8px 12px", borderRadius: 10, borderBottomLeftRadius: 3, background: color.panel2, border: `1px solid ${color.border}` }}>
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
    display: "flex", gap: 8, alignItems: "center", padding: "8px 12px",
    border: `1px solid ${t === "amber" ? color.amber : color.border}`, borderRadius: radius.base,
    background: t === "amber" ? "rgba(255,178,62,0.06)" : color.panel2,
    fontFamily: font.mono, fontSize: 12, lineHeight: 1.5, color: c === color.amber ? color.textDim : color.textMuted,
  };
}

// ══ Conversation history browser (card 59e8e0c9) ═══════════════════════════════════════════════════════
// A companion's Chat surface, extended so past conversations are browsable alongside the live chat. Every
// "/new"/"/reset" ARCHIVES the just-ended conversation (daemon card 85f62475); this pane surfaces those
// archived conversations in a left rail (newest-first, each a timestamp + first-message preview + count).
// The CURRENT (open, endedAt===null) conversation stays the live chat, UNCHANGED — it never appears as a
// "past" row. Clicking a past conversation opens its full unified transcript READ-ONLY (no composer),
// reusing the exact bubble rendering (channel badge + 🎤 voice indicator) the live chat uses.
//
// Scoped PER-companion by sessionId (each companion is its own session). With NO archived conversations yet
// the rail is hidden entirely, so a fresh single-conversation companion reads exactly as it did before this
// feature — the live chat sits in the same tree slot whether the rail shows or not, so gaining history never
// tears down and re-opens the live WebSocket.
export function CompanionChatPanel({ sessionId, title, armed }: { sessionId: string; title?: string; armed?: boolean }) {
  const qc = useQueryClient();
  const convos = useQuery({
    queryKey: ["companionConversations", sessionId],
    queryFn: () => api.companionConversations(sessionId),
  });
  // null = the live chat; a number = viewing that archived conversation's read-only transcript.
  const [viewingSeq, setViewingSeq] = useState<number | null>(null);

  // "Past" = archived (endedAt !== null). The open conversation (endedAt===null) IS the live chat and is
  // rendered in the live pane, so it's never a browsable "past" row.
  const past = (convos.data ?? []).filter((c) => c.endedAt !== null);
  const hasHistory = past.length > 0;

  // A /new archives the current conversation → refetch so it shows in the rail. Passed into the live chat,
  // fired from its `cleared` frame handler.
  const onArchived = () => { qc.invalidateQueries({ queryKey: ["companionConversations", sessionId] }); };

  // If the viewed conversation vanished (retention eviction past the cap, or a companion switch), fall back
  // to the live chat rather than leaving a dangling read-only pane.
  useEffect(() => {
    if (viewingSeq !== null && convos.data && !convos.data.some((c) => c.seq === viewingSeq)) setViewingSeq(null);
  }, [viewingSeq, convos.data]);

  return (
    <div style={{ display: "flex", gap: hasHistory ? 14 : 0, flex: 1, minHeight: 0 }}>
      {hasHistory && (
        <ConversationHistoryRail past={past} viewingSeq={viewingSeq} onSelect={setViewingSeq} />
      )}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", minHeight: 0 }}>
        {viewingSeq === null ? (
          <CompanionChat sessionId={sessionId} title={title} armed={armed} onConversationArchived={onArchived} />
        ) : (
          <PastConversationView sessionId={sessionId} seq={viewingSeq} title={title ?? "Companion"} onBack={() => setViewingSeq(null)} />
        )}
      </div>
    </div>
  );
}

// ── History rail: the live conversation + every archived one, newest-first ─────────────────────────────
function ConversationHistoryRail({ past, viewingSeq, onSelect }: {
  past: CompanionConversationSummary[];
  viewingSeq: number | null;
  onSelect: (seq: number | null) => void;
}) {
  return (
    <aside aria-label="Conversation history" style={{ width: 232, flexShrink: 0, display: "flex", flexDirection: "column", minHeight: 0, gap: 8 }}>
      <SectionLabel style={{ margin: 0 }}>History</SectionLabel>
      <div style={{ overflowY: "auto", minHeight: 0, display: "flex", flexDirection: "column", gap: 6, paddingRight: 2 }}>
        <HistoryRow
          active={viewingSeq === null}
          live
          primary="Current"
          secondary="The live chat"
          onClick={() => onSelect(null)}
        />
        {past.map((c) => (
          <HistoryRow
            key={c.seq}
            active={viewingSeq === c.seq}
            primary={formatConversationTime(c.startedAt)}
            secondary={c.preview ?? "(no preview)"}
            count={c.messageCount}
            onClick={() => onSelect(c.seq)}
          />
        ))}
      </div>
    </aside>
  );
}

// One selectable conversation row. `live` marks the current (live-chat) entry with a phosphor dot; a past
// row shows its message count. Selection mirrors the CompanionSwitcher toggle treatment (phosphor fill +
// border when active) so the two picker patterns on this page read as one system.
function HistoryRow({ active, primary, secondary, count, live, onClick }: {
  active: boolean; primary: string; secondary: string; count?: number; live?: boolean; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className="loom-toggle"
      style={{
        textAlign: "left", display: "flex", flexDirection: "column", gap: 3, cursor: "pointer",
        background: active ? color.phosphorDim : "transparent",
        border: `1px solid ${active ? color.phosphor : color.border}`,
        borderRadius: radius.base, padding: "7px 9px", fontFamily: font.mono,
      }}
    >
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        {live && <Dot tone="phosphor" glow />}
        <span style={{ fontFamily: font.head, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: active ? color.text : color.textDim }}>
          {primary}
        </span>
        {count !== undefined && (
          <>
            <span style={{ flex: 1 }} />
            <span style={{ fontSize: 10, color: color.textMuted }}>{count} msg{count === 1 ? "" : "s"}</span>
          </>
        )}
      </span>
      <span style={{ fontSize: 11, lineHeight: 1.4, color: color.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {secondary}
      </span>
    </button>
  );
}

// ── Past conversation: a read-only transcript of ONE archived conversation ─────────────────────────────
// Fetches the one conversation's full unified message list and renders it with the SAME Bubble the live
// chat uses (channel badge + 🎤 voice indicator preserved). No composer — a past conversation is immutable.
function PastConversationView({ sessionId, seq, title, onBack }: {
  sessionId: string; seq: number; title: string; onBack: () => void;
}) {
  const q = useQuery({
    queryKey: ["companionConversation", sessionId, seq],
    queryFn: () => api.companionConversation(sessionId, seq),
  });
  const messages: ChatMessage[] = (q.data?.messages ?? []).map(historyMessage);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Button variant="ghost" onClick={onBack} style={{ padding: "4px 8px" }} title="Return to the live chat">← Live chat</Button>
        <span style={{ flex: 1, minWidth: 0, fontFamily: font.head, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", color: color.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {q.data ? formatConversationTime(q.data.conversation.startedAt) : "Conversation"}
        </span>
        <StatusPill tone="cyan" label="read-only" />
      </div>

      <div
        style={{
          flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 0,
          padding: "4px 4px",
        }}
      >
        {q.isLoading ? (
          <div style={{ margin: "auto", color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>Loading…</div>
        ) : q.isError ? (
          <div style={{ margin: "auto", color: color.red, fontFamily: font.mono, fontSize: 12 }}>{(q.error as Error).message}</div>
        ) : messages.length === 0 ? (
          <div style={{ margin: "auto", color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>This conversation has no messages.</div>
        ) : (
          messages.map((m, i) => (
            <Bubble
              key={m.id}
              msg={m}
              title={title}
              grouped={messages[i - 1]?.author === m.author && messages[i - 1]?.channel === m.channel}
            />
          ))
        )}
      </div>
    </div>
  );
}

// Compact, locale-aware absolute timestamp for a conversation row / header — e.g. "Jul 6, 2:14 PM". Falls
// back to the raw ISO string if it can't be parsed (never throws on a malformed date).
function formatConversationTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}
