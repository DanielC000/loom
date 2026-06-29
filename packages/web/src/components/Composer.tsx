import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Button, Select, StatusPill, Panel, SectionLabel, Chip } from "./ui";
import { color, font } from "../theme";
import { useSpeechRecognition, type SpeechRecognitionApi } from "../lib/useSpeechRecognition";
import { useVoiceLang, voiceLangOptions } from "../lib/useVoiceLang";
import { getDraft, setDraft, clearDraft } from "../lib/composerDrafts";

// Reliable "send a turn" box: posts through the daemon's busy-gated enqueue (auto-Enter, queues
// if a turn is in flight) so a human send and the programmatic worker_report enqueue can't collide.
// This is the single coordinated input path — distinct from the raw xterm keystroke channel.
export function Composer({ sessionId }: { sessionId: string }) {
  // Lazy initializer reads the per-session draft store so the text SURVIVES this component being
  // remounted (the maximize/minimize layout swap unmounts + remounts the tile) AND round-trips with
  // ZERO loss between the inline box and the expand-to-large editor below — both render from this one
  // `text` state, so there is no second copy to drift. writeText keeps the store in sync on every edit;
  // a successful send clears both (see onSuccess).
  const [text, setText] = useState(() => getDraft(sessionId));
  const [status, setStatus] = useState<string | null>(null);
  // The large-editor overlay. It shares EVERYTHING below (text/send/speech) with the inline box, so
  // toggling it never copies or risks losing the draft — it is the same component, just a roomier view.
  const [expanded, setExpanded] = useState(false);

  // Mirror every text change into the per-session draft store. Accepts a value or an updater (voice
  // append uses the functional form). The store write is idempotent, so a StrictMode double-invoke
  // is harmless.
  const writeText = (next: string | ((prev: string) => string)) => {
    setText((prev) => {
      const value = typeof next === "function" ? next(prev) : next;
      setDraft(sessionId, value);
      return value;
    });
  };

  const send = useMutation({
    mutationFn: (t: string) => api.sendInput(sessionId, t),
    onSuccess: (r) => {
      if (r.delivered) { setStatus("sent"); setText(""); clearDraft(sessionId); setExpanded(false); }
      else if (r.position) { setStatus(`queued #${r.position} — sends when the turn ends`); setText(""); clearDraft(sessionId); setExpanded(false); }
      else setStatus("session not live");
    },
    onError: () => setStatus("failed"),
  });
  const submit = () => { if (text.trim()) send.mutate(text); };
  const onComposeKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
  };

  // GLOBAL voice-input language (shared across every mounted composer, persisted; default =
  // navigator.language). Threaded into the recognizer below; it applies on the NEXT start().
  const [voiceLang, setVoiceLang] = useVoiceLang();

  // Voice input → APPEND each finalized transcript chunk to the box (never clobber typed text, never
  // auto-send). The user reviews and sends via the SAME path above. ONE recognizer feeds both the
  // inline box and the large editor (the controls are rendered in both places from this instance).
  const speech = useSpeechRecognition({
    lang: voiceLang,
    onFinalTranscript: (chunk) => {
      const piece = chunk.trim();
      if (!piece) return;
      writeText((prev) => (prev ? `${prev.replace(/\s+$/, "")} ${piece}` : piece));
      setStatus(null);
    },
  });

  const voiceCluster = speech.supported ? (
    // Voice + language picker share ONE row so adding the selector doesn't grow the footprint (the
    // terminal pane is flex:1 — extra height here would resize/rescale the xterm).
    <div style={{ display: "flex", gap: 4, alignItems: "stretch" }}>
      <MicButton speech={speech} />
      <VoiceLangSelect
        lang={voiceLang}
        setLang={setVoiceLang}
        disabled={speech.status === "listening" || speech.status === "requesting"}
      />
    </div>
  ) : null;

  return (
    <div style={{ marginTop: 3 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
        <div style={{ flex: 1, position: "relative", display: "flex" }}>
          <textarea
            value={text}
            onChange={(e) => { writeText(e.target.value); setStatus(null); }}
            onKeyDown={onComposeKey}
            placeholder="Send a turn to this session…  (Ctrl/Cmd+Enter)"
            // FIXED footprint: resize is off (a draggable box could eat the terminal's space) and the
            // height is pinned to ~2 lines via minHeight while flex-stretch matches the controls column.
            // Constant height ⇒ the flex:1 terminal pane never rescales (Terminal.tsx's ResizeObserver).
            style={{ flex: 1, resize: "none", minHeight: 44, boxSizing: "border-box", background: color.panel2, color: color.text, border: `1px solid ${color.borderStrong}`, borderRadius: 4, padding: "6px 30px 6px 8px", fontFamily: font.mono, fontSize: 13 }}
          />
          <ExpandButton onClick={() => setExpanded(true)} />
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, justifyContent: "flex-end", width: 176 }}>
          {voiceCluster}
          <Button variant="primary" disabled={!text.trim() || send.isPending} onClick={submit}>Send turn</Button>
        </div>
      </div>
      {/* ONE status line beneath the box, ALWAYS rendered at a reserved height: it carries both the
          send result and the live voice state, so neither can pop into existence and jolt the layout. */}
      <ComposerStatusLine speech={speech} sendStatus={status} />

      {expanded && (
        <LargeEditor
          sessionId={sessionId}
          text={text}
          onChange={(v) => { writeText(v); setStatus(null); }}
          onKeyDown={onComposeKey}
          onSubmit={submit}
          sending={send.isPending}
          onClose={() => setExpanded(false)}
          voiceCluster={voiceCluster}
          statusLine={<ComposerStatusLine speech={speech} sendStatus={status} />}
        />
      )}
    </div>
  );
}

