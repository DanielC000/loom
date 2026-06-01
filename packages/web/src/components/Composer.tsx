import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Button } from "./ui";
import { color, font } from "../theme";

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

  return (
    <div style={{ display: "flex", gap: 6, marginTop: 6, alignItems: "stretch" }}>
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
        <Button variant="primary" disabled={!text.trim() || send.isPending} onClick={submit}>Send turn</Button>
      </div>
    </div>
  );
}
