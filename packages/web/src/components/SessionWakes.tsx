import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Wake } from "@loom/shared";
import { api } from "../lib/api";
import { Dot } from "./ui";
import { color, font } from "../theme";

// Shows a session's pending scheduled wake-ups / nudges (the wake_me primitive) under its terminal,
// each cancellable. Renders nothing when there are none, so it stays out of the way.
export function SessionWakes({ sessionId }: { sessionId: string }) {
  const wakes = useQuery({ queryKey: ["wakes", sessionId], queryFn: () => api.sessionWakes(sessionId), refetchInterval: 15000 });
  const list = [...(wakes.data ?? [])].sort((a, b) => a.wakeAt.localeCompare(b.wakeAt));
  if (list.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 4 }}>
      <span style={{ fontFamily: font.head, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textMuted }}>Wakes</span>
      {list.map((w) => <WakeChip key={w.id} w={w} sessionId={sessionId} />)}
    </div>
  );
}

function WakeChip({ w, sessionId }: { w: Wake; sessionId: string }) {
  const qc = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => api.cancelWake(sessionId, w.id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["wakes", sessionId] }),
  });
  const inMs = new Date(w.wakeAt).getTime() - Date.now();
  return (
    <span title={`"${w.note}"\nfires ${new Date(w.wakeAt).toLocaleString()} (scheduled ${new Date(w.createdAt).toLocaleString()})`}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, border: `1px solid ${color.border}`, borderRadius: 4, padding: "1px 6px 1px 8px", fontFamily: font.mono, fontSize: 11, color: color.textDim, maxWidth: 320 }}>
      <Dot tone="cyan" />
      <span style={{ color: color.cyan, whiteSpace: "nowrap" }}>wake {relTime(inMs)}</span>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>· {w.note}</span>
      <button onClick={() => cancel.mutate()} disabled={cancel.isPending} title="Cancel this wake"
        style={{ background: "none", border: "none", color: color.textMuted, cursor: "pointer", padding: "0 2px", marginLeft: 2, fontFamily: font.mono, fontSize: 13, lineHeight: 1 }}>×</button>
    </span>
  );
}

function relTime(ms: number): string {
  if (ms <= 0) return "due";
  const s = Math.round(ms / 1000);
  if (s < 90) return `in ${s}s`;
  const m = Math.round(s / 60);
  if (m < 90) return `in ${m}m`;
  const h = Math.floor(m / 60);
  return `in ${h}h ${m % 60}m`;
}
