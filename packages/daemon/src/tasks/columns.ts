import { resolveConfig, type KanbanColumn, type ColumnRole } from "@loom/shared";
import type { Db } from "../db.js";

// Board-column lifecycle (task B): the ONE-TIME role backfill migration + the pure desired-vs-current
// layout planner behind the atomic safe column-lifecycle API. The HARD INVARIANT this code exists to
// uphold: no task may ever reference a non-existent column.

// --- One-time migration: backfill `role` onto legacy stored project configs ------------------------

/**
 * app_meta one-shot marker for the column-role backfill. Daemon-GLOBAL (app_meta is not project-scoped),
 * so it survives a daemon_restart — the "fires exactly once, forever" anchor (mirrors SETUP_FIRST_RUN_KEY).
 */
export const COLUMN_ROLE_BACKFILL_KEY = "tasks.columnRoleBackfill";

/**
 * Today's hardcoded column KEY → its lifecycle ROLE, for the pre-role default board. A stored config that
 * predates `role` (task A) carries these keys with no role; this table maps them back so NOTHING changes
 * for current boards (a role annotation moves no cards). A non-default key (a user's custom column) is
 * left role-less — the required-role backstop below still guarantees defaultLanding + terminal.
 */
const LEGACY_KEY_TO_ROLE: Readonly<Record<string, ColumnRole>> = {
  backlog: "defaultLanding",
  inbox: "intake",
  todo: "workReady",
  in_progress: "active",
  review: "review",
  waiting: "parked",
  blocked: "humanHold",
  done: "terminal",
};

/**
 * ONE-TIME boot migration (triple-guarded one-shot): backfill `role` onto EXISTING stored project
 * configs that predate task A. Mirrors seedSetupAgentRename's containment posture but is marker-guarded
 * (the rename was idempotent by name-match; this isn't content-idempotent — a user may legitimately
 * re-role a column later, and we must never clobber that on a reboot).
 *
 * The three guards:
 *  1. the app_meta marker — runs exactly once per LOOM_HOME, ever (survives daemon_restart);
 *  2. per project — only a config with an EXPLICIT `kanbanColumns` override is touched (an override-less
 *     project already inherits the role-annotated PLATFORM_DEFAULTS, so there is nothing to backfill);
 *  3. per column — a role is assigned ONLY where one is absent (an already-roled column is left as-is).
 *
 * After mapping, every migrated board is guaranteed the two REQUIRED roles: if no column carries
 * `defaultLanding`, the FIRST column gets it; if none carries `terminal`, the LAST column gets it (matching
 * columnKeyForRole's fallbacks, so the board's effective behavior is unchanged). NO card is ever moved.
 *
 * Iterates every live + archived project row (reserved homes included; an archived project keeps its
 * legacy override otherwise). Returns the count of projects whose config was rewritten.
 */
export function backfillColumnRoles(db: Db): { migrated: number } {
  if (db.getMeta(COLUMN_ROLE_BACKFILL_KEY)) return { migrated: 0 }; // guard 1: already run
  let migrated = 0;
  const projects = [...db.listAllProjects(), ...db.listArchivedProjects()]; // live (incl. reserved) + archived
  for (const p of projects) {
    const stored = p.config.kanbanColumns;
    if (!stored || !stored.length) continue; // guard 2: no explicit column override → inherits defaults
    let changed = false;
    const cols: KanbanColumn[] = stored.map((c) => {
      if (c.role) return c; // guard 3: already roled — leave it
      const role = LEGACY_KEY_TO_ROLE[c.key];
      if (!role) return c; // a custom key with no legacy mapping — leave role-less
      changed = true;
      return { ...c, role };
    });
    // Required-role backstop: every board must end with defaultLanding + terminal assigned somewhere.
    const first = cols[0];
    const last = cols[cols.length - 1];
    if (first && !cols.some((c) => c.role === "defaultLanding")) {
      cols[0] = { ...first, role: "defaultLanding" };
      changed = true;
    }
    if (last && !cols.some((c) => c.role === "terminal")) {
      cols[cols.length - 1] = { ...last, role: "terminal" };
      changed = true;
    }
    if (changed) {
      db.setProjectConfig(p.id, { ...p.config, kanbanColumns: cols });
      migrated++;
    }
  }
  db.setMeta(COLUMN_ROLE_BACKFILL_KEY, new Date().toISOString()); // stamp last — the one-shot guarantee
  return { migrated };
}

// --- Part B: pure desired-vs-current layout planner -----------------------------------------------

/** A desired column in an atomic layout update. `prevKey` marks a KEY RENAME (re-key its cards old→new). */
export interface DesiredColumn {
  key: string;
  label: string;
  role?: ColumnRole;
  /** When the user RENAMED this column's key, the previous key. Its cards are re-keyed prevKey→key. */
  prevKey?: string;
}

/** The outcome of planning a layout change: a hard reject, or the columns + card re-keys to apply. */
export interface ColumnLayoutPlan {
  ok: boolean;
  /** Set on a HARD reject (a guard violation); the caller surfaces it as a 400. */
  error?: string;
  /** Soft advisories (e.g. removing a role-bearing lifecycle lane) — surfaced but not blocking. */
  warnings: string[];
  /** The final KanbanColumn[] to store (prevKey stripped). Present iff ok. */
  columns?: KanbanColumn[];
  /** Card re-keys to apply IN ORDER (renames then removals→defaultLanding). Present iff ok. */
  rekeys?: { from: string; to: string }[];
  /** The resolved defaultLanding key of the DESIRED layout (the catch-all re-key target). Present iff ok. */
  defaultLandingKey?: string;
}

