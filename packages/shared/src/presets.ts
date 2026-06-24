// Board-column PRESETS — a small, typed catalog of ready-made board layouts a user can pick at project
// creation or reset an existing board to. Each preset is just a `KanbanColumn[]` (reusing the shared
// column shape, incl. the optional `accentColor`), so a preset feeds straight into the SAME atomic
// columns API (PUT /api/projects/:id/columns) the editor already uses — there is no preset-specific
// endpoint or persistence path.
//
// HARD CONTRACT every preset upholds (so it survives planColumnLayout's guards): ≥1 column; EXACTLY one
// `defaultLanding` + EXACTLY one `terminal`; any other role at most once; non-empty unique keys + labels.
// The shared `column-presets` test asserts all of this against the live planner.
import { PLATFORM_DEFAULTS, type KanbanColumn, type ColumnRole } from "./config.js";

/** Accent palette keyed by lifecycle role, drawn from the web theme tokens (global.css) so the preset
 *  colors match the app's design language rather than an ad-hoc rainbow. Cosmetic only — the atomic API
 *  drops `accentColor` until the sibling persistence card lands; the key/label/role set persists today. */
const ROLE_ACCENT: Readonly<Record<ColumnRole, string>> = {
  intake: "#5bc8ff", // cyan — info / new arrivals
  defaultLanding: "#2ee66e", // phosphor — the catch-all landing
  workReady: "#7c8b9a", // slate — queued, not yet active
  active: "#ffb23e", // amber — in flight
  review: "#5bc8ff", // cyan — under review
  parked: "#7c8b9a", // slate — waiting / parked
  humanHold: "#ff5c5c", // red — needs a human
  terminal: "#2ee66e", // phosphor — done
};

/** Build a column with its role's accent applied, so each preset reads as a tidy table below. */
function col(key: string, label: string, role: ColumnRole): KanbanColumn {
  return { key, label, role, accentColor: ROLE_ACCENT[role] };
}

/** One selectable board layout. `id` is the stable picker value; `columns` is what gets applied. */
export interface ColumnPreset {
  /** Stable identifier used as the picker's option value (never shown raw). */
  id: string;
  /** Human-facing name shown in the picker. */
  name: string;
  /** One-line blurb describing the workflow this board suits. */
  description: string;
  /** The board layout this preset seeds/applies. */
  columns: KanbanColumn[];
}

/** The preset selected by default at project creation — keeps a fresh project on today's exact board. */
export const DEFAULT_COLUMN_PRESET_ID = "agent-dev";

export const COLUMN_PRESETS: ColumnPreset[] = [
  {
    // The current default dev board: PLATFORM_DEFAULTS' columns verbatim (key/label/role), with the role
    // accents layered on. Derived from PLATFORM_DEFAULTS so it can never drift from "today's behavior".
    id: "agent-dev",
    name: "Agent Dev",
    description: "The full agent-orchestration board (intake → review → done). Today's default.",
    columns: PLATFORM_DEFAULTS.kanbanColumns.map((c) =>
      c.role ? { ...c, accentColor: ROLE_ACCENT[c.role] } : { ...c },
    ),
  },
  {
    // A writing/research pipeline: gather → read → draft → review → publish, with a human-hold lane.
    id: "research",
    name: "Research",
    description: "A reading-and-writing pipeline: inbox → reading → drafting → review → published.",
    columns: [
      col("inbox", "Inbox", "intake"),
      col("reading", "Reading", "defaultLanding"),
      col("drafting", "Drafting", "active"),
      col("review", "Review", "review"),
      col("blocked", "Blocked", "humanHold"),
      col("published", "Published", "terminal"),
    ],
  },
  {
    // A lean operations board: triage → do → wait → done, with a human-hold lane.
    id: "ops",
    name: "Ops",
    description: "A lean operations board: triage → in progress → waiting → done.",
    columns: [
      col("triage", "Triage", "defaultLanding"),
      col("in_progress", "In Progress", "active"),
      col("waiting", "Waiting", "parked"),
      col("blocked", "Blocked", "humanHold"),
      col("done", "Done", "terminal"),
    ],
  },
  {
    // The minimal three-lane board.
    id: "simple",
    name: "Simple",
    description: "The minimal three-lane board: to do → doing → done.",
    columns: [
      col("todo", "To Do", "defaultLanding"),
      col("doing", "Doing", "active"),
      col("done", "Done", "terminal"),
    ],
  },
  {
    // A platform-lead board geared to the escalation-driven cross-project admin loop: manager
    // escalations land in 'escalations', flow through review, and finish in done. (The reserved Platform
    // home itself ships override-less and inherits PLATFORM_DEFAULTS; this preset is the sensible
    // distinct layout a human can pick for that style of work.)
    id: "platform-lead",
    name: "Platform Lead",
    description: "A cross-project admin board: escalations → backlog → in progress → review → done.",
    columns: [
      col("escalations", "Escalations", "intake"),
      col("backlog", "Backlog", "defaultLanding"),
      col("in_progress", "In Progress", "active"),
      col("review", "Review", "review"),
      col("blocked", "Blocked", "humanHold"),
      col("done", "Done", "terminal"),
    ],
  },
];

/** Look up a preset by id (the default preset when no/unknown id is given). */
export function presetById(id: string | undefined): ColumnPreset {
  return COLUMN_PRESETS.find((p) => p.id === id) ?? COLUMN_PRESETS.find((p) => p.id === DEFAULT_COLUMN_PRESET_ID)!;
}

/** A column in the shape the atomic columns API (PUT /…/columns) expects. Mirrors the daemon's
 *  `DesiredColumn` without importing it (shared stays daemon-free): key/label/role only. No `prevKey` —
 *  applying a preset is a fresh layout, not a rename, so dropped columns' cards fall to defaultLanding. */
export interface PresetDesiredColumn {
  key: string;
  label: string;
  role?: ColumnRole;
}

/** Convert a preset's columns into the atomic-API payload. Drops `accentColor` (the API drops it today;
 *  persistence rides the sibling card) and omits `prevKey` (a preset apply is a re-layout, not a rename). */
export function presetToDesired(preset: ColumnPreset): PresetDesiredColumn[] {
  return preset.columns.map((c) => (c.role ? { key: c.key, label: c.label, role: c.role } : { key: c.key, label: c.label }));
}
