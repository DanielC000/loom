import type { Tone } from "../theme";

// Which vendor CLI a Profile's sessions spawn as (multi-harness epic `df1f94b0`). `undefined` on a
// profile row means `"claude"` — today's default and the only harness before this field existed — so an
// untouched profile is never shown as having made a choice it didn't make.
export type Harness = "claude" | "codex";

export const harnessOf = (value: Harness | null | undefined): Harness => value ?? "claude";

// ── The codex consumption gap ───────────────────────────────────────────────────────────────────────
//
// A profile field that the codex spawn path never reads. Rendering such a field as a live control beside
// a codex rig manufactures the exact "checkbox reads ON while nothing is applied" false green that cards
// `0770d916` (the point fix) and `d34dd208` (the schema-wide sweep) exist to eliminate — so every field
// listed here is annotated and disabled in the Profiles editor while `harness = "codex"`.
//
// VERIFIED AT SOURCE, 2026-09-07, against `packages/daemon/src/pty/host.ts`. `spawn()` dispatches to
// `spawnCodexProcess` as its FIRST statement, so the codex spawn path is exactly the two methods
// `createCodexPty` + `spawnCodexProcess`. Across that whole range the ONLY SpawnOpts fields read are
// `sessionId` / `cwd` / `geometry` / `role` / `startupPrompt` — every field below is read on the claude
// path (`createPty`) and nowhere on the codex one.
//
// ⚠️ This is a UI mirror of daemon behaviour, not its source of truth, so it can go stale in the safe-
// looking direction (a field gets wired up and this keeps warning). `0770d916` is landing a machine-
// readable per-field × per-harness consumption registry with a guard behind it; when that exists, drive
// this map from it rather than re-deriving the list by hand. Until then: re-verify at source before
// editing, and positive-control any grep (a pattern that finds nothing in the codex range must be shown
// to find the same field in the claude one).
//
// @decision 0770d916 — severity is the failure DIRECTION, never the field count: a dropped SAFETY
// toggle fails OPEN and is categorically worse than a dropped capability, which merely fails closed.
export type DropSeverity = "fail-open" | "fail-closed" | "inert";

export interface HarnessDrop {
  severity: DropSeverity;
  /** What actually happens at spawn — phrased as the OUTCOME, never a bare "not supported". */
  note: string;
}

export const SEVERITY_META: Record<DropSeverity, { tone: Tone; tag: string }> = {
  // Reads ON, restricts nothing — the dangerous direction, so it gets the alert tone.
  "fail-open": { tone: "red", tag: "not enforced" },
  // The capability is simply absent: a real functionality gap, but failing safe.
  "fail-closed": { tone: "amber", tag: "not applied" },
  // Nothing is lost or widened — the setting just has no counterpart to act on.
  inert: { tone: "muted", tag: "no effect" },
};

// Keyed by the Profile schema field name, so this vocabulary lines up with the daemon's own
// MERGEABLE_PROFILE_FIELDS and with `FIELD_DISPLAY` in the Profiles editor.
export const CODEX_DROPPED_FIELDS = {
  restrictedTools: {
    severity: "fail-open",
    note:
      "Codex has no per-tool disallow concept — its entire permission model is two session-wide levers " +
      "(sandbox mode + approval policy). A rig on this harness spawns `-a never -s workspace-write` " +
      "regardless, so the dangerous native tools are NOT removed from its tool list.",
  },
  capabilities: {
    severity: "fail-closed",
    note:
      "The codex spawn resolves its MCP surface from the role alone, so no capability server is mounted. " +
      "A session under this rig gets none of the capabilities ticked here.",
  },
  skills: {
    severity: "fail-closed",
    note:
      "Codex reads its own AGENTS.md project-instructions file, not an injected `.claude/skills` " +
      "directory — so NO skills are delivered at all, neither a subset nor the full set.",
  },
  model: {
    severity: "inert",
    note: "Codex runs whatever model its own config selects; this pin is never passed through to it.",
  },
  allowDelta: {
    severity: "inert",
    note:
      "Codex has no per-tool allowlist. It spawns with approvals disabled inside its own workspace " +
      "sandbox, so these globs neither grant nor withhold anything there.",
  },
} as const satisfies Record<string, HarnessDrop>;

