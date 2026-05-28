// Core Loom entities. Loom owns four primitives: Project, Topic, Session, Task.
// (Skill loading is delegated to the Claude CLI — Loom builds no skill machinery.)
import type { ProjectConfigOverride } from "./config.js";

export type ProjectId = string;
export type TopicId = string;
export type SessionId = string; // Loom's own id
export type TaskId = string;

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
}

// --- Session FSM (explicit; replaces Jinn's loose status enum) ---
export type ProcessState = "none" | "starting" | "live" | "exited";
export type Resumability = "unknown" | "resumable" | "dead";

/** A session's orchestration role (phase-2). Plain phase-1 sessions have no role. */
export type SessionRole = "manager" | "worker";

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
}

/** Append-only orchestration audit record (the manager↔worker timeline). */
export type OrchestrationEventKind =
  | "spawn_worker" | "message_worker" | "worker_report" | "stop_worker"
  | "recycle_begin" | "recycle_complete" | "merge_request" | "merge_done"
  | "merge_rejected" | "build_gate" | "kill_switch" | "schedule_fired";

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
