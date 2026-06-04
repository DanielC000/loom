import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { ArchivedSessionListItem, SessionRole } from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { TranscriptPane } from "../components/TranscriptPane";
import { Panel, Button, SectionLabel, StatusPill, Chip, Badge } from "../components/ui";
import { color, font, tone, type Tone } from "../theme";

const roleTone: Record<NonNullable<SessionRole>, Tone> = { manager: "phosphor", worker: "cyan", platform: "amber" };

// Per-project Archive tab: dead/exited sessions tidied out of the Workspace rail. View their captured
// transcript snapshot, Restore them to the rail (VIEW-ONLY if dead — they can't resume), or Delete
// permanently (row + snapshot). The list is project-scoped via the header's active project.
export default function Archive() {
  const qc = useQueryClient();
  const { projectId } = useActiveProject();
  const [sessionId, setSessionId] = useState<string | null>(null);
  useEffect(() => { setSessionId(null); }, [projectId]); // clear selection when the project changes

  const archived = useQuery({
    queryKey: ["archive", projectId],
    queryFn: () => api.archivedSessions(projectId),
    enabled: !!projectId,
    refetchInterval: 4000,
  });

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["archive", projectId] });
    qc.invalidateQueries({ queryKey: ["allSessions"] }); // god-eye views
    qc.invalidateQueries({ queryKey: ["sessions"] });     // every agent's rail
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
  const selected = rows.find((r) => r.id === sessionId) ?? null;

  if (!projectId) return <p style={{ color: color.textMuted }}>No project selected.</p>;

  return (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 1fr) minmax(0, 1fr)", gap: 16 }}>
      {/* LEFT: the archived sessions list */}
      <div>
        <SectionLabel>Archived sessions ({rows.length})</SectionLabel>
        {rows.length === 0 && (
          <p style={{ color: color.textMuted, fontSize: 13 }}>
            No archived sessions. Archive an exited session from the Workspace rail to tidy it out of view.
          </p>
        )}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          {rows.map((s) => (
            <ArchiveRow key={s.id} s={s} selected={s.id === sessionId}
              onSelect={() => setSessionId(s.id)}
              onRestore={() => restore.mutate(s.id)} restoring={restore.isPending}
              onDelete={() => { if (window.confirm("Permanently delete this archived session and its transcript snapshot? This cannot be undone.")) del.mutate(s.id); }}
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
