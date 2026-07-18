import type { OrchestrationEvent, OrchestrationEventKind, PendingMerge, SessionListItem, SessionRole } from "./types.js";

// Wire protocol shared by daemon and web.
//
// Terminal WebSocket  (/ws/term/:sessionId):
//   server -> client: BINARY frames = raw pty bytes; TEXT frames = JSON TerminalControl
//   client -> server: TEXT frames = JSON TerminalInput
// Claude ptys are pinned to a fixed geometry (viewers scale by font size); only SHELL terminals
// negotiate size — a `resize` from the viewer is honored for shells and ignored for Claude ptys
// (the alt-screen repaint invariant). See ShellTerminal below.

export type TerminalControl =
  | { type: "sessionId"; id: string }   // engine session id captured/known
  | { type: "reset" }                   // pty respawned (resume) — clear xterm
  | { type: "busy"; busy: boolean }     // a turn started (true) / ended (false) — hook-driven
  | { type: "exit"; code: number | null }
  | { type: "dead" }                    // stored engine id no longer resumable
  // INFO ONLY: the daemon telling a viewer the pinned pty grid so it can size its xterm
  // (resize the grid to match + scale fontSize to fill the tile). This is NOT resize
  // negotiation — the viewer never resizes the pty; the pin stays viewer-independent.
  | { type: "geometry"; cols: number; rows: number };

export type TerminalInput =
  | { type: "stdin"; data: string }
  | { type: "repaint" }                 // force Ctrl-L repaint (tearing mitigation)
  | { type: "resize"; cols: number; rows: number }; // SHELL terminals only — fit the pty to the pane

/**
 * A plain interactive SHELL terminal (pwsh/cmd/bash) the HUMAN spawned in a project's repo cwd from
 * the Terminals page — NOT a Claude session (no agent, engine id, role, busy, or resumability). Lives
 * in-memory in PtyHost; this is the listing shape for the web to re-attach after a detach/reload. See
 * the trust-boundary note on POST /api/terminals: spawning a shell is host-RCE-by-design, so it is a
 * HUMAN-ONLY REST endpoint and deliberately NOT exposed as an MCP tool.
 */
export interface ShellTerminal {
  id: string;
  cwd: string;
  command: string;
  label: string;
  alive: boolean;
}

// REST DTOs (subset; expanded during the build).
export interface SpawnSessionRequest {
  projectId: string;
  agentId: string;
  /** Omit to resume; present to start a NEW session (the agent's startup prompt). */
  startNew: boolean;
}

export interface ResumeSessionRequest {
  sessionId: string;
}

export type StopMode = "graceful" | "hard";
export interface StopSessionRequest {
  sessionId: string;
  mode: StopMode;
}

// ── Plan-usage status (GET /api/usage/limits) ──────────────────────────────────
// The user's REAL Claude *account/plan* usage (rate-limit headroom), fetched daemon-side from the
// undocumented OAuth usage endpoint and cached. DISTINCT from Loom's /usage page (context occupancy
// per session). Camel-cased here to match the rest of the REST DTOs; the raw endpoint is snake_case.

/** One usage window: `utilization` is 0–100; `resetsAt` is an ISO-8601 instant or null (no active reset). */
export interface UsageWindow {
  utilization: number;
  resetsAt: string | null;
}

/** Extra-usage (paid overflow) balance — only meaningful when `isEnabled`. */
export interface UsageExtra {
  isEnabled: boolean;
  monthlyLimit: number | null;
  usedCredits: number | null;
  utilization: number | null; // 0–100, null when not yet metered
}

/**
 * The parsed, cached plan-usage status. `available:false` is the graceful-degrade state (no token,
 * expired, network/HTTP error, schema drift) — Mission Control renders a muted note, never an error.
 */
export type UsageLimitsStatus =
  | {
      available: true;
      fetchedAt: string; // ISO — when this snapshot was fetched
      fiveHour: UsageWindow;
      sevenDay: UsageWindow;
      sevenDayOpus: UsageWindow | null;
      sevenDaySonnet: UsageWindow | null;
      extraUsage: UsageExtra | null;
    }
  | {
      available: false;
      reason: string;
      fetchedAt: string | null; // ISO of the last attempt, null if never tried
    };

