// Bottom-docked controls the request pill must never sit on (card 3094c4aa, Atlas audits A-01 + B-02).
//
// The pill lives in the viewport's bottom-right corner. A control docked to the bottom of the view —
// the board's multi-select bulk bar (sticky), a session's composer row — lands in that same corner, and
// pre-fix the pill covered "Clear selection" and "Send turn". A control that can sit there registers
// here with `useBottomDock(ref)`; the pill reads `useDockClearance(...)` and rises above whichever
// registered dock currently overlaps its corner, then drops back once none does.
//
// Lift, not route suppression: hiding the pill on /board and /session/:id would remove the one
// "requests need you → inbox" signal from the two pages an owner spends the most time on, and a route
// list only covers the bars it names — the next sticky bar elsewhere would be covered again. Opt-in
// registration (rather than probing whatever happens to be under the corner) keeps the pill still while
// an ordinary page scrolls past it; only a real docked control moves it.
import { useEffect, useLayoutEffect, useState, type RefObject } from "react";

const DOCK_RECHECK_MS = 400;
const docks = new Set<HTMLElement>();
const listeners = new Set<() => void>();
const notify = () => { for (const l of listeners) l(); };

/** Register `ref`'s element as a bottom-docked control for as long as it is mounted. */
export function useBottomDock(ref: RefObject<HTMLElement | null>) {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    docks.add(el);
    notify();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(notify) : null;
    ro?.observe(el);
    return () => { ro?.disconnect(); docks.delete(el); notify(); };
  }, [ref]);
}

interface Box { left: number; right: number; top: number; bottom: number }
const overlaps = (a: Box, b: Box) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

/**
 * Pure: the bottom offset (px from the viewport's bottom edge) at which a corner element of the given
 * size clears every dock rect. Starts at `base` and steps above each dock it would overlap, repeating
 * until stable, so two docks stacked in the corner are both cleared. Exported for unit tests.
 */
export function clearanceFor(
  docksRects: Box[], vw: number, vh: number,
  pill: { width: number; height: number; right: number; base: number; gap: number },
): number {
  let bottom = pill.base;
  for (let pass = 0; pass <= docksRects.length; pass++) {
    const zone: Box = { left: vw - pill.right - pill.width, right: vw - pill.right, top: vh - bottom - pill.height, bottom: vh - bottom };
    const hit = docksRects.filter((d) => d.bottom > d.top && overlaps(zone, d));
    if (hit.length === 0) return bottom;
    bottom = Math.max(bottom, ...hit.map((d) => vh - d.top + pill.gap));
  }
  return bottom;
}

/**
 * The live bottom offset for a corner element of `size`, re-derived whenever a dock mounts, unmounts or
 * resizes, the window resizes, or anything scrolls (a sticky bar or a composer in a scrolled grid moves
 * relative to the corner). rAF-coalesced, so a scroll costs one read per frame.
 */
export function useDockClearance(size: { width: number; height: number } | null, right: number, base: number, gap: number): number {
  const [bottom, setBottom] = useState(base);
  useEffect(() => {
    if (!size) { setBottom(base); return; }
    let raf = 0;
    const compute = () => {
      raf = 0;
      const rects = [...docks].map((d) => d.getBoundingClientRect());
      setBottom(clearanceFor(rects, window.innerWidth, window.innerHeight, { ...size, right, base, gap }));
    };
    const schedule = () => { if (!raf) raf = requestAnimationFrame(compute); };
    compute();
    listeners.add(schedule);
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    // A dock can MOVE without resizing or scrolling: a session's bound-task block loads in above the
    // composer and pushes it down into the corner (measured: the composer slid from 735 to 802 at
    // 1440×900 with no event the observers above see). A slow re-check closes that gap; it only runs
    // while the pill is up AND a dock is mounted, and each tick is one rect read per dock.
    const poll = setInterval(() => { if (docks.size > 0) schedule(); }, DOCK_RECHECK_MS);
    return () => {
      clearInterval(poll);
      listeners.delete(schedule);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [size?.width, size?.height, right, base, gap]);
  return bottom;
}
