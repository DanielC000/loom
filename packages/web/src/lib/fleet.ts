import type { SessionListItem } from "@loom/shared";
import type { Tone } from "../theme";

// Pure fleet roll-up math + the archived-fold policy, split out of components/fleet.tsx (which is JSX,
// so it can't be imported by the hermetic node test). The widgets import these back; test/fleet.mjs
// asserts on them directly (no React, no daemon). Kept free of RUNTIME relative imports (only type-only,
// which type-stripping erases) so the node test loads it standalone — hence isRateLimited lives here too,
// re-exported from lib/attention for its existing consumers.

// A session parked on the account/plan rate-limit cap, with its hold not yet lapsed.
export function isRateLimited(s: SessionListItem): boolean {
  return !!s.rateLimitedUntil && new Date(s.rateLimitedUntil).getTime() > Date.now();
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
