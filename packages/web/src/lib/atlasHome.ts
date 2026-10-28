// Derivations shared by the two Atlas home nodes — the Workspace root and the project node
// (card fd99b2d7, Atlas build plan P2-1: docs/plans/atlas-ui/03-decomposition.md).
//
// ⛔ Every figure below is COMPOSED CLIENT-SIDE from calls `lib/api.ts` already exposes, per the
// plan's one hard rule (docs/plans/atlas-ui/02-architecture.md): Atlas is a new presentation layer
// over the existing data layer, never a parallel one. No `api.ts` member was added for this card.
//
// Pure functions here, hooks at the bottom. The split is the point: a figure a KPI tile shows and
// the pop-over's own breakdown of that same figure are derived by ONE function, so the headline and
// the detail behind it can never disagree.
import { useQuery } from "@tanstack/react-query";
import type { GateHistoryRow, GateRun, GatesActive, KanbanColumn, SessionListItem } from "@loom/shared";
import { api } from "./api";
import { isCompanionSession } from "./sessions";

/** Live for fleet-counting purposes — `starting` counts, matching AtlasTree's own live marker. */
export function isLiveSession(s: SessionListItem): boolean {
  return s.processState === "live" || s.processState === "starting";
}

// ── Board roll-up ──────────────────────────────────────────────────────────────────────────────
// Keyed off each column's lifecycle ROLE, never its key or its label: a board can rename, reorder
// or drop a lane (Settings' ColumnManager), and a key-matching roll-up would then silently report
// zero for a lane that is right there on screen. `role` is the same input `columnKeyForRole`
// (packages/shared/src/config.ts) resolves the daemon's own lifecycle moves through.

export interface BoardLane {
  key: string;
  label: string;
  count: number;
  role: KanbanColumn["role"];
  accentColor?: string;
}

export interface BoardRollup {
  /** Cards in a non-terminal lane — "open cards". */
  open: number;
  /** Cards in the `review` lane. */
  inReview: number;
  /** Cards in the `parked` lane — the ones waiting on a human, not on a worker. */
  waiting: number;
  total: number;
  lanes: BoardLane[];
}

export function boardRollup(
  columns: readonly KanbanColumn[] | undefined,
  tasks: readonly { columnKey: string }[] | undefined,
): BoardRollup {
  const cols = columns ?? [];
  const rows = tasks ?? [];
  const counts = new Map<string, number>();
  for (const t of rows) counts.set(t.columnKey, (counts.get(t.columnKey) ?? 0) + 1);
  const lanes: BoardLane[] = cols.map((c) => ({
    key: c.key, label: c.label, role: c.role, accentColor: c.accentColor, count: counts.get(c.key) ?? 0,
  }));
  let open = 0, inReview = 0, waiting = 0;
  for (const lane of lanes) {
    if (lane.role !== "terminal") open += lane.count;
    if (lane.role === "review") inReview += lane.count;
    if (lane.role === "parked") waiting += lane.count;
  }
  return { open, inReview, waiting, total: rows.length, lanes };
}

// ── Gate lanes ─────────────────────────────────────────────────────────────────────────────────

export interface GateLanes {
  cap: number;
  running: number;
  queued: number;
  runs: GateRun[];
}

/** The live semaphore occupancy, optionally narrowed to one project. `cap` is daemon-global either
 *  way — it is the number of lanes the whole host has, never a per-project allowance, so a project
 *  reading "1 of 2" is reading its own share of a shared budget. */
export function gateLanes(active: GatesActive | undefined, projectId?: string): GateLanes {
  const runs = (active?.gates ?? []).filter((g) => !projectId || g.projectId === projectId);
  return {
    cap: active?.cap ?? 0,
    running: runs.filter((g) => g.phase === "running").length,
    queued: runs.filter((g) => g.phase === "queued").length,
    runs,
  };
}

// ── Merge throughput ───────────────────────────────────────────────────────────────────────────

export interface MergeThroughput {
  /** BRANCHES landed today, not gate RUNS — a batched merge lands `branchCount` of them at once. */
  branches: number;
  /** Distinct projects contributing, for the workspace tile's sub-line. */
  projects: number;
  /** `endedAt` of the most recent landing, for a "last Xm ago" sub-line. */
  lastEndedAt: string | null;
  /** One bar per day, oldest-first — the band panel's sparkline. */
  byDay: { day: string; branches: number }[];
}

