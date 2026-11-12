// The worker LANE RAIL on a manager's session node (card dd5c8724, owner pick "C · Lane rail").
// Pure derivations over data the web already holds (`["allSessions"]`, `["orchEvents", managerId]`,
// `["gates-active"]`), so test/worker-lanes.mjs imports the real functions. No daemon change.
//
// @decision dd5c8724 — the track is inferred web-side and cannot see pre-recycle reports or in-turn
// activity; never present it as authoritative. Mapping and limits: `workerLaneStep` below.
import type { GateRun, OrchestrationEvent, SessionListItem } from "@loom/shared";
import { contextWindowForModel, CONTEXT_WARN_RATIO } from "@loom/shared";
import { hasPendingMergeRequest } from "./cardWorker";
import type { Tone } from "../theme";

export type LaneStep = "dispatched" | "working" | "reported" | "review" | "merging";

/** Render order of the track, and the single source of it. */
export const LANE_STEPS: readonly LaneStep[] = ["dispatched", "working", "reported", "review", "merging"];

export const LANE_STEP_LABEL: Record<LaneStep, string> = {
  dispatched: "Dispatched",
  working: "Working",
  reported: "Reported",
  review: "Review",
  merging: "Merging",
};

/** The fields of a session row the lane reads. Narrowed so a test can build one by hand. */
export type LaneWorker = Pick<SessionListItem, "id" | "processState" | "busy" | "createdAt"> &
  Partial<Pick<SessionListItem,
    "taskId" | "turnSeq" | "ctxTurns" | "rateLimitedUntil" | "pendingMerge" | "ctxInputTokens" | "model" |
    "role" | "parentSessionId" | "archivedAt" | "agentName" | "branch">>;

export interface LaneReport {
  status: string;
  summary: string | null;
  needs: string | null;
  ts: string;
}

/** The newest `worker_report` this worker filed on the manager's stream, or null. */
export function latestWorkerReport(events: readonly OrchestrationEvent[] | undefined, workerId: string): LaneReport | null {
  if (!events) return null;
  let best: OrchestrationEvent | null = null;
  for (const e of events) {
    if (e.kind !== "worker_report" || e.workerSessionId !== workerId) continue;
    if (!best || Date.parse(e.ts) >= Date.parse(best.ts)) best = e;
  }
  if (!best) return null;
  const d = best.detail ?? {};
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return { status: str(d.status) ?? "", summary: str(d.summary), needs: str(d.needs), ts: best.ts };
}

function isLiveish(w: Pick<LaneWorker, "processState">): boolean {
  return w.processState === "live" || w.processState === "starting";
}

function mergeRunning(w: LaneWorker): boolean {
  return w.pendingMerge?.state === "running";
}

/**
 * Where the worker is on the track. The FIRST rule that holds wins:
 *   merging     its `pendingMerge` op is still running (queued for a lane, or holding one);
 *   review      its manager filed a merge request that is still pending (`hasPendingMergeRequest`);
 *   reported    its latest `worker_report` is `done` and it is not running a turn;
 *   working     it is running a turn, OR it has filed any report, OR it has completed a turn;
 *   dispatched  none of those: spawned, with no turn and no report yet.
 * What it cannot know is listed in docs/decisions/dd5c8724-worker-lane-rail.md.
 */
export function workerLaneStep(w: LaneWorker, ctx: { report: LaneReport | null; reviewPending: boolean }): LaneStep {
  if (mergeRunning(w)) return "merging";
  if (ctx.reviewPending) return "review";
  if (ctx.report?.status === "done" && !w.busy) return "reported";
  if (w.busy || ctx.report || (w.turnSeq ?? 0) > 0 || (w.ctxTurns ?? 0) > 0) return "working";
  return "dispatched";
}

export type LaneStatusKey =
  | "exited" | "rate-limited" | "merging" | "merge-queued" | "review" | "blocked" | "working" | "starting" | "idle";

