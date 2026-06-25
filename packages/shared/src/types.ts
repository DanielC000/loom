// Core Loom entities. Loom owns four primitives: Project, Agent, Session, Task.
// (Skill loading is delegated to the Claude CLI — Loom builds no skill machinery.)
import type { ProjectConfigOverride } from "./config.js";

export type ProjectId = string;
export type AgentId = string;
export type SessionId = string; // Loom's own id
export type TaskId = string;
export type ProfileId = string;
export type ApiKeyId = string;
export type RunId = string;

/** A project's two bindings + its config override blob. */
export interface Project {
  id: ProjectId;
  name: string;
  repoPath: string;   // cwd for spawned sessions; source of project-local .claude/skills
  vaultPath: string;  // Obsidian docs folder (auto-committed)
  /** Per-project config overrides; merged over platform defaults. */
  config: ProjectConfigOverride;
  createdAt: string;
  archivedAt: string | null;
  /**
   * Reserved/system project: a Loom-internal project (the seeded "Loom Platform" home for the
   * Platform Lead/Auditor agents) that is HIDDEN from the normal project picker (`db.listProjects`)
   * but still addressable + visible to admin surfaces (Mission Control, the future Platform UI).
   * false on every ordinary user project; only the boot-seeded platform home is true. Additive —
   * legacy rows backfill to false (0).
   */
  reserved: boolean;
}

/**
 * An **Agent** — the seat + brief inside a project: identity, project-specifics, and the startup
 * prompt injected as the first input of a NEW session. Per-project, many, edited often. An Agent
 * RUNS UNDER a Profile (the reusable rig); the Profile supplies role/model/allow/skills/icon while
 * the injected prompt always comes from the Agent.
 */
export interface Agent {
  id: AgentId;
  projectId: ProjectId;
  name: string;
  /** Injected as the first input ONLY when starting a new session (never on resume). */
  startupPrompt: string;
  position: number;
  /**
   * Optional Profile this agent runs under — the reusable, platform-level "rig" (role + model +
   * allow-delta + skill-subset + icon). Nullable + additive: null = a plain agent, which
   * `resolveProfile` maps to EXACTLY today's behavior. When set, the profile supplies
   * role/allow/skills/model/icon; the injected prompt ALWAYS comes from the agent (a profile no
   * longer carries a prompt — its `description` is a UI-only blurb).
   */
  profileId: ProfileId | null;
  /**
   * Agent Runs R1: marks this agent as *API-exposable* — only an `endpoint=true` agent may be put
   * on a project API key's allowlist (the Agent Runs run-invocation surface, R2+). Default **false**
   * and FULLY ADDITIVE: the flag changes NO spawn behavior in R1 (a session in an endpoint agent
   * spawns byte-identically to one in a non-endpoint agent) — it only gates allowlist eligibility +
   * which agents the future run API may invoke. HUMAN-set only (the agent-edit REST surface); NO
   * agent MCP tool can flip it (same trust-boundary posture as profile role / gateCommand). Legacy
   * rows backfill to false (0). See `[[Agent Runs]]`.
   */
  endpoint: boolean;
  /**
   * Agent Runs R1: an OPTIONAL JSON I/O schema blob describing the agent's expected input/output for
   * runs (advisory in R1 — nothing reads it yet; R2's `submit_result` validates against a
   * caller-supplied-per-call schema, not this one). Nullable + additive (null on every existing /
   * non-endpoint agent). Stored verbatim as a JSON value.
   */
  ioSchema: unknown | null;
}

/**
 * A **Profile** — a reusable, platform-level (cross-project) "rig": the role, model, permission
 * delta, skill-subset, and icon a session adopts. Agents reference one via `profileId`, and
 * `resolveProfile` (sibling of `resolveConfig`) resolves agent + profile into the effective spawn
 * shape. An agent with NO profile resolves to today's plain behavior, so this is fully additive.
 * Platform-level on purpose (like skills + config defaults): a small reusable set, rarely changing,
 * reused across projects rather than re-typed per project. A Profile carries NO injected prompt —
 * `description` is a human-facing blurb shown in the Profiles UI, never injected into a session.
 */
