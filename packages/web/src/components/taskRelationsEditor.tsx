// The board card dialog's relation EDITOR (card 03d9db6e — the owner's "UI Features in board card
// dialog for users to set and adjust Task relations"). Logic lives in lib/taskRelationsEdit; this file
// is presentation only.
//
// Design posture, matched to the dialog it sits in rather than invented: one flat label+control pair
// per kind on the same left rule as TITLE / PRIORITY / PARENT / HOLD; COLLAPSED AT REST (a kind with
// nothing in it renders no row, and a card with no relations costs one ghost link — five always-open
// pickers would be ~120px on every open, the cost the Parent field was collapsed to avoid); edits
// STAGED onto the dialog's own Save like every other field; and the read side's glyph/colour
// vocabulary (components/taskLinks) reused rather than extended.
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import type { KanbanColumn } from "@loom/shared";
import { Badge, Button, Input, Select } from "./ui";
import { TaskLinkRow } from "./taskLinks";
import { color, columnTone, font, radius, fs } from "../theme";
import type { TaskLinks, TaskRef } from "../lib/taskHierarchy";
import {
  EDITABLE_RELATION_KINDS, EDIT_RELATION_HINT, EDIT_RELATION_LABEL, isSingleValueKind,
  refById, relationErrorTarget, releasedHistory, searchCards,
  type EditableRelationKind, type PickerCard, type RelationDraft,
} from "../lib/taskRelationsEdit";

/** How many picker results to render at once. Past this the list says it is capped. */
const PICKER_LIMIT = 8;

const sectionLabel: CSSProperties = {
  fontFamily: font.ui, fontSize: fs.xs, fontWeight: 700, color: color.text2,
};

/**
 * The width of the label column that the relation rows below and the dialog's PARENT summary row
 * above them BOTH lay out on — an explicit width, not the `auto` this column used to be.
 *
 * @decision 03d9db6e — keep ONE label-column width across the two grids; an `auto`/`max-content`
 * track on either side sizes from that side's own labels alone and the values stop lining up.
 *
 * Sized to clear the widest label this column ever carries (`EDIT_RELATION_LABEL` uppercased, plus
 * "Parent") with headroom for the fallback face that renders before the head face (`--loom-font-ui`) loads. A label is
 * `nowrap`, so one wider than this overflows into the value column rather than wrapping;
 * `board-relations-grid-align.spec.ts` asserts none does, so a label that needs more room fails
 * there rather than colliding silently on screen.
 */
export const RELATION_LABEL_COL = 112;

/**
 * The grid the relation rows and the parent summary row share. Exported so there is exactly one
 * declaration of the column geometry; `pages/Board.tsx` lays its parent row out on this same object.
 */
export const relationGrid: CSSProperties = {
  display: "grid", gridTemplateColumns: `${RELATION_LABEL_COL}px minmax(0, 1fr)`,
  columnGap: 10, rowGap: 6, alignItems: "start", minWidth: 0,
};

/** A label in that grid's first column. Exported with the grid so the parent's label can't drift from it. */
export const relationRowLabel: CSSProperties = { ...sectionLabel, paddingTop: 3, whiteSpace: "nowrap" };

/** A staged chip's glyph/tone, keyed by kind — the read side's vocabulary, one place. */
const KIND_GLYPH: Record<EditableRelationKind, string> = {
  blockedBy: "⊘", blocks: "·", related: "·", discoveredFrom: "↳",
};

