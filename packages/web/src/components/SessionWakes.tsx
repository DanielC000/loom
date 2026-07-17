import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { Wake } from "@loom/shared";
import { api } from "../lib/api";
import { Dot } from "./ui";
import { color, font } from "../theme";

// Shows a session's pending scheduled wake-ups / nudges (the wake_me primitive) under its terminal,
// each cancellable. Renders nothing when there are none, so it stays out of the way.
export function SessionWakes({
  sessionId, wakes: bulkWakes, onCancelled,
}: {
  sessionId: string;
  /** Pre-fetched wake list from a shared parent-level bulk query (Overview/Terminals batching — see
   * useSessionWakesBulk). When supplied, this card skips its own per-session 15s poll entirely. */
  wakes?: Wake[];
  /** Called after a cancel settles, in place of invalidating this card's own per-session query — only
   * meaningful (and required) alongside `wakes`, whose owning bulk query this card doesn't otherwise
   * know how to invalidate. */
  onCancelled?: () => void;
}) {
  const bulkMode = bulkWakes !== undefined;
  const q = useQuery({
    queryKey: ["wakes", sessionId],
    queryFn: () => api.sessionWakes(sessionId),
    refetchInterval: 15000,
    enabled: !bulkMode,
  });
  const list = [...(bulkMode ? bulkWakes! : (q.data ?? []))].sort((a, b) => a.wakeAt.localeCompare(b.wakeAt));
  if (list.length === 0) return null;
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 4 }}>
      <span style={{ fontFamily: font.head, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textMuted }}>Wakes</span>
      {list.map((w) => <WakeChip key={w.id} w={w} sessionId={sessionId} onCancelled={bulkMode ? onCancelled : undefined} />)}
    </div>
  );
}

function WakeChip({ w, sessionId, onCancelled }: { w: Wake; sessionId: string; onCancelled?: () => void }) {
  const qc = useQueryClient();
  const cancel = useMutation({
    mutationFn: () => api.cancelWake(sessionId, w.id),
    onSuccess: () => (onCancelled ? onCancelled() : qc.invalidateQueries({ queryKey: ["wakes", sessionId] })),
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
