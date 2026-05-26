import Database from "better-sqlite3";
import { DB_PATH } from "./paths.js";
import type {
  Project, Topic, Session, Task, ProjectConfigOverride,
  ProcessState, Resumability, SessionListItem,
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
  last_error TEXT
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
CREATE INDEX IF NOT EXISTS idx_topics_project ON topics(project_id, position);
CREATE INDEX IF NOT EXISTS idx_sessions_topic ON sessions(topic_id, last_activity DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, column_key, position);
`;

type Row = Record<string, unknown>;

export class Db {
  private db: Database.Database;
  constructor(file = DB_PATH) {
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
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
      `INSERT INTO sessions (id,project_id,topic_id,engine_session_id,title,cwd,process_state,resumability,busy,created_at,last_activity,last_error)
       VALUES (@id,@projectId,@topicId,@engineSessionId,@title,@cwd,@processState,@resumability,@busy,@createdAt,@lastActivity,@lastError)`,
    ).run({ ...s, busy: s.busy ? 1 : 0 });
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
