import type { Session, ProcessState } from "@loom/shared";

// The ONE shared session ordering, applied at every session-list tier (Workspace, Terminals,
// Mission Control, Orchestration) so a session's place in a list is consistent everywhere.
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
