import { useMemo, useState, type CSSProperties } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SessionListItem } from "@loom/shared";
import { api } from "../lib/api";
import { TerminalPane } from "../components/Terminal";
import { SessionWakes } from "../components/SessionWakes";
import { SessionQueue } from "../components/SessionQueue";
import { Panel, Button, Select, StatusPill, SectionLabel } from "../components/ui";
import { color, font } from "../theme";

// Tiles flow horizontally then wrap; reused per-project group and for a single filtered project.
const gridStyle: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(560px, 1fr))", gap: 12 };

// Global Live Terminals grid: all running sessions, with a project filter, tiled, maximizable.
// Also reachable per-project by pre-selecting the filter.
export default function Terminals() {
  const [filter, setFilter] = useState<string>("");      // projectName filter ("" = all)
  const [maximized, setMaximized] = useState<string | null>(null);

  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions, refetchInterval: 4000 });
  // Manual graceful stop (Ctrl-C ×2 — clean + resumable). On success the session leaves the live set,
  // so its tile drops out; refetch confirms. Stopping the maximized one falls back to the grid.
  const stop = useMutation({
    mutationFn: (id: string) => api.stopSession(id, "graceful"),
    onSuccess: (_r, id) => { if (maximized === id) setMaximized(null); qc.invalidateQueries({ queryKey: ["allSessions"] }); },
  });
  // Fork an idle session: branch its conversation into a fresh divergent session (appears as a new
  // tile). Idle-only — the button is disabled while the source is busy.
  const fork = useMutation({
    mutationFn: (id: string) => api.forkSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["allSessions"] }),
  });
  const live = (sessions.data ?? []).filter((s) => s.processState === "live");
  const projectNames = useMemo(() => [...new Set(live.map((s) => s.projectName))].sort(), [live]);
  // Stable tile order: sort by spawn time so a tile keeps its place once spawned. (The backend
  // lists sessions by last_activity DESC, which would otherwise reshuffle tiles on every prompt.)
  const shown = (filter ? live.filter((s) => s.projectName === filter) : live)
    .slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  // When unfiltered ("All"), bucket the tiles by project so each project becomes its own
  // horizontal group under a header. Insertion order follows the createdAt sort above; group
  // keys are then alphabetised so the lanes have a stable, predictable order.
  const groups = useMemo(() => {
    const m = new Map<string, SessionListItem[]>();
    for (const s of shown) (m.get(s.projectName) ?? m.set(s.projectName, []).get(s.projectName)!).push(s);
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [shown]);

  const renderTile = (s: SessionListItem) => (
    <Panel key={s.id} style={{ height: 460, padding: 6, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <TileTitle s={s} />
        <div style={{ display: "flex", gap: 4 }}>
          <ForkButton onFork={() => fork.mutate(s.id)} busy={s.busy} pending={fork.isPending} />
          <StopButton onStop={() => stop.mutate(s.id)} stopping={stop.isPending} />
          <Button style={{ padding: "0 6px" }} onClick={() => setMaximized(s.id)}>⤢</Button>
        </div>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}><TerminalPane sessionId={s.id} /></div>
      <SessionWakes sessionId={s.id} />
      <SessionQueue sessionId={s.id} />
    </Panel>
  );

  if (maximized) {
    const s = live.find((x) => x.id === maximized);
    return (
      <div>
        <Button onClick={() => setMaximized(null)}>← back to grid</Button>
        {s && (
          <Panel style={{ height: "78vh", padding: 6, marginTop: 8, display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <TileTitle s={s} />
              <div style={{ display: "flex", gap: 4 }}>
                <ForkButton onFork={() => fork.mutate(s.id)} busy={s.busy} pending={fork.isPending} />
                <StopButton onStop={() => stop.mutate(s.id)} stopping={stop.isPending} />
              </div>
            </div>
            <div style={{ flex: 1, minHeight: 0 }}><TerminalPane sessionId={s.id} /></div>
            <SessionWakes sessionId={s.id} />
      <SessionQueue sessionId={s.id} />
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
      {filter ? (
        <div style={gridStyle}>{shown.map(renderTile)}</div>
      ) : (
        groups.map(([name, list]) => (
          <section key={name} style={{ marginBottom: 20 }}>
            <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
              {name}
              <span style={{ color: color.textMuted, fontWeight: 400 }}>({list.length})</span>
            </SectionLabel>
            <div style={gridStyle}>{list.map(renderTile)}</div>
          </section>
        ))
      )}
    </div>
  );
}

function ForkButton({ onFork, busy, pending }: { onFork: () => void; busy: boolean; pending: boolean }) {
  return (
    <Button style={{ padding: "0 8px" }} disabled={busy || pending}
      title={busy ? "Fork is available when the session is idle" : "Fork — branch this conversation into a new divergent session"}
      onClick={(ev) => { ev.stopPropagation(); onFork(); }}>Fork</Button>
  );
}

function StopButton({ onStop, stopping }: { onStop: () => void; stopping: boolean }) {
  return (
    <Button style={{ padding: "0 8px" }} disabled={stopping}
      title="Stop this session — graceful Ctrl-C, clean and resumable"
      onClick={(ev) => { ev.stopPropagation(); onStop(); }}>Stop</Button>
  );
}

function TileTitle({ s }: { s: SessionListItem }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: font.mono, fontSize: 12, color: color.textDim }}>
      <StatusPill tone={s.busy ? "amber" : "phosphor"} glow={s.busy} label={s.busy ? "busy" : "idle"} />
      <span>{s.projectName} · {s.agentName}{s.role ? ` · ${s.role}` : ""} · {s.id.slice(0, 8)}</span>
    </span>
  );
}
