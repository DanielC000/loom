import { resolveConfig, columnKeyForRole, type KanbanColumn, type ColumnRole, type ProjectConfigOverride } from "@loom/shared";
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

// --- One-time migration: retire the humanHold column-role in favor of the `held` flag ---------------

/**
 * app_meta one-shot marker for the Board Hold Model migration. Daemon-GLOBAL; survives a daemon_restart.
 */
export const HUMAN_HOLD_MIGRATION_KEY = "tasks.humanHoldToHeldMigration";

/**
 * ONE-TIME boot migration (Board Hold Model redesign, mirrors backfillColumnRoles/backfillHeldFromTitlesOnce):
 * the `blocked` column / `humanHold` column-role is retired — the per-card `held` flag becomes the SOLE
 * human brake, checked in ANY column. For every project (live + archived) whose board still carries a
 * humanHold-role column: every card on it is promoted `held=true` and moved to the `workReady` lane
 * (fallback `defaultLanding`), then the humanHold column is dropped from the project's STORED override.
 *
 * A project with NO explicit `kanbanColumns` override never had one to rewrite — it inherited the
 * pre-migration PLATFORM_DEFAULTS, whose humanHold column was always keyed `blocked` (the same assumption
 * LEGACY_KEY_TO_ROLE above made before this migration retired that key). Any of ITS cards sitting on that
 * key are migrated the same way; there is no override to rewrite since the newly-resolved defaults already
 * exclude the column.
 *
 * Runs AFTER backfillColumnRoles (so a legacy override's `blocked` key already carries role:"humanHold" by
 * the time this reads it) and MUST ship in the SAME deploy as the engine brake flip (spawnWorker /
 * idle-watcher / hasPendingBoardWork all key off `held` now) — a migrated card must never land in an
 * actionable lane while dispatch still keys off the old column. Lossless: blocked → held is a promotion,
 * never a downgrade. One-shot via an app_meta marker (checked first, stamped last); idempotent — a second
 * run finds no humanHold columns/legacy keys and no-ops.
 */
export function migrateHumanHoldToHeld(db: Db): { projectsMigrated: number; cardsMigrated: number } {
  if (db.getMeta(HUMAN_HOLD_MIGRATION_KEY) !== undefined) return { projectsMigrated: 0, cardsMigrated: 0 };
  let projectsMigrated = 0;
  let cardsMigrated = 0;
  const projects = [...db.listAllProjects(), ...db.listArchivedProjects()]; // live (incl. reserved) + archived
  for (const p of projects) {
    const override = p.config.kanbanColumns;
    const hasOverride = !!override && override.length > 0;
    // Resolve the humanHold column key + the column set to derive the migration target from. An
    // override-based board reads its OWN stored columns (already role-backfilled by now, in the COMMON
    // case); an override-less board never stored one — it inherited the legacy default, whose humanHold
    // column was always `blocked`. The override-based match ALSO falls back to the legacy key `blocked`
    // (not just role) — a never-backfilled home (a pre-role DB upgraded straight to this build, after
    // `blocked`→`humanHold` was removed from LEGACY_KEY_TO_ROLE above) would otherwise carry a role-LESS
    // `blocked` override column that role-matching alone can never find, silently losing the brake. The
    // role comparison reads legacy PERSISTED data (a role value the current ColumnRole type no longer
    // permits), hence the cast — this migration is the one place that's expected and correct.
    const humanHoldKey = hasOverride
      ? override!.find((c) => (c.role as string) === "humanHold" || c.key === "blocked")?.key
      : "blocked";
    if (!humanHoldKey) continue; // override-based board with no humanHold/blocked column — nothing to migrate
    const targetCols: KanbanColumn[] = hasOverride ? override! : resolveConfig(p.config).kanbanColumns;
    const targetKey = columnKeyForRole(targetCols, "workReady") ?? columnKeyForRole(targetCols, "defaultLanding");
    const cardsOnKey = db.listTasks(p.id).filter((t) => t.columnKey === humanHoldKey);
    if (!cardsOnKey.length && !hasOverride) continue; // override-less + no legacy cards → a genuine no-op
    if (cardsOnKey.length && !targetKey) continue; // defensive: no landing lane — never drop the column with cards still on it (no orphans)
    let actioned = false;
    if (cardsOnKey.length && targetKey) {
      for (const t of cardsOnKey) {
        db.updateTask(t.id, { held: true, columnKey: targetKey });
        cardsMigrated++;
      }
      actioned = true;
    }
    if (hasOverride) {
      const nextCols = override!.filter((c) => c.key !== humanHoldKey);
      db.setProjectConfig(p.id, { ...p.config, kanbanColumns: nextCols });
      actioned = true;
    }
    if (actioned) projectsMigrated++;
  }
  db.setMeta(HUMAN_HOLD_MIGRATION_KEY, new Date().toISOString()); // stamp last — the one-shot guarantee
  return { projectsMigrated, cardsMigrated };
}

