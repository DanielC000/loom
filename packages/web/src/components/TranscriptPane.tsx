import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";

// Renders Claude's session JSONL as a clean, ordered conversation — the canonical history
// surface (terminal scrollback is best-effort live-only). Refreshes periodically.
export function TranscriptPane({ sessionId }: { sessionId: string }) {
  const t = useQuery({ queryKey: ["transcript", sessionId], queryFn: () => api.transcript(sessionId), refetchInterval: 5000 });
  return (
    <div style={{ height: "100%", overflow: "auto", padding: 8 }}>
      {t.data?.length === 0 && <p style={{ color: "#777" }}>No transcript yet (engine session id not captured, or no turns).</p>}
      {t.data?.map((turn, i) => (
        <div key={i} style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 11, textTransform: "uppercase", color: turn.role === "user" ? "#8c8" : "#9ad", marginBottom: 2 }}>{turn.role}</div>
          <pre style={{ whiteSpace: "pre-wrap", margin: 0, fontFamily: "ui-monospace, Consolas, monospace", fontSize: 13, color: "#ddd" }}>{turn.text}</pre>
        </div>
      ))}
    </div>
  );
}
