// Board-hierarchy presentation (card 1ae4f88c — the UI half; the daemon/REST half is card 3df86c87).
//
// Two surfaces, deliberately asymmetric in weight:
//   · BoardCardHierarchy — ONE optional 10px meta line on a board card. The owner's primary board is the
//     Overview-embedded one, so this is the surface that must NOT grow: it renders nothing at all unless
//     the card genuinely has a parent, children or an open blocker, which most cards don't.
//   · TaskLinksBlock — the full picture in the card drawer, where there IS room: parent, the children
//     list with progress, and all five relation buckets, every item clickable through to that card.
//
// Glyph vocabulary matches the board's existing one (⠿ grip, ≣ body, ⑂ repo, ✓ shipped): ↳ parent,
// ⊞ children, ⊘ blocked. Colour is the established signal palette, nothing new — amber for "waiting on
// something" (the blocked marker is plain amber TEXT, never a filled badge, so it can't be confused with
// the filled amber `held` badge beside it), cyan for links/metadata, phosphor only for genuine
// completion, textDim/textMuted for context.
import type { CSSProperties, ReactNode } from "react";
import type { KanbanColumn } from "@loom/shared";
import { Badge, Meter } from "./ui";
import { color, columnTone, font, radius } from "../theme";
import {
  RELATION_KINDS, RESOLVABLE_KINDS, splitResolved,
  type BoardHierarchy, type RelationKind, type TaskLinks, type TaskRef,
} from "../lib/taskHierarchy";

// ── Board card: the one optional meta line ───────────────────────────────────────────────────────
// Ordered strongest signal first: a blocker (why nothing is moving) → child progress → the parent
// (context you can also get by opening the card). Deliberately NOT clickable: the whole card body is
// already one click target that opens the drawer, and a nested link inside it would have to fight that
// plus the drag grip for a payoff the drawer already gives. Full titles ride in the tooltips.
const metaItem: CSSProperties = {
  display: "inline-flex", alignItems: "baseline", gap: 3, minWidth: 0,
  overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
};

export function BoardCardHierarchy({ h, parentTitle }: { h: BoardHierarchy; parentTitle: string | null }) {
  // All children done is the one state worth a positive signal; anything else stays context-weight.
  const complete = h.childCount > 0 && h.childDone >= h.childCount;
  return (
    <div style={{ marginTop: 4, display: "flex", flexWrap: "wrap", alignItems: "baseline", columnGap: 8, rowGap: 2,
      fontFamily: font.mono, fontSize: 10, lineHeight: 1.4 }}>
      {h.blockedByOpen > 0 && (
        <span style={{ ...metaItem, maxWidth: 150, color: color.amber }}
          title={h.blockedByFirst
            ? `Blocked by "${h.blockedByFirst.title}"${h.blockedByOpen > 1 ? ` and ${h.blockedByOpen - 1} more` : ""} — open the card for the full list`
            : `Blocked by ${h.blockedByOpen} unresolved ${h.blockedByOpen === 1 ? "card" : "cards"}`}>
          <span aria-hidden>⊘</span>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
            {h.blockedByFirst
              ? `${h.blockedByFirst.title}${h.blockedByOpen > 1 ? ` +${h.blockedByOpen - 1}` : ""}`
              : `blocked ×${h.blockedByOpen}`}
          </span>
        </span>
      )}
      {h.childCount > 0 && (
        <span style={{ ...metaItem, color: complete ? color.phosphor : color.textDim }}
          title={`${h.childDone} of ${h.childCount} child ${h.childCount === 1 ? "card" : "cards"} done`}>
          <span aria-hidden>⊞</span>
          <span>{h.childDone}/{h.childCount}</span>
        </span>
      )}
      {h.parentId && (
        <span style={{ ...metaItem, maxWidth: 140, color: color.textMuted }}
          title={parentTitle
            ? `Child of "${parentTitle}"`
            : `Child of card ${h.parentId.slice(0, 8)} — that card isn't on this board (archived, or in another project)`}>
          <span aria-hidden>↳</span>
          <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>
            {parentTitle ?? h.parentId.slice(0, 8)}
          </span>
        </span>
      )}
    </div>
  );
}

