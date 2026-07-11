import { useState, useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useQuery, useMutation, useQueryClient, keepPreviousData } from "@tanstack/react-query";
import { DndContext, useDraggable, useDroppable, type DragEndEvent } from "@dnd-kit/core";
import type { Task, TaskPriority, KanbanColumn, SessionListItem, QuestionInboxItem } from "@loom/shared";
import { api } from "../lib/api";
import { useActiveProject } from "../lib/activeProject";
import { Button, Input, SectionLabel, StatusPill, Chip, Badge } from "../components/ui";
import { useOpenRequest, RequestTypeTag } from "../components/requests";
import { DecisionStateChip } from "../components/decisions";
import { relativeAge, requestHint, REQUEST_TYPE_TONE } from "../lib/questions";
import { color, font, radius, tone, roleTone, type Tone } from "../theme";
import { useSpeechRecognition, type SpeechRecognitionApi } from "../lib/useSpeechRecognition";
import { useVoiceLang } from "../lib/useVoiceLang";
import { isDoneColumn } from "../lib/columnSort";
import { taskMatchesSearch } from "../lib/taskFilter";
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
  // Poll so the board reflects task changes made by ANOTHER process (the orchestrator via MCP), not
  // just this client's own mutations — otherwise external card moves only appear on a manual refresh.
  // keepPreviousData (above) makes the 4s refetch flicker-free. Matches the Platform board's polling.
  const board = useQuery({ queryKey: ["board", projectId], queryFn: () => api.board(projectId), enabled: !!projectId, refetchInterval: 4000, placeholderData: keepPreviousData });
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
    mutationFn: (title: string) => api.createTask(projectId, { title, columnKey: "inbox" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["board", projectId] }),
  });
  // Edit a task's title/description/priority/held/deferred from the detail drawer (same store the MCP tools read/write).
  const edit = useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: { title?: string; body?: string; priority?: TaskPriority; held?: boolean; deferred?: boolean } }) => api.updateTask(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["board", projectId] }),
  });
  // PERMANENTLY delete a task card from the drawer (HUMAN-only REST; no MCP path). On success close the
  // drawer + refetch the board. On the server's live-session guard 400, delErr throws the reason — leave
  // the drawer open and surface `del.error` to the user instead of silently closing.
  const del = useMutation({
    mutationFn: (id: string) => api.deleteTask(id),
    onSuccess: () => { setOpenTaskId(null); qc.invalidateQueries({ queryKey: ["board", projectId] }); },
  });

  const onDragEnd = (e: DragEndEvent) => {
    if (e.over && e.active.id !== e.over.id) move.mutate({ id: String(e.active.id), columnKey: String(e.over.id) });
  };

  // Deep-link into a specific card's drawer via `?task=<id>` — used by a Request's reverse "linked task"
  // chip (components/requests → RequestDetail). Consumed once the target card is present in the loaded
  // board, then the param is cleared so a later close/reopen doesn't re-open it. A dangling id (deleted
  // card) never resolves and simply leaves the board as-is — the soft link tolerates it.
  const [searchParams, setSearchParams] = useSearchParams();
  const taskParam = searchParams.get("task");
  useEffect(() => {
    if (!taskParam || !board.data) return;
    if (board.data.tasks.some((t) => t.id === taskParam)) setOpenTaskId(taskParam);
    setSearchParams((p) => { p.delete("task"); return p; }, { replace: true });
  }, [taskParam, board.data, setSearchParams]);

  const openTask = board.data?.tasks.find((t) => t.id === openTaskId) ?? null;
  // The open card's resolved lane, for the modal header's state/lane chip (dossier header).
  const openColumn = openTask ? board.data?.columns.find((c) => c.key === openTask.columnKey) ?? null : null;

  // ── Client-side view filter (no server round-trip) ───────────────────────────
  // Search matches id+title+body (case-insensitive substring — a full card id or any prefix finds the
  // card by its primary handle); priority + column are multi-select (empty set = no constraint). All
  // three AND together. Non-matching cards vanish from every column; the column header count and the
  // "N of M shown" affordance reflect the filtered view.
  const [search, setSearch] = useState("");
  const [priFilter, setPriFilter] = useState<Set<TaskPriority>>(() => new Set());
  const [colFilter, setColFilter] = useState<Set<string>>(() => new Set());
  const togglePri = (p: TaskPriority) => setPriFilter((s) => { const n = new Set(s); n.delete(p) || n.add(p); return n; });
  const toggleCol = (k: string) => setColFilter((s) => { const n = new Set(s); n.delete(k) || n.add(k); return n; });
  const clearFilters = () => { setSearch(""); setPriFilter(new Set()); setColFilter(new Set()); };
  const q = search.trim().toLowerCase();
  const filterActive = q !== "" || priFilter.size > 0 || colFilter.size > 0;
  const allTasks = board.data?.tasks ?? [];
  const shownTasks = allTasks.filter((t) =>
    taskMatchesSearch(t, q) &&
    (priFilter.size === 0 || priFilter.has(prio(t))) &&
    (colFilter.size === 0 || colFilter.has(t.columnKey)));

  return (
    <div>
      {!projectId && <p style={{ color: color.textMuted }}>No project selected.</p>}
      {/* First-load placeholder: lane shells so the layout settles in, not a blank flash. keepPreviousData
          keeps this from re-appearing on the 4s refetch — it shows only before the very first response. */}
      {projectId && !board.data && board.isLoading && <BoardSkeleton />}
      {/* First-load failure (retries under the hood): a calm line rather than a permanently empty page. */}
      {projectId && !board.data && board.isError && (
        <div style={{ marginTop: 10, color: color.red, fontFamily: font.mono, fontSize: 12 }}>
          couldn’t load the board — retrying…
        </div>
      )}
      {projectId && board.data && (
        <>
          <NewTask onCreate={(t) => create.mutate(t)} />
          <FilterBar search={search} onSearch={setSearch} columns={board.data.columns}
            priFilter={priFilter} onTogglePri={togglePri} colFilter={colFilter} onToggleCol={toggleCol}
            shown={shownTasks.length} total={allTasks.length} active={filterActive} onClear={clearFilters} />
          <div style={{ display: "flex", gap: 10, marginTop: 10, alignItems: "stretch" }}>
            <DndContext onDragEnd={onDragEnd}>
              {/* Responsive lane grid (.loom-board-grid): equal 1fr lanes when they fit, horizontal
                  scroll with a usable per-lane min width when they don't (narrow viewport / many lanes)
                  — so the board degrades gracefully instead of crushing every lane. */}
              <div className="loom-board-grid">
                {board.data.columns.map((col) => (
                  <Column key={col.key} col={col}
                    tasks={shownTasks.filter((t) => t.columnKey === col.key)
                      .sort(isDoneColumn(col) ? byRecentlyDone : byPriorityThenPosition)}
                    filterActive={filterActive} workers={workerByTask} onOpen={setOpenTaskId}
                    cardCount={allTasks.filter((t) => t.columnKey === col.key).length} />
                ))}
              </div>
            </DndContext>
          </div>
        </>
      )}
      {openTask && (
        <TaskDrawer key={openTask.id} task={openTask} column={openColumn} onClose={() => setOpenTaskId(null)}
          onSave={(patch) => edit.mutate({ id: openTask.id, patch })} saving={edit.isPending}
          onDelete={() => del.mutate(openTask.id)} deleting={del.isPending}
          deleteError={del.error ? (del.error as Error).message : null} />
      )}
    </div>
  );
}

