import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ArchivedSessionListItem, SessionRole } from "@loom/shared";
import { api } from "../lib/api";
import { TranscriptPane } from "../components/TranscriptPane";
import { Panel, Button, Input, SectionLabel, StatusPill, Chip, Badge } from "../components/ui";
import { color, font, tone, type Tone } from "../theme";

const roleTone: Record<NonNullable<SessionRole>, Tone> = { manager: "phosphor", worker: "cyan", platform: "amber" };

// Cross-project Archive: dead/exited sessions tidied out of the Workspace rail, ACROSS ALL PROJECTS
// (god-eye via GET /api/archived-sessions). Structured as a searchable, collapsible Project → Agent
// tree (role shown), newest-archived-first within each group, in a bounded+scrollable region. View a
// session's captured transcript snapshot, Restore it to the rail (VIEW-ONLY if dead — can't resume),
// or Delete permanently (row + snapshot). NOT bound to the header's active project — it spans all.
export default function Archive() {
  const qc = useQueryClient();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [rawQuery, setRawQuery] = useState("");
  const [query, setQuery] = useState(""); // debounced
  useEffect(() => { const t = setTimeout(() => setQuery(rawQuery), 200); return () => clearTimeout(t); }, [rawQuery]);

  const archived = useQuery({
    queryKey: ["allArchived"],
    queryFn: () => api.allArchivedSessions(),
    refetchInterval: 4000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["allArchived"] });
    qc.invalidateQueries({ queryKey: ["archive"] });   // per-project archive (other views)
    qc.invalidateQueries({ queryKey: ["allSessions"] }); // god-eye views
    qc.invalidateQueries({ queryKey: ["sessions"] });    // every agent's rail
  };
  const restore = useMutation({
    mutationFn: (id: string) => api.restoreSession(id),
    onSuccess: invalidate,
    onError: (e) => window.alert((e as Error).message),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteArchivedSession(id),
    onSuccess: (_r, id) => { if (sessionId === id) setSessionId(null); invalidate(); },
    onError: (e) => window.alert((e as Error).message),
  });

  const rows = archived.data ?? [];
  // Selection resolves from the FULL list, so the transcript stays put even when search hides its row.
  const selected = rows.find((r) => r.id === sessionId) ?? null;

  // Filter (case-insensitive across id/agent/role/project/task/branch) then group Project → Agent,
  // newest-archived-first at every level (archivedAt desc, falling back to lastActivity).
  const { projects, matchCount } = useMemo(() => buildTree(rows, query), [rows, query]);

  const searching = query.trim().length > 0;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 16 }}>
      {/* LEFT: search + the grouped archive tree */}
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <SectionLabel style={{ margin: 0 }}>
            Archived sessions ({searching ? `${matchCount} of ${rows.length}` : rows.length})
          </SectionLabel>
          <span style={{ flex: 1 }} />
        </div>
        <Input
          placeholder="Search id · agent · role · project · task · branch…"
          value={rawQuery}
          onChange={(e) => setRawQuery(e.currentTarget.value)}
          style={{ marginBottom: 10 }}
        />
        <div style={{ maxHeight: "70vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 10, paddingRight: 4 }}>
          {rows.length === 0 && (
            <p style={{ color: color.textMuted, fontSize: 13 }}>
              No archived sessions. Archive an exited session from the Workspace rail to tidy it out of view.
            </p>
          )}
          {rows.length > 0 && matchCount === 0 && (
            <p style={{ color: color.textMuted, fontSize: 13 }}>No archived sessions match “{query}”.</p>
          )}
          {projects.map((p) => (
            <ProjectGroup key={p.projectId} group={p} forceOpen={searching}
              sessionId={sessionId} onSelect={setSessionId}
              onRestore={(id) => restore.mutate(id)} restoring={restore.isPending}
              onDelete={(id) => { if (window.confirm("Permanently delete this archived session and its transcript snapshot? This cannot be undone.")) del.mutate(id); }}
              deleting={del.isPending} />
          ))}
        </div>
      </div>

      {/* RIGHT: the selected session's stored transcript snapshot */}
      <div>
        <SectionLabel>{selected ? `Transcript · ${selected.id.slice(0, 8)}` : "Transcript"}</SectionLabel>
        <Panel style={{ height: "76vh", padding: 6 }}>
          {!selected && <span style={{ color: color.textMuted, fontSize: 12 }}>Select an archived session to view its stored transcript.</span>}
          {selected && !selected.snapshotExists && (
            <span style={{ color: color.textMuted, fontSize: 12 }}>
              No transcript captured — this session was already dead (its engine transcript was gone) when archived.
            </span>
          )}
          {selected && selected.snapshotExists && <TranscriptPane sessionId={selected.id} />}
        </Panel>
      </div>
    </div>
  );
}

