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
