// Board lane controls (card 67c43038): reorder a lane on the board itself (header drag, or the ⋯ menu's
// Move left / Move right for keyboard users), and fold a lane to a slim rail. Column CRUD (add / rename /
// delete / role / accent / WIP) stays in Settings › Board Columns; this file only ever changes ORDER (a
// server write through the permutation-only PUT /columns/order) and a per-viewer collapsed flag (browser
// storage, never the server, so collapsing a lane changes nothing for anyone else).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { Link } from "react-router-dom";
import { closestCenter, pointerWithin, rectIntersection, type CollisionDetection } from "@dnd-kit/core";
import type { KanbanColumn } from "@loom/shared";

/** Upper bound on the lane menu's rendered height, for the open-upward decision. */
const MENU_MAX_H = 180;

/** Drag-data discriminator: the board's one DndContext carries both card drags and lane drags. */
export type BoardDragData = { type: "card" } | { type: "lane"; key: string };

export const laneDragId = (key: string) => `lane:${key}`;

/** The column keys with `key` moved to `toIndex` (clamped). Returns null when nothing would change. */
export function movedKeys(columns: readonly KanbanColumn[], key: string, toIndex: number): string[] | null {
  const keys = columns.map((c) => c.key);
  const from = keys.indexOf(key);
  if (from < 0) return null;
  const to = Math.max(0, Math.min(keys.length - 1, toIndex));
  if (to === from) return null;
  keys.splice(from, 1);
  keys.splice(to, 0, key);
  return keys;
}

/**
 * Collision for the shared DndContext. A CARD drag keeps the context's default (rectIntersection), so card
 * moves behave exactly as before. A LANE drag targets whichever lane the pointer is over: a lane is tall and
 * the drag preview is a compact header, so rect overlap would resolve to the wrong lane. Keyboard-driven
 * drags have no pointer, so they fall back to the nearest lane centre.
 */
export const boardCollision: CollisionDetection = (args) => {
  if ((args.active.data.current as BoardDragData | undefined)?.type !== "lane") return rectIntersection(args);
  const hits = pointerWithin(args);
  return hits.length ? hits : closestCenter(args);
};

const storageKey = (projectId: string) => `loom.board.collapsedLanes.${projectId}`;

/** Per-viewer, per-project collapsed lanes. Storage can be unavailable (private mode, blocked site data):
 *  every read/write is guarded, and the board renders fully expanded without it. */
export function useCollapsedLanes(projectId: string | undefined): [Set<string>, (key: string, collapsed: boolean) => void] {
  const read = (id: string | undefined): Set<string> => {
    if (!id) return new Set();
    try {
      const raw = localStorage.getItem(storageKey(id));
      const parsed: unknown = raw ? JSON.parse(raw) : [];
      return new Set(Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === "string") : []);
    } catch { return new Set(); }
  };
  const [collapsed, setCollapsed] = useState<Set<string>>(() => read(projectId));
  useEffect(() => { setCollapsed(read(projectId)); }, [projectId]);
  const set = useCallback((key: string, on: boolean) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (on) next.add(key); else next.delete(key);
      if (projectId) {
        try { localStorage.setItem(storageKey(projectId), JSON.stringify([...next])); } catch { /* storage unavailable */ }
      }
      return next;
    });
  }, [projectId]);
  return [collapsed, set];
}

/**
 * The ⋯ lane menu: a real menu button (Enter/Space/ArrowDown open it, focus lands on the first enabled item,
 * arrows/Home/End move, Escape closes and returns focus). Alt+←/→ on the closed button moves the lane
 * directly, the shortcut the menu items advertise.
 */