// ── grouping ────────────────────────────────────────────────────────────────────
type AgentGroup = { agentId: string; agentName: string; roles: (SessionRole | null)[]; sessions: ArchivedSessionListItem[] };
type ProjectGroupT = { projectId: string; projectName: string; agents: AgentGroup[] };

const archTs = (s: ArchivedSessionListItem) => Date.parse(s.archivedAt ?? s.lastActivity ?? "") || 0;
const agentTs = (a: AgentGroup) => Math.max(0, ...a.sessions.map(archTs));

function buildTree(rows: ArchivedSessionListItem[], rawQuery: string): { projects: ProjectGroupT[]; matchCount: number } {
  const q = rawQuery.trim().toLowerCase();
  const match = (s: ArchivedSessionListItem) =>
    !q || [s.id, s.agentName, s.role, s.projectName, s.taskId, s.branch]
      .some((v) => v != null && String(v).toLowerCase().includes(q));
  const filtered = rows.filter(match);

  const byProject = new Map<string, { projectId: string; projectName: string; agents: Map<string, AgentGroup> }>();
  for (const s of filtered) {
    let p = byProject.get(s.projectId);
    if (!p) { p = { projectId: s.projectId, projectName: s.projectName, agents: new Map() }; byProject.set(s.projectId, p); }
    let a = p.agents.get(s.agentId);
    if (!a) { a = { agentId: s.agentId, agentName: s.agentName, roles: [], sessions: [] }; p.agents.set(s.agentId, a); }
    a.sessions.push(s);
  }

  const projects = [...byProject.values()].map((p) => {
    const agents = [...p.agents.values()].map((a) => {
      a.sessions.sort((x, y) => archTs(y) - archTs(x));
      a.roles = [...new Set(a.sessions.map((s) => s.role ?? null))];
      return a;
    });
    agents.sort((x, y) => agentTs(y) - agentTs(x)); // freshest-archived agent first
    return { projectId: p.projectId, projectName: p.projectName, agents };
  });
  const groupTs = (p: ProjectGroupT) => Math.max(0, ...p.agents.flatMap((a) => a.sessions.map(archTs)));
  projects.sort((x, y) => groupTs(y) - groupTs(x));

  return { projects, matchCount: filtered.length };
}

// ── tree components ──────────────────────────────────────────────────────────────
function Caret({ open }: { open: boolean }) {
  return <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted, width: 12, display: "inline-block" }}>{open ? "▾" : "▸"}</span>;
}

function ProjectGroup({ group, forceOpen, sessionId, onSelect, onRestore, restoring, onDelete, deleting }:
  { group: ProjectGroupT; forceOpen: boolean; sessionId: string | null; onSelect: (id: string) => void;
    onRestore: (id: string) => void; restoring: boolean; onDelete: (id: string) => void; deleting: boolean }) {
  const [collapsed, setCollapsed] = useState(false);
  const open = forceOpen || !collapsed;
  const count = group.agents.reduce((n, a) => n + a.sessions.length, 0);
  return (
    <div>
      <div onClick={() => setCollapsed((c) => !c)}
        style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", padding: "4px 2px", borderBottom: `1px solid ${color.border}` }}>
        <Caret open={open} />
        <span style={{ fontFamily: font.head, fontSize: 12, fontWeight: 700, letterSpacing: "0.04em", color: color.text }}>{group.projectName}</span>
        <Chip value={count} tone="muted" />
      </div>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 8, paddingLeft: 10 }}>
          {group.agents.map((a) => (
            <AgentGroupView key={a.agentId} group={a} forceOpen={forceOpen}
              sessionId={sessionId} onSelect={onSelect}
              onRestore={onRestore} restoring={restoring} onDelete={onDelete} deleting={deleting} />
          ))}
        </div>
      )}
    </div>
  );
}

