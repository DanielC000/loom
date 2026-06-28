// The session/run AUDIT LOG read model — a replayable + diffable timeline over Loom's EXISTING durable
// record. There is NO new capture pipeline here: the data is the `orchestration_events` table (the
// manager↔worker timeline already written on every spawn / message / redirect / merge / restart / report /
// completion / board event) joined with `sessions` metadata. This module only READS and NORMALIZES that
// into the {@link AuditTimeline} / {@link AuditDiff} protocol shapes the human-only REST readers serve
// (and the web sibling card consumes). Pure + deterministic; the gateway routes are thin wrappers.

import type {
  OrchestrationEvent, Session, AuditEvent, AuditScope, AuditSessionRef,
  AuditTimeline, AuditDiff, AuditDiffStep, AuditKindDelta, OrchestrationEventKind,
} from "@loom/shared";

/** The narrow slice of the Db the audit read model reads — keeps the builders unit-testable against a stub. */
export interface AuditDbReads {
  getSession(id: string): Session | undefined;
  listEventsForSession(sessionId: string): OrchestrationEvent[];
  listChildSessions(parentSessionId: string): Session[];
}

/** Project a `sessions` row into the lightweight actor ref carried by a timeline. */
function toSessionRef(s: Session): AuditSessionRef {
  return {
    id: s.id, projectId: s.projectId, agentId: s.agentId,
    role: s.role ?? null, title: s.title ?? null,
    parentSessionId: s.parentSessionId ?? null, taskId: s.taskId ?? null,
    gen: s.gen ?? 0, recycledFrom: s.recycledFrom ?? null, createdAt: s.createdAt,
  };
}

/**
 * Chronological comparator for normalized events: by `ts`, then `id` (a stable, deterministic tiebreaker
 * for same-instant events across a UNION of per-session queries, where SQLite rowid order is lost). A
 * single-query timeline is already ts/rowid ordered; re-sorting by (ts, id) keeps it deterministic.
 */
function byTsThenId(a: OrchestrationEvent, b: OrchestrationEvent): number {
  if (a.ts < b.ts) return -1;
  if (a.ts > b.ts) return 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Normalize raw events into the ordered, seq-numbered {@link AuditEvent} stream + the referenced-session map. */
function assemble(db: AuditDbReads, scope: AuditScope, rootId: string, raw: OrchestrationEvent[]): AuditTimeline {
  const ordered = [...raw].sort(byTsThenId);
  const events: AuditEvent[] = ordered.map((e, seq) => ({
    id: e.id, seq, ts: e.ts, kind: e.kind,
    managerSessionId: e.managerSessionId,
    workerSessionId: e.workerSessionId ?? null,
    taskId: e.taskId ?? null,
    detail: e.detail ?? null,
  }));
  // Build the actor lookup: every session id referenced as a manager or worker, resolved once.
  const sessions: Record<string, AuditSessionRef> = {};
  for (const e of events) {
    for (const id of [e.managerSessionId, e.workerSessionId]) {
      if (id && !(id in sessions)) {
        const s = db.getSession(id);
        if (s) sessions[id] = toSessionRef(s);
      }
    }
  }
  return {
    scope, rootId, sessions, events, eventCount: events.length,
    firstTs: events.length ? events[0]!.ts : null,
    lastTs: events.length ? events[events.length - 1]!.ts : null,
  };
}

/**
 * The replayable timeline for ONE session: every event where it is the manager OR the worker, in order.
 * Returns null when the session id is unknown (the caller maps that to a 404). Built over
 * `orchestration_events` (via listEventsForSession) + `sessions` (for the actor refs).
 */
export function buildSessionTimeline(db: AuditDbReads, sessionId: string): AuditTimeline | null {
  if (!db.getSession(sessionId)) return null;
  return assemble(db, "session", sessionId, db.listEventsForSession(sessionId));
}

/**
 * The replayable timeline for a whole orchestration WAVE — the manager session plus all its (incl.
 * archived) workers — de-duplicated by event id. Most wave events are already filed under the manager,
 * but worker-keyed ones (queued messages whose recipient is a worker, a worker's crash event) are picked
 * up by unioning each worker's own touch-set. Returns null when the manager id is unknown.
 */
export function buildWaveTimeline(db: AuditDbReads, managerSessionId: string): AuditTimeline | null {
  if (!db.getSession(managerSessionId)) return null;
  const ids = [managerSessionId, ...db.listChildSessions(managerSessionId).map((c) => c.id)];
  const seen = new Set<string>();
  const raw: OrchestrationEvent[] = [];
  for (const id of ids) {
    for (const e of db.listEventsForSession(id)) {
      if (!seen.has(e.id)) { seen.add(e.id); raw.push(e); }
    }
  }
  return assemble(db, "wave", managerSessionId, raw);
}

/**
 * An event's diff SIGNATURE — its `kind` plus a small OUTCOME discriminator drawn from the durable detail
 * (the first present of `status` / `reason` / `action`, e.g. `worker_report:done`, `merge_rejected`,
 * `manager_manage:assign_profile`). So a changed outcome (done→blocked) aligns as removed+added rather
 * than a spurious "same", which is exactly the "what changed in the outcomes" the diff is for.
 */
export function signatureOf(e: AuditEvent): string {
  const d = e.detail ?? {};
  const disc = [d.status, d.reason, d.action].find((v) => typeof v === "string" && v.length > 0);
  return disc ? `${e.kind}:${disc}` : e.kind;
}

/**
 * Defensive bound on the LCS DP table (cells = |a| × |b|). Orchestration waves hold dozens of events, so
 * this is never hit in practice; it caps memory on a pathological pair (the timelines fall back to a
 * cheaper positional alignment beyond it rather than allocating an enormous table).
 */
const LCS_CELL_CAP = 4_000_000; // ~2000 × 2000

/**
 * Longest-common-subsequence alignment of two signature streams → ordered same/added/removed ops. Standard
 * O(n·m) DP + backtrack, emitting indices into A and B in replay order. Beyond {@link LCS_CELL_CAP} cells
 * it degrades to a positional zip (pairwise same/changed by index, surplus added/removed) — still ordered,
 * just not minimal.
 */
function alignBySignature(aSigs: string[], bSigs: string[]): Array<{ op: "same" | "added" | "removed"; ai: number; bi: number }> {
  const n = aSigs.length, m = bSigs.length;
  const out: Array<{ op: "same" | "added" | "removed"; ai: number; bi: number }> = [];
  if (n * m > LCS_CELL_CAP) {
    const k = Math.min(n, m);
    for (let i = 0; i < k; i++) {
      if (aSigs[i] === bSigs[i]) out.push({ op: "same", ai: i, bi: i });
      else { out.push({ op: "removed", ai: i, bi: -1 }); out.push({ op: "added", ai: -1, bi: i }); }
    }
    for (let i = k; i < n; i++) out.push({ op: "removed", ai: i, bi: -1 });
    for (let i = k; i < m; i++) out.push({ op: "added", ai: -1, bi: i });
    return out;
  }
  // dp[i][j] = LCS length of aSigs[i..] and bSigs[j..]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = aSigs[i] === bSigs[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (aSigs[i] === bSigs[j]) { out.push({ op: "same", ai: i, bi: j }); i++; j++; }
    else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) { out.push({ op: "removed", ai: i, bi: -1 }); i++; }
    else { out.push({ op: "added", ai: -1, bi: j }); j++; }
  }
  while (i < n) { out.push({ op: "removed", ai: i, bi: -1 }); i++; }
  while (j < m) { out.push({ op: "added", ai: -1, bi: j }); j++; }
  return out;
}