export interface LaneStatus {
  key: LaneStatusKey;
  tone: Tone;
  label: string;
  /** Sort rank: the lanes that need a look first. */
  rank: number;
}

const STATUS: Record<Exclude<LaneStatusKey, "exited">, Omit<LaneStatus, "key">> = {
  review: { tone: "attn", label: "awaiting review", rank: 0 },
  blocked: { tone: "attn", label: "blocked", rank: 1 },
  "rate-limited": { tone: "danger", label: "rate-limited", rank: 2 },
  merging: { tone: "work", label: "merging", rank: 3 },
  "merge-queued": { tone: "muted", label: "merge queued", rank: 3 },
  working: { tone: "work", label: "working", rank: 4 },
  starting: { tone: "muted", label: "starting", rank: 5 },
  idle: { tone: "live", label: "idle", rank: 6 },
};

/**
 * The lane's ONE status pill. Precedence (first wins):
 *   not running (its processState, muted) › rate-limited › merging / merge queued › awaiting review ›
 *   blocked (latest report `blocked` and no turn running since) › working › starting › idle.
 *
 * Two deliberate departures from plan.md's draft order: a session that is no longer running reads as
 * that first (a dead process is not "rate-limited", and the board's own worker pill puts it first too),
 * and a RUNNING merge gate beats "awaiting review", because the merge request stays the latest merge
 * event for the whole gate run — without this a merging worker would read as still waiting for review.
 */
export function workerLaneStatus(w: LaneWorker, ctx: { report: LaneReport | null; reviewPending: boolean; now: number }): LaneStatus {
  if (!isLiveish(w)) return { key: "exited", tone: "muted", label: w.processState || "exited", rank: 7 };
  const limited = w.rateLimitedUntil ? Date.parse(w.rateLimitedUntil) : NaN;
  const pick = (key: Exclude<LaneStatusKey, "exited">): LaneStatus => ({ key, ...STATUS[key] });
  if (Number.isFinite(limited) && limited > ctx.now) return pick("rate-limited");
  if (mergeRunning(w)) return pick(w.pendingMerge?.gatePhase === "queued" ? "merge-queued" : "merging");
  if (ctx.reviewPending) return pick("review");
  if (ctx.report?.status === "blocked" && !w.busy) return pick("blocked");
  if (w.busy) return pick("working");
  if (w.processState === "starting") return pick("starting");
  return pick("idle");
}

/** A gate the lane shows a live timer for: the worker's own merge gate, or its `run_gate` self-check. */
export interface LaneGate {
  kind: "merge" | "self-check";
  phase: "queued" | "running";
  /** ISO anchor for the elapsed clock. */
  since: string;
}

/**
 * The worker's gate, if any. A running merge wins over a self-check. Only a REAL self-check counts: the
 * ungated-landing safety net and the dist-importer advisory also ride `gateType:"worker"`, but neither
 * is the worker's own check.
 */
export function workerLaneGate(w: LaneWorker, gates: readonly GateRun[] | undefined): LaneGate | null {
  const pm = w.pendingMerge;
  if (pm && pm.state === "running") {
    return { kind: "merge", phase: pm.gatePhase === "queued" ? "queued" : "running", since: pm.startedAt };
  }
  const g = gates?.find((r) => r.gateType === "worker" && r.sessionId === w.id && !r.landingCheckOnly && !r.distImporterCheckOnly);
  return g ? { kind: "self-check", phase: g.phase, since: g.since } : null;
}

/** Context occupancy as a whole percent, plus whether it is past the warn ratio; null when unmeasured. */
export function workerLaneCtx(w: Pick<LaneWorker, "ctxInputTokens" | "model">): { pct: number; warn: boolean } | null {
  const ctx = w.ctxInputTokens ?? 0;
  if (ctx <= 0) return null;
  const window = contextWindowForModel(w.model ?? undefined);
  if (window <= 0) return null;
  return { pct: Math.min(100, Math.round((ctx / window) * 100)), warn: ctx > window * CONTEXT_WARN_RATIO };
}