// ── One source of truth for a board lane's color ──────────────────────────────────
// A lane is tinted by its lifecycle ROLE (via the shared `roleTone` map), so the board agrees with
// Settings' role coloring. The ONE resolved color drives the accent bar, the header label, AND each
// card's left border — they can no longer diverge the way the old key-substring heuristic let them
// (Blocked = red bar but grey label/cards). A role-less lane has no signal tone (it may still carry an
// explicit accentColor — e.g. a future per-column accent set without a role).
function columnTone(col: KanbanColumn): Tone | null {
  return col.role ? roleTone[col.role] : null;
}
// The resolved accent COLOR for a lane: an explicit per-column accentColor WINS, then the role tone,
// then null. accentColor-first is what makes the Settings accent picker take effect on the board even
// for role-bearing lanes (f033daeb added the picker; before this it silently lost to the role tone on
// the typical all-role board). A preset's accentColor equals its role color, and the DEFAULT board sets
// no accentColor at all, so default/preset boards look unchanged. A role-less lane with no accent → null
// (transparent bar + neutral label/border). The "muted" role tone resolves to textDim (#8a929b =
// 5.92:1), never textMuted (#5a636c = 3.05:1).
function columnAccent(col: KanbanColumn): string | null {
  if (col.accentColor) return col.accentColor;
  const t = columnTone(col);
  if (t) return t === "muted" ? color.textDim : tone[t];
  return null;
}

