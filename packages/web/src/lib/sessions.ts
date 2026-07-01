import type { Session, ProcessState, SessionRole } from "@loom/shared";

// The ONE shared session ordering, applied at every session-list tier (Workspace, Terminals,
// Mission Control, the Overview fleet accordion) so a session's place in a list is consistent everywhere.
//
// Order: (1) liveness first — live/starting rank above exited/none; (2) lastActivity DESC — the
// most-recently-active float up; (3) createdAt as a stable tiebreak (spawn order). Applied WITHIN
// each group only — callers preserve the manager→worker hierarchy and never flatten it.
//
// Server-side listChildren stays createdAt-ordered (spawn order is correct for resume/boot); this
// is purely the viewport's presentation order.

/** The minimal session shape this comparator needs — Session and SessionListItem both satisfy it. */
export type SessionOrder = Pick<Session, "processState" | "lastActivity" | "createdAt">;

// Liveness bucket — lower sorts higher. live/starting are "present"; exited/none tie at the bottom.
function livenessRank(state: ProcessState): number {
  return state === "live" || state === "starting" ? 0 : 1;
}

export function bySessionActivity(a: SessionOrder, b: SessionOrder): number {
  const byLiveness = livenessRank(a.processState) - livenessRank(b.processState);
  if (byLiveness !== 0) return byLiveness;
  // ISO-8601 strings compare lexicographically in chronological order; reverse for DESC.
  const byActivity = b.lastActivity.localeCompare(a.lastActivity);
  if (byActivity !== 0) return byActivity;
  return a.createdAt.localeCompare(b.createdAt); // stable spawn-order tiebreak
}

/** The minimal shape the stable comparator needs — Session and SessionListItem both satisfy it. */
export type SessionStableOrder = Pick<Session, "createdAt" | "id">;

/**
 * STABLE newest-first comparator — createdAt DESC, tiebreak id. Unlike bySessionActivity, this key
 * never depends on liveness or lastActivity, so a row keeps its slot whether it's busy or idle and
 * a polling list (Overview, Terminals) never reshuffles between polls. Because createdAt is immutable,
 * DESC is still a STABLE order — newest sessions simply sit at the TOP instead of the bottom, and no
 * row reshuffles between polls. Use this for any tier that must hold position through busy↔idle flips.
 */
export function byCreatedStable(a: SessionStableOrder, b: SessionStableOrder): number {
  return b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id);
}

/** The minimal shape the manager-first comparator needs — role on top of the stable-order fields. */
export type SessionRoleOrder = SessionStableOrder & Pick<Session, "role">;

// Manager bucket — managers rank 0 (first/left), everyone else 1. null/undefined role (plain or
// orphaned sessions) is NOT a manager, so it sinks below the manager(s) in the same group.
function managerRank(role: SessionRole | null | undefined): number {
  return role === "manager" ? 0 : 1;
}

/**
 * Manager-first STABLE comparator for any FLAT grid that mixes a manager with its workers — the
 * Overview `ProjectTerminals` grid and the Terminals-page live grid. Managers sort BEFORE workers
 * (so the orchestrator sits first/left and its workers follow to the right), then byCreatedStable
 * WITHIN each bucket (createdAt DESC, id tiebreak → newest-first, immutable key, no reshuffle on the
 * 3s poll). Use this ONLY where a flat grid must read manager→workers left-to-right; grouped tiers
 * (the fleet accordion, the Terminals manager rows) keep their own nesting and don't need it.
 */
export function byManagerThenCreated(a: SessionRoleOrder, b: SessionRoleOrder): number {
  const byManager = managerRank(a.role) - managerRank(b.role);
  if (byManager !== 0) return byManager;
  return byCreatedStable(a, b);
}

/** The minimal shape the resume gate needs — Session and SessionListItem both satisfy it. */
export type SessionResumeGate = Pick<Session, "processState" | "resumability"> & { archivedAt?: string | null };

