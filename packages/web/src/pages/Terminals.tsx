import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SessionListItem } from "@loom/shared";
import { api } from "../lib/api";
import { TerminalPane } from "../components/Terminal";
import { Panel, Button, Select, StatusPill } from "../components/ui";
import { color, font } from "../theme";

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
        <Button onClick={() => setMaximized(null)}>← back to grid</Button>
        {s && (
          <Panel style={{ height: "78vh", padding: 6, marginTop: 8, display: "flex", flexDirection: "column" }}>
            <TileTitle s={s} />
            <div style={{ flex: 1, minHeight: 0 }}><TerminalPane sessionId={s.id} /></div>
          </Panel>
        )}
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: 12, display: "inline-flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: font.head, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textDim }}>Project</span>
        <Select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="">All ({live.length})</option>
          {projectNames.map((n) => <option key={n} value={n}>{n}</option>)}
        </Select>
      </div>
      {shown.length === 0 && <p style={{ color: color.textMuted }}>No running sessions.</p>}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(560px, 1fr))", gap: 12 }}>
        {shown.map((s) => (
          <Panel key={s.id} style={{ height: 460, padding: 6, display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <TileTitle s={s} />
              <Button style={{ padding: "0 6px" }} onClick={() => setMaximized(s.id)}>⤢</Button>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}><TerminalPane sessionId={s.id} /></div>
          </Panel>
        ))}
      </div>
    </div>
  );
}

function TileTitle({ s }: { s: SessionListItem }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: font.mono, fontSize: 12, color: color.textDim }}>
      <StatusPill tone={s.busy ? "amber" : "phosphor"} glow={s.busy} label={s.busy ? "busy" : "idle"} />
      <span>{s.projectName} · {s.topicName}{s.role ? ` · ${s.role}` : ""} · {s.id.slice(0, 8)}</span>
    </span>
  );
}
