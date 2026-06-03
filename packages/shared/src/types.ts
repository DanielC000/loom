// Core Loom entities. Loom owns four primitives: Project, Topic, Session, Task.
// (Skill loading is delegated to the Claude CLI — Loom builds no skill machinery.)
import type { ProjectConfigOverride } from "./config.js";

export type ProjectId = string;
export type TopicId = string;
export type SessionId = string; // Loom's own id
export type TaskId = string;
export type ProfileId = string;

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
}

/** A user-defined category of sessions inside a project. */
export interface Topic {
  id: TopicId;
  projectId: ProjectId;
  name: string;
  /** Injected as the first input ONLY when starting a new session (never on resume). */
  startupPrompt: string;
  position: number;
  /**
   * Optional Agent Profile this topic adopts — the reusable, platform-level "who" (role + prompt +
   * tool/permission/model/icon). Nullable + additive: null = a legacy / plain topic, which
   * `resolveProfile` maps to EXACTLY today's behavior. When set, the profile supplies
   * role/allow/skills/model/icon and the topic's own startupPrompt overrides the profile's when
   * non-empty (a blank per-topic prompt falls back to the profile's default prompt).
   * Phase-1 is the READ PATH only — the spawn path still ignores this (P2 wires it in).
   */
  profileId: ProfileId | null;
}

/**
 * An **Agent Profile** — a reusable, platform-level (cross-project) "who": the role, prompt, and
 * tool/permission/model/icon a session adopts. Topics reference one via `profileId`, and
 * `resolveProfile` (sibling of `resolveConfig`) merges profile + topic into the effective spawn
 * shape. A topic with NO profile resolves to today's plain behavior, so this is fully additive.
 * Platform-level on purpose (like skills + config defaults): one definition reused across projects,
 * not re-typed per project the way `TEMPLATE_TOPICS` is today.
 */
export interface Profile {
  id: ProfileId;
  name: string;
  /** Orchestration role conferred; null = a plain (non-orchestration) session — today's default. */
  role: SessionRole | null;
  /** Default startup prompt. A topic's own (non-empty) startupPrompt overrides this; a blank one
   *  falls back to this default (per-topic override is opt-in). */
  startupPrompt: string;
  /** Permission allowlist delta layered onto the resolved config's allow (e.g. extra Bash globs). */
  allowDelta: string[];
  /** Skill-name subset to deliver; null = deliver all (today's behavior). */
  skills: string[] | null;
  /** Model id to spawn with (e.g. "claude-opus-4-8"); null = engine default (no --model emitted). */
  model: string | null;
  /** UI icon (emoji or name); null = none. */
  icon: string | null;
}

// --- Session FSM (explicit; replaces Jinn's loose status enum) ---
export type ProcessState = "none" | "starting" | "live" | "exited";
export type Resumability = "unknown" | "resumable" | "dead";

/**
 * A session's orchestration role (phase-2). Plain phase-1 sessions have no role.
 * - manager / worker: the orchestration spine (loom-orchestration MCP).
 * - platform: a platform-lead — creates/configures projects + topics (loom-platform MCP, Pillar C).
 *   Kept distinct from manager so least-privilege holds: cross-project tools never leak into a
 *   project-scoped manager, and a platform-lead gets no worker-coordination tools.
 */
export type SessionRole = "manager" | "worker" | "platform";

export interface Session {
  id: SessionId;
  projectId: ProjectId;
  topicId: TopicId;
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
}

/** Append-only orchestration audit record (the manager↔worker timeline). */
export type OrchestrationEventKind =
  | "spawn_worker" | "message_worker" | "worker_report" | "stop_worker"
  | "recycle_begin" | "recycle_complete" | "merge_request" | "merge_done"
  | "merge_rejected" | "build_gate" | "kill_switch" | "schedule_fired"
  | "wake_scheduled" | "wake_fired" | "wake_dropped" | "idle_report";

export interface OrchestrationEvent {
  id: string;
  ts: string;
  managerSessionId: string;
  workerSessionId?: string | null;
  taskId?: string | null;
  kind: OrchestrationEventKind;
  detail?: Record<string, unknown>;
}

/** A session enriched with its project/topic names — for the global Live Terminals grid. */
export interface SessionListItem extends Session {
  projectName: string;
  topicName: string;
}

/** A read-only vault file-tree entry. */
export interface VaultEntry {
  path: string; // relative to the project's vault folder, forward slashes
  type: "file" | "dir";
}

export interface Task {
  id: TaskId;
  projectId: ProjectId;
  title: string;
  body: string;
  columnKey: string; // references a resolved kanban column key
  position: number;  // fractional index for cheap reordering
  createdAt: string;
  updatedAt: string;
}

/**
 * A cron-triggered schedule (phase-2 Pillar B). On its minute boundary the daemon Scheduler
 * boots a manager session in `topicId` (the topic's startupPrompt is the kickoff), which then
 * runs the Pillar-A loop. `nextFireAt` is recomputed on create/update and after each fire.
 */
export interface Schedule {
  id: string;
  topicId: TopicId;
  cron: string;              // 5-field cron expression
  enabled: boolean;
  nextFireAt: string;        // ISO; the next scheduled fire
  lastFiredAt: string | null;
  createdAt: string;
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