export interface Profile {
  id: ProfileId;
  name: string;
  /** Orchestration role conferred; null = a plain (non-orchestration) session — today's default. */
  role: SessionRole | null;
  /** Human-facing blurb shown in the Profiles UI (what this rig is for). NEVER injected into a
   *  session — the injected startup prompt always comes from the Agent. */
  description: string;
  /** Permission allowlist delta layered onto the resolved config's allow (e.g. extra Bash globs). */
  allowDelta: string[];
  /** Skill-name subset to deliver; null = deliver all (today's behavior). */
  skills: string[] | null;
  /** Model id to spawn with (e.g. "claude-opus-4-8"); null = engine default (no --model emitted). */
  model: string | null;
  /** UI icon (emoji or name); null = none. */
  icon: string | null;
  /**
   * Opt-in browser-automation capability: when true, a session under this rig is spawned with its
   * OWN per-session stdio Playwright MCP (`@playwright/mcp`) so the agent can drive a headless
   * browser. Default OFF (absent/false) and fully additive — a rig without it spawns byte-identically
   * to today. HUMAN-set only (Profiles UI / REST), like role/allow: NEVER exposed via an agent MCP
   * tool (a browser is a navigate-anywhere capability — same capability-gating posture as gateCommand).
   */
  browserTesting?: boolean;
  /**
   * Opt-in document-conversion capability: when true, a session under this rig is spawned with its
   * OWN per-session stdio markitdown MCP (`markitdown-mcp`) so the agent can convert files
   * (PDF/Office/images/HTML/…) to Markdown to save tokens. Default OFF (absent/false) and fully
   * additive — a rig without it spawns byte-identically to today. HUMAN-set only (Profiles UI / REST),
   * like role/allow/browserTesting: NEVER exposed via an agent MCP tool (it launches a host process —
   * same capability-gating posture as browserTesting/gateCommand).
   */
  documentConversion?: boolean;
}

// --- Agent Runs API keys (R1) ---------------------------------------------------------------------
/** A project API key's lifecycle status: active (auths), paused (temporarily blocked), revoked (dead). */
export type ApiKeyStatus = "active" | "paused" | "revoked";

/**
 * Per-key usage ceilings (Agent Runs R1 STORES them; R3/R4 enforce — nothing reads them in R1).
 * `null` on any field = uncapped for that dimension.
 */
export interface ApiKeyCaps {
  /** Max simultaneously-running runs this key may have in flight. */
  maxConcurrentRuns: number | null;
  /** Daily token budget across this key's runs. */
  dailyTokenCap: number | null;
  /** Daily spend budget (USD) across this key's runs. */
  dailySpendCap: number | null;
}

/**
 * A project-scoped API key (Agent Runs R1). The key SECRET is NEVER part of this shape — only a
 * salted hash lives at rest (db-internal); the plaintext token is returned exactly ONCE at creation
 * and at each rotation, never again. This is the public METADATA the human-only key-admin REST
 * surfaces (list/create/rotate/edit) — list must never leak the secret or its hash. The key binds a
 * project to an allowlist of that project's `endpoint=true` agents (R2+ run-invocation scope) plus
 * per-key caps. Human-managed only — no agent MCP tool can mint/rotate/revoke one. See `[[Agent Runs]]`.
 */
export interface ApiKey {
  id: ApiKeyId;
  projectId: ProjectId;
  /** Human label for the key (e.g. "Invest app — prod"). */
  name: string;
  /** Allowlist of endpoint-agent ids this key may invoke; every id is an `endpoint=true` agent in the project. */
  endpointAgentIds: AgentId[];
  caps: ApiKeyCaps;
  status: ApiKeyStatus;
  createdAt: string;
  /** When the secret was last rotated (null = never rotated since creation). */
  rotatedAt: string | null;
}

// --- Session FSM (explicit; replaces the predecessor's loose status enum) ---
export type ProcessState = "none" | "starting" | "live" | "exited";
export type Resumability = "unknown" | "resumable" | "dead";

