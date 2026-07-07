import type { OrchestrationEvent, SessionListItem } from "@loom/shared";
import type { Tone } from "../theme";

// Pure fleet roll-up math + the archived-fold policy, split out of components/fleet.tsx (which is JSX,
// so it can't be imported by the hermetic node test). The widgets import these back; test/fleet.mjs
// asserts on them directly (no React, no daemon). Kept free of RUNTIME relative imports (only type-only,
// which type-stripping erases) so the node test loads it standalone — hence isRateLimited (and the
// STUCK-BUSY heuristic below) live here too, re-exported from lib/attention for their existing consumers.

// A session parked on the account/plan rate-limit cap, with its hold not yet lapsed.
export function isRateLimited(s: SessionListItem): boolean {
  return !!s.rateLimitedUntil && new Date(s.rateLimitedUntil).getTime() > Date.now();
}

// ── STUCK-BUSY heuristic (Mission Control attention queue) ─────────────────────────────────────────────
// A session that's been `busy` with a stale `lastActivity` this long is FLAGGED — UNLESS it's legitimately
// parked: a manager supervising ≥1 live/pending worker between turns, or a session that told Loom it's
// intentionally waiting (an unexpired idle_report('waiting') snooze). Both exclusions are additive —
// narrowing the two false-positive shapes (board card a1f06bcc), not the underlying "busy a long time"
// signal, so a genuinely stuck session (no workers, no snooze) is still caught.
export const STUCK_BUSY_MS = 3 * 60_000; // busy with no activity this long → likely stuck (heuristic)

export interface StuckBusyContext {
  /** A manager currently supervising ≥1 live/pending worker — it's parked between turns, not stuck. */
  hasSupervisedWorkers?: boolean;
  /** An unexpired idle_report('waiting') snooze is in effect — the session told Loom it's intentionally parked. */
  isWaitingSnoozed?: boolean;
}

export function isStuckBusy(s: SessionListItem, ctx: StuckBusyContext = {}): boolean {
  if (ctx.hasSupervisedWorkers || ctx.isWaitingSnoozed) return false;
  return s.processState === "live" && s.busy && Date.now() - new Date(s.lastActivity).getTime() > STUCK_BUSY_MS;
}

// True when `managerId` currently has ≥1 worker that's live or starting (dispatched, not yet reporting).
// A worker's depth-1 (it never spawns workers of its own), so this is a no-op / false for a worker id.
export function hasSupervisedWorkers(managerId: string, allSessions: readonly SessionListItem[]): boolean {
  return allSessions.some((w) =>
    w.role === "worker" && w.parentSessionId === managerId && (w.processState === "live" || w.processState === "starting"));
}

// True when `e` is an idle_report recording an unexpired 'waiting' snooze — the session self-reported an
// intentional park with a window, and now is still inside that window. False for any other event kind/
// state, a missing/expired snoozeUntil, or no event at all.
export function isActiveWaitingSnooze(e: OrchestrationEvent | undefined, now: number = Date.now()): boolean {
  if (!e || e.kind !== "idle_report") return false;
  const d = (e.detail ?? {}) as { state?: string; snoozeUntil?: string };
  return d.state === "waiting" && !!d.snoozeUntil && new Date(d.snoozeUntil).getTime() > now;
}

// A compact FleetCard folds a project's ARCHIVED (exited) sessions in alongside the running set, so the
// card still reads meaningfully the moment a wave auto-archives (its workers exit → the running set
// empties, and the card would otherwise go blank). Archived rows are muted history: CAP how many feed the
// card's composition bar / offline tally so a large archive can't flood it. The header still reports the
// TRUE archived total — this cap is display-only.
export const ARCHIVED_FOLD_CAP = 6;

export function capArchived<T>(archived: readonly T[], cap = ARCHIVED_FOLD_CAP): T[] {
  return archived.slice(0, Math.max(0, cap));
}

