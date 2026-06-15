import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { useQuery, useQueries, useMutation, useQueryClient } from "@tanstack/react-query";
import type { SessionListItem, ShellTerminal, Task } from "@loom/shared";
import { api } from "../lib/api";
import { byCreatedStable, byManagerThenCreated } from "../lib/sessions";
import { TerminalPane } from "../components/Terminal";
import { SessionWakes } from "../components/SessionWakes";
import { SessionQueue } from "../components/SessionQueue";
import { SessionTaskCard } from "../components/SessionTaskCard";
import { TerminalTile } from "../components/TerminalTile";
import { Panel, Button, Select, Input, StatusPill, SectionLabel } from "../components/ui";
import { color, font } from "../theme";

// Tiles flow horizontally then wrap; reused per manager row and the catch-all rows.
const gridStyle: CSSProperties = { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(560px, 1fr))", gap: 12 };

// One rendered row of the Claude-sessions grid. A "manager" row = its manager tile first then the
// workers it parented; "orphans"/"standalone" are the trailing catch-all rows (see the `rows` memo).
type SessionRow = { key: string; kind: "manager" | "orphans" | "standalone"; list: SessionListItem[] };

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
  // Resolve the board task each BOUND session is working on (web-only, no daemon change → HMR-live):
  // fetch tasks for each distinct project that owns a bound session via the existing api.tasks, then
  // index by id. A tile reads its thin card from this map; an id that doesn't resolve (deleted task,
  // or tasks not yet loaded) is simply absent → that tile renders no card (graceful).
  const boundProjectIds = useMemo(
    () => [...new Set(live.filter((s) => s.taskId).map((s) => s.projectId))],
    [live],
  );
  const taskQueries = useQueries({
    queries: boundProjectIds.map((pid) => ({ queryKey: ["tasks", pid], queryFn: () => api.tasks(pid), staleTime: 4000 })),
  });
  const tasksById = new Map<string, Task>();
  for (const q of taskQueries) for (const t of q.data ?? []) tasksById.set(t.id, t);
  // Tile order: the STABLE shared key (lib/sessions.ts byManagerThenCreated) — managers first, then
  // createdAt DESC (newest first), tiebreak by id within each bucket. A session keeps its slot whether
  // it's busy or idle, so the grid never reshuffles on a poll (the old activity sort made rows jump).
  // Shared with Overview so the two flat live-grids can't drift.
  const shown = (filter ? live.filter((s) => s.projectName === filter) : live)
    .slice().sort(byManagerThenCreated);
  // Manager-centric layout: one ROW per manager — the manager tile leftmost, then ITS workers to
  // the right ordered newest→oldest (createdAt DESC). Workers attach to their manager via
  // parentSessionId. Two catch-all rows trail the manager rows so nothing is dropped: orphan workers
  // (parent absent from the live set — a recycled/stopped manager) and standalone sessions (no role /
  // no parent — plain human sessions, platform leads — which must never anchor a manager row).
  // Manager rows are ordered by a STABLE key (manager createdAt DESC, tiebreak id, via `shown`) so a
  // row never jumps when its manager/workers flip busy↔idle. Computed from `shown` (already in that
  // stable order), so the same layout holds inside a project filter.
  const rows = useMemo<SessionRow[]>(() => {
    const managers = shown.filter((s) => s.role === "manager");
    const managerIds = new Set(managers.map((m) => m.id));
    const workersByParent = new Map<string, SessionListItem[]>();
    const orphans: SessionListItem[] = [];
    const standalone: SessionListItem[] = [];
    for (const s of shown) {
      if (s.role === "manager") continue;
      const pid = s.parentSessionId ?? null;
      if (s.role === "worker" || pid) {
        if (pid && managerIds.has(pid)) (workersByParent.get(pid) ?? workersByParent.set(pid, []).get(pid)!).push(s);
        else orphans.push(s); // parent stopped/recycled or not a live manager — don't drop it
      } else standalone.push(s); // no role / platform lead — its own trailing row
    }
    // `managers` is already in stable createdAt/id order (from `shown`), so the rows are too — no
    // re-sort, and a row holds its slot regardless of activity. Nested workers + the catch-all rows
    // use the same shared stable key (byCreatedStable) so nothing reshuffles on a poll.
    const managerRows: SessionRow[] = managers
      .map((m) => ({ key: m.id, kind: "manager" as const, list: [m, ...(workersByParent.get(m.id) ?? []).slice().sort(byCreatedStable)] }));
    const trailing: SessionRow[] = [];
    if (orphans.length) trailing.push({ key: "__orphans", kind: "orphans", list: orphans.slice().sort(byCreatedStable) });
    if (standalone.length) trailing.push({ key: "__standalone", kind: "standalone", list: standalone.slice().sort(byCreatedStable) });
    return [...managerRows, ...trailing];
  }, [shown]);

  const renderTile = (s: SessionListItem) => {
    const task = s.taskId ? tasksById.get(s.taskId) : undefined;
    return (
      <TerminalTile key={s.id} s={s} height={540} showProject
        onFork={() => fork.mutate(s.id)} forkPending={fork.isPending}
        onStop={() => stop.mutate(s.id)} stopPending={stop.isPending}
        onMaximize={() => setMaximized(s.id)}
        taskCard={task && <SessionTaskCard task={task} />}
        footer={<><SessionWakes sessionId={s.id} /><SessionQueue sessionId={s.id} /></>} />
    );
  };

  if (maximized) {
    const s = live.find((x) => x.id === maximized);
    const task = s?.taskId ? tasksById.get(s.taskId) : undefined;
    return (
      <div>
        <Button onClick={() => setMaximized(null)}>← back to grid</Button>
        {s && (
          <div style={{ marginTop: 8 }}>
            <TerminalTile s={s} height="84vh" showProject
              onFork={() => fork.mutate(s.id)} forkPending={fork.isPending}
              onStop={() => stop.mutate(s.id)} stopPending={stop.isPending}
              taskCard={task && <SessionTaskCard task={task} />}
              footer={<><SessionWakes sessionId={s.id} /><SessionQueue sessionId={s.id} /></>} />
          </div>
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
      {rows.map((row) => (
        <section key={row.key} style={{ marginBottom: 20 }}>
          <RowHeader row={row} />
          <div style={gridStyle}>{row.list.map(renderTile)}</div>
        </section>
      ))}
    </div>
  );
}

// Header for one Claude-sessions row. A manager row names its manager (project · agent · id) and the
// worker count; the catch-all rows get a plain descriptive label + member count.
function RowHeader({ row }: { row: SessionRow }) {
  if (row.kind === "manager") {
    const m = row.list[0]!; // a manager row is built as [manager, ...workers], so [0] always exists
    const workers = row.list.length - 1;
    return (
      <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <StatusPill tone={m.busy ? "amber" : "phosphor"} glow={m.busy} label="manager" />
        <span style={{ fontFamily: font.mono, textTransform: "none", letterSpacing: 0 }}>
          {m.projectName} · {m.agentName} · {m.id.slice(0, 8)}
        </span>
        <span style={{ color: color.textMuted, fontWeight: 400 }}>({workers} worker{workers === 1 ? "" : "s"})</span>
      </SectionLabel>
    );
  }
  const label = row.kind === "orphans"
    ? "Orphan workers — parent manager stopped or recycled"
    : "Standalone sessions";
  return (
    <SectionLabel style={{ display: "flex", alignItems: "center", gap: 8 }}>
      {label}
      <span style={{ color: color.textMuted, fontWeight: 400 }}>({row.list.length})</span>
    </SectionLabel>
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
  // Kill hard-terminates the process tree, so gate it behind an inline confirm — mirrors the
  // Schedules/Profiles/Skills delete pattern (a confirm/cancel pair in place of the action button).
  const [confirmKill, setConfirmKill] = useState(false);
  return (
    <Panel style={{ height: 460, padding: 6, display: "flex", flexDirection: "column" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontFamily: font.mono, fontSize: 12, color: color.textDim }}>
          <StatusPill tone="phosphor" label="shell" />
          <span title={`${t.command}\n${t.cwd}`}>{t.label} · {t.id.slice(0, 8)}</span>
        </span>
        {confirmKill ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <span style={{ color: color.red, fontSize: 12, fontFamily: font.mono }}>kill shell?</span>
            <Button variant="danger" style={{ padding: "0 8px" }} disabled={killing}
              onClick={(ev) => { ev.stopPropagation(); onKill(); }}>Confirm</Button>
            <Button style={{ padding: "0 8px" }}
              onClick={(ev) => { ev.stopPropagation(); setConfirmKill(false); }}>Cancel</Button>
          </span>
        ) : (
          <Button variant="danger" style={{ padding: "0 8px" }} disabled={killing}
            title="Kill this shell — hard terminate the process tree"
            onClick={(ev) => { ev.stopPropagation(); setConfirmKill(true); }}>Kill</Button>
        )}
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
