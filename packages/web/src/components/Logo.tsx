// Loom brand mark — an abstract plain-weave glyph.
//
// The weaving metaphor at the heart of Loom ("weaves real Claude Code sessions, Obsidian
// docs, and tasks into one fabric") rendered literally: two warp threads (vertical) and two
// weft threads (horizontal) interlaced over-under, the way fabric forms on a loom. Each
// crossing alternates which thread sits on top; the under-thread breaks at the crossing so
// the over-under reads even at 16px.
//
// Hand-authored, monochrome `currentColor` so it themes with the cockpit kit. Set the color
// on the wrapping element (the header gives it the phosphor signal). viewBox 0 0 24 24,
// threads inset to a 4-unit margin so the mark stays square / favicon-safe.

import type { CSSProperties } from "react";
import { color, font } from "../theme";

// The four interlaced threads. Each `d` is a thread drawn as two segments with a gap where it
// passes *under* the crossing thread (plain weave: every crossing flips which thread is on top).
const THREADS = [
  // Warp (vertical) — x=8: over at y=8, under at y=16
  "M8 4 V13.2 M8 18.8 V20",
  // Warp (vertical) — x=16: under at y=8, over at y=16
  "M16 4 V5.2 M16 10.8 V20",
  // Weft (horizontal) — y=8: under at x=8, over at x=16
  "M4 8 H5.2 M10.8 8 H20",
  // Weft (horizontal) — y=16: over at x=8, under at x=16
  "M4 16 H13.2 M18.8 16 H20",
];

export function LogoMark({ size = 20, style }: { size?: number; style?: CSSProperties }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden
      style={{ display: "block", ...style }}
    >
      {THREADS.map((d) => (
        <path
          key={d}
          d={d}
          stroke="currentColor"
          strokeWidth={2.4}
          strokeLinecap="round"
        />
      ))}
    </svg>
  );
}

// Full lockup: woven mark + lowercase wordmark. The mark carries the phosphor signal (brand /
// "live"); the wordmark sits in head font, lowercase to fit the terminal aesthetic.
export function Logo({ size = 20 }: { size?: number }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      <span style={{ color: color.phosphor, display: "inline-flex" }}>
        <LogoMark size={size} />
      </span>
      <span
        style={{
          fontFamily: font.head,
          fontWeight: 600,
          fontSize: 16,
          letterSpacing: "0.12em",
          color: color.text,
        }}
      >
        loom
      </span>
    </span>
  );
}