// WCAG-AA guard for the 11px-bold lane LABEL, which must clear 4.5:1 on the panel. The accent bar and
// each card's left border are decorative (no contrast floor) and always use the resolved accent; the
// LABEL uses it ONLY when it clears AA, else falls back to textDim. Only a raw accentColor hex can fail
// — the role tones are var() refs vetted AA-safe by design — so the guard runs the contrast math on hex
// accents alone (every ACCENT_PALETTE swatch happens to clear AA; the guard is the floor if one didn't).
// Panel hex mirrors --loom-panel (global.css :root).
const PANEL_HEX = "#101316";
function relLuminance(hex: string): number {
  const lin = (i: number): number => {
    const v = parseInt(hex.slice(1 + i, 3 + i), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(0) + 0.7152 * lin(2) + 0.0722 * lin(4);
}
function labelColorFor(accent: string | null): string {
  if (!accent) return color.textDim;
  if (accent.startsWith("#")) {
    const a = relLuminance(accent) + 0.05;
    const b = relLuminance(PANEL_HEX) + 0.05;
    const ratio = a > b ? a / b : b / a;
    if (ratio < 4.5) return color.textDim;
  }
  return accent;
}

function Column({ col, tasks, filterActive, workers, onOpen, cardCount }:
  { col: KanbanColumn; tasks: Task[]; filterActive: boolean; workers: Map<string, SessionListItem>; onOpen: (id: string) => void;
    cardCount: number }) {
  const { setNodeRef, isOver } = useDroppable({ id: col.key });
  // ONE resolved color for the lane (role → tone, else accentColor, else null). Drives the accent bar,
  // the header label, and each card's left border so all three agree. null = un-accented: transparent
  // bar, neutral AA-safe label, neutral hairline card border.
  const accent = columnAccent(col);
  const labelColor = labelColorFor(accent); // resolved accent if it clears AA on the panel, else textDim
  const cardAccent = accent ?? color.border; // un-accented lane → a neutral hairline left-border
  // SOFT WIP limit (advisory, never blocks). Shown as "N / limit" WHENEVER a limit is set (so an
  // approaching "2 / 3" is visible, not just a breach) — neutral under, amber AT-or-over. The count is
  // the column's TRUE card load (`cardCount`, unfiltered), NOT the filtered `tasks.length`, so an active
  // board filter can't make the WIP count / over-limit state read wrong.
  const hasWipLimit = col.wipLimit !== undefined;
  const atOrOverWip = hasWipLimit && cardCount >= col.wipLimit!;

  // The board header is plain, non-editable display — column CRUD (add/rename/delete/reorder/role/
  // accent/WIP) lives ONLY in Settings › Board Columns (ColumnManager). Here we render the label, its
  // resolved role tint, and the card count / soft-WIP readout.
  //
  // Bounded, viewport-relative height so a long column scrolls internally instead of stretching the
  // page. Flex column: header stays pinned; the card list is the lone flex:1 scroll region. The
  // droppable ref stays on this outer wrapper, so a drop lands anywhere over the column (incl. when
  // scrolled — dnd-kit measures this wrapper's rect, and its auto-scroll drives the inner list).
  return (
    <div ref={setNodeRef} className="loom-grid"
      style={{ background: isOver ? color.phosphorDim : color.panel, border: `1px solid ${color.border}`, borderRadius: 4,
        display: "flex", flexDirection: "column", minHeight: 200, maxHeight: "75vh" }}>
      {/* Restrained per-column header accent: a thin top bar in the lane's resolved color. The 3px height
          is ALWAYS reserved (transparent when un-accented) so accented and un-accented lanes share one
          label baseline. Top corners rounded to nest inside the wrapper's radius. */}
      <div aria-hidden style={{ height: 3, background: accent ?? "transparent", flexShrink: 0,
        borderTopLeftRadius: 3, borderTopRightRadius: 3 }} />
      <SectionLabel style={{ color: labelColor, margin: 0, padding: "12px 12px 8px", display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{col.label}</span>
        {hasWipLimit ? (
          <span aria-label={`${cardCount} of ${col.wipLimit} cards${atOrOverWip ? ", at or over the soft WIP limit" : ""}`}
            title={atOrOverWip
              ? `At or over the soft WIP limit of ${col.wipLimit} (advisory — does not block; counts the column's true load)`
              : `Soft WIP limit of ${col.wipLimit} (advisory; counts the column's true load)`}
            style={{ marginLeft: "auto", flexShrink: 0, color: atOrOverWip ? color.amber : color.textDim, fontWeight: atOrOverWip ? 700 : undefined }}>
            {cardCount} / {col.wipLimit}
          </span>
        ) : (
          <span style={{ marginLeft: "auto", flexShrink: 0, color: "inherit" }}>({tasks.length})</span>
        )}
      </SectionLabel>
      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "0 12px 12px" }}>
        {tasks.map((task) => <Card key={task.id} task={task} accent={cardAccent} worker={workers.get(task.id)} onOpen={() => onOpen(task.id)} />)}
        {/* Filtered-empty state: the filter hid every card in this column. Reads as deliberate, not broken. */}
        {tasks.length === 0 && filterActive && (
          <div style={{ color: color.textMuted, fontFamily: font.mono, fontSize: 11, padding: "8px 2px" }}>no matches</div>
        )}
        {/* Genuinely-empty lane (no filter): a calm placeholder that doubles as a drop-target hint, so an
            empty column reads as intentional rather than a broken blank — and lights up when dragged over. */}
        {tasks.length === 0 && !filterActive && (
          <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 72, textAlign: "center",
            color: isOver ? color.phosphor : color.textMuted, fontFamily: font.mono, fontSize: 11,
            border: `1px dashed ${isOver ? color.phosphor : color.border}`, borderRadius: 4,
            transition: "color 120ms ease, border-color 120ms ease" }}>
            {isOver ? "drop to move here" : "no cards yet"}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Filter bar ─────────────────────────────────────────────────────────────────
// Tiny uppercase group label (Space Grotesk) preceding a row of toggle chips. aria-hidden — each
// toggle carries its own descriptive aria-label, so the visual label would only be redundant noise
// to a screen reader.
const groupLabel = { fontFamily: font.head, fontSize: 10, fontWeight: 700, textTransform: "uppercase",
  letterSpacing: "0.1em", color: color.textMuted } as const;

// A multi-select toggle chip. Off: outlined + dim. On: filled with its signal tone (the established
// PriorityChip "pop" look). `muted` fills with the lighter text-dim grey instead of the near-invisible
// muted grey so the dark on-fill label keeps AA contrast. Native <button> → Enter/Space + focus ring
// (.loom-toggle in global.css) come for free; aria-pressed exposes the on/off state.
function ToggleChip({ label, ariaLabel, t, active, onToggle }:
  { label: string; ariaLabel: string; t: Tone; active: boolean; onToggle: () => void }) {
  const fill = t === "muted" ? color.textDim : tone[t];
  return (
    <button type="button" aria-pressed={active} aria-label={ariaLabel} title={ariaLabel} onClick={onToggle}
      className={`loom-toggle${active ? " is-active" : ""}`}
      style={{
        fontFamily: font.head, fontSize: 10, fontWeight: active ? 700 : 500, letterSpacing: "0.06em",
        textTransform: "uppercase", padding: "3px 8px", borderRadius: 3, lineHeight: "14px",
        color: active ? color.bg : color.textDim, background: active ? fill : "transparent",
        border: `1px solid ${active ? fill : color.border}`,
      }}>
      {label}
    </button>
  );
}

function FilterBar({ search, onSearch, columns, priFilter, onTogglePri, colFilter, onToggleCol, shown, total, active, onClear }:
  { search: string; onSearch: (v: string) => void; columns: KanbanColumn[];
    priFilter: Set<TaskPriority>; onTogglePri: (p: TaskPriority) => void;
    colFilter: Set<string>; onToggleCol: (k: string) => void;
    shown: number; total: number; active: boolean; onClear: () => void }) {
  return (
    <div style={{ marginTop: 10, background: color.panel, border: `1px solid ${color.border}`, borderRadius: 4,
      padding: "8px 10px", display: "flex", flexDirection: "column", gap: 8 }}>
      {/* Row 1: search + live result count + clear-all */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <div style={{ position: "relative", display: "flex", alignItems: "center", flex: "1 1 240px", maxWidth: 460 }}>
          <span aria-hidden style={{ position: "absolute", left: 8, color: color.textMuted, fontSize: 13, pointerEvents: "none" }}>⌕</span>
          <Input value={search} onChange={(e) => onSearch(e.target.value)}
            aria-label="Search tasks by id, title, or description" placeholder="search tasks by id or text…"
            onKeyDown={(e) => { if (e.key === "Escape" && search) { e.stopPropagation(); onSearch(""); } }}
            style={{ width: "100%", paddingLeft: 26, paddingRight: search ? 26 : 8 }} />
          {search && (
            <button type="button" aria-label="Clear search" title="Clear search" onClick={() => onSearch("")}
              className="loom-toggle" style={{ position: "absolute", right: 6, background: "transparent", border: "none",
                color: color.textMuted, cursor: "pointer", fontSize: 13, lineHeight: 1, padding: 2, borderRadius: 3 }}>✕</button>
          )}
        </div>
        <span aria-live="polite" style={{ fontFamily: font.mono, fontSize: 11, whiteSpace: "nowrap",
          color: active ? color.phosphor : color.textMuted }}>
          {shown} of {total} shown
        </span>
        {active && <Button variant="ghost" onClick={onClear} style={{ marginLeft: "auto" }}>Clear filters</Button>}
      </div>
      {/* Row 2: priority + column toggles */}
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span aria-hidden style={groupLabel}>Priority</span>
          {PRIORITIES.map((p) => (
            <ToggleChip key={p} label={PRIORITY_META[p].short} ariaLabel={`Filter by ${PRIORITY_META[p].label} priority`}
              t={PRIORITY_META[p].tone} active={priFilter.has(p)} onToggle={() => onTogglePri(p)} />
          ))}
        </div>
        {columns.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span aria-hidden style={groupLabel}>Column</span>
            {columns.map((c) => (
              <ToggleChip key={c.key} label={c.label} ariaLabel={`Filter by ${c.label} column`}
                t={columnTone(c) ?? "muted"} active={colFilter.has(c.key)} onToggle={() => onToggleCol(c.key)} />
            ))}
          </div>
        )}
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
        // Held reads as braked WHEREVER the card sits — its amber left-border overrides the column's
        // own role accent, so a held card never blends into an ordinary lane.
        border: `1px solid ${task.held ? color.amber : color.border}`,
        borderLeft: `3px solid ${task.held ? color.amber : accent}`, borderRadius: 4,
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
          {/* flexWrap is the phone-density hinge: the priority chip + a held/deferred badge share this
              line with the title. On a TIGHT lane (phone ~200px / the 240px desktop floor) a chip + badge
              starve the title's slice, so the title's 120px flex-basis no longer fits beside them and
              wraps to its OWN full-width line below the badge row — giving a long word the whole lane so
              it never breaks mid-word. On a WIDE lane the basis fits inline and the row stays one line,
              unchanged. Self-adjusting: only a genuinely starved title reflows (a chip-only card with room
              keeps its title inline). */}
          <div style={{ display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 6, minWidth: 0 }}>
            <PriorityChip priority={prio(task)} />
            {task.held && (
              <span title="Held — won't be worked or nagged (the owner's brake)"
                style={{ flexShrink: 0, fontFamily: font.head, fontSize: 9, fontWeight: 700, letterSpacing: "0.08em",
                  textTransform: "uppercase", color: color.bg, background: color.amber, borderRadius: 3, padding: "1px 4px" }}>
                held
              </span>
            )}
            {task.deferred && (
              <span title="Deferred — a manager's own sequencing marker, won't nag (not the owner's brake)"
                style={{ flexShrink: 0, fontFamily: font.head, fontSize: 9, fontWeight: 700, letterSpacing: "0.08em",
                  textTransform: "uppercase", color: color.bg, background: color.cyan, borderRadius: 3, padding: "1px 4px" }}>
                deferred
              </span>
            )}
            {/* `break-word` (not `anywhere`): normal titles wrap at WORD boundaries, and only a genuinely
                long unbroken token breaks mid-word. `anywhere` makes the title's min-content width one
                character, so at a crushed lane width the flex row collapses it to one letter per row. */}
            <span style={{ flex: "1 1 120px", minWidth: 0, overflowWrap: "break-word" }}>{task.title}</span>
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

// Centered modal detail dialog: view + edit a task's title and description (the `body` field that the
// MCP task tools read/write but the card never showed). Renders as a centered overlay OVER the current
// page — backdrop, ✕, click-outside or Esc closes; keyed by task id so switching cards resets the fields.
// Mirrors the RequestModal chrome (components/requests.tsx) so the task-detail and request-detail
// surfaces feel like one system. zIndex 50 sits BELOW the RequestModal's 60, so a "view ↗" from the
// Linked-requests section opens the request dialog ABOVE this one. Save patches the shared task store,
// then the board refetches. EVERY entry point (a Board card click, the `?task=` deep-link, a Request's
// reverse linked-task chip → /board?task=) funnels through Board's openTaskId state into this one modal.
function TaskDrawer({ task, column, onClose, onSave, saving, onDelete, deleting, deleteError }:
  { task: Task; column: KanbanColumn | null; onClose: () => void; onSave: (patch: { title?: string; body?: string; priority?: TaskPriority; held?: boolean; deferred?: boolean }) => void; saving: boolean;
    onDelete: () => void; deleting: boolean; deleteError: string | null }) {
  const [title, setTitle] = useState(task.title);
  const [body, setBody] = useState(task.body ?? "");
  const [priority, setPriority] = useState<TaskPriority>(prio(task));
  const [held, setHeld] = useState<boolean>(task.held ?? false);
  const [deferred, setDeferred] = useState<boolean>(task.deferred ?? false);
  // Two-step delete: a first click arms the confirm so the destructive action can't fire on a single misclick.
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const dirty = title !== task.title || body !== (task.body ?? "") || priority !== prio(task)
    || held !== (task.held ?? false) || deferred !== (task.deferred ?? false);
  // Guard the three close paths (backdrop / Esc / ✕) against silently discarding unsaved edits. When dirty,
  // a close request arms an in-drawer "Discard unsaved changes?" confirm (mirroring the delete two-step)
  // instead of closing; when clean it closes immediately, zero extra friction.
  const [confirmingClose, setConfirmingClose] = useState(false);
  const requestClose = () => { if (dirty) setConfirmingClose(true); else onClose(); };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { if (dirty) setConfirmingClose(true); else onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dirty, onClose]);

  // ── Voice dictation for the Description field (v1: this field only) ───────────────────────────
  // Reuses the same Web Speech recognizer the terminal composer uses (lib/useSpeechRecognition), so
  // there is ONE recording state machine + privacy posture across the app. The transcript is inserted
  // AT THE CARET captured when recording started — interim text shows live and is replaced as it
  // finalizes — so existing description text is never clobbered. Absence/insecure context degrade to a
  // disabled, explained mic button (the recognizer no-ops); the drawer is otherwise untouched.
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const [voiceLang] = useVoiceLang(); // shared, persisted app-wide language (read-only here)
  // Caret split captured at start: text before/after the insertion point. Insertion grows between them.
  const anchorRef = useRef<{ before: string; after: string } | null>(null);
  const [finals, setFinals] = useState(""); // finalized transcript accrued during the current recording
  const speech = useSpeechRecognition({
    lang: voiceLang,
    onFinalTranscript: (chunk) => {
      const piece = chunk.trim();
      if (!piece) return;
      setFinals((f) => (f ? `${f.replace(/\s+$/, "")} ${piece}` : piece));
    },
  });
  const dictating = speech.status === "listening" || speech.status === "requesting";
  // Compose `before + <finals + live interim> + after` into the field on every recognizer update, and
  // park the caret just past the inserted text so continued dictation reads naturally. Only while a
  // recording is live — outside that, the user owns the textarea (manual edits aren't fought).
  useEffect(() => {
    if (!dictating) return;
    const a = anchorRef.current;
    if (!a) return;
    const live = [finals.trimEnd(), speech.interim.trim()].filter(Boolean).join(" ");
    const lead = a.before && live && !/\s$/.test(a.before) ? " " : "";
    const tail = a.after && live && !/^\s/.test(a.after) ? " " : "";
    const next = a.before + lead + live + tail + a.after;
    setBody(next);
    const caret = a.before.length + lead.length + live.length;
    const ta = bodyRef.current;
    if (ta) requestAnimationFrame(() => { try { ta.setSelectionRange(caret, caret); } catch { /* detached */ } });
  }, [finals, speech.interim, dictating]);
  const startDictation = () => {
    const ta = bodyRef.current;
    const caret = ta && ta.selectionStart != null ? ta.selectionStart : body.length;
    anchorRef.current = { before: body.slice(0, caret), after: body.slice(caret) };
    setFinals("");
    speech.start();
  };
  const labelStyle = { fontFamily: font.head, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textDim } as const;

  // ── Connected requests (Dossier right rail, card 8c1f27f0) ──────────────────────────────────────
  // Every Request (pending/answered/consumed) connected to this card. Matches commit 9e5a733's
  // `db.listQuestionsForTask` project+task scoping guard client-side: filter the global inbox
  // (`openQuestions(true)` folds in consumed history) by BOTH `projectId` AND `taskId`, so a foreign-
  // project question that happens to carry this task's id can never leak in (there is no task-scoped REST
  // endpoint — 9e5a733 built the read as MCP tools only; this is the equivalent human/REST read).
  // Since 76b4bdb, `question_ask` stores the RESOLVED FULL task id, so a fresh row always matches the
  // exact `q.taskId === task.id` check below — but a row filed BEFORE that fix landed can still carry a
  // raw 8-char id-PREFIX (`question_ask({taskId: "28f425c2"})`), which never equals the card's full id.
  // The `startsWith` fallback is belt-and-suspenders for those legacy rows (card c089a959).
  const questions = useQuery({ queryKey: ["openQuestions", "history"], queryFn: () => api.openQuestions(true), refetchInterval: 5000 });
  const linked = (questions.data ?? []).filter(
    (q) => q.projectId === task.projectId && (q.taskId === task.id || (!!q.taskId && task.id.startsWith(`${q.taskId}-`))),
  );
  const hasRequests = linked.length > 0;
  // Per-user COLLAPSED preference, persisted so it survives reopen. Tri-state: `null` = no explicit
  // choice yet → default to expanded when the card HAS connected requests, collapsed when it has none.
  // Once the user toggles, their explicit boolean sticks (localStorage), regardless of the request count.
  const RAIL_KEY = "loom.taskRail.collapsed";
  const [collapsedPref, setCollapsedPref] = useState<boolean | null>(() => {
    try { const v = localStorage.getItem(RAIL_KEY); return v === null ? null : v === "1"; } catch { return null; }
  });
  const railCollapsed = collapsedPref ?? !hasRequests;
  const toggleRail = () => {
    const next = !railCollapsed;
    setCollapsedPref(next);
    try { localStorage.setItem(RAIL_KEY, next ? "1" : "0"); } catch { /* storage may be unavailable */ }
  };

  return (
    <div onClick={requestClose} role="dialog" aria-modal
      style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.55)", zIndex: 50, display: "flex",
        alignItems: "flex-start", justifyContent: "center", padding: "6vh 16px", overflowY: "auto" }}>
      <div onClick={(e) => e.stopPropagation()}
        style={{ width: "min(820px, 92vw)", maxWidth: "100%",
          // Grow toward the viewport height on a large window (the flex:1 description below absorbs the
          // extra room and scrolls internally): floor at min(820px, 85vh) — 820px mirrors the width cap
          // and bounds the height on a huge monitor — and cap at 88vh (with the overlay's 6vh top/bottom
          // padding that's an exact fit). On a short viewport the 85vh floor collapses below the 88vh cap
          // and the panel itself scrolls (overflowY) instead of overflowing. Sibling to the width cap.
          minHeight: "min(820px, 85vh)", maxHeight: "88vh", overflowY: "auto",
          background: color.panel, border: `1px solid ${color.borderStrong}`,
          borderRadius: radius.base, padding: 16, display: "flex", flexDirection: "column", gap: 10, boxSizing: "border-box" }}>
        {/* Dossier header: TASK · id · priority · lane · close. The priority chip reflects the LIVE
            edited priority (updates as you pick below); the lane chip is tinted by the column's role. */}
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <SectionLabel style={{ margin: 0 }}>Task · {task.id.slice(0, 8)}</SectionLabel>
          <PriorityChip priority={priority} />
          {column && <Badge tone={columnTone(column) ?? "muted"}>{column.label}</Badge>}
          <span style={{ flex: 1 }} />
          <Button onClick={requestClose} title="Close (Esc)">✕</Button>
        </div>
        {/* Unsaved-edit guard: a close request while dirty arms this confirm instead of discarding. */}
        {confirmingClose && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 8px", borderRadius: 4,
            background: color.panel2, border: `1px solid ${color.amber}` }}>
            <span style={{ flex: 1, color: color.amber, fontSize: 12, fontFamily: font.mono }}>Discard unsaved changes?</span>
            <Button variant="danger" onClick={onClose}>Discard</Button>
            <Button onClick={() => setConfirmingClose(false)}>Cancel</Button>
          </div>
        )}
        {/* Dossier body: LEFT = task editing, RIGHT = connected-requests rail. When the rail is collapsed
            the left column expands to full width (single-column); flexWrap lets the two stack on a narrow
            panel. flex:1 so the body fills the panel down to its min-height. */}
        <div style={{ display: "flex", gap: 14, flex: 1, minHeight: 0, alignItems: "stretch",
          flexWrap: railCollapsed ? "nowrap" : "wrap" }}>
          <div data-testid="task-edit-column" style={{ flex: railCollapsed ? "1 1 auto" : "2 1 360px", minWidth: 0, display: "flex",
            flexDirection: "column", gap: 10, minHeight: 0 }}>
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
        {/* Owner HOLD gate — the SOLE human brake (Board Hold Model): held=true means this card won't be
            worked (spawnWorker refuses to dispatch onto it) AND won't nag (excluded from the idle-watcher's
            actionable count) — in whatever column it sits. Distinct from priority/column — an owner-only
            "don't touch this" signal. Persisted on the same task store the MCP tools read. */}
        <span style={labelStyle}>Hold</span>
        <button type="button" role="switch" aria-checked={held} aria-label="Held — won't be worked or nagged"
          title={held
            ? "Held — won't be worked or nagged. No worker will be dispatched onto this card and the idle watchdog won't nag about it. Click to release."
            : "Not held — click to hold this card so it won't be worked or nagged."}
          onClick={() => setHeld((h) => !h)}
          style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", textAlign: "left",
            padding: "6px 8px", borderRadius: 4, background: color.panel2,
            border: `1px solid ${held ? color.amber : color.border}` }}>
          <span aria-hidden style={{ width: 30, height: 16, borderRadius: 999, flexShrink: 0, position: "relative",
            background: held ? color.amber : color.border, transition: "background 0.12s" }}>
            <span style={{ position: "absolute", top: 2, left: held ? 16 : 2, width: 12, height: 12, borderRadius: 999,
              background: color.bg, transition: "left 0.12s" }} />
          </span>
          <span style={{ fontFamily: font.mono, fontSize: 12, color: held ? color.amber : color.textDim }}>
            {held ? "Held — won't be worked or nagged" : "Not held"}
          </span>
        </button>
        {/* Manager DEFERRED marker — orthogonal to Hold: a manager's own sequencing/dependency-gating
            signal (won't nag the idle watchdog) that, UNLIKE Hold, never blocks worker_spawn. Distinct
            cyan styling so it never reads as the owner's brake. */}
        <span style={labelStyle}>Defer</span>
        <button type="button" role="switch" aria-checked={deferred} aria-label="Deferred — sequencing marker, won't nag"
          title={deferred
            ? "Deferred — your own sequencing marker; won't nag the idle watchdog, but a worker can still be dispatched onto it. Click to un-defer."
            : "Not deferred — click to defer this card as your own sequencing marker (not a brake)."}
          onClick={() => setDeferred((d) => !d)}
          style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", textAlign: "left",
            padding: "6px 8px", borderRadius: 4, background: color.panel2,
            border: `1px solid ${deferred ? color.cyan : color.border}` }}>
          <span aria-hidden style={{ width: 30, height: 16, borderRadius: 999, flexShrink: 0, position: "relative",
            background: deferred ? color.cyan : color.border, transition: "background 0.12s" }}>
            <span style={{ position: "absolute", top: 2, left: deferred ? 16 : 2, width: 12, height: 12, borderRadius: 999,
              background: color.bg, transition: "left 0.12s" }} />
          </span>
          <span style={{ fontFamily: font.mono, fontSize: 12, color: deferred ? color.cyan : color.textDim }}>
            {deferred ? "Deferred — sequencing marker, won't nag" : "Not deferred"}
          </span>
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ ...labelStyle, flex: 1 }}>Description</span>
          <DescriptionMic speech={speech} dictating={dictating} onStart={startDictation} />
        </div>
        <textarea ref={bodyRef} value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false}
          placeholder="No description yet — agents fill this in via the task tools, or write one here."
          style={{
            flex: 1, minHeight: 200, width: "100%", boxSizing: "border-box", resize: "none",
            fontFamily: font.mono, fontSize: 13, lineHeight: 1.5,
            background: color.panel2, color: color.text, border: `1px solid ${color.border}`, borderRadius: 6, padding: 8,
          }} />
        {speech.supported && <DescriptionVoiceNote speech={speech} />}
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <Button variant="primary" disabled={!dirty || saving} onClick={() => onSave({ title, body, priority, held, deferred })}>{saving ? "Saving…" : "Save"}</Button>
          {dirty
            ? <Button onClick={() => { setTitle(task.title); setBody(task.body ?? ""); setPriority(prio(task)); setHeld(task.held ?? false); setDeferred(task.deferred ?? false); }}>Reset</Button>
            : <span style={{ color: color.phosphor, fontSize: 12, fontFamily: font.mono }}>saved</span>}
          {/* Destructive delete, pushed to the right and visually separated from Save. Two-step confirm. */}
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 6 }}>
            {confirmingDelete ? (
              <>
                <span style={{ color: color.red, fontSize: 12, fontFamily: font.mono }}>Delete?</span>
                <Button variant="danger" disabled={deleting} onClick={onDelete}>{deleting ? "Deleting…" : "Confirm"}</Button>
                <Button disabled={deleting} onClick={() => setConfirmingDelete(false)}>Cancel</Button>
              </>
            ) : (
              <Button variant="danger" onClick={() => setConfirmingDelete(true)}>Delete</Button>
            )}
          </div>
        </div>
        {/* The server's live-session guard (or any failure) surfaces here rather than silently closing. */}
        {deleteError && <span style={{ color: color.red, fontSize: 12, fontFamily: font.mono }}>{deleteError}</span>}
          </div>
          {/* RIGHT rail — the card's connected requests (card 8c1f27f0). Collapsed → a slim, clickable
              strip so the left editing column takes the full width; expanded → the full dossier rail. */}
          {railCollapsed
            ? <CollapsedRequestsStrip count={linked.length} onExpand={toggleRail} />
            : <ConnectedRequestsRail linked={linked} onCollapse={toggleRail} />}
        </div>
      </div>
    </div>
  );
}