/**
 * A session's orchestration role (phase-2). Plain phase-1 sessions have no role.
 * - manager / worker: the orchestration spine (loom-orchestration MCP).
 * - platform: a platform-lead — creates/configures projects + agents (loom-platform MCP, Pillar C).
 *   Kept distinct from manager so least-privilege holds: cross-project tools never leak into a
 *   project-scoped manager, and a platform-lead gets no worker-coordination tools.
 * - auditor: the Platform Auditor (Platform Manager P5) — a scheduled, READ-AND-FILE-ONLY transcript
 *   reviewer. A DISTINCT role from `platform` BY DESIGN (the load-bearing security boundary): it
 *   ingests UNTRUSTED transcript content (a prompt-injection surface), so it gets ONLY the restricted
 *   `loom-audit` surface (cross-project transcript reads + file-finding to the Platform backlog) and
 *   NATURALLY 404s on the Lead's elevated `/mcp-platform` (resolveRole gates on role==="platform") AND
 *   on `/mcp-orch` (gates on manager|worker). No agent/MCP path may mint one — only `startAuditor`
 *   (human REST) and the human-configured Scheduler spawn it.
 * - workspace-auditor: the END-USER Auditor (End-User Platform tier, Part B) — the de-privileged,
 *   user-workspace twin of `auditor`: a read-mostly, SUGGEST-ONLY reviewer of the user's OWN
 *   sessions/agents/skills/prompts (board-card + preset suggestions, never auto-apply). A DISTINCT role
 *   from `auditor` BY DESIGN so the two missions are physically separated under LOOM_DEV (where both
 *   exist): it gets ONLY the restricted `loom-user-audit` surface (B3, not built yet) and 404s on every
 *   other MCP surface. Like `auditor` it ingests UNTRUSTED transcript content, so it is caller-set ONLY
 *   by a future `startWorkspaceAuditor` (B5, human REST) — NEVER mintable via a profile
 *   (`profiles/validate.ts`) or by the operator/Setup surface (`setupRoleError`). See
 *   `[[End-User Platform Tier Design]]` Part B. (B1 adds ONLY the role + these guards; the router/skill/
 *   profile/seed/start are B3–B5.)
 * - setup: a Setup Assistant session — the guided onboarding rig that helps a human stand up a project
 *   (see `[[Setup Assistant Design]]`). A first-class role so it can carry its own rig/skills; the
 *   bundled "Setup Assistant" profile sets it and it ships UNGATED (core product, not the dev Platform layer).
 * - run: an EPHEMERAL Agent-Run session (Agent Runs R2) — a curated endpoint agent invoked on one input
 *   to return a structured answer, then torn down. It SUBTRACTS the worker machinery (NO worktree /
 *   branch / merge gate), runs in a disposable read-only snapshot of the project's HEAD, and gets ONLY
 *   the restricted `loom-run` surface (`submit_result`), gated to role==="run" — so it 404s on every
 *   other MCP surface AND does not even mount `loom-tasks`. Runs are NOT resumable (ephemeral by design;
 *   a daemon restart mid-run fails the run clean). Started ONLY by the internal run-starter — no
 *   human/agent session-spawn route mints one (the public keyed trigger is R3). See `[[Agent Runs]]`.
 */
export type SessionRole = "manager" | "worker" | "platform" | "auditor" | "setup" | "workspace-auditor" | "run";

// --- Agent Runs (R2): the AgentRun primitive ------------------------------------------------------
/**
 * An AgentRun's lifecycle status (Agent Runs R2). queued/starting/running are in-flight; the rest are
 * terminal. completed = `submit_result` recorded a (schema-valid) answer; failed = the run errored or
 * its session exited before submitting (incl. a daemon restart mid-run — runs do NOT resume); timed_out
 * = a hard timeout/cap teardown; cancelled = a deliberate cancel (R3 surfaces the trigger). Terminal
 * runs retain `{result, usage, transcriptRef, error}` on the row for audit.
 */
export type RunStatus = "queued" | "starting" | "running" | "completed" | "failed" | "timed_out" | "cancelled";

/**
 * An **AgentRun** (Agent Runs R2) — one ephemeral invocation of an endpoint agent on a caller `input`,
 * returning a structured `result` via `submit_result`. Distinct from a worker: NO worktree/branch/merge;
 * it runs in a disposable read-only HEAD snapshot of the project repo and tears down on a terminal state.
 *
 * Durable in SQLite (the `runs` table). `sessionId` is the ephemeral `run` session driving it (1:1; null
 * only in the instant before the session is minted). `keyId` is null in R2 (runs are started internally;
 * R3's keyed REST sets it). `schema` is the caller-supplied JSON Schema `submit_result` validates the
 * answer against (null ⇒ freeform accept). `result`/`usage`/`transcriptRef`/`error` are populated at
 * teardown. See `[[Agent Runs]]`.
 */
export interface AgentRun {
  id: RunId;
  projectId: ProjectId;
  agentId: AgentId;
  /** The ephemeral `run` session driving this run (null only before it's minted). */
  sessionId: SessionId | null;
  /** The API key that triggered the run; null in R2 (internal starter) — R3's keyed REST sets it. */
  keyId: ApiKeyId | null;
  status: RunStatus;
  /** The caller's input, treated as DATA (injection hygiene), injected into the run's startup prompt. */
  input: unknown;
  /** Caller-supplied JSON Schema the answer must match; null ⇒ `submit_result` accepts freeform JSON. */
  schema: unknown | null;
  /** The `submit_result` payload (null until completed). */
  result: unknown | null;
  /**
   * Usage snapshot captured at teardown; null until then. Agent Runs #2 made this CUMULATIVE per-run usage
   * `{ inputTokens, outputTokens, cacheCreationTokens, cacheReadTokens, turns, model, costUsd }` (summed
   * across all turns + priced via the per-model table). `inputTokens` is cumulative billed input (NOT the
   * old last-turn occupancy). Degrades to the legacy `{ inputTokens, turns, model }` last-turn snapshot
   * only when the transcript was unreadable at teardown.
   */
  usage: unknown | null;
  /** Pointer to the retained transcript snapshot (path under LOOM_HOME); null until captured at teardown. */
  transcriptRef: string | null;
  /** Terminal error detail for a failed/timed-out run; null otherwise. */
  error: string | null;
  /**
   * Caller-supplied webhook URL POSTed the run summary on a terminal transition (Agent Runs R3); null
   * when the caller didn't pass one. Best-effort + bounded — never blocks/wedges teardown.
   */
  webhookUrl: string | null;
  /**
   * Caller-supplied idempotency key (Agent Runs R3) — a per-key exactly-once dispatch token. A retry
   * with the same `(keyId, idempotencyKey)` returns THIS run (no second start, no double-spend). null
   * when the caller didn't pass one (a unique index covers only the non-null pairs).
   */
  idempotencyKey: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
}

