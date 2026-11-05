// Loom "Terminal Cockpit" design tokens.
//
// The actual values live ONCE as CSS custom properties in styles/global.css (:root).
// This module exposes them to TS / React inline-styles as var() references, so there is
// a single source of truth and no drifting hex literals. Spec: packages/web/design/DESIGN.md.

import type { ColumnRole, KanbanColumn, SessionRole } from "@loom/shared";

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

  // ── Graphite semantic tokens (epic e25fa8a9). Each one follows the light/dark theme. The legacy
  // keys above are aliases onto these in global.css and move over call site by call site in later
  // Graphite cards, which then delete them.
  inset: "var(--loom-inset)",
  fieldBg: "var(--loom-field-bg)",
  railBg: "var(--loom-rail-bg)",
  laneBg: "var(--loom-lane-bg)",
  surface: "var(--loom-surface)",
  surface2: "var(--loom-surface-2)",
  btnBg: "var(--loom-btn-bg)",
  raised: "var(--loom-raised)",
  cardBg: "var(--loom-card-bg)",
  hover: "var(--loom-hover)",
  pressed: "var(--loom-pressed)",
  selected: "var(--loom-selected)",
  line: "var(--loom-line)",
  lineStrong: "var(--loom-line-strong)",
  lineHover: "var(--loom-line-hover)",
  text2: "var(--loom-text-2)",
  text3: "var(--loom-text-3)",
  accent: "var(--loom-accent)",
  accentHover: "var(--loom-accent-hover)",
  onAccent: "var(--loom-on-accent)",
  accentFg: "var(--loom-accent-fg)",
  accentEdge: "var(--loom-accent-edge)",
  ring: "var(--loom-ring)",
  ringSoft: "var(--loom-ring-soft)",
  live: "var(--loom-live)",
  liveText: "var(--loom-live-text)",
  liveSoft: "var(--loom-live-soft)",
  busy: "var(--loom-busy)",
  busySoft: "var(--loom-busy-soft)",
  onBusy: "var(--loom-on-busy)",
  info: "var(--loom-info)",
  infoSoft: "var(--loom-info-soft)",
  danger: "var(--loom-danger)",
  dangerSoft: "var(--loom-danger-soft)",
  dangerLine: "var(--loom-danger-line)",
  onDanger: "var(--loom-on-danger)",
  track: "var(--loom-track)",
  meterOk: "var(--loom-meter-ok)",
  scrim: "var(--loom-scrim)",
  termBg: "var(--loom-term-bg)",
  termFg: "var(--loom-term-fg)",
} as const;

// Elevation, per theme: none in dark (tonal surfaces), a hairline ring plus a short shadow in light.
export const shadow = {
  panel: "var(--loom-panel-shadow)",
  card: "var(--loom-card-shadow)",
  pop: "var(--loom-pop-shadow)",
} as const;

// A translucent tint of a colour token, for washes and soft borders: `wash(color.danger, 6)`. It mixes
// the token itself, so the tint follows the theme with the colour (a fixed rgba would not).
export const wash = (c: string, pct: number): string => `color-mix(in oklab, ${c} ${pct}%, transparent)`;

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
  terminal: "phosphor", // done
  mergeLanding: "amber", // where a merged card lands, pre-terminal
};

// A board lane's signal tone, resolved from its lifecycle ROLE — the ONE resolver, so every surface that
// tints a lane agrees (the board's accent bar / header label / card left-border, the drawer's lane badge,
// and the task-link lane chips in components/taskLinks). A role-less lane has no signal tone (it may
// still carry an explicit accentColor; that's a separate, cosmetic source resolved at the call site).
export function columnTone(col: Pick<KanbanColumn, "role">): Tone | null {
  return col.role ? roleTone[col.role] : null;
}

// Session-ROLE → badge tone. The ONE place a session/profile's orchestration role maps to a signal
// tone, so every surface that tints a session by its role agrees (Archive / Overview / Profiles /
// Workspace all read this). null/plain sessions fall back to "muted" at the call site. Distinct from
// the lane-oriented `roleTone` above (ColumnRole) — this keys on SessionRole.
export const sessionRoleTone: Record<NonNullable<SessionRole>, Tone> = {
  manager: "phosphor",
  worker: "cyan",
  platform: "amber",
  auditor: "muted",
  setup: "cyan",
  "workspace-auditor": "muted",
  run: "muted",
  assistant: "cyan",
  operator: "amber",
};
