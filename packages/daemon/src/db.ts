import Database from "better-sqlite3";
import { DB_PATH } from "./paths.js";
import type {
  Project, Topic, Session, Task, ProjectConfigOverride,
  ProcessState, Resumability, SessionListItem, SessionRole,
  OrchestrationEvent, OrchestrationEventKind, Schedule,
} from "@loom/shared";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  vault_path TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  archived_at TEXT
);
CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  startup_prompt TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  topic_id TEXT NOT NULL REFERENCES topics(id),
  engine_session_id TEXT,
  title TEXT,
  cwd TEXT NOT NULL,
  process_state TEXT NOT NULL DEFAULT 'none',
  resumability TEXT NOT NULL DEFAULT 'unknown',
  busy INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_activity TEXT NOT NULL,
  last_error TEXT,
  -- phase-2 orchestration (also added to existing DBs via the idempotent migration below)
  role TEXT,
  parent_session_id TEXT,
  task_id TEXT,
  worktree_path TEXT,
  branch TEXT,
  gen INTEGER DEFAULT 0,
  recycled_from TEXT,
  ctx_input_tokens INTEGER,
  ctx_turns INTEGER,
  ctx_updated_at TEXT,
  rate_limited_until TEXT,
  rate_limit_deadline TEXT
);
-- Append-only orchestration audit trail (manager↔worker timeline; UI timeline in #18).
CREATE TABLE IF NOT EXISTS orchestration_events (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  manager_session_id TEXT NOT NULL,
  worker_session_id TEXT,
  task_id TEXT,
  kind TEXT NOT NULL,
  detail_json TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  column_key TEXT NOT NULL,
  position REAL NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Cron-triggered schedules (phase-2 Pillar B): the daemon Scheduler boots a manager on the tick.
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  topic_id TEXT NOT NULL REFERENCES topics(id),
  cron TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_fire_at TEXT NOT NULL,
  last_fired_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_topics_project ON topics(project_id, position);
CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_fire_at);
CREATE INDEX IF NOT EXISTS idx_sessions_topic ON sessions(topic_id, last_activity DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, column_key, position);
CREATE INDEX IF NOT EXISTS idx_orch_events_mgr ON orchestration_events(manager_session_id, ts);
`;

/** Columns added to `sessions` after phase-1; applied to existing DBs by migrateSessions(). */
const SESSION_ADDED_COLUMNS: Record<string, string> = {
  role: "TEXT",
  parent_session_id: "TEXT",
  task_id: "TEXT",
  worktree_path: "TEXT",
  branch: "TEXT",
  gen: "INTEGER DEFAULT 0",
  recycled_from: "TEXT",
  ctx_input_tokens: "INTEGER",
  ctx_turns: "INTEGER",
  ctx_updated_at: "TEXT",
  rate_limited_until: "TEXT",
  rate_limit_deadline: "TEXT",
};

type Row = Record<string, unknown>;

export class Db {
  private db: Database.Database;
  constructor(file = DB_PATH) {
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
    this.migrateSessions();
  }

  /**
   * Idempotent additive migration: ADD COLUMN any phase-2 `sessions` column missing from an
   * existing DB (fresh installs already have them via CREATE TABLE). Converges both paths
   * without wiping data. The parent-lineage index is created here since it depends on a
   * migrated column.
   */
  private migrateSessions(): void {
    const have = new Set(
      (this.db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name),
    );
    for (const [name, type] of Object.entries(SESSION_ADDED_COLUMNS)) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE sessions ADD COLUMN ${name} ${type}`);
    }
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_sessions_parent ON sessions(parent_session_id)");
  }

  /** Release the SQLite handle (used by hermetic tests to free the file before cleanup). */
  close(): void {
    this.db.close();
  }

  // --- projects ---
  listProjects(): Project[] {
    return this.db.prepare("SELECT * FROM projects WHERE archived_at IS NULL ORDER BY name")
      .all().map(toProject);
  }
  getProject(id: string): Project | undefined {
    const r = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
    return r ? toProject(r) : undefined;
  }
  insertProject(p: Project): void {
    this.db.prepare(
      `INSERT INTO projects (id,name,repo_path,vault_path,config_json,created_at,archived_at)
       VALUES (@id,@name,@repoPath,@vaultPath,@config,@createdAt,@archivedAt)`,
    ).run({ ...p, config: JSON.stringify(p.config), archivedAt: p.archivedAt });
  }
  /** Replace a project's config override (Pillar C project_configure / PATCH config). */
  setProjectConfig(id: string, config: ProjectConfigOverride): void {
    this.db.prepare("UPDATE projects SET config_json = ? WHERE id = ?").run(JSON.stringify(config), id);
  }

  // --- topics ---
  listTopics(projectId: string): Topic[] {
    return this.db.prepare("SELECT * FROM topics WHERE project_id = ? ORDER BY position")
      .all(projectId).map(toTopic);
  }
  getTopic(id: string): Topic | undefined {
    const r = this.db.prepare("SELECT * FROM topics WHERE id = ?").get(id) as Row | undefined;
    return r ? toTopic(r) : undefined;
  }
  insertTopic(t: Topic): void {
    this.db.prepare(
      `INSERT INTO topics (id,project_id,name,startup_prompt,position)
       VALUES (@id,@projectId,@name,@startupPrompt,@position)`,
    ).run(t);
  }

  // --- sessions ---
  listSessions(topicId: string): Session[] {
    return this.db.prepare("SELECT * FROM sessions WHERE topic_id = ? ORDER BY last_activity DESC")
      .all(topicId).map(toSession);
  }
  getSession(id: string): Session | undefined {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
    return r ? toSession(r) : undefined;
  }
  /** All sessions across all projects, enriched with project/topic names (global grid). */
  listAllSessions(): SessionListItem[] {
    const rows = this.db.prepare(
      `SELECT s.*, p.name AS project_name, t.name AS topic_name
       FROM sessions s JOIN projects p ON s.project_id = p.id JOIN topics t ON s.topic_id = t.id
       ORDER BY s.last_activity DESC`,
    ).all() as Row[];
    return rows.map((r) => ({ ...toSession(r), projectName: r.project_name as string, topicName: r.topic_name as string }));
  }
  insertSession(s: Session): void {
    this.db.prepare(
      `INSERT INTO sessions (
         id,project_id,topic_id,engine_session_id,title,cwd,process_state,resumability,busy,
         created_at,last_activity,last_error,
         role,parent_session_id,task_id,worktree_path,branch,gen,recycled_from,
         ctx_input_tokens,ctx_turns,ctx_updated_at,rate_limited_until,rate_limit_deadline)
       VALUES (
         @id,@projectId,@topicId,@engineSessionId,@title,@cwd,@processState,@resumability,@busy,
         @createdAt,@lastActivity,@lastError,
         @role,@parentSessionId,@taskId,@worktreePath,@branch,@gen,@recycledFrom,
         @ctxInputTokens,@ctxTurns,@ctxUpdatedAt,@rateLimitedUntil,@rateLimitDeadline)`,
    ).run({
      ...s,
      busy: s.busy ? 1 : 0,
      // Orchestration fields are optional on Session; coerce absent ones (undefined) to NULL/0
      // so plain phase-1 session literals insert unchanged.
      role: s.role ?? null,
      parentSessionId: s.parentSessionId ?? null,
      taskId: s.taskId ?? null,
      worktreePath: s.worktreePath ?? null,
      branch: s.branch ?? null,
      gen: s.gen ?? 0,
      recycledFrom: s.recycledFrom ?? null,
      ctxInputTokens: s.ctxInputTokens ?? null,
      ctxTurns: s.ctxTurns ?? null,
      ctxUpdatedAt: s.ctxUpdatedAt ?? null,
      rateLimitedUntil: s.rateLimitedUntil ?? null,
      rateLimitDeadline: s.rateLimitDeadline ?? null,
    });
  }
  setEngineSessionId(id: string, engineId: string): void {
    this.db.prepare("UPDATE sessions SET engine_session_id = ?, resumability = 'resumable', last_activity = ? WHERE id = ?")
      .run(engineId, new Date().toISOString(), id);
  }
  setProcessState(id: string, state: ProcessState): void {
    this.db.prepare("UPDATE sessions SET process_state = ?, last_activity = ? WHERE id = ?")
      .run(state, new Date().toISOString(), id);
  }
  setResumability(id: string, r: Resumability): void {
    this.db.prepare("UPDATE sessions SET resumability = ? WHERE id = ?").run(r, id);
  }
  /** Turn in-flight flag — driven hook-side (UserPromptSubmit rising, Stop/StopFailure falling). */
  setBusy(id: string, busy: boolean): void {
    this.db.prepare("UPDATE sessions SET busy = ?, last_activity = ? WHERE id = ?")
      .run(busy ? 1 : 0, new Date().toISOString(), id);
  }
  /**
   * On daemon boot, no pty from a previous run survives — reconcile any session still
   * marked live/starting to exited (it stays resumable if it captured an engine id).
   */
  recoverStaleSessions(): number {
    return this.db.prepare(
      "UPDATE sessions SET process_state = 'exited', busy = 0 WHERE process_state IN ('live','starting')",
    ).run().changes;
  }
  /** Sessions that have a captured engine id and aren't already marked dead. */
  listResumeCandidates(): Session[] {
    return (this.db.prepare(
      "SELECT * FROM sessions WHERE engine_session_id IS NOT NULL AND resumability != 'dead'",
    ).all() as Row[]).map(toSession);
  }

  // --- orchestration (phase-2): lineage, context counters, audit trail ---
  /** Set only the provided lineage fields on a session (undefined = leave as-is; null clears). */
  setOrchestration(id: string, patch: {
    role?: SessionRole | null; parentSessionId?: string | null; taskId?: string | null;
    worktreePath?: string | null; branch?: string | null; gen?: number; recycledFrom?: string | null;
  }): void {
    const cols: Record<string, unknown> = {
      role: patch.role, parent_session_id: patch.parentSessionId, task_id: patch.taskId,
      worktree_path: patch.worktreePath, branch: patch.branch, gen: patch.gen,
      recycled_from: patch.recycledFrom,
    };
    const names = Object.keys(cols).filter((k) => cols[k] !== undefined);
    if (names.length === 0) return;
    const set = names.map((c) => `${c} = ?`).join(", ");
    const vals = names.map((c) => cols[c]);
    this.db.prepare(`UPDATE sessions SET ${set} WHERE id = ?`).run(...vals, id);
  }
  /** Update measured context occupancy, bumping ctx_updated_at. */
  setContextCounters(id: string, c: { ctxInputTokens: number; ctxTurns: number }): void {
    this.db.prepare("UPDATE sessions SET ctx_input_tokens = ?, ctx_turns = ?, ctx_updated_at = ? WHERE id = ?")
      .run(c.ctxInputTokens, c.ctxTurns, new Date().toISOString(), id);
  }
  /**
   * §19c usage-limit park: stamp when the session may resume (null clears the park) and the
   * human-readable lastError. Bumps last_activity so the UI shows parked-not-dead. Persisted, so
   * the resume-at survives a daemon restart (#19c-b re-arms the wake from it).
   */
  setRateLimitedUntil(id: string, until: string | null, lastError: string | null): void {
    this.db.prepare("UPDATE sessions SET rate_limited_until = ?, last_error = ?, last_activity = ? WHERE id = ?")
      .run(until, lastError, new Date().toISOString(), id);
  }
  /**
   * §19c-b: arm the give-up deadline for a recovery episode. COALESCE keeps an already-set
   * deadline, so the FIRST cap sets it and re-caps preserve it (Jinn's episode-bounded deadline) —
   * the loop is bounded from the first hit, not reset on every retry.
   */
  armRateLimitDeadline(id: string, deadline: string): void {
    this.db.prepare("UPDATE sessions SET rate_limit_deadline = COALESCE(rate_limit_deadline, ?) WHERE id = ?").run(deadline, id);
  }
  /** Clear the episode deadline — on recovery (success) or after bailing. */
  clearRateLimitDeadline(id: string): void {
    this.db.prepare("UPDATE sessions SET rate_limit_deadline = NULL WHERE id = ?").run(id);
  }
  /** Live sessions in an active usage-limit episode (deadline armed) — the resume watcher's work set. */
  listRateLimitEpisodes(): Session[] {
    return (this.db.prepare("SELECT * FROM sessions WHERE rate_limit_deadline IS NOT NULL AND process_state = 'live'")
      .all() as Row[]).map(toSession);
  }
  /** Append an orchestration audit record (detail serialized to JSON). */
  appendEvent(evt: OrchestrationEvent): void {
    this.db.prepare(
      `INSERT INTO orchestration_events (id,ts,manager_session_id,worker_session_id,task_id,kind,detail_json)
       VALUES (@id,@ts,@managerSessionId,@workerSessionId,@taskId,@kind,@detailJson)`,
    ).run({
      id: evt.id, ts: evt.ts, managerSessionId: evt.managerSessionId,
      workerSessionId: evt.workerSessionId ?? null, taskId: evt.taskId ?? null,
      kind: evt.kind, detailJson: evt.detail === undefined ? null : JSON.stringify(evt.detail),
    });
  }
  /** The workers a manager spawned (its direct children). */
  listWorkers(managerSessionId: string): Session[] {
    return (this.db.prepare("SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY created_at")
      .all(managerSessionId) as Row[]).map(toSession);
  }
  /** A manager's audit trail in chronological order (rowid breaks same-timestamp ties). */
  listEvents(managerSessionId: string): OrchestrationEvent[] {
    return (this.db.prepare("SELECT * FROM orchestration_events WHERE manager_session_id = ? ORDER BY ts, rowid")
      .all(managerSessionId) as Row[]).map(toOrchestrationEvent);
  }

  // --- tasks ---
  listTasks(projectId: string): Task[] {
    return this.db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY column_key, position")
      .all(projectId).map(toTask);
  }
  insertTask(t: Task): void {
    this.db.prepare(
      `INSERT INTO tasks (id,project_id,title,body,column_key,position,created_at,updated_at)
       VALUES (@id,@projectId,@title,@body,@columnKey,@position,@createdAt,@updatedAt)`,
    ).run(t);
  }
  updateTask(id: string, patch: Partial<Pick<Task, "title" | "body" | "columnKey" | "position">>): void {
    const cur = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    if (!cur) return;
    const t = toTask(cur);
    const next = { ...t, ...patch, updatedAt: new Date().toISOString() };
    this.db.prepare(
      "UPDATE tasks SET title=@title, body=@body, column_key=@columnKey, position=@position, updated_at=@updatedAt WHERE id=@id",
    ).run(next);
  }

  // --- schedules (phase-2 Pillar B) ---
  insertSchedule(s: Schedule): void {
    this.db.prepare(
      `INSERT INTO schedules (id,topic_id,cron,enabled,next_fire_at,last_fired_at,created_at)
       VALUES (@id,@topicId,@cron,@enabled,@nextFireAt,@lastFiredAt,@createdAt)`,
    ).run({ ...s, enabled: s.enabled ? 1 : 0, lastFiredAt: s.lastFiredAt ?? null });
  }
  listSchedules(): Schedule[] {
    return (this.db.prepare("SELECT * FROM schedules ORDER BY created_at").all() as Row[]).map(toSchedule);
  }
  getSchedule(id: string): Schedule | undefined {
    const r = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as Row | undefined;
    return r ? toSchedule(r) : undefined;
  }
  /** Partial edit (REST): any provided field is written; omitted fields are left as-is. */
  updateSchedule(id: string, patch: { cron?: string; enabled?: boolean; nextFireAt?: string; lastFiredAt?: string | null }): void {
    const cols: Record<string, unknown> = {
      cron: patch.cron,
      enabled: patch.enabled === undefined ? undefined : patch.enabled ? 1 : 0,
      next_fire_at: patch.nextFireAt,
      last_fired_at: patch.lastFiredAt,
    };
    const names = Object.keys(cols).filter((k) => cols[k] !== undefined);
    if (names.length === 0) return;
    const set = names.map((c) => `${c} = ?`).join(", ");
    this.db.prepare(`UPDATE schedules SET ${set} WHERE id = ?`).run(...names.map((c) => cols[c]), id);
  }
  deleteSchedule(id: string): void {
    this.db.prepare("DELETE FROM schedules WHERE id = ?").run(id);
  }
  /** Enabled schedules whose next_fire_at is at/earlier than nowIso (the Scheduler's due set). */
  listDueSchedules(nowIso: string): Schedule[] {
    return (this.db.prepare("SELECT * FROM schedules WHERE enabled = 1 AND next_fire_at <= ? ORDER BY next_fire_at")
      .all(nowIso) as Row[]).map(toSchedule);
  }
  /** Record a fire: stamp last_fired_at and advance next_fire_at (computed by the caller). */
  markFired(id: string, lastIso: string, nextIso: string): void {
    this.db.prepare("UPDATE schedules SET last_fired_at = ?, next_fire_at = ? WHERE id = ?").run(lastIso, nextIso, id);
  }
}