/**
 * A run-scoped audit event kind (Agent Runs follow-up #1). `cap_rejected` is the core, genuinely-invisible
 * case: a 429 at POST /api/runs (concurrency or daily-token cap) creates NO run row, so without an explicit
 * audit record a throttled key leaves no trace anywhere. Run LIFECYCLE (status/timestamps) is already on the
 * `runs` row and is deliberately NOT duplicated here.
 */
export type RunEventKind = "cap_rejected";

/**
 * A **RunEvent** (Agent Runs follow-up #1) — a project-scoped audit record for a run-related event that has
 * NO run row of its own. Distinct from {@link OrchestrationEvent}, which is manager-tree shaped
 * (`managerSessionId` is NOT NULL and its readers are session-keyed); a cap-rejection has no session at all,
 * so it needs this separate store. Durable in SQLite (the `run_events` table). `keyId`/`runId` are nullable
 * (a `cap_rejected` carries the throttled `keyId` but NO `runId` — none was created). `detail` is
 * kind-specific JSON (`cap_rejected`: `{ cap: "concurrency"|"daily_token"|"daily_spend", limit, observed, agentId }`).
 * See `[[Agent Runs]]`.
 */
export interface RunEvent {
  id: string;
  projectId: ProjectId;
  /** The API key the event concerns (a cap-rejection is per-key); null if not key-scoped. */
  keyId: ApiKeyId | null;
  /** The run this event concerns; null for a `cap_rejected` (no run row was ever created). */
  runId: RunId | null;
  kind: RunEventKind;
  /** Kind-specific detail JSON (`cap_rejected`: `{ cap, limit, observed, agentId }`); null when none. */
  detail: Record<string, unknown> | null;
  createdAt: string;
}

export interface Session {
  id: SessionId;
  projectId: ProjectId;
  agentId: AgentId;
  /** Claude Code's engine session id, captured via the SessionStart hook. */
  engineSessionId: string | null;
  title: string | null; // auto-derived from the first turn, user-overridable
  cwd: string;          // = project repoPath
  processState: ProcessState;
  resumability: Resumability;
  busy: boolean;        // a turn is currently running
  createdAt: string;
  lastActivity: string;
  lastError: string | null;
  // --- phase-2 orchestration lineage + context counters (additive; null/0 on phase-1 sessions) ---
  role?: SessionRole | null;
  parentSessionId?: string | null;  // the manager that spawned this worker
  taskId?: string | null;           // the board task this worker is working (references tasks)
  worktreePath?: string | null;     // a worker's isolated git worktree cwd
  branch?: string | null;           // the worker's branch
  gen?: number;                     // recycle generation (0 = original)
  recycledFrom?: string | null;     // the prior-generation session id this was recycled from
  ctxInputTokens?: number | null;   // measured engine context occupancy (last-assistant usage)
  ctxTurns?: number | null;
  ctxUpdatedAt?: string | null;
  /** Engine model id from the transcript (e.g. "claude-opus-4-8"); sizes the ctx meters. */
  model?: string | null;
  /**
   * §19c usage-limit park: the ISO instant this session may resume after hitting the Claude
   * usage cap (reset+buffer when known, else a default backoff). null = not rate-limited. The
   * pty is NOT killed on a cap; #19c-b re-submits the pending turn at this time. (lastError
   * carries the human "usage limit — resumes X" string.)
   */
  rateLimitedUntil?: string | null;
  /**
   * §19c-b give-up deadline for the active usage-limit recovery episode — set ONCE at the first
   * cap (reset+30min, else now+6h) and kept across re-caps; null when not recovering. Past it
   * without recovery, the watcher abandons auto-resume and marks the session errored (lastError).
   */
  rateLimitDeadline?: string | null;
  /**
   * Opt-in browser-automation capability, resolved from the session's Profile at spawn and PINNED
   * here (mirrors `role`): a per-session stdio Playwright MCP is injected iff this is true. Persisted
   * so EVERY respawn path (resume / fork / recycle) carries the capability forward unchanged — a
   * resumed browser-worker keeps its browser, exactly as role is re-passed. Absent/false on every
   * existing session ⇒ no Playwright MCP, byte-identical spawn.
   */
  browserTesting?: boolean;
  /**
   * Opt-in document-conversion capability, resolved from the session's Profile at spawn and PINNED
   * here (mirrors `browserTesting`): a per-session stdio markitdown MCP is injected iff this is true.
   * Persisted so EVERY respawn path (resume / fork / recycle) carries the capability forward unchanged.
   * Absent/false on every existing session ⇒ no markitdown MCP, byte-identical spawn.
   */
  documentConversion?: boolean;
  /**
   * Profile-resolved skill-name SUBSET to deliver to this session, PINNED here at fresh spawn (mirrors
   * `role`/`browserTesting`): `injectSkills` mirrors ONLY these skills into the session's `.claude/skills`.
   * `null`/absent ⇒ deliver ALL store skills (today's behavior — the regression-guarded default). Pinned
   * (not re-resolved) so EVERY respawn path (resume / fork / recycle / boot) honors the same subset — a
   * profile re-resolution at resume time would be wrong (the profile may have changed). An empty array is
   * normalized to null at the pin sites (no profile subset ⇒ all).
   */
  skills?: string[] | null;
  /**
   * Per-project session Archive: the ISO instant a session was archived (a UI tidy action that moves
   * a dead/exited session out of the Workspace rail). null = not archived (every live/normal session).
   * Archived sessions are EXCLUDED from the rail/god-eye lists and surface only in the Archive tab.
   * Mirrors the project soft-archive pattern (`Project.archivedAt`). Only an EXITED session is
   * archivable; archiving a manager cascades to its workers.
   */
  archivedAt?: string | null;
}

