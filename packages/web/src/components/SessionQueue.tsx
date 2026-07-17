import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type QueuedMessage } from "../lib/api";
import { Button, Dot } from "./ui";
import { color, font, radius } from "../theme";

// ── SessionQueue — the "ledger bar" for a session's QUEUED inbound messages ─────────────────────────
//
// Direction B, owner-approved 2026-07-06 (`Projects/Loom/Design/Queue Redesign.md`). When ≥1 message is
// held (session busy / human mid-compose) the queue renders as ONE constant-height "ledger bar" directly
// under the terminal: an amber tick, "QUEUED (n)", a one-line peek of the next-up message, and a chevron.
// The bar's footprint NEVER changes with backlog depth — a card with 1 queued and a card with 50 queued
// look identical at rest — and (in TerminalCard's HUG height model) the bar GROWS THE CARD rather than
// shrinking the terminal: TerminalCard excludes this element from the terminal's height budget, so the
// terminal region holds a fixed height in every queue state. Clicking the bar expands a BOUNDED,
// internally-scrollable drawer listing every queued message with its full affordances; collapse returns
// to the one-liner. Renders nothing when empty, so it stays completely out of the way.
//
// Three row species share the one FIFO and render together in the drawer:
//   • 'human' entries (composer turns) are fully adjustable: reorder (↑/↓), edit in place (✎), remove (✕);
//   • Loom nudges ('warning' kind — idle/context watchdog, restart/memory-recall injections like
//     [loom:worker-idle]) are Loom's OWN text: the human may reorder (↑/↓) and remove (✕) them, but not
//     rewrite them (editing a Loom nudge is meaningless);
//   • agent-authored entries ('system' source + 'agent' kind — worker reports / manager direction) render
//     READ-ONLY — the human never rewrites or reorders an agent's message out from under it (the daemon
//     mutators refuse it too).
// They still drain on their own (next turn boundary / reconcile tick). Every mutation is id-addressed: the
// FIFO head can drain between the 3s poll and a click, so an id op targets exactly one entry and is a
// harmless no-op once it has drained.
//
// Reorder moves a MUTABLE entry (human + Loom-nudge) only among the OTHER mutable entries (agent-authored
// entries hold their slot), so ↑/↓ sends the mutable ids' desired order and the daemon permutes them
// within those slots.

// Which entries the human may act on: their OWN composer turns PLUS Loom's OWN 'warning' nudges. An
// agent-authored entry (system source + 'agent' kind) stays read-only. Mirrors the daemon's isHumanMutable.
const isMutable = (m: QueuedMessage) => m.source === "human" || m.kind === "warning";
// Edit (rewrite in place) is reserved for the human's own composed turns — a Loom nudge is deletable /
// reorderable but not editable.
const isEditable = (m: QueuedMessage) => m.source === "human";

// Bounded drawer height (px) — the approved mockup's cap. Beyond it, the drawer scrolls internally so the
// footprint stays bounded no matter how deep the backlog is.
const DRAWER_MAX_H = 118;

