// Which board lanes are out of view, and where to scroll to bring the next one in (card c315f579).
//
// Pure, so test/lane-overflow.mjs can pin it: Board.tsx feeds it each lane's left/right edge in the
// grid's SCROLL coordinates (offsetLeft, offsetLeft + offsetWidth) plus the visible window
// (scrollLeft, scrollLeft + clientWidth). A lane counts as "more" on a side when any of it is cut off
// there, so a lane sliced mid-word is counted, not just the fully hidden ones.

export type LaneSpan = { key: string; left: number; right: number };
export type LaneOverflow = { before: string[]; after: string[] };

// Sub-pixel layout can leave a fully visible lane a fraction past the edge; that is not "hidden".
const SLACK = 1;

export function laneOverflow(lanes: LaneSpan[], viewLeft: number, viewRight: number): LaneOverflow {
  const before: string[] = [];
  const after: string[] = [];
  for (const l of lanes) {
    if (l.left < viewLeft - SLACK) before.push(l.key);
    else if (l.right > viewRight + SLACK) after.push(l.key);
  }
  return { before, after };
}

// The scrollLeft that brings the NEXT out-of-view lane on `side` fully into view, keeping `fade` px of
// room so it isn't left sitting under the edge fade when more lanes remain beyond it.
export function scrollTargetFor(lanes: LaneSpan[], viewLeft: number, viewRight: number,
  side: "before" | "after", fade: number): number | null {
  const width = viewRight - viewLeft;
  const o = laneOverflow(lanes, viewLeft, viewRight);
  if (side === "after") {
    const next = lanes.find((l) => l.key === o.after[0]);
    if (!next) return null;
    const moreBeyond = o.after.length > 1;
    return Math.max(0, next.right - width + (moreBeyond ? fade : 0));
  }
  const prev = lanes.find((l) => l.key === o.before[o.before.length - 1]);
  if (!prev) return null;
  const moreBeyond = o.before.length > 1;
  return Math.max(0, prev.left - (moreBeyond ? fade : 0));
}