/**
 * Routing outcome for an UPWARD report/escalation (worker_report → manager, platform_escalate → Lead).
 * Replaces the old boolean `delivered`, which couldn't tell a durable queue from a genuine drop (the
 * `{delivered:false}` ambiguity — board card fc9a27d5). The caller reads this to know whether to relax
 * (it's durably routed) or act (it was dropped):
 *   • `delivered-live` — a LIVE, idle parent received it as a turn NOW (it's already engaged).
 *   • `queued`         — a LIVE-but-busy/parked parent has it HELD in its FIFO; it drains on the parent's
 *                        next turn boundary (durable for the life of the process; re-driven on restart).
 *   • `boarded`        — no live session to take it, but it is DURABLY PERSISTED (platform_escalate always
 *                        files a board task; a worker_report records its event + a wake trigger so the
 *                        crash-recovery watcher auto-resumes the parent). Surfaces later, never lost.
 *   • `dropped`        — a genuine failure to route: there was no target to reach AND nothing durable will
 *                        surface it (e.g. a parentless worker report). The ONLY value that warrants alarm.
 */
export type DeliveryStatus = "delivered-live" | "queued" | "boarded" | "dropped";

/** Append-only orchestration audit record (the manager↔worker timeline). */
export type OrchestrationEventKind =
  | "spawn_worker" | "message_worker" | "worker_report" | "stop_worker"
  // Manager→worker REDIRECT (orchestration `worker_redirect`): the "land it NOW" escalation — END the
  // worker's CURRENT turn (a single Esc cancel) + flush/SUPERSEDE its queued direction + deliver ONE
  // authoritative instruction as the next turn. Parent-scoped exactly like message_worker/stop_worker.
  // Filed under the owning MANAGER (workerSessionId = the steered worker); `detail` carries whether the
  // redirect delivered live or queued. The flushed durable messages resolve as session_message_delivered
  // with reason "superseded" (so the done-guard + boot-recovery never re-drive them).
  | "redirect_worker"
  | "recycle_begin" | "recycle_complete" | "merge_request" | "merge_done"
  | "merge_rejected" | "build_gate" | "kill_switch" | "schedule_fired"
  // worker_report(done) PRE-CHECK refusal (board cards 907b9f50, dcb25bd9): a worker reported done but was
  // refused at the source — `detail.reason` discriminates: "uncommitted" (UNCOMMITTED work in its worktree,
  // + the named files) or "pending-direction" (UNRESOLVED manager direction still queued, + the queued
  // count). Either way the task is kept in_progress (not moved to review). Composes with the divergent-
  // branch merge_rejected.
  | "worker_report_rejected"
  | "wake_scheduled" | "wake_fired" | "wake_dropped" | "idle_report" | "idle_escalated"
  // Busy-worker stuck watchdog (BusyWorkerWatcher): a LIVE worker has been `busy` in a single
  // uninterrupted turn past the `stuckWorkerMinutes` window with no progress. Filed under the OWNING
  // MANAGER (managerSessionId) with workerSessionId/taskId set; `detail` carries minutesBusy + reason.
  // The human-/manager-facing signal that the worker may be hung — surfaced, never a hard kill. Emitted
  // ONCE per stuck episode (re-arms when the worker makes progress, i.e. lastActivity advances).
  | "worker_stuck"
  // A manager self-service management action (assign profile / update agent / update or archive a
  // project / create or update a schedule). `detail.action` discriminates; audit trail for the
  // trust-boundary surface (managers ASSIGN existing capability sets + edit structure, never MINT).
  | "manager_manage"
  // Platform Lead cross-project message delivery (loom-platform `session_message`) — UN-scoped, above
  // the manager/worker tree. `workerSessionId` carries the TARGET session id (delivery only, never spawn).
  | "session_message"
  // Manager→Platform UPWARD escalation (orchestration `platform_escalate`): a discovered Loom bug/friction
  // filed as a durable TASK on the reserved Platform board (the Lead's inbox). `detail` carries the origin
  // project, severity, and the created Platform task id. The ONLY cross-project write a manager may make.
  | "platform_escalate"
  // Platform Auditor finding (loom-audit `audit_file_finding`, P5): a transcript-review finding filed as a
  // durable TASK on the reserved Platform board. `detail` carries the severity, title, and Platform task id.
  // The ONLY write the read-and-file-only Auditor can make (it has no git/vault/config/spawn capability).
  | "audit_finding"
  // End-user Auditor improvement suggestion (loom-user-audit `audit_suggest_improvement`, End-User Platform
  // tier B3): the de-privileged twin of `audit_finding` — a transcript-review SUGGESTION filed as a durable
  // TASK on the USER'S OWN "Getting Started" home inbox (never the dev Platform board). `detail` carries the
  // severity, title, and the user-home task id. One of the workspace-auditor's two inert daemon-local writes.
  | "workspace_audit_suggestion"
  // ── Crash-recovery watchdog (CrashRecoveryWatcher) ─────────────────────────────────────────────
  // A resumable session's pty process died UNEXPECTEDLY while the daemon stayed healthy — i.e. NOT via
  // pty.stop() (graceful/idle/user-stop/recycle/merge-stop) and NOT a whole-daemon restart/crash (those
  // tear down the process, so no JS onExit runs → no event). Recorded at onExit time iff `intended===false`
  // (= the pty's `stopping` flag was unset). This is the DURABLE trigger the watchdog acts on; filed with
  // workerSessionId = the dead session (managerSessionId = its parent for a worker, else its own id).
  | "session_died"
  // A bounded crash-recovery auto-resume attempt. `detail` carries the 1-based attempt number + ok/error.
  // The PERSISTED counter (count of these since the last `session_recovered`) is what bounds the loop —
  // it survives a daemon restart (mirrors busy-worker's once-per-episode mark via the events table).
  | "session_resume_attempt"
  // A crash-recovered session has stayed stably LIVE long enough after a resume → the episode is closed and
  // the attempt counter RESETS (the next death starts fresh). The high-water reset marker for the counter.
  | "session_recovered"
  // CRASH-LOOP SAFETY: after N (crashRecoveryMaxAttempts) re-deaths the watchdog STOPS auto-resuming and
  // escalates LOUDLY instead of looping forever. Filed ONCE per episode; ALSO stamped on the session's
  // lastError so Mission Control surfaces it role-agnostically (a dead manager has no parent to nudge).
  | "session_recovery_abandoned"
  // STRAND BACKSTOP (incident 22a44352): a worker called worker_report while its parent manager had already
  // EXITED (idle-reaped after dispatching its last worker), so the framed report reached NOBODY
  // (`delivered:false`) and the completed branch sat unmerged. This is the durable wake trigger — the SECOND
  // trigger the CrashRecoveryWatcher acts on, keyed on `delivered:false` rather than process-death: it
  // bounded-auto-resumes the exited manager (same attempt-cap/escalation machinery as `session_died`) so it
  // consumes the report and runs review→gate→merge. Filed under the MANAGER (workerSessionId = its id, so
  // listEventsForWorker retrieves it; managerSessionId = its parent or its own id); `detail` carries the
  // reporting worker + task. Recorded by recordUndeliveredReport ONLY when the manager is exited (a
  // live-but-busy manager's queue drains on its next turn — not a strand) and not usage-limit parked.
  | "worker_report_undelivered"
  // EXITED-WITHOUT-REPORT (board card 84151b99): a worker's pty exited UNEXPECTEDLY (intended===false —
  // not a manager-issued worker_stop/recycle/merge) while its task was STILL in_progress, i.e. it never
  // called worker_report at all. The idle nudge (notifyManagerOfIdleWorker) only fires on a busy→false
  // EDGE, but a fast/first worker can exit before that edge ever lands (a pty exit routes through onExit,
  // NOT the onBusy callback) → the manager would see a silent idle (or nothing) and have to self-rescue via
  // worker_transcript. This is the DISTINCT, DURABLE signal that the worker is GONE and will never report:
  // filed under the MANAGER (managerSessionId = the parent, workerSessionId = the dead worker), `detail`
  // carries the worker's branch. Recorded by notifyManagerOfExitedWorker from the onExit hook; paired with
  // a [loom:worker-exited] nudge enqueued to the (live) manager. Sibling of `worker_report_undelivered`
  // (report reached nobody) — this is "no report at all".
  | "worker_exited_without_report"
  // DURABLE QUEUED-MESSAGE INBOX (card 2ca18433): a down/cross-tree message (message_worker /
  // session_message) that could NOT be delivered as a turn at send time — the recipient was busy, so it
  // was HELD in the recipient's in-memory FIFO (`delivered:false`). That FIFO dies with the process, so a
  // sender death or a daemon restart before the recipient's next turn boundary would SILENTLY DROP it
  // (it lost a P1 dispatch twice). This event PERSISTS the held message so it survives both: filed under
  // workerSessionId = the RECIPIENT (managerSessionId = the SENDER), `detail` carries { msgId, text,
  // sender }. Recorded by SessionService's messaging helpers ONLY on the queued (delivered:false) path —
  // an immediately-delivered message is already a live turn and needs no persistence. The boot scan
  // (recoverUndeliveredMessagesOnBoot) re-enqueues every still-unresolved one onto its resumed recipient
  // and surfaces stuck outbound ones to the resumed sender. PAIRED with its resolution marker below.
  | "session_message_queued"
  // The resolution half of `session_message_queued`: the held message was finally HANDED to the recipient
  // — drained as a turn at its next Stop, or consumed via inbox_pull. `detail.msgId` matches the queued
  // event; a queued event with NO matching delivered event is "still undelivered" (the boot scan's work
  // set). Also filed by the boot scan to RETIRE a queued event whose recipient is gone/superseded (carried
  // forward by recycle, or unrecoverable) so the undelivered set can't grow without bound (detail.reason).
  | "session_message_delivered";