export function SessionQueue({
  sessionId, pending: bulkPending, onMutated,
}: {
  sessionId: string;
  /** Pre-fetched pending list from a shared parent-level bulk query (Overview/Terminals batching — see
   * useSessionQueuesBulk). When supplied, this card skips its own per-session 3s poll entirely. */
  pending?: QueuedMessage[];
  /** Called after a mutation (delete/edit/reorder) settles, in place of invalidating this card's own
   * per-session query — only meaningful (and required) alongside `pending`, whose owning bulk query
   * this card doesn't otherwise know how to invalidate. */
  onMutated?: () => void;
}) {
  const qc = useQueryClient();
  const bulkMode = bulkPending !== undefined;
  const q = useQuery({
    queryKey: ["queue", sessionId],
    queryFn: () => api.sessionQueue(sessionId),
    refetchInterval: 3000,
    enabled: !bulkMode,
  });
  const [expanded, setExpanded] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const pending = bulkMode ? bulkPending! : (q.data?.pending ?? []);

  const invalidate = () => (bulkMode ? onMutated?.() : qc.invalidateQueries({ queryKey: ["queue", sessionId] }));
  const del = useMutation({ mutationFn: (id: string) => api.deleteQueued(sessionId, id), onSettled: invalidate });
  const reorder = useMutation({ mutationFn: (ids: string[]) => api.reorderQueued(sessionId, ids), onSettled: invalidate });
  const edit = useMutation({
    mutationFn: ({ id, text }: { id: string; text: string }) => api.editQueued(sessionId, id, text),
    onSuccess: () => { setEditingId(null); invalidate(); },
  });
  const mutating = del.isPending || reorder.isPending || edit.isPending;

  if (pending.length === 0) return null;

  // Reorder operates on the MUTABLE entries only (human turns + Loom nudges) — agent-authored entries keep
  // their slot (the daemon pins them). Move the entry `id` by `dir` (±1) within that ordering and send it.
  const movableIds = pending.filter(isMutable).map((m) => m.id);
  const move = (id: string, dir: -1 | 1) => {
    const k = movableIds.indexOf(id);
    const j = k + dir;
    if (k < 0 || j < 0 || j >= movableIds.length) return;
    const order = [...movableIds];
    [order[k], order[j]] = [order[j]!, order[k]!];
    reorder.mutate(order);
  };

  const peek = pending[0]!.text.replace(/\s+/g, " ").trim();

  return (
    <div style={{ marginTop: 6 }}>
      {/* The constant-height ledger bar. Its height is invariant to backlog depth (always one peek line);
          click anywhere on it to expand / collapse the drawer. */}
      <div
        data-testid="queue-ledger-bar"
        onClick={() => setExpanded((e) => !e)}
        title={expanded ? "Collapse the queue" : "Expand to reorder / edit / remove queued messages"}
        style={{
          display: "flex", alignItems: "center", gap: 8, cursor: "pointer", userSelect: "none",
          background: color.panel2, border: `1px solid ${expanded ? color.borderStrong : color.border}`,
          borderRadius: radius.base, padding: "5px 8px",
        }}
      >
        <Dot tone="amber" />
        <span style={{ fontFamily: font.head, fontSize: 10, textTransform: "uppercase", letterSpacing: "0.1em", color: color.textMuted, flexShrink: 0 }}>
          Queued <span style={{ color: color.amber }}>({pending.length})</span>
        </span>
        {expanded ? (
          <span style={{ flex: 1, minWidth: 0, fontFamily: font.head, fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", color: color.textMuted }}>
            manage · reorder · edit
          </span>
        ) : (
          <>
            <span style={{ fontFamily: font.head, fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", color: color.textMuted, flexShrink: 0 }}>next</span>
            <span title={pending[0]!.text} style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: font.mono, fontSize: 11, color: color.textDim }}>
              {peek}
            </span>
          </>
        )}
        <span aria-hidden style={{ marginLeft: "auto", flexShrink: 0, color: color.textMuted, fontSize: 11, fontFamily: font.mono }}>
          {expanded ? "▾" : "▸"}
        </span>
      </div>

      {/* Bounded, internally-scrollable drawer — the full queue with its per-entry controls. It grows the
          card (in HUG mode) rather than the terminal, then scrolls once it hits DRAWER_MAX_H. */}
      {expanded && (
        <div
          data-testid="queue-drawer"
          style={{
            marginTop: 4, background: color.panel2, border: `1px solid ${color.border}`, borderRadius: radius.base,
            padding: 4, maxHeight: DRAWER_MAX_H, overflowY: "auto", display: "flex", flexDirection: "column", gap: 3,
          }}
        >
          {pending.map((m) => {
            const mIdx = isMutable(m) ? movableIds.indexOf(m.id) : -1;
            return (
              <QueueRow
                key={m.id}
                m={m}
                canUp={mIdx > 0}
                canDown={mIdx >= 0 && mIdx < movableIds.length - 1}
                editing={editingId === m.id}
                busy={mutating}
                onEditStart={() => setEditingId(m.id)}
                onEditCancel={() => setEditingId(null)}
                onEditSave={(text) => edit.mutate({ id: m.id, text })}
                onDelete={() => del.mutate(m.id)}
                onUp={() => move(m.id, -1)}
                onDown={() => move(m.id, 1)}
              />
            );
          })}
        </div>
      )}
    </div>
  );
}

function QueueRow({
  m, canUp, canDown, editing, busy, onEditStart, onEditCancel, onEditSave, onDelete, onUp, onDown,
}: {
  m: QueuedMessage;
  canUp: boolean;
  canDown: boolean;
  editing: boolean;
  busy: boolean;
  onEditStart: () => void;
  onEditCancel: () => void;
  onEditSave: (text: string) => void;
  onDelete: () => void;
  onUp: () => void;
  onDown: () => void;
}) {
  const rowStyle = { display: "flex", gap: 6, alignItems: editing ? "flex-start" : "center", padding: "2px 4px", borderRadius: radius.sm } as const;
  const preview = m.text.replace(/\s+/g, " ").trim();

  // Agent-authored entries (worker reports / manager direction) are READ-ONLY: a calm cyan-dot row, no
  // controls, no edit. The human never rewrites or reorders another agent's message out from under it.
  if (!isMutable(m)) {
    return (
      <div style={rowStyle} title={`${m.text}\n\n(worker / agent message — read-only)`}>
        <Dot tone="cyan" />
        <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: font.mono, fontSize: 11, color: color.textDim }}>
          {preview}
        </span>
        <span style={{ fontFamily: font.head, fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", color: color.textMuted }}>worker</span>
      </div>
    );
  }

  const editable = isEditable(m);

  if (editing && editable) {
    // Mounted fresh per edit, so the draft always seeds from the CURRENT text.
    return <div style={rowStyle}><QueueEditor initial={m.text} busy={busy} onSave={onEditSave} onCancel={onEditCancel} /></div>;
  }

  // Mutable rows: the human's own composer turns (amber dot, editable) and Loom's own operational nudges
  // ('warning' kind — a muted dot + a "loom" tag, removable/reorderable but not editable).
  return (
    <div style={rowStyle}>
      <div style={{ display: "inline-flex", gap: 2 }}>
        <IconBtn title="Move up" disabled={!canUp || busy} onClick={onUp}>↑</IconBtn>
        <IconBtn title="Move down" disabled={!canDown || busy} onClick={onDown}>↓</IconBtn>
      </div>
      <Dot tone={editable ? "amber" : "muted"} />
      <span
        onClick={editable ? onEditStart : undefined}
        title={editable ? m.text : `${m.text}\n\n(Loom nudge — remove or reorder, not editable)`}
        style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontFamily: font.mono, fontSize: 11, color: color.textDim, cursor: editable ? "text" : "default" }}
      >
        {preview}
      </span>
      {editable
        ? <IconBtn title="Edit this queued message" disabled={busy} onClick={onEditStart}>✎</IconBtn>
        : <span style={{ fontFamily: font.head, fontSize: 9, textTransform: "uppercase", letterSpacing: "0.08em", color: color.textMuted }}>loom</span>}
      <IconBtn title="Remove from queue" variant="danger" disabled={busy} onClick={onDelete}>✕</IconBtn>
    </div>
  );
}

