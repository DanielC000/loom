import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { CompanionConversationSummary } from "@loom/shared";
import {
  buildTimeline, companionMessage, crossChannelMessage, historyMessage, mediaMessage, parseCleared,
  parseCrossChannel, parseInbound, parseMedia, parseTranscript, prepareSend, prepareSendAudio, resetMarker,
  youMessage,
  type ChatConnState, type ChatMessage, type InboundMedia, type TimelineItem,
} from "../lib/companionChat";
import { channelBadgeLabel } from "../lib/companion";
import { api } from "../lib/api";
import { Button, Dot, SectionLabel, StatusPill } from "./ui";
import { color, font, radius } from "../theme";

// Feature-detect mic support ONCE at module load (Companion Voice epic, VOICE-P4 inbound) — Safari/older
// browsers or a non-HTTPS/non-loopback origin may lack getUserMedia or MediaRecorder entirely; the mic
// button simply doesn't render rather than throwing when clicked. The daemon's loopback origin (http on
// 127.0.0.1) is a getUserMedia-secure-context exception in every major browser, so this isn't gated further.
const MIC_SUPPORTED =
  typeof navigator !== "undefined" && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== "undefined";

// A monotonic ISO stamp for a LIVE turn — the panel's own send/receive time. History rows carry the durable
// `createdAt` instead (historyMessage). One helper so every live builder call agrees.
function nowIso(): string {
  return new Date().toISOString();
}

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
 * Companion chat surface — a companion's DEFAULT face in the cockpit (NOT the raw session terminal). A real
 * threaded chat over the dedicated in-app WebSocket `/ws/companion/:sessionId` (separate from the terminal
 * route `/ws/term/:sessionId`; see daemon companion/in-app.ts). You type → the panel sends {type:"chat",text};
 * the companion's reply arrives as a {type:"chat",chatId,text} frame and renders as a companion bubble. A
 * turn that happened on a NON-in-app channel (e.g. Telegram) arrives as a {type:"cross-channel",...} frame
 * (live-push card) and renders with the same badge/mic treatment a reload's history seed would give it. A
 * `send_media` delivery (the `media-out` lever's in-app fast-follow, card 9ec79b52) arrives as a
 * {type:"media",...} frame and renders as its own bubble. All wire framing + parsing — and the timeline
 * assembly (day dividers, consecutive-sender grouping, per-group timestamps, delivery state, reset markers,
 * proactive event lines) — live in the pure, unit-tested lib/companionChat (`buildTimeline`).
 *
 * THE "REAL CHAT" REBUILD (card bbd1ced9): the panel no longer renders a flat, timeless bubble wall that
 * grows without anchors. `buildTimeline` segments the stream by day, collapses same-sender runs under one
 * header, and marks delivery + channel state; the scroll sticks to the bottom while you're there and offers a
 * floating "Jump to latest · N new" anchor once you scroll up — the direct fix for "grows endlessly".
 *
 * Connection lifecycle mirrors Terminal.tsx's discipline (open/close/reconnect, and the CONNECTING-state
 * close guard so a pane abandoned mid-handshake never logs a spurious close) — but with JSON chat framing,
 * never raw pty bytes.
 *
 * HISTORY (bug 0f01f234 — reload used to lose the whole conversation): on every sessionId mount, this LOADS
 * the durable history first (GET /api/companion/messages/:sessionId) and seeds `messages` from it, THEN
 * opens the WebSocket — load-then-connect, so no live frame can arrive before the history snapshot is taken.
 * A cross-channel live push is still deduped by its persisted row id (see the ws handler). A fetch failure
 * degrades to an empty seed and still connects live (never blocks the chat on a history read).
 *
 * `armed` (optional) is whether this companion actually has an in-app route. When false, we surface a gentle
 * "not wired" notice: a message to an unbound companion gets no reply frame, so we must not imply it was
 * delivered. Unknown (undefined) ⇒ no upfront notice, but the reply-timeout backstop still applies.
 */