// ── Connected-requests rail (Dossier RIGHT column, card 8c1f27f0) ─────────────────────────────────
// The expanded rail: header (title + count + collapse control), a by-state summary line, then one
// signal row per connected request — the same visual language as the Requests inbox (components/
// requests.tsx): a 3px left edge signed by the type's color, a bordered type tag + lifecycle state
// chip, the title, and the asking-agent/time meta. Each row inline-expands to its recorded answer.
function ConnectedRequestsRail({ linked, onCollapse }: { linked: QuestionInboxItem[]; onCollapse: () => void }) {
  const now = Date.now();
  const pending = linked.filter((q) => q.state === "pending").length;
  const answered = linked.filter((q) => q.state === "answered").length;
  const consumed = linked.filter((q) => q.state === "consumed").length;
  return (
    <div data-testid="task-requests-rail"
      style={{ flex: "1 1 280px", minWidth: 240, maxWidth: "100%", display: "flex", flexDirection: "column",
        minHeight: 0, background: color.panel2, border: `1px solid ${color.border}`, borderRadius: radius.base }}>
      {/* Header (pinned) — title + count + collapse control. */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 10px 8px", borderBottom: `1px solid ${color.border}` }}>
        <span style={{ fontFamily: font.head, fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textDim }}>
          Connected requests
        </span>
        <span style={{ fontFamily: font.mono, fontSize: 11, fontWeight: 700, color: linked.length > 0 ? color.cyan : color.textMuted }}>{linked.length}</span>
        <span style={{ flex: 1 }} />
        <button type="button" onClick={onCollapse} aria-expanded aria-label="Collapse connected requests"
          title="Collapse the requests rail" data-testid="task-requests-collapse" className="loom-toggle"
          style={{ background: "transparent", border: "none", cursor: "pointer", color: color.textDim,
            fontSize: 15, lineHeight: 1, padding: "2px 4px", borderRadius: 3 }}>›</button>
      </div>
      {linked.length === 0 ? (
        // Empty state — reads as intentional, not broken. (A card with no requests defaults to collapsed,
        // but the user can still expand the empty rail.)
        <div style={{ padding: "14px 10px", color: color.textMuted, fontFamily: font.mono, fontSize: 11, lineHeight: 1.5 }}>
          No requests connected to this card yet. A manager links owner Requests to a card so the answer travels with the work.
        </div>
      ) : (
        <>
          {/* By-state summary line. */}
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 10px", flexWrap: "wrap",
            fontFamily: font.mono, fontSize: 11, color: color.textMuted, borderBottom: `1px solid ${color.border}` }}>
            <span style={{ color: pending > 0 ? color.cyan : color.textMuted }}>{pending} pending</span>
            <span aria-hidden>·</span>
            <span>{answered} answered</span>
            <span aria-hidden>·</span>
            <span>{consumed} consumed</span>
          </div>
          {/* Signal rows — the lone scroll region so the header + summary stay pinned. */}
          <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "flex", flexDirection: "column", gap: 6, padding: 10 }}>
            {linked.map((q) => <ConnectedRequestRow key={q.id} q={q} now={now} />)}
          </div>
        </>
      )}
    </div>
  );
}

