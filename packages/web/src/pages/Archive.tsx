import { useEffect, useMemo, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ArchivedSessionListItem } from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { TranscriptPane } from "../components/TranscriptPane";
import { Panel, Button, Input, SectionLabel, StatusPill, Chip, Badge } from "../components/ui";
import { color, font, tone, sessionRoleTone as roleTone } from "../theme";
import { ARCHIVE_INVALIDATE_KEYS } from "../lib/archiveInvalidate";

// Per-project Archive: every STOPPED session of the header's active project (sessions auto-archive on
// exit, so Archive = all stopped sessions). Structured as a searchable manager → worker fold-out tree:
// each manager is a top-level row with the workers it spawned (parentSessionId === manager.id) NESTED
// and folding out under it; orphan/plain sessions (no manager in the set) sit at top level. Managers
// fold COLLAPSED by default so a large archive stays scannable. View a session's captured transcript
// snapshot, Resume it back to the live rail (clears archived_at), or Delete permanently. Scoped to the
// active project (useActiveProject) — NOT god-eye; the cross-project view lives elsewhere.
export default function Archive() {
  const qc = useQueryClient();
  const { projectId } = useActiveProject();
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [rawQuery, setRawQuery] = useState("");
  const [query, setQuery] = useState(""); // debounced
  useEffect(() => { const t = setTimeout(() => setQuery(rawQuery), 200); return () => clearTimeout(t); }, [rawQuery]);

  const archived = useQuery({
    queryKey: ["archive", projectId],
    queryFn: () => api.archivedSessions(projectId),
    enabled: !!projectId,
    refetchInterval: 4000,
  });

  const invalidate = () => {
    ARCHIVE_INVALIDATE_KEYS.forEach((queryKey) => qc.invalidateQueries({ queryKey }));
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

  // Filter (case-insensitive across id/agent/role/task/branch) then build the manager → worker tree,
  // newest-archived first at every level (archivedAt desc, falling back to lastActivity).
  const { nodes, matchCount } = useMemo(() => buildTree(rows, query), [rows, query]);

  const searching = query.trim().length > 0;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 16 }}>
      {/* LEFT: search + the manager → worker fold-out tree */}
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
          <SectionLabel style={{ margin: 0 }}>
            Archived sessions ({searching ? `${matchCount} of ${rows.length}` : rows.length})
          </SectionLabel>
          <span style={{ flex: 1 }} />
        </div>
        <Input
          placeholder="Search id · agent · role · task · branch…"
          value={rawQuery}
          onChange={(e) => setRawQuery(e.currentTarget.value)}
          style={{ marginBottom: 10 }}
        />
        <div style={{ maxHeight: "70vh", overflowY: "auto", display: "flex", flexDirection: "column", gap: 8, paddingRight: 4 }}>
          {!projectId && (
            <p style={{ color: color.textMuted, fontSize: 13 }}>No project selected.</p>
          )}
          {projectId && rows.length === 0 && (
            <p style={{ color: color.textMuted, fontSize: 13 }}>
              No archived sessions in this project. Sessions are archived automatically when they exit.
            </p>
          )}
          {rows.length > 0 && matchCount === 0 && (
            <p style={{ color: color.textMuted, fontSize: 13 }}>No archived sessions match “{query}”.</p>
          )}
          {nodes.map((n) => (
            <TreeNodeView key={n.session.id} node={n} forceOpen={searching}
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

// ── tree shape ───────────────────────────────────────────────────────────────────
// A top-level entry: one session plus the workers it spawned (empty for a plain/orphan session). The
// fold-out only renders when `children` is non-empty.
type TreeNode = { session: ArchivedSessionListItem; children: ArchivedSessionListItem[] };

const archTs = (s: ArchivedSessionListItem) => Date.parse(s.archivedAt ?? s.lastActivity ?? "") || 0;

function buildTree(rows: ArchivedSessionListItem[], rawQuery: string): { nodes: TreeNode[]; matchCount: number } {
  const q = rawQuery.trim().toLowerCase();
  const match = (s: ArchivedSessionListItem) =>
    !q || [s.id, s.agentName, s.role, s.taskId, s.branch]
      .some((v) => v != null && String(v).toLowerCase().includes(q));
  const filtered = rows.filter(match);
  const idSet = new Set(filtered.map((s) => s.id));

  // A session nests under its manager only when that manager is also in the (filtered) set; otherwise
  // it surfaces at top level — that covers managers (no parent) AND orphan workers (manager filtered
  // out or never archived in this project).
  const childrenByParent = new Map<string, ArchivedSessionListItem[]>();
  const topLevel: ArchivedSessionListItem[] = [];
  for (const s of filtered) {
    if (s.parentSessionId && idSet.has(s.parentSessionId)) {
      const arr = childrenByParent.get(s.parentSessionId) ?? [];
      arr.push(s);
      childrenByParent.set(s.parentSessionId, arr);
    } else {
      topLevel.push(s);
    }
  }

  const nodes: TreeNode[] = topLevel.map((s) => ({
    session: s,
    children: (childrenByParent.get(s.id) ?? []).sort((a, b) => archTs(b) - archTs(a)),
  }));
  // Newest-archived top-level first — a manager ranks by its freshest activity (itself or any worker),
  // so an actively-worked manager floats up even if it exited before its workers.
  const nodeTs = (n: TreeNode) => Math.max(archTs(n.session), ...n.children.map(archTs));
  nodes.sort((a, b) => nodeTs(b) - nodeTs(a));

  return { nodes, matchCount: filtered.length };
}

// ── tree components ──────────────────────────────────────────────────────────────
function TreeNodeView({ node, forceOpen, sessionId, onSelect, onRestore, restoring, onDelete, deleting }:
  { node: TreeNode; forceOpen: boolean; sessionId: string | null; onSelect: (id: string) => void;
    onRestore: (id: string) => void; restoring: boolean; onDelete: (id: string) => void; deleting: boolean }) {
  // Managers fold COLLAPSED by default so a large archive stays scannable; search forces them open.
  const [collapsed, setCollapsed] = useState(true);
  const hasChildren = node.children.length > 0;
  const open = forceOpen || !collapsed;
  return (
    <div>
      <div style={{ display: "flex", alignItems: "stretch", gap: 6 }}>
        {hasChildren ? (
          <button onClick={() => setCollapsed((c) => !c)} aria-expanded={open}
            title={`${node.children.length} worker${node.children.length === 1 ? "" : "s"} — click to ${open ? "collapse" : "expand"}`}
            style={{
              display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 2,
              width: 26, flexShrink: 0, cursor: "pointer", padding: 0,
              background: "transparent", border: "none", color: color.textMuted, fontFamily: font.mono,
            }}>
            <span style={{ fontSize: 12 }}>{open ? "▾" : "▸"}</span>
            <span style={{ fontSize: 11, color: color.textDim }}>{node.children.length}</span>
          </button>
        ) : (
          <span style={{ width: 26, flexShrink: 0 }} />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <ArchiveRow s={node.session} selected={node.session.id === sessionId}
            onSelect={() => onSelect(node.session.id)}
            onRestore={() => onRestore(node.session.id)} restoring={restoring}
            onDelete={() => onDelete(node.session.id)} deleting={deleting} />
        </div>
      </div>
      {hasChildren && open && (
        <div style={{ marginTop: 8, marginLeft: 12, paddingLeft: 14, borderLeft: `1px solid ${color.border}`, display: "flex", flexDirection: "column", gap: 8 }}>
          {node.children.map((s) => (
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
        <Button disabled={restoring} title={dead ? "Restore to the rail (view-only — a dead session can't resume)" : "Resume — return this session to the live rail"}
          onClick={(ev) => { ev.stopPropagation(); onRestore(); }}>{dead ? "Restore" : "Resume"}</Button>
        <Button variant="danger" disabled={deleting} title="Permanently delete this session row + its transcript snapshot"
          onClick={(ev) => { ev.stopPropagation(); onDelete(); }}>Delete</Button>
      </div>
    </Panel>
  );
}