// Small unobtrusive corner affordance over the textarea: opens the large editor. Pure-icon, ghost
// styling so it recedes until hovered; absolutely positioned so it adds ZERO height to the composer.
function ExpandButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      title="Expand to a larger editor"
      aria-label="Expand to a larger editor"
      onClick={onClick}
      style={{ position: "absolute", top: 4, right: 4, padding: "2px 4px", lineHeight: 0, display: "inline-flex", alignItems: "center", justifyContent: "center" }}
    >
      <ExpandIcon />
    </Button>
  );
}

// 12px maximize-corners glyph drawn as SVG (renders crisply at any font; no glyph-coverage gamble).
function ExpandIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden focusable="false">
      <path d="M4.5 1.5H1.5V4.5" />
      <path d="M7.5 1.5H10.5V4.5" />
      <path d="M4.5 10.5H1.5V7.5" />
      <path d="M7.5 10.5H10.5V7.5" />
    </svg>
  );
}

// The expand-to-large editor: a top-anchored overlay with a roomy textarea for composing a longer
// message. It is NOT a second composer — it renders from the parent's single `text`/send/speech, so
// the draft round-trips with zero loss and submitting takes the same busy-gated path. Restore via the
// Collapse button, a backdrop click, or Esc — all non-destructive (the draft stays in state + store).
function LargeEditor({
  sessionId, text, onChange, onKeyDown, onSubmit, sending, onClose, voiceCluster, statusLine,
}: {
  sessionId: string;
  text: string;
  onChange: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  onSubmit: () => void;
  sending: boolean;
  onClose: () => void;
  voiceCluster: React.ReactNode;
  statusLine: React.ReactNode;
}) {
  // Esc closes — bound in the CAPTURE phase so it consumes the key BEFORE the tile's window-level
  // Escape handler (which restores a maximized tile) can also fire; otherwise one Esc would collapse
  // both. Focus the textarea on open with the caret at the end of the existing draft.
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); onClose(); }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  useEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    ta.focus();
    const end = ta.value.length;
    ta.setSelectionRange(end, end);
  }, []);

  return (
    <div
      className="loom-overlay-in"
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.66)", display: "flex", alignItems: "flex-start", justifyContent: "center", zIndex: 60, padding: 16, paddingTop: "7vh" }}
      onClick={onClose}
    >
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(860px, 92vw)" }}>
        <Panel style={{ display: "flex", flexDirection: "column", gap: 8, maxHeight: "82vh" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
            <SectionLabel style={{ margin: 0 }}>Compose message</SectionLabel>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <Chip label="session" value={sessionId.slice(0, 8)} />
              <Button variant="ghost" title="Collapse to the inline composer (Esc)" onClick={onClose}>Collapse</Button>
            </div>
          </div>
          <textarea
            ref={taRef}
            value={text}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Compose a longer message…  (Ctrl/Cmd+Enter to send)"
            style={{ flex: 1, minHeight: 320, resize: "vertical", boxSizing: "border-box", background: color.panel2, color: color.text, border: `1px solid ${color.borderStrong}`, borderRadius: 4, padding: "10px 12px", fontFamily: font.mono, fontSize: 13, lineHeight: 1.5 }}
          />
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 8 }}>
            <div>{voiceCluster}</div>
            <Button variant="primary" disabled={!text.trim() || sending} onClick={onSubmit}>Send turn</Button>
          </div>
          {statusLine}
        </Panel>
      </div>
    </div>
  );
}