// One connected-request signal row. The header (type tag · state chip · title · agent/time meta) toggles
// an inline answer readout; "Open request ↗" opens the shared Request detail modal for the full view.
function ConnectedRequestRow({ q, now }: { q: QuestionInboxItem; now: number }) {
  const openRequest = useOpenRequest();
  const [open, setOpen] = useState(false);
  const edge = tone[REQUEST_TYPE_TONE[q.type]];
  return (
    <div style={{ border: `1px solid ${color.border}`, borderLeft: `3px solid ${edge}`, borderRadius: 4, background: color.panel }}>
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
        title={open ? "Hide the answer" : "Show the answer"} className="loom-toggle"
        style={{ width: "100%", textAlign: "left", cursor: "pointer", background: "transparent", border: "none",
          padding: "6px 8px", display: "flex", flexDirection: "column", gap: 4, borderRadius: 4 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
          <RequestTypeTag type={q.type} />
          <DecisionStateChip q={q} now={now} />
          <span aria-hidden style={{ marginLeft: "auto", color: color.textMuted, fontSize: 11, flexShrink: 0,
            transition: "transform 120ms ease", transform: open ? "rotate(90deg)" : "none" }}>▸</span>
        </div>
        <span style={{ fontFamily: font.mono, fontSize: 12, color: color.text, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={q.title}>{q.title}</span>
        <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          agent {q.sessionId.slice(0, 8)} · {relativeAge(q.state === "pending" ? q.createdAt : q.answeredAt, now)}
        </span>
      </button>
      {open && (
        <div style={{ borderTop: `1px solid ${color.border}`, padding: 8, display: "flex", flexDirection: "column", gap: 8 }}>
          <ConnectedRequestAnswer q={q} />
          <Button variant="ghost" onClick={() => openRequest(q.id)} style={{ padding: "0 6px", alignSelf: "flex-start" }}>Open request ↗</Button>
        </div>
      )}
    </div>
  );
}

// The inline-expanded answer for a connected request. Mirrors requests.tsx › AnsweredReadout: a credential
// NEVER shows a value — only the ack + the target env var (the read tool never returns a secret). A pending
// request has no answer yet, so it shows the ask body + a type-colored "needs …" hint instead.
function ConnectedRequestAnswer({ q }: { q: QuestionInboxItem }) {
  if (q.state === "pending") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        {q.body && <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textDim, lineHeight: 1.5, whiteSpace: "pre-wrap" }}>{q.body}</span>}
        <span style={{ fontFamily: font.mono, fontSize: 11, color: tone[REQUEST_TYPE_TONE[q.type]] }}>{requestHint(q)} · awaiting your answer</span>
      </div>
    );
  }
  if (q.type === "credential") {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textDim }}>provided · encrypted, never shown</span>
        {q.credentialEnvVar && (
          <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textMuted }}>
            target env var: <span style={{ color: color.amber }}>{q.credentialEnvVar}</span>
          </span>
        )}
      </div>
    );
  }
  if (q.type === "permission") {
    const authorized = q.chosenOption === "authorize";
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ fontFamily: font.mono, fontSize: 12, color: authorized ? color.phosphor : color.red }}>{authorized ? "authorized" : "denied"}</span>
        {q.note && <span style={{ fontFamily: font.mono, fontSize: 11, color: color.textDim, whiteSpace: "pre-wrap" }}>{q.note}</span>}
      </div>
    );
  }
  // decision / input — chosen option + note (the note IS the answer for a note-only ask).
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {q.chosenOption && <span style={{ fontFamily: font.mono, fontSize: 12, color: color.text }}>chose <span style={{ color: color.cyan }}>{q.chosenOption}</span></span>}
      {q.note && <span style={{ fontFamily: font.mono, fontSize: 12, color: color.textDim, whiteSpace: "pre-wrap" }}>{q.note}</span>}
      {!q.chosenOption && !q.note && <span style={{ color: color.textMuted, fontSize: 12, fontFamily: font.mono }}>—</span>}
    </div>
  );
}

