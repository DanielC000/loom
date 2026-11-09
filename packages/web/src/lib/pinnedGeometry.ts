// The pinned column count each Claude session's pane has been told by the daemon (card eb516fba).
//
// A session's pty geometry is fixed per project (`pty.cols`/`pty.rows`) and reaches the browser only
// on the pane's own websocket, as its `geometry` frame; the session list carries no geometry at all.
// The Terminals grid needs it to decide how wide an `auto` tile must be to stay readable
// (lib/terminalLayout.ts `autoGridTemplate`), so the pane publishes what it learned here and the grid
// reads it back. A tiny module store rather than a prop threaded up through TerminalCard and
// TerminalTile, because the reader is three components above the writer and none in between cares.
//
// Entries are never removed: a session's pinned grid does not change for its lifetime, and a stale
// entry for a session that has left the grid is simply never read.
import { useSyncExternalStore } from "react";

let snapshot: ReadonlyMap<string, number> = new Map();
const listeners = new Set<() => void>();

/** Record a session's pinned column count. A no-op when nothing changed, so a re-attach costs no render. */
export function publishPinnedCols(sessionId: string, cols: number): void {
  if (!sessionId || !(cols > 0) || snapshot.get(sessionId) === cols) return;
  const next = new Map(snapshot);
  next.set(sessionId, cols);
  snapshot = next;
  for (const l of listeners) l();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Every pinned column count published so far, by session id. Re-renders when one is added or changed. */
export function usePinnedCols(): ReadonlyMap<string, number> {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}

/** The widest pinned grid among `ids`, or undefined while none of them has reported one. */
export function maxPinnedCols(pinned: ReadonlyMap<string, number>, ids: readonly string[]): number | undefined {
  let max: number | undefined;
  for (const id of ids) {
    const c = pinned.get(id);
    if (c != null && (max == null || c > max)) max = c;
  }
  return max;
}