// ── Historical run-usage aggregation (GET /api/usage/history) ──────────────────────────────────
// Timespan + project-scoped HISTORICAL token/cost usage, aggregated read-only from the `runs` table
// (the only persisted time-series usage data in Loom — interactive sessions keep no history). Each run
// row carries a CUMULATIVE usage snapshot at teardown (Agent Runs #2: tokens + costUsd, per-project,
// per-agent, timestamped). DISTINCT from UsageLimitsStatus (live plan headroom) and the /usage page
// (live per-session context occupancy). Best-effort: a run whose model had no price recorded 0 costUsd,
// so costUsd is a meter, not a billing ledger; runs still in flight (no usage snapshot) are excluded.

/** The six aggregated measures shared by the grand totals and each breakdown row. `runs` is the COUNT
 *  of qualifying run rows; the token fields are CUMULATIVE billed tokens summed across those runs. */
export interface UsageHistoryTotals {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

/** Per-project breakdown row — the totals plus the project id and its display name (null if the project
 *  row is gone). */
export interface UsageHistoryProject extends UsageHistoryTotals {
  projectId: string;
  projectName: string | null;
}

/** Per-agent breakdown row — the totals plus the agent id and its display name (null if the agent row
 *  is gone). `projectId`/`projectName` identify the agent's OWNING project so identically-named agents
 *  across projects (each project seeds its own "Dev", "Bugfix", … ) disambiguate in the "all" scope. */
export interface UsageHistoryAgent extends UsageHistoryTotals {
  agentId: string;
  agentName: string | null;
  projectId: string | null;
  projectName: string | null;
}

/** GET /api/usage/history response: grand totals over the window + per-project and per-agent breakdowns.
 *  `since` echoes the (clamped) ISO cutoff actually applied; `projectId` echoes the applied filter
 *  (null = all projects). */
export interface UsageHistory {
  since: string;
  projectId: string | null;
  totals: UsageHistoryTotals;
  byProject: UsageHistoryProject[];
  byAgent: UsageHistoryAgent[];
}

// ── Interactive-session usage telemetry (GET /api/usage/sessions/history) ───────────────────────
// A real time-series of every INTERACTIVE session's BILLED usage, sampled periodically by the daemon
// (epic c9924bcd). Token-free: the sampler reads the transcript JSONL the engine already writes — no
// agent turn, no model call. Each `session_usage_samples` row is a per-interval DELTA (additive): its
// token/cost fields are the CHANGE since that session's previous sample, NOT a cumulative snapshot, so a
// windowed/bucketed sum is a plain SUM with no read-time monotonicity math (the sampler — card B —
// computes the deltas + handles transcript-rotation/reset). DISTINCT from the runs-backed UsageHistory
// above (Agent Runs): this is the OWNER'S OWN interactive usage over time. Best-effort cost: an unpriced
// model contributes 0 costUsd, so costUsd is a meter, not a billing ledger.

/** One persisted usage sample — a per-interval DELTA of billed usage for one session segment. The
 *  token/cost fields are the CHANGE since the session's previous sample (not cumulative), so they sum
 *  directly. `agentId`/`model` are nullable (defensive); `ts` is the ISO instant the sample was taken. */
export interface UsageSample {
  id: string;
  sessionId: string;
  projectId: string;
  agentId: string | null;
  model: string | null;
  ts: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
}

/** The aggregated measures shared by the grand totals and each breakdown row. `samples` is the COUNT of
 *  sample rows in the window; the token/cost fields are summed DELTAS (genuine billed usage). */
export interface SessionUsageTotals {
  samples: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  costUsd: number;
  /** {@link cacheHitRatio} of this row's own token sums — carried on the wire so a reader never has to
   *  recompute it. `null` when the row has zero cacheRead+cacheCreation+input to divide by. */
  cacheHitRatio: number | null;
}

/**
 * The prompt-cache HIT RATIO over an aggregated usage window: `cacheRead / (cacheRead + cacheCreation +
 * input)`. Loom drives real interactive `claude` sessions with a fixed startup prefix — a warm,
 * byte-stable prefix means `cache_read` dominates after turn 1 (ratio near 1); a broken prefix (the
 * prefix stopped being byte-identical turn to turn) re-pays ~the whole prefix as `cache_creation` EVERY
 * turn instead (ratio collapses toward 0). This is a pure function over already-aggregated sums — no new
 * data, just a read-time computation — so ANY {@link SessionUsageTotals}-shaped row (totals, or a
 * byProject/byAgent/byDay/bySession breakdown) can be scored the same way. `null` (not 0) when there is
 * no usage in the window to divide by — a 0 would misleadingly read as "totally broken" rather than
 * "no data".
 */
export function cacheHitRatio(t: Pick<SessionUsageTotals, "cacheReadTokens" | "cacheCreationTokens" | "inputTokens">): number | null {
  const denom = t.cacheReadTokens + t.cacheCreationTokens + t.inputTokens;
  return denom > 0 ? t.cacheReadTokens / denom : null;
}

/** Per-project breakdown row — the totals plus the project id and its display name (null if the project
 *  row is gone). */
export interface SessionUsageProject extends SessionUsageTotals {
  projectId: string;
  projectName: string | null;
}

/** Per-agent breakdown row — the totals plus the agent id and its display name (both null if the sample
 *  carried no agent or the agent row is gone). `projectId`/`projectName` identify the agent's OWNING
 *  project so identically-named agents across projects (each project seeds its own "Dev", "Bugfix", … )
 *  disambiguate in the "all" scope; both null when the agent (or its project) is gone. */
export interface SessionUsageAgent extends SessionUsageTotals {
  agentId: string | null;
  agentName: string | null;
  projectId: string | null;
  projectName: string | null;
}

/** One time-bucket row for the over-time chart — the totals for a single ISO `YYYY-MM-DD` day. The
 *  `byDay` array is ordered ascending by `day`. */
export interface SessionUsageDay extends SessionUsageTotals {
  day: string;
}

/** Per-SESSION breakdown row — the totals plus the session id, its `role` (e.g. "manager"/"worker", null
 *  for a legacy/roleless session), and the owning agent/project names (all nullable — the session or its
 *  agent may since be gone). This is the one breakdown granular enough to carry a meaningful
 *  {@link cacheHitRatio}: `byAgent`/`byProject` blend many sessions' prefixes together, but a single
 *  long-running session (a manager, most usefully) has ONE fixed startup prefix, so ITS ratio is the
 *  direct empirical read on whether that prefix stayed byte-stable across the window. Ordered by
 *  `costUsd` desc (same as byProject/byAgent) and capped at the top `SESSION_BREAKDOWN_LIMIT` rows — a
 *  long-lived install accumulates far more distinct sessions than projects/agents, and the top spenders
 *  by usage are exactly the long-running managers this ratio is for. */
export interface SessionUsageSession extends SessionUsageTotals {
  sessionId: string;
  role: string | null;
  agentId: string | null;
  agentName: string | null;
  projectId: string;
  projectName: string | null;
}

/** GET /api/usage/sessions/history response: grand totals over the window + per-project, per-agent,
 *  per-session, and per-day breakdowns. `since` echoes the (clamped) ISO cutoff actually applied;
 *  `projectId` echoes the applied filter (null = all projects). */
export interface SessionUsageHistory {
  since: string;
  projectId: string | null;
  totals: SessionUsageTotals;
  byProject: SessionUsageProject[];
  byAgent: SessionUsageAgent[];
  byDay: SessionUsageDay[];
  bySession: SessionUsageSession[];
}

// ── Session/run AUDIT LOG (the replayable + diffable timeline) ──────────────────────────────────
// A read model over Loom's EXISTING durable record — the `orchestration_events` table (the manager↔
// worker timeline: spawns, messages, redirects, merges, restarts, reports, completion/board events)
// joined with `sessions` metadata. No new capture pipeline: this exposes what is already persisted as
// a first-class, ordered, replayable + diffable surface. Served by the human-only loopback REST readers
// GET /api/audit/session/:id, /api/audit/wave/:managerId, and /api/audit/diff (NOT an agent MCP tool).

/** Whether an {@link AuditTimeline} is keyed on ONE session or a whole orchestration WAVE (a manager + its
 *  workers). The diff endpoint applies the same scope to both sides. */
export type AuditScope = "session" | "wave";

/**
 * One normalized entry on an {@link AuditTimeline} — a single `orchestration_events` row plus a `seq`
 * ordinal (0-based, its position in THIS timeline) for stable replay addressing. Mirrors the durable
 * {@link OrchestrationEventKind} record verbatim (no synthesized fields): `ts` is the recorded instant,
 * `detail` the kind-specific JSON already stored. The web replay scrubs by `seq`; `id` is the durable row id.
 */
export interface AuditEvent {
  id: string;
  /** 0-based ordinal of this event within its timeline (stable replay index). */
  seq: number;
  /** ISO instant the event was recorded. */
  ts: string;
  kind: OrchestrationEventKind;
  /** The owning manager session (a wave/tree event is filed under its manager). */
  managerSessionId: string;
  /** The worker/target session the event concerns, when applicable (null for manager-only events). */
  workerSessionId: string | null;
  /** The board task the event relates to, when applicable. */
  taskId: string | null;
  /** Kind-specific durable detail JSON (e.g. `worker_report` → `{ status, summary }`); null when none. */
  detail: Record<string, unknown> | null;
}

/** Lightweight session metadata for every session referenced by a timeline's events — so a consumer can
 *  resolve an event's actor (role/title/lineage) without a second round-trip. Drawn from the `sessions` row. */
export interface AuditSessionRef {
  id: string;
  projectId: string;
  agentId: string;
  role: SessionRole | null;
  title: string | null;
  parentSessionId: string | null;
  taskId: string | null;
  /** Recycle generation (0 = original) + the prior-generation id this was recycled from (the "predecessor"). */
  gen: number;
  recycledFrom: string | null;
  createdAt: string;
}

/**
 * An ordered, replayable audit timeline for one session (`scope:"session"` — every event where the session
 * is the manager OR the worker) or a whole orchestration wave (`scope:"wave"` — the manager plus all its
 * workers, de-duplicated). Built strictly over `orchestration_events` + `sessions`. `events` is in
 * chronological order (`ts`, then `id` as a stable tiebreaker); `seq` numbers them 0..n-1.
 */
export interface AuditTimeline {
  scope: AuditScope;
  /** The session id (`scope:"session"`) or manager session id (`scope:"wave"`) this timeline is keyed on. */
  rootId: string;
  /** Metadata for every session id referenced by an event here (`id` → ref) — the actor lookup. */
  sessions: Record<string, AuditSessionRef>;
  events: AuditEvent[];
  eventCount: number;
  /** ISO instant of the first / last event (null when the timeline is empty) — the timeline span. */
  firstTs: string | null;
  lastTs: string | null;
}

/** One step in an {@link AuditDiff}'s sequence alignment. `same` = present in both (a & b set); `added` =
 *  only in B (b set, a null); `removed` = only in A (a set, b null). Steps are in replay order. */
export interface AuditDiffStep {
  op: "same" | "added" | "removed";
  /** The compared event signature (`kind` + an outcome discriminator like `:done`/`:blocked`). */
  signature: string;
  a: AuditEvent | null;
  b: AuditEvent | null;
}

/** Per-kind count comparison between two timelines (the "outcomes changed" view). `delta` is `b - a`. */
export interface AuditKindDelta {
  kind: OrchestrationEventKind;
  a: number;
  b: number;
  delta: number;
}

/**
 * A pragmatic structured diff of two audit timelines (two sessions, or a run vs its predecessor) — what
 * changed in the SEQUENCE (an LCS alignment of the event streams by signature) and in the OUTCOMES
 * (`kindDeltas`, per-kind counts). NOT a bespoke VCS; an event's `signature` is its `kind` plus a small
 * outcome discriminator, so e.g. a `worker_report:done` vs `worker_report:blocked` shows as removed+added.
 */
export interface AuditDiff {
  a: { rootId: string; scope: AuditScope; eventCount: number };
  b: { rootId: string; scope: AuditScope; eventCount: number };
  /** Ordered LCS alignment of the two event streams (same / added / removed, in replay order). */
  steps: AuditDiffStep[];
  /** Per-kind count comparison, sorted by kind. */
  kindDeltas: AuditKindDelta[];
  summary: { sameCount: number; addedCount: number; removedCount: number; changed: boolean };
}

// ── Fleet WebSocket delta-push protocol (C1 of umbrella 1efde4ba) ───────────────────────────────
// ADDITIVE ONLY — no runtime code, no consumers, no change to any existing type (TerminalControl /
// TerminalInput and every REST DTO above stay byte-identical). `v:1` here is just a literal field on
// `hello`; there is no handshake/version-enforcement logic in this card. Reuses SessionListItem /
// PendingMerge / OrchestrationEvent VERBATIM so a delta message's shape matches what the REST
// endpoints (`/api/sessions`, `/api/orchestration/events`) already return.

/** Server → client fleet delta messages (a future `/ws/fleet`, not wired up by this card). */
export type ServerFleetMessage =
  | { t: "hello"; v: 1 }
  | { t: "session:upsert"; session: SessionListItem & { pendingMerge: PendingMerge | null } }
  | { t: "session:remove"; id: string }
  | { t: "status"; pausedScopes: string[]; schedulerEnabled: boolean }
  | { t: "event"; managerId: string; event: OrchestrationEvent & { seq: number } };

/** Client → server fleet subscription messages (a future `/ws/fleet`, not wired up by this card). */
export type ClientFleetMessage =
  | { t: "sub:events"; managerId: string; sinceSeq: number }
  | { t: "unsub:events"; managerId: string };
