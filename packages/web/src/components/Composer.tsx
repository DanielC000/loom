import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Button, StatusPill } from "./ui";
import { color, font } from "../theme";
import { useSpeechRecognition, type SpeechRecognitionApi } from "../lib/useSpeechRecognition";

// Reliable "send a turn" box: posts through the daemon's busy-gated enqueue (auto-Enter, queues
// if a turn is in flight) so a human send and the programmatic worker_report enqueue can't collide.
// This is the single coordinated input path — distinct from the raw xterm keystroke channel.
export function Composer({ sessionId }: { sessionId: string }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState<string | null>(null);

  const send = useMutation({
    mutationFn: (t: string) => api.sendInput(sessionId, t),
    onSuccess: (r) => {
      if (r.delivered) { setStatus("sent"); setText(""); }
      else if (r.position) { setStatus(`queued #${r.position} — sends when the turn ends`); setText(""); }
      else setStatus("session not live");
    },
    onError: () => setStatus("failed"),
  });
  const submit = () => { if (text.trim()) send.mutate(text); };

  // Voice input → APPEND each finalized transcript chunk to the box (never clobber typed text, never
  // auto-send). The user reviews and sends via the SAME path above. The hook is click-driven only.
  const speech = useSpeechRecognition({
    onFinalTranscript: (chunk) => {
      const piece = chunk.trim();
      if (!piece) return;
      setText((prev) => (prev ? `${prev.replace(/\s+$/, "")} ${piece}` : piece));
      setStatus(null);
    },
  });

  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: "flex", gap: 6, alignItems: "stretch" }}>
        <textarea
          value={text}
          onChange={(e) => { setText(e.target.value); setStatus(null); }}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }}
          placeholder="Send a turn to this session…  (Ctrl/Cmd+Enter)"
          rows={2}
          style={{ flex: 1, resize: "vertical", boxSizing: "border-box", background: color.panel2, color: color.text, border: `1px solid ${color.borderStrong}`, borderRadius: 4, padding: "6px 8px", fontFamily: font.mono, fontSize: 13 }}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 4, justifyContent: "flex-end", width: 130 }}>
          {status && <span style={{ fontFamily: font.mono, fontSize: 10, color: color.textMuted }}>{status}</span>}
          {speech.supported && <MicButton speech={speech} />}
          <Button variant="primary" disabled={!text.trim() || send.isPending} onClick={submit}>Send turn</Button>
        </div>
      </div>
      {speech.supported && <VoiceStatusLine speech={speech} />}
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

// One muted line beneath the box: live recognition state on the left + the standing privacy note on
// the right. minHeight reserves the row so showing/clearing it never shifts the composer layout.
function VoiceStatusLine({ speech }: { speech: SpeechRecognitionApi }) {
  const { status, interim, error, secure } = speech;
  let node: React.ReactNode = null;
  if (!secure) {
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
  }
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 4, fontFamily: font.mono, fontSize: 10, minHeight: 13 }}>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{node}</span>
      <span style={{ color: color.textMuted, whiteSpace: "nowrap" }}>uses browser speech recognition</span>
    </div>
  );
}