export interface OrchestrationEvent {
  id: string;
  ts: string;
  managerSessionId: string;
  workerSessionId?: string | null;
  taskId?: string | null;
  kind: OrchestrationEventKind;
  detail?: Record<string, unknown>;
}

/** A session enriched with its project/agent names — for the global Live Terminals grid. */
export interface SessionListItem extends Session {
  projectName: string;
  agentName: string;
}

/**
 * An archived session row for the per-project Archive tab — a SessionListItem plus whether a
 * transcript SNAPSHOT was captured on exit (false ⇒ "no transcript captured" — the session was
 * already dead when archived, so its engine JSONL was gone before a snapshot could be taken).
 */
export interface ArchivedSessionListItem extends SessionListItem {
  snapshotExists: boolean;
}

/** A read-only vault file-tree entry. */
export interface VaultEntry {
  path: string; // relative to the project's vault folder, forward slashes
  type: "file" | "dir";
}

/**
 * A board task's priority: four levels, LOW number = HIGHER priority. Each maps to a theme tone for
 * its card chip (p0 red, p1 amber, p2 cyan/dim, p3 muted). `p2` (Normal) is the DEFAULT — every new
 * task and every backfilled legacy row carries it. Columns order high→low (p0 first) by (priority,
 * position).
 */
export type TaskPriority = "p0" | "p1" | "p2" | "p3";
/** The default priority for a new / un-prioritized task (Normal). */
export const DEFAULT_TASK_PRIORITY: TaskPriority = "p2";

