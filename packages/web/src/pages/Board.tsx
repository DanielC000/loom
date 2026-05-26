import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { DndContext, useDraggable, useDroppable, type DragEndEvent } from "@dnd-kit/core";
import type { Task, KanbanColumn } from "@loom/shared";
import { api } from "../lib/api";
import { card, btn, input } from "../ui";
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

function Column({ col, tasks }: { col: KanbanColumn; tasks: Task[] }) {
  const { setNodeRef, isOver } = useDroppable({ id: col.key });
  return (
    <div ref={setNodeRef} style={{ ...card, minHeight: "60vh", background: isOver ? "#1c1c22" : undefined }}>
      <div style={{ fontSize: 12, color: "#9ad", marginBottom: 8 }}>{col.label} ({tasks.length})</div>
      {tasks.map((t) => <Card key={t.id} task={t} />)}
    </div>
  );
}

function Card({ task }: { task: Task }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: task.id });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes}
      style={{
        border: "1px solid #3a3a40", borderRadius: 6, padding: "6px 8px", marginBottom: 6,
        background: "#161618", cursor: "grab", opacity: isDragging ? 0.5 : 1,
        transform: transform ? `translate(${transform.x}px, ${transform.y}px)` : undefined,
      }}>
      {task.title}
    </div>
  );
}

function NewTask({ onCreate }: { onCreate: (title: string) => void }) {
  const [title, setTitle] = useState("");
  return (
    <div style={{ marginTop: 8 }}>
      <input style={input} placeholder="new task title" value={title} onChange={(e) => setTitle(e.target.value)} />
      <button style={btn} disabled={!title} onClick={() => { onCreate(title); setTitle(""); }}>Add to Backlog</button>
    </div>
  );
}