export function LaneMenu({ col, index, count, disabled, onMove, onCollapse }: {
  col: KanbanColumn; index: number; count: number; disabled?: boolean;
  onMove: (toIndex: number) => void; onCollapse: () => void;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<(HTMLElement | null)[]>([]);
  // The menu is portalled to <body> with fixed positioning: the board grid clips vertically
  // (overflow-y: hidden, so it can scroll sideways), and a short lane is shorter than the menu.
  // Anchored to the button's right edge; opens upward when there is no room below.
  const [pos, setPos] = useState<CSSProperties | null>(null);
  // Re-anchor to the button. Returns false once the button has left the viewport entirely.
  const place = (): boolean => {
    if (!btnRef.current) return false;
    const r = btnRef.current.getBoundingClientRect();
    if (r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) return false;
    const right = Math.max(8, window.innerWidth - r.right);
    setPos(window.innerHeight - r.bottom < MENU_MAX_H + 12
      ? { position: "fixed", right, bottom: window.innerHeight - r.top + 4 }
      : { position: "fixed", right, top: r.bottom + 4 });
    return true;
  };
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    if (!place()) setOpen(false);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  // Dismissal: outside press (the menu is outside the button's subtree, so both are checked) and Escape.
  // A scroll or resize RE-ANCHORS the fixed menu to its button (closing only once the button is off
  // screen): closing on scroll instead would also fire on the scroll a click's own scroll-into-view
  // (or an inertial scroll) lands a moment after the menu opens.
  useEffect(() => {
    if (!open) return;
    const close = (refocus: boolean) => { setOpen(false); if (refocus) btnRef.current?.focus(); };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!btnRef.current?.contains(t) && !menuRef.current?.contains(t)) close(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === "Escape") close(!!menuRef.current?.contains(document.activeElement)); };
    const onMove = () => { if (!place()) close(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", onMove, true);
    window.addEventListener("resize", onMove);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", onMove, true);
      window.removeEventListener("resize", onMove);
    };
  }, [open]);
  const canLeft = index > 0 && !disabled;
  const canRight = index < count - 1 && !disabled;
  const enabledItems = () => itemRefs.current.filter((el): el is HTMLElement => !!el && el.getAttribute("aria-disabled") !== "true");
  const focusItem = (i: number) => {
    const items = enabledItems();
    // preventScroll: the menu is fixed and already on screen; focusing it must not scroll the page under it.
    if (items.length) items[((i % items.length) + items.length) % items.length]?.focus({ preventScroll: true });
  };
  // Focus the first item ONCE per opening, when the portalled menu first mounts (`pos` set) — never on a
  // later re-anchor, which would yank focus back from an item the user has arrowed to.
  const focusedOnOpen = useRef(false);
  useEffect(() => {
    if (!open) { focusedOnOpen.current = false; return; }
    if (pos && !focusedOnOpen.current) { focusedOnOpen.current = true; focusItem(0); }
  }, [open, pos]); // eslint-disable-line react-hooks/exhaustive-deps

  const act = (fn: () => void) => { setOpen(false); fn(); };
  const onBtnKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.altKey && (e.key === "ArrowLeft" || e.key === "ArrowRight")) {
      e.preventDefault();
      if (e.key === "ArrowLeft" && canLeft) onMove(index - 1);
      if (e.key === "ArrowRight" && canRight) onMove(index + 1);
      return;
    }
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); setOpen(true); }
  };
  const onMenuKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = enabledItems();
    const cur = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "ArrowDown") { e.preventDefault(); focusItem(cur + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); focusItem(cur - 1); }
    else if (e.key === "Home") { e.preventDefault(); focusItem(0); }
    else if (e.key === "End") { e.preventDefault(); focusItem(-1); }
    else if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setOpen(false); btnRef.current?.focus(); }
    else if (e.key === "Tab") setOpen(false);
  };
  const menuId = `lane-menu-${col.key}`;
  let i = 0;
  const item = (label: string, hint: string | null, enabled: boolean, onSelect: () => void, testId: string) => {
    const n = i++;
    return (
      <button type="button" role="menuitem" tabIndex={-1} key={testId} data-testid={testId}
        ref={(el) => { itemRefs.current[n] = el; }}
        aria-disabled={enabled ? undefined : true}
        className="loom-lane-menu-item"
        onClick={() => { if (enabled) act(onSelect); }}>
        <span>{label}</span>
        {hint && <span className="loom-lane-menu-hint" aria-hidden>{hint}</span>}
      </button>
    );
  };
  return (
    <div style={{ flexShrink: 0 }}>
      <button type="button" ref={btnRef} className="loom-lane-more" data-testid={`lane-menu-button-${col.key}`}
        data-lane-more={col.key}
        aria-label={`${col.label} lane options`} aria-haspopup="menu" aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
        title="Lane options (Alt+←/→ to move)"
        onClick={() => setOpen((o) => !o)} onKeyDown={onBtnKey}>
        <span aria-hidden>⋯</span>
      </button>
      {open && pos && createPortal(
        <div ref={menuRef} className="loom-lane-menu" role="menu" id={menuId} aria-label={`${col.label} lane`}
          data-testid={`lane-menu-${col.key}`} onKeyDown={onMenuKey} style={pos}>
          {item("← Move left", "Alt ←", canLeft, () => onMove(index - 1), `lane-move-left-${col.key}`)}
          {item("→ Move right", "Alt →", canRight, () => onMove(index + 1), `lane-move-right-${col.key}`)}
          <div className="loom-lane-menu-sep" role="separator" />
          {item("Collapse lane", null, true, onCollapse, `lane-collapse-${col.key}`)}
          <div className="loom-lane-menu-sep" role="separator" />
          <Link to="/settings" role="menuitem" tabIndex={-1} className="loom-lane-menu-item is-quiet"
            ref={(el) => { itemRefs.current[3] = el; }} onClick={() => setOpen(false)}
            data-testid={`lane-edit-columns-${col.key}`}>
            <span>Edit columns in Settings</span>
            <span className="loom-lane-menu-hint" aria-hidden>↗</span>
          </Link>
        </div>,
        document.body,
      )}
    </div>
  );
}