export type DroppedFieldKey = keyof typeof CODEX_DROPPED_FIELDS;

/** The dropped fields whose failure direction is OPEN — what a summary must lead with, if any. */
export const CODEX_FAIL_OPEN_FIELDS = (Object.keys(CODEX_DROPPED_FIELDS) as DroppedFieldKey[])
  .filter((k) => CODEX_DROPPED_FIELDS[k].severity === "fail-open");

/** Null unless this harness drops the field — so a caller can render the annotation unconditionally. */
export function harnessDrop(harness: Harness, field: DroppedFieldKey): HarnessDrop | null {
  return harness === "codex" ? CODEX_DROPPED_FIELDS[field] : null;
}

// ── The codex REJECTION set — a DIFFERENT set from CODEX_DROPPED_FIELDS above ────────────────────────
//
// @decision 6232fe9d — never conflate DROPPED (codex stores it, ignores it at spawn) with REJECTED
// (`validateProfile` refuses to store it at all): neither set contains the other, and a control that is
// disabled for one reason while its value is still SENT makes the rig unsaveable with no way to fix it.
//
// ⚠️ MIRROR of the daemon's `profiles/codex-compat.ts` › `codexIncompatibilities`, the ONE source of this
// rule — the web package cannot import from `packages/daemon`, so this is a copy by necessity. Keep it in
// step field for field, re-verify at source before editing, and never re-derive the list at a call site.
export const CODEX_REJECTED_FIELDS = ["restrictedTools", "browserTesting", "documentConversion", "capabilities"] as const;

export type CodexRejectedFieldKey = (typeof CODEX_REJECTED_FIELDS)[number];

/**
 * The Profiles-editor control label for every field this module names — so a summary or warning calls a
 * field what the reader can actually SEE on screen, rather than by its schema key. Covers the union of
 * {@link DroppedFieldKey} and {@link CodexRejectedFieldKey}; `FIELD_DISPLAY` in the Profiles editor spreads
 * this rather than restating the overlapping entries, so the two can never disagree about a label.
 */
export const HARNESS_FIELD_LABELS: Record<DroppedFieldKey | CodexRejectedFieldKey, string> = {
  restrictedTools: "Restricted tools",
  browserTesting: "Browser testing",
  documentConversion: "Document conversion",
  capabilities: "Capabilities",
  skills: "Skills",
  model: "Model",
  allowDelta: "Allow delta",
};

/** The subset of the profile a codex rejection depends on — mirrors the daemon's `CodexCompatInput`. */
export interface CodexRejectInput {
  restrictedTools?: boolean;
  browserTesting?: boolean;
  documentConversion?: boolean;
  capabilities?: readonly unknown[] | null;
}

/**
 * Which fields of `input` a codex save would be REFUSED for — empty ⇒ this rig can move onto codex as-is.
 * Harness-agnostic on purpose (it answers "what blocks codex", not "what is blocked now"), so a caller
 * asking about a rig already on claude passes the same values and branches on the harness itself.
 * Ordering matches `codexIncompatibilities` so the UI lists them in the same order the daemon reports.
 */
export function codexRejectedFields(input: CodexRejectInput): CodexRejectedFieldKey[] {
  return [
    input.restrictedTools === true ? "restrictedTools" : null,
    input.browserTesting === true ? "browserTesting" : null,
    input.documentConversion === true ? "documentConversion" : null,
    input.capabilities && input.capabilities.length > 0 ? "capabilities" : null,
  ].filter((f): f is CodexRejectedFieldKey => f !== null);
}