const DAY_MS = 86_400_000;
/** Local midnight N days back, as the `YYYY-MM-DD` key the series is bucketed by. */
const dayKey = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

/**
 * Landings derived from the settled gate history. Counts only `merge` gates that actually PASSED —
 * `cancelled` / `skipped` / `error` are explicitly non-verdicts (see `GateOutcome`'s own doc in
 * packages/shared/src/types.ts) and must never be counted as a landing.
 *
 * `days` bounds the sparkline window; "today" is always the last bucket. The caller's own fetch
 * bounds how far back the rows reach, so a short history simply yields short bars, never a wrong
 * total for today.
 */
export function mergeThroughput(rows: readonly GateHistoryRow[] | undefined, days = 14): MergeThroughput {
  const now = Date.now();
  const series: { day: string; branches: number }[] = [];
  const index = new Map<string, number>();
  for (let i = days - 1; i >= 0; i--) {
    const key = dayKey(now - i * DAY_MS);
    index.set(key, series.length);
    series.push({ day: key, branches: 0 });
  }
  const today = dayKey(now);
  const projects = new Set<string>();
  let branches = 0;
  let lastEndedAt: string | null = null;
  for (const r of rows ?? []) {
    if (r.gateType !== "merge" || r.outcome !== "pass") continue;
    // A batched landing is N branches in one run; `branchCount` is the POST-assembly landed count.
    const landed = r.batched ? (r.branchCount ?? 1) : 1;
    const key = dayKey(Date.parse(r.endedAt));
    const slot = index.get(key);
    const bucket = slot === undefined ? undefined : series[slot];
    if (bucket) bucket.branches += landed;
    if (key !== today) continue;
    branches += landed;
    if (r.projectName) projects.add(r.projectName);
    if (!lastEndedAt || Date.parse(r.endedAt) > Date.parse(lastEndedAt)) lastEndedAt = r.endedAt;
  }
  return { branches, projects: projects.size, lastEndedAt, byDay: series };
}

/** The most recent landing per project, for the Workspace deck's project cards — read off the SAME
 *  cross-project history page the KPI tile reads, so a project row costs no request of its own. */
export function lastMergeByProject(rows: readonly GateHistoryRow[] | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const r of rows ?? []) {
    if (r.gateType !== "merge" || r.outcome !== "pass" || !r.projectId) continue;
    const prev = out.get(r.projectId);
    if (!prev || Date.parse(r.endedAt) > Date.parse(prev)) out.set(r.projectId, r.endedAt);
  }
  return out;
}

// ── Formatting ─────────────────────────────────────────────────────────────────────────────────

/** "11m ago" / "2h 5m ago" / "just now" — the same coarse grammar the Gates page's history rows use. */
export function relativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  const sec = Math.max(0, Math.floor((now - ms) / 1000));
  if (sec < 45) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return min % 60 > 0 ? `${hr}h ${min % 60}m ago` : `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/** "n thing" / "n things" — small enough that a dependency would cost more than it saves. */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

// ── Shared reads ───────────────────────────────────────────────────────────────────────────────
// Both hooks reuse an EXISTING cache key where one exists, so an Atlas home adds no second poll of
// something another page already watches.

/** `["gates-active"]` — the SAME entry pages/Gates.tsx fills, so opening Gates from here is warm. */
export function useGatesActive() {
  return useQuery({ queryKey: ["gates-active"], queryFn: api.gatesActive, refetchInterval: 4000 });
}

/**
 * One bounded page of settled gate history. A SEPARATE entry from the Gates page's own
 * `["gates-history", filter]`: that one is an infinite query whose pages accumulate behind a
 * user-driven "load more", and borrowing it would make a home node's figure depend on how far
 * someone had scrolled a different page.
 */
export function useGateHistoryRecent(projectId?: string) {
  return useQuery({
    queryKey: ["gates-history-recent", projectId ?? null],
    queryFn: () => api.gatesHistory({ projectId, limit: 200 }),
    refetchInterval: 15_000,
  });
}

/** Live, non-companion sessions per project id — the same exclusion AtlasTree's row marker makes. */
export function liveCountsByProject(sessions: readonly SessionListItem[] | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const s of sessions ?? []) {
    if (isCompanionSession(s) || !isLiveSession(s)) continue;
    counts.set(s.projectId, (counts.get(s.projectId) ?? 0) + 1);
  }
  return counts;
}