const RECONNECT_MIN_MS = 1000;
const RECONNECT_MAX_MS = 10000;
// If a sent message draws no reply within this window, stop the "typing" affordance and surface a gentle
// "no reply yet" hint — the companion may be offline / not yet provisioned (never a fake "delivered").
const REPLY_TIMEOUT_MS = 25000;
// Treat the scroll as "at the bottom" within this slack (px) — the stick-to-bottom / jump-to-latest boundary.
const BOTTOM_SLACK_PX = 80;
// The chat viewport is BOUNDED (mirrors the companion Terminal tab's own `62vh`) so a long conversation
// scrolls INSIDE its own box — the load-bearing fix for the "endless wall". Without a bound the app shell
// (a `minHeight:100vh` scrolling document) just grows the page, and the stick-to-bottom / jump-to-latest
// mechanics never engage. Capped, not fixed, so a short conversation still collapses to its content.
const SCROLL_MAX_HEIGHT = "62vh";

export function CompanionChat({ sessionId, title, armed, onConversationArchived }: {
  sessionId: string; title?: string; armed?: boolean;
  // Fires when a "/new"/"/reset" archives the current conversation (a live `cleared` frame). The
  // history-browser parent uses it to refetch the conversation list so the just-archived one appears.
  onConversationArchived?: () => void;
}) {
  const name = title ?? "Companion";
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conn, setConn] = useState<ChatConnState>("connecting");
  const [draft, setDraft] = useState("");
  const [awaitingReply, setAwaitingReply] = useState(false);
  const [replyTimedOut, setReplyTimedOut] = useState(false);
  const [recording, setRecording] = useState(false); // Companion Voice epic, VOICE-P4 inbound
  // ── Stick-to-bottom + jump-to-latest (the anti-"endless wall" scroll mechanic) ──
  const [atBottom, setAtBottom] = useState(true);
  const [unread, setUnread] = useState(0);

  // Held in a ref so the sessionId-keyed WS effect below always calls the LATEST callback without
  // re-subscribing the socket when the parent passes a fresh function each render.
  const onArchivedRef = useRef(onConversationArchived);
  onArchivedRef.current = onConversationArchived;

  const wsRef = useRef<WebSocket | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const idRef = useRef(0);
  const replyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  // Scroll bookkeeping the render must NOT re-run on: whether we're pinned to the bottom (mirrors `atBottom`
  // for the message effect to read synchronously), and the last-seen message count (to count only NEW rows).
  const atBottomRef = useRef(true);
  const prevLenRef = useRef(0);
  const nextId = () => String(++idRef.current);

  // ── WebSocket lifecycle: connect, ingest chat frames, auto-reconnect with backoff. ─────────────
  useEffect(() => {
    let disposed = false;
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
    let backoff = RECONNECT_MIN_MS;

    const clearReplyTimer = () => { clearTimeout(replyTimer.current); replyTimer.current = undefined; };

    // Belongs-in-the-unit invariant: a sessionId change is a FRESH conversation — clear the transcript +
    // pending-reply + scroll state here so nothing bleeds across companions even if a caller reuses this
    // component without a keyed parent (the parent keys on sessionId today, but the no-bleed rule shouldn't
    // depend on it).
    setMessages([]);
    setConn("connecting");
    setAwaitingReply(false);
    setReplyTimedOut(false);
    setUnread(0);
    setAtBottom(true);
    atBottomRef.current = true;
    prevLenRef.current = 0;
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
          setMessages((m) => [...m, companionMessage(reply.text, nextId(), reply.audio, nowIso())]);
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
        // A `send_media` delivery (the `media-out` lever's in-app fast-follow, card 9ec79b52) — a file the
        // companion pushed live, never persisted to history. Resets the reply-await state exactly like a text
        // reply, since a media send is itself the companion's response to the owner's request.
        const media = parseMedia(e.data);
        if (media) {
          clearReplyTimer();
          setAwaitingReply(false);
          setReplyTimedOut(false);
          setMessages((m) => [...m, mediaMessage({ data: media.data, mimeType: media.mimeType, fileName: media.fileName }, nextId(), nowIso())]);
          return;
        }
        // The daemon's live echo of OUR OWN web-mic recording once STT completes (Companion Voice epic,
        // VOICE-P4 inbound) — a recorded clip has no text to render locally at send time (unlike typed
        // text), so this is a genuine round trip. Render it as "your turn" and arm the SAME reply-await/
        // timeout `send()` arms for typed text, so a stalled STT/agent still surfaces the "no reply yet" hint.
        const transcript = parseTranscript(e.data);
        if (transcript) {
          setMessages((m) => [...m, youMessage(transcript.text, nextId(), nowIso())]);
          setAwaitingReply(true);
          setReplyTimedOut(false);
          clearReplyTimer();
          replyTimer.current = setTimeout(() => setReplyTimedOut(true), REPLY_TIMEOUT_MS);
          return;
        }
        // The "/new"/"/reset" command's live push (daemon has already cleared the durable history). Instead
        // of silently emptying the panel, drop an inline RESET marker where the conversation was reset (the
        // approved redesign, card bbd1ced9) — session continuity stays readable, day dividers + grouping keep
        // it navigable, and the next reload naturally re-scopes to the fresh (post-reset) conversation. Still
        // fire onArchived so the just-ended conversation appears in the history rail.
        const cleared = parseCleared(e.data);
        if (cleared) {
          setMessages((m) => [...m, resetMarker(nextId(), nowIso())]);
          setAwaitingReply(false);
          setReplyTimedOut(false);
          clearReplyTimer();
          onArchivedRef.current?.(); // the just-ended conversation is now archived — refresh the history list
          return;
        }
        // A NON-in-app channel turn (e.g. Telegram), pushed live the moment the daemon persists it (live-push
        // card 7d63e200). Renders with the SAME shape a reload would produce (channel badge + 🎤 for a voice
        // transcript). Dedup by `id` (the companion_messages row id): a reconnect or duplicate push could
        // otherwise double-render. Stamped with receipt time — the frame carries no createdAt (the row's real
        // stamp arrives with the same id on the next reload; dedup is by id, so the stamp needn't match).
        const crossChannel = parseCrossChannel(e.data);
        if (crossChannel) {
          setMessages((m) => (m.some((x) => x.id === crossChannel.id) ? m : [...m, crossChannelMessage(crossChannel, nowIso())]));
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
    // window where a live frame and a historical row could both land. `disposed` guards against a fast
    // sessionId swap (or unmount) landing a stale fetch's result on the NEW session's transcript.
    (async () => {
      try {
        const body = await api.companionMessages(sessionId);
        if (!disposed && Array.isArray(body.messages)) {
          setMessages(body.messages.map(historyMessage));
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

  // ── Autoscroll + unread bookkeeping on a new message ──────────────────────────────────────────
  // Stick to the bottom while the reader is there; once they've scrolled up to read back, DON'T yank them
  // down — accrue an unread count instead and surface the "Jump to latest · N new" anchor. This is the
  // direct fix for the "wall that grows endlessly": the newest turn is always one click away, never a
  // hijacked scroll position.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const grew = messages.length - prevLenRef.current;
    prevLenRef.current = messages.length;
    if (atBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      setUnread((u) => (u === 0 ? u : 0));
    } else if (grew > 0) {
      setUnread((u) => u + grew);
    }
  }, [messages]);

  // The "typing" affordance / timeout notice appearing or clearing should keep a bottom-pinned reader
  // pinned, but never counts as unread (it's not a message).
  useEffect(() => {
    const el = scrollRef.current;
    if (el && atBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [awaitingReply, replyTimedOut]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < BOTTOM_SLACK_PX;
    atBottomRef.current = nearBottom;
    setAtBottom(nearBottom);
    if (nearBottom) setUnread(0);
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    atBottomRef.current = true;
    setAtBottom(true);
    setUnread(0);
  };

  const send = () => {
    const prepared = prepareSend(draft);
    if (!prepared) return;
    const ws = wsRef.current;
    if (!ws || ws.readyState !== ws.OPEN) return; // Send is disabled unless connected — belt & suspenders
    ws.send(prepared.frame);
    setMessages((m) => [...m, youMessage(prepared.text, nextId(), nowIso())]);
    setDraft("");
    setAwaitingReply(true);
    setReplyTimedOut(false);
    clearTimeout(replyTimer.current);
    replyTimer.current = setTimeout(() => setReplyTimedOut(true), REPLY_TIMEOUT_MS);
    // Sending is always a deliberate "I'm at the live edge" gesture — snap back to the bottom.
    jumpToLatest();
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
  const timeline = buildTimeline(messages);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, gap: 12 }}>
      <ChatHeader conn={conn} title={name} />

      {armed === false && (
        <div style={notice("amber")} role="status">
          <span aria-hidden style={{ color: color.amber }}>▲</span>
          <span>
            This companion has no in-app route yet, so a message won't reach it — bind one under{" "}
            <strong style={{ color: color.text }}>Manage</strong> first.
          </span>
        </div>
      )}

      <div style={{ position: "relative", flex: 1, minHeight: 0, maxHeight: SCROLL_MAX_HEIGHT, display: "flex", flexDirection: "column" }}>
        <div
          ref={scrollRef}
          onScroll={onScroll}
          data-testid="companion-chat-scroll"
          style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", padding: "6px 14px 10px" }}
        >
          {timeline.length === 0 ? (
            <EmptyState connected={connected} title={name} />
          ) : (
            <Timeline items={timeline} title={name} />
          )}
          {awaitingReply && !replyTimedOut && <TypingIndicator title={name} />}
          {replyTimedOut && (
            <div style={{ ...notice("muted"), alignSelf: "center", marginTop: 12 }} role="status">
              No reply yet — {name} may be offline or not connected.
            </div>
          )}
        </div>
        <JumpToLatest show={!atBottom && timeline.length > 0} unread={unread} onClick={jumpToLatest} />
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "flex-end" }}>
        <textarea
          className="loom-field"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={connected ? `Message ${name}…` : "Connecting…"}
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
            title={recording ? "Stop recording" : `Record a voice message to ${name}`}
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

// ── Header: companion avatar + name + live connection pill ────────────────────────────────
// Names the companion INSIDE the chat panel (left), with the live connection state right-aligned. The name
// reads in the panel's own header strip so it's present even once the empty state (which also names it)
// scrolls away. Truncates with an ellipsis rather than wrapping the strip.
function ChatHeader({ conn, title }: { conn: ChatConnState; title: string }) {
  const pill =
    conn === "connected" ? { tone: "phosphor" as const, label: "connected", glow: true } :
    conn === "connecting" ? { tone: "amber" as const, label: "connecting", glow: false } :
    { tone: "red" as const, label: "reconnecting", glow: false };
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
      <Avatar label={initials(title)} />
      <span
        style={{
          flex: 1, minWidth: 0, fontFamily: font.head, fontSize: 13, fontWeight: 600,
          color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
        }}
      >
        {title}
      </span>
      <StatusPill tone={pill.tone} label={pill.label} glow={pill.glow} />
    </div>
  );
}

// ── The rendered timeline: day dividers, reset markers, event lines, and grouped bubbles ──────────────
// A thin view over `buildTimeline` (lib/companionChat) — all the structure decisions (what groups, where a
// day breaks, which bubble ends a run, the delivery state) are made in that pure, unit-tested function; this
// only paints each item. Shared by the live chat and the read-only past-conversation view.
export function Timeline({ items, title }: { items: TimelineItem[]; title: string }) {
  return (
    <>
      {items.map((it) => {
        if (it.kind === "day") return <DayDivider key={it.id} label={it.label} />;
        if (it.kind === "reset") return <ResetDivider key={it.id} />;
        if (it.kind === "event") return <EventLine key={it.id} msg={it.msg} time={it.time} title={title} />;
        return (
          <MessageRow
            key={it.id}
            msg={it.msg}
            title={title}
            grouped={it.grouped}
            groupEnd={it.groupEnd}
            time={it.time}
            delivery={it.delivery}
          />
        );
      })}
    </>
  );
}

// ── One message row: avatar (companion, group-start only) + a stack of header / bubble / delivery meta ──
function MessageRow({ msg, title, grouped, groupEnd, time, delivery }: {
  msg: ChatMessage; title: string; grouped: boolean; groupEnd: boolean; time: string;
  delivery?: "sent" | "delivered";
}) {
  const you = msg.author === "you";
  const badge = channelBadgeLabel(msg.channel);
  return (
    <div
      style={{
        display: "flex", flexDirection: you ? "row-reverse" : "row", gap: 10,
        marginTop: grouped ? 3 : 14, alignItems: "flex-start",
      }}
    >
      {/* Only a companion's group-START row carries a filled avatar; every other slot is a transparent
          spacer so the bubble columns stay aligned on both sides. */}
      <Avatar label={initials(title)} blank={you || grouped} rowGap />
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0, maxWidth: "78%", alignItems: you ? "flex-end" : "flex-start" }}>
        {!grouped && (
          <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "0 4px 4px", maxWidth: "100%" }}>
            <span style={{ fontFamily: font.head, fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.05em", color: color.textDim, whiteSpace: "nowrap" }}>
              {you ? "You" : title}
            </span>
            {badge && (
              <span style={{ fontFamily: font.mono, fontSize: 9.5, textTransform: "uppercase", letterSpacing: "0.05em", color: color.cyan, border: `1px solid rgba(91,200,255,0.3)`, borderRadius: 3, padding: "0 5px", background: "rgba(91,200,255,0.1)" }}>
                {badge}
              </span>
            )}
            {time && <span style={{ fontFamily: font.mono, fontSize: 10, color: color.textMuted, whiteSpace: "nowrap" }}>{time}</span>}
          </div>
        )}
        <Bubble msg={msg} you={you} groupEnd={groupEnd} />
        {you && groupEnd && delivery && (
          <div style={{ display: "flex", flexDirection: "row-reverse", alignItems: "center", gap: 6, margin: "4px 5px 0", fontFamily: font.mono, fontSize: 10, color: color.textMuted }}>
            <span style={{ color: color.phosphor, letterSpacing: "-1px" }} aria-hidden>{delivery === "delivered" ? "✓✓" : "✓"}</span>
            <span>{(badge ? `via ${badge}` : "in-app")} · {delivery}</span>
          </div>
        )}
      </div>
    </div>
  );
}

// ── The bubble itself: tinted by author, with a "tail" corner only on a run's LAST bubble ─────────────
function Bubble({ msg, you, groupEnd }: { msg: ChatMessage; you: boolean; groupEnd: boolean }) {
  return (
    <div
      className="loom-chat-in"
      style={{
        maxWidth: "100%", padding: "9px 13px", borderRadius: 12, fontFamily: font.mono, fontSize: 13,
        lineHeight: 1.6, whiteSpace: "pre-wrap", overflowWrap: "anywhere", color: color.text,
        background: you ? color.phosphorDim : color.panel2,
        border: `1px solid ${you ? "rgba(46,230,110,0.22)" : color.border}`,
        borderBottomRightRadius: you && groupEnd ? 4 : 12,
        borderBottomLeftRadius: !you && groupEnd ? 4 : 12,
      }}
    >
      {msg.voice && <span aria-label="Voice message" title="Voice message">🎤 </span>}
      {msg.text}
      {msg.media && <MediaAttachment media={msg.media} spaced={msg.text.length > 0} />}
      {msg.audio && (
        // Companion Voice epic, VOICE-P4 outbound — the manual play/pause/replay affordance (the ws handler
        // already attempted a one-shot autoplay on arrival; this stays regardless, and gives a replay control).
        <audio
          controls
          src={`data:${msg.audio.mimeType};base64,${msg.audio.data}`}
          style={{ display: "block", marginTop: 8, height: 32, width: "100%" }}
        />
      )}
    </div>
  );
}

// ── Day divider: a centered pill between hairlines, segmenting the timeline by calendar day ───────────
function DayDivider({ label }: { label: string }) {
  return (
    <div className="loom-chat-day" role="separator" aria-label={label}>
      <span>{label}</span>
    </div>
  );
}

// ── Inline "/new" reset boundary: a dashed rule marking where the conversation was reset ──────────────
function ResetDivider() {
  return (
    <div className="loom-chat-reset" role="separator" aria-label="New conversation">
      <span>⟲ New conversation</span>
    </div>
  );
}

// ── Proactive / heartbeat EVENT LINE: a distinct amber row, never a chat bubble ───────────────────────
// A heartbeat, a fired reminder, or an attention-push alert — an UNSOLICITED companion turn — reads as a
// centered amber event line so it's visibly not part of the back-and-forth. (Wiring the `proactive` flag it
// keys on needs a small daemon change to tag a proactive-origin reply; the render is complete — see the
// ChatMessage.proactive doc in lib/companionChat.)
function EventLine({ msg, time, title }: { msg: ChatMessage; time: string; title: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "center", margin: "12px 0 8px" }} role="status">
      <span
        style={{
          display: "inline-flex", alignItems: "center", gap: 9, maxWidth: "82%", padding: "6px 12px",
          borderRadius: 999, border: `1px solid rgba(255,178,62,0.28)`, background: "rgba(255,178,62,0.09)",
          fontFamily: font.mono, fontSize: 11.5, color: color.textDim, lineHeight: 1.45,
        }}
      >
        <span style={{ fontFamily: font.head, fontSize: 9, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.09em", color: color.amber, whiteSpace: "nowrap" }}>
          ⟡ {title}
        </span>
        <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{msg.text}</span>
        {time && <span style={{ color: color.textMuted, fontSize: 10, whiteSpace: "nowrap" }}>{time}</span>}
      </span>
    </div>
  );
}

// ── Floating "Jump to latest · N new" anchor — the direct fix for "grows endlessly" ───────────────────
// Shows only once the reader has scrolled up off the bottom; clicking returns to the newest turn and clears
// the unread count. Hidden (and non-interactive) while pinned to the bottom.
function JumpToLatest({ show, unread, onClick }: { show: boolean; unread: number; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-hidden={!show}
      tabIndex={show ? 0 : -1}
      className={`loom-chat-jump${show ? " is-shown" : ""}`}
    >
      <span aria-hidden style={{ color: color.phosphor, fontSize: 13 }}>↓</span>
      Jump to latest
      {unread > 0 && (
        <span style={{ fontFamily: font.head, fontWeight: 700, fontSize: 10, color: color.bg, background: color.phosphor, borderRadius: 999, padding: "1px 7px", letterSpacing: "0.02em" }}>
          {unread} new
        </span>
      )}
    </button>
  );
}

// ── Companion avatar: initials on a phosphor chip; `blank` renders a transparent spacer that keeps the
// bubble columns aligned; `rowGap` nudges it down to sit beside the first bubble (past the header). ──────
function Avatar({ label, blank, rowGap }: { label: string; blank?: boolean; rowGap?: boolean }) {
  return (
    <div
      aria-hidden
      style={{
        width: 28, height: 28, borderRadius: 7, flexShrink: 0, ...(rowGap ? { marginTop: 20 } : null),
        display: "grid", placeItems: "center", fontFamily: font.head, fontWeight: 700, fontSize: 11,
        letterSpacing: "0.02em",
        ...(blank
          ? { background: "transparent", border: "1px solid transparent", color: "transparent" }
          : { color: color.phosphor, background: color.phosphorDim, border: "1px solid rgba(46,230,110,0.35)" }),
      }}
    >
      {blank ? "" : label}
    </div>
  );
}

// Up-to-two-character initials for the avatar chip — first letters of the first two words, else the first
// two characters of a single word. Uppercased. Never empty (falls back to "?").
function initials(name: string): string {
  const [first, second] = name.trim().split(/\s+/).filter(Boolean);
  if (!first) return "?";
  if (!second) return first.slice(0, 2).toUpperCase();
  return (first.charAt(0) + second.charAt(0)).toUpperCase();
}

// ── A `send_media` delivery (the `media-out` lever's in-app fast-follow, card 9ec79b52) ───────────────
// An image renders inline (capped so a large screenshot doesn't blow out the bubble width); any other file
// renders as a small downloadable attachment card naming the file — the browser's own data-URI download
// (no daemon round trip needed; the bytes already arrived on the WS frame). `spaced` adds top margin only
// when this follows visible text in the SAME bubble (a bare media message has none).
function MediaAttachment({ media, spaced }: { media: InboundMedia; spaced: boolean }) {
  const src = `data:${media.mimeType};base64,${media.data}`;
  const marginTop = spaced ? 8 : 0;
  if (media.mimeType.startsWith("image/")) {
    return (
      <a href={src} download={media.fileName} title={`Download ${media.fileName}`} style={{ display: "block", marginTop }}>
        <img
          src={src}
          alt={media.fileName}
          style={{ display: "block", maxWidth: "100%", maxHeight: 320, borderRadius: 8, border: `1px solid ${color.border}` }}
        />
      </a>
    );
  }
  return (
    <a
      href={src}
      download={media.fileName}
      style={{
        display: "flex", alignItems: "center", gap: 8, marginTop, padding: "8px 10px", borderRadius: 8,
        border: `1px solid ${color.border}`, background: color.panel2, color: color.text, textDecoration: "none",
        fontFamily: font.mono, fontSize: 12,
      }}
    >
      <span aria-hidden style={{ opacity: 0.7 }}>📎</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{media.fileName}</span>
    </a>
  );
}

// ── Companion "typing" affordance while a reply is awaited ────────────────────────
function TypingIndicator({ title }: { title: string }) {
  return (
    <div style={{ display: "flex", gap: 10, marginTop: 14, alignItems: "flex-start" }} aria-label={`${title} is replying`} role="status">
      <Avatar label={initials(title)} rowGap={false} />
      <div style={{ display: "flex", gap: 4, alignItems: "center", padding: "10px 13px", borderRadius: 12, borderBottomLeftRadius: 4, background: color.panel2, border: `1px solid ${color.border}` }}>
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
    <div style={{ margin: "auto", textAlign: "center", display: "flex", flexDirection: "column", gap: 10, alignItems: "center", color: color.textMuted, padding: 40, maxWidth: 340 }}>
      <span aria-hidden style={{ width: 52, height: 52, borderRadius: 12, display: "grid", placeItems: "center", fontSize: 22, color: color.phosphor, background: color.phosphorDim, border: "1px solid rgba(46,230,110,0.3)" }}>◇</span>
      <span style={{ fontFamily: font.head, textTransform: "uppercase", letterSpacing: "0.08em", fontSize: 12, color: color.textDim }}>
        Say hello
      </span>
      <span style={{ fontSize: 12, lineHeight: 1.7 }}>
        {connected
          ? `Start a conversation with ${title}. Messages and replies show up here — grouped by sender, marked by time, and always anchored to the latest.`
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
// reusing the exact timeline rendering (day dividers + grouping + channel badge + 🎤 voice indicator) the
// live chat uses.
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
// Fetches the one conversation's full unified message list and renders it with the SAME timeline the live
// chat uses (day dividers + grouping + channel badge + 🎤 voice indicator preserved). No composer — a past
// conversation is immutable.
function PastConversationView({ sessionId, seq, title, onBack }: {
  sessionId: string; seq: number; title: string; onBack: () => void;
}) {
  const q = useQuery({
    queryKey: ["companionConversation", sessionId, seq],
    queryFn: () => api.companionConversation(sessionId, seq),
  });
  const messages: ChatMessage[] = (q.data?.messages ?? []).map(historyMessage);
  const timeline = buildTimeline(messages);

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0, gap: 12 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Button variant="ghost" onClick={onBack} style={{ padding: "4px 8px" }} title="Return to the live chat">← Live chat</Button>
        <span style={{ flex: 1, minWidth: 0, fontFamily: font.head, fontSize: 12, textTransform: "uppercase", letterSpacing: "0.08em", color: color.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {q.data ? formatConversationTime(q.data.conversation.startedAt) : "Conversation"}
        </span>
        <StatusPill tone="cyan" label="read-only" />
      </div>

      <div style={{ flex: 1, minHeight: 0, maxHeight: SCROLL_MAX_HEIGHT, overflowY: "auto", display: "flex", flexDirection: "column", padding: "6px 14px 10px" }}>
        {q.isLoading ? (
          <div style={{ margin: "auto", color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>Loading…</div>
        ) : q.isError ? (
          <div style={{ margin: "auto", color: color.red, fontFamily: font.mono, fontSize: 12 }}>{(q.error as Error).message}</div>
        ) : timeline.length === 0 ? (
          <div style={{ margin: "auto", color: color.textMuted, fontFamily: font.mono, fontSize: 12 }}>This conversation has no messages.</div>
        ) : (
          <Timeline items={timeline} title={title} />
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
