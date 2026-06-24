// Loom "Terminal Cockpit" design tokens.
//
// The actual values live ONCE as CSS custom properties in styles/global.css (:root).
// This module exposes them to TS / React inline-styles as var() references, so there is
// a single source of truth and no drifting hex literals. Spec: packages/web/design/DESIGN.md.

import type { ColumnRole } from "@loom/shared";

export const color = {
  // Surfaces — depth comes from hairline borders, not shadows.
  bg: "var(--loom-bg)",
  panel: "var(--loom-panel)",
  panel2: "var(--loom-panel-2)",
  border: "var(--loom-border)",
  borderStrong: "var(--loom-border-strong)",
  // Signal — used sparingly, only where there is state.
  phosphor: "var(--loom-phosphor)", // live / primary / interactive
  phosphorDim: "var(--loom-phosphor-dim)", // fills, glows, selection
  amber: "var(--loom-amber)", // busy / attention
  cyan: "var(--loom-cyan)", // info / links / metadata
  red: "var(--loom-red)", // kill / error / dead / rate-limited
  // Text
  text: "var(--loom-text)",
  textDim: "var(--loom-text-dim)",
  textMuted: "var(--loom-text-muted)",
} as const;

export const font = {
  head: "var(--loom-font-head)", // Space Grotesk — uppercase section labels
  mono: "var(--loom-font-mono)", // JetBrains Mono — all data / IDs / code
} as const;

export const radius = {
  sm: "var(--loom-radius-sm)",
  base: "var(--loom-radius)",
} as const;

// 4px base grid. space(2) -> "8px".
export const space = (n: number): string => `${n * 4}px`;

// Signal tones — the semantic status palette used by StatusPill / Dot / Badge / Meter.
export type Tone = "phosphor" | "amber" | "cyan" | "red" | "muted";
export const tone: Record<Tone, string> = {
  phosphor: color.phosphor,
  amber: color.amber,
  cyan: color.cyan,
  red: color.red,
  muted: color.textMuted,
};

// Lifecycle-role → signal tone. The ONE place a board lane's role maps to a color, so every surface
// that tints a lane by its role agrees: the board header (accent bar + label + card left-border) AND
// the Settings ColumnManager (role badge + row border) both read this map. (Mirrors the preset
// ROLE_ACCENT palette in shared/presets.ts, which is its own — cosmetic, persisted — accent source.)
export const roleTone: Record<ColumnRole, Tone> = {
  intake: "cyan", // info / new arrivals
  defaultLanding: "phosphor", // the catch-all landing
  workReady: "muted", // queued, not yet active
  active: "amber", // in flight
  review: "cyan", // under review
  parked: "muted", // waiting / parked
  humanHold: "red", // needs a human
  terminal: "phosphor", // done
};