// --- Part B: pure desired-vs-current layout planner -----------------------------------------------

/** A desired column in an atomic layout update. `prevKey` marks a KEY RENAME (re-key its cards old→new). */
export interface DesiredColumn {
  key: string;
  label: string;
  role?: ColumnRole;
  /** When the user RENAMED this column's key, the previous key. Its cards are re-keyed prevKey→key. */
  prevKey?: string;
  /** CSS header accent (e.g. "#6b8afd"). Optional — carried through to the stored KanbanColumn when present. */
  accentColor?: string;
  /** SOFT (advisory) work-in-progress limit. Optional — carried through to the stored KanbanColumn when present. */
  wipLimit?: number;
  /** Marks a dead-end/parking lane discounted from the idle watchdog. Optional — carried through as-is. */
  excludeFromIdleWatchdog?: boolean;
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
  // Removing this column drops the mergeLanding role; a merged card then falls back to the
  // `terminal` column (finalizeMerge's `?? terminal` resolution) — no card-orphaning, since
  // this same planColumnLayout re-keys the removed column's EXISTING cards to defaultLanding.
  mergeLanding: "where finalizeMerge lands a merged card (falls back to terminal if removed)",
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
    const removedCol = current.find((c) => c.key === removed);
    const role = removedCol?.role;
    if (role && role !== "defaultLanding" && role !== "terminal") {
      const depends = ROLE_DEPENDS[role] ?? `the '${role}' lane`;
      const removedLabel = removedCol?.label ?? removed; // human label, not the snake_case key
      warnings.push(`removing column '${removedLabel}' drops the '${role}' role (${depends}); that behavior falls back until you reassign the role`);
    }
  }

  // --- build the plan ---
  const defaultLandingKey = desired.find((d) => d.role === "defaultLanding")!.key; // exactly one (guarded)
  const rekeys: { from: string; to: string }[] = [];
  for (const d of desired) {
    if (d.prevKey && d.prevKey !== d.key) rekeys.push({ from: d.prevKey, to: d.key }); // rename: cards follow
  }
  for (const removed of removedKeys) rekeys.push({ from: removed, to: defaultLandingKey }); // removed cards → landing

  // Carry every present KanbanColumn field through; an ABSENT optional stays absent (no undefined-injection).
  const columns: KanbanColumn[] = desired.map((d) => {
    const col: KanbanColumn = { key: d.key, label: d.label };
    if (d.role) col.role = d.role;
    if (d.accentColor !== undefined) col.accentColor = d.accentColor;
    if (d.wipLimit !== undefined) col.wipLimit = d.wipLimit;
    if (d.excludeFromIdleWatchdog !== undefined) col.excludeFromIdleWatchdog = d.excludeFromIdleWatchdog;
    return col;
  });
  return { ok: true, warnings, columns, rekeys, defaultLandingKey };
}

/**
 * Convenience used by the daemon + tests: resolve a project's CURRENT resolved columns. Kept here so the
 * lifecycle API + its tests share one source for "what the board looks like right now".
 */