/** Human-readable note of what a non-required lifecycle role drives, for the removal warning. */
const ROLE_DEPENDS: Readonly<Partial<Record<ColumnRole, string>>> = {
  intake: "where workspace-auditor suggestions land",
  workReady: "the idle-watcher's open-work count",
  active: "where a spawned worker's task is moved",
  review: "where a worker's done report lands for review",
  parked: "where a worker's blocked report lands",
  humanHold: "the human-hold lane",
};

/**
 * Plan an atomic board-column layout change by diffing `desired` against `current`. PURE — no DB, no
 * mutation — so it is unit-testable and the transactional writer (db.applyBoardColumnLayout) just executes
 * the plan. Enforces the Part-B guards:
 *  - ≥1 column; every key non-empty + unique; every label non-empty;
 *  - EXACTLY ONE column each for the two REQUIRED roles (defaultLanding, terminal); any other role at
 *    most once (a duplicate role is ambiguous for columnKeyForRole);
 *  - a `prevKey` must name a current column (you can't rename from a column that doesn't exist).
 *
 * The removal/rename diff (a current key is KEPT if it stays in desired, RENAMED if a desired column
 * claims it as prevKey, else REMOVED) yields the card re-keys: renamed columns' cards follow old→new;
 * removed columns' cards land in the DESIRED defaultLanding column (guaranteed to exist + be kept).
 * Removing a required-role column is allowed iff the desired set still assigns that role elsewhere — which
 * the exactly-one-each requirement guarantees. Removing any other role-bearing column is a soft warning.
 */
export function planColumnLayout(
  current: readonly KanbanColumn[],
  desired: readonly DesiredColumn[],
): ColumnLayoutPlan {
  const warnings: string[] = [];

  // --- shape guards ---
  if (!desired.length) return { ok: false, warnings, error: "a board must keep at least one column" };
  const keys = desired.map((d) => d.key);
  if (keys.some((k) => !k || !k.trim())) return { ok: false, warnings, error: "every column needs a non-empty key" };
  if (desired.some((d) => !d.label || !d.label.trim())) return { ok: false, warnings, error: "every column needs a non-empty label" };
  if (new Set(keys).size !== keys.length) return { ok: false, warnings, error: "column keys must be unique" };

  // --- role guards (exactly one defaultLanding + terminal; any other role at most once) ---
  const roleCounts = new Map<ColumnRole, number>();
  for (const d of desired) if (d.role) roleCounts.set(d.role, (roleCounts.get(d.role) ?? 0) + 1);
  if ((roleCounts.get("defaultLanding") ?? 0) !== 1) {
    return { ok: false, warnings, error: "the board must have exactly one default-landing column" };
  }
  if ((roleCounts.get("terminal") ?? 0) !== 1) {
    return { ok: false, warnings, error: "the board must have exactly one terminal (done) column" };
  }
  for (const [role, n] of roleCounts) {
    if (n > 1 && role !== "defaultLanding" && role !== "terminal") {
      return { ok: false, warnings, error: `role '${role}' is assigned to more than one column` };
    }
  }

  // --- prevKey guards ---
  const currentKeys = new Set(current.map((c) => c.key));
  const renameSources = new Set<string>();
  for (const d of desired) {
    if (!d.prevKey) continue;
    if (!currentKeys.has(d.prevKey)) {
      return { ok: false, warnings, error: `cannot rename from '${d.prevKey}': no such current column` };
    }
    if (renameSources.has(d.prevKey)) {
      return { ok: false, warnings, error: `two columns claim the same previous key '${d.prevKey}'` };
    }
    renameSources.add(d.prevKey);
  }

  // --- partition current keys: kept | renamed | removed ---
  const desiredKeys = new Set(keys);
  const removedKeys = current.filter((c) => !desiredKeys.has(c.key) && !renameSources.has(c.key)).map((c) => c.key);

  // Removal warnings for role-bearing non-required lanes (the required ones are guarded above: removing
  // a defaultLanding/terminal column is fine since the role is reassigned to a kept column).
  for (const removed of removedKeys) {
    const role = current.find((c) => c.key === removed)?.role;
    if (role && role !== "defaultLanding" && role !== "terminal") {
      const depends = ROLE_DEPENDS[role] ?? `the '${role}' lane`;
      warnings.push(`removing column '${removed}' drops the '${role}' role (${depends}); that behavior falls back until you reassign the role`);
    }
  }

  // --- build the plan ---
  const defaultLandingKey = desired.find((d) => d.role === "defaultLanding")!.key; // exactly one (guarded)
  const rekeys: { from: string; to: string }[] = [];
  for (const d of desired) {
    if (d.prevKey && d.prevKey !== d.key) rekeys.push({ from: d.prevKey, to: d.key }); // rename: cards follow
  }
  for (const removed of removedKeys) rekeys.push({ from: removed, to: defaultLandingKey }); // removed cards → landing

  const columns: KanbanColumn[] = desired.map((d) => (d.role ? { key: d.key, label: d.label, role: d.role } : { key: d.key, label: d.label }));
  return { ok: true, warnings, columns, rekeys, defaultLandingKey };
}

/**
 * Convenience used by the daemon + tests: resolve a project's CURRENT resolved columns. Kept here so the
 * lifecycle API + its tests share one source for "what the board looks like right now".
 */
export function currentColumns(db: Db, projectId: string): KanbanColumn[] {
  return resolveConfig(db.getProject(projectId)?.config).kanbanColumns;
}