/** Per-kind count map for a timeline's events (the outcomes roll-up input). */
function countByKind(events: AuditEvent[]): Map<OrchestrationEventKind, number> {
  const m = new Map<OrchestrationEventKind, number>();
  for (const e of events) m.set(e.kind, (m.get(e.kind) ?? 0) + 1);
  return m;
}

/**
 * A pragmatic structured diff of two audit timelines (two sessions, or a run vs its predecessor): the
 * SEQUENCE alignment (LCS by signature → ordered same/added/removed steps) plus the OUTCOMES view
 * (per-kind count deltas). Pure — operates on two already-built {@link AuditTimeline}s.
 */
export function diffTimelines(a: AuditTimeline, b: AuditTimeline): AuditDiff {
  const aSigs = a.events.map(signatureOf);
  const bSigs = b.events.map(signatureOf);
  const aligned = alignBySignature(aSigs, bSigs);
  const steps: AuditDiffStep[] = aligned.map((s) => ({
    op: s.op,
    signature: s.ai >= 0 ? aSigs[s.ai]! : bSigs[s.bi]!,
    a: s.ai >= 0 ? a.events[s.ai]! : null,
    b: s.bi >= 0 ? b.events[s.bi]! : null,
  }));

  const aCounts = countByKind(a.events);
  const bCounts = countByKind(b.events);
  const kinds = [...new Set([...aCounts.keys(), ...bCounts.keys()])].sort();
  const kindDeltas: AuditKindDelta[] = kinds.map((kind) => {
    const av = aCounts.get(kind) ?? 0;
    const bv = bCounts.get(kind) ?? 0;
    return { kind, a: av, b: bv, delta: bv - av };
  });

  const sameCount = steps.filter((s) => s.op === "same").length;
  const addedCount = steps.filter((s) => s.op === "added").length;
  const removedCount = steps.filter((s) => s.op === "removed").length;
  return {
    a: { rootId: a.rootId, scope: a.scope, eventCount: a.eventCount },
    b: { rootId: b.rootId, scope: b.scope, eventCount: b.eventCount },
    steps, kindDeltas,
    summary: { sameCount, addedCount, removedCount, changed: addedCount + removedCount > 0 },
  };
}

/**
 * Build a timeline for either scope — the gateway's single entry point. Returns null when the root session
 * id is unknown (→ 404). `scope:"wave"` keys on a manager session; `scope:"session"` on any session.
 */
export function buildTimeline(db: AuditDbReads, scope: AuditScope, rootId: string): AuditTimeline | null {
  return scope === "wave" ? buildWaveTimeline(db, rootId) : buildSessionTimeline(db, rootId);
}
