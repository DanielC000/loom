// Loom "Graphite" design tokens.
//
// The actual values live ONCE as CSS custom properties in styles/global.css, one set per theme
// (:root[data-theme="dark" | "light"]). This module exposes them to TS / React inline styles as var()
// references, so every value follows the theme and nothing drifts into a literal.
// Spec: packages/web/design/DESIGN.md.

import type { ColumnRole, KanbanColumn, SessionRole } from "@loom/shared";

export const color = {
  bg: "var(--loom-bg)",
  text: "var(--loom-text)",
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
  // Live green for bare small text / glyphs on a page surface. Same as `live` in dark; text-safe in light.
  liveFg: "var(--loom-live-fg)",
  work: "var(--loom-work)",
  workText: "var(--loom-work-text)",
  workSoft: "var(--loom-work-soft)",
  attn: "var(--loom-attn)",
  attnText: "var(--loom-attn-text)",
  attnSoft: "var(--loom-attn-soft)",
  onAttn: "var(--loom-on-attn)",
  // Amber for bare small text / glyphs on a page surface. Same as `attn` in dark; text-safe in light.
  attnFg: "var(--loom-attn-fg)",
  danger: "var(--loom-danger)",
  dangerText: "var(--loom-danger-text)",
  dangerSoft: "var(--loom-danger-soft)",
  dangerFill: "var(--loom-danger-fill)",
  dangerLine: "var(--loom-danger-line)",
  onDanger: "var(--loom-on-danger)",
  track: "var(--loom-track)",
  meterOk: "var(--loom-meter-ok)",
  scrim: "var(--loom-scrim)",
  termBg: "var(--loom-term-bg)",
  cardBorder: "var(--loom-card-border)",
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
  ui: "var(--loom-font-ui)", // Instrument Sans — prose, labels, buttons
  mono: "var(--loom-font-mono)", // Geist Mono — data / IDs / code
} as const;

// Graphite type scale, as CSS lengths: `fontSize: fs.body`. Mirrors the --loom-fs-* tokens.
export const fs = {
  xs: "var(--loom-fs-xs)", // 11 — the floor: dense meta, small labels, mono ids; nothing smaller
  sm: "var(--loom-fs-sm)", // 12 — small text, labels
  mono: "var(--loom-fs-mono)", // 12.5 — data
  body: "var(--loom-fs-body)", // 14
  lg: "var(--loom-fs-lg)", // 17.5 — sub-head
  h1: "var(--loom-fs-h1)", // 22
  kpi: "var(--loom-fs-kpi)", // 27.5 — semibold, tabular
} as const;

export const radius = {
  sm: "var(--loom-radius-sm)", // 6 — tags, small controls
  base: "var(--loom-radius)", // 8 — buttons, fields
  lg: "var(--loom-radius-lg)", // 12 — panels, cards
  pill: "var(--loom-radius-pill)", // capsules, chips
} as const;

// 4px base grid. space(2) -> "8px".
export const space = (n: number): string => `${n * 4}px`;

// Signal tones: the semantic status palette used by StatusPill / Dot / Badge / Chip / Meter.
//   live    alive and healthy, or succeeded (saved, merged, passed);
//   work    an agent is doing something: normal, no action needed;
//   attn    a human is needed: a pending request, the Review lane, unsaved work, a threshold, P1;
//   danger  failed, refused, destructive, P0;
//   muted   identity and metadata: roles, branches, ids, lane names, P2/P3;
//   accent  the cobalt brand: the primary action, selection, links, the healthy meter. Never a status.
export type Tone = "live" | "work" | "attn" | "danger" | "muted" | "accent";

// The tone's signal colour: what a caller writes into `color:` or a border. Each signal reads its
// -text shade (the fill shade is too light to read as text on the light theme's white); a dot or a
// meter bar reads `toneFill` instead.
export const tone: Record<Tone, string> = {
  live: color.liveText,
  work: color.workText,
  attn: color.attnText,
  danger: color.dangerText,
  muted: color.text3,
  accent: color.accentFg,
};

// The tone as TEXT laid on its own soft fill (a status capsule, a tag). Neutral text on the
// surface-2 capsule is text-2, which keeps a muted tag legible; every other tone equals `tone`.
export const toneText: Record<Tone, string> = { ...tone, muted: color.text2 };

// The tone as a FILL: a status dot, a meter bar.
export const toneFill: Record<Tone, string> = {
  live: color.live,
  work: color.work,
  attn: color.attn,
  danger: color.danger,
  muted: color.text3,
  accent: color.meterOk,
};

// The tone's tinted background, for a capsule or tag that carries the tone's text on top of it.
export const toneSoft: Record<Tone, string> = {
  live: color.liveSoft,
  work: color.workSoft,
  attn: color.attnSoft,
  danger: color.dangerSoft,
  muted: color.surface2,
  accent: color.selected,
};

// Lifecycle-role → signal tone. The ONE place a board lane's role maps to a color, so every surface
// that tints a lane by its role agrees: the board header (accent bar + label + card left-border) AND
// the Settings ColumnManager (role badge + row border) both read this map. (Mirrors the preset
// ROLE_ACCENT palette in shared/presets.ts, which is its own — cosmetic, persisted — accent source.)
export const roleTone: Record<ColumnRole, Tone> = {
  intake: "muted", // new arrivals: a lane name, not a state
  defaultLanding: "muted", // the catch-all landing (accent is never a state)
  workReady: "muted", // queued, not yet active
  active: "work", // in flight
  review: "attn", // review is exactly where a human is needed
  parked: "muted", // waiting / parked
  terminal: "muted", // done: quiet, never green (green means live only)
  mergeLanding: "work", // a merged card landing, pre-terminal
};

// A board lane's signal tone, resolved from its lifecycle ROLE — the ONE resolver, so every surface that
// tints a lane agrees (the board's accent bar / header label / card left-border, the drawer's lane badge,
// and the task-link lane chips in components/taskLinks). A role-less lane has no signal tone (it may
// still carry an explicit accentColor; that's a separate, cosmetic source resolved at the call site).
export function columnTone(col: Pick<KanbanColumn, "role">): Tone | null {
  return col.role ? roleTone[col.role] : null;
}

// Session-ROLE → badge tone. The ONE place a session/profile's orchestration role maps to a tone, so
// every surface that tints a session by its role agrees (Archive / Overview / Profiles / Workspace all
// read this). null/plain sessions fall back to "muted" at the call site. Distinct from the
// lane-oriented `roleTone` above (ColumnRole) — this keys on SessionRole. A role is identity, not a
// state, so every role is neutral: the role's word (and glyph, where a surface draws one) carries it.
export const sessionRoleTone: Record<NonNullable<SessionRole>, Tone> = {
  manager: "muted",
  worker: "muted",
  platform: "muted",
  auditor: "muted",
  setup: "muted",
  "workspace-auditor": "muted",
  run: "muted",
  assistant: "muted",
};