// ── Drawer: the full links block ─────────────────────────────────────────────────────────────────
// Sits under the dossier header, above the edit/requests body, because it's card CONTEXT ("what is this
// connected to") in the same register as the header's id/priority/lane chips — not another editable
// field. Renders nothing when the card has no links, so an ordinary card's drawer is unchanged.
const RELATION_LABEL: Record<RelationKind, string> = {
  blockedBy: "Blocked by",
  blocks: "Blocking",
  related: "Related",
  discoveredFrom: "Discovered from",
  discoveries: "Discoveries",
};

// Screen-reader + tooltip explanation per bucket, so the direction of each edge is unambiguous — the
// labels alone can't distinguish "blocks" from "blocked by" at a glance.
const RELATION_HINT: Record<RelationKind, string> = {
  blockedBy: "this card is waiting on these",
  blocks: "these are waiting on this card",
  related: "related, with no ordering implied",
  discoveredFrom: "the card this one was spun out of",
  discoveries: "cards spun out of this one",
};

const linkLabel: CSSProperties = {
  fontFamily: font.head, fontSize: 10, fontWeight: 700, textTransform: "uppercase",
  letterSpacing: "0.1em", color: color.textDim, paddingTop: 2, whiteSpace: "nowrap",
};

export function TaskLinksBlock({ links, columns, titleById, onOpenTask }: {
  links: TaskLinks;
  columns: KanbanColumn[];
  /** Every card on the loaded board, id → title. A link to anything NOT in here can't be opened. */
  titleById: Map<string, string>;
  onOpenTask: (id: string) => void;
}) {
  const { blockedBy, blocks, related, discoveredFrom, discoveries } = links.relations;
  const allDone = links.children.total > 0 && links.children.done >= links.children.total;
  const buckets: [RelationKind, TaskRef[]][] = [
    ["blockedBy", blockedBy], ["blocks", blocks], ["related", related],
    ["discoveredFrom", discoveredFrom], ["discoveries", discoveries],
  ];
  // The label/items pair is `display: contents` so both land directly on the outer grid. The items div
  // carries `data-testid="links-<key>"` because the SAME card can legitimately appear in two sections at
  // once (an epic that is both this card's parent AND where it was discovered from), so the per-section
  // element is the only way to say which occurrence you mean — the `display: contents` wrapper isn't one.
  const row = (label: string, hint: string, body: ReactNode, key: string) => (
    <div key={key} style={{ display: "contents" }}>
      <span style={linkLabel} title={hint}>{label}</span>
      <div data-testid={`links-${key}`} style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>{body}</div>
    </div>
  );
  return (
    <div data-testid="task-links" style={{ display: "grid", gridTemplateColumns: "minmax(64px, auto) 1fr",
      columnGap: 10, rowGap: 6, alignItems: "start", padding: "8px 10px", background: color.panel2,
      border: `1px solid ${color.border}`, borderRadius: radius.base }}>
      {links.parent && row("Parent", "the card this one sits under",
        <TaskLinkRow ref_={links.parent} columns={columns} titleById={titleById} onOpenTask={onOpenTask} glyph="↳" />,
        "parent")}
      {links.children.total > 0 && row("Children", `${links.children.done} of ${links.children.total} done`,
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontFamily: font.mono, fontSize: 11,
            color: allDone ? color.phosphor : color.textDim }}>
            <span>{links.children.done}/{links.children.total} done</span>
            <Meter value={links.children.done} max={links.children.total} width={56} tone={allDone ? "phosphor" : "cyan"} />
          </div>
          {/* Bounded: `items` is capped at 100 by the contract, and 100 rows would push the edit form off
              the panel. Scroll the list instead of truncating it — `done`/`total` above stay exact either
              way, so a capped list never misreports progress. */}
          {links.children.items.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 132, overflowY: "auto" }}>
              {links.children.items.map((c) => (
                <TaskLinkRow key={c.id} ref_={c} columns={columns} titleById={titleById} onOpenTask={onOpenTask} glyph="▸" />
              ))}
            </div>
          )}
          {/* Say so when the list is capped, rather than letting it read as the whole set. */}
          {links.children.total > links.children.items.length && (
            <span style={{ fontFamily: font.mono, fontSize: 10, color: color.textMuted }}>
              showing {links.children.items.length} of {links.children.total}
            </span>
          )}
        </>,
        "children")}
      {buckets.map(([kind, items]) => {
        if (items.length === 0) return null;
        // A resolved blocker stays on the board as history ("blocked-by X (resolved)") rather than
        // vanishing — when a card has sat still, what it WAS waiting on is the question you ask.
        // Only blockedBy/blocks carry `resolved`; the other three have no such notion, so their items
        // all fall to `open` and the resolved list is empty by construction.
        const { open, resolved } = RESOLVABLE_KINDS.includes(kind) ? splitResolved(items) : { open: items, resolved: [] };
        return row(RELATION_LABEL[kind], RELATION_HINT[kind], (
          <>
            {open.map((r) => (
              <TaskLinkRow key={r.id} ref_={r} columns={columns} titleById={titleById} onOpenTask={onOpenTask}
                glyph={kind === "blockedBy" ? "⊘" : "·"} tone={kind === "blockedBy" ? color.amber : undefined} />
            ))}
            {/* Both read as muted history, but they are NOT the same fact and the label says which:
                `resolved` is a DECLARED dependency whose blocker is done; `released` is auto-released
                deferral history that is no longer a declared dependency at all. Collapsing them would
                lose the distinction the contract went out of its way to keep. */}
            {resolved.map((r) => (
              <TaskLinkRow key={r.id} ref_={r} columns={columns} titleById={titleById} onOpenTask={onOpenTask}
                glyph="✓" suffix={r.released ? "(released)" : "(resolved)"} muted />
            ))}
          </>
        ), kind);
      })}
    </div>
  );
}