export interface Task {
  id: TaskId;
  projectId: ProjectId;
  title: string;
  body: string;
  columnKey: string; // references a resolved kanban column key
  position: number;  // fractional index for cheap reordering
  priority: TaskPriority; // p0 (critical) → p3 (low); default p2 (normal)
  createdAt: string;
  updatedAt: string;
}

/**
 * A global "preset prompt" — a programmable terminal action-button (a short `label` + the `prompt`
 * text it sends to a session on click). GLOBAL / daemon-wide: a single shared list with NO project or
 * session scoping. Human/UI-managed over the loopback REST surface (there is intentionally NO MCP path
 * — an agent never reaches it; it is plain user UI data, not a trust-boundary capability). Ordered by
 * `position`; a freshly-created preset appends at the end of the list.
 */
export interface PresetPrompt {
  id: string;
  label: string;   // short button text
  prompt: string;  // the prompt text sent to the session on click
  position: number; // ascending order (append = max+1)
  createdAt: string;
  updatedAt: string;
}

/**
 * A SUGGESTED preset prompt — the "Suggested from your usage" feature. The Platform Auditor (and the
 * human/UI for completeness) proposes a candidate preset (`label` + `prompt`, plus a `rationale` for
 * WHY it was suggested, surfaced in the UI). GLOBAL / daemon-wide, mirroring `PresetPrompt`: a single
 * shared list, NO project/session scoping. Lifecycle: `pending` → `adopted` | `dismissed`. Adopting
 * mints a real `PresetPrompt` from the suggestion's label+prompt; adopted/dismissed rows are KEPT to
 * back the dedupe ("no re-nag"). The write path is dedupe-guarded so a hostile transcript can't spam:
 * a suggestion whose normalized (trimmed) prompt already matches an existing preset OR any existing
 * suggestion (in any status) is a no-op.
 */
