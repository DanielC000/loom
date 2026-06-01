import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { TerminalPane } from "../components/Terminal";
import { card, btn, input } from "../ui";

// Global Live Terminals grid: all running sessions, with a project filter, tiled, maximizable.
// Also reachable per-project by pre-selecting the filter.
export default function Terminals() {
  const [filter, setFilter] = useState<string>("");      // projectName filter ("" = all)
  const [maximized, setMaximized] = useState<string | null>(null);

  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions, refetchInterval: 4000 });
  const live = (sessions.data ?? []).filter((s) => s.processState === "live");
  const projectNames = useMemo(() => [...new Set(live.map((s) => s.projectName))].sort(), [live]);
  // Stable tile order: sort by spawn time so a tile keeps its place once spawned. (The backend
  // lists sessions by last_activity DESC, which would otherwise reshuffle tiles on every prompt.)
  const shown = (filter ? live.filter((s) => s.projectName === filter) : live)
    .slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  if (maximized) {
    const s = live.find((x) => x.id === maximized);
    return (
      <div>
        <button style={btn} onClick={() => setMaximized(null)}>← back to grid</button>
        {s && <div style={{ ...card, height: "78vh", padding: 6, marginTop: 8 }}>
          <div style={{ color: "#9ad", fontSize: 12, marginBottom: 4 }}>{s.projectName} · {s.topicName}{s.role ? ` · ${s.role}` : ""} · {s.id.slice(0, 8)}</div>
          <TerminalPane sessionId={s.id} />
        </div>}
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        Project:{" "}
        <select style={input} value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All ({live.length})</option>
          {projectNames.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </div>
      {shown.length === 0 && <p style={{ color: "#777" }}>No running sessions.</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(560px, 1fr))", gap: 12 }}>
        {shown.map((s) => (
          <div key={s.id} style={{ ...card, height: 460, padding: 6, display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#9ad", marginBottom: 4 }}>
              <span>{s.projectName} · {s.topicName}{s.role ? ` · ${s.role}` : ""} · {s.id.slice(0, 8)}</span>
              <button style={{ ...btn, padding: "0 6px" }} onClick={() => setMaximized(s.id)}>⤢</button>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}><TerminalPane sessionId={s.id} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}
