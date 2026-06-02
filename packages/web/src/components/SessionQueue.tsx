import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { Dot } from "./ui";
import { color, font } from "../theme";

// Shows a session's QUEUED inbound messages (worker reports / turns held while it's busy or while the
// human is mid-compose) under its terminal — the counterpart to SessionWakes. They drain on their own
// (next turn boundary / reconcile tick), so this just surfaces "N waiting" as long as anything is held.
// Renders nothing when the queue is empty, so it stays out of the way.
export function SessionQueue({ sessionId }: { sessionId: string }) {
  const q = useQuery({ queryKey: ["queue", sessionId], queryFn: () => api.sessionQueue(sessionId), refetchInterval: 3000 });
  const pending = q.data?.pending ?? [];
  if (pending.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 4 }}>
      <span style={{ fontFamily: font.head, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textMuted }}>
        Queued ({pending.length})
      </span>
      {pending.map((text, i) => <QueueChip key={i} text={text} />)}
    </div>
  );
}

function QueueChip({ text }: { text: string }) {
  const preview = text.replace(/\s+/g, " ").trim();
  return (
    <span title={text}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, border: `1px solid ${color.border}`, borderRadius: 4, padding: "1px 8px", fontFamily: font.mono, fontSize: 11, color: color.textDim, maxWidth: 360 }}>
      <Dot tone="amber" />
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{preview}</span>
    </span>
  );
}