// Click-only mic toggle (kept OUTSIDE the .xterm subtree so it never perturbs terminal focus/scroll).
// Idle → click to record; listening → red pulse + click to stop. Disabled in an insecure context.
function MicButton({ speech }: { speech: SpeechRecognitionApi }) {
  const listening = speech.status === "listening";
  const requesting = speech.status === "requesting";
  const active = listening || requesting;
  const title = !speech.secure
    ? "Voice input needs a secure context (https or localhost)"
    : listening
      ? "Stop recording"
      : "Record voice — the transcript appends to the box (review, then Send)";
  return (
    <Button
      type="button"
      variant={listening ? "danger" : "default"}
      disabled={!speech.secure || requesting}
      title={title}
      onClick={active ? speech.stop : speech.start}
      style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", gap: 6 }}
    >
      <span
        className={listening ? "loom-mic-pulse" : undefined}
        style={{ width: 7, height: 7, borderRadius: 7, display: "inline-block", background: listening ? color.red : color.phosphor }}
      />
      {listening ? "Stop" : requesting ? "starting…" : "Voice"}
    </Button>
  );
}

// Compact BCP-47 language picker for voice dictation, sitting beside the Voice button. Disabled while
// a recording is live — the choice applies on the NEXT start() (the hook reads `lang` at start, never
// hot-swapping mid-recording). The persisted `lang` is always injected as an option if it isn't one
// of the curated tags, so the controlled <select> always has a matching value.
function VoiceLangSelect({ lang, setLang, disabled }: { lang: string; setLang: (l: string) => void; disabled: boolean }) {
  const options = voiceLangOptions();
  const all = options.some((o) => o.tag === lang) ? options : [{ tag: lang, label: lang }, ...options];
  return (
    <Select
      aria-label="Voice recognition language"
      title={disabled ? "Language applies to the next recording" : "Voice recognition language"}
      value={lang}
      disabled={disabled}
      onChange={(e) => setLang(e.target.value)}
      style={{ flex: 1, minWidth: 0, fontSize: 11, padding: "2px 4px" }}
    >
      {all.map((o) => (
        <option key={o.tag} value={o.tag}>{o.label}</option>
      ))}
    </Select>
  );
}

// One muted line beneath the box, ALWAYS rendered at a reserved minHeight so it never changes the
// composer's footprint (a constant footprint matters because the terminal pane is flex:1: any height
// change here resizes the pane → Terminal.tsx's ResizeObserver rescales the xterm font). It carries
// the live voice recognition state when a recording is active/terminal, otherwise the send result.
function ComposerStatusLine({ speech, sendStatus }: { speech: SpeechRecognitionApi; sendStatus: string | null }) {
  const { status, interim, error, secure, supported } = speech;
  let node: React.ReactNode = null;
  if (supported && !secure) {
    node = <span style={{ color: color.amber }}>voice needs a secure context</span>;
  } else if (status === "requesting") {
    node = <span style={{ color: color.textDim }}>requesting microphone…</span>;
  } else if (status === "listening") {
    node = (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
        <StatusPill tone="red" label="rec" glow />
        {interim
          ? <span style={{ color: color.textMuted, fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{interim}…</span>
          : <span style={{ color: color.textDim }}>listening — speak, then Stop</span>}
      </span>
    );
  } else if (status === "denied") {
    node = <span style={{ color: color.red }}>mic permission denied — allow it in your browser site settings</span>;
  } else if (status === "error") {
    node = <span style={{ color: color.red }}>{error ?? "voice error"} — click Voice to retry</span>;
  } else if (sendStatus) {
    node = <span style={{ color: color.textMuted }}>{sendStatus}</span>;
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4, fontFamily: font.mono, fontSize: 10, minHeight: 18 }}>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{node}</span>
    </div>
  );
}