// The COLLAPSED connected-requests rail: a slim, full-height vertical strip pinned to the modal's right
// edge. Clicking it re-expands the rail; while collapsed the left editing column takes the full width.
// Keeps the requests DISCOVERABLE (a count badge) without spending horizontal room.
function CollapsedRequestsStrip({ count, onExpand }: { count: number; onExpand: () => void }) {
  return (
    <button type="button" onClick={onExpand} aria-expanded={false} aria-label={`Expand connected requests (${count})`}
      title="Expand connected requests" data-testid="task-requests-collapsed"
      style={{ flex: "0 0 auto", alignSelf: "stretch", width: 36, display: "flex", flexDirection: "column",
        alignItems: "center", gap: 10, padding: "10px 0", cursor: "pointer",
        background: color.panel2, border: `1px solid ${color.border}`, borderRadius: radius.base }}>
      <span aria-hidden style={{ color: color.textDim, fontSize: 14, lineHeight: 1 }}>‹</span>
      <span aria-hidden style={{ fontFamily: font.head, fontSize: 9, fontWeight: 700, letterSpacing: "0.14em",
        textTransform: "uppercase", color: color.textMuted, writingMode: "vertical-rl" }}>
        Requests
      </span>
      <span style={{ fontFamily: font.mono, fontSize: 11, fontWeight: 700, color: count > 0 ? color.cyan : color.textMuted }}>{count}</span>
    </button>
  );
}

