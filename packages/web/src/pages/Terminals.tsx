import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SessionListItem, ShellTerminal } from "@loom/shared";
import { api } from "../lib/api";
import { bySessionActivity, mostRecentActivity } from "../lib/sessions";
import { TerminalPane } from "../components/Terminal";
import { SessionWakes } from "../components/SessionWakes";
import { SessionQueue } from "../components/SessionQueue";
import { Panel, Button, Select, Input, StatusPill, SectionLabel } from "../components/ui";
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
  // Tile order: the shared activity comparator (live-first → most-recent-active → spawn-order), so
  // the session you're driving floats up, consistent with every other session list.
  const shown = (filter ? live.filter((s) => s.projectName === filter) : live)
    .slice().sort(bySessionActivity);
  // When unfiltered ("All"), bucket the tiles by project so each project becomes its own horizontal
  // group under a header. Within-group order follows the activity sort above; the lanes themselves
  // rank by their most-recent-active member, so the busiest project sits up top.
  const groups = useMemo(() => {
    const m = new Map<string, SessionListItem[]>();
    for (const s of shown) (m.get(s.projectName) ?? m.set(s.projectName, []).get(s.projectName)!).push(s);
    return [...m.entries()].sort((a, b) => mostRecentActivity(b[1]) - mostRecentActivity(a[1]));
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
      <ShellsSection />
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

// Plain shell terminals (human-spawned pwsh/cmd/bash in a repo cwd). A separate lane above the Claude
// sessions — different lifecycle (ephemeral, not a DB Session) and a resizable xterm.
function ShellsSection() {
  const qc = useQueryClient();
  const [spawning, setSpawning] = useState(false);
  const shells = useQuery({ queryKey: ["terminals"], queryFn: api.terminals, refetchInterval: 4000 });
  const kill = useMutation({
    mutationFn: (id: string) => api.killTerminal(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["terminals"] }),
  });
  const live = (shells.data ?? []).filter((t) => t.alive);

  return (
    <section style={{ marginBottom: 20 }}>
      <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
        Shells
        <span style={{ color: color.textMuted, fontWeight: 400 }}>({live.length})</span>
        <Button variant="primary" style={{ padding: "0 8px", marginLeft: 4 }} onClick={() => setSpawning(true)}>+ Shell</Button>
      </SectionLabel>
      {live.length === 0 && <p style={{ color: color.textMuted, marginTop: 0 }}>No shells. Open one in a project's repo with “+ Shell”.</p>}
      {live.length > 0 && (
        <div style={gridStyle}>
          {live.map((t) => <ShellTile key={t.id} t={t} onKill={() => kill.mutate(t.id)} killing={kill.isPending} />)}
        </div>
      )}
      {spawning && <SpawnShellModal onClose={() => setSpawning(false)} />}
    </section>
  );
}

function ShellTile({ t, onKill, killing }: { t: ShellTerminal; onKill: () => void; killing: boolean }) {
  return (
    <Panel style={{ height: 460, padding: 6, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: font.mono, fontSize: 12, color: color.textDim }}>
          <StatusPill tone="phosphor" label="shell" />
          <span title={`${t.command}\n${t.cwd}`}>{t.label} · {t.id.slice(0, 8)}</span>
        </span>
        <Button variant="danger" style={{ padding: "0 8px" }} disabled={killing}
          title="Kill this shell — hard terminate the process tree"
          onClick={(ev) => { ev.stopPropagation(); onKill(); }}>Kill</Button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}><TerminalPane sessionId={t.id} resizable /></div>
    </Panel>
  );
}

// "+ Shell" modal: pick a project (cwd = its repoPath), an executable (prefilled with the host's
// detected default), and optional args. The spawn is a HUMAN-only REST call (never an MCP tool).
function SpawnShellModal({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const defaultShell = useQuery({ queryKey: ["defaultShell"], queryFn: api.defaultShell });
  const [projectId, setProjectId] = useState("");
  const [command, setCommand] = useState("");
  const [argsText, setArgsText] = useState("");

  // Prefill once the queries land: first project + the host default shell.
  useEffect(() => { const first = projects.data?.[0]; if (!projectId && first) setProjectId(first.id); }, [projects.data, projectId]);
  useEffect(() => { if (!command && defaultShell.data?.command) setCommand(defaultShell.data.command); }, [defaultShell.data, command]);

  const create = useMutation({
    mutationFn: () => api.createTerminal({
      projectId,
      command: command.trim() || undefined,
      args: argsText.trim() ? argsText.trim().split(/\s+/) : undefined,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["terminals"] }); onClose(); },
  });

  const overlay: CSSProperties = { position: "fixed", inset: 0, background: "rgba(0,0,0,0.6)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 50 };
  const box: CSSProperties = { width: 520, maxWidth: "90vw", padding: 16, background: color.panel, border: `1px solid ${color.border}`, borderRadius: 6 };
  const labelStyle: CSSProperties = { fontFamily: font.head, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textDim, display: "block", marginBottom: 4 };

  return (
    <div style={overlay} onClick={onClose}>
      <div style={box} onClick={(e) => e.stopPropagation()}>
        <SectionLabel>Open a shell</SectionLabel>
        <div style={{ marginBottom: 10 }}>
          <label style={labelStyle}>Project (cwd = its repo)</label>
          <Select value={projectId} onChange={(e) => setProjectId(e.target.value)} style={{ width: "100%" }}>
            {(projects.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </div>
        <div style={{ marginBottom: 10 }}>
          <label style={labelStyle}>Executable</label>
          <Input value={command} onChange={(e) => setCommand(e.target.value)} placeholder="pwsh / bash / …" style={{ width: "100%" }} />
        </div>
        <div style={{ marginBottom: 14 }}>
          <label style={labelStyle}>Args (optional, space-separated)</label>
          <Input value={argsText} onChange={(e) => setArgsText(e.target.value)} placeholder="-NoLogo" style={{ width: "100%" }} />
        </div>
        {create.isError && <p style={{ color: color.red, fontSize: 12 }}>Failed to spawn — check the executable path.</p>}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!projectId || create.isPending} onClick={() => create.mutate()}>
            {create.isPending ? "Opening…" : "Open shell"}
          </Button>
        </div>
      </div>
    </div>
  );
}
