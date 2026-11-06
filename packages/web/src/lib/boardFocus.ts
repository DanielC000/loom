// Board keyboard focus (card 591fe6ed): ONE Tab stop into the lane grid, arrow keys between cards and
// lanes. The focus position lives in exactly one place — Board's `BoardFocus` state, handed down through
// `BoardNavContext` — so a later selection model (card 19074e42) can read the same position instead of
// growing a second one.
//
// The navigable items are marked in the DOM, not registered: each lane (`[data-lane-key]`) lists its items
// in render order as `[data-board-nav="<id>"]`, where `<id>` is HEAD (the lane header control: the ⋯ menu
// button, or a collapsed lane's rail), a card id, or MORE (the done lane's "Show N more"). Reading the order
// off the DOM at keypress time means the nav can never disagree with what is actually rendered — the done
// cap, a filter, a collapse and the 4s poll all change that set.
//
// @decision 591fe6ed — one Tab stop for the whole grid: no grip stop, no arrows-open-the-menu, one focus position.
import { createContext, useContext } from "react";

export const NAV_HEAD = "head";
export const NAV_MORE = "more";

/** Where the board's one Tab stop is: a lane, an item in it, and that item's position (the fallback when
 *  the item itself is gone — a card moved away, a reveal button that vanished). */
export type BoardFocus = { lane: string; item: string; index: number };

export type BoardNav = {
  /** The lane holding the Tab stop (already resolved against the rendered lanes). */
  lane: string | null;
  /** The wanted item in that lane; null = the default (its first card, else its header). */
  item: string | null;
  index: number;
  /** Put focus back on the Tab stop if the element that held it has left the DOM. */
  repairIfLost: () => void;
};

export const BoardNavContext = createContext<BoardNav | null>(null);
export const useBoardNav = () => useContext(BoardNavContext);

/** Which of a lane's items holds the Tab stop. `items` is the lane's render order (HEAD first). */
export function resolveLaneItem(items: readonly string[], item: string | null, index: number): string | undefined {
  if (item !== null && items.includes(item)) return item;
  if (item === null) return items[1] ?? items[0];
  return items[Math.max(0, Math.min(index, items.length - 1))];
}

export type NavLane = { lane: string; items: string[] };
export type NavKey = "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Home" | "End";
export const NAV_KEYS: ReadonlySet<string> = new Set<NavKey>(["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Home", "End"]);

const cardsOf = (items: readonly string[]) => items.filter((i) => i !== NAV_HEAD && i !== NAV_MORE);

/**
 * The item a key moves to, or null when it goes nowhere (an edge). Up/Down step through the lane's own
 * items (header, cards, reveal button); Home/End jump to its first/last CARD (the header when it has
 * none); Left/Right cross to the neighbouring lane at the same card index, clamped to its last card, and
 * land on its header when it is empty or collapsed. From a header, Left/Right go header to header.
 */
export function navTarget(lanes: readonly NavLane[], from: { lane: string; item: string }, key: NavKey): { lane: string; item: string } | null {
  const li = lanes.findIndex((l) => l.lane === from.lane);
  if (li < 0) return null;
  const { items } = lanes[li]!;
  const pos = items.indexOf(from.item);
  if (pos < 0) return null;
  const at = (lane: NavLane, item: string | undefined) => (item === undefined ? null : { lane: lane.lane, item });
  switch (key) {
    case "ArrowUp": return pos > 0 ? at(lanes[li]!, items[pos - 1]) : null;
    case "ArrowDown": return pos < items.length - 1 ? at(lanes[li]!, items[pos + 1]) : null;
    case "Home": { const c = cardsOf(items); return at(lanes[li]!, c[0] ?? items[0]); }
    case "End": { const c = cardsOf(items); return at(lanes[li]!, c[c.length - 1] ?? items[0]); }
    case "ArrowLeft":
    case "ArrowRight": {
      const next = lanes[li + (key === "ArrowLeft" ? -1 : 1)];
      if (!next) return null;
      if (from.item === NAV_HEAD) return at(next, next.items[0]);
      const mine = cardsOf(items);
      const cardIndex = from.item === NAV_MORE ? mine.length : mine.indexOf(from.item);
      const theirs = cardsOf(next.items);
      return at(next, theirs.length ? theirs[Math.min(cardIndex, theirs.length - 1)] : next.items[0]);
    }
  }
}

/** The lanes and their items, in render order, read off a board grid element. */
export function readNavLanes(grid: HTMLElement): NavLane[] {
  return [...grid.querySelectorAll<HTMLElement>("[data-lane-key]")].map((lane) => ({
    lane: lane.dataset.laneKey!,
    items: [...lane.querySelectorAll<HTMLElement>("[data-board-nav]")].map((el) => el.dataset.boardNav!),
  }));
}

export function navElement(grid: HTMLElement, lane: string, item: string): HTMLElement | null {
  return grid.querySelector<HTMLElement>(`[data-lane-key="${CSS.escape(lane)}"] [data-board-nav="${CSS.escape(item)}"]`);
}

/** The board's new-card shortcut key. Plain `n`: no other handler in the app reads a bare letter. */
export const NEW_CARD_KEY = "n";

/** True when a keypress belongs to whatever is being typed into, or to an open dialog or menu — the
 *  new-card shortcut must never take a key from any of them. */
export function shortcutBlocked(e: KeyboardEvent): boolean {
  if (e.defaultPrevented || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return true;
  const t = e.target as HTMLElement | null;
  if (t && (t.isContentEditable || t.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])"))) return true;
  return !!document.querySelector("[aria-modal='true'], [role='menu']");
}