function QueueEditor({ initial, busy, onSave, onCancel }: { initial: string; busy: boolean; onSave: (text: string) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState(initial);
  const submit = () => { if (draft.trim()) onSave(draft); };
  return (
    <div style={{ flex: 1, minWidth: 0, display: "flex", gap: 4, alignItems: "stretch" }}>
      <textarea
        value={draft}
        autoFocus
        rows={2}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
          else if (e.key === "Escape") { e.preventDefault(); onCancel(); }
        }}
        style={{ flex: 1, minWidth: 0, resize: "vertical", boxSizing: "border-box", background: color.panel2, color: color.text, border: `1px solid ${color.borderStrong}`, borderRadius: 4, padding: "4px 6px", fontFamily: font.mono, fontSize: 11 }}
      />
      <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <Button variant="primary" disabled={!draft.trim() || busy} onClick={submit} style={{ padding: "2px 8px", fontSize: 11 }}>Save</Button>
        <Button disabled={busy} onClick={onCancel} style={{ padding: "2px 8px", fontSize: 11 }}>Cancel</Button>
      </div>
    </div>
  );
}

// Compact ghost icon-button for the per-row controls (↑ ↓ ✎ ✕) — tight padding so a row stays one line tall.
function IconBtn({ title, disabled, variant, onClick, children }: { title: string; disabled?: boolean; variant?: "ghost" | "danger"; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button
      variant={variant ?? "ghost"}
      title={title}
      disabled={disabled}
      onClick={onClick}
      style={{ padding: "0 6px", fontSize: 12, lineHeight: "20px", minWidth: 0 }}
    >
      {children}
    </Button>
  );
}
