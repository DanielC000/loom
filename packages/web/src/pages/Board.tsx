import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { DndContext, useDraggable, useDroppable, type DragEndEvent } from "@dnd-kit/core";
import type { Task, KanbanColumn } from "@loom/shared";
import { api } from "../lib/api";
import { Button, Input, SectionLabel } from "../components/ui";
import { color, font, tone, type Tone } from "../theme";
import { ProjectSelect } from "./Vault";

// Per-project kanban. Reads/writes the SAME task store the MCP tools use — moving a card
// POSTs columnKey, which a spawned agent's tasks_list immediately sees, and vice versa.
export default function Board() {
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState<string>("");
  const projects = useQuery({ queryKey: ["projects"], queryFn: api.projects });
  const board = useQuery({ queryKey: ["board", projectId], queryFn: () => api.board(projectId), enabled: !!projectId });

  const move = useMutation({
    mutationFn: ({ id, columnKey }: { id: string; columnKey: string }) => api.updateTask(id, { columnKey }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["board", projectId] }),
  });
  const create = useMutation({
    mutationFn: (title: string) => api.createTask(projectId, { title, columnKey: "backlog" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["board", projectId] }),
  });

  const onDragEnd = (e: DragEndEvent) => {
    if (e.over && e.active.id !== e.over.id) move.mutate({ id: String(e.active.id), columnKey: String(e.over.id) });
  };

  return (
    <div>
      <ProjectSelect value={projectId} onChange={setProjectId} projects={projects.data ?? []} />
      {projectId && board.data && (
        <>
          <NewTask onCreate={(t) => create.mutate(t)} />
          <DndContext onDragEnd={onDragEnd}>
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${board.data.columns.length}, 1fr)`, gap: 10, marginTop: 12 }}>
              {board.data.columns.map((col) => (
                <Column key={col.key} col={col} tasks={board.data!.tasks.filter((t) => t.columnKey === col.key)} />
              ))}
            </div>
          </DndContext>
        </>
      )}
    </div>
  );
}

// Map a column to a signal tone (done = phosphor, review = cyan, in-progress = amber, else muted).
function columnTone(key: string): Tone {
  const k = key.toLowerCase();
  if (k.includes("done") || k.includes("complete") || k.includes("merged")) return "phosphor";
  if (k.includes("review")) return "cyan";
  if (k.includes("progress") || k.includes("doing") || k.includes("wip") || k.includes("active")) return "amber";
  return "muted";
}

function Column({ col, tasks }: { col: KanbanColumn; tasks: Task[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: col.key });
  const t = columnTone(col.key);
  return (
    <div ref={setNodeRef} className="loom-grid"
      style={{ background: isOver ? color.phosphorDim : color.panel, border: `1px solid ${color.border}`, borderRadius: 4, padding: 12, minHeight: "60vh" }}>
      <SectionLabel style={{ color: tone[t] }}>{col.label} ({tasks.length})</SectionLabel>
      {tasks.map((task) => <Card key={task.id} task={task} accent={tone[t]} />)}
    </div>
  );
}

function Card({ task, accent }: { task: Task; accent: string }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: task.id });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes}
      style={{
        border: `1px solid ${color.border}`, borderLeft: `2px solid ${accent}`, borderRadius: 4,
        padding: "6px 8px", marginBottom: 6, background: color.panel2, cursor: "grab",
        opacity: isDragging ? 0.5 : 1,
        transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined,
        fontFamily: font.mono, fontSize: 12, color: color.text,
      }}>
      {task.title}
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