function toProject(r0: unknown): Project {
  const r = r0 as Row;
  return {
    id: r.id as string, name: r.name as string,
    repoPath: r.repo_path as string, vaultPath: r.vault_path as string,
    config: JSON.parse((r.config_json as string) || "{}") as ProjectConfigOverride,
    createdAt: r.created_at as string, archivedAt: (r.archived_at as string) ?? null,
  };
}
function toTopic(r0: unknown): Topic {
  const r = r0 as Row;
  return {
    id: r.id as string, projectId: r.project_id as string, name: r.name as string,
    startupPrompt: r.startup_prompt as string, position: r.position as number,
  };
}
function toSession(r0: unknown): Session {
  const r = r0 as Row;
  return {
    id: r.id as string, projectId: r.project_id as string, topicId: r.topic_id as string,
    engineSessionId: (r.engine_session_id as string) ?? null, title: (r.title as string) ?? null,
    cwd: r.cwd as string,
    processState: r.process_state as ProcessState, resumability: r.resumability as Resumability,
    busy: (r.busy as number) === 1,
    createdAt: r.created_at as string, lastActivity: r.last_activity as string,
    lastError: (r.last_error as string) ?? null,
    // phase-2 orchestration (null/0 on plain phase-1 rows)
    role: (r.role as SessionRole) ?? null,
    parentSessionId: (r.parent_session_id as string) ?? null,
    taskId: (r.task_id as string) ?? null,
    worktreePath: (r.worktree_path as string) ?? null,
    branch: (r.branch as string) ?? null,
    gen: (r.gen as number) ?? 0,
    recycledFrom: (r.recycled_from as string) ?? null,
    ctxInputTokens: (r.ctx_input_tokens as number) ?? null,
    ctxTurns: (r.ctx_turns as number) ?? null,
    ctxUpdatedAt: (r.ctx_updated_at as string) ?? null,
    rateLimitedUntil: (r.rate_limited_until as string) ?? null,
    rateLimitDeadline: (r.rate_limit_deadline as string) ?? null,
  };
}
function toOrchestrationEvent(r0: unknown): OrchestrationEvent {
  const r = r0 as Row;
  return {
    id: r.id as string, ts: r.ts as string,
    managerSessionId: r.manager_session_id as string,
    workerSessionId: (r.worker_session_id as string) ?? null,
    taskId: (r.task_id as string) ?? null,
    kind: r.kind as OrchestrationEventKind,
    detail: r.detail_json ? (JSON.parse(r.detail_json as string) as Record<string, unknown>) : undefined,
  };
}
function toTask(r0: unknown): Task {
  const r = r0 as Row;
  return {
    id: r.id as string, projectId: r.project_id as string, title: r.title as string,
    body: r.body as string, columnKey: r.column_key as string, position: r.position as number,
    createdAt: r.created_at as string, updatedAt: r.updated_at as string,
  };
}
function toSchedule(r0: unknown): Schedule {
  const r = r0 as Row;
  return {
    id: r.id as string, topicId: r.topic_id as string, cron: r.cron as string,
    enabled: (r.enabled as number) === 1,
    nextFireAt: r.next_fire_at as string, lastFiredAt: (r.last_fired_at as string) ?? null,
    createdAt: r.created_at as string,
  };
}