export function currentColumns(db: Db, projectId: string): KanbanColumn[] {
  return resolveConfig(db.getProject(projectId)?.config).kanbanColumns;
}

/**
 * Apply a project config override that MAY change the board's column layout, SAFELY — the shared writer
 * behind the config-PATCH surfaces (the platform `project_configure` MCP tool + the REST
 * `PATCH /api/projects/:id/config`). The blind `db.setProjectConfig` is a two-path asymmetry hazard: it
 * writes the new columns with NO card re-key, so renaming/removing a column ORPHANS every card still on the
 * old key (Board.tsx filters strictly → the card vanishes, no migration), violating columns.ts's hard
 * invariant "no task references a non-existent column". The dedicated column editor (PUT /api/projects/:id/
 * columns → planColumnLayout) re-keys cards; these config-PATCH surfaces bypassed it.
 *
 * When the override changes the column KEY SET (the only thing that can orphan a card), route the column
 * change through the existing transactional safe WRITER `db.applyBoardColumnLayout`: every card on a
 * removed/renamed-away key lands in the resolved defaultLanding lane, and the writer's backstop sweep +
 * post-apply assertion guarantee ZERO orphans (or the whole thing rolls back). The columns are stored
 * EXACTLY as supplied (roles preserved or absent as given — this path deliberately does NOT re-validate or
 * normalize the layout, matching the blind path's tolerance of a roleless board via columnKeyForRole's
 * first/last fallback, so it never rejects a layout the blind path would have accepted). A patch that does
 * NOT change the key set (label/role/accent edits, or any non-column key) stays on the blind path,
 * byte-identical to before.
 *
 * A blind config PATCH carries no `prevKey`, so a rename is indistinguishable from drop-old+add-new — cards
 * follow to defaultLanding, NOT to the renamed column. The PUT /columns editor is the rename-FOLLOWING path;
 * this surface only guarantees no orphan. Returns {ok:false} on an unknown project or an empty board, with
 * the stored config left UNCHANGED.
 */
export function setProjectConfigSafe(
  db: Db, projectId: string, next: ProjectConfigOverride,
): { ok: true } | { ok: false; error: string } {
  const project = db.getProject(projectId);
  if (!project) return { ok: false, error: "project not found" };
  const current = resolveConfig(project.config).kanbanColumns;
  const desired = resolveConfig(next).kanbanColumns;
  const curKeys = new Set(current.map((c) => c.key));
  const nextKeys = new Set(desired.map((c) => c.key));
  const keySetChanged = curKeys.size !== nextKeys.size || [...nextKeys].some((k) => !curKeys.has(k));
  if (!keySetChanged) { db.setProjectConfig(projectId, next); return { ok: true }; } // no orphan possible → blind path
  // An empty board would orphan EVERY card with no landing target — reject (the blind path would silently
  // store it and break the board). Mirrors planColumnLayout's ≥1-column floor.
  if (!desired.length) return { ok: false, error: "a board must keep at least one column" };
  // The landing target for dropped cards: the desired board's resolved defaultLanding (first-column fallback
  // when roleless), guaranteed to be one of `desired`'s keys — exactly what applyBoardColumnLayout requires.
  const defaultLandingKey = columnKeyForRole(desired, "defaultLanding");
  if (!defaultLandingKey) return { ok: false, error: "the board has no landing column" }; // defensive (≥1 col ⇒ defined)
  const rekeys = [...curKeys].filter((k) => !nextKeys.has(k)).map((from) => ({ from, to: defaultLandingKey }));
  // Persist the NON-column keys first so applyBoardColumnLayout (which writes {...config, kanbanColumns})
  // lands the full override; it then stores the EXACT desired columns + sweeps every orphan to the landing lane.
  const rest = { ...next };
  delete rest.kanbanColumns;
  db.setProjectConfig(projectId, rest);
  db.applyBoardColumnLayout(projectId, desired, rekeys, defaultLandingKey);
  return { ok: true };
}