// One clickable link to another card: glyph · title · lane chip. A target that isn't on the loaded board
// (archived, or filtered out of this project's list) renders as PLAIN TEXT with a tooltip saying so —
// never as a button that silently does nothing when clicked.
function TaskLinkRow({ ref_, columns, titleById, onOpenTask, glyph, tone, suffix, muted }: {
  ref_: TaskRef;
  columns: KanbanColumn[];
  titleById: Map<string, string>;
  onOpenTask: (id: string) => void;
  glyph: string;
  tone?: string;
  suffix?: string;
  muted?: boolean;
}) {
  const col = columns.find((c) => c.key === ref_.columnKey) ?? null;
  const openable = titleById.has(ref_.id);
  const textColor = muted ? color.textMuted : (tone ?? (openable ? color.cyan : color.textMuted));
  const label = (
    <>
      <span aria-hidden style={{ flexShrink: 0, color: color.textMuted }}>{glyph}</span>
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ref_.title}</span>
      {suffix && <span style={{ flexShrink: 0, color: color.textMuted, fontSize: 10 }}>{suffix}</span>}
      {col && <Badge tone={columnTone(col) ?? "muted"} style={{ flexShrink: 0, fontSize: 9, padding: "0 5px" }}>{col.label}</Badge>}
    </>
  );
  const shared: CSSProperties = {
    display: "flex", alignItems: "center", gap: 5, minWidth: 0, textAlign: "left",
    fontFamily: font.mono, fontSize: 12, color: textColor,
  };
  if (!openable) {
    return (
      <span style={shared} title={`${ref_.title} — card ${ref_.id.slice(0, 8)} isn't on this board (archived, or in another project)`}>
        {label}
      </span>
    );
  }
  // An explicit aria-label, not just the tooltip: the visible content is a bare glyph + title + lane
  // badge, which a screen reader announces as "▸ sub one TODO" with no hint that it's a link to another
  // card. The label says what activating it does and names the card by the same 8-char handle the rest of
  // the UI uses. (It doubles as the e2e handle — a button's accessible name comes from its CONTENT, so a
  // `title` attribute alone is NOT addressable by role+name.)
  return (
    <button type="button" className="loom-task-link" onClick={() => onOpenTask(ref_.id)}
      aria-label={`Open card ${ref_.id.slice(0, 8)} — ${ref_.title}${suffix ? ` ${suffix}` : ""}`}
      title={`Open ${ref_.id.slice(0, 8)} — ${ref_.title}`}
      style={{ ...shared, background: "transparent", border: "none", borderRadius: radius.sm, padding: "1px 2px", cursor: "pointer" }}>
      {label}
    </button>
  );
}