// Click-only mic toggle beside the Description label. Idle → click to dictate; listening → red pulse +
// click to stop. Always rendered (so the capability is discoverable) but disabled — with an explaining
// tooltip — when the browser lacks the Web Speech API (e.g. Firefox) or the page isn't a secure context.
function DescriptionMic({ speech, dictating, onStart }:
  { speech: SpeechRecognitionApi; dictating: boolean; onStart: () => void }) {
  const listening = speech.status === "listening";
  const requesting = speech.status === "requesting";
  const disabled = !speech.supported || !speech.secure || requesting;
  const title = !speech.supported
    ? "Voice dictation isn't available in this browser — try Chrome"
    : !speech.secure
      ? "Voice dictation needs a secure context (https or localhost)"
      : listening
        ? "Stop dictation"
        : "Dictate into the description — the transcript inserts at the caret (review before saving)";
  return (
    <Button
      type="button"
      variant={listening ? "danger" : "default"}
      disabled={disabled}
      aria-pressed={listening}
      aria-label={listening ? "Stop voice dictation" : "Start voice dictation for the description"}
      title={title}
      onClick={dictating ? speech.stop : onStart}
      style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "3px 9px" }}
    >
      <span
        className={listening ? "loom-mic-pulse" : undefined}
        style={{ width: 7, height: 7, borderRadius: 7, display: "inline-block",
          background: listening ? color.red : disabled ? color.textMuted : color.phosphor }}
      />
      {listening ? "Stop" : requesting ? "starting…" : "Dictate"}
    </Button>
  );
}

