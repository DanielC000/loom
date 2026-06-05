import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { DndContext, useDraggable, useDroppable, type DragEndEvent } from "@dnd-kit/core";
import type { Task, TaskPriority, KanbanColumn, SessionListItem } from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { Button, Input, SectionLabel, StatusPill, Chip } from "../components/ui";
import { color, font, tone, type Tone } from "../theme";
// Priority chip + metadata live in one place so the board and the /terminals task card never drift.
import { PRIORITY_META, PriorityChip, prio } from "../components/priority";

const PRIORITIES: TaskPriority[] = ["p0", "p1", "p2", "p3"];
// Sort a column's cards high→low priority (p0 first), then by position — strings p0<p1<p2<p3 sort right.
const byPriorityThenPosition = (a: Task, b: Task) =>
  prio(a) === prio(b) ? a.position - b.position : (prio(a) < prio(b) ? -1 : 1);
// Done columns sort most-recently-done first. `updatedAt` (ISO string → lexical compare is chronological)
// is the stand-in for completion time; tie-break on position then id so equal-timestamp cards never
// reshuffle on the 3s refetch (deterministic, no flicker).
const byRecentlyDone = (a: Task, b: Task) =>
  a.updatedAt === b.updatedAt ? (a.position - b.position || (a.id < b.id ? -1 : 1)) : (a.updatedAt > b.updatedAt ? -1 : 1);