export function TaskRelationsEditor({
  selfId, links, draft, baseline, cards, columns, titleById, saveErrorMessage, onChange, onOpenTask,
}: {
  selfId: string;
  /** The SERVED relation view — titles, lanes and the released/resolved marks the chips render from. */
  links: TaskLinks;
  /** The staged set (already falls through to `baseline` when the user hasn't touched anything). */
  draft: RelationDraft;
  /** The set a Save would have to send to change nothing — `relationBaseline(links)`. */
  baseline: RelationDraft;
  /** Every card on the loaded board, for the picker. */
  cards: PickerCard[];
  columns: KanbanColumn[];
  titleById: Map<string, string>;
  /** The last save failure's message, verbatim — placed, never reworded. */
  saveErrorMessage: string | null;
  onChange: (next: RelationDraft) => void;
  onOpenTask: (id: string) => void;
}) {
  // Which kind the picker is currently adding to; null = picker closed (the collapsed-at-rest state).
  const [picking, setPicking] = useState<EditableRelationKind | null>(null);
  const errorTarget = relationErrorTarget(saveErrorMessage);

  // A kind gets a row when it has anything to show — staged ids, or released history (which is never
  // staged but still worth showing). Everything else stays collapsed behind "Add relation…".
  const rows = EDITABLE_RELATION_KINDS
    .map((kind) => ({ kind, ids: draft[kind], released: releasedHistory(links, kind) }))
    .filter((r) => r.ids.length > 0 || r.released.length > 0);

  const chipRef = (kind: EditableRelationKind, id: string): TaskRef => {
    const served = refById(links, kind, id);
    if (served) return served;
    // A JUST-STAGED card isn't in the served view yet (that lands on the next poll), so build its chip
    // from the board row the user picked it from. Falling back to a bare id would make a staged chip
    // unreadable for the one moment it matters most — right after picking it.
    const card = cards.find((c) => c.id === id);
    return { id, title: card?.title ?? titleById.get(id) ?? id.slice(0, 8), columnKey: card?.columnKey ?? "", resolved: false, released: false };
  };

  return (
    <>
      {/* A graph-wide refusal (a blocks cycle) names edges on BOTH sides, so it belongs to the section
          rather than to one row. Verbatim — the validator's own wording already says what to drop. */}
      {errorTarget?.scope === "graph" && saveErrorMessage && (
        <span role="alert" data-testid="relations-error-graph"
          style={{ fontFamily: font.mono, fontSize: fs.mono, color: color.danger, lineHeight: 1.4 }}>
          {saveErrorMessage}
        </span>
      )}
      {rows.length > 0 && (
        <div data-testid="task-relations-editor" style={relationGrid}>
          {rows.map(({ kind, ids, released }) => (
            <div key={kind} style={{ display: "contents" }}>
              <span style={relationRowLabel} title={EDIT_RELATION_HINT[kind]}>{EDIT_RELATION_LABEL[kind]}</span>
              <div data-testid={`relations-edit-${kind}`}
                style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                {ids.map((id) => (
                  <RelationChip key={id} kind={kind} ref_={chipRef(kind, id)} columns={columns} titleById={titleById}
                    onOpenTask={onOpenTask}
                    onRemove={() => onChange({ ...draft, [kind]: ids.filter((x) => x !== id) })} />
                ))}
                {/* Released deferral history: shown so the record isn't lost, with NO remove control —
                    there is no live edge there to remove, and it is never part of a write. */}
                {released.map((r) => (
                  <RelationChip key={`released-${r.id}`} kind={kind} ref_={r} columns={columns} titleById={titleById}
                    onOpenTask={onOpenTask} onRemove={null} />
                ))}
                {errorTarget?.scope === "kind" && errorTarget.kind === kind && saveErrorMessage && (
                  <span role="alert" data-testid={`relations-error-${kind}`}
                    style={{ fontFamily: font.mono, fontSize: fs.mono, color: color.danger, lineHeight: 1.4 }}>
                    {saveErrorMessage}
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
      {picking ? (
        <CardPicker kind={picking} selfId={selfId} cards={cards} columns={columns}
          excludeIds={draft[picking]}
          onPick={(id) => {
            onChange(isSingleValueKind(picking)
              ? { ...draft, [picking]: [id] }
              : { ...draft, [picking]: [...draft[picking], id] });
            // Single-value kinds are done after one pick; a list kind stays open so several blockers can
            // be added in one sitting without re-opening the picker each time.
            if (isSingleValueKind(picking)) setPicking(null);
          }}
          onKindChange={setPicking}
          onClose={() => setPicking(null)} />
      ) : (
        // Negative margin cancels the ghost button's own left padding so its text sits on the same
        // vertical rule as the labels above, exactly like the Parent field's "Set parent…" link.
        <div>
          <Button variant="ghost" data-testid="relations-add-open" style={{ fontSize: fs.sm, padding: "2px 6px", marginLeft: -6 }}
            onClick={() => setPicking("blockedBy")}>＋ Add relation…</Button>
        </div>
      )}
    </>
  );
}

// One staged edge: the read side's own link row (so a chip and the links block above can never drift
// apart visually) plus a remove control. The link half opens that card — the same click-through the
// links block offers — and removal is a separate target, so neither can fire the other by accident.
function RelationChip({ kind, ref_, columns, titleById, onOpenTask, onRemove }: {
  kind: EditableRelationKind;
  ref_: TaskRef;
  columns: KanbanColumn[];
  titleById: Map<string, string>;
  onOpenTask: (id: string) => void;
  /** null for display-only history (released) — renders no remove control at all. */
  onRemove: (() => void) | null;
}) {
  const history = ref_.released || ref_.resolved;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 2, minWidth: 0 }}>
      {/* `flex: 0 1 auto`, NOT `flex: 1`: the unlink control has to sit against its own chip. Growing
          the link to fill the column pushed every × to the far right edge, ~500px from the title it
          unlinks at panel width — a column of identical ×s belonging to nothing in particular. It still
          SHRINKS (and ellipsises, via the row's own minWidth:0) when the title is too long. */}
      <span style={{ flex: "0 1 auto", minWidth: 0, display: "flex" }}>
        <TaskLinkRow ref_={ref_} columns={columns} titleById={titleById} onOpenTask={onOpenTask}
          glyph={history ? "✓" : KIND_GLYPH[kind]}
          suffix={ref_.released ? "(released)" : ref_.resolved ? "(resolved)" : undefined}
          muted={history}
          tone={!history && kind === "blockedBy" ? color.attnText : undefined} />
      </span>
      {onRemove && (
        <Button variant="ghost" style={{ flexShrink: 0, fontSize: fs.sm, padding: "1px 6px", lineHeight: 1.2 }}
          aria-label={`Unlink ${EDIT_RELATION_LABEL[kind]} ${ref_.id.slice(0, 8)} — ${ref_.title}`}
          title={`Unlink ${ref_.id.slice(0, 8)} (staged — takes effect on Save)`}
          onClick={onRemove}>×</Button>
      )}
    </div>
  );
}

// The searchable card picker. One input matching an id prefix OR a title substring (the two handles
// this system names cards by), a kind selector so one picker serves every row, and a bounded result
// list that says when it is capped rather than implying it is everything.
function CardPicker({ kind, selfId, cards, columns, excludeIds, onPick, onKindChange, onClose }: {
  kind: EditableRelationKind;
  selfId: string;
  cards: PickerCard[];
  columns: KanbanColumn[];
  excludeIds: string[];
  onPick: (id: string) => void;
  onKindChange: (kind: EditableRelationKind) => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const { matches, total } = useMemo(
    () => searchCards(cards, query, { selfId, excludeIds, limit: PICKER_LIMIT }),
    [cards, query, selfId, excludeIds],
  );
  // Keep the keyboard cursor inside the (shrinking) result list as the query narrows it.
  const clamped = matches.length === 0 ? 0 : Math.min(cursor, matches.length - 1);
  useEffect(() => { setCursor(0); }, [query, kind]);
  const listId = useRef(`relations-picker-${Math.random().toString(36).slice(2, 8)}`).current;

  return (
    <div data-testid="relations-picker"
      // borderStrong, not border: this is a panel INSIDE a panel, and at the hairline weight the rest of
      // the dialog uses it read as loose rows rather than one popover with an edge (caught by eye).
      style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 10px", minWidth: 0,
        background: color.inset, border: `1px solid ${color.lineStrong}`, borderRadius: radius.base }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
        <Select value={kind} aria-label="Relation kind" style={{ fontSize: fs.sm, padding: "3px 6px" }}
          onChange={(e) => onKindChange(e.target.value as EditableRelationKind)}>
          {EDITABLE_RELATION_KINDS.map((k) => (
            <option key={k} value={k}>{EDIT_RELATION_LABEL[k]}</option>
          ))}
        </Select>
        <span style={{ flex: 1, minWidth: 0, fontFamily: font.mono, fontSize: fs.xs, color: color.text3,
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {EDIT_RELATION_HINT[kind]}
        </span>
        <Button variant="ghost" style={{ flexShrink: 0, fontSize: fs.sm, padding: "1px 6px" }}
          aria-label="Close the card picker" title="Close the card picker" onClick={onClose}>×</Button>
      </div>
      <Input value={query} onChange={(e) => setQuery(e.target.value)} spellCheck={false} autoFocus
        aria-label="Find a card to link" aria-controls={listId}
        placeholder="find a card — title or id prefix"
        style={{ width: "100%", boxSizing: "border-box" }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") { e.preventDefault(); setCursor((c) => Math.min(c + 1, Math.max(matches.length - 1, 0))); return; }
          if (e.key === "ArrowUp") { e.preventDefault(); setCursor((c) => Math.max(c - 1, 0)); return; }
          if (e.key === "Enter") {
            e.preventDefault();
            const hit = matches[clamped];
            if (hit) { onPick(hit.id); setQuery(""); }
            return;
          }
          if (e.key === "Escape") {
            // The native stopPropagation is the load-bearing half: the dialog's Esc-to-close listener is
            // a native `window` handler, and React's synthetic stopPropagation does NOT reach it (React's
            // own listener sits on the root container, below window, so the native event keeps bubbling
            // past it). Without this, closing the picker also closes the whole dialog.
            e.stopPropagation();
            e.nativeEvent.stopPropagation();
            e.preventDefault();
            onClose();
          }
        }} />
      <div id={listId} role="listbox" aria-label={`Cards to link as ${EDIT_RELATION_LABEL[kind]}`}
        style={{ display: "flex", flexDirection: "column", gap: 1, maxHeight: 176, overflowY: "auto", minWidth: 0 }}>
        {matches.length === 0 ? (
          <span style={{ fontFamily: font.mono, fontSize: fs.mono, color: color.text3 }}>
            {total === 0 && query.trim() === ""
              ? "no other cards on this board yet"
              : "no card on this board matches that title or id"}
          </span>
        ) : matches.map((c, i) => {
          const col = columns.find((x) => x.key === c.columnKey) ?? null;
          const active = i === clamped;
          return (
            <button key={c.id} type="button" role="option" aria-selected={active}
              onMouseEnter={() => setCursor(i)}
              onClick={() => { onPick(c.id); setQuery(""); }}
              title={`Link card ${c.id.slice(0, 8)} — ${c.title}`}
              style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, textAlign: "left", cursor: "pointer",
                fontFamily: font.mono, fontSize: fs.mono, padding: "3px 5px", borderRadius: radius.sm,
                color: active ? color.text : color.text2,
                background: active ? color.surface : "transparent",
                border: `1px solid ${active ? color.lineStrong : "transparent"}` }}>
              <span style={{ flexShrink: 0, color: color.text3, fontSize: fs.xs }}>{c.id.slice(0, 8)}</span>
              <span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.title}</span>
              {col && <Badge tone={columnTone(col) ?? "muted"} style={{ flexShrink: 0, fontSize: fs.xs, padding: "0 5px" }}>{col.label}</Badge>}
            </button>
          );
        })}
      </div>
      {/* Say so when the list is capped rather than letting 8 rows read as the whole board. */}
      {total > matches.length && (
        <span style={{ fontFamily: font.mono, fontSize: fs.xs, color: color.text3 }}>
          showing {matches.length} of {total} — keep typing to narrow
        </span>
      )}
    </div>
  );
}