// One muted line under the Description: live recognition state on the left, the standing privacy
// disclosure on the right. Local-first honesty: browser dictation is NOT on-device — Chrome streams the
// captured audio to Google's speech service — so we say so plainly rather than implying it stays local.
function DescriptionVoiceNote({ speech }: { speech: SpeechRecognitionApi }) {
  const { status, interim, error, secure } = speech;
  let node: React.ReactNode = null;
  if (!secure) node = <span style={{ color: color.amber }}>voice needs a secure context</span>;
  else if (status === "requesting") node = <span style={{ color: color.textDim }}>requesting microphone…</span>;
  else if (status === "listening") node = (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, minWidth: 0 }}>
      <StatusPill tone="red" label="rec" glow />
      {interim
        ? <span style={{ color: color.textMuted, fontStyle: "italic", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{interim}…</span>
        : <span style={{ color: color.textDim }}>listening — speak, then Stop</span>}
    </span>
  );
  else if (status === "denied") node = <span style={{ color: color.red }}>mic permission denied — allow it in your browser site settings</span>;
  else if (status === "error") node = <span style={{ color: color.red }}>{error ?? "voice error"} — click Dictate to retry</span>;
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, marginTop: 2,
      fontFamily: font.mono, fontSize: 10, minHeight: 16 }}>
      <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0 }}>{node}</span>
      <span title="The browser Web Speech API is not on-device — Chrome streams audio to Google's speech service."
        style={{ color: color.textMuted, whiteSpace: "nowrap" }}>dictation may send audio to your browser's speech service</span>
    </div>
  );
}

function NewTask({ onCreate }: { onCreate: (title: string) => void }) {
  const [title, setTitle] = useState("");
  const submit = () => { if (title.trim()) { onCreate(title); setTitle(""); } };
  // flexWrap + a shrinkable, growing input: on a narrow viewport the button wraps below instead of
  // forcing the row (and the page) to overflow horizontally. Enter submits (keyboard parity with the button).
  return (
    <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
      <Input placeholder="new task title" value={title} onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submit(); } }}
        style={{ flex: "1 1 260px", minWidth: 0 }} />
      <Button variant="primary" disabled={!title.trim()} onClick={submit}>Add to Inbox</Button>
    </div>
  );
}

// First-load placeholder for the board — a few lane shells matching the real column chrome (border,
// radius, the 3px top-bar reserve) so the layout doesn't pop in from a blank page. The faint pulse
// (.loom-skeleton) is dropped under prefers-reduced-motion. Reuses .loom-board-grid so it's responsive too.
function BoardSkeleton() {
  return (
    <div className="loom-board-grid loom-skeleton" style={{ marginTop: 10 }} aria-hidden>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} style={{ background: color.panel, border: `1px solid ${color.border}`, borderRadius: 4,
          minHeight: 200, maxHeight: "75vh", display: "flex", flexDirection: "column" }}>
          <div style={{ height: 3 }} />
          <div style={{ height: 11, width: "44%", margin: "12px 12px 12px", background: color.border, borderRadius: 3 }} />
          <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "0 12px 12px" }}>
            {Array.from({ length: 3 }).map((_, j) => (
              <div key={j} style={{ height: 34, background: color.panel2, border: `1px solid ${color.border}`,
                borderLeft: `3px solid ${color.border}`, borderRadius: 4 }} />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