export interface WorkerLane<W extends LaneWorker = LaneWorker> {
  worker: W;
  status: LaneStatus;
  step: LaneStep;
  report: LaneReport | null;
  reviewPending: boolean;
  gate: LaneGate | null;
}

/** This manager's workers off the shared session feed. Archived rows are not lanes. */
export function managerWorkers<W extends LaneWorker>(sessions: readonly W[] | undefined, managerId: string): W[] {
  return (sessions ?? []).filter((s) => s.role === "worker" && s.parentSessionId === managerId && !s.archivedAt);
}

/** Every lane, sorted so the ones that need a look are on top; ties keep the oldest dispatch first. */
export function buildWorkerLanes<W extends LaneWorker>(
  workers: readonly W[],
  events: readonly OrchestrationEvent[] | undefined,
  gates: readonly GateRun[] | undefined,
  now: number,
): WorkerLane<W>[] {
  const lanes = workers.map((worker) => {
    const report = latestWorkerReport(events, worker.id);
    const reviewPending = hasPendingMergeRequest(events, { id: worker.id, taskId: worker.taskId, processState: worker.processState });
    return {
      worker,
      report,
      reviewPending,
      status: workerLaneStatus(worker, { report, reviewPending, now }),
      step: workerLaneStep(worker, { report, reviewPending }),
      gate: workerLaneGate(worker, gates),
    };
  });
  return lanes.sort((a, b) => a.status.rank - b.status.rank
    || Date.parse(a.worker.createdAt) - Date.parse(b.worker.createdAt));
}

export type FinishedOutcome = "merged" | "stopped" | "exited";

export interface FinishedWorker {
  workerSessionId: string;
  taskId: string | null;
  outcome: FinishedOutcome;
  ts: string;
}

const FINISH_KINDS: Partial<Record<string, FinishedOutcome>> = {
  merge_done: "merged",
  stop_worker: "stopped",
  worker_exited_without_report: "exited",
};

/**
 * The "Finished this hour" footer: each worker's LATEST finishing event (merge_done / stop_worker /
 * worker_exited_without_report) inside the window, newest first. A worker that still has a lane is
 * skipped, so a stop that is still settling never shows twice. Built from this manager's own stream, so
 * it is this manager's history, not a cross-manager archive.
 */
export function finishedRecently(
  events: readonly OrchestrationEvent[] | undefined,
  laneIds: ReadonlySet<string>,
  now: number,
  windowMs = 60 * 60 * 1000,
): FinishedWorker[] {
  const latest = new Map<string, FinishedWorker>();
  for (const e of events ?? []) {
    const outcome = FINISH_KINDS[e.kind];
    const id = e.workerSessionId;
    if (!outcome || !id || laneIds.has(id)) continue;
    const t = Date.parse(e.ts);
    if (!Number.isFinite(t) || now - t > windowMs || t > now + 60_000) continue;
    const cur = latest.get(id);
    if (!cur || Date.parse(cur.ts) <= t) latest.set(id, { workerSessionId: id, taskId: e.taskId ?? null, outcome, ts: e.ts });
  }
  return [...latest.values()].sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
}

/** A compact elapsed reading: `40s`, `9m`, `1h 12m`, `3d 4h`. Negative or unparseable → null. */
export function formatElapsed(fromIso: string | null | undefined, now: number): string | null {
  if (!fromIso) return null;
  const t = Date.parse(fromIso);
  if (!Number.isFinite(t)) return null;
  const s = Math.floor((now - t) / 1000);
  if (s < 0) return null;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${String(m % 60).padStart(2, "0")}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** A gate's live timer, `M:SS` (minutes uncapped, like the board's merge meter). */
export function formatGateTimer(sinceIso: string, now: number): string {
  const t = Date.parse(sinceIso);
  const secs = Number.isFinite(t) ? Math.max(0, Math.floor((now - t) / 1000)) : 0;
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
}