// Roll-up status — worst-of across the project's sessions: rate-limited > busy > idle > no-live-mgr.
// Fed the LIVE (running) set only: severity should reflect live state, never a finished session (an
// exited row that was parked when archived could still carry a future rateLimitedUntil and spuriously
// paint the card red). Archived history surfaces in the buckets/header instead.
export function fleetRollup(sessions: SessionListItem[]): { tone: Tone; label: string; glow?: boolean } {
  if (sessions.some(isRateLimited)) return { tone: "red", label: "rate-limited" };
  if (sessions.some((s) => s.processState === "live" && s.busy)) return { tone: "amber", label: "busy", glow: true };
  if (sessions.some((s) => s.role === "manager" && s.processState === "live")) return { tone: "phosphor", label: "idle" };
  return { tone: "muted", label: "no live manager" };
}

// Worker-state tally for the composition bar — each worker lands in exactly one bucket. Fed the running
// workers PLUS the capped archived workers, which are exited and so land in `offline` (rendered muted).
export function workerBuckets(workers: SessionListItem[]) {
  let busy = 0, idle = 0, rl = 0, offline = 0;
  for (const w of workers) {
    if (isRateLimited(w)) rl++;
    else if (w.processState !== "live") offline++;
    else if (w.busy) busy++;
    else idle++;
  }
  return { busy, idle, rl, offline, total: workers.length };
}

// ── Inactive projects (the god-eye "finished wave" tier — surfaced to the user as "inactive") ───────────
// Mission Control builds its project list from the RUNNING session set, so a project whose sessions have
// ALL exited (auto-archived on exit) drops off the god-eye entirely. To keep a finished wave glanceable,
// surface projects present ONLY in the archived set — in archived, absent from the live set — as MUTED
// cards, rendered AFTER the live fleet so live projects always rank first and archived history can never
// crowd the active fleet. (The UI labels this tier "inactive" — distinct from the reversible soft-archive
// "Archived" section on the Workspace page, a genuinely different project state.) The derivation is O(n): a
// Set of live project names, then ONE pass over the archived rows (never O(n²) over a large archive). The
// rendered count is capped (ARCHIVED_ONLY_CAP) so a deep archive stays out of the way; the affordance still
// reports the true total.
//
// RESERVED homes are filtered out: the reserved/system projects (the "Loom Platform" / "Platform" homes)
// appear in the archive with zero live sessions, so they'd otherwise leak into this tier — but they're
// hidden from every other project surface, so they must never read as an "inactive" user project either.
// The archived-session wire shape (ArchivedSessionListItem) does NOT carry the structural `reserved` flag
// (that lives on Project, not Session), so the caller resolves reserved-ness — by the reserved-home project
// IDS it already discovers — and passes them here to exclude by projectId (a robust join key).
export const ARCHIVED_ONLY_CAP = 4;

export interface ArchivedOnlyProject { name: string; archived: SessionListItem[] }

export function archivedOnlyProjects(
  liveProjectNames: Iterable<string>,
  archived: readonly SessionListItem[],
  reservedProjectIds: Iterable<string> = [],
): ArchivedOnlyProject[] {
  const live = new Set(liveProjectNames);
  const reserved = new Set(reservedProjectIds);
  const byProject = new Map<string, SessionListItem[]>();
  for (const s of archived) {
    if (live.has(s.projectName)) continue; // still has live sessions → already in the active fleet
    if (reserved.has(s.projectId)) continue; // reserved/system home (Loom Platform / Platform) → never "inactive"
    (byProject.get(s.projectName) ?? byProject.set(s.projectName, []).get(s.projectName)!).push(s);
  }
  // Freshest finished wave first, so the most-recently-archived project reads at the top of the strip.
  return [...byProject.entries()]
    .map(([name, sessions]) => ({ name, archived: sessions }))
    .sort((a, b) => archivedRecency(b.archived) - archivedRecency(a.archived));
}

function archivedRecency(sessions: readonly SessionListItem[]): number {
  let max = -Infinity;
  for (const s of sessions) max = Math.max(max, +new Date(s.lastActivity));
  return max;
}