/**
 * Whether a session's Resume affordance should show. Auto-archive-on-exit (card b37750a4) stamps
 * archivedAt in the SAME onExit handler that flips processState to "exited", and the rail/god-eye
 * lists (listAllSessions) exclude archived rows outright — so by the time any poll observes a row,
 * gating Resume on `processState === "exited"` alone is already too late: the row either hasn't
 * archived yet (a window of effectively zero) or has archived and vanished from the rail entirely
 * (findings #14/#15). Gate on EITHER signal — still-exited-but-not-yet-archived, OR already
 * archived — so Resume has a durable path through the archive, not just the ephemeral rail window.
 * resume()/resumeSession un-archives + respawns in one call regardless of which state it finds the
 * row in, so both branches call the exact same mutation. Shared by SessionActions and RunHistory so
 * the two surfaces don't drift onto separate resume mechanisms.
 */
export function canResumeSession(s: SessionResumeGate): boolean {
  return (s.processState === "exited" || !!s.archivedAt) && s.resumability !== "dead";
}

/**
 * Most-recent activity timestamp (epoch ms) across a group's members — for ranking GROUPS (a
 * project lane, a manager's subtree) by their freshest member, so the group you're driving floats
 * up. Empty groups sink (−Infinity). This is the project-tier logic Mission Control had inline.
 */
export function mostRecentActivity(members: readonly SessionOrder[]): number {
  let max = -Infinity;
  for (const m of members) max = Math.max(max, +new Date(m.lastActivity));
  return max;
}

/** The minimal session shape the Terminals-page grouping needs — role + parent + the stable-order keys. */
export type SessionRowMember = SessionRoleOrder & Pick<Session, "parentSessionId">;

/** One rendered row of the Terminals live-sessions grid (see groupSessionRows). */
export type SessionRowGroup<T> = { key: string; kind: "manager" | "orphans" | "standalone"; list: T[] };

/**
 * The Terminals-page manager-centric grouping, extracted here as a PURE function so it can't drift
 * and is hermetically testable (test/sessions.mjs). One ROW per live manager — the manager first, its
 * workers (attached via parentSessionId) to the right in stable order — then two catch-all rows:
 * orphan workers (parent absent from the input — a recycled/stopped manager) and standalone sessions
 * (no role / no parent — plain human sessions, platform leads).
 *
 * COMPANION EXCLUSION (load-bearing security invariant): assistant-role (companion) sessions are
 * dropped HERE, at the grouping source, so a companion can never surface as a pty tile + STDIN
 * Composer in ANY sub-list (manager row, orphan, or standalone). A companion is driven ONLY through
 * its chat surface (/companion). The Terminals page ALSO excludes them upstream at `live` (so they
 * stay out of the project dropdown + counts); this in-function guard is the belt to that suspenders —
 * feed this a companion and it still emits no row for it.
 */
export function groupSessionRows<T extends SessionRowMember>(sessions: readonly T[]): SessionRowGroup<T>[] {
  const shown = sessions.filter((s) => s.role !== "assistant").slice().sort(byManagerThenCreated);
  const managers = shown.filter((s) => s.role === "manager");
  const managerIds = new Set(managers.map((m) => m.id));
  const workersByParent = new Map<string, T[]>();
  const orphans: T[] = [];
  const standalone: T[] = [];
  for (const s of shown) {
    if (s.role === "manager") continue;
    const pid = s.parentSessionId ?? null;
    if (s.role === "worker" || pid) {
      if (pid && managerIds.has(pid)) (workersByParent.get(pid) ?? workersByParent.set(pid, []).get(pid)!).push(s);
      else orphans.push(s); // parent stopped/recycled or not a live manager — don't drop it
    } else standalone.push(s); // no role / platform lead — its own trailing row
  }
  // `managers` is already in stable createdAt/id order (from `shown`), so the rows are too — no
  // re-sort, and a row holds its slot regardless of activity. Nested workers + the catch-all rows
  // use the same shared stable key (byCreatedStable) so nothing reshuffles on a poll.
  const managerRows: SessionRowGroup<T>[] = managers
    .map((m) => ({ key: m.id, kind: "manager" as const, list: [m, ...(workersByParent.get(m.id) ?? []).slice().sort(byCreatedStable)] }));
  const trailing: SessionRowGroup<T>[] = [];
  if (orphans.length) trailing.push({ key: "__orphans", kind: "orphans", list: orphans.slice().sort(byCreatedStable) });
  if (standalone.length) trailing.push({ key: "__standalone", kind: "standalone", list: standalone.slice().sort(byCreatedStable) });
  return [...managerRows, ...trailing];
}