export interface PresetPromptSuggestion {
  id: string;
  label: string;   // short button text (the adopted preset's label)
  prompt: string;  // the prompt text the adopted preset would send
  rationale: string | null; // WHY it was suggested (for the UI); nullable
  status: "pending" | "adopted" | "dismissed";
  position: number; // ascending order (append = max+1)
  createdAt: string;
  updatedAt: string;
}

/**
 * A cron-triggered schedule (phase-2 Pillar B). On its minute boundary the daemon Scheduler
 * boots a manager session in `agentId` (the agent's startupPrompt is the kickoff), which then
 * runs the Pillar-A loop. `nextFireAt` is recomputed on create/update and after each fire.
 */
export interface Schedule {
  id: string;
  agentId: AgentId;
  cron: string;              // 5-field cron expression
  enabled: boolean;
  nextFireAt: string;        // ISO; the next scheduled fire
  lastFiredAt: string | null;
  createdAt: string;
  /**
   * What a fired schedule spawns (Platform Manager P5):
   * - "manager" (DEFAULT) — boots a manager session that runs the Pillar-A loop (today's behavior).
   * - "auditor" — boots the dev Platform Auditor via `startAuditor` (role locked to "auditor", the
   *   read-and-file-only transcript reviewer). The Scheduler routes by this field.
   * - "workspace-auditor" — boots the END-USER Workspace Auditor via `startWorkspaceAuditor` (role
   *   locked to "workspace-auditor", the de-privileged suggest-only user-workspace reviewer; B6). It
   *   lets a user run "Review my workspace" on a cron, not just on-demand.
   * Additive + idempotent: legacy rows backfill to "manager" (column DEFAULT), so every existing
   * schedule keeps spawning a manager exactly as before.
   */
  kind: "manager" | "auditor" | "workspace-auditor";
}

/**
 * A one-shot self-scheduled wake-up (the agent-facing `wake_me` primitive). A session schedules
 * one, ends its turn, and goes idle; when `wakeAt` passes the daemon WakeService re-submits `note`
 * as a fresh turn — auto-resuming the session first if it was stopped. Unlike a Schedule it does
 * NOT recur: a fired wake is deleted. `note` is the agent's message-to-its-future-self.
 */
export interface Wake {
  id: string;
  sessionId: SessionId;
  wakeAt: string;            // ISO; when to re-nudge the session
  note: string;
  createdAt: string;
}

/**
 * A Loom-managed skill (a SKILL.md playbook in the Loom skill store, ~/.loom/skills/<name>). These
 * are delivered to every session as project-local skills (shadowing the user's personal ones) and
 * are editable in the UI. `bundled` = a same-named skill ships with Loom (so the UI can offer reset).
 */
export interface SkillSummary {
  name: string;
  description: string;
  bundled: boolean;
  /** Bundled skills only: the user's store SKILL.md (`mine`) differs from the `base` snapshot — they edited it. */
  customized?: boolean;
  /** Bundled skills only: Loom shipped a newer asset than the `base` snapshot — an update is available to adopt. */
  updateAvailable?: boolean;
}

// --- Context-window sizing -------------------------------------------------------------------
/** Fallback window for an unknown / not-yet-measured model — the classic Claude context size. */
export const DEFAULT_CONTEXT_WINDOW = 200_000;
/** Fraction of the window at which a ctx meter flips to the amber "getting full" tone. */
export const CONTEXT_WARN_RATIO = 0.6;
// Map a model id to its context window. The transcript reports a BARE model id (e.g.
// "claude-opus-4-8") with no signal of the 1M-context beta, so we size by the model's MAX
// attainable window: Claude 4.x Opus/Sonnet run with the 1M beta in this deployment. An explicit
// "1m" in the id always wins. Unknown models fall back to DEFAULT_CONTEXT_WINDOW. Adjust here if
// you run a 4.x model pinned to the smaller 200k window.
const CONTEXT_WINDOW_BY_MODEL: { match: RegExp; window: number }[] = [
  { match: /1m/i, window: 1_000_000 },               // an explicit 1M-context model id
  { match: /opus-4|sonnet-4/i, window: 1_000_000 },  // Claude 4.x Opus/Sonnet — 1M-context beta
];
/** Resolve a session's context window from its (possibly null) model id. */
export function contextWindowForModel(model?: string | null): number {
  if (!model) return DEFAULT_CONTEXT_WINDOW;
  for (const { match, window } of CONTEXT_WINDOW_BY_MODEL) if (match.test(model)) return window;
  return DEFAULT_CONTEXT_WINDOW;
}