// Per-project kanban. Reads/writes the SAME task store the MCP tools use — moving a card
// POSTs columnKey, which a spawned agent's tasks_list immediately sees, and vice versa.
// Scoped to the header's active project by default; an explicit `projectId` prop points it at a
// specific project instead — the Platform section reuses it pointed at the reserved "Loom Platform"
// home so its board (the findings + escalations backlog) renders + triages with the same component.
export default function Board({ projectId: propProjectId }: { projectId?: string } = {}) {
  const qc = useQueryClient();
  const active = useActiveProject();
  const projectId = propProjectId ?? active.projectId;
  const [openTaskId, setOpenTaskId] = useState<string | null>(null); // task whose detail drawer is open
  const board = useQuery({ queryKey: ["board", projectId], queryFn: () => api.board(projectId), enabled: !!projectId, placeholderData: keepPreviousData });
  // Link the board to the orchestration spine: a worker carries its task id, so cards can show the
  // live worker's status + branch for the task they represent.
  const sessions = useQuery({ queryKey: ["allSessions"], queryFn: api.allSessions, refetchInterval: 3000 });
  const workerByTask = new Map<string, SessionListItem>();
  for (const s of sessions.data ?? []) if (s.taskId) workerByTask.set(s.taskId, s);

  const move = useMutation({
    mutationFn: ({ id, columnKey }: { id: string; columnKey: string }) => api.updateTask(id, { columnKey }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["board", projectId] }),
  });
  const create = useMutation({
    mutationFn: (title: string) => api.createTask(projectId, { title, columnKey: "backlog" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["board", projectId] }),
  });
  // Edit a task's title/description/priority from the detail drawer (same store the MCP tools read/write).
  const edit = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { title?: string; body?: string; priority?: TaskPriority } }) => api.updateTask(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["board", projectId] }),
  });

  const onDragEnd = (e: DragEndEvent) => {
    if (e.over && e.active.id !== e.over.id) move.mutate({ id: String(e.active.id), columnKey: String(e.over.id) });
  };

  const openTask = board.data?.tasks.find((t) => t.id === openTaskId) ?? null;

  return (
    <div>
      {!projectId && <p style={{ color: color.textMuted }}>No project selected.</p>}
      {projectId && board.data && (
        <>
          <NewTask onCreate={(t) => create.mutate(t)} />
          <DndContext onDragEnd={onDragEnd}>
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${board.data.columns.length}, 1fr)`, gap: 10, marginTop: 12 }}>
              {board.data.columns.map((col) => (
                <Column key={col.key} col={col}
                  tasks={board.data!.tasks.filter((t) => t.columnKey === col.key)
                    .sort(isDoneColumn(col.key) ? byRecentlyDone : byPriorityThenPosition)}
                  workers={workerByTask} onOpen={setOpenTaskId} />
              ))}
            </div>
          </DndContext>
        </>
      )}
      {openTask && (
        <TaskDrawer key={openTask.id} task={openTask} onClose={() => setOpenTaskId(null)}
          onSave={(patch) => edit.mutate({ id: openTask.id, patch })} saving={edit.isPending} />
      )}
    </div>
  );
}

// A column counts as "done" when its key signals completion (done/complete/merged). Single source
// of truth for both the phosphor tone and the recently-done sort, so the two never drift apart.
function isDoneColumn(key: string): boolean {
  const k = key.toLowerCase();
  return k.includes("done") || k.includes("complete") || k.includes("merged");
}

// Map a column to a signal tone (done = phosphor, review = cyan, in-progress = amber, else muted).
function columnTone(key: string): Tone {
  const k = key.toLowerCase();
  if (isDoneColumn(key)) return "phosphor";
  if (k.includes("review")) return "cyan";
  if (k.includes("progress") || k.includes("doing") || k.includes("wip") || k.includes("active")) return "amber";
  return "muted";
}

function Column({ col, tasks, workers, onOpen }:
  { col: KanbanColumn; tasks: Task[]; workers: Map<string, SessionListItem>; onOpen: (id: string) => void }) {
  const { setNodeRef, isOver } = useDroppable({ id: col.key });
  const t = columnTone(col.key);
  // Bounded, viewport-relative height so a long column scrolls internally instead of stretching the
  // page. Flex column: header stays pinned; the card list is the lone flex:1 scroll region. The
  // droppable ref stays on this outer wrapper, so a drop lands anywhere over the column (incl. when
  // scrolled — dnd-kit measures this wrapper's rect, and its auto-scroll drives the inner list).
  return (
    <div ref={setNodeRef} className="loom-grid"
      style={{ background: isOver ? color.phosphorDim : color.panel, border: `1px solid ${color.border}`, borderRadius: 4,
        display: "flex", flexDirection: "column", minHeight: 200, maxHeight: "75vh" }}>
      <SectionLabel style={{ color: tone[t], margin: 0, padding: "12px 12px 8px" }}>{col.label} ({tasks.length})</SectionLabel>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 12px 12px" }}>
        {tasks.map((task) => <Card key={task.id} task={task} accent={tone[t]} worker={workers.get(task.id)} onOpen={() => onOpen(task.id)} />)}
      </div>
    </div>
  );
}

// A worker bound to this task → show its live status + branch (links the board to the spine).
function workerStatus(w: SessionListItem): { tone: Tone; label: string; glow?: boolean } {
  if (w.processState !== "live") return { tone: "muted", label: w.processState };
  return w.busy ? { tone: "amber", label: "working", glow: true } : { tone: "phosphor", label: "idle" };
}

function Card({ task, accent, worker, onOpen }: { task: Task; accent: string; worker?: SessionListItem; onOpen: () => void }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: task.id });
  const st = worker ? workerStatus(worker) : null;
  const hasBody = !!task.body?.trim();
  return (
    <div ref={setNodeRef}
      style={{
        border: `1px solid ${color.border}`, borderLeft: `2px solid ${accent}`, borderRadius: 4,
        padding: "6px 8px", marginBottom: 6, background: color.panel2,
        opacity: isDragging ? 0.5 : 1,
        transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined,
        fontFamily: font.mono, fontSize: 12, color: color.text,
      }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 6 }}>
        {/* Drag is confined to this grip so a click on the card body opens the detail drawer instead. */}
        <span {...listeners} {...attributes} title="Drag to move"
          style={{ cursor: "grab", color: color.textMuted, lineHeight: "16px", touchAction: "none", userSelect: "none" }}>⠿</span>
        <div onClick={onOpen} title="Open task" style={{ flex: 1, cursor: "pointer", minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
            <PriorityChip priority={prio(task)} />
            <span style={{ flex: 1 }}>{task.title}</span>
            {hasBody && <span title="has a description" style={{ color: color.textMuted, flexShrink: 0 }}>≣</span>}
          </div>
          {worker && st && (
            <div style={{ marginTop: 5, display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
              <StatusPill tone={st.tone} label={st.label} glow={st.glow} />
              {worker.branch && <Chip label="branch" value={worker.branch} tone="cyan" />}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Slide-over detail drawer: view + edit a task's title and description (the `body` field that the
// MCP task tools read/write but the card never showed). Backdrop or Esc closes; keyed by task id so
// switching cards resets the fields. Save patches the shared task store, then the board refetches.
function TaskDrawer({ task, onClose, onSave, saving }:
  { task: Task; onClose: () => void; onSave: (patch: { title?: string; body?: string; priority?: TaskPriority }) => void; saving: boolean }) {
  const [title, setTitle] = useState(task.title);
  const [body, setBody] = useState(task.body ?? "");
  const [priority, setPriority] = useState<TaskPriority>(prio(task));
  const dirty = title !== task.title || body !== (task.body ?? "") || priority !== prio(task);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const labelStyle = { fontFamily: font.head, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textDim } as const;
  return (
    <div onClick={onClose}
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 50, display: "flex", justifyContent: "flex-end" }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: 460, maxWidth: "90vw", height: "100%", background: color.panel, borderLeft: `1px solid ${color.borderStrong}`,
          padding: 16, display: "flex", flexDirection: "column", gap: 10, boxSizing: "border-box" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <SectionLabel style={{ margin: 0, flex: 1 }}>Task · {task.id.slice(0, 8)}</SectionLabel>
          <Button onClick={onClose} title="Close (Esc)">✕</Button>
        </div>
        <span style={labelStyle}>Title</span>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} />
        <span style={labelStyle}>Priority</span>
        <div style={{ display: "flex", gap: 4 }}>
          {PRIORITIES.map((p) => {
            const m = PRIORITY_META[p];
            const active = priority === p;
            const c = tone[m.tone];
            return (
              <button key={p} type="button" onClick={() => setPriority(p)} title={m.label}
                style={{
                  flex: 1, cursor: "pointer", fontFamily: font.head, fontSize: 11, letterSpacing: "0.05em",
                  padding: "5px 4px", borderRadius: 4, textTransform: "uppercase",
                  color: active ? color.bg : c, background: active ? c : "transparent",
                  border: `1px solid ${active ? c : color.border}`,
                }}>
                {m.short} <span style={{ fontSize: 9, opacity: 0.8 }}>{m.label}</span>
              </button>
            );
          })}
        </div>
        <span style={labelStyle}>Description</span>
        <textarea value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false}
          placeholder="No description yet — agents fill this in via the task tools, or write one here."
          style={{
            flex: 1, minHeight: 200, width: "100%", boxSizing: "border-box", resize: "none",
            fontFamily: font.mono, fontSize: 13, lineHeight: 1.5,
            background: color.panel2, color: color.text, border: `1px solid ${color.border}`, borderRadius: 6, padding: 8,
          }} />
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Button variant="primary" disabled={!dirty || saving} onClick={() => onSave({ title, body, priority })}>{saving ? "Saving…" : "Save"}</Button>
          {dirty
            ? <Button onClick={() => { setTitle(task.title); setBody(task.body ?? ""); setPriority(prio(task)); }}>Reset</Button>
            : <span style={{ color: color.phosphor, fontSize: 12, fontFamily: font.mono }}>saved</span>}
        </div>
      </div>
    </div>
  );
}

function NewTask({ onCreate }: { onCreate: (title: string) => void }) {
  const [title, setTitle] = useState("");
  return (
    <div style={{ marginTop: 10, display: "flex", gap: 6 }}>
      <Input placeholder="new task title" value={title} onChange={(e) => setTitle(e.target.value)} style={{ minWidth: 280 }} />
      <Button variant="primary" disabled={!title} onClick={() => { onCreate(title); setTitle(""); }}>Add to Backlog</Button>
    </div>
  );
}