function AgentGroupView({ group, forceOpen, sessionId, onSelect, onRestore, restoring, onDelete, deleting }:
  { group: AgentGroup; forceOpen: boolean; sessionId: string | null; onSelect: (id: string) => void;
    onRestore: (id: string) => void; restoring: boolean; onDelete: (id: string) => void; deleting: boolean }) {
  const [collapsed, setCollapsed] = useState(false);
  const open = forceOpen || !collapsed;
  return (
    <div>
      <div onClick={() => setCollapsed((c) => !c)}
        style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer", padding: "2px" }}>
        <Caret open={open} />
        <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textDim }}>{group.agentName}</span>
        {group.roles.map((r) => (
          <span key={r ?? "session"} style={{ fontFamily: font.mono, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: r ? tone[roleTone[r]] : color.textMuted }}>
            {r ?? "session"}
          </span>
        ))}
        <Chip value={group.sessions.length} tone="muted" />
      </div>
      {open && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 6, paddingLeft: 10 }}>
          {group.sessions.map((s) => (
            <ArchiveRow key={s.id} s={s} selected={s.id === sessionId}
              onSelect={() => onSelect(s.id)}
              onRestore={() => onRestore(s.id)} restoring={restoring}
              onDelete={() => onDelete(s.id)} deleting={deleting} />
          ))}
        </div>
      )}
    </div>
  );
}

function ArchiveRow({ s, selected, onSelect, onRestore, restoring, onDelete, deleting }:
  { s: ArchivedSessionListItem; selected: boolean; onSelect: () => void;
    onRestore: () => void; restoring: boolean; onDelete: () => void; deleting: boolean }) {
  const dead = s.resumability === "dead";
  const t = s.role ? roleTone[s.role] : "muted";
  const ts = (iso?: string | null) => (iso ? new Date(iso).toLocaleString() : "—");
  return (
    <Panel selected={selected} onClick={onSelect} style={{ padding: "8px 10px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ fontFamily: font.mono, fontSize: 12, color: tone[t], fontWeight: s.role === "manager" ? 700 : 400 }}>
          {s.role === "manager" ? "★ " : ""}{s.id.slice(0, 8)} · {s.role ?? "session"}
        </span>
        <span style={{ flex: 1 }} />
        {s.snapshotExists ? <Badge tone="phosphor">transcript</Badge> : <Badge tone="muted">no transcript</Badge>}
        <StatusPill tone={dead ? "red" : "muted"} label={dead ? "dead · view-only" : s.processState} />
      </div>
      <div style={{ marginTop: 8, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <Chip label="agent" value={s.agentName} />
        {s.taskId && <Chip label="task" value={s.taskId.slice(0, 8)} tone="cyan" />}
        {s.branch && <Chip label="branch" value={s.branch} tone="cyan" />}
        <Chip label="created" value={ts(s.createdAt)} />
        <Chip label="exited" value={ts(s.lastActivity)} />
        <Chip label="archived" value={ts(s.archivedAt)} />
      </div>
      <div style={{ marginTop: 8, display: "flex", gap: 6 }}>
        <Button disabled={restoring} title={dead ? "Restore to the rail (view-only — a dead session can't resume)" : "Restore to the rail"}
          onClick={(ev) => { ev.stopPropagation(); onRestore(); }}>Restore</Button>
        <Button variant="danger" disabled={deleting} title="Permanently delete this session row + its transcript snapshot"
          onClick={(ev) => { ev.stopPropagation(); onDelete(); }}>Delete</Button>
      </div>
    </Panel>
  );
}