/**
 * `values` with every codex-rejected field cleared — the ONE place a save payload is made storable on
 * codex. Returns `values` UNTOUCHED (same object) on any other harness and whenever nothing is set, so a
 * claude save is byte-identical to before this existed.
 *
 * Clearing rather than refusing is card `6232fe9d`'s chosen branch: the alternative (leave them editable
 * so the user clears them by hand) asks the reader to understand a validator rule before they can save at
 * all. The honesty condition the card attaches to it is that the removal is NAMED BEFORE the click —
 * `codexRejectedFields` above drives that copy from this same source, never a hand-copied list.
 */
export function clearCodexRejectedFields<T extends CodexRejectInput>(harness: Harness, values: T): T {
  if (harness !== "codex" || codexRejectedFields(values).length === 0) return values;
  return { ...values, restrictedTools: false, browserTesting: false, documentConversion: false, capabilities: [] };
}

/**
 * The dropped fields codex genuinely KEEPS in the store — i.e. dropped-but-not-rejected. Derived from the
 * two sets rather than hand-listed, so the "they stay stored" promise in the drop summary can never claim
 * a field that a save actually removes (which is exactly what it claimed for all five before this card).
 */
export const CODEX_DROPPED_BUT_STORED_FIELDS = (Object.keys(CODEX_DROPPED_FIELDS) as DroppedFieldKey[])
  .filter((k) => !(CODEX_REJECTED_FIELDS as readonly string[]).includes(k));

// ── Mixed-harness views + the default-harness config ────────────────────────────────────────────────

/** Vendor product name, for a control that names the choice rather than tagging a row. */
export const HARNESS_TITLE: Record<Harness, string> = { claude: "Claude Code", codex: "Codex CLI" };

/** The shape {@link liveHarnesses} reads — structural, so a SessionListItem and a terminal-card session both fit. */
export interface HarnessMixSession {
  processState?: string;
  harness?: Harness | null;
}

/**
 * The distinct harnesses actually RUNNING in a set of sessions. Only `live` rows count: an exited/archived
 * row is history, and letting one widen the set would badge a whole view off a session nobody can act on.
 * An unset `harness` reads as claude (see {@link harnessOf}), so a fleet of untouched sessions is a
 * one-harness set, never a mixed one.
 */
export function liveHarnesses(sessions: readonly HarnessMixSession[]): Set<Harness> {
  const out = new Set<Harness>();
  for (const s of sessions) {
    if (s.processState !== undefined && s.processState !== "live") continue;
    out.add(harnessOf(s.harness));
  }
  return out;
}

/** Which roles a default-harness `scope` actually reaches — the human-facing copy for the shared allowlist. */
export type HarnessDefaultScopeValue = "workers" | "fleet";

// ── GET /api/harness/drain ──────────────────────────────────────────────────────────────────────────
//
// A DERIVED read (no stored drain state): which live sessions still run a harness that a spawn made right
// now would not pick. Typed here rather than imported from @loom/shared because the daemon builds the
// shape inline in `SessionService.harnessDrainStatus` — keep this in step with that return type.

/** One `codexIncompatibilities` item: the profile/session field that cannot be honoured, and why. */
export interface HarnessDrainReason { id: string; reason: string }

/** A session a drain WILL move — its next spawn/recycle lands on the target. */
export interface HarnessDrainSession {
  sessionId: string;
  role: string | null;
  harness: Harness;
  projectId: string;
}

/** A session a drain will NEVER move: a recycle re-resolves to codex but the row carries codex-incompatible fields. */
export interface HarnessDrainBlocked extends HarnessDrainSession {
  wanted: Harness;
  reasons: HarnessDrainReason[];
}

export interface HarnessDrainStatus {
  target: Harness;
  scope: "fleet" | { projectId: string };
  pending: HarnessDrainSession[];
  blocked: HarnessDrainBlocked[];
  /** True only when NOTHING is off target — `pending` AND `blocked` both empty. */
  done: boolean;
}
