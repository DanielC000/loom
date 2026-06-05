import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { DB_PATH } from "./paths.js";

/**
 * The REAL production database — `~/.loom/loom.db`, independent of any LOOM_HOME override. A worker
 * once wiped this by running a daemon integration test with no env set (the test's bare `new Db()`
 * opened it and DELETE'd everything). This is the last-line backstop against that class of accident.
 */
const REAL_PROD_DB = path.resolve(path.join(os.homedir(), ".loom", "loom.db"));

/** True when this process is marked as a test run (the test guard / `test:daemon` wrapper sets these). */
function inTestMode(): boolean {
  return process.env.LOOM_TEST === "1" || process.env.NODE_ENV === "test";
}

/**
 * Prod-guard: under a test marker, REFUSE to open the real prod DB. A hermetic test sets
 * LOOM_HOME=<temp> so DB_PATH resolves to a throwaway db and this is a no-op; only a stray
 * default-path `new Db()` with no isolation trips it. The prod daemon (no test marker) is unaffected.
 */
function assertNotProdDbInTest(file: string): void {
  if (inTestMode() && path.resolve(file) === REAL_PROD_DB) {
    throw new Error(
      "refusing to open the prod DB (~/.loom/loom.db) under a test marker (LOOM_TEST/NODE_ENV=test) — " +
        "set LOOM_HOME=<temp> so tests get an isolated database",
    );
  }
}
import type {
  Project, Agent, Session, Task, ProjectConfigOverride, PlatformConfigOverride, Profile,
  ProcessState, Resumability, SessionListItem, SessionRole,
  OrchestrationEvent, OrchestrationEventKind, Schedule, Wake,
  ApiKey, ApiKeyStatus, ApiKeyCaps, AgentRun, RunStatus,
} from "@loom/shared";
import { mintApiKey, parseApiKey, verifySecret } from "./keys/hash.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL,
  vault_path TEXT NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  archived_at TEXT,
  -- Reserved/system project flag (the seeded "Loom Platform" home). 1 = hidden from the project
  -- picker (listProjects) but still admin/Mission-Control visible. Added to existing DBs via the
  -- idempotent migration below; NOT NULL + constant DEFAULT 0 backfills legacy rows to 0 (ordinary).
  reserved INTEGER NOT NULL DEFAULT 0
);
-- Profiles (platform-level rig: role + model + permission-delta + skill-subset + icon). NO project
-- FK — a profile is cross-project, reused by agents across projects. allow_delta/skills are JSON text.
-- the description column is a UI-only blurb (NEVER injected); the startup prompt comes from the agent.
CREATE TABLE IF NOT EXISTS profiles (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT,                              -- NULL = plain | 'manager' | 'worker' | 'platform'
  description TEXT NOT NULL DEFAULT '',   -- human-facing blurb (UI only; never injected)
  allow_delta TEXT NOT NULL DEFAULT '[]', -- JSON string[] (permission allowlist delta)
  skills TEXT,                            -- JSON string[] | NULL (NULL = deliver all skills)
  model TEXT,                             -- model id | NULL (NULL = engine default)
  icon TEXT,                              -- UI icon | NULL
  browser_testing INTEGER NOT NULL DEFAULT 0 -- opt-in: inject a per-session Playwright MCP at spawn
);
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  startup_prompt TEXT NOT NULL DEFAULT '',
  position INTEGER NOT NULL DEFAULT 0,
  -- nullable Profile ref (also added to existing DBs via the idempotent migration below).
  -- plain TEXT (no FK), matching the migration's ADD COLUMN so fresh + migrated DBs converge.
  profile_id TEXT,
  -- Agent Runs R1: marks an agent API-exposable (allowlist-eligible). NOT NULL + constant DEFAULT 0 is
  -- legal on ALTER TABLE ADD COLUMN, so legacy rows backfill to 0 (not an endpoint). Fully additive —
  -- the flag changes NO spawn behavior. io_schema is an OPTIONAL JSON blob (NULL on non-endpoint agents).
  endpoint INTEGER NOT NULL DEFAULT 0,
  io_schema TEXT
);
-- Agent Runs R1: project-scoped API keys (durable, hashed at rest — NEVER plaintext). The secret is a
-- salted SHA-256 (salt+hash columns); the plaintext is shown to the human ONCE at create/rotate. A key
-- binds a project to an allowlist of its endpoint=true agents (JSON id array) + per-key caps + status.
-- Brand-new table ⇒ CREATE TABLE IF NOT EXISTS is itself the additive migration (no ALTER needed); an
-- existing DB simply gains an empty table on next boot. HUMAN-managed only (loopback REST) — no MCP tool.
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL DEFAULT '',
  salt TEXT NOT NULL,                                   -- per-key random salt (hex)
  hash TEXT NOT NULL,                                   -- salted SHA-256 of the secret (hex) — never plaintext
  endpoint_agent_ids TEXT NOT NULL DEFAULT '[]',        -- JSON string[] of allowlisted endpoint-agent ids
  max_concurrent_runs INTEGER,                          -- per-key caps (NULL = uncapped); R3/R4 enforce
  daily_token_cap INTEGER,
  daily_spend_cap REAL,
  status TEXT NOT NULL DEFAULT 'active',                -- 'active' | 'paused' | 'revoked'
  created_at TEXT NOT NULL,
  rotated_at TEXT
);
-- Agent Runs R2: ephemeral AgentRun records (one row per endpoint-agent invocation). Brand-new table ⇒
-- CREATE TABLE IF NOT EXISTS is itself the additive migration (no ALTER), exactly like api_keys; an
-- existing DB simply gains an empty table on next boot. key_id is NULL in R2 (runs are started
-- internally; R3's keyed REST sets it). input/schema/result/usage are JSON text; session_id is the 1:1
-- ephemeral run session driving the run. Runs do NOT resume — an interrupted one is failed at boot.
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
  session_id TEXT,                                      -- the ephemeral run session (1:1; NULL pre-spawn)
  key_id TEXT,                                          -- triggering API key (NULL in R2; R3 sets it)
  status TEXT NOT NULL DEFAULT 'queued',                -- queued|starting|running|completed|failed|timed_out|cancelled
  input_json TEXT NOT NULL DEFAULT 'null',              -- caller input (JSON)
  schema_json TEXT,                                     -- caller-supplied JSON Schema (NULL ⇒ freeform)
  result_json TEXT,                                     -- submit_result payload (NULL until completed)
  usage_json TEXT,                                      -- usage snapshot at teardown (NULL until then)
  transcript_ref TEXT,                                  -- retained transcript snapshot pointer
  error TEXT,                                           -- terminal error detail (failed/timed_out)
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  agent_id TEXT NOT NULL REFERENCES agents(id),
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
  -- opt-in browser-automation, pinned at spawn from the session's Profile (mirrors role): a
  -- per-session Playwright MCP is injected iff 1. Carried across every respawn (resume/fork/recycle).
  browser_testing INTEGER NOT NULL DEFAULT 0,
  parent_session_id TEXT,
  task_id TEXT,
  worktree_path TEXT,
  branch TEXT,
  gen INTEGER DEFAULT 0,
  recycled_from TEXT,
  ctx_input_tokens INTEGER,
  ctx_turns INTEGER,
  ctx_updated_at TEXT,
  model TEXT,
  rate_limited_until TEXT,
  rate_limit_deadline TEXT,
  -- Asleep-at-the-Wheel idle watchdog per-manager state (foundation; nothing reads it yet). Added to
  -- existing DBs via the idempotent migration below; mirrors the rate-limit columns above.
  idle_nudge_policy TEXT NOT NULL DEFAULT 'watching', -- 'watching' | 'snoozed' | 'suppressed'
  idle_nudge_snooze_until TEXT,                        -- ISO ts | NULL (silent until this passes)
  last_idle_nudge_at TEXT,                             -- ISO ts | NULL (last nudge fired)
  idle_nudge_unanswered INTEGER NOT NULL DEFAULT 0,    -- consecutive unanswered nudges
  -- Per-project session Archive (mirrors projects.archived_at): the ISO instant a dead/exited
  -- session was archived out of the rail. NULL = not archived. Excluded from the live lists.
  archived_at TEXT
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
  -- p0 (critical) → p3 (low); default p2 (normal). Added to existing DBs via migrateTasks() below.
  priority TEXT NOT NULL DEFAULT 'p2',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Cron-triggered schedules (phase-2 Pillar B): the daemon Scheduler boots a manager on the tick.
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  cron TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  next_fire_at TEXT NOT NULL,
  last_fired_at TEXT,
  created_at TEXT NOT NULL,
  -- What a fired schedule spawns (Platform Manager P5): 'manager' (default) or 'auditor' (the
  -- read-and-file-only Platform Auditor, spawned via startAuditor). Legacy rows backfill to 'manager'.
  kind TEXT NOT NULL DEFAULT 'manager'
);
-- One-shot self-scheduled wake-ups (the agent wake_me primitive): the daemon WakeService
-- re-nudges session_id with its note when wake_at passes, then deletes the row (one-shot).
CREATE TABLE IF NOT EXISTS wakes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  wake_at TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- Daemon-GLOBAL platform tuning override (rate-limit numbers / watcher cadences / op timeouts), held
-- as a single JSON blob in a SINGLETON row (id pinned to 1 by the CHECK). NOT per-project — the daemon
-- shares one of these (like backup/schedulerEnabled). Persisted in SQLite so a backup captures it. The
-- daemon reads override_json, resolveConfig(undefined, override) merges it BENEATH per-project values.
-- Additive: CREATE TABLE IF NOT EXISTS, so existing DBs get an empty store (→ {} → platform defaults).
CREATE TABLE IF NOT EXISTS platform_config (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  override_json TEXT NOT NULL DEFAULT '{}',
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id, position);
CREATE INDEX IF NOT EXISTS idx_api_keys_project ON api_keys(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_fire_at);
CREATE INDEX IF NOT EXISTS idx_wakes_due ON wakes(wake_at);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id, last_activity DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, column_key, position);
CREATE INDEX IF NOT EXISTS idx_orch_events_mgr ON orchestration_events(manager_session_id, ts);
`;

/** Columns added to `sessions` after phase-1; applied to existing DBs by migrateSessions(). */
const SESSION_ADDED_COLUMNS: Record<string, string> = {
  role: "TEXT",
  // opt-in browser-automation (pinned at spawn from the Profile; carried across respawns). NOT NULL +
  // constant DEFAULT is legal on ALTER TABLE ADD COLUMN, so legacy rows backfill to 0 (off).
  browser_testing: "INTEGER NOT NULL DEFAULT 0",
  parent_session_id: "TEXT",
  task_id: "TEXT",
  worktree_path: "TEXT",
  branch: "TEXT",
  gen: "INTEGER DEFAULT 0",
  recycled_from: "TEXT",
  ctx_input_tokens: "INTEGER",
  ctx_turns: "INTEGER",
  ctx_updated_at: "TEXT",
  model: "TEXT",
  rate_limited_until: "TEXT",
  rate_limit_deadline: "TEXT",
  // Asleep-at-the-Wheel idle watchdog state (foundation). NOT NULL + constant DEFAULT is legal on
  // ALTER TABLE ADD COLUMN, so legacy rows backfill to 'watching' / 0.
  idle_nudge_policy: "TEXT NOT NULL DEFAULT 'watching'",
  idle_nudge_snooze_until: "TEXT",
  last_idle_nudge_at: "TEXT",
  idle_nudge_unanswered: "INTEGER NOT NULL DEFAULT 0",
  // Per-project session Archive (nullable; legacy rows backfill to NULL = not archived).
  archived_at: "TEXT",
};

/** Columns added to `projects` after phase-1; applied to existing DBs by migrateProjects(). */
const PROJECT_ADDED_COLUMNS: Record<string, string> = {
  // Reserved/system project flag (Platform Manager P1). NOT NULL + constant DEFAULT 0 is legal on
  // ALTER TABLE ADD COLUMN, so every legacy project row backfills to 0 (ordinary, picker-visible).
  reserved: "INTEGER NOT NULL DEFAULT 0",
};

/** Columns added to `agents` after phase-1; applied to existing DBs by migrateAgents(). */
const AGENT_ADDED_COLUMNS: Record<string, string> = {
  profile_id: "TEXT",
  // Agent Runs R1: API-exposable flag (NOT NULL + constant DEFAULT 0 is legal on ALTER TABLE ADD
  // COLUMN, so legacy rows backfill to endpoint=0) + an optional JSON I/O schema blob (NULL on legacy).
  endpoint: "INTEGER NOT NULL DEFAULT 0",
  io_schema: "TEXT",
};

/** Columns added to `profiles` after the initial rig schema; applied to existing DBs by migrateProfiles(). */
const PROFILE_ADDED_COLUMNS: Record<string, string> = {
  // opt-in browser-automation flag; NOT NULL + constant DEFAULT backfills legacy rows to 0 (off).
  browser_testing: "INTEGER NOT NULL DEFAULT 0",
};

/** Columns added to `schedules` after phase-2; applied to existing DBs by migrateSchedules(). */
const SCHEDULE_ADDED_COLUMNS: Record<string, string> = {
  // Platform Manager P5: what a fired schedule spawns. NOT NULL + constant DEFAULT 'manager' is legal
  // on ALTER TABLE ADD COLUMN, so every legacy schedule row backfills to 'manager' (today's behavior).
  kind: "TEXT NOT NULL DEFAULT 'manager'",
};

/** Columns added to `tasks` after phase-1; applied to existing DBs by migrateTasks(). */
const TASK_ADDED_COLUMNS: Record<string, string> = {
  // p0 (critical) → p3 (low). NOT NULL + constant DEFAULT 'p2' is legal on ALTER TABLE ADD COLUMN, so
  // every legacy row backfills to 'p2' (Normal) in place — existing cards keep all other fields intact.
  priority: "TEXT NOT NULL DEFAULT 'p2'",
};

type Row = Record<string, unknown>;

/**
 * Agent Runs R1 — the db-INTERNAL api-key record: the public {@link ApiKey} metadata PLUS the
 * salt+hash that never leave the daemon. The REST layer maps this to the public `ApiKey` (dropping
 * salt/hash) so the secret material is never serialized to a client. Returned only by internal
 * accessors (getApiKeyRecord / authenticate); the public list/get accessors return `ApiKey`.
 */
export interface ApiKeyRecord extends ApiKey {
  salt: string;
  hash: string;
}

/** Result of authenticating a presented API-key token (Agent Runs R1; nothing CALLS auth yet — R3 does). */
export type ApiKeyAuth =
  | { ok: true; key: ApiKey }
  | { ok: false; reason: "malformed" | "unknown" | "bad-secret" | "paused" | "revoked" };

/** Asleep-at-the-Wheel idle-watchdog nudge policy (foundation). */
export type IdleNudgePolicy = "watching" | "snoozed" | "suppressed";
/** Per-manager idle-watchdog state read back from the sessions row (db-layer, parity w/ rate-limit). */
export interface IdleNudgeState {
  policy: IdleNudgePolicy;
  snoozeUntil: string | null;
  lastIdleNudgeAt: string | null;
  unanswered: number;
}

export class Db {
  private db: Database.Database;
  /**
   * Optional post-write listener for appended orchestration events — the chokepoint the outbound
   * alert-webhook emitter hooks (wired at boot). Invoked AFTER the audit row is committed, in a
   * try/catch, so a listener fault NEVER breaks the event path (best-effort by contract). Single
   * listener by design (one emitter); not an event-bus.
   */
  private eventListener?: (evt: OrchestrationEvent) => void;
  constructor(file = DB_PATH) {
    assertNotProdDbInTest(file);
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    // One-shot structural rename (topics→agents) MUST run before exec(SCHEMA) — see the method doc.
    this.migrateTopicsToAgents();
    this.db.exec(SCHEMA);
    this.migrateSessions();
    this.migrateProjects();
    this.migrateAgents();
    this.migrateProfiles();
    this.migrateTasks();
    this.migrateSchedules();
  }

  /**
   * One-shot structural migration: rename the legacy `topics` table → `agents` (and the FK columns
   * `sessions.topic_id` / `schedules.topic_id` → `agent_id`, plus `profiles.startup_prompt` →
   * `description`). Unlike the additive migrations below this is a true rename of existing data.
   *
   * GUARD: runs EXACTLY once, only on a legacy DB — fires only when `topics` exists AND `agents` does
   * not. CRITICAL ORDERING: it MUST run BEFORE exec(SCHEMA). SCHEMA's `CREATE TABLE IF NOT EXISTS
   * agents` would otherwise create an empty `agents` table first, defeating the guard and orphaning
   * the real rows still sitting in `topics`. better-sqlite3 bundles SQLite ≥3.25, so RENAME COLUMN is
   * supported and (with legacy_alter_table OFF, the default) RENAME TO auto-rewrites the FK references
   * in `sessions`/`schedules`. Wrapped in a transaction → a failure rolls back to the legacy schema.
   */
  private migrateTopicsToAgents(): void {
    const tables = new Set(
      (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map((t) => t.name),
    );
    if (!tables.has("topics") || tables.has("agents")) return;
    this.db.transaction(() => {
      this.db.exec("ALTER TABLE topics RENAME TO agents");
      // Guard each FK-column rename by table existence: in prod these always coexist with `topics`,
      // but this runs BEFORE exec(SCHEMA), so a minimal/legacy DB may not have them all yet.
      if (tables.has("sessions")) this.db.exec("ALTER TABLE sessions RENAME COLUMN topic_id TO agent_id");
      if (tables.has("schedules")) this.db.exec("ALTER TABLE schedules RENAME COLUMN topic_id TO agent_id");
      // `profiles` postdates `topics` but predates this rename; rename its prompt column → UI blurb
      // only when present (a pre-profiles legacy DB has no profiles table yet — SCHEMA creates it
      // after this runs; PRAGMA on an absent table returns an empty set, so this safely no-ops).
      const profileCols = new Set(
        (this.db.prepare("PRAGMA table_info(profiles)").all() as { name: string }[]).map((c) => c.name),
      );
      if (profileCols.has("startup_prompt") && !profileCols.has("description")) {
        this.db.exec("ALTER TABLE profiles RENAME COLUMN startup_prompt TO description");
      }
      // Drop the legacy-named indexes; SCHEMA recreates them as idx_agents_project / idx_sessions_agent.
      // (RENAME keeps the old index names pointing at the renamed table/column → otherwise duplicates.)
      this.db.exec("DROP INDEX IF EXISTS idx_topics_project");
      this.db.exec("DROP INDEX IF EXISTS idx_sessions_topic");
    })();
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

  /**
   * Idempotent additive migration for `projects` — ADD COLUMN any post-phase-1 column missing from
   * an existing DB (fresh installs already have them via CREATE TABLE). Mirrors migrateAgents; the
   * NOT NULL + constant DEFAULT 0 backfills every legacy project row to reserved=0 (ordinary).
   */
  private migrateProjects(): void {
    const have = new Set(
      (this.db.prepare("PRAGMA table_info(projects)").all() as { name: string }[]).map((c) => c.name),
    );
    for (const [name, type] of Object.entries(PROJECT_ADDED_COLUMNS)) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE projects ADD COLUMN ${name} ${type}`);
    }
  }

  /**
   * Idempotent additive migration for `agents` — ADD COLUMN any post-phase-1 column missing from an
   * existing DB (fresh installs already have them via CREATE TABLE). Mirrors migrateSessions; the
   * nullable `profile_id` defaults to NULL on legacy rows ⇒ resolveProfile maps them to today's
   * behavior. Runs after migrateTopicsToAgents + exec(SCHEMA), so the `agents` table always exists.
   */
  private migrateAgents(): void {
    const have = new Set(
      (this.db.prepare("PRAGMA table_info(agents)").all() as { name: string }[]).map((c) => c.name),
    );
    for (const [name, type] of Object.entries(AGENT_ADDED_COLUMNS)) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE agents ADD COLUMN ${name} ${type}`);
    }
  }

  /**
   * Idempotent additive migration for `profiles` — ADD COLUMN any post-rig column missing from an
   * existing DB (fresh installs already have them via CREATE TABLE). Mirrors migrateAgents; legacy
   * rows backfill to the column DEFAULT (browser_testing → 0 = off, today's behavior).
   */
  private migrateProfiles(): void {
    const have = new Set(
      (this.db.prepare("PRAGMA table_info(profiles)").all() as { name: string }[]).map((c) => c.name),
    );
    for (const [name, type] of Object.entries(PROFILE_ADDED_COLUMNS)) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE profiles ADD COLUMN ${name} ${type}`);
    }
  }

  /**
   * Idempotent additive migration for `tasks` — ADD COLUMN any post-phase-1 column missing from an
   * existing DB (fresh installs already have them via CREATE TABLE). Mirrors migrateProfiles; the
   * NOT NULL + constant DEFAULT 'p2' backfills every legacy task row to Normal priority in place,
   * leaving its other fields untouched.
   */
  private migrateTasks(): void {
    const have = new Set(
      (this.db.prepare("PRAGMA table_info(tasks)").all() as { name: string }[]).map((c) => c.name),
    );
    for (const [name, type] of Object.entries(TASK_ADDED_COLUMNS)) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE tasks ADD COLUMN ${name} ${type}`);
    }
  }

  /**
   * Idempotent additive migration for `schedules` (Platform Manager P5) — ADD COLUMN any post-phase-2
   * column missing from an existing DB (fresh installs already have them via CREATE TABLE). Mirrors
   * migrateTasks; the NOT NULL + constant DEFAULT 'manager' backfills every legacy schedule row to
   * kind='manager' in place, so existing schedules keep booting a manager exactly as before.
   */
  private migrateSchedules(): void {
    const have = new Set(
      (this.db.prepare("PRAGMA table_info(schedules)").all() as { name: string }[]).map((c) => c.name),
    );
    for (const [name, type] of Object.entries(SCHEDULE_ADDED_COLUMNS)) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE schedules ADD COLUMN ${name} ${type}`);
    }
  }

  /** Release the SQLite handle (used by hermetic tests to free the file before cleanup). */
  close(): void {
    this.db.close();
  }

  // --- projects ---
  /**
   * The project PICKER feed (GET /api/projects → the web project selector). EXCLUDES reserved/system
   * projects (the seeded "Loom Platform" home) as well as archived ones — a reserved project is a
   * Loom-internal admin scope, never an ordinary pick target. Admin/god-eye surfaces that must see the
   * platform home use listAllProjects(); Mission Control gets it for free via listAllSessions (which
   * JOINs the project name by id, with no reserved filter).
   */
  listProjects(): Project[] {
    return this.db.prepare("SELECT * FROM projects WHERE archived_at IS NULL AND reserved = 0 ORDER BY name")
      .all().map(toProject);
  }
  /**
   * INCLUSIVE list — every live project INCLUDING reserved/system ones (still excludes archived).
   * For admin/platform surfaces that legitimately need the platform home alongside ordinary projects;
   * the ordinary picker uses listProjects() (reserved excluded).
   */
  listAllProjects(): Project[] {
    return this.db.prepare("SELECT * FROM projects WHERE archived_at IS NULL ORDER BY name")
      .all().map(toProject);
  }
  /** True iff a reserved/system project already exists — the idempotency gate for seedPlatformHome. */
  hasReservedProject(): boolean {
    return !!this.db.prepare("SELECT 1 FROM projects WHERE reserved = 1 LIMIT 1").get();
  }
  getProject(id: string): Project | undefined {
    const r = this.db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as Row | undefined;
    return r ? toProject(r) : undefined;
  }
  insertProject(p: Project): void {
    this.db.prepare(
      `INSERT INTO projects (id,name,repo_path,vault_path,config_json,created_at,archived_at,reserved)
       VALUES (@id,@name,@repoPath,@vaultPath,@config,@createdAt,@archivedAt,@reserved)`,
    ).run({ ...p, config: JSON.stringify(p.config), archivedAt: p.archivedAt, reserved: p.reserved ? 1 : 0 });
  }
  /**
   * Partial STRUCTURAL edit of a project (name / vaultPath). Provided fields are written; omitted
   * are left as-is. Deliberately does NOT touch config (that goes through the validated
   * setProjectConfig path) or repoPath (rebinding a live project's repo is out of scope).
   */
  updateProject(id: string, patch: { name?: string; vaultPath?: string }): void {
    const cols: Record<string, unknown> = { name: patch.name, vault_path: patch.vaultPath };
    const names = Object.keys(cols).filter((k) => cols[k] !== undefined);
    if (names.length === 0) return;
    const set = names.map((c) => `${c} = ?`).join(", ");
    this.db.prepare(`UPDATE projects SET ${set} WHERE id = ?`).run(...names.map((c) => cols[c]), id);
  }
  /** Replace a project's config override (Pillar C project_configure / PATCH config). */
  setProjectConfig(id: string, config: ProjectConfigOverride): void {
    this.db.prepare("UPDATE projects SET config_json = ? WHERE id = ?").run(JSON.stringify(config), id);
  }
  /** Soft-remove a project: stamp archived_at so listProjects() hides it (rows + sessions kept). */
  archiveProject(id: string): void {
    this.db.prepare("UPDATE projects SET archived_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }

  // --- platform config (daemon-GLOBAL tuning override; singleton row, JSON blob) ---
  /**
   * Read the daemon-global platform override blob. Returns `{}` when the singleton row is absent
   * (fresh/empty store) OR its JSON is unparseable — a corrupt blob must never wedge boot, so we
   * try/catch → `{}` (today's behavior: platform defaults). The caller threads the result into
   * resolveConfig's 2nd arg; it is NOT re-validated here (the human PATCH path validates on write).
   */
  getPlatformConfig(): PlatformConfigOverride {
    const r = this.db.prepare("SELECT override_json FROM platform_config WHERE id = 1").get() as Row | undefined;
    if (!r) return {};
    try {
      return (JSON.parse((r.override_json as string) || "{}") as PlatformConfigOverride) ?? {};
    } catch {
      return {};
    }
  }
  /** Upsert the singleton platform override blob (validated by the caller); stamps updated_at. */
  setPlatformConfig(override: PlatformConfigOverride): void {
    this.db.prepare(
      `INSERT INTO platform_config (id, override_json, updated_at) VALUES (1, @json, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET override_json = @json, updated_at = @updatedAt`,
    ).run({ json: JSON.stringify(override ?? {}), updatedAt: new Date().toISOString() });
  }

  // --- agents ---
  listAgents(projectId: string): Agent[] {
    return this.db.prepare("SELECT * FROM agents WHERE project_id = ? ORDER BY position")
      .all(projectId).map(toAgent);
  }
  getAgent(id: string): Agent | undefined {
    const r = this.db.prepare("SELECT * FROM agents WHERE id = ?").get(id) as Row | undefined;
    return r ? toAgent(r) : undefined;
  }
  insertAgent(a: Agent): void {
    this.db.prepare(
      `INSERT INTO agents (id,project_id,name,startup_prompt,position,profile_id,endpoint,io_schema)
       VALUES (@id,@projectId,@name,@startupPrompt,@position,@profileId,@endpoint,@ioSchema)`,
    ).run({
      ...a, profileId: a.profileId ?? null,
      // Agent Runs R1: absent on plain phase-1/2 agent literals ⇒ endpoint 0 + io_schema NULL (additive).
      endpoint: a.endpoint ? 1 : 0,
      ioSchema: a.ioSchema == null ? null : JSON.stringify(a.ioSchema),
    });
  }
  /**
   * Partial edit of an agent (name / startup prompt / assigned Profile). Omitted fields are left
   * as-is; `profileId: null` CLEARS the assignment (agent falls back to resolveProfile's plain
   * backstop). `?? null` coerces a provided-but-undefined value so an explicit clear reaches the
   * column (a truly absent key is filtered out and left as-is).
   */
  updateAgent(id: string, patch: { name?: string; startupPrompt?: string; profileId?: string | null; endpoint?: boolean; ioSchema?: unknown | null }): void {
    const cols: Record<string, unknown> = {
      name: patch.name,
      startup_prompt: patch.startupPrompt,
      // present (incl. null → clear) writes; absent (undefined) is filtered out below and left as-is.
      profile_id: "profileId" in patch ? patch.profileId ?? null : undefined,
      // Agent Runs R1 (HUMAN-only — only the agent-edit REST surface passes these; no MCP path does,
      // so an agent can never flip its own endpoint flag). `endpoint` present writes 0/1; `ioSchema`
      // present writes JSON text (null clears). updateAgentPreset/assign_profile omit both ⇒ left as-is.
      endpoint: patch.endpoint === undefined ? undefined : patch.endpoint ? 1 : 0,
      io_schema: "ioSchema" in patch ? (patch.ioSchema == null ? null : JSON.stringify(patch.ioSchema)) : undefined,
    };
    const names = Object.keys(cols).filter((k) => cols[k] !== undefined);
    if (names.length === 0) return;
    const set = names.map((c) => `${c} = ?`).join(", ");
    this.db.prepare(`UPDATE agents SET ${set} WHERE id = ?`).run(...names.map((c) => cols[c]), id);
  }

  // --- api keys (Agent Runs R1: project-scoped, hashed-at-rest, human-managed) -------------------
  // Durable in SQLite ("SQLite owns durable state"). The SECRET never persists — only a salted SHA-256
  // (salt+hash); the plaintext is returned ONCE by createApiKey/rotateApiKey and never again. The
  // PUBLIC accessors (listApiKeys/getApiKey) return `ApiKey` metadata with no salt/hash; the internal
  // record (getApiKeyRecord/authenticate) keeps them daemon-side. There is intentionally NO MCP path to
  // any of this — only the loopback human REST surface calls these (trust boundary like the git/vault writers).

  /** True iff every id is an `endpoint=true` agent in `projectId` — the allowlist-eligibility gate.
   *  Returns the first offending id (a non-endpoint, wrong-project, or unknown agent) so the caller can 400. */
  validateEndpointAllowlist(projectId: string, agentIds: string[]): { ok: true } | { ok: false; badId: string } {
    for (const id of agentIds) {
      const a = this.getAgent(id);
      if (!a || a.projectId !== projectId || !a.endpoint) return { ok: false, badId: id };
    }
    return { ok: true };
  }

  /**
   * Mint a project API key: persist the salt+hash (never the secret) + metadata, and RETURN the
   * one-time plaintext token alongside the stored public metadata. The ONLY place the plaintext exists.
   */
  createApiKey(input: {
    projectId: string; name: string; endpointAgentIds: string[]; caps: ApiKeyCaps; status?: ApiKeyStatus;
  }): { key: ApiKey; plaintext: string } {
    const minted = mintApiKey();
    const createdAt = new Date().toISOString();
    const rec: ApiKeyRecord = {
      id: minted.id, projectId: input.projectId, name: input.name,
      endpointAgentIds: input.endpointAgentIds, caps: input.caps,
      status: input.status ?? "active", createdAt, rotatedAt: null,
      salt: minted.salt, hash: minted.hash,
    };
    this.insertApiKeyRecord(rec);
    return { key: toApiKeyPublic(rec), plaintext: minted.plaintext };
  }

  private insertApiKeyRecord(rec: ApiKeyRecord): void {
    this.db.prepare(
      `INSERT INTO api_keys
         (id,project_id,name,salt,hash,endpoint_agent_ids,max_concurrent_runs,daily_token_cap,daily_spend_cap,status,created_at,rotated_at)
       VALUES (@id,@projectId,@name,@salt,@hash,@endpointAgentIds,@maxConcurrentRuns,@dailyTokenCap,@dailySpendCap,@status,@createdAt,@rotatedAt)`,
    ).run({
      id: rec.id, projectId: rec.projectId, name: rec.name, salt: rec.salt, hash: rec.hash,
      endpointAgentIds: JSON.stringify(rec.endpointAgentIds ?? []),
      maxConcurrentRuns: rec.caps.maxConcurrentRuns ?? null,
      dailyTokenCap: rec.caps.dailyTokenCap ?? null,
      dailySpendCap: rec.caps.dailySpendCap ?? null,
      status: rec.status, createdAt: rec.createdAt, rotatedAt: rec.rotatedAt ?? null,
    });
  }

  /** A project's keys as PUBLIC metadata (NO secret/hash), newest first. */
  listApiKeys(projectId: string): ApiKey[] {
    return (this.db.prepare("SELECT * FROM api_keys WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as Row[])
      .map(toApiKeyRecord).map(toApiKeyPublic);
  }
  /** One key as PUBLIC metadata (NO secret/hash); undefined if absent. */
  getApiKey(id: string): ApiKey | undefined {
    const rec = this.getApiKeyRecord(id);
    return rec ? toApiKeyPublic(rec) : undefined;
  }
  /** INTERNAL: the full record incl. salt+hash (for authenticate). Never serialize this to a client. */
  getApiKeyRecord(id: string): ApiKeyRecord | undefined {
    const r = this.db.prepare("SELECT * FROM api_keys WHERE id = ?").get(id) as Row | undefined;
    return r ? toApiKeyRecord(r) : undefined;
  }

  /** Partial edit of a key's metadata — allowlist / caps / status / name. Omitted fields are left as-is.
   *  The secret is NEVER touched here (rotateApiKey is the only secret-changing path). */
  updateApiKey(id: string, patch: { name?: string; endpointAgentIds?: string[]; caps?: ApiKeyCaps; status?: ApiKeyStatus }): void {
    const cols: Record<string, unknown> = {
      name: patch.name,
      endpoint_agent_ids: patch.endpointAgentIds === undefined ? undefined : JSON.stringify(patch.endpointAgentIds),
      max_concurrent_runs: patch.caps === undefined ? undefined : patch.caps.maxConcurrentRuns ?? null,
      daily_token_cap: patch.caps === undefined ? undefined : patch.caps.dailyTokenCap ?? null,
      daily_spend_cap: patch.caps === undefined ? undefined : patch.caps.dailySpendCap ?? null,
      status: patch.status,
    };
    const names = Object.keys(cols).filter((k) => cols[k] !== undefined);
    if (names.length === 0) return;
    const set = names.map((c) => `${c} = ?`).join(", ");
    this.db.prepare(`UPDATE api_keys SET ${set} WHERE id = ?`).run(...names.map((c) => cols[c]), id);
  }

  /**
   * Rotate a key's SECRET: mint a fresh secret for the SAME row id, overwrite salt+hash, stamp
   * rotated_at. The old plaintext stops verifying immediately (different hash); the new plaintext is
   * returned ONCE. Identity, allowlist, caps and status are preserved. Returns null if the id is unknown.
   */
  rotateApiKey(id: string): { key: ApiKey; plaintext: string } | null {
    const existing = this.getApiKeyRecord(id);
    if (!existing) return null;
    const minted = mintApiKey(id); // same id ⇒ row identity preserved, only the secret changes
    const rotatedAt = new Date().toISOString();
    this.db.prepare("UPDATE api_keys SET salt = ?, hash = ?, rotated_at = ? WHERE id = ?")
      .run(minted.salt, minted.hash, rotatedAt, id);
    return { key: toApiKeyPublic({ ...existing, salt: minted.salt, hash: minted.hash, rotatedAt }), plaintext: minted.plaintext };
  }

  /** Permanently delete a key row (hard revoke + cleanup). A soft revoke is `updateApiKey(id, {status:'revoked'})`. */
  deleteApiKey(id: string): void {
    this.db.prepare("DELETE FROM api_keys WHERE id = ?").run(id);
  }

  /**
   * Authenticate a presented token (Agent Runs R1 builds it; R3's run REST is the first CALLER).
   * Parse → O(1) lookup by embedded id → CONSTANT-TIME secret verify → status gate. Verify the secret
   * BEFORE consulting status so a wrong secret never reveals whether a key is paused/revoked.
   */
  authenticateApiKey(token: unknown): ApiKeyAuth {
    const parsed = parseApiKey(token);
    if (!parsed) return { ok: false, reason: "malformed" };
    const rec = this.getApiKeyRecord(parsed.id);
    if (!rec) return { ok: false, reason: "unknown" };
    if (!verifySecret(parsed.secret, rec.salt, rec.hash)) return { ok: false, reason: "bad-secret" };
    if (rec.status === "revoked") return { ok: false, reason: "revoked" };
    if (rec.status === "paused") return { ok: false, reason: "paused" };
    return { ok: true, key: toApiKeyPublic(rec) };
  }

  // --- agent runs (R2: ephemeral AgentRun records) ----------------------------------------------
  // Durable in SQLite. The run row is the source of truth for a run's lifecycle; the ephemeral `run`
  // session that drives it is 1:1 via session_id. JSON columns (input/schema/result/usage) round-trip
  // through toRun. Internal-only in R2 (the run-starter calls insertRun/setRun*); R3's keyed REST layers on.

  insertRun(r: AgentRun): void {
    this.db.prepare(
      `INSERT INTO runs
         (id,project_id,agent_id,session_id,key_id,status,input_json,schema_json,result_json,usage_json,transcript_ref,error,created_at,started_at,ended_at)
       VALUES
         (@id,@projectId,@agentId,@sessionId,@keyId,@status,@inputJson,@schemaJson,@resultJson,@usageJson,@transcriptRef,@error,@createdAt,@startedAt,@endedAt)`,
    ).run({
      id: r.id, projectId: r.projectId, agentId: r.agentId,
      sessionId: r.sessionId ?? null, keyId: r.keyId ?? null, status: r.status,
      inputJson: JSON.stringify(r.input ?? null),
      schemaJson: r.schema == null ? null : JSON.stringify(r.schema),
      resultJson: r.result == null ? null : JSON.stringify(r.result),
      usageJson: r.usage == null ? null : JSON.stringify(r.usage),
      transcriptRef: r.transcriptRef ?? null, error: r.error ?? null,
      createdAt: r.createdAt, startedAt: r.startedAt ?? null, endedAt: r.endedAt ?? null,
    });
  }
  getRun(id: string): AgentRun | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
    return row ? toRun(row) : undefined;
  }
  /** The run driving a given `run` session (1:1) — the run MCP resolves session→run server-side. */
  getRunBySession(sessionId: string): AgentRun | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE session_id = ?").get(sessionId) as Row | undefined;
    return row ? toRun(row) : undefined;
  }
  /** A project's runs, newest first (R3's "Runs" view + diagnostics). */
  listRuns(projectId: string): AgentRun[] {
    return (this.db.prepare("SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC").all(projectId) as Row[]).map(toRun);
  }
  /** Move a run to a (typically in-flight) status, optionally stamping started_at. */
  setRunStatus(id: string, status: RunStatus, opts: { startedAt?: string } = {}): void {
    const cols: Record<string, unknown> = { status, started_at: opts.startedAt };
    const names = Object.keys(cols).filter((k) => cols[k] !== undefined);
    const set = names.map((c) => `${c} = ?`).join(", ");
    this.db.prepare(`UPDATE runs SET ${set} WHERE id = ?`).run(...names.map((c) => cols[c]), id);
  }
  /** Record a completed run's result and mark it terminal (status=completed, ended_at stamped). */
  recordRunResult(id: string, result: unknown, endedAt = new Date().toISOString()): void {
    this.db.prepare("UPDATE runs SET result_json = ?, status = 'completed', ended_at = ? WHERE id = ?")
      .run(JSON.stringify(result ?? null), endedAt, id);
  }
  /** Mark a run terminally failed/timed_out/cancelled with an error detail (idempotent for already-terminal). */
  failRun(id: string, error: string, status: Extract<RunStatus, "failed" | "timed_out" | "cancelled"> = "failed", endedAt = new Date().toISOString()): void {
    this.db.prepare("UPDATE runs SET status = ?, error = ?, ended_at = ? WHERE id = ?").run(status, error, endedAt, id);
  }
  /** Retain a run's usage snapshot + transcript pointer at teardown (omitted fields left as-is). */
  setRunTeardown(id: string, patch: { usage?: unknown; transcriptRef?: string | null }): void {
    const cols: Record<string, unknown> = {
      usage_json: patch.usage === undefined ? undefined : patch.usage == null ? null : JSON.stringify(patch.usage),
      transcript_ref: "transcriptRef" in patch ? patch.transcriptRef ?? null : undefined,
    };
    const names = Object.keys(cols).filter((k) => cols[k] !== undefined);
    if (names.length === 0) return;
    const set = names.map((c) => `${c} = ?`).join(", ");
    this.db.prepare(`UPDATE runs SET ${set} WHERE id = ?`).run(...names.map((c) => cols[c]), id);
  }
  /** In-flight (non-terminal) runs — the boot reconcile fails these (runs do NOT resume). */
  listInterruptedRuns(): AgentRun[] {
    return (this.db.prepare("SELECT * FROM runs WHERE status IN ('queued','starting','running') ORDER BY created_at").all() as Row[]).map(toRun);
  }

  // --- profiles (platform-level rigs; read path + seed) ---
  listProfiles(): Profile[] {
    return (this.db.prepare("SELECT * FROM profiles ORDER BY name").all() as Row[]).map(toProfile);
  }
  getProfile(id: string): Profile | undefined {
    const r = this.db.prepare("SELECT * FROM profiles WHERE id = ?").get(id) as Row | undefined;
    return r ? toProfile(r) : undefined;
  }
  insertProfile(p: Profile): void {
    this.db.prepare(
      `INSERT INTO profiles (id,name,role,description,allow_delta,skills,model,icon,browser_testing)
       VALUES (@id,@name,@role,@description,@allowDelta,@skills,@model,@icon,@browserTesting)`,
    ).run({
      id: p.id, name: p.name, role: p.role ?? null, description: p.description,
      // string[] columns persist as JSON text; skills NULL means "deliver all".
      allowDelta: JSON.stringify(p.allowDelta ?? []),
      skills: p.skills == null ? null : JSON.stringify(p.skills),
      model: p.model ?? null, icon: p.icon ?? null,
      browserTesting: p.browserTesting ? 1 : 0, // boolean ↔ INTEGER; absent ⇒ 0 (off)
    });
  }
  /** Partial edit of a profile. Provided fields are written (null clears); omitted are left as-is. */
  updateProfile(id: string, patch: Partial<Omit<Profile, "id">>): void {
    const cols: Record<string, unknown> = {
      name: patch.name,
      role: patch.role,
      description: patch.description,
      allow_delta: patch.allowDelta === undefined ? undefined : JSON.stringify(patch.allowDelta),
      skills: patch.skills === undefined ? undefined : patch.skills === null ? null : JSON.stringify(patch.skills),
      model: patch.model,
      icon: patch.icon,
      browser_testing: patch.browserTesting === undefined ? undefined : patch.browserTesting ? 1 : 0,
    };
    const names = Object.keys(cols).filter((k) => cols[k] !== undefined);
    if (names.length === 0) return;
    const set = names.map((c) => `${c} = ?`).join(", ");
    this.db.prepare(`UPDATE profiles SET ${set} WHERE id = ?`).run(...names.map((c) => cols[c]), id);
  }
  /**
   * Delete a profile. SAFE for assigned agents: an agent whose profile_id now dangles resolves to the
   * plain backstop via resolveProfile (getProfile → undefined). A bundled profile re-seeds on next
   * boot (seed-if-absent), so deleting one is non-destructive.
   */
  deleteProfile(id: string): void {
    this.db.prepare("DELETE FROM profiles WHERE id = ?").run(id);
  }

  // --- sessions ---
  // The rail/god-eye lists (listSessions/listAllSessions/listWorkers) EXCLUDE archived sessions so
  // archiving clears them from Workspace/Terminals/Mission Control/Orchestration; the Archive tab
  // reads them back via listArchivedSessions. getSession is unfiltered (an archived row is still
  // addressable by id — the transcript route + restore/delete need it).
  listSessions(agentId: string): Session[] {
    return this.db.prepare("SELECT * FROM sessions WHERE agent_id = ? AND archived_at IS NULL ORDER BY last_activity DESC")
      .all(agentId).map(toSession);
  }
  getSession(id: string): Session | undefined {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
    return r ? toSession(r) : undefined;
  }
  /** All sessions across all projects, enriched with project/agent names (global grid). */
  listAllSessions(): SessionListItem[] {
    const rows = this.db.prepare(
      `SELECT s.*, p.name AS project_name, a.name AS agent_name
       FROM sessions s JOIN projects p ON s.project_id = p.id JOIN agents a ON s.agent_id = a.id
       WHERE s.archived_at IS NULL
       ORDER BY s.last_activity DESC`,
    ).all() as Row[];
    return rows.map((r) => ({ ...toSession(r), projectName: r.project_name as string, agentName: r.agent_name as string }));
  }
  /**
   * EVERY session including archived, enriched with names — for the boot-time orchestration reconcile
   * ONLY (finish orphaned merges + GC orphaned worktrees). An archived worker whose worktree still
   * lingers must still be reconciled, so this deliberately bypasses the archived_at filter that the
   * rail/god-eye listAllSessions applies. Not a UI feed.
   */
  listAllSessionsIncludingArchived(): SessionListItem[] {
    const rows = this.db.prepare(
      `SELECT s.*, p.name AS project_name, a.name AS agent_name
       FROM sessions s JOIN projects p ON s.project_id = p.id JOIN agents a ON s.agent_id = a.id
       ORDER BY s.last_activity DESC`,
    ).all() as Row[];
    return rows.map((r) => ({ ...toSession(r), projectName: r.project_name as string, agentName: r.agent_name as string }));
  }
  /** Archived sessions for a project's Archive tab, newest-archived first (enriched with names). */
  listArchivedSessions(projectId: string): SessionListItem[] {
    const rows = this.db.prepare(
      `SELECT s.*, p.name AS project_name, a.name AS agent_name
       FROM sessions s JOIN projects p ON s.project_id = p.id JOIN agents a ON s.agent_id = a.id
       WHERE s.project_id = ? AND s.archived_at IS NOT NULL
       ORDER BY s.archived_at DESC`,
    ).all(projectId) as Row[];
    return rows.map((r) => ({ ...toSession(r), projectName: r.project_name as string, agentName: r.agent_name as string }));
  }
  /** Archived sessions across ALL projects, newest-archived first (enriched with names) — the
   * cross-project Archive view. Mirrors listArchivedSessions but unscoped (no project filter). */
  listAllArchivedSessions(): SessionListItem[] {
    const rows = this.db.prepare(
      `SELECT s.*, p.name AS project_name, a.name AS agent_name
       FROM sessions s JOIN projects p ON s.project_id = p.id JOIN agents a ON s.agent_id = a.id
       WHERE s.archived_at IS NOT NULL
       ORDER BY s.archived_at DESC`,
    ).all() as Row[];
    return rows.map((r) => ({ ...toSession(r), projectName: r.project_name as string, agentName: r.agent_name as string }));
  }
  /** An archived manager's archived workers — for cascade restore/delete (NOT a rail feed). */
  listArchivedWorkers(managerSessionId: string): Session[] {
    return (this.db.prepare("SELECT * FROM sessions WHERE parent_session_id = ? AND archived_at IS NOT NULL ORDER BY created_at")
      .all(managerSessionId) as Row[]).map(toSession);
  }
  /** Soft-archive a session (stamp archived_at) — hidden from the rail/god-eye lists; row retained. */
  archiveSession(id: string): void {
    this.db.prepare("UPDATE sessions SET archived_at = ? WHERE id = ?").run(new Date().toISOString(), id);
  }
  /** Restore an archived session back to the rail (clear archived_at). */
  restoreSession(id: string): void {
    this.db.prepare("UPDATE sessions SET archived_at = NULL WHERE id = ?").run(id);
  }
  /** Permanently delete a session row (the Archive tab's Delete). Also drops its pending wakes. */
  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM wakes WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }
  insertSession(s: Session): void {
    this.db.prepare(
      `INSERT INTO sessions (
         id,project_id,agent_id,engine_session_id,title,cwd,process_state,resumability,busy,
         created_at,last_activity,last_error,
         role,browser_testing,parent_session_id,task_id,worktree_path,branch,gen,recycled_from,
         ctx_input_tokens,ctx_turns,ctx_updated_at,model,rate_limited_until,rate_limit_deadline)
       VALUES (
         @id,@projectId,@agentId,@engineSessionId,@title,@cwd,@processState,@resumability,@busy,
         @createdAt,@lastActivity,@lastError,
         @role,@browserTesting,@parentSessionId,@taskId,@worktreePath,@branch,@gen,@recycledFrom,
         @ctxInputTokens,@ctxTurns,@ctxUpdatedAt,@model,@rateLimitedUntil,@rateLimitDeadline)`,
    ).run({
      ...s,
      busy: s.busy ? 1 : 0,
      // Orchestration fields are optional on Session; coerce absent ones (undefined) to NULL/0
      // so plain phase-1 session literals insert unchanged.
      role: s.role ?? null,
      browserTesting: s.browserTesting ? 1 : 0, // off (0) on every plain session literal

      parentSessionId: s.parentSessionId ?? null,
      taskId: s.taskId ?? null,
      worktreePath: s.worktreePath ?? null,
      branch: s.branch ?? null,
      gen: s.gen ?? 0,
      recycledFrom: s.recycledFrom ?? null,
      ctxInputTokens: s.ctxInputTokens ?? null,
      ctxTurns: s.ctxTurns ?? null,
      ctxUpdatedAt: s.ctxUpdatedAt ?? null,
      model: s.model ?? null,
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
  /**
   * Update measured context occupancy, bumping ctx_updated_at. Also records the model id read
   * from the same transcript line (COALESCE keeps the prior model when this reading lacks one,
   * so a model-less line never clears it).
   */
  setContextCounters(id: string, c: { ctxInputTokens: number; ctxTurns: number; model?: string | null }): void {
    this.db.prepare("UPDATE sessions SET ctx_input_tokens = ?, ctx_turns = ?, model = COALESCE(?, model), ctx_updated_at = ? WHERE id = ?")
      .run(c.ctxInputTokens, c.ctxTurns, c.model ?? null, new Date().toISOString(), id);
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

  // --- Asleep-at-the-Wheel idle watchdog state (FOUNDATION; persisted per-manager, parity with the
  // rate-limit accessors above). Nothing reads/writes these yet — the IdleWatcher ticker and the
  // idle_report tool that drive them are later tasks. Kept as dedicated accessors rather than fields
  // on the shared Session type, so these db-only columns don't spill into the shared shape. ---
  /** Read the per-session idle-watchdog state; undefined when the session row is missing. */
  getIdleNudgeState(id: string): IdleNudgeState | undefined {
    const r = this.db.prepare(
      "SELECT idle_nudge_policy, idle_nudge_snooze_until, last_idle_nudge_at, idle_nudge_unanswered FROM sessions WHERE id = ?",
    ).get(id) as Row | undefined;
    if (!r) return undefined;
    return {
      policy: (r.idle_nudge_policy as IdleNudgePolicy) ?? "watching",
      snoozeUntil: (r.idle_nudge_snooze_until as string) ?? null,
      lastIdleNudgeAt: (r.last_idle_nudge_at as string) ?? null,
      unanswered: (r.idle_nudge_unanswered as number) ?? 0,
    };
  }
  /**
   * Set the nudge policy and (for 'snoozed') its snooze-until. Pass snoozeUntil for 'snoozed' (silent
   * until then); 'watching'/'suppressed' clear it. Mirrors setRateLimitedUntil's two-field shape.
   */
  setIdleNudgePolicy(id: string, policy: IdleNudgePolicy, snoozeUntil: string | null = null): void {
    this.db.prepare("UPDATE sessions SET idle_nudge_policy = ?, idle_nudge_snooze_until = ? WHERE id = ?")
      .run(policy, snoozeUntil, id);
  }
  /** Record that an idle nudge fired: stamp last_idle_nudge_at and increment the unanswered counter. */
  recordIdleNudge(id: string, atIso: string): void {
    this.db.prepare("UPDATE sessions SET last_idle_nudge_at = ?, idle_nudge_unanswered = idle_nudge_unanswered + 1 WHERE id = ?")
      .run(atIso, id);
  }
  /**
   * Reset the watchdog when a manager produces genuine new orchestration activity (back at work):
   * policy → 'watching', unanswered → 0, snooze cleared. Mirrors clearRateLimitDeadline's role.
   */
  resetIdleNudgeState(id: string): void {
    this.db.prepare("UPDATE sessions SET idle_nudge_policy = 'watching', idle_nudge_snooze_until = NULL, idle_nudge_unanswered = 0 WHERE id = ?")
      .run(id);
  }
  /** Register the post-write event listener (the alert-webhook emitter). At most one; replaces any prior. */
  setEventListener(fn: (evt: OrchestrationEvent) => void): void {
    this.eventListener = fn;
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
    // Notify the (optional) listener AFTER the row is committed. Best-effort: a listener fault must
    // never propagate into the orchestration event path, so swallow it.
    if (this.eventListener) {
      try { this.eventListener(evt); } catch { /* listener faults never break the audit write */ }
    }
  }
  /** The workers a manager spawned (its direct children). Archived workers are excluded (rail feed). */
  listWorkers(managerSessionId: string): Session[] {
    return (this.db.prepare("SELECT * FROM sessions WHERE parent_session_id = ? AND archived_at IS NULL ORDER BY created_at")
      .all(managerSessionId) as Row[]).map(toSession);
  }
  /** Currently-LIVE manager sessions — the ContextWatcher's work set (recycle-by-context). */
  listLiveManagers(): Session[] {
    return (this.db.prepare("SELECT * FROM sessions WHERE role = 'manager' AND process_state = 'live'")
      .all() as Row[]).map(toSession);
  }
  /** Re-parent a recycled manager's LIVE workers onto its successor so the fleet survives the handoff. */
  reparentLiveWorkers(oldManagerId: string, newManagerId: string): number {
    return this.db.prepare("UPDATE sessions SET parent_session_id = ? WHERE parent_session_id = ? AND process_state = 'live'")
      .run(newManagerId, oldManagerId).changes;
  }
  /** Move a session's pending wakes to a successor on recycle: the successor inherits the scheduled
   *  nudges, and the retired session is left with nothing to fire (so a due wake can't zombie it). */
  reparentWakes(oldSessionId: string, newSessionId: string): number {
    return this.db.prepare("UPDATE wakes SET session_id = ? WHERE session_id = ?")
      .run(newSessionId, oldSessionId).changes;
  }
  /** True once a session has been recycled — a successor row points back at it via recycled_from.
   *  resume() uses this to refuse resurrecting a superseded session from ANY path (wake/rate-limit/boot). */
  hasSuccessor(sessionId: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM sessions WHERE recycled_from = ? LIMIT 1").get(sessionId);
  }
  /** Count of currently-LIVE manager sessions — the Scheduler's manager-cap gate (§19a hardening). */
  countLiveManagers(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE role = 'manager' AND process_state = 'live'")
      .get() as { c: number }).c;
  }
  /** A manager's audit trail in chronological order (rowid breaks same-timestamp ties). */
  listEvents(managerSessionId: string): OrchestrationEvent[] {
    return (this.db.prepare("SELECT * FROM orchestration_events WHERE manager_session_id = ? ORDER BY ts, rowid")
      .all(managerSessionId) as Row[]).map(toOrchestrationEvent);
  }
  /**
   * One worker's audit trail in chronological order — used by boot-reconcile's dangling-merge
   * detector to pair a `merge_request` with its later terminal `merge_done`/`merge_rejected`
   * regardless of which manager id the events were filed under (rowid breaks same-ts ties).
   */
  listEventsForWorker(workerSessionId: string): OrchestrationEvent[] {
    return (this.db.prepare("SELECT * FROM orchestration_events WHERE worker_session_id = ? ORDER BY ts, rowid")
      .all(workerSessionId) as Row[]).map(toOrchestrationEvent);
  }

  // --- tasks ---
  listTasks(projectId: string): Task[] {
    return this.db.prepare("SELECT * FROM tasks WHERE project_id = ? ORDER BY column_key, position")
      .all(projectId).map(toTask);
  }
  getTask(id: string): Task | undefined {
    const r = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    return r ? toTask(r) : undefined;
  }
  insertTask(t: Task): void {
    this.db.prepare(
      `INSERT INTO tasks (id,project_id,title,body,column_key,position,priority,created_at,updated_at)
       VALUES (@id,@projectId,@title,@body,@columnKey,@position,@priority,@createdAt,@updatedAt)`,
    ).run({ ...t, priority: t.priority ?? "p2" }); // default p2 when an (untyped) caller omits it
  }
  updateTask(id: string, patch: Partial<Pick<Task, "title" | "body" | "columnKey" | "position" | "priority">>): void {
    const cur = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    if (!cur) return;
    const t = toTask(cur);
    const next = { ...t, ...patch, updatedAt: new Date().toISOString() };
    this.db.prepare(
      "UPDATE tasks SET title=@title, body=@body, column_key=@columnKey, position=@position, priority=@priority, updated_at=@updatedAt WHERE id=@id",
    ).run(next);
  }

  // --- schedules (phase-2 Pillar B) ---
  insertSchedule(s: Schedule): void {
    this.db.prepare(
      `INSERT INTO schedules (id,agent_id,cron,enabled,next_fire_at,last_fired_at,created_at,kind)
       VALUES (@id,@agentId,@cron,@enabled,@nextFireAt,@lastFiredAt,@createdAt,@kind)`,
    ).run({ ...s, enabled: s.enabled ? 1 : 0, lastFiredAt: s.lastFiredAt ?? null, kind: s.kind ?? "manager" });
  }
  listSchedules(): Schedule[] {
    return (this.db.prepare("SELECT * FROM schedules ORDER BY created_at").all() as Row[]).map(toSchedule);
  }
  getSchedule(id: string): Schedule | undefined {
    const r = this.db.prepare("SELECT * FROM schedules WHERE id = ?").get(id) as Row | undefined;
    return r ? toSchedule(r) : undefined;
  }
  /** Partial edit (REST): any provided field is written; omitted fields are left as-is. */
  updateSchedule(id: string, patch: { cron?: string; enabled?: boolean; nextFireAt?: string; lastFiredAt?: string | null; kind?: "manager" | "auditor" }): void {
    const cols: Record<string, unknown> = {
      cron: patch.cron,
      enabled: patch.enabled === undefined ? undefined : patch.enabled ? 1 : 0,
      next_fire_at: patch.nextFireAt,
      last_fired_at: patch.lastFiredAt,
      kind: patch.kind,
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

  // --- wakes (one-shot self-scheduled wake-ups; the `wake_me` primitive) ---
  insertWake(w: Wake): void {
    this.db.prepare(
      `INSERT INTO wakes (id,session_id,wake_at,note,created_at)
       VALUES (@id,@sessionId,@wakeAt,@note,@createdAt)`,
    ).run(w);
  }
  getWake(id: string): Wake | undefined {
    const r = this.db.prepare("SELECT * FROM wakes WHERE id = ?").get(id) as Row | undefined;
    return r ? toWake(r) : undefined;
  }
  deleteWake(id: string): void {
    this.db.prepare("DELETE FROM wakes WHERE id = ?").run(id);
  }
  /** Wakes whose wake_at is at/earlier than nowIso — the WakeService's due set. */
  listDueWakes(nowIso: string): Wake[] {
    return (this.db.prepare("SELECT * FROM wakes WHERE wake_at <= ? ORDER BY wake_at").all(nowIso) as Row[]).map(toWake);
  }
  /** A session's pending wakes (chronological) — for wake_list and the per-session cap. */
  listWakesForSession(sessionId: string): Wake[] {
    return (this.db.prepare("SELECT * FROM wakes WHERE session_id = ? ORDER BY wake_at").all(sessionId) as Row[]).map(toWake);
  }
  countPendingWakes(sessionId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM wakes WHERE session_id = ?").get(sessionId) as { c: number }).c;
  }
}

function toProject(r0: unknown): Project {
  const r = r0 as Row;
  return {
    id: r.id as string, name: r.name as string,
    repoPath: r.repo_path as string, vaultPath: r.vault_path as string,
    config: JSON.parse((r.config_json as string) || "{}") as ProjectConfigOverride,
    createdAt: r.created_at as string, archivedAt: (r.archived_at as string) ?? null,
    reserved: (r.reserved as number) === 1,
  };
}
function toAgent(r0: unknown): Agent {
  const r = r0 as Row;
  return {
    id: r.id as string, projectId: r.project_id as string, name: r.name as string,
    startupPrompt: r.startup_prompt as string, position: r.position as number,
    // null on legacy/plain rows ⇒ resolveProfile maps to today's behavior
    profileId: (r.profile_id as string) ?? null,
    // Agent Runs R1: 0/NULL on legacy rows ⇒ endpoint false + ioSchema null (additive). io_schema is
    // stored as JSON text; parse it back (a corrupt blob never wedges a read → null).
    endpoint: (r.endpoint as number) === 1,
    ioSchema: parseJsonOrNull(r.io_schema as string | null),
  };
}
/** Parse a nullable JSON text column back to its value; null on absent/empty/corrupt (never throws). */
function parseJsonOrNull(s: string | null | undefined): unknown {
  if (s == null || s === "") return null;
  try { return JSON.parse(s); } catch { return null; }
}
/** Map an api_keys row to the db-internal record (incl. salt+hash). */
function toApiKeyRecord(r0: unknown): ApiKeyRecord {
  const r = r0 as Row;
  return {
    id: r.id as string, projectId: r.project_id as string, name: (r.name as string) ?? "",
    salt: r.salt as string, hash: r.hash as string,
    endpointAgentIds: (parseJsonOrNull(r.endpoint_agent_ids as string) as string[]) ?? [],
    caps: {
      maxConcurrentRuns: (r.max_concurrent_runs as number) ?? null,
      dailyTokenCap: (r.daily_token_cap as number) ?? null,
      dailySpendCap: (r.daily_spend_cap as number) ?? null,
    },
    status: (r.status as ApiKeyStatus) ?? "active",
    createdAt: r.created_at as string, rotatedAt: (r.rotated_at as string) ?? null,
  };
}
/** Strip the secret material — the PUBLIC `ApiKey` surfaced over REST never carries salt/hash. */
function toApiKeyPublic(rec: ApiKeyRecord): ApiKey {
  const { salt: _s, hash: _h, ...pub } = rec;
  return pub;
}
/** Map a runs row → AgentRun, parsing the JSON columns (a corrupt blob degrades to null, never throws). */
function toRun(r0: unknown): AgentRun {
  const r = r0 as Row;
  return {
    id: r.id as string, projectId: r.project_id as string, agentId: r.agent_id as string,
    sessionId: (r.session_id as string) ?? null, keyId: (r.key_id as string) ?? null,
    status: r.status as RunStatus,
    input: parseJsonOrNull((r.input_json as string) ?? "null"),
    schema: r.schema_json == null ? null : parseJsonOrNull(r.schema_json as string),
    result: r.result_json == null ? null : parseJsonOrNull(r.result_json as string),
    usage: r.usage_json == null ? null : parseJsonOrNull(r.usage_json as string),
    transcriptRef: (r.transcript_ref as string) ?? null, error: (r.error as string) ?? null,
    createdAt: r.created_at as string, startedAt: (r.started_at as string) ?? null, endedAt: (r.ended_at as string) ?? null,
  };
}
function toProfile(r0: unknown): Profile {
  const r = r0 as Row;
  return {
    id: r.id as string, name: r.name as string,
    role: (r.role as SessionRole) ?? null,
    description: r.description as string,
    allowDelta: JSON.parse((r.allow_delta as string) || "[]") as string[],
    skills: r.skills == null ? null : (JSON.parse(r.skills as string) as string[]),
    model: (r.model as string) ?? null,
    icon: (r.icon as string) ?? null,
    browserTesting: (r.browser_testing as number) === 1,
  };
}
function toSession(r0: unknown): Session {
  const r = r0 as Row;
  return {
    id: r.id as string, projectId: r.project_id as string, agentId: r.agent_id as string,
    engineSessionId: (r.engine_session_id as string) ?? null, title: (r.title as string) ?? null,
    cwd: r.cwd as string,
    processState: r.process_state as ProcessState, resumability: r.resumability as Resumability,
    busy: (r.busy as number) === 1,
    createdAt: r.created_at as string, lastActivity: r.last_activity as string,
    lastError: (r.last_error as string) ?? null,
    // phase-2 orchestration (null/0 on plain phase-1 rows)
    role: (r.role as SessionRole) ?? null,
    browserTesting: (r.browser_testing as number) === 1,
    parentSessionId: (r.parent_session_id as string) ?? null,
    taskId: (r.task_id as string) ?? null,
    worktreePath: (r.worktree_path as string) ?? null,
    branch: (r.branch as string) ?? null,
    gen: (r.gen as number) ?? 0,
    recycledFrom: (r.recycled_from as string) ?? null,
    ctxInputTokens: (r.ctx_input_tokens as number) ?? null,
    ctxTurns: (r.ctx_turns as number) ?? null,
    ctxUpdatedAt: (r.ctx_updated_at as string) ?? null,
    model: (r.model as string) ?? null,
    rateLimitedUntil: (r.rate_limited_until as string) ?? null,
    rateLimitDeadline: (r.rate_limit_deadline as string) ?? null,
    archivedAt: (r.archived_at as string) ?? null,
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
    priority: (r.priority as Task["priority"]) ?? "p2",
    createdAt: r.created_at as string, updatedAt: r.updated_at as string,
  };
}
function toSchedule(r0: unknown): Schedule {
  const r = r0 as Row;
  return {
    id: r.id as string, agentId: r.agent_id as string, cron: r.cron as string,
    enabled: (r.enabled as number) === 1,
    nextFireAt: r.next_fire_at as string, lastFiredAt: (r.last_fired_at as string) ?? null,
    createdAt: r.created_at as string,
    kind: (r.kind as Schedule["kind"]) ?? "manager", // legacy rows (pre-P5) → manager
  };
}
function toWake(r0: unknown): Wake {
  const r = r0 as Row;
  return {
    id: r.id as string, sessionId: r.session_id as string,
    wakeAt: r.wake_at as string, note: r.note as string, createdAt: r.created_at as string,
  };
}
