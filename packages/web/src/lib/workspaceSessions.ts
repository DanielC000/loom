import type { SessionListItem } from "@loom/shared";
import { isLiveSession } from "./atlasHome";
import { byManagerThenCreated, isCompanionSession } from "./sessions";

// The derivation behind the Workspace node's "Sessions" card (card 9b6be377, the owner's Atlas
// feedback item: `"Workspace": Add "Sessions" card with all running session terminals`).
//
// Pure and dependency-free so it can be asserted on plain objects — pages/WorkspaceHome.tsx holds
// the render and nothing else, and test/workspace-sessions.mjs imports THESE functions rather than
// a copy of their rules.

/**
 * Every running session the card lists, in render order.
 *
 * 🔴 THE POPULATION IS THE `live sessions` KPI TILE'S OWN, NOT A WIDER ONE. WorkspaceHome derives
 * that tile from `sessions.filter(!isCompanionSession).filter(isLiveSession)` and the Atlas tree's
 * live marker uses the same pair — so this card reads the identical set. A card listing a different
 * population would state a count ~200px below a tile stating another, on one screen, for the same
 * words ("live"/"running"); that disagreement is the defect, not the extra rows.
 *
 * Excluding companions is ALSO the companion guard (card 5c87f4b6): a companion is driven only
 * through its chat surface, never a raw pty + stdin Composer, and pages/Terminals.tsx filters them
 * at the same source for the same reason. The card's own footer names where they live instead, so
 * the omission is stated rather than silent.
 */
export function workspaceRunningSessions(
  sessions: readonly SessionListItem[] | undefined,
): SessionListItem[] {
  return (sessions ?? [])
    .filter((s) => !isCompanionSession(s) && isLiveSession(s))
    .slice()
    .sort(byProjectThenManager);
}

/**
 * Render order: project name first, then the SHARED within-project order.
 *
 * Project-major because this is the app's only cross-project terminal list — adjacency by project
 * answers "and where" without the card paying for a header row per project. Within a project it
 * DELEGATES to `byManagerThenCreated` (lib/sessions.ts), the same stable order the classic Terminals
 * page and the project Overview grid use, so a session cannot hold one slot there and another here —
 * which also keeps `busy`/`lastActivity` out of the ordering, so no row jumps on a poll.
 *
 * `localeCompare` at `sensitivity: "base"`, the collation lib/projectOrder.ts settled on: a raw `<`
 * on UTF-16 code units sorts every capitalised project ahead of every lowercase one.
 */
export function byProjectThenManager(a: SessionListItem, b: SessionListItem): number {
  const byName = a.projectName.localeCompare(b.projectName, undefined, { sensitivity: "base" });
  if (byName !== 0) return byName;
  // Two DIFFERENT projects sharing a display name must not interleave their sessions — the id
  // breaks it, so each project's block stays whole and in a stable place between renders.
  if (a.projectId !== b.projectId) return a.projectId < b.projectId ? -1 : 1;
  return byManagerThenCreated(a, b);
}

/**
 * Which row's terminal is mounted after a click on `clicked` — AT MOST ONE, ever.
 *
 * ⛔ This single-mount rule is the card's whole performance contract, not a preference. CLAUDE.md:
 * a page mounting live terminals is heavy and the cockpit's renderer has frozen on one. Each mount
 * is a real `/ws/term` attach plus an xterm instance, so N rows expanded at once is N of both. The
 * card therefore mounts NOTHING at rest and exactly one terminal when a reader asks for one;
 * clicking the open row closes it, and clicking another MOVES the mount rather than adding a second.
 *
 * Returning `null` for a re-click (rather than keeping it open) is what makes the mount releasable
 * without navigating away.
 */
export function toggleExpandedSession(current: string | null, clicked: string): string | null {
  return current === clicked ? null : clicked;
}

/**
 * The expansion, re-resolved against the CURRENT running set — `null` once that session is gone.
 *
 * A session the reader expanded can exit, be stopped, or be archived while its terminal is on
 * screen; `["allSessions"]` then stops listing it and its row disappears from under the mount. Left
 * unresolved, the card would keep an xterm attached to a dead pty with no row left to collapse it
 * from — a leak the reader has no control over, which is the opposite of the single-mount contract
 * above. Deriving the mount through this on every render means the expansion cannot outlive its row.
 */
export function liveExpandedSession(
  current: string | null,
  rows: readonly { id: string }[],
): string | null {
  if (current === null) return null;
  return rows.some((r) => r.id === current) ? current : null;
}

/**
 * Whether an expanded row has a pty to show yet.
 *
 * `workspaceRunningSessions` lists `starting` rows too — it has to, because the `live sessions` KPI
 * tile counts them (`isLiveSession`) and the two must agree. But a `starting` session has no pty: the
 * `/ws/term` attach is a documented no-op over a non-existent entry, so the pane would simply draw
 * BLANK, which reads as a broken terminal rather than as a session that has not finished booting.
 * The expanded region shows a one-line note in that case instead — deliberately not a disabled
 * twist, whose reason would only be reachable by hover.
 *
 * Kept SEPARATE from `liveExpandedSession` on purpose: that one drops an expansion whose row is
 * gone, which is the real leak; folding this in too would make a `starting` row collapse itself
 * before it could ever state why it has nothing to draw.
 */
export function canMountTerminal(s: Pick<SessionListItem, "processState">): boolean {
  return s.processState === "live";
}

/** "3 running sessions across 2 projects" — the card's own footer, stating both halves of its scope. */
export function workspaceSessionsSummary(rows: readonly SessionListItem[]): string {
  const projects = new Set(rows.map((r) => r.projectId)).size;
  const s = (n: number, one: string) => `${n} ${n === 1 ? one : `${one}s`}`;
  if (rows.length === 0) return "No sessions are running.";
  return `${s(rows.length, "running session")} across ${s(projects, "project")}.`;
}
