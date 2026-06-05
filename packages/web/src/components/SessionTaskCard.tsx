import { useEffect, useState } from "react";
import type { Task } from "@loom/shared";
import { Button, SectionLabel } from "./ui";
import { color, font } from "../theme";
import { PRIORITY_META, PriorityChip, prio } from "./priority";

// A SLIM read-only strip shown under a /terminals session tile's title line, naming the board task
// the session is bound to. Thinner/lighter than the board Card: one line (PriorityChip + title +
// ≣-if-body), smaller vertical padding, NO drag handle and NO worker/branch pills — the tile's own
// title line already shows live status. Clicking opens a strictly read-only slide-over drawer
// (view title/priority/description — no edit inputs, no Save/Reset). The Terminals page never mutates
// a task. (Read-only drawer kept separate from the board's editable TaskDrawer to avoid touching
// Board.tsx; the priority styling is shared via ./priority.)
export function SessionTaskCard({ task }: { task: Task }) {
  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const hasBody = !!task.body?.trim();
  return (
    <>
      <div onClick={(e) => { e.stopPropagation(); setOpen(true); }} title="Open task (read-only)"
        onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}
        style={{
          display: "flex", alignItems: "center", gap: 6, cursor: "pointer",
          border: `1px solid ${hover ? color.borderStrong : color.border}`, borderRadius: 4,
          padding: "2px 6px", marginBottom: 4, background: color.panel2,
          fontFamily: font.mono, fontSize: 11, color: color.text,
        }}>
        <PriorityChip priority={prio(task)} />
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{task.title}</span>
        {hasBody && <span title="has a description" style={{ color: color.textMuted, flexShrink: 0 }}>≣</span>}
      </div>
      {open && <ReadOnlyTaskDrawer task={task} onClose={() => setOpen(false)} />}
    </>
  );
}

// Slide-over detail drawer mirroring the board's TaskDrawer placement/look (Esc or backdrop closes),
// but STRICTLY read-only: it renders the task's title, priority, and full description as static text —
// no inputs, no priority buttons, no Save/Reset/"saved" footer.
function ReadOnlyTaskDrawer({ task, onClose }: { task: Task; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const labelStyle = { fontFamily: font.head, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textDim } as const;
  const body = task.body?.trim();
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
        <div style={{ fontFamily: font.mono, fontSize: 13, lineHeight: 1.5, color: color.text }}>{task.title}</div>
        <span style={labelStyle}>Priority</span>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <PriorityChip priority={prio(task)} />
          <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textDim }}>{PRIORITY_META[prio(task)].label}</span>
        </div>
        <span style={labelStyle}>Description</span>
        <div style={{
          flex: 1, minHeight: 200, overflow: "auto", whiteSpace: "pre-wrap", wordBreak: "break-word",
          fontFamily: font.mono, fontSize: 13, lineHeight: 1.5,
          background: color.panel2, color: body ? color.text : color.textMuted,
          border: `1px solid ${color.border}`, borderRadius: 6, padding: 8, boxSizing: "border-box",
        }}>{body || "No description."}</div>
      </div>
    </div>
  );
}
