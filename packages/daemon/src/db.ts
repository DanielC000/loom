import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { DB_PATH } from "./paths.js";

/**
 * The REAL production database — `~/.loom/loom.db`, independent of any LOOM_HOME override. A worker
 * once wiped this by running a daemon integration test with no env set (the test's bare `new Db()`
 * opened it and DELETE'd everything). This is the last-line backstop against that class of accident.
 */
const REAL_PROD_DB = path.resolve(path.join(os.homedir(), ".loom", "loom.db"));

/** True when this process is marked as a test run (the test guard / `test:daemon` wrapper sets these). */
export function inTestMode(): boolean {
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
  OrchestrationEvent, OrchestrationEventKind, Schedule, Wake, PollJob, PresetPrompt, PresetPromptSuggestion,
  CompanionBinding, CompanionAllowedSender, CompanionVoicePref, CompanionMessage, CompanionConversationSummary, CompanionRoute,
  ApiKey, ApiKeyStatus, ApiKeyCaps, AgentRun, RunStatus, RunEvent, RunEventKind, KanbanColumn,
  UsageHistoryTotals, UsageHistoryProject, UsageHistoryAgent,
  UsageSample, SessionUsageTotals, SessionUsageProject, SessionUsageAgent, SessionUsageDay,
  ConnectionAuthScheme, CapabilityGrant, CapabilityProvisionKind,
} from "@loom/shared";
import type { CapabilityDefRow } from "./capabilities/registry.js";
import { isOwnerHeldTaskTitle } from "@loom/shared";
import { mintApiKey, parseApiKey, verifySecret, mintPairingCode as mintPairingToken } from "./keys/hash.js";
// Type-only — companion/types.ts has zero runtime imports, so this can never form a runtime cycle with
// the companion/* modules that import `Db` from here. CompanionReminder.route reuses THIS module's
// CompanionRoute (never a duplicate route type, unlike Wake/CompanionBinding's shared/types.ts twins).
import type { CompanionReminder } from "./companion/types.js";

/**
 * The atomic result of a companion pairing-code redemption (db layer). A single silent `rejected` covers
 * EVERY failure (wrong/expired/consumed/locked-out/grant-type-or-session mismatch/route-collision) so the
 * caller can surface the SAME reject as any unallowlisted inbound — no pairing oracle. On success the grant
 * is applied + the code consumed in ONE transaction; `bound` carries the freshly-created dm binding so the
 * gateway can live-sync its in-memory routing map.
 */
export type PairingRedeemResult =
  | { outcome: "rejected" }
  | ({ outcome: "bound"; sessionId: string; scope: "dm" | "group" } & CompanionRoute)
  | { outcome: "sender-added"; sessionId: string };

/**
 * A durable Companion RUN config row (Companion epic Phase 3) as stored/read at the DB layer. Carries the
 * ENCRYPTED bot token (`botTokenBlob`, envelope ciphertext) for the boot resolver to decrypt — this shape
 * is DAEMON-INTERNAL and must NEVER be returned over REST (the REST layer masks to CompanionConfigMasked,
 * exposing only configured + last-4). Home is deliberately absent — it stays in app_meta, keyed PER
 * SESSION (getCompanionHome(sessionId)/setCompanionHome(sessionId, …)), never a cross-session singleton.
 */
export interface CompanionConfigRow {
  sessionId: string;
  /** Envelope ciphertext, or the EMPTY STRING for an in-app-only companion (no bot token stored). */
  botTokenBlob: string;
  channel: string;
  allowedChatId: string;
  chatScope: "dm" | "group";
  heartbeatIntervalMinutes: number;
  heartbeatPrompt: string | null;
  enabled: boolean;
  /** The companion's given (human-friendly) name, or "" when never named. Baked into the assistant's
   *  startup prompt at creation (composeAssistantStartupPrompt) — not re-injected on resume. */
  name: string;
  /**
   * Provision provenance: TRUE ⇒ the `/api/companion/provision` endpoint minted the bound session, so
   * deleting this config also retires that session. FALSE (env bootstrap / a human-bound pre-existing
   * session) ⇒ the session outlives the config on delete. Backfills to 0 on legacy rows.
   */
  provisioned: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * A stored Connection row (owner-controlled encrypted credential store, agent-tooling epic P1) as read at
 * the DB layer — carries the ENCRYPTED `secretBlob` (envelope ciphertext) that `connections/store.ts`
 * decrypts only on the (future, P2-only) authenticated-request seam. This shape is DAEMON-INTERNAL and must
 * NEVER be returned over REST or to any MCP tool — the REST layer masks to `ConnectionMetadata` (name/host/
 * authScheme/createdAt only, never the secret).
 */
export interface ConnectionRow {
  id: string;
  name: string;
  host: string;
  authScheme: ConnectionAuthScheme;
  /** Envelope ciphertext (v1:iv:tag:ct) — NEVER plaintext. */
  secretBlob: string;
  createdAt: string;
}

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
  browser_testing INTEGER NOT NULL DEFAULT 0, -- opt-in: inject a per-session Playwright MCP at spawn
  document_conversion INTEGER NOT NULL DEFAULT 0, -- opt-in: inject a per-session markitdown MCP at spawn
  restricted_tools INTEGER NOT NULL DEFAULT 0, -- opt-in: append the curated dangerous native tools to --disallowedTools at spawn (blast-radius control)
  no_commit INTEGER NOT NULL DEFAULT 0, -- declared no-commit role: 0-commit done auto-retires + skips the forgot-to-commit warning (lifecycle-only)
  connections TEXT NOT NULL DEFAULT '[]', -- JSON string[] of P1 connection ids the authenticated_request tool may use; [] = no access (unlike skills, absent/empty is NOT "all")
  -- agent-tooling P4: registry-capability grants (JSON {slug, connectionId?}[]) — RAW passthrough, never
  -- pre-bridged with browser_testing/document_conversion (see resolveProfileCapabilities). [] = none.
  capabilities TEXT NOT NULL DEFAULT '[]',
  -- bundled-profile customization base snapshot: JSON of the shipped def (sans id) at the user's last
  -- sync. NULL = unset (falls back to shipped at read time, like a missing skill base). Backfilled at boot
  -- by seedProfileBaseSnapshots for bundled-by-name rows; advanced on adopt/reset. Computed state only.
  base_snapshot TEXT
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
  -- Agent Runs R3: caller-supplied webhook URL (POSTed the run summary on a terminal transition) + the
  -- per-key idempotency token. Both NULL on R2 internal runs. Brought to existing R2 DBs by migrateRuns()
  -- (additive ALTER, exactly like the other post-phase migrations); fresh DBs get them via this CREATE.
  webhook_url TEXT,
  idempotency_key TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);
-- Agent Runs follow-up #1: a run-scoped audit trail. Brand-new ⇒ CREATE TABLE IF NOT EXISTS is itself the
-- additive migration (no ALTER), exactly like the runs/api_keys tables; an existing DB simply gains an empty
-- table on next boot. Captures the genuinely-invisible case: a 429 cap-rejection at POST /api/runs that makes
-- NO run row. Distinct from orchestration_events (manager-tree shaped, manager_session_id NOT NULL, readers
-- session-keyed) — a cap-reject has no session. key_id/run_id are nullable (a cap_rejected carries the
-- throttled key but no run); detail_json is kind-specific JSON. Run lifecycle stays on the runs row.
CREATE TABLE IF NOT EXISTS run_events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  key_id TEXT,                                          -- the key the event concerns (NULL if not key-scoped)
  run_id TEXT,                                          -- the run it concerns (NULL for cap_rejected — none made)
  kind TEXT NOT NULL,                                  -- cap_rejected (+ optional future lifecycle markers)
  detail_json TEXT,                                    -- kind-specific JSON ({cap,limit,observed,agentId})
  created_at TEXT NOT NULL
);
-- Session usage telemetry (epic c9924bcd): an append-only time-series of each INTERACTIVE session's
-- BILLED usage, sampled by the daemon's background sampler (card B) — token-free (it reads transcript
-- JSONL the engine already writes; no agent turn). Each row is a per-interval DELTA (additive): the
-- token/cost columns are the CHANGE since that session's previous sample, so a windowed/bucketed SUM is
-- genuine usage with NO read-time monotonicity math (the sampler computes the deltas + handles
-- transcript-rotation resets). Brand-new table ⇒ CREATE TABLE IF NOT EXISTS is itself the additive
-- migration (no ALTER), exactly like runs/run_events; an existing DB simply gains an empty table on next
-- boot. agent_id/model are nullable (defensive); ts is the ISO instant the sample was taken. Pruned past
-- usageSampleRetentionDays by pruneUsageSamples.
CREATE TABLE IF NOT EXISTS session_usage_samples (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  agent_id TEXT,                                       -- nullable (defensive); LEFT JOIN agents for a display name
  model TEXT,                                          -- model id billed for this delta (NULL if unknown)
  ts TEXT NOT NULL,                                    -- ISO instant the sample was taken
  input_tokens INTEGER NOT NULL DEFAULT 0,             -- per-interval DELTAS (NOT cumulative) — sum directly
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0                     -- best-effort priced delta (unpriced model ⇒ 0)
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
  -- opt-in document-conversion, pinned at spawn from the session's Profile (mirrors browser_testing): a
  -- per-session markitdown MCP is injected iff 1. Carried across every respawn (resume/fork/recycle).
  document_conversion INTEGER NOT NULL DEFAULT 0,
  -- restricted-tools, pinned at spawn from the session's Profile (mirrors browser_testing): the curated
  -- dangerous native tools are appended to --disallowedTools iff 1. Carried across every respawn.
  restricted_tools INTEGER NOT NULL DEFAULT 0,
  -- declared no-commit role, pinned at spawn from the session's Profile (mirrors browser_testing): NO
  -- spawn-time effect — read by the worker_report lifecycle (0-commit done auto-retires + skips the
  -- forgot-to-commit warning). Carried across every respawn (resume/fork/recycle).
  no_commit INTEGER NOT NULL DEFAULT 0,
  -- profile-resolved skill subset pinned at fresh spawn (JSON array of skill names); NULL = deliver all
  -- skills (today's behavior). Carried verbatim across every respawn (resume/fork/recycle) like role.
  skills TEXT,
  -- profile-resolved authenticated-egress connection-id allowlist, pinned at fresh spawn (mirrors
  -- browser_testing, NOT skills): '[]' = no access (the secure default — unlike skills, empty here is
  -- never "all"). Carried across every respawn (resume/fork/recycle).
  connections TEXT NOT NULL DEFAULT '[]',
  -- agent-tooling P4: registry-capability grants pinned at spawn (JSON {slug, connectionId?}[]), carried
  -- across every respawn (resume/fork/recycle) like browser_testing. [] on every legacy row (byte-identical).
  capabilities TEXT NOT NULL DEFAULT '[]',
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
  -- ContextWatcher per-manager recycle-nudge state (parity with the idle-watchdog columns above): persist
  -- the last context-nudge time + unanswered count so the re-nudge cadence + escalate-after-cap survive a
  -- daemon restart. No snooze column (unlike idle): a context nudge is answered by RECYCLING, not snoozing.
  context_nudge_policy TEXT NOT NULL DEFAULT 'watching', -- 'watching' | 'escalated'
  last_context_nudge_at TEXT,                            -- ISO ts | NULL (last context-recycle nudge fired)
  context_nudge_unanswered INTEGER NOT NULL DEFAULT 0,   -- consecutive unanswered context nudges
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
  -- owner-gated HOLD flag (idle-watchdog discount signal). Added to existing DBs via migrateTasks(); the
  -- NOT NULL + constant DEFAULT 0 backfills every legacy task row to "not held" in place.
  held INTEGER NOT NULL DEFAULT 0,
  -- manager-settable DEFERRED flag (idle-watchdog discount signal, orthogonal to held -- never checked
  -- by worker_spawn). Added to existing DBs via migrateTasks(); the NOT NULL + constant DEFAULT 0
  -- backfills every legacy task row to "not deferred" in place.
  deferred INTEGER NOT NULL DEFAULT 0,
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
  -- What a fired schedule spawns (Platform Manager P5): 'manager' (default), 'auditor' (the dev
  -- read-and-file-only Platform Auditor, spawned via startAuditor), or 'workspace-auditor' (the
  -- end-user Workspace Auditor, spawned via startWorkspaceAuditor; B6). Plain TEXT — a new kind value
  -- needs no migration. Legacy rows backfill to 'manager'.
  kind TEXT NOT NULL DEFAULT 'manager'
);
-- One-shot self-scheduled wake-ups (the agent wake_me primitive): the daemon WakeService
-- re-nudges session_id with its note when wake_at passes, then deletes the row (one-shot).
CREATE TABLE IF NOT EXISTS wakes (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  wake_at TEXT NOT NULL,
  note TEXT NOT NULL,
  created_at TEXT NOT NULL,
  -- The companion route (JSON {channel,chatId}) captured at SCHEDULE time via
  -- pty.getActiveTurnOrigin, or NULL for an ordinary wake. Nullable -- NULL is the byte-identical
  -- default (fires via plain enqueueStdin, exactly as before this column existed).
  route TEXT
);
-- Local poll-job triggers (agent-tooling epic P3): the daemon PollService periodically fetches 'path' on
-- 'connection_id' (through the SAME server-side P2 authenticated_request path — never a second outbound-
-- HTTP path) and, on a new item vs the previous poll, wakes session_id or spawns a fresh session in
-- agent_id with the item(s) as kickoff. Brand-new table => CREATE TABLE IF NOT EXISTS is itself the
-- additive migration (no ALTER), exactly like connections/api_keys/runs. Human-configured only (REST) —
-- no MCP path (mirrors connections/schedules).
CREATE TABLE IF NOT EXISTS poll_jobs (
  id TEXT PRIMARY KEY,
  connection_id TEXT NOT NULL REFERENCES connections(id),
  path TEXT NOT NULL,
  method TEXT NOT NULL DEFAULT 'GET',
  interval_ms INTEGER NOT NULL,
  next_poll_at TEXT NOT NULL,
  last_polled_at TEXT,
  -- Dot-path into the fetched JSON body to the array of items (default '' = the body itself is the array).
  items_path TEXT NOT NULL DEFAULT '',
  -- Dot-path within ONE item to its stable unique id (default 'id').
  id_path TEXT NOT NULL DEFAULT 'id',
  -- The PREVIOUS successful poll's item-id snapshot (JSON string[]), NOT accumulated across polls — bounds
  -- storage to O(items-per-poll). NULL = never successfully polled (the next poll seeds the baseline and
  -- fires nothing — a fresh job must never replay the existing backlog as "new").
  cursor_json TEXT,
  -- 'wake' (nudge an existing session_id) or 'spawn' (fresh session in agent_id).
  mode TEXT NOT NULL,
  session_id TEXT REFERENCES sessions(id),
  agent_id TEXT REFERENCES agents(id),
  enabled INTEGER NOT NULL DEFAULT 1,
  -- Backoff counter (resets to 0 on any successful poll); the tick pushes next_poll_at out by
  -- interval_ms * 2^min(consecutive_failures, 5) instead of disabling on a transient failure.
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
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
-- Setup Assistant E1-6: a tiny daemon-GLOBAL key/value store for one-time boot markers (today: the
-- first-run setup auto-launch flag). NOT per-project — daemon-wide, like platform_config. Brand-new
-- table ⇒ this CREATE TABLE IF NOT EXISTS is itself the additive migration (no ALTER), exactly like
-- platform_config / preset_prompts: it runs every boot (exec(SCHEMA)) so an existing DB simply gains an
-- empty table on next boot. Plain daemon-internal state — no MCP path, no human REST surface.
CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Preset Prompts: the GLOBAL "terminal action-buttons" store (label + the prompt text to send). ONE
-- daemon-wide list — no project/session scoping (deliberately no project_id). Plain human/UI data,
-- managed over the loopback REST surface only (no MCP path). Brand-new table ⇒ CREATE TABLE IF NOT
-- EXISTS is itself the additive migration (no ALTER), exactly like platform_config / api_keys: an
-- existing DB simply gains an empty table on next boot. Ordered by position (a fresh one appends at
-- the end = MAX(position)+1).
CREATE TABLE IF NOT EXISTS preset_prompts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  prompt TEXT NOT NULL,
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_preset_prompts_position ON preset_prompts(position);
-- Preset Prompt SUGGESTIONS: the "Suggested from your usage" store. Candidate presets proposed by the
-- Platform Auditor (via the role-gated preset_suggestion_suggest MCP tool) or the human/UI, awaiting an
-- in-app Adopt/Dismiss. Mirrors preset_prompts (GLOBAL, no project/session scoping) but adds a nullable
-- rationale (WHY suggested, for the UI) + a status lifecycle ('pending'->'adopted'|'dismissed').
-- Brand-new table ⇒ CREATE TABLE IF NOT EXISTS is itself the additive migration (no ALTER). Adopted/
-- dismissed rows are KEPT (they back the dedupe — "no re-nag"). Ordered by position (append = MAX+1).
CREATE TABLE IF NOT EXISTS preset_prompt_suggestions (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL,
  prompt TEXT NOT NULL,
  rationale TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  position INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_preset_prompt_suggestions_position ON preset_prompt_suggestions(position);
-- Companion authorization layer (Companion epic Phase 1). Durable session↔chat bindings + per-binding
-- allowlisted senders — the security store that decides WHICH human may reach a chat-native companion
-- session. The allowlist table is a brand-new table ⇒ its CREATE TABLE IF NOT EXISTS is itself the
-- additive migration; the bindings table needed a TABLE-REBUILD migration (session_id: PK → non-unique) to
-- go MULTI-CHANNEL — see migrateCompanionBindings(). An UNCONFIGURED daemon (no LOOM_COMPANION_BOT_TOKEN)
-- never writes a row — default-OFF stays byte-identical. HUMAN-managed only (loopback REST); there is
-- intentionally NO MCP path (an injection-exposed companion agent must never authorize senders for itself).
--   • bindings: MULTI-CHANNEL — a session may hold up to ONE binding PER channel (the UNIQUE
--     (session_id, channel) index is the upsert key), so an in-app + a Telegram binding coexist for the
--     SAME companion. Routing stays unambiguous: at most ONE session per (channel, chat_id) route — the
--     UNIQUE route index below is UNCHANGED, so a chat still maps to exactly one session (no inbound
--     ambiguity), and a second session claiming a bound route is rejected at the db. scope selects the
--     authz rule ('dm' = single-owner (channel,chat_id) match; 'group' = require an allowlisted sender),
--     applied PER binding (per channel) independently.
-- session_id is NON-unique (no PRIMARY KEY — the rebuild dropped it); the table is a plain rowid table.
-- The identifying route columns are NOT NULL: SQLite treats NULLs as DISTINCT in a UNIQUE index, so a
-- NULL route/channel would slip the unique guards — NOT NULL makes them airtight at the schema
-- (unreachable today: REST validates non-blank + callers pass non-blank, but the guards hold regardless).
CREATE TABLE IF NOT EXISTS companion_bindings (
  session_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  scope TEXT NOT NULL DEFAULT 'dm',
  created_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_companion_bindings_route ON companion_bindings(channel, chat_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_companion_bindings_session_channel ON companion_bindings(session_id, channel);
--   • allowed_senders: the per-binding group allowlist — one row per identified human who may post to a
--     GROUP-scoped binding. UNIQUE per (session_id, channel, sender_id) so a re-add is an upsert, not a dup;
--     those identifying columns are NOT NULL for the same airtight-unique-index reason as the bindings route.
CREATE TABLE IF NOT EXISTS companion_allowed_senders (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  label TEXT,
  created_at TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_companion_allowed_senders_route ON companion_allowed_senders(session_id, channel, sender_id);
-- Companion DM-pairing (SECURITY): an owner-minted, single-use, short-TTL code that ENROLLS a new
-- chat/sender into the binding/allowlist records above WITHOUT hand-entering numeric ids. The code is
-- hashed at rest (salted SHA-256; plaintext shown to the human ONCE at mint — never stored, never echoed
-- to a chat). At mint the human targets a companion session_id + a grant_type; at redemption the grant
-- always captures the AUTHENTICATED inbound metadata id (never a body-supplied id). Brand-new tables ⇒
-- CREATE TABLE IF NOT EXISTS is itself the additive migration (an existing DB gains empty tables on boot).
-- All times are epoch-ms INTEGERs (paired with an injectable numeric clock, so TTL/lockout are pure
-- integer math and deterministically testable — no wall-clock sleeps).
CREATE TABLE IF NOT EXISTS companion_pairing_codes (
  code_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,          -- the companion session the grant targets
  channel TEXT NOT NULL,             -- the channel the code is valid on (redemption channel must match)
  grant_type TEXT NOT NULL,          -- 'dm-bind' (new dm binding) | 'group-sender' (add to a group allowlist)
  code_hash TEXT NOT NULL,           -- salted SHA-256 of the secret (hex) — NEVER plaintext
  code_salt TEXT NOT NULL,           -- per-code random salt (hex)
  minted_at INTEGER NOT NULL,        -- epoch ms
  expires_at INTEGER NOT NULL,       -- epoch ms (short TTL)
  consumed_at INTEGER,               -- epoch ms of single-use consumption (NULL = unused)
  consumed_by TEXT                   -- the authenticated sender id that redeemed it
);
-- Per-(channel, sender_id) redemption attempt counters — the rate-limit / lockout defense-in-depth
-- (the ≥64-bit secret is the primary defense). Keyed on the AUTHENTICATED sender id; while locked the
-- redemption path rejects WITHOUT even loading a code. UNIQUE per (channel, sender_id) so an increment is
-- an upsert. Times are epoch-ms INTEGERs like the codes table.
CREATE TABLE IF NOT EXISTS companion_pairing_attempts (
  channel TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,     -- epoch ms — start of the current failed-attempt window
  locked_until INTEGER,              -- epoch ms — locked out until this instant (NULL = not locked)
  PRIMARY KEY (channel, sender_id)
);
-- Companion RUN config (Companion epic Phase 3) — the "how to RUN this companion" layer keyed by the
-- bound assistant session_id, so a human can configure a companion WITHOUT editing a .env and restarting.
-- The bot token is stored ENCRYPTED-at-rest (keys/envelope.ts, AES-256-GCM; the confidentiality rests on
-- a NEVER-backed-up local key file) as bot_token_blob — NEVER plaintext, NEVER logged, and NEVER
-- returned in clear over REST (the masked read exposes only configured + last-4). HUMAN-managed only over
-- loopback REST — INTENTIONALLY NO MCP path (an injection-exposed companion must not read/write its own
-- token). Brand-new table ⇒ CREATE TABLE IF NOT EXISTS is itself the additive migration (an existing DB
-- gains an empty table on boot; no row ⇒ companion OFF, byte-identical). Home is DELIBERATELY NOT stored
-- here — it stays the source of truth in app_meta, PER SESSION (get/setCompanionHome(sessionId)),
-- surfaced in the masked read by joining that session's value, so there are never two conflicting home
-- stores for the same companion.
CREATE TABLE IF NOT EXISTS companion_config (
  session_id TEXT PRIMARY KEY,               -- the bound companion session id this run-config keys on
  bot_token_blob TEXT NOT NULL,              -- envelope ciphertext (v1:iv:tag:ct) — NEVER plaintext
  channel TEXT NOT NULL DEFAULT 'telegram',  -- transport channel
  allowed_chat_id TEXT NOT NULL,             -- owner/allowlisted chat id (bootstraps the binding, like LOOM_COMPANION_CHAT_ID)
  chat_scope TEXT NOT NULL DEFAULT 'dm',     -- boot-binding authz scope ('dm' | 'group')
  heartbeat_interval_minutes INTEGER NOT NULL DEFAULT 0, -- proactive cadence in minutes (0 = off)
  heartbeat_prompt TEXT,                      -- framed proactive-prompt text (NULL ⇒ DEFAULT_HEARTBEAT_PROMPT)
  enabled INTEGER NOT NULL DEFAULT 1,         -- a disabled config is treated as OFF at boot
  provisioned INTEGER NOT NULL DEFAULT 0,     -- 1 ⇒ the provision endpoint minted the session (delete retires it)
  name TEXT NOT NULL DEFAULT '',              -- the companion's given name (baked into its startup prompt at creation)
  created_at TEXT,
  updated_at TEXT
);
-- Companion RECURRING reminders (Companion Memory & Reminders Design, Surface 2 s3): N named cron jobs
-- that fire a proactive turn into the companion's OWN long-lived session — generalizes the single
-- heartbeat cadence+prompt to many independently-cadenced, independently-routed reminders. Reuses the
-- SAME cron validation / next-fire computation as schedules (orchestration/cron.ts) but NOT the
-- Scheduler's fresh-session boot — a reminder always targets an EXISTING session_id. Brand-new table =>
-- CREATE TABLE IF NOT EXISTS is itself the additive migration (an existing DB gains an empty table on
-- boot; zero rows => every existing path, heartbeat included, is byte-identical — DEFAULT-OFF). route
-- mirrors wakes.route: nullable JSON {channel,chatId}; NULL means a fired reminder has nowhere to
-- chat_reply, same as an unconfigured heartbeat home. enabled pauses a reminder without deleting it.
-- created_at anchors the FIRST-fire computation (nextFireAt(cron, created_at)) for a reminder that has
-- never yet fired, so a brand-new reminder waits for its real next cron boundary instead of firing on
-- the very next tick.
CREATE TABLE IF NOT EXISTS companion_reminders (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  cron TEXT NOT NULL,
  prompt TEXT NOT NULL,
  label TEXT,
  route TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
-- Companion VOICE preferences (Companion Voice epic, VOICE-P1 foundation — the routing/preference
-- plumbing P2/P3 slot into; NO STT/TTS model work here). Per-ROUTE, keyed like companion_bindings but
-- ADDITIONALLY by sender_id for a GROUP-scoped binding (a DM's chat_id already IS the user, so a DM row's
-- sender_id stays '' — same NOT-NULL-with-empty-string convention as companion_bindings' route columns,
-- for the same airtight-unique-index reason: SQLite treats NULL as DISTINCT in a UNIQUE index, so a NULL
-- sender_id would let a group route's per-user rows collide into duplicates). Brand-new table => CREATE
-- TABLE IF NOT EXISTS is itself the additive migration (an existing DB gains an empty table on boot; zero
-- rows => every existing companion path is byte-identical — DEFAULT-OFF). The ONLY writer is the
-- "/lang"/"/voice" slash-command router (companion/commands.ts via companion/voice-prefs.ts), which
-- resolves the route SERVER-SIDE from an already-authorized inbound; HUMAN-managed READ-ONLY over the
-- loopback REST surface (no MCP path — same trust posture as companion_bindings/companion_allowed_senders).
-- voice_replies started as an INTEGER 0/1 boolean (VOICE-P1); VOICE-P4 (card edd11203) extended it to a
-- tri-state 'on'|'off'|'auto' WITHOUT an ALTER — kept as INTEGER (not retyped to TEXT) deliberately: SQLite
-- affinity is a CONVERSION rule, not a passive label, so a TEXT-declared column would actively reformat an
-- inserted INTEGER (e.g. the JS number 1 becomes the text "1.0"), which would corrupt a genuinely-legacy
-- row on write. INTEGER affinity has the opposite (safe) behavior: it only converts a TEXT value when that
-- text IS a well-formed number; 'on'/'off'/'auto' aren't, so they're stored verbatim, while a legacy 0/1
-- stays a real INTEGER untouched. A legacy row's stored 0/1 and a fresh row's 'on'/'off'/'auto' therefore
-- coexist in the SAME column, on the SAME declared type, with no ALTER; toVoiceMode() (db.ts) is the one
-- place that normalizes both shapes on read.
CREATE TABLE IF NOT EXISTS companion_voice_prefs (
  session_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  sender_id TEXT NOT NULL DEFAULT '',
  stt_lang TEXT,
  tts_lang TEXT,
  tts_voice TEXT,
  voice_replies INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_companion_voice_prefs_route ON companion_voice_prefs(session_id, channel, chat_id, sender_id);
-- Companion CHAT HISTORY (bug 0f01f234): a durable record of every companion chat turn, fixing the
-- "reload loses the whole conversation" bug — the in-app channel was live-only with no store-and-forward.
-- Channel-keyed like companion_voice_prefs; UNIFIED CROSS-CHANNEL CHAT (card 7d63e200) extended writers
-- from in-app-only to every channel (Telegram inbound/outbound now records here too, tagged via_voice for
-- a voice-note-originated inbound turn — the unified web panel renders a small mic indicator for those).
-- Brand-new table => CREATE TABLE IF NOT EXISTS is itself the additive migration (an existing DB gains an
-- empty table on boot; zero rows => byte-identical to today until a companion chat actually happens).
-- Bounded growth: pruned to the most recent ~200 rows per (session_id, channel) on every insert
-- (Db.insertCompanionMessage), so this can never grow unbounded across a long-lived companion.
-- HUMAN-facing READ-ONLY over loopback REST (GET /api/companion/messages/:sessionId) — no MCP path, same
-- trust posture as companion_reminders/companion_voice_prefs; the only writers are the inbound/outbound
-- record hooks (companion/controller.ts, companion/in-app.ts, companion/chat-gateway.ts), never a
-- body-supplied author/text.
CREATE TABLE IF NOT EXISTS companion_messages (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),
  channel TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  author TEXT NOT NULL,       -- 'user' | 'companion'
  text TEXT NOT NULL,
  created_at TEXT NOT NULL,
  via_voice INTEGER NOT NULL DEFAULT 0,  -- 1 iff this inbound turn's text is a voice-note STT transcript
  conversation_seq INTEGER NOT NULL DEFAULT 1  -- which conversation this turn belongs to (see companion_conversations)
);
CREATE INDEX IF NOT EXISTS idx_companion_messages_session ON companion_messages(session_id, channel, created_at);
-- NOTE: the (session_id, conversation_seq) index is created in migrateCompanionMessages() — NOT here —
-- because a legacy DB's companion_messages table lacks conversation_seq until the ALTER in that migration
-- runs, and exec(SCHEMA) precedes the migrations (same hazard the runs idempotency index avoids).
-- Companion CONVERSATION HISTORY (card 85f62475): one row per conversation boundary — a conversation is the
-- span of companion_messages between two "/new"/"/reset" boundaries (or session start / "still live"). Exactly
-- one OPEN row (ended_at IS NULL) exists per session at a time; "/new" closes it (sets ended_at) and opens the
-- next seq. Brand-new table so CREATE TABLE IF NOT EXISTS is itself the additive migration. Existing DBs get
-- their history backfilled into a single open conversation-1 by migrateCompanionConversations() below (mirrors
-- migrateCompanionMessages's idempotent-additive pattern), so history browsing on an upgraded DB shows correct
-- data immediately rather than only after the next chat message lazily opens one.
CREATE TABLE IF NOT EXISTS companion_conversations (
  session_id TEXT NOT NULL REFERENCES sessions(id),
  seq INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  PRIMARY KEY (session_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_companion_conversations_session ON companion_conversations(session_id, seq);
-- Owner-controlled encrypted credential store (agent-tooling epic, P1 foundation). GLOBAL / daemon-wide,
-- HUMAN-managed only over the loopback REST surface — NO MCP tool creates/reads/lists a connection or its
-- secret. secret_blob is envelope ciphertext (v1:iv:tag:ct); the REST layer never returns it (masked read).
-- Brand-new table => CREATE TABLE IF NOT EXISTS is itself the additive migration.
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  host TEXT NOT NULL,
  auth_scheme TEXT NOT NULL,
  secret_blob TEXT NOT NULL,
  created_at TEXT NOT NULL
);
-- Owner-added capability catalog rows (agent-tooling epic P4). The two BUILTIN capabilities
-- (browser-testing/document-conversion) are NOT rows here — they stay special-cased in buildMcpServers,
-- reusing their existing bespoke resolution code. Brand-new table ⇒ CREATE TABLE IF NOT EXISTS is itself
-- the additive migration (no ALTER needed), exactly like the connections table above. HUMAN-managed only
-- (loopback REST, no MCP path) — a capability grant can launch a host process and bind egress.
CREATE TABLE IF NOT EXISTS capability_defs (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  transport TEXT NOT NULL DEFAULT 'stdio',
  kind TEXT NOT NULL,                        -- 'node-package' | 'python-venv' | 'bundled'
  provision_json TEXT NOT NULL,              -- kind-specific recipe (JSON)
  tool_allowlist_json TEXT NOT NULL DEFAULT '[]', -- JSON string[] of MCP tool names for --allowedTools
  wants_scratch_dir INTEGER NOT NULL DEFAULT 0,
  requires_connection INTEGER NOT NULL DEFAULT 0,
  secret_env_var TEXT,                       -- env var name the P1 secret is injected under; NULL if N/A
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_agents_project ON agents(project_id, position);
CREATE INDEX IF NOT EXISTS idx_api_keys_project ON api_keys(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_project ON runs(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_run_events_project ON run_events(project_id, created_at);
CREATE INDEX IF NOT EXISTS idx_usage_samples_ts ON session_usage_samples(ts);
CREATE INDEX IF NOT EXISTS idx_usage_samples_project ON session_usage_samples(project_id, ts);
CREATE INDEX IF NOT EXISTS idx_schedules_due ON schedules(enabled, next_fire_at);
CREATE INDEX IF NOT EXISTS idx_wakes_due ON wakes(wake_at);
CREATE INDEX IF NOT EXISTS idx_companion_reminders_session ON companion_reminders(session_id, enabled);
CREATE INDEX IF NOT EXISTS idx_sessions_agent ON sessions(agent_id, last_activity DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_project ON tasks(project_id, column_key, position);
CREATE INDEX IF NOT EXISTS idx_orch_events_mgr ON orchestration_events(manager_session_id, ts);
`;

/**
 * app_meta marker for the one-time `archived_at` backfill (backfillArchivedAtOnce) — sessions that exited
 * BEFORE auto-archive-on-exit shipped. Daemon-GLOBAL (app_meta is not project-scoped); set once per LOOM_HOME.
 */
const ARCHIVED_AT_BACKFILL_KEY = "archived_at_backfill_done";

/**
 * app_meta marker for the one-time `held` backfill (backfillHeldFromTitlesOnce) — seeds the structured
 * Task.held flag from the LEGACY uppercase-HOLD/CONFIRM title heuristic so cards intentionally parked
 * before the flag existed keep their idle-watchdog discount. Daemon-GLOBAL; set once per LOOM_HOME.
 */
const HELD_BACKFILL_KEY = "task_held_title_backfill_done";

/**
 * app_meta key PREFIX for a companion's home channel (the proactive/outbound "where to reach the owner"
 * target — a single JSON blob `{channel, chatId}`), PER-SESSION (multi-companion cross-delivery fix,
 * task e849a487): each companion session gets its OWN key `companion_home:<sessionId>`, mirroring the
 * per-row route already used by companion_reminders.route — NOT a single daemon-GLOBAL singleton (that
 * was the bug: with ≥2 enabled companions, one shared key meant every heartbeat carried the SAME route
 * regardless of which companion armed it). Still app_meta (NO new table). Read by
 * getCompanionHome/setCompanionHome/clearCompanionHome.
 */
const COMPANION_HOME_KEY_PREFIX = "companion_home:";
/** Legacy PRE-multi-companion global key (single shared home for the one-companion era). Read ONLY by
 *  the one-shot migrateCompanionHomeToPerSession() backfill below; never written again. */
const COMPANION_HOME_KEY_LEGACY = "companion_home";

/**
 * app_meta key for the wedged-worktree tracking set (task dea6728e — the threadpool-safe redo of
 * bd9fc808). A single JSON array of {@link WedgedWorktreeEntry}, daemon-GLOBAL, mirroring
 * getCompanionHome's single-JSON-key pattern (NO new table for what is expected to stay a handful of
 * entries). Read/written by listWedgedWorktrees/recordWorktreeWedgeAttempt/markWorktreeNeedsHuman/
 * clearWedgedWorktree.
 */
const WORKTREE_WEDGED_KEY = "worktree_wedged";

/**
 * The bounded-growth cap for `companion_messages` (bug 0f01f234 — the in-app chat history store): the most
 * recent rows per (session_id, channel) kept; `insertCompanionMessage` prunes anything older on every
 * insert, so the table is a ring buffer and can never grow unbounded across a long-lived companion.
 */
const MAX_COMPANION_MESSAGES = 200;

/**
 * The bounded-growth cap for conversation history (card 85f62475): the most recent N conversations retained
 * per session — "/new" evicts the whole OLDEST conversation (its companion_messages rows + its
 * companion_conversations row) once this is exceeded, never a partial/mid-conversation prune. Hardcoded,
 * mirroring MAX_COMPANION_MESSAGES's own hardcoded-const pattern (no PlatformConfig knob — no demand signal
 * yet). MAX_COMPANION_MESSAGES's ring buffer is per (session, channel, conversation), so a single-channel
 * session bounds to ~4k rows (20 x 200), but a session spanning 2 channels (in-app + Telegram) can hold up
 * to ~200 rows PER CHANNEL PER conversation — ~8k rows total for that session.
 */
const MAX_RETAINED_CONVERSATIONS = 20;

/** Max chars for a conversation-list preview (card 85f62475) — full text is always available via the
 *  fetch-one-conversation read; the list is not the place to ship whole message bodies. */
const CONVERSATION_PREVIEW_MAX_CHARS = 120;

/**
 * One worktree dir whose killable removal was force-KILLED on timeout (genuinely wedged, not a clean
 * reject) — see removeWorktree/killableRemoveDir in git/worktrees.ts. This is NOT a permanent quarantine:
 * the owner pushed back that "wedged" must not mean "dangles forever" — most wedges are eventually
 * resolvable (a held OS-indexer/Defender-scan handle releases on its own, or a pnpm-junction structure
 * `fs.rm` chokes on but `rmdir /s /q` actually deletes), so SessionService retries it on a SLOW cadence
 * (once per boot + a low-frequency in-session sweep) rather than skipping it forever. `needsHuman` flips
 * true only past a long give-up bound (many attempts over days) — the rare truly-permanent case — at
 * which point auto-retry stops and it's surfaced for a human to investigate/delete manually.
 */
export interface WedgedWorktreeEntry {
  worktreePath: string;
  /** the canonical repo path, carried so the background sweep can retry it without a session lookup. */
  repoPath: string;
  firstWedgedAt: string;
  lastAttemptAt: string;
  attempts: number;
  reason: string;
  needsHuman: boolean;
}

/** Columns added to `sessions` after phase-1; applied to existing DBs by migrateSessions(). */
const SESSION_ADDED_COLUMNS: Record<string, string> = {
  role: "TEXT",
  // opt-in browser-automation (pinned at spawn from the Profile; carried across respawns). NOT NULL +
  // constant DEFAULT is legal on ALTER TABLE ADD COLUMN, so legacy rows backfill to 0 (off).
  browser_testing: "INTEGER NOT NULL DEFAULT 0",
  // opt-in document-conversion (pinned at spawn from the Profile; carried across respawns); legacy rows ⇒ 0.
  document_conversion: "INTEGER NOT NULL DEFAULT 0",
  // restricted-tools (pinned at spawn from the Profile; appends dangerous native tools to --disallowedTools); legacy rows ⇒ 0 (off).
  restricted_tools: "INTEGER NOT NULL DEFAULT 0",
  // declared no-commit role (pinned at spawn from the Profile; lifecycle-only); legacy rows ⇒ 0 (off).
  no_commit: "INTEGER NOT NULL DEFAULT 0",
  // profile-resolved skill subset pinned at spawn (JSON array). Nullable; legacy rows backfill to NULL
  // = deliver all skills (today's behavior — the regression-guarded default).
  skills: "TEXT",
  // profile-resolved authenticated-egress connection-id allowlist (JSON array); legacy rows backfill to
  // '[]' = no access (mirrors browser_testing's off-by-default direction, NOT skills' "null = all").
  connections: "TEXT NOT NULL DEFAULT '[]'",
  // agent-tooling P4: registry-capability grants pinned at spawn (JSON array); legacy rows backfill to
  // '[]' = none (mirrors connections' off-by-default direction).
  capabilities: "TEXT NOT NULL DEFAULT '[]'",
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
  // ContextWatcher recycle-nudge state (parity with the idle columns above). NOT NULL + constant DEFAULT
  // is legal on ALTER TABLE ADD COLUMN, so legacy rows backfill to 'watching' / 0.
  context_nudge_policy: "TEXT NOT NULL DEFAULT 'watching'",
  last_context_nudge_at: "TEXT",
  context_nudge_unanswered: "INTEGER NOT NULL DEFAULT 0",
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
  // opt-in document-conversion flag; NOT NULL + constant DEFAULT backfills legacy rows to 0 (off).
  document_conversion: "INTEGER NOT NULL DEFAULT 0",
  // restricted-tools flag; NOT NULL + constant DEFAULT backfills legacy rows to 0 (off).
  restricted_tools: "INTEGER NOT NULL DEFAULT 0",
  // declared no-commit role flag; NOT NULL + constant DEFAULT backfills legacy rows to 0 (off).
  no_commit: "INTEGER NOT NULL DEFAULT 0",
  // authenticated-egress connection-id allowlist (JSON array); legacy rows backfill to '[]' = no access.
  connections: "TEXT NOT NULL DEFAULT '[]'",
  // agent-tooling P4: registry-capability grants (JSON array); legacy rows backfill to '[]' = none.
  capabilities: "TEXT NOT NULL DEFAULT '[]'",
  // bundled-profile customization `base` snapshot (JSON of the shipped def, sans id). Nullable; legacy
  // rows backfill to NULL and seedProfileBaseSnapshots fills bundled-by-name rows at boot (safe direction).
  base_snapshot: "TEXT",
};

/** Columns added to `schedules` after phase-2; applied to existing DBs by migrateSchedules(). */
const SCHEDULE_ADDED_COLUMNS: Record<string, string> = {
  // Platform Manager P5: what a fired schedule spawns. NOT NULL + constant DEFAULT 'manager' is legal
  // on ALTER TABLE ADD COLUMN, so every legacy schedule row backfills to 'manager' (today's behavior).
  kind: "TEXT NOT NULL DEFAULT 'manager'",
};

/** Columns added to `runs` after R2; applied to existing DBs by migrateRuns() (Agent Runs R3). */
const RUN_ADDED_COLUMNS: Record<string, string> = {
  // Both nullable (R2 internal runs carry neither). The unique partial index on (key_id,
  // idempotency_key) is created in migrateRuns() — NOT in SCHEMA — because a legacy R2 DB lacks the
  // column until the ALTER below runs (exec(SCHEMA) precedes the migrations).
  webhook_url: "TEXT",
  idempotency_key: "TEXT",
};

/** Columns added to `tasks` after phase-1; applied to existing DBs by migrateTasks(). */
const TASK_ADDED_COLUMNS: Record<string, string> = {
  // p0 (critical) → p3 (low). NOT NULL + constant DEFAULT 'p2' is legal on ALTER TABLE ADD COLUMN, so
  // every legacy row backfills to 'p2' (Normal) in place — existing cards keep all other fields intact.
  priority: "TEXT NOT NULL DEFAULT 'p2'",
  // Owner-gated HOLD flag. NOT NULL + constant DEFAULT 0 backfills every legacy row to "not held" in place;
  // intentionally-held legacy cards are seeded true post-migration by backfillHeldFromTitlesOnce().
  held: "INTEGER NOT NULL DEFAULT 0",
  // Manager-settable DEFERRED flag. NOT NULL + constant DEFAULT 0 backfills every legacy row to
  // "not deferred" in place — byte-identical to a fresh CREATE TABLE default.
  deferred: "INTEGER NOT NULL DEFAULT 0",
};

/** Columns added to `companion_config` after its initial ship; applied to existing DBs by
 *  migrateCompanionConfig() (fresh installs already have them via CREATE TABLE). */
const COMPANION_CONFIG_ADDED_COLUMNS: Record<string, string> = {
  // Provision provenance. NOT NULL + constant DEFAULT 0 is legal on ALTER TABLE ADD COLUMN, so every
  // legacy config row backfills to provisioned=0 (env/human-bound — a delete never retires its session).
  provisioned: "INTEGER NOT NULL DEFAULT 0",
  // The companion's given name. NOT NULL + constant DEFAULT '' backfills every legacy row to unnamed,
  // matching a fresh CREATE TABLE — an existing companion's prompt stays byte-identical until re-named.
  name: "TEXT NOT NULL DEFAULT ''",
};

/** Columns added to `wakes` after its initial ship (route-aware wake engine); applied to existing DBs
 *  by migrateWakes() (fresh installs already have them via CREATE TABLE). */
const WAKE_ADDED_COLUMNS: Record<string, string> = {
  // Nullable JSON `{channel,chatId}` captured at schedule time; NULL backfills every legacy wake row,
  // so an existing pending wake keeps firing via plain enqueueStdin exactly as before.
  route: "TEXT",
};

/** Columns added to `companion_messages` after its initial ship (unified cross-channel chat, card
 *  7d63e200); applied to existing DBs by migrateCompanionMessages() (fresh installs already have them via
 *  CREATE TABLE). NOT NULL + constant DEFAULT 0 backfills every legacy (in-app-only) row to via_voice=0 —
 *  correct, since only a voice-note-originated inbound turn is ever recorded with via_voice=1. */
const COMPANION_MESSAGES_ADDED_COLUMNS: Record<string, string> = {
  via_voice: "INTEGER NOT NULL DEFAULT 0",
  // Conversation history (card 85f62475): DEFAULT 1 backfills every legacy row into conversation 1 — correct,
  // since migrateCompanionConversations() below gives every such session exactly one open conversation-1 row.
  conversation_seq: "INTEGER NOT NULL DEFAULT 1",
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

/** ContextWatcher recycle-nudge policy (twin of IdleNudgePolicy; no snooze state — see below). */
export type ContextNudgePolicy = "watching" | "escalated";
/** Per-manager context-recycle-nudge state read back from the sessions row (parity w/ IdleNudgeState). */
export interface ContextNudgeState {
  policy: ContextNudgePolicy;
  lastContextNudgeAt: string | null;
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
    this.migrateRuns();
    this.migrateCompanionConfig();
    this.migrateCompanionHomeToPerSession();
    this.migrateCompanionBindings();
    this.migrateWakes();
    this.migrateCompanionMessages();
    this.migrateCompanionConversations();
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

  /**
   * Idempotent additive migration for `runs` (Agent Runs R3) — ADD COLUMN any post-R2 column missing
   * from an existing DB (fresh installs already have them via CREATE TABLE), then create the per-key
   * idempotency unique index. Mirrors migrateSessions (which likewise creates an index depending on a
   * migrated column). The index is PARTIAL — `WHERE idempotency_key IS NOT NULL` — so the many R2/keyless
   * runs (both columns NULL) are exempt, and uniqueness holds only across non-null (key_id, idempotency_key)
   * pairs: a retry with the same pair collides; a fresh key/token does not.
   */
  private migrateRuns(): void {
    const have = new Set(
      (this.db.prepare("PRAGMA table_info(runs)").all() as { name: string }[]).map((c) => c.name),
    );
    for (const [name, type] of Object.entries(RUN_ADDED_COLUMNS)) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE runs ADD COLUMN ${name} ${type}`);
    }
    // Idempotency-on-failure (Agent Runs #4): the unique index is partial on STATUS too, so a
    // terminal-FAILURE run leaves the index (SQLite re-evaluates the partial predicate on UPDATE —
    // verified) and frees the (key_id, idempotency_key) pair for a retry, while at most one
    // non-failed run (queued/starting/running/completed) per pair still holds.
    //
    // Convert-ONCE, not every boot: a DROP+CREATE re-indexes the whole runs table, an unbounded-with-
    // growth boot cost long after every DB has converted. So read the stored definition from
    // sqlite_master and only DROP+CREATE when it differs from the desired one (an existing DB carrying
    // the old key-only predicate). When it already matches we skip; when it's absent (fresh DB) we just
    // CREATE. SQLite stores the CREATE statement verbatim, so a byte-equal `sql` means already-current.
    const desiredIndexSql =
      "CREATE UNIQUE INDEX idx_runs_idempotency ON runs(key_id, idempotency_key) WHERE idempotency_key IS NOT NULL AND status NOT IN ('failed','timed_out','cancelled')";
    const existingIndexSql = (
      this.db
        .prepare("SELECT sql FROM sqlite_master WHERE type='index' AND name='idx_runs_idempotency'")
        .get() as { sql: string } | undefined
    )?.sql;
    if (existingIndexSql !== desiredIndexSql) {
      // Differs (old predicate) or absent (fresh DB) — (re)build to the desired shape.
      this.db.exec("DROP INDEX IF EXISTS idx_runs_idempotency");
      this.db.exec(desiredIndexSql);
    }
  }

  /**
   * Idempotent additive migration for `companion_config` — ADD COLUMN any column added after the table's
   * initial ship missing from an existing DB (fresh installs already have them via CREATE TABLE). Mirrors
   * migrateSchedules; the NOT NULL + constant DEFAULT 0 backfills every legacy config row to
   * provisioned=0 (env/human-bound — a delete never retires its session) in place.
   */
  private migrateCompanionConfig(): void {
    const have = new Set(
      (this.db.prepare("PRAGMA table_info(companion_config)").all() as { name: string }[]).map((c) => c.name),
    );
    for (const [name, type] of Object.entries(COMPANION_CONFIG_ADDED_COLUMNS)) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE companion_config ADD COLUMN ${name} ${type}`);
    }
  }

  /**
   * One-shot backfill for the multi-companion heartbeat cross-delivery fix (task e849a487): the PRE-fix
   * home was a single daemon-GLOBAL app_meta key (COMPANION_HOME_KEY_LEGACY) with no session scoping.
   * Migrate it to the new per-session key (COMPANION_HOME_KEY_PREFIX) so an upgraded single-companion DB
   * doesn't silently lose its configured home. Attribution is only unambiguous with EXACTLY ONE
   * companion_config row (the pre-multi-companion shape this legacy key was ever valid for) — with zero
   * or several rows there is no single session the old global value can be safely assigned to, so it is
   * just dropped (losing a since-ambiguous setting beats reintroducing the exact cross-delivery bug this
   * migration exists to fix). Idempotent: the legacy key is deleted after reading, so a second run is a
   * no-op (getMeta returns undefined). Runs AFTER migrateCompanionConfig (companion_config's columns must
   * already be settled) and BEFORE anything reads the new per-session key live.
   */
  private migrateCompanionHomeToPerSession(): void {
    const raw = this.getMeta(COMPANION_HOME_KEY_LEGACY);
    if (!raw) return; // fresh install, or already migrated — nothing to do
    try {
      const rows = this.db.prepare("SELECT session_id FROM companion_config").all() as { session_id: string }[];
      const only = rows.length === 1 ? rows[0] : undefined;
      if (only) {
        const v = JSON.parse(raw) as { channel?: unknown; chatId?: unknown };
        if (v && typeof v.channel === "string" && typeof v.chatId === "string") {
          this.setMeta(COMPANION_HOME_KEY_PREFIX + only.session_id, JSON.stringify({ channel: v.channel, chatId: v.chatId }));
        }
      }
    } catch { /* corrupt legacy blob — nothing to carry forward, fall through to delete it */ }
    this.deleteMeta(COMPANION_HOME_KEY_LEGACY);
  }

  /**
   * Idempotent additive migration for `wakes` (route-aware wake engine) — ADD COLUMN any column added
   * after the table's initial ship missing from an existing DB (fresh installs already have them via
   * CREATE TABLE). Mirrors migrateCompanionConfig; the nullable `route` backfills every legacy wake row
   * to NULL, so an existing pending wake keeps firing via plain enqueueStdin exactly as before.
   */
  private migrateWakes(): void {
    const have = new Set(
      (this.db.prepare("PRAGMA table_info(wakes)").all() as { name: string }[]).map((c) => c.name),
    );
    for (const [name, type] of Object.entries(WAKE_ADDED_COLUMNS)) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE wakes ADD COLUMN ${name} ${type}`);
    }
  }

  /**
   * Idempotent additive migration for `companion_messages` (unified cross-channel chat, card 7d63e200) —
   * ADD COLUMN any column added after the table's initial ship missing from an existing DB (fresh installs
   * already have it via CREATE TABLE). Mirrors migrateWakes/migrateCompanionConfig.
   */
  private migrateCompanionMessages(): void {
    const have = new Set(
      (this.db.prepare("PRAGMA table_info(companion_messages)").all() as { name: string }[]).map((c) => c.name),
    );
    for (const [name, type] of Object.entries(COMPANION_MESSAGES_ADDED_COLUMNS)) {
      if (!have.has(name)) this.db.exec(`ALTER TABLE companion_messages ADD COLUMN ${name} ${type}`);
    }
    // Created HERE, after the conversation_seq column is guaranteed to exist — a legacy DB lacks it until
    // the ALTER above runs, and this index cannot live in SCHEMA (exec(SCHEMA) precedes migrations).
    this.db.exec(
      "CREATE INDEX IF NOT EXISTS idx_companion_messages_conversation ON companion_messages(session_id, conversation_seq)",
    );
  }

  /**
   * Idempotent additive DATA backfill for conversation history (card 85f62475) — runs AFTER
   * migrateCompanionMessages (so conversation_seq already exists + every legacy row already defaults to 1).
   * For every session with companion_messages rows but NO companion_conversations row yet, opens exactly one
   * OPEN conversation (seq=1, started_at = that session's earliest message, ended_at=NULL) so a pre-upgrade
   * session's history is immediately correct in the conversation list — not just once its next message lazily
   * opens one (currentConversationSeq below would otherwise do the same thing, just later and with
   * started_at=now instead of the true earliest-message time). Guard: only sessions missing a row are
   * touched, so re-running on a warm DB is a no-op; a session with zero companion_messages rows ever is left
   * alone (currentConversationSeq lazily opens conversation 1 for it on its first message).
   */
  private migrateCompanionConversations(): void {
    const missing = this.db.prepare(
      `SELECT m.session_id AS sessionId, MIN(m.created_at) AS startedAt
       FROM companion_messages m
       LEFT JOIN companion_conversations c ON c.session_id = m.session_id
       WHERE c.session_id IS NULL
       GROUP BY m.session_id`,
    ).all() as { sessionId: string; startedAt: string }[];
    const insert = this.db.prepare(
      "INSERT INTO companion_conversations (session_id, seq, started_at, ended_at) VALUES (?, 1, ?, NULL)",
    );
    for (const row of missing) insert.run(row.sessionId, row.startedAt);
  }

  /**
   * One-shot TABLE-REBUILD migration: make companion_bindings MULTI-CHANNEL by dropping the legacy
   * `session_id PRIMARY KEY` so a session may hold up to one binding PER channel (in-app + Telegram at
   * once). SQLite cannot drop a PRIMARY KEY via ALTER, so this copies rows into a PK-free table, drops the
   * old, and renames — losslessly. Runs AFTER exec(SCHEMA) (so a fresh DB already has the new PK-free
   * shape and this no-ops) and inside a transaction (a failure rolls back to the legacy schema).
   *
   * GUARD (idempotent): fires ONLY when the legacy PRIMARY KEY is still present — detected via
   * PRAGMA table_info, where the `pk` marker on `session_id` is >0 on the old schema and 0 once rebuilt.
   * After the rebuild the UNIQUE route index (channel, chat_id) — UNCHANGED, still one-session-per-route —
   * and the NEW UNIQUE (session_id, channel) upsert key are recreated (DROP TABLE dropped the originals).
   */
  private migrateCompanionBindings(): void {
    const cols = this.db.prepare("PRAGMA table_info(companion_bindings)").all() as { name: string; pk: number }[];
    const sessionCol = cols.find((c) => c.name === "session_id");
    if (!sessionCol || sessionCol.pk === 0) return; // table absent, or already rebuilt (PK-free) ⇒ no-op
    this.db.transaction(() => {
      this.db.exec(`CREATE TABLE companion_bindings_new (
        session_id TEXT NOT NULL,
        channel TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        scope TEXT NOT NULL DEFAULT 'dm',
        created_at TEXT
      )`);
      // Copy every legacy row verbatim (old session_id PK ⇒ each session had exactly one binding, so the
      // new UNIQUE (session_id, channel) can never collide on the copy).
      this.db.exec(
        "INSERT INTO companion_bindings_new (session_id, channel, chat_id, scope, created_at) " +
          "SELECT session_id, channel, chat_id, scope, created_at FROM companion_bindings",
      );
      this.db.exec("DROP TABLE companion_bindings"); // drops the old table AND its indexes
      this.db.exec("ALTER TABLE companion_bindings_new RENAME TO companion_bindings");
      this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_companion_bindings_route ON companion_bindings(channel, chat_id)");
      this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_companion_bindings_session_channel ON companion_bindings(session_id, channel)");
    })();
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
  /**
   * Soft-archived projects, newest-archived first — feeds the web "Archived projects" section (the
   * source for restore / permanent-delete). EXCLUDES reserved (a reserved project is never archivable,
   * so it can never appear here, but the filter keeps the contract explicit). Mirrors listArchivedSessions.
   */
  listArchivedProjects(): Project[] {
    return this.db.prepare("SELECT * FROM projects WHERE archived_at IS NOT NULL AND reserved = 0 ORDER BY archived_at DESC")
      .all().map(toProject);
  }
  /** True iff ANY reserved/system project exists (name-agnostic). Prefer the NAME-SCOPED checks below as
   * the per-home idempotency gate now that more than one reserved home can coexist (see below). */
  hasReservedProject(): boolean {
    return !!this.db.prepare("SELECT 1 FROM projects WHERE reserved = 1 LIMIT 1").get();
  }
  /**
   * The LIVE reserved/system project with this exact name, if present. The NAME-SCOPED home resolver:
   * once Loom seeds more than one reserved home (the dev-only "Loom Platform" AND the ungated setup
   * home "Platform"), a bare `listAllProjects().find(p => p.reserved)` is ambiguous — it returns
   * whichever reserved home sorts first by name, mis-targeting home lookups. Reader sites (the
   * /api/platform/home + /api/setup/home discovery routes, platformEscalate, auditFileFinding) resolve by
   * THIS, keyed to the home's own name. EXCLUDES archived (archived_at IS NULL) — mirroring the
   * listAllProjects()-based lookups it replaces, so an (impossible-in-prod) archived reserved home is
   * never returned/targeted. For the seed idempotency gate use hasReservedProjectNamed (archive-agnostic).
   */
  getReservedProjectByName(name: string): Project | undefined {
    const r = this.db.prepare("SELECT * FROM projects WHERE reserved = 1 AND name = ? AND archived_at IS NULL").get(name) as Row | undefined;
    return r ? toProject(r) : undefined;
  }
  /** True iff a reserved/system project with this exact name exists — the per-home idempotency gate. */
  hasReservedProjectNamed(name: string): boolean {
    return !!this.db.prepare("SELECT 1 FROM projects WHERE reserved = 1 AND name = ? LIMIT 1").get(name);
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
   * Partial STRUCTURAL edit of a project (name / vaultPath / repoPath). Provided fields are written;
   * omitted are left as-is. Deliberately does NOT touch config (that goes through the validated
   * setProjectConfig path). `repoPath` is editable ONLY via the elevated platform MCP project_update +
   * the human REST PATCH path, both fronted by checkRepoRebind (isGitRepo + live-worktree guard) — it is
   * NEVER exposed on any agent-facing surface (loom-setup / loom-orchestration).
   */
  updateProject(id: string, patch: { name?: string; vaultPath?: string; repoPath?: string }): void {
    const cols: Record<string, unknown> = { name: patch.name, vault_path: patch.vaultPath, repo_path: patch.repoPath };
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
  /** Restore a soft-archived project (clear archived_at) — mirrors restoreSession. */
  restoreProject(id: string): void {
    this.db.prepare("UPDATE projects SET archived_at = NULL WHERE id = ?").run(id);
  }
  /**
   * PERMANENTLY delete a project and EVERYTHING under it, in ONE transaction (all-or-nothing) — the
   * irreversible counterpart to archiveProject. Cascades the project's agents, their sessions (+ each
   * session's pending wakes), tasks, the agents' schedules, plus the project-scoped api_keys / runs /
   * run_events so no orphan rows survive — INCLUDING the orchestration_events audit rows keyed by this
   * project's session ids (they surface in the cross-project Activity feed, so a permanent delete must
   * clear them). SQLite FKs are not enforced (no PRAGMA foreign_keys=ON), so order is for clarity, not
   * constraint-safety. Owns ROWS ONLY — on-disk transcript snapshots are the caller's job (gateway),
   * mirroring deleteSession; returns the deleted session ids so the caller can drop their snapshots.
   * Does NOT guard reserved/live — the REST layer enforces those FIRST.
   */
  deleteProject(id: string): { sessionIds: string[] } {
    const sessionIds = (this.db.prepare("SELECT id FROM sessions WHERE project_id = ?").all(id) as Row[]).map((r) => r.id as string);
    const agentIds = (this.db.prepare("SELECT id FROM agents WHERE project_id = ?").all(id) as Row[]).map((r) => r.id as string);
    this.db.transaction(() => {
      for (const sid of sessionIds) {
        this.db.prepare("DELETE FROM wakes WHERE session_id = ?").run(sid);
        this.db.prepare("DELETE FROM companion_reminders WHERE session_id = ?").run(sid);
        // orchestration_events is session-keyed (manager OR worker) with no project_id — drop per session id.
        this.db.prepare("DELETE FROM orchestration_events WHERE manager_session_id = ? OR worker_session_id = ?").run(sid, sid);
      }
      for (const aid of agentIds) this.db.prepare("DELETE FROM schedules WHERE agent_id = ?").run(aid);
      this.db.prepare("DELETE FROM run_events WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM runs WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM api_keys WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM tasks WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM sessions WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM agents WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    })();
    return { sessionIds };
  }
  /** Count of a project's sessions still in processState 'live' — the archive/delete guard ("stop the fleet first"). */
  countLiveSessionsInProject(id: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE project_id = ? AND process_state = 'live'").get(id) as { c: number }).c;
  }
  /**
   * A project's LIVE sessions that occupy a worktree (worktree_path set) — the repoPath-rebind guard's
   * work set. Rebinding the repo would strand these worktrees (they hang off the OLD repo), so a rebind
   * is refused while any exist (see checkRepoRebind).
   */
  listLiveWorktreeSessionsInProject(id: string): Session[] {
    return (this.db.prepare("SELECT * FROM sessions WHERE project_id = ? AND process_state = 'live' AND worktree_path IS NOT NULL")
      .all(id) as Row[]).map(toSession);
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

  // --- app_meta (daemon-GLOBAL key/value; one-time boot markers like the first-run setup auto-launch) ---
  /** Read a daemon-global meta value by key. Returns undefined when the key is unset (fresh install). */
  getMeta(key: string): string | undefined {
    const r = this.db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as Row | undefined;
    return r ? (r.value as string) : undefined;
  }
  /** Upsert a daemon-global meta value (stamps updated_at). Used for fire-exactly-once boot markers. */
  setMeta(key: string, value: string): void {
    this.db.prepare(
      `INSERT INTO app_meta (key, value, updated_at) VALUES (@key, @value, @updatedAt)
       ON CONFLICT(key) DO UPDATE SET value = @value, updated_at = @updatedAt`,
    ).run({ key, value, updatedAt: new Date().toISOString() });
  }
  /** Delete a daemon-global meta value (a no-op when unset). Used by a one-shot corrective reset to clear
   *  a fire-exactly-once marker so its guarded work re-runs on the next pass (e.g. re-priming the usage
   *  backfill after wiping the inflated samples — see UsageSampler.correctiveResetOnce). */
  deleteMeta(key: string): void {
    this.db.prepare("DELETE FROM app_meta WHERE key = ?").run(key);
  }

  // --- preset prompts (GLOBAL "terminal action-buttons" store; human/UI REST only, no MCP path) ---
  /** The whole global list, ordered by position (rowid breaks same-position ties → stable insertion order). */
  listPresetPrompts(): PresetPrompt[] {
    return (this.db.prepare("SELECT * FROM preset_prompts ORDER BY position, rowid").all() as Row[]).map(toPresetPrompt);
  }
  getPresetPrompt(id: string): PresetPrompt | undefined {
    const r = this.db.prepare("SELECT * FROM preset_prompts WHERE id = ?").get(id) as Row | undefined;
    return r ? toPresetPrompt(r) : undefined;
  }
  /** Create a preset, APPENDING it at the end (position = MAX(position)+1, or 0 on an empty list). Mints
   *  the id + timestamps and returns the stored row (mirrors createApiKey's "db owns the new row" shape). */
  createPresetPrompt(input: { label: string; prompt: string }): PresetPrompt {
    const max = (this.db.prepare("SELECT MAX(position) AS m FROM preset_prompts").get() as { m: number | null }).m;
    const now = new Date().toISOString();
    const p: PresetPrompt = {
      id: randomUUID(), label: input.label, prompt: input.prompt,
      position: (max == null ? -1 : max) + 1, createdAt: now, updatedAt: now,
    };
    this.db.prepare(
      `INSERT INTO preset_prompts (id,label,prompt,position,created_at,updated_at)
       VALUES (@id,@label,@prompt,@position,@createdAt,@updatedAt)`,
    ).run(p);
    return p;
  }
  /** Partial edit (label / prompt / position) — provided fields are written, omitted are left as-is;
   *  stamps updated_at whenever anything changes. No-op (no updated_at bump) when the patch is empty. */
  updatePresetPrompt(id: string, patch: { label?: string; prompt?: string; position?: number }): void {
    const cols: Record<string, unknown> = { label: patch.label, prompt: patch.prompt, position: patch.position };
    const names = Object.keys(cols).filter((k) => cols[k] !== undefined);
    if (names.length === 0) return;
    const set = [...names.map((c) => `${c} = ?`), "updated_at = ?"].join(", ");
    this.db.prepare(`UPDATE preset_prompts SET ${set} WHERE id = ?`)
      .run(...names.map((c) => cols[c]), new Date().toISOString(), id);
  }
  /** Delete a preset. Idempotent on a missing id (DELETE … WHERE matches nothing). */
  deletePresetPrompt(id: string): void {
    this.db.prepare("DELETE FROM preset_prompts WHERE id = ?").run(id);
  }

  // --- preset prompt SUGGESTIONS ("Suggested from your usage"; deduped write, pending→adopted|dismissed) ---
  /** PENDING suggestions only, ordered by position (rowid breaks same-position ties → stable order).
   *  Adopted/dismissed rows are kept (they back the dedupe) but never listed. */
  listPresetPromptSuggestions(): PresetPromptSuggestion[] {
    return (this.db.prepare("SELECT * FROM preset_prompt_suggestions WHERE status = 'pending' ORDER BY position, rowid")
      .all() as Row[]).map(toPresetPromptSuggestion);
  }
  getPresetPromptSuggestion(id: string): PresetPromptSuggestion | undefined {
    const r = this.db.prepare("SELECT * FROM preset_prompt_suggestions WHERE id = ?").get(id) as Row | undefined;
    return r ? toPresetPromptSuggestion(r) : undefined;
  }
  /** DEDUPED write (the load-bearing "no re-nag" rule): a no-op returning {deduped:true,reason} when the
   *  normalized (trimmed) prompt already matches EITHER an existing preset_prompts row OR ANY existing
   *  suggestion row (pending|adopted|dismissed). Only a genuinely-novel prompt inserts a new PENDING
   *  suggestion (appended at MAX(position)+1). Returns {deduped:false, suggestion} on a fresh insert. */
  suggestPresetPrompt(input: { label: string; prompt: string; rationale?: string | null }):
    | { deduped: false; suggestion: PresetPromptSuggestion }
    | { deduped: true; reason: string } {
    const normalized = input.prompt.trim();
    const presetHit = this.db.prepare("SELECT 1 FROM preset_prompts WHERE TRIM(prompt) = ? LIMIT 1").get(normalized);
    if (presetHit) return { deduped: true, reason: "a preset prompt with this text already exists" };
    const suggHit = this.db.prepare("SELECT 1 FROM preset_prompt_suggestions WHERE TRIM(prompt) = ? LIMIT 1").get(normalized);
    if (suggHit) return { deduped: true, reason: "this prompt has already been suggested" };
    const max = (this.db.prepare("SELECT MAX(position) AS m FROM preset_prompt_suggestions").get() as { m: number | null }).m;
    const now = new Date().toISOString();
    const s: PresetPromptSuggestion = {
      id: randomUUID(), label: input.label, prompt: input.prompt, rationale: input.rationale ?? null,
      status: "pending", position: (max == null ? -1 : max) + 1, createdAt: now, updatedAt: now,
    };
    this.db.prepare(
      `INSERT INTO preset_prompt_suggestions (id,label,prompt,rationale,status,position,created_at,updated_at)
       VALUES (@id,@label,@prompt,@rationale,@status,@position,@createdAt,@updatedAt)`,
    ).run(s);
    return { deduped: false, suggestion: s };
  }
  /** Adopt a pending suggestion: mint a REAL preset_prompt from its label+prompt, mark the suggestion
   *  'adopted' (KEPT — backs the dedupe), and return the created preset. Returns undefined when no
   *  suggestion has that id; throws if it isn't pending (already adopted/dismissed). */
  adoptPresetPromptSuggestion(id: string): PresetPrompt | undefined {
    const s = this.getPresetPromptSuggestion(id);
    if (!s) return undefined;
    if (s.status !== "pending") throw new Error(`suggestion ${id} is already ${s.status}`);
    const created = this.createPresetPrompt({ label: s.label, prompt: s.prompt });
    this.db.prepare("UPDATE preset_prompt_suggestions SET status = 'adopted', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    return created;
  }
  /** Dismiss a pending suggestion: mark it 'dismissed' (KEPT — backs the dedupe). Returns false when no
   *  suggestion has that id (so REST can 404); throws if it isn't pending. */
  dismissPresetPromptSuggestion(id: string): boolean {
    const s = this.getPresetPromptSuggestion(id);
    if (!s) return false;
    if (s.status !== "pending") throw new Error(`suggestion ${id} is already ${s.status}`);
    this.db.prepare("UPDATE preset_prompt_suggestions SET status = 'dismissed', updated_at = ? WHERE id = ?")
      .run(new Date().toISOString(), id);
    return true;
  }

  // --- companion authorization (durable session↔chat bindings + per-binding sender allowlist) ---
  // HUMAN-managed only (loopback REST); NO MCP path — the security store deciding who may reach a
  // chat-native companion session. Mirrors the preset/api-key accessor shape (db owns id + timestamps).
  /** Every durable binding (GLOBAL / daemon-wide). Ordered by created_at for a stable admin list. */
  listCompanionBindings(): CompanionBinding[] {
    return (this.db.prepare("SELECT * FROM companion_bindings ORDER BY created_at, rowid").all() as Row[]).map(toCompanionBinding);
  }
  /**
   * Upsert a binding KEYED ON (session_id, channel) (multi-channel: one binding per session PER channel):
   * a re-bind of the SAME session on the SAME channel updates its chat_id/scope in place, while a binding
   * on a DIFFERENT channel is ADDED alongside (so writing a Telegram binding never clobbers the session's
   * in-app one). A DIFFERENT session claiming an already-bound (channel, chat_id) route hits the UNCHANGED
   * UNIQUE route index and THROWS (a SqliteError) — still at most one session per route, by construction
   * (the caller/REST surfaces this as a 409). Stamps created_at on first insert; keeps it on update
   * (ON CONFLICT touches only chat_id/scope — channel is part of the conflict key). Returns the stored row.
   */
  upsertCompanionBinding(input: { sessionId: string; scope?: "dm" | "group" } & CompanionRoute): CompanionBinding {
    const existing = this.db.prepare("SELECT created_at FROM companion_bindings WHERE session_id = ? AND channel = ?").get(input.sessionId, input.channel) as Row | undefined;
    const createdAt = (existing?.created_at as string) ?? new Date().toISOString();
    const b: CompanionBinding = {
      sessionId: input.sessionId, channel: input.channel, chatId: input.chatId,
      scope: input.scope ?? "dm", createdAt,
    };
    this.db.prepare(
      `INSERT INTO companion_bindings (session_id, channel, chat_id, scope, created_at)
       VALUES (@sessionId, @channel, @chatId, @scope, @createdAt)
       ON CONFLICT(session_id, channel) DO UPDATE SET chat_id = @chatId, scope = @scope`,
    ).run(b);
    return b;
  }
  /**
   * Delete a binding by session id, or (when `channel` is given) only that session's binding on that ONE
   * channel — the other channels' bindings are untouched. Idempotent either way (a missing id/channel
   * matches nothing, a safe no-op). CASCADE-clears that scope's allowlisted senders AND unconsumed pairing
   * codes in the SAME transaction (PL + Lead ruling: least-privilege on an auth boundary — a re-bind of
   * the same (session, channel) must start with an EMPTY allowlist, never inherit a prior grant, and a
   * still-outstanding pairing code from before the unbind must not be able to re-populate it). Mirrors the
   * full-teardown `deleteCompanionConfig`'s cascade shape. companion_pairing_attempts is deliberately LEFT
   * (see deleteCompanionConfig — a lockout must survive unbind/re-bind churn).
   */
  deleteCompanionBinding(sessionId: string, channel?: string): void {
    if (channel !== undefined) {
      this.db.transaction(() => {
        this.db.prepare("DELETE FROM companion_bindings WHERE session_id = ? AND channel = ?").run(sessionId, channel);
        this.db.prepare("DELETE FROM companion_allowed_senders WHERE session_id = ? AND channel = ?").run(sessionId, channel);
        this.db.prepare("DELETE FROM companion_pairing_codes WHERE session_id = ? AND channel = ?").run(sessionId, channel);
      })();
      return;
    }
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM companion_bindings WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM companion_allowed_senders WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM companion_pairing_codes WHERE session_id = ?").run(sessionId);
    })();
  }
  /** A session's per-binding allowlisted senders (the group-scope allowlist). Ordered for a stable list. */
  listAllowedSenders(sessionId: string): CompanionAllowedSender[] {
    return (this.db.prepare("SELECT * FROM companion_allowed_senders WHERE session_id = ? ORDER BY created_at, rowid")
      .all(sessionId) as Row[]).map(toCompanionAllowedSender);
  }
  /**
   * The load-bearing authz predicate for a GROUP-scoped binding: is `senderId` on `sessionId`'s
   * allowlist for `channel`? A pure existence check over the unique (session_id, channel, sender_id)
   * key — no row ⇒ false (REJECT). Used by the db-backed CompanionAuth in companion/auth.ts.
   */
  isSenderAllowed(sessionId: string, channel: string, senderId: string): boolean {
    return !!this.db.prepare(
      "SELECT 1 FROM companion_allowed_senders WHERE session_id = ? AND channel = ? AND sender_id = ? LIMIT 1",
    ).get(sessionId, channel, senderId);
  }
  /** Add (or re-add, upserting the label) an allowlisted sender. Unique per (session_id, channel,
   *  sender_id): a repeat add updates the label rather than erroring. Returns the stored row. */
  addAllowedSender(input: { sessionId: string; channel: string; senderId: string; label?: string | null }): CompanionAllowedSender {
    const existing = this.db.prepare(
      "SELECT id, created_at FROM companion_allowed_senders WHERE session_id = ? AND channel = ? AND sender_id = ?",
    ).get(input.sessionId, input.channel, input.senderId) as Row | undefined;
    const s: CompanionAllowedSender = {
      id: (existing?.id as string) ?? randomUUID(),
      sessionId: input.sessionId, channel: input.channel, senderId: input.senderId,
      label: input.label ?? null, createdAt: (existing?.created_at as string) ?? new Date().toISOString(),
    };
    this.db.prepare(
      `INSERT INTO companion_allowed_senders (id, session_id, channel, sender_id, label, created_at)
       VALUES (@id, @sessionId, @channel, @senderId, @label, @createdAt)
       ON CONFLICT(session_id, channel, sender_id) DO UPDATE SET label = @label`,
    ).run(s);
    return s;
  }
  /** Remove an allowlisted sender by id (idempotent — a missing id matches nothing). */
  removeAllowedSender(id: string): void {
    this.db.prepare("DELETE FROM companion_allowed_senders WHERE id = ?").run(id);
  }

  // --- companion DM-pairing (SECURITY): owner-minted, single-use, short-TTL, rate-limited enrollment ---
  // HUMAN-managed mint (loopback REST) only; NO MCP path. The redemption txn below is the ONE place a
  // pairing code turns into a durable grant, applied ATOMICALLY with consuming the code.
  /**
   * Mint a one-time pairing code targeted at `sessionId` + `grantType`, valid for `ttlMs`. Stores only the
   * SALTED HASH + salt (never plaintext); returns the plaintext ONCE for the human. `nowMs` is the injected
   * clock (epoch ms) so minted_at/expires_at are deterministic in tests.
   */
  mintPairingCode(input: { sessionId: string; channel: string; grantType: "dm-bind" | "group-sender"; ttlMs: number }, nowMs: number): { codeId: string; code: string; expiresAt: string } {
    this.purgeExpiredPairingCodes(nowMs); // opportunistic housekeeping — expired codes are dead weight (TTL rejects them anyway)
    const minted = mintPairingToken(); // { id, plaintext (pair_<id>.<secret>), salt, hash }
    const expiresMs = nowMs + input.ttlMs;
    this.db.prepare(
      `INSERT INTO companion_pairing_codes (code_id, session_id, channel, grant_type, code_hash, code_salt, minted_at, expires_at, consumed_at, consumed_by)
       VALUES (@codeId, @sessionId, @channel, @grantType, @hash, @salt, @mintedAt, @expiresAt, NULL, NULL)`,
    ).run({ codeId: minted.id, sessionId: input.sessionId, channel: input.channel, grantType: input.grantType, hash: minted.hash, salt: minted.salt, mintedAt: nowMs, expiresAt: expiresMs });
    return { codeId: minted.id, code: minted.plaintext, expiresAt: new Date(expiresMs).toISOString() };
  }
  /** Read one pairing code row by id (test/admin read; returns the raw persisted shape or undefined). */
  getPairingCodeById(codeId: string): Record<string, unknown> | undefined {
    return this.db.prepare("SELECT * FROM companion_pairing_codes WHERE code_id = ?").get(codeId) as Row | undefined;
  }
  /** Drop every expired code (housekeeping; idempotent). `nowMs` is the injected clock. */
  purgeExpiredPairingCodes(nowMs: number): void {
    this.db.prepare("DELETE FROM companion_pairing_codes WHERE expires_at < ?").run(nowMs);
  }
  /**
   * Redeem a pairing code — the SECURITY-CRITICAL atomic path. In ONE transaction: (1) a lockout gate that
   * rejects WITHOUT loading a code while (channel, senderId) is locked; (2) load + constant-time verify +
   * unexpired/unconsumed/grant-type/session/channel checks; (3) on success, apply the grant from the
   * AUTHENTICATED metadata (dm binding upsert OR group allowlist add) AND consume the code, then clear the
   * attempt counter; (4) on ANY failure, bump the per-(channel, senderId) attempt counter (locking out at
   * `maxAttempts`) and return the SAME silent `rejected` (no oracle). A grant-write collision (e.g. the
   * UNIQUE route index) is contained as `rejected` and leaves the code UNCONSUMED (the grant never landed).
   */
  redeemPairingCode(input: {
    codeId: string; secret: string; channel: string; senderId: string; chatId: string;
    expectedGrantType: "dm-bind" | "group-sender"; bindingSessionId?: string;
    maxAttempts: number; windowMs: number; lockoutMs: number;
  }, nowMs: number): PairingRedeemResult {
    return this.db.transaction((): PairingRedeemResult => {
      // (1) Lockout gate — reject before even loading a code while locked out.
      const attempt = this.db.prepare(
        "SELECT attempts, window_start, locked_until FROM companion_pairing_attempts WHERE channel = ? AND sender_id = ?",
      ).get(input.channel, input.senderId) as Row | undefined;
      const lockedUntil = attempt?.locked_until as number | null | undefined;
      if (lockedUntil != null && nowMs < lockedUntil) return { outcome: "rejected" };

      // (2) Load + validate. Every check folds into one boolean so a failure is INDISTINGUISHABLE.
      const code = this.db.prepare("SELECT * FROM companion_pairing_codes WHERE code_id = ?").get(input.codeId) as Row | undefined;
      const valid = !!code
        && code.consumed_at == null
        && nowMs < (code.expires_at as number)
        && (code.channel as string) === input.channel
        && (code.grant_type as string) === input.expectedGrantType
        && (input.expectedGrantType !== "group-sender" || (code.session_id as string) === input.bindingSessionId)
        && verifySecret(input.secret, code.code_salt as string, code.code_hash as string);
      if (!valid) {
        this.recordPairingFailure(input.channel, input.senderId, nowMs, input.maxAttempts, input.windowMs, input.lockoutMs, attempt);
        return { outcome: "rejected" };
      }

      // (3) Apply the grant from the AUTHENTICATED metadata (never a body-supplied id) + consume, atomically.
      const sessionId = code!.session_id as string;
      const consume = () => this.db.prepare(
        "UPDATE companion_pairing_codes SET consumed_at = ?, consumed_by = ? WHERE code_id = ?",
      ).run(nowMs, input.senderId, input.codeId);
      if (input.expectedGrantType === "dm-bind") {
        // SILENT-TAKEOVER REFUSAL: a dm-bind code must never rebind/repurpose a session that is ALREADY
        // bound to a DIFFERENT chat — that would silently lock out its current owner. Refuse conservatively
        // (same no-oracle reject, code UNCONSUMED, NO counter bump — the secret was valid, this is a safety
        // refusal not a guess); the human clears the old binding via the REST admin first to move it. A
        // no-existing-binding or an exact-same-chat re-pair (idempotent) is allowed through.
        const prior = this.db.prepare("SELECT chat_id FROM companion_bindings WHERE session_id = ?").get(sessionId) as Row | undefined;
        if (prior && (prior.chat_id as string) !== input.chatId) return { outcome: "rejected" };
        let binding;
        try {
          binding = this.upsertCompanionBinding({ sessionId, channel: input.channel, chatId: input.chatId, scope: "dm" });
        } catch {
          // The UNIQUE (channel, chat_id) route index (a stale in-memory map raced the db). Contain it as
          // the same silent reject; the code stays UNCONSUMED so a legitimate re-try can still land.
          return { outcome: "rejected" };
        }
        consume();
        this.clearPairingAttempts(input.channel, input.senderId);
        return { outcome: "bound", sessionId: binding.sessionId, channel: binding.channel, chatId: binding.chatId, scope: binding.scope };
      }
      try {
        this.addAllowedSender({ sessionId, channel: input.channel, senderId: input.senderId });
      } catch {
        // Symmetric with the dm-bind path: contain any grant-write throw as the same silent reject (code
        // left UNCONSUMED). The add is an idempotent upsert today, so this is a belt-and-suspenders guard.
        return { outcome: "rejected" };
      }
      consume();
      this.clearPairingAttempts(input.channel, input.senderId);
      return { outcome: "sender-added", sessionId };
    })();
  }
  /** Bump the failed-attempt counter for (channel, senderId), locking out at `maxAttempts`. A window that
   *  has elapsed (or a lock that has expired) resets to strike 1. Called ONLY inside redeemPairingCode's txn. */
  private recordPairingFailure(channel: string, senderId: string, nowMs: number, maxAttempts: number, windowMs: number, lockoutMs: number, existing?: Row): void {
    const lockedUntil = existing?.locked_until as number | null | undefined;
    const windowStartPrev = existing?.window_start as number | undefined;
    let attempts: number;
    let windowStart: number;
    if (!existing || (lockedUntil != null && nowMs >= lockedUntil) || (windowStartPrev != null && nowMs - windowStartPrev > windowMs)) {
      attempts = 1; windowStart = nowMs; // fresh window (first strike, expired lock, or elapsed window)
    } else {
      attempts = (existing.attempts as number) + 1; windowStart = windowStartPrev ?? nowMs;
    }
    const newLockedUntil = attempts >= maxAttempts ? nowMs + lockoutMs : null;
    this.db.prepare(
      `INSERT INTO companion_pairing_attempts (channel, sender_id, attempts, window_start, locked_until)
       VALUES (@channel, @senderId, @attempts, @windowStart, @lockedUntil)
       ON CONFLICT(channel, sender_id) DO UPDATE SET attempts = @attempts, window_start = @windowStart, locked_until = @lockedUntil`,
    ).run({ channel, senderId, attempts, windowStart, lockedUntil: newLockedUntil });
  }
  /** Clear the attempt/lockout row for (channel, senderId) — a successful redemption wipes the strikes. */
  private clearPairingAttempts(channel: string, senderId: string): void {
    this.db.prepare("DELETE FROM companion_pairing_attempts WHERE channel = ? AND sender_id = ?").run(channel, senderId);
  }

  // --- companion home channel (the proactive/outbound "where to reach the owner" target; app_meta JSON,
  // PER-SESSION — see COMPANION_HOME_KEY_PREFIX doc) ---
  /** The stored home channel target for ONE companion session, or null when unset/corrupt (never throws). */
  getCompanionHome(sessionId: string): CompanionRoute | null {
    const raw = this.getMeta(COMPANION_HOME_KEY_PREFIX + sessionId);
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as { channel?: unknown; chatId?: unknown };
      if (v && typeof v.channel === "string" && typeof v.chatId === "string") return { channel: v.channel, chatId: v.chatId };
    } catch { /* corrupt blob ⇒ null (like getPlatformConfig) */ }
    return null;
  }
  /** Upsert the home channel target for ONE companion session (its own app_meta JSON key). */
  setCompanionHome(sessionId: string, home: CompanionRoute): void {
    this.setMeta(COMPANION_HOME_KEY_PREFIX + sessionId, JSON.stringify({ channel: home.channel, chatId: home.chatId }));
  }
  /** Clear ONE companion session's home channel target — that companion's proactive HEARTBEAT turns OFF
   *  (heartbeat.ts's tick() reads null ⇒ no route ⇒ nothing to chat_reply), never another session's home. */
  clearCompanionHome(sessionId: string): void {
    this.deleteMeta(COMPANION_HOME_KEY_PREFIX + sessionId);
  }

  // --- wedged-worktree tracking (task dea6728e; app_meta JSON array) — SLOW retry, not permanent skip ---
  /** Every currently-tracked wedged worktree dir. Corrupt/missing blob → empty (never throws). */
  listWedgedWorktrees(): WedgedWorktreeEntry[] {
    const raw = this.getMeta(WORKTREE_WEDGED_KEY);
    if (!raw) return [];
    try {
      const v: unknown = JSON.parse(raw);
      if (Array.isArray(v)) {
        return v.filter(
          (e): e is WedgedWorktreeEntry =>
            !!e && typeof e.worktreePath === "string" && typeof e.repoPath === "string" &&
            typeof e.firstWedgedAt === "string" && typeof e.lastAttemptAt === "string" &&
            typeof e.attempts === "number" && typeof e.reason === "string" && typeof e.needsHuman === "boolean",
        );
      }
    } catch { /* corrupt blob ⇒ empty (like getPlatformConfig) */ }
    return [];
  }
  /** The tracked entry for `worktreePath`, or undefined if it isn't (currently) wedged. */
  getWedgedWorktree(worktreePath: string): WedgedWorktreeEntry | undefined {
    return this.listWedgedWorktrees().find((e) => e.worktreePath === worktreePath);
  }
  /**
   * Record ONE more failed (killed/timed-out) removal attempt against `worktreePath` — upsert: a first
   * sighting creates the entry (`attempts:1`, `needsHuman:false`); a repeat bumps `attempts` and
   * `lastAttemptAt` while keeping the original `firstWedgedAt` (so age-based give-up policy in the
   * caller can measure how long it's been wedged). Returns the updated entry so the caller can decide
   * (using its own give-up thresholds) whether to call {@link markWorktreeNeedsHuman}. Pure bookkeeping —
   * this method itself never decides give-up; that policy lives in SessionService.
   */
  recordWorktreeWedgeAttempt(worktreePath: string, repoPath: string, reason: string): WedgedWorktreeEntry {
    const now = new Date().toISOString();
    const list = this.listWedgedWorktrees();
    const existing = list.find((e) => e.worktreePath === worktreePath);
    const updated: WedgedWorktreeEntry = existing
      ? { ...existing, repoPath, lastAttemptAt: now, attempts: existing.attempts + 1, reason }
      : { worktreePath, repoPath, firstWedgedAt: now, lastAttemptAt: now, attempts: 1, reason, needsHuman: false };
    this.setMeta(WORKTREE_WEDGED_KEY, JSON.stringify([...list.filter((e) => e.worktreePath !== worktreePath), updated]));
    return updated;
  }
  /** Flip `worktreePath` to `needsHuman:true` (the long give-up bound was crossed) — auto-retry stops for
   *  it from here on; a no-op if it isn't currently tracked. */
  markWorktreeNeedsHuman(worktreePath: string): void {
    const list = this.listWedgedWorktrees();
    const entry = list.find((e) => e.worktreePath === worktreePath);
    if (!entry || entry.needsHuman) return;
    this.setMeta(WORKTREE_WEDGED_KEY, JSON.stringify([...list.filter((e) => e.worktreePath !== worktreePath), { ...entry, needsHuman: true }]));
  }
  /** Drop `worktreePath` from wedged tracking (a no-op if it wasn't tracked) — called once a removal
   *  actually succeeds, at any point (first try, a slow retry, or out-of-band). */
  clearWedgedWorktree(worktreePath: string): void {
    const before = this.listWedgedWorktrees();
    const after = before.filter((e) => e.worktreePath !== worktreePath);
    if (after.length === before.length) return; // wasn't tracked ⇒ nothing to clear
    this.setMeta(WORKTREE_WEDGED_KEY, JSON.stringify(after));
  }

  // --- companion RUN config (Companion epic Phase 3): the "how to RUN this companion" layer, keyed by
  // session_id, with the bot token ENCRYPTED at rest. HUMAN-managed only (loopback REST); NO MCP path.
  // The stored `botTokenBlob` is envelope ciphertext — accessors carry it for the boot resolver to decrypt,
  // but the REST layer NEVER returns it (masked read). Mirrors the binding/allowlist accessor shape. ---
  /** Every stored run-config (GLOBAL / daemon-wide), ordered by created_at for a stable admin list. */
  listCompanionConfigs(): CompanionConfigRow[] {
    return (this.db.prepare("SELECT * FROM companion_config ORDER BY created_at, rowid").all() as Row[]).map(toCompanionConfigRow);
  }
  /** Read one run-config by session id (with the ciphertext blob), or undefined when absent. */
  getCompanionConfig(sessionId: string): CompanionConfigRow | undefined {
    const r = this.db.prepare("SELECT * FROM companion_config WHERE session_id = ?").get(sessionId) as Row | undefined;
    return r ? toCompanionConfigRow(r) : undefined;
  }
  /**
   * Upsert a run-config KEYED ON session_id. The caller passes an ALREADY-ENCRYPTED `botTokenBlob` (this
   * layer never sees the plaintext token — encryption happens at the REST/boot edge via the envelope
   * helper). Stamps created_at on first insert, keeps it on update; always bumps updated_at. Returns the
   * stored row.
   */
  upsertCompanionConfig(input: {
    sessionId: string; botTokenBlob: string; channel: string; allowedChatId: string;
    chatScope: "dm" | "group"; heartbeatIntervalMinutes: number; heartbeatPrompt: string | null; enabled: boolean;
    /** Provision provenance (see CompanionConfigRow.provisioned). OMITTED ⇒ PRESERVE the stored value on an
     *  update (env-bootstrap / REST-config writes leave it untouched), defaulting to false on first insert. */
    provisioned?: boolean;
    /** The companion's given name. OMITTED ⇒ PRESERVE the stored value on an update (mirrors `provisioned`),
     *  defaulting to "" (unnamed) on first insert. */
    name?: string;
  }): CompanionConfigRow {
    const existing = this.db.prepare("SELECT created_at, provisioned, name FROM companion_config WHERE session_id = ?").get(input.sessionId) as Row | undefined;
    const now = new Date().toISOString();
    const row: CompanionConfigRow = {
      sessionId: input.sessionId, botTokenBlob: input.botTokenBlob, channel: input.channel,
      allowedChatId: input.allowedChatId, chatScope: input.chatScope,
      heartbeatIntervalMinutes: input.heartbeatIntervalMinutes, heartbeatPrompt: input.heartbeatPrompt,
      enabled: input.enabled,
      // Explicit value wins; else keep what's stored (an update never silently clears provenance); else false.
      provisioned: input.provisioned ?? (existing?.provisioned as number | undefined) === 1,
      // Same preserve-on-omit pattern as provisioned: a config write that doesn't mention name never clears it.
      name: input.name ?? (existing?.name as string | undefined) ?? "",
      createdAt: (existing?.created_at as string) ?? now, updatedAt: now,
    };
    this.db.prepare(
      `INSERT INTO companion_config (session_id, bot_token_blob, channel, allowed_chat_id, chat_scope, heartbeat_interval_minutes, heartbeat_prompt, enabled, provisioned, name, created_at, updated_at)
       VALUES (@sessionId, @botTokenBlob, @channel, @allowedChatId, @chatScope, @heartbeatIntervalMinutes, @heartbeatPrompt, @enabledInt, @provisionedInt, @name, @createdAt, @updatedAt)
       ON CONFLICT(session_id) DO UPDATE SET
         bot_token_blob = @botTokenBlob, channel = @channel, allowed_chat_id = @allowedChatId, chat_scope = @chatScope,
         heartbeat_interval_minutes = @heartbeatIntervalMinutes, heartbeat_prompt = @heartbeatPrompt, enabled = @enabledInt,
         provisioned = @provisionedInt, name = @name, updated_at = @updatedAt`,
    ).run({ ...row, enabledInt: row.enabled ? 1 : 0, provisionedInt: row.provisioned ? 1 : 0 });
    return row;
  }
  /**
   * Delete a run-config by session id (idempotent — a missing id matches nothing), CASCADE-cleaning its
   * routing/authz rows in ONE transaction so no stale binding/allowlist/pairing row survives a torn-down
   * companion (data-integrity — PL ruling, single-companion model). The cascade is ONE-WAY: deleting a
   * CONFIG cleans its bindings/allowed-senders/pairing codes; a binding WITHOUT a config is a VALID
   * "provisioned-but-unarmed" state, so removing a binding NEVER deletes the config (no reverse cascade).
   * companion_pairing_attempts is deliberately LEFT (it's keyed by channel+sender, not session, and
   * self-expires — a lockout window must survive a config churn so it can't be reset by delete/recreate).
   */
  deleteCompanionConfig(sessionId: string): void {
    // Deliberately does NOT cascade companion_reminders: reminders are SESSION-scoped (not config-scoped),
    // so they survive a config disable/re-enable on the same session — only a session delete cleans them
    // (see the session-delete cascades elsewhere in this file).
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM companion_config WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM companion_bindings WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM companion_allowed_senders WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM companion_pairing_codes WHERE session_id = ?").run(sessionId);
      this.db.prepare("DELETE FROM app_meta WHERE key = ?").run(COMPANION_HOME_KEY_PREFIX + sessionId);
    })();
  }

  // --- connections (owner-controlled encrypted credential store, agent-tooling epic P1) ---
  // GLOBAL / daemon-wide, HUMAN-managed only over the loopback REST surface — NO MCP path (same trust
  // posture as the companion/vault/git writers). These accessors carry the raw `secretBlob` ciphertext
  // (this layer is daemon-internal); `connections/store.ts` is the only caller and it never lets the
  // ciphertext or a decrypted secret reach a REST response or an MCP tool. ---
  /** Every stored connection (GLOBAL / daemon-wide), ordered by created_at for a stable admin list. */
  listConnections(): ConnectionRow[] {
    return (this.db.prepare("SELECT * FROM connections ORDER BY created_at, rowid").all() as Row[]).map(toConnectionRow);
  }
  /** Read one connection by id (with the ciphertext blob), or undefined when absent. */
  getConnection(id: string): ConnectionRow | undefined {
    const r = this.db.prepare("SELECT * FROM connections WHERE id = ?").get(id) as Row | undefined;
    return r ? toConnectionRow(r) : undefined;
  }
  /**
   * Create a new connection. The caller passes an ALREADY-ENCRYPTED `secretBlob` (this layer never sees
   * the plaintext secret — encryption happens in `connections/store.ts` via the envelope helper).
   */
  createConnection(input: { name: string; host: string; authScheme: ConnectionAuthScheme; secretBlob: string }): ConnectionRow {
    const row: ConnectionRow = {
      id: randomUUID(), name: input.name, host: input.host, authScheme: input.authScheme,
      secretBlob: input.secretBlob, createdAt: new Date().toISOString(),
    };
    this.db.prepare(
      `INSERT INTO connections (id, name, host, auth_scheme, secret_blob, created_at)
       VALUES (@id, @name, @host, @authScheme, @secretBlob, @createdAt)`,
    ).run(row);
    return row;
  }
  /** Delete a connection by id (idempotent — a missing id matches nothing). */
  deleteConnection(id: string): void {
    this.db.prepare("DELETE FROM connections WHERE id = ?").run(id);
  }

  // --- capability_defs (owner-added registry-capability catalog rows, agent-tooling epic P4) ---
  // GLOBAL / daemon-wide, HUMAN-managed only over the loopback REST surface — NO MCP path (same trust
  // posture as connections above). The two BUILTIN capabilities are NOT rows here (see capabilities/registry.ts). ---
  /** Every owner-added capability, ordered by created_at for a stable admin list. */
  listCapabilityDefs(): CapabilityDefRow[] {
    return (this.db.prepare("SELECT * FROM capability_defs ORDER BY created_at, rowid").all() as Row[]).map(toCapabilityDefRow);
  }
  /** Read one owner-added capability by slug, or undefined when absent. */
  getCapabilityDefBySlug(slug: string): CapabilityDefRow | undefined {
    const r = this.db.prepare("SELECT * FROM capability_defs WHERE slug = ?").get(slug) as Row | undefined;
    return r ? toCapabilityDefRow(r) : undefined;
  }
  /** Create a new owner-added capability def. Caller (capabilities/registry.ts) validates + dedupes first. */
  createCapabilityDef(input: Omit<CapabilityDefRow, "id" | "createdAt">): CapabilityDefRow {
    const row: CapabilityDefRow = { id: randomUUID(), createdAt: new Date().toISOString(), ...input };
    this.db.prepare(
      `INSERT INTO capability_defs (id,slug,name,description,transport,kind,provision_json,tool_allowlist_json,wants_scratch_dir,requires_connection,secret_env_var,created_at)
       VALUES (@id,@slug,@name,@description,@transport,@kind,@provisionJson,@toolAllowlistJson,@wantsScratchDir,@requiresConnection,@secretEnvVar,@createdAt)`,
    ).run({
      ...row,
      wantsScratchDir: row.wantsScratchDir ? 1 : 0,
      requiresConnection: row.requiresConnection ? 1 : 0,
      secretEnvVar: row.secretEnvVar ?? null,
    });
    return row;
  }
  /** Delete an owner-added capability def by id (idempotent — a missing id matches nothing). */
  deleteCapabilityDef(id: string): void {
    this.db.prepare("DELETE FROM capability_defs WHERE id = ?").run(id);
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
  /**
   * PERMANENTLY delete an agent and CASCADE its sessions (+ each session's pending wakes + the
   * session-keyed orchestration_events), the agent's schedules, and the runs that referenced it (+ the
   * run-keyed run_events for those runs) — in ONE transaction, so no orphan rows survive. Owns ROWS
   * ONLY; the caller drops the deleted sessions' on-disk transcript snapshots (mirrors deleteSession),
   * so returns the deleted session ids. Does NOT guard live sessions — the REST layer blocks that FIRST
   * ("stop the fleet first").
   */
  deleteAgent(id: string): { sessionIds: string[] } {
    const sessionIds = (this.db.prepare("SELECT id FROM sessions WHERE agent_id = ?").all(id) as Row[]).map((r) => r.id as string);
    const runIds = (this.db.prepare("SELECT id FROM runs WHERE agent_id = ?").all(id) as Row[]).map((r) => r.id as string);
    this.db.transaction(() => {
      for (const sid of sessionIds) {
        this.db.prepare("DELETE FROM wakes WHERE session_id = ?").run(sid);
        this.db.prepare("DELETE FROM companion_reminders WHERE session_id = ?").run(sid);
        this.db.prepare("DELETE FROM orchestration_events WHERE manager_session_id = ? OR worker_session_id = ?").run(sid, sid);
      }
      // run_events is project/run-keyed (not agent-keyed) — drop only the rows for THIS agent's runs.
      for (const rid of runIds) this.db.prepare("DELETE FROM run_events WHERE run_id = ?").run(rid);
      this.db.prepare("DELETE FROM schedules WHERE agent_id = ?").run(id);
      this.db.prepare("DELETE FROM runs WHERE agent_id = ?").run(id);
      this.db.prepare("DELETE FROM sessions WHERE agent_id = ?").run(id);
      this.db.prepare("DELETE FROM agents WHERE id = ?").run(id);
    })();
    return { sessionIds };
  }
  /** Count of an agent's sessions still in processState 'live' — the agent-delete guard ("stop the fleet first"). */
  countLiveSessionsForAgent(id: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE agent_id = ? AND process_state = 'live'").get(id) as { c: number }).c;
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
         (id,project_id,agent_id,session_id,key_id,status,input_json,schema_json,result_json,usage_json,transcript_ref,error,webhook_url,idempotency_key,created_at,started_at,ended_at)
       VALUES
         (@id,@projectId,@agentId,@sessionId,@keyId,@status,@inputJson,@schemaJson,@resultJson,@usageJson,@transcriptRef,@error,@webhookUrl,@idempotencyKey,@createdAt,@startedAt,@endedAt)`,
    ).run({
      id: r.id, projectId: r.projectId, agentId: r.agentId,
      sessionId: r.sessionId ?? null, keyId: r.keyId ?? null, status: r.status,
      inputJson: JSON.stringify(r.input ?? null),
      schemaJson: r.schema == null ? null : JSON.stringify(r.schema),
      resultJson: r.result == null ? null : JSON.stringify(r.result),
      usageJson: r.usage == null ? null : JSON.stringify(r.usage),
      transcriptRef: r.transcriptRef ?? null, error: r.error ?? null,
      // Agent Runs R3: NULL on R2 internal runs (additive). The unique index covers the non-null pairs.
      webhookUrl: r.webhookUrl ?? null, idempotencyKey: r.idempotencyKey ?? null,
      createdAt: r.createdAt, startedAt: r.startedAt ?? null, endedAt: r.endedAt ?? null,
    });
  }
  getRun(id: string): AgentRun | undefined {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
    return row ? toRun(row) : undefined;
  }
  /**
   * Agent Runs R3 idempotency lookup: the existing run for a `(keyId, idempotencyKey)` pair, if any.
   * The keyed POST /api/runs consults this BEFORE starting — a hit returns the SAME runId with no second
   * start (no double-spend). Both args are non-null by contract (the route only calls this when the caller
   * supplied an idempotencyKey, and an authed run always carries a keyId), matching the partial index.
   *
   * Idempotency-on-failure (Agent Runs #4): EXCLUDE terminal-failure runs (mirrors the index
   * predicate) — a pair whose only run(s) FAILED/timed_out/cancelled returns undefined, so POST
   * /api/runs starts a FRESH attempt; a completed/in-flight run still replays (true idempotency for
   * successes + in-flight preserved).
   */
  getRunByIdempotency(keyId: string, idempotencyKey: string): AgentRun | undefined {
    const row = this.db.prepare(
      "SELECT * FROM runs WHERE key_id = ? AND idempotency_key = ? AND status NOT IN ('failed','timed_out','cancelled')",
    ).get(keyId, idempotencyKey) as Row | undefined;
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
  // --- Agent Runs R4a: per-key cap accessors + the kill-switch's in-flight set ---------------------
  /** How many runs THIS key currently has in flight (queued/starting/running) — the concurrency-cap counter. */
  countInFlightRunsForKey(keyId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM runs WHERE key_id = ? AND status IN ('queued','starting','running')")
      .get(keyId) as { c: number }).c;
  }
  /** THIS key's in-flight runs (queued/starting/running), oldest first — the per-key kill-switch's cancel set. */
  listInFlightRunsForKey(keyId: string): AgentRun[] {
    return (this.db.prepare("SELECT * FROM runs WHERE key_id = ? AND status IN ('queued','starting','running') ORDER BY created_at")
      .all(keyId) as Row[]).map(toRun);
  }
  /**
   * Best-effort daily TOKEN usage for a key: sum the `inputTokens` field of every retained run-usage
   * snapshot for THIS key created at/after `sinceIso` (the trailing-24h window the caller computes).
   * Agent Runs #2 MIGRATED `usage.inputTokens` from the last-turn occupancy snapshot to CUMULATIVE
   * billed input tokens (summed across all the run's turns; see `readRunUsage`), so this sum is now a
   * genuine trailing-24h input-token meter rather than a coarse occupancy proxy. Runs with no usage_json
   * (in-flight / never recorded) contribute 0. Used by the POST /api/runs daily-token-cap gate.
   */
  sumKeyTokensSince(keyId: string, sinceIso: string): number {
    const row = this.db.prepare(
      "SELECT COALESCE(SUM(json_extract(usage_json, '$.inputTokens')), 0) AS t FROM runs WHERE key_id = ? AND created_at >= ? AND usage_json IS NOT NULL",
    ).get(keyId, sinceIso) as { t: number | null };
    return row.t ?? 0;
  }

  /**
   * Best-effort daily SPEND (USD) for a key: sum the `costUsd` field of every retained run-usage snapshot
   * for THIS key created at/after `sinceIso` (Agent Runs #2). `costUsd` is computed at teardown from the
   * run's cumulative usage × the per-model price table (see `sessions/pricing.ts`); an unknown model
   * records 0 (never throws), so this is a best-effort backstop, not a billing ledger. Runs with no
   * usage_json (or no costUsd) contribute 0. Used by the POST /api/runs daily-spend-cap gate.
   */
  sumKeySpendSince(keyId: string, sinceIso: string): number {
    const row = this.db.prepare(
      "SELECT COALESCE(SUM(json_extract(usage_json, '$.costUsd')), 0) AS t FROM runs WHERE key_id = ? AND created_at >= ? AND usage_json IS NOT NULL",
    ).get(keyId, sinceIso) as { t: number | null };
    return row.t ?? 0;
  }

  /**
   * Read-only HISTORICAL run-usage aggregation for the usage-history surface (GET /api/usage/history):
   * grand totals + per-project + per-agent breakdowns over every retained run-usage snapshot created
   * at/after `sinceIso`, optionally scoped to ONE project. The `runs` table is Loom's only persisted
   * time-series usage data (interactive sessions keep no history). Mirrors the COALESCE(SUM(json_extract(
   * usage_json,'$.field'))) shape of sumKeyTokensSince/sumKeySpendSince, but across the full breakdown and
   * joined to projects/agents for display names (like listAllSessions). Token/cost fields read the
   * CUMULATIVE per-run snapshot (Agent Runs #2). Runs with no usage_json (in-flight / never recorded) are
   * excluded. When projectId is omitted/null/"all" the aggregation spans every project. Best-effort: a run
   * whose model had no price recorded 0 costUsd, so totals are a meter, not a billing ledger.
   */
  aggregateRunUsage(opts: { sinceIso: string; projectId?: string | null }): {
    totals: UsageHistoryTotals;
    byProject: UsageHistoryProject[];
    byAgent: UsageHistoryAgent[];
  } {
    const scoped = opts.projectId != null && opts.projectId !== "all";
    const params: Record<string, string> = { sinceIso: opts.sinceIso };
    if (scoped) params.projectId = opts.projectId as string;
    // runs aliased `r` in every query (join or not) so the column refs are identical throughout.
    const where = `r.created_at >= @sinceIso AND r.usage_json IS NOT NULL${scoped ? " AND r.project_id = @projectId" : ""}`;
    // CUMULATIVE per-run usage fields (Agent Runs #2), summed; a NULL/missing field coalesces to 0.
    const sums = `
      COUNT(*) AS runs,
      COALESCE(SUM(json_extract(r.usage_json, '$.inputTokens')), 0) AS inputTokens,
      COALESCE(SUM(json_extract(r.usage_json, '$.outputTokens')), 0) AS outputTokens,
      COALESCE(SUM(json_extract(r.usage_json, '$.cacheCreationTokens')), 0) AS cacheCreationTokens,
      COALESCE(SUM(json_extract(r.usage_json, '$.cacheReadTokens')), 0) AS cacheReadTokens,
      COALESCE(SUM(json_extract(r.usage_json, '$.costUsd')), 0) AS costUsd`;
    const num = (v: unknown): number => Number(v) || 0;
    const measures = (row: Row): UsageHistoryTotals => ({
      runs: num(row.runs),
      inputTokens: num(row.inputTokens),
      outputTokens: num(row.outputTokens),
      cacheCreationTokens: num(row.cacheCreationTokens),
      cacheReadTokens: num(row.cacheReadTokens),
      costUsd: num(row.costUsd),
    });

    const t = this.db.prepare(`SELECT ${sums} FROM runs r WHERE ${where}`).get(params) as Row;
    const totals = measures(t);

    const byProject = (this.db.prepare(
      `SELECT r.project_id AS projectId, p.name AS projectName, ${sums}
       FROM runs r LEFT JOIN projects p ON r.project_id = p.id
       WHERE ${where} GROUP BY r.project_id ORDER BY costUsd DESC, runs DESC`,
    ).all(params) as Row[]).map((row) => ({
      projectId: row.projectId as string,
      projectName: (row.projectName as string | null) ?? null,
      ...measures(row),
    }));

    // LEFT JOIN agents (for the name) AND projects (on the agent's project_id, for the OWNING-project
    // label) so identically-named agents across projects disambiguate in the "all" scope.
    const byAgent = (this.db.prepare(
      `SELECT r.agent_id AS agentId, a.name AS agentName, a.project_id AS projectId, p.name AS projectName, ${sums}
       FROM runs r LEFT JOIN agents a ON r.agent_id = a.id LEFT JOIN projects p ON a.project_id = p.id
       WHERE ${where} GROUP BY r.agent_id ORDER BY costUsd DESC, runs DESC`,
    ).all(params) as Row[]).map((row) => ({
      agentId: row.agentId as string,
      agentName: (row.agentName as string | null) ?? null,
      projectId: (row.projectId as string | null) ?? null,
      projectName: (row.projectName as string | null) ?? null,
      ...measures(row),
    }));

    return { totals, byProject, byAgent };
  }

  // --- Session usage telemetry (epic c9924bcd): the DATA layer for daemon-collected interactive-session
  // usage. Each `session_usage_samples` row is a per-interval DELTA (additive), so totals/buckets are a
  // plain SUM — no read-time monotonicity math (the sampler, card B, computes the deltas + handles
  // transcript resets). insertUsageSample appends one row; aggregateSessionUsage reads totals +
  // byProject/byAgent/byDay over a window; pruneUsageSamples enforces retention. Mirrors aggregateRunUsage's
  // COALESCE(SUM(...)) + LEFT JOIN projects/agents-for-names + GROUP BY shape, but SUMs the stored numeric
  // DELTA columns directly (each row is already a delta — not a json_extract of a cumulative snapshot). ---

  /** Append one usage sample (a per-interval billed-usage DELTA for a session segment). */
  insertUsageSample(s: UsageSample): void {
    this.db.prepare(
      `INSERT INTO session_usage_samples
         (id,session_id,project_id,agent_id,model,ts,input_tokens,output_tokens,cache_creation_tokens,cache_read_tokens,cost_usd)
       VALUES
         (@id,@sessionId,@projectId,@agentId,@model,@ts,@inputTokens,@outputTokens,@cacheCreationTokens,@cacheReadTokens,@costUsd)`,
    ).run({
      id: s.id, sessionId: s.sessionId, projectId: s.projectId,
      agentId: s.agentId ?? null, model: s.model ?? null, ts: s.ts,
      inputTokens: s.inputTokens, outputTokens: s.outputTokens,
      cacheCreationTokens: s.cacheCreationTokens, cacheReadTokens: s.cacheReadTokens,
      costUsd: s.costUsd,
    });
  }

  /**
   * Read-only HISTORICAL interactive-session usage aggregation for GET /api/usage/sessions/history: grand
   * totals + per-project + per-agent + per-DAY breakdowns over every sample at/after `sinceIso`, optionally
   * scoped to ONE project. Mirrors aggregateRunUsage's COALESCE(SUM(...)) + LEFT JOIN projects/agents-for-
   * names + GROUP BY shape, but SUMs the stored numeric DELTA columns directly (each row is already a
   * per-interval delta — no json_extract, no monotonicity math). `byDay` buckets via GROUP BY substr(ts,1,10)
   * (the ISO date), ordered ascending, for the over-time chart. When projectId is omitted/null/"all" the
   * aggregation spans every project. `bucket` is reserved for future granularities (the over-time series is
   * day-grained today). Cost is best-effort — an unpriced model's samples contribute 0 costUsd.
   */
  aggregateSessionUsage(opts: { sinceIso: string; projectId?: string | null; bucket?: "day" }): {
    totals: SessionUsageTotals;
    byProject: SessionUsageProject[];
    byAgent: SessionUsageAgent[];
    byDay: SessionUsageDay[];
  } {
    const scoped = opts.projectId != null && opts.projectId !== "all";
    const params: Record<string, string> = { sinceIso: opts.sinceIso };
    if (scoped) params.projectId = opts.projectId as string;
    // samples aliased `s` in every query (join or not) so the column refs are identical throughout.
    const where = `s.ts >= @sinceIso${scoped ? " AND s.project_id = @projectId" : ""}`;
    // Each row's columns are already per-interval DELTAS; sum directly (a NULL/missing field coalesces to 0).
    const sums = `
      COUNT(*) AS samples,
      COALESCE(SUM(s.input_tokens), 0) AS inputTokens,
      COALESCE(SUM(s.output_tokens), 0) AS outputTokens,
      COALESCE(SUM(s.cache_creation_tokens), 0) AS cacheCreationTokens,
      COALESCE(SUM(s.cache_read_tokens), 0) AS cacheReadTokens,
      COALESCE(SUM(s.cost_usd), 0) AS costUsd`;
    const num = (v: unknown): number => Number(v) || 0;
    const measures = (row: Row): SessionUsageTotals => ({
      samples: num(row.samples),
      inputTokens: num(row.inputTokens),
      outputTokens: num(row.outputTokens),
      cacheCreationTokens: num(row.cacheCreationTokens),
      cacheReadTokens: num(row.cacheReadTokens),
      costUsd: num(row.costUsd),
    });

    const t = this.db.prepare(`SELECT ${sums} FROM session_usage_samples s WHERE ${where}`).get(params) as Row;
    const totals = measures(t);

    const byProject = (this.db.prepare(
      `SELECT s.project_id AS projectId, p.name AS projectName, ${sums}
       FROM session_usage_samples s LEFT JOIN projects p ON s.project_id = p.id
       WHERE ${where} GROUP BY s.project_id ORDER BY costUsd DESC, samples DESC`,
    ).all(params) as Row[]).map((row) => ({
      projectId: row.projectId as string,
      projectName: (row.projectName as string | null) ?? null,
      ...measures(row),
    }));

    // LEFT JOIN agents (for the name) AND projects (on the agent's project_id, for the OWNING-project
    // label) so identically-named agents across projects disambiguate in the "all" scope.
    const byAgent = (this.db.prepare(
      `SELECT s.agent_id AS agentId, a.name AS agentName, a.project_id AS projectId, p.name AS projectName, ${sums}
       FROM session_usage_samples s LEFT JOIN agents a ON s.agent_id = a.id LEFT JOIN projects p ON a.project_id = p.id
       WHERE ${where} GROUP BY s.agent_id ORDER BY costUsd DESC, samples DESC`,
    ).all(params) as Row[]).map((row) => ({
      agentId: (row.agentId as string | null) ?? null,
      agentName: (row.agentName as string | null) ?? null,
      projectId: (row.projectId as string | null) ?? null,
      projectName: (row.projectName as string | null) ?? null,
      ...measures(row),
    }));

    const byDay = (this.db.prepare(
      `SELECT substr(s.ts, 1, 10) AS day, ${sums}
       FROM session_usage_samples s WHERE ${where} GROUP BY day ORDER BY day ASC`,
    ).all(params) as Row[]).map((row) => ({
      day: row.day as string,
      ...measures(row),
    }));

    return { totals, byProject, byAgent, byDay };
  }

  /** Retention: delete every sample older than `beforeIso` (ts < beforeIso). Returns rows removed. */
  pruneUsageSamples(beforeIso: string): number {
    return this.db.prepare("DELETE FROM session_usage_samples WHERE ts < ?").run(beforeIso).changes;
  }

  /**
   * The sampler's RESTART-SAFE baseline: the already-persisted token SUM per session (one GROUP BY scan).
   * `lastSeen` is in-memory and wiped on every daemon restart, so without this the sampler's FIRST-sight
   * delta after a restart would re-emit a still-live session's whole transcript cumulative — double-counting
   * everything already recorded. With it, first-sight delta = `transcript_cumulative − this[sessionId]`: a
   * session resumed across the restart (plain `--resume` REUSES its engine id + the SAME transcript, which
   * still holds the full pre-restart cumulative) counts only the UNCOUNTED remainder, while a genuinely new
   * session (no prior rows) still counts its full cumulative-so-far. Each row is already a per-interval delta,
   * so the per-session total is a plain SUM (epic c9924bcd, card B).
   */
  usagePersistedTotalsBySession(): Map<string, { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number }> {
    const rows = this.db.prepare(
      `SELECT session_id AS sessionId,
              COALESCE(SUM(input_tokens), 0) AS inputTokens,
              COALESCE(SUM(output_tokens), 0) AS outputTokens,
              COALESCE(SUM(cache_creation_tokens), 0) AS cacheCreationTokens,
              COALESCE(SUM(cache_read_tokens), 0) AS cacheReadTokens
       FROM session_usage_samples GROUP BY session_id`,
    ).all() as Row[];
    const out = new Map<string, { inputTokens: number; outputTokens: number; cacheCreationTokens: number; cacheReadTokens: number }>();
    for (const r of rows) {
      out.set(r.sessionId as string, {
        inputTokens: Number(r.inputTokens) || 0,
        outputTokens: Number(r.outputTokens) || 0,
        cacheCreationTokens: Number(r.cacheCreationTokens) || 0,
        cacheReadTokens: Number(r.cacheReadTokens) || 0,
      });
    }
    return out;
  }

  /** Truncate the derived usage-samples table (returns rows removed). Used ONLY by the one-shot corrective
   *  reset (UsageSampler.correctiveResetOnce) that rebuilds inflated telemetry from scratch — this table is
   *  pure derived data (re-seedable from the on-disk transcripts via the boot backfill). */
  clearUsageSamples(): number {
    return this.db.prepare("DELETE FROM session_usage_samples").run().changes;
  }

  // --- Agent Runs follow-up #1: the run-scoped audit trail (cap-rejections) -------------------------
  // Project-scoped, NOT session-keyed (orchestration_events doesn't fit — a cap-reject has no session).
  // The core write is the 429 cap-rejection at POST /api/runs (no run row is created there, so this is the
  // ONLY trace). The route's call site swallows any fault from insertRunEvent — audit is best-effort and
  // must never change the 429 response or the cap enforcement.

  /** Append a run-scoped audit event (detail serialized to JSON). */
  insertRunEvent(e: RunEvent): void {
    this.db.prepare(
      `INSERT INTO run_events (id,project_id,key_id,run_id,kind,detail_json,created_at)
       VALUES (@id,@projectId,@keyId,@runId,@kind,@detailJson,@createdAt)`,
    ).run({
      id: e.id, projectId: e.projectId, keyId: e.keyId ?? null, runId: e.runId ?? null,
      kind: e.kind, detailJson: e.detail == null ? null : JSON.stringify(e.detail),
      createdAt: e.createdAt,
    });
  }
  /** A project's run-events, newest first, bounded (default 200) — the Runs-page cap-rejection strip. */
  listRunEvents(projectId: string, limit = 200): RunEvent[] {
    return (this.db.prepare("SELECT * FROM run_events WHERE project_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?")
      .all(projectId, limit) as Row[]).map(toRunEvent);
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
      `INSERT INTO profiles (id,name,role,description,allow_delta,skills,model,icon,browser_testing,document_conversion,restricted_tools,no_commit,connections,capabilities)
       VALUES (@id,@name,@role,@description,@allowDelta,@skills,@model,@icon,@browserTesting,@documentConversion,@restrictedTools,@noCommit,@connections,@capabilities)`,
    ).run({
      id: p.id, name: p.name, role: p.role ?? null, description: p.description,
      // string[] columns persist as JSON text; skills NULL means "deliver all".
      allowDelta: JSON.stringify(p.allowDelta ?? []),
      skills: p.skills == null ? null : JSON.stringify(p.skills),
      model: p.model ?? null, icon: p.icon ?? null,
      browserTesting: p.browserTesting ? 1 : 0, // boolean ↔ INTEGER; absent ⇒ 0 (off)
      documentConversion: p.documentConversion ? 1 : 0, // boolean ↔ INTEGER; absent ⇒ 0 (off)
      restrictedTools: p.restrictedTools ? 1 : 0, // boolean ↔ INTEGER; absent ⇒ 0 (off)
      noCommit: p.noCommit ? 1 : 0, // boolean ↔ INTEGER; absent ⇒ 0 (off)
      connections: JSON.stringify(p.connections ?? []), // [] = no access (absent ⇒ [], NOT skills' "all")
      capabilities: JSON.stringify(p.capabilities ?? []), // agent-tooling P4: registry-capability grants, raw
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
      document_conversion: patch.documentConversion === undefined ? undefined : patch.documentConversion ? 1 : 0,
      restricted_tools: patch.restrictedTools === undefined ? undefined : patch.restrictedTools ? 1 : 0,
      no_commit: patch.noCommit === undefined ? undefined : patch.noCommit ? 1 : 0,
      connections: patch.connections === undefined ? undefined : JSON.stringify(patch.connections),
      capabilities: patch.capabilities === undefined ? undefined : JSON.stringify(patch.capabilities),
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
  /**
   * Read a profile's bundled-customization `base` snapshot (raw JSON text of the shipped def at last
   * sync); null when unset. Kept OFF the Profile shape (toProfile ignores the column) — it's internal
   * customization plumbing, not part of the entity the validator/resolver see.
   */
  getProfileBaseSnapshot(id: string): string | null {
    const r = this.db.prepare("SELECT base_snapshot FROM profiles WHERE id = ?").get(id) as
      | { base_snapshot: string | null }
      | undefined;
    return r ? (r.base_snapshot ?? null) : null;
  }
  /** Advance (or clear, with null) a profile's `base` snapshot — set on adopt/reset and the boot backfill. */
  setProfileBaseSnapshot(id: string, snapshot: string | null): void {
    this.db.prepare("UPDATE profiles SET base_snapshot = ? WHERE id = ?").run(snapshot, id);
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
  /**
   * LIVE sessions for an agent (archived excluded), preserving listSessions' last_activity-DESC order.
   * This is the canonical "is there a live singleton?" query — every singleton/liveness decision (the
   * Platform Lead's live-precedence guard, the /api/platform/home live-session info) MUST go through a
   * LIVE filter, NOT a plain .find() over listSessions: that list is ordered by last_activity DESC, so a
   * recently-STOPPED row sorts AHEAD of an idle-but-LIVE one and a bare .find() would pick the dead one
   * (this exact recency-over-liveness trap re-introduced the duplicate-live-Lead bug — see 0e40dde).
   * Filtering to processState === "live" FIRST makes liveness win; among multiple live rows (legacy
   * accumulation that shouldn't happen) the most-recently-active still leads.
   */
  liveSessions(agentId: string): Session[] {
    return this.listSessions(agentId).filter((s) => s.processState === "live");
  }
  getSession(id: string): Session | undefined {
    const r = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(id) as Row | undefined;
    return r ? toSession(r) : undefined;
  }
  /**
   * Sessions whose id STARTS WITH `prefix` — across all projects and incl. archived, like getSession
   * (an archived row is still addressable by id-prefix). Powers transcript_read's id-prefix resolution:
   * the caller treats exactly 1 match as a hit and >1 as ambiguous. Session ids are UUIDs (hex + hyphens,
   * no `%`/`_`), so the prefix is a literal LIKE pattern with no wildcard-escaping needed.
   */
  findSessionsByIdPrefix(prefix: string): Session[] {
    return (this.db.prepare("SELECT * FROM sessions WHERE id LIKE ? ORDER BY id").all(`${prefix}%`) as Row[]).map(toSession);
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
  /**
   * One-time boot backfill: sessions that EXITED before auto-archive-on-exit (card b37750a4) shipped never
   * got `archived_at` stamped, so they're invisible in BOTH the live rail (exited rows are pruned) AND the
   * project Archive tab (listArchivedSessions filters `archived_at IS NOT NULL`). Stamp `archived_at` on
   * every such legacy row so the trees appear.
   *
   * Uses each row's REAL end-time — `COALESCE(last_activity, created_at)`, NOT `now()` — so the Archive's
   * `archived_at DESC` ordering keeps these in chronological position rather than collapsing them all to the
   * migration instant at the top. (Both columns are NOT NULL; last_activity is the session's last observed
   * activity, the closest proxy for when it stopped. COALESCE is a belt-and-suspenders fallback.)
   *
   * Predicate `process_state = 'exited'` ONLY: the ProcessState union is `none|starting|live|exited` — there
   * is NO 'dead' (that's a Resumability value), so 'exited' is the whole terminal set. 'none' is EXCLUDED —
   * it's a shell / non-engine placeholder row, never a real stopped session (mirrors onExit, which archives
   * only real DB engine rows). `role='run'` is EXCLUDED — ephemeral Agent Run sessions must never clutter
   * the Archive (same exclusion as onExit). Already-archived rows (archived_at NOT NULL) are untouched, so
   * the 6.5/6.6 auto-archived sessions keep their original archived_at.
   *
   * One-shot via an app_meta marker (same fire-exactly-once pattern as the first-run setup flag / column-role
   * backfill): marker checked FIRST, stamped LAST — a second invocation is a clean no-op (returns 0). SAFE
   * re: resumeFleetOnBoot — a session it resumes is un-archived by restoreSession regardless, and this matches
   * only already-'exited' rows (a crashed session about to be recovered+resumed is still 'live'/'starting' at
   * this point, so it isn't touched here). Returns the count of rows stamped (0 if the marker was already set).
   */
  backfillArchivedAtOnce(): number {
    if (this.getMeta(ARCHIVED_AT_BACKFILL_KEY) !== undefined) return 0; // guard: already run (one-shot)
    const res = this.db.prepare(
      `UPDATE sessions
          SET archived_at = COALESCE(last_activity, created_at)
        WHERE archived_at IS NULL
          AND process_state = 'exited'
          AND (role IS NULL OR role <> 'run')`,
    ).run();
    this.setMeta(ARCHIVED_AT_BACKFILL_KEY, new Date().toISOString()); // stamp last — the one-shot guarantee
    return res.changes;
  }
  /**
   * One-time backfill of the structured `Task.held` flag from the LEGACY uppercase-HOLD/CONFIRM title
   * heuristic (isOwnerHeldTaskTitle). Before `held` existed, the idle watchdog discounted owner-gated
   * cards by matching their title; that brittle path is now gone, so this seeds the flag on every card
   * that WOULD have been discounted, so intentionally-parked cards keep their discount instead of
   * suddenly nagging. After this runs, `held` is authoritative — the title regex never gates again.
   *
   * Title-only (lane-agnostic) on purpose: that mirrors the OLD discount, which matched the title in
   * EVERY actionable lane. A matched done/blocked card is harmless (held has no effect on a terminal or
   * already-excluded card). One-shot via an app_meta marker (checked FIRST, stamped LAST), idempotent on
   * a second invocation (returns 0). The SQLite regex can't do word boundaries, so we match in JS.
   * Returns the count of rows newly flagged.
   */
  backfillHeldFromTitlesOnce(): number {
    if (this.getMeta(HELD_BACKFILL_KEY) !== undefined) return 0; // guard: already run (one-shot)
    const rows = this.db.prepare("SELECT id, title FROM tasks WHERE held = 0").all() as Row[];
    const flag = this.db.prepare("UPDATE tasks SET held = 1 WHERE id = ?");
    let changed = 0;
    const run = this.db.transaction((toFlag: string[]) => { for (const id of toFlag) { flag.run(id); changed++; } });
    run(rows.filter((r) => isOwnerHeldTaskTitle(r.title as string)).map((r) => r.id as string));
    this.setMeta(HELD_BACKFILL_KEY, new Date().toISOString()); // stamp last — the one-shot guarantee
    return changed;
  }
  /** Permanently delete a session row (the Archive tab's Delete). Also drops its pending wakes + reminders. */
  deleteSession(id: string): void {
    this.db.prepare("DELETE FROM wakes WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM companion_reminders WHERE session_id = ?").run(id);
    this.db.prepare("DELETE FROM sessions WHERE id = ?").run(id);
  }
  insertSession(s: Session): void {
    this.db.prepare(
      `INSERT INTO sessions (
         id,project_id,agent_id,engine_session_id,title,cwd,process_state,resumability,busy,
         created_at,last_activity,last_error,
         role,browser_testing,document_conversion,restricted_tools,no_commit,skills,connections,capabilities,parent_session_id,task_id,worktree_path,branch,gen,recycled_from,
         ctx_input_tokens,ctx_turns,ctx_updated_at,model,rate_limited_until,rate_limit_deadline)
       VALUES (
         @id,@projectId,@agentId,@engineSessionId,@title,@cwd,@processState,@resumability,@busy,
         @createdAt,@lastActivity,@lastError,
         @role,@browserTesting,@documentConversion,@restrictedTools,@noCommit,@skills,@connections,@capabilities,@parentSessionId,@taskId,@worktreePath,@branch,@gen,@recycledFrom,
         @ctxInputTokens,@ctxTurns,@ctxUpdatedAt,@model,@rateLimitedUntil,@rateLimitDeadline)`,
    ).run({
      ...s,
      busy: s.busy ? 1 : 0,
      // Orchestration fields are optional on Session; coerce absent ones (undefined) to NULL/0
      // so plain phase-1 session literals insert unchanged.
      role: s.role ?? null,
      browserTesting: s.browserTesting ? 1 : 0, // off (0) on every plain session literal
      documentConversion: s.documentConversion ? 1 : 0, // off (0) on every plain session literal
      restrictedTools: s.restrictedTools ? 1 : 0, // off (0) on every plain session literal
      noCommit: s.noCommit ? 1 : 0, // off (0) on every plain session literal
      // skill subset → JSON text; null/absent ⇒ NULL = deliver all (today's behavior). An empty array is
      // also stored as NULL ("no subset ⇒ all") so the read side never has to special-case [].
      skills: s.skills && s.skills.length ? JSON.stringify(s.skills) : null,
      // connection-id allowlist → JSON text; absent ⇒ '[]' = no access (unlike skills, empty is NEVER "all").
      connections: JSON.stringify(s.connections ?? []),
      // agent-tooling P4: registry-capability grants pinned at spawn → JSON text; absent ⇒ '[]' = none.
      capabilities: JSON.stringify(s.capabilities ?? []),

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
  /**
   * Set ONLY the human-readable lastError (without touching the rate-limit park, unlike
   * setRateLimitedUntil). Used by the CrashRecoveryWatcher to stamp a crash-loop give-up so Mission
   * Control surfaces it role-agnostically off the session row (a dead manager has no parent to nudge).
   * Bumps last_activity so the UI reflects the change. Pass null to clear.
   */
  setLastError(id: string, lastError: string | null): void {
    this.db.prepare("UPDATE sessions SET last_error = ?, last_activity = ? WHERE id = ?")
      .run(lastError, new Date().toISOString(), id);
  }
  /** Turn in-flight flag — driven hook-side (UserPromptSubmit rising, Stop/StopFailure falling). */
  setBusy(id: string, busy: boolean): void {
    this.db.prepare("UPDATE sessions SET busy = ?, last_activity = ? WHERE id = ?")
      .run(busy ? 1 : 0, new Date().toISOString(), id);
  }
  /**
   * Re-pin the session-row `restrictedTools` flag directly (the human-only Companion Manage toggle) —
   * a DIRECT row write, NOT re-resolved from the Profile (mirrors how the row is the source of truth on
   * every resume/fork/recycle path — see resolveAgentSpawn's comment). restrictedTools is a spawn-time
   * property (the `--disallowedTools` list), so this write alone has NO live effect until the session is
   * next restarted (stop+resume) — the caller (REST route) is responsible for making that plain to the human.
   */
  setRestrictedTools(id: string, restrictedTools: boolean): void {
    this.db.prepare("UPDATE sessions SET restricted_tools = ?, last_activity = ? WHERE id = ?")
      .run(restrictedTools ? 1 : 0, new Date().toISOString(), id);
  }
  /**
   * On daemon boot, no pty from a previous run survives — reconcile any session still
   * marked live/starting to exited (it stays resumable if it captured an engine id).
   * Returns the recovered rows (read BEFORE the flip) so boot can run the crash-path
   * backstop on each — snapshot the transcript + auto-archive — work the missed onExit never did.
   */
  recoverStaleSessions(): Session[] {
    const stale = (this.db.prepare(
      "SELECT * FROM sessions WHERE process_state IN ('live','starting')",
    ).all() as Row[]).map(toSession);
    this.db.prepare(
      "UPDATE sessions SET process_state = 'exited', busy = 0 WHERE process_state IN ('live','starting')",
    ).run();
    return stale;
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
   * deadline, so the FIRST cap sets it and re-caps preserve it (the predecessor's episode-bounded deadline) —
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
  /** EVERY session currently parked with a rate-limit (rate_limited_until set), live or not — the
   *  clear-usage-hold CASCADE's work set. (Distinct from listRateLimitEpisodes, which is LIVE +
   *  deadline-armed: a session can carry a park with no episode deadline, and a dead row may linger.) */
  listRateLimited(): Session[] {
    return (this.db.prepare("SELECT * FROM sessions WHERE rate_limited_until IS NOT NULL")
      .all() as Row[]).map(toSession);
  }
  /**
   * Clear the rate-limit park (rate_limited_until + rate_limit_deadline) WITHOUT touching lastError —
   * the on-EXIT cleanup. An exited/terminal session must never read RATE-LIMITED (its until-timestamp
   * would otherwise linger in the Attention queue until it naturally passes), but its lastError (e.g. a
   * crash-loop banner the attention surface keys off) must survive — so unlike setRateLimitedUntil
   * (which also writes lastError + bumps last_activity), this touches ONLY the two park columns.
   */
  clearRateLimit(id: string): void {
    this.db.prepare("UPDATE sessions SET rate_limited_until = NULL, rate_limit_deadline = NULL WHERE id = ?").run(id);
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

  // --- ContextWatcher recycle-nudge state (persisted per-manager, parity with the idle accessors above
  // and the rate-limit accessors). No reset method: a context nudge is answered by RECYCLING (the manager
  // goes not-live and its successor is a fresh row with default state), so there is no in-session re-arm. ---
  /** Read the per-session context-recycle-nudge state; undefined when the session row is missing. */
  getContextNudgeState(id: string): ContextNudgeState | undefined {
    const r = this.db.prepare(
      "SELECT context_nudge_policy, last_context_nudge_at, context_nudge_unanswered FROM sessions WHERE id = ?",
    ).get(id) as Row | undefined;
    if (!r) return undefined;
    return {
      policy: (r.context_nudge_policy as ContextNudgePolicy) ?? "watching",
      lastContextNudgeAt: (r.last_context_nudge_at as string) ?? null,
      unanswered: (r.context_nudge_unanswered as number) ?? 0,
    };
  }
  /** Set the context-nudge policy. 'escalated' is the once-per-session gate that stops further nudges. */
  setContextNudgePolicy(id: string, policy: ContextNudgePolicy): void {
    this.db.prepare("UPDATE sessions SET context_nudge_policy = ? WHERE id = ?").run(policy, id);
  }
  /** Record that a context-recycle nudge fired: stamp last_context_nudge_at + increment the unanswered counter. */
  recordContextNudge(id: string, atIso: string): void {
    this.db.prepare("UPDATE sessions SET last_context_nudge_at = ?, context_nudge_unanswered = context_nudge_unanswered + 1 WHERE id = ?")
      .run(atIso, id);
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
  /** Currently-LIVE worker sessions across all projects — the BusyWorkerWatcher's work set (stuck-busy). */
  listLiveWorkers(): Session[] {
    return (this.db.prepare("SELECT * FROM sessions WHERE role = 'worker' AND process_state = 'live'")
      .all() as Row[]).map(toSession);
  }
  /** ALL currently-LIVE sessions across every role/project — the usage sampler's per-tick work set
   *  (epic c9924bcd, card B). The sampler skips run sessions itself (accounted via aggregateRunUsage). */
  listLiveSessions(): Session[] {
    return (this.db.prepare("SELECT * FROM sessions WHERE process_state = 'live'")
      .all() as Row[]).map(toSession);
  }
  /** Every session (live, exited, OR archived) that ever captured an engine transcript — the usage
   *  sampler's one-time boot-backfill scan set (epic c9924bcd, card B). A session whose transcript is
   *  already pruned from disk is skipped by the sampler (readRunUsage → null). */
  listSessionsWithEngineId(): Session[] {
    return (this.db.prepare("SELECT * FROM sessions WHERE engine_session_id IS NOT NULL")
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
  /** The session (if any) whose `recycled_from` points at `sessionId` — the FORWARD counterpart to
   *  `hasSuccessor`'s boolean check, returning the actual successor row so a caller can walk the chain. */
  getSuccessor(sessionId: string): Session | undefined {
    const r = this.db.prepare("SELECT * FROM sessions WHERE recycled_from = ? LIMIT 1").get(sessionId) as Row | undefined;
    return r ? toSession(r) : undefined;
  }
  /** Count of currently-LIVE manager sessions — the Scheduler's manager-cap gate (§19a hardening). */
  countLiveManagers(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE role = 'manager' AND process_state = 'live'")
      .get() as { c: number }).c;
  }
  /**
   * Count of currently-LIVE auditor sessions — BOTH the dev Platform Auditor ('auditor') and the end-user
   * Workspace Auditor ('workspace-auditor'). The Scheduler counts these against their OWN small budget,
   * SEPARATE from the manager cap, so a read-mostly scheduled auditor neither consumes a manager slot nor
   * is blocked when the manager cap is full (and vice versa).
   */
  countLiveAuditors(): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE role IN ('auditor', 'workspace-auditor') AND process_state = 'live'")
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
  /**
   * EVERY orchestration event that TOUCHES a session — it appears as the manager OR the worker. The
   * union of listEvents + listEventsForWorker in one ordered pass; the audit-log read model (sessions/
   * audit.ts) builds a session's replayable timeline from this. Chronological (ts, rowid breaks same-ts
   * ties — true insertion order within this single query).
   */
  listEventsForSession(sessionId: string): OrchestrationEvent[] {
    return (this.db.prepare(
      "SELECT * FROM orchestration_events WHERE manager_session_id = ? OR worker_session_id = ? ORDER BY ts, rowid",
    ).all(sessionId, sessionId) as Row[]).map(toOrchestrationEvent);
  }
  /**
   * ALL direct child sessions of a parent (workers a manager spawned), INCLUDING archived ones — the
   * audit-log wave assembly needs the complete tree, not the rail feed. Mirrors listWorkers but without
   * the archived_at filter (an archived worker still belongs to the wave's history). Ordered by creation.
   */
  listChildSessions(parentSessionId: string): Session[] {
    return (this.db.prepare("SELECT * FROM sessions WHERE parent_session_id = ? ORDER BY created_at")
      .all(parentSessionId) as Row[]).map(toSession);
  }
  /**
   * Durable queued-message inbox (card 2ca18433): every `session_message_queued` event with NO matching
   * `session_message_delivered` marker (paired by `detail.msgId`) — i.e. a held message that was NEVER
   * handed to its recipient. This is the boot scan's work set (recoverUndeliveredMessagesOnBoot): the ones
   * to re-enqueue onto a resumed recipient / surface to a resumed sender. Chronological (FIFO) so replay
   * preserves send order. The anti-join is on the JSON-extracted msgId; a queued event missing a msgId
   * (shouldn't happen — the helpers always mint one) coalesces to "" and is treated as its own key.
   */
  listUndeliveredQueuedMessages(): OrchestrationEvent[] {
    return (this.db.prepare(
      `SELECT * FROM orchestration_events
         WHERE kind = 'session_message_queued'
           AND COALESCE(json_extract(detail_json, '$.msgId'), '') NOT IN (
             SELECT COALESCE(json_extract(detail_json, '$.msgId'), '')
               FROM orchestration_events WHERE kind = 'session_message_delivered'
           )
       ORDER BY ts, rowid`,
    ).all() as Row[]).map(toOrchestrationEvent);
  }
  /** True once a `session_message_delivered` marker exists for this msgId — the idempotency guard the
   *  delivery callback uses so a queued message resolves EXACTLY once (a re-fired onDeliver is a no-op). */
  isQueuedMessageDelivered(msgId: string): boolean {
    return !!this.db.prepare(
      "SELECT 1 FROM orchestration_events WHERE kind = 'session_message_delivered' AND json_extract(detail_json, '$.msgId') = ? LIMIT 1",
    ).get(msgId);
  }
  /**
   * Like listUndeliveredQueuedMessages but SCOPED to one recipient worker (card dcb25bd9): every unresolved
   * `session_message_queued` event whose recipient (worker_session_id) is this worker — i.e. queued
   * direction that was HELD and never handed to it. The worker-done guard (workerReport) reads this to
   * REFUSE a done-report while manager direction is still pending, then narrows by origin (detail.sender ===
   * the worker's manager) so platform/cross-tree sends don't gate. Same msgId anti-join + FIFO order as the
   * unscoped scan; watcher/system nudges use the non-durable enqueue and never appear here (origin-accurate).
   */
  listUnresolvedQueuedMessagesForWorker(workerSessionId: string): OrchestrationEvent[] {
    return (this.db.prepare(
      `SELECT * FROM orchestration_events
         WHERE kind = 'session_message_queued'
           AND worker_session_id = ?
           AND COALESCE(json_extract(detail_json, '$.msgId'), '') NOT IN (
             SELECT COALESCE(json_extract(detail_json, '$.msgId'), '')
               FROM orchestration_events WHERE kind = 'session_message_delivered'
           )
       ORDER BY ts, rowid`,
    ).all(workerSessionId) as Row[]).map(toOrchestrationEvent);
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
      `INSERT INTO tasks (id,project_id,title,body,column_key,position,priority,held,deferred,created_at,updated_at)
       VALUES (@id,@projectId,@title,@body,@columnKey,@position,@priority,@held,@deferred,@createdAt,@updatedAt)`,
    ).run({ ...t, priority: t.priority ?? "p2", held: t.held ? 1 : 0, deferred: t.deferred ? 1 : 0 }); // defaults when an (untyped) caller omits them
  }
  updateTask(id: string, patch: Partial<Pick<Task, "title" | "body" | "columnKey" | "position" | "priority" | "held" | "deferred">>): void {
    const cur = this.db.prepare("SELECT * FROM tasks WHERE id = ?").get(id) as Row | undefined;
    if (!cur) return;
    const t = toTask(cur);
    const next = { ...t, ...patch, updatedAt: new Date().toISOString() };
    this.db.prepare(
      "UPDATE tasks SET title=@title, body=@body, column_key=@columnKey, position=@position, priority=@priority, held=@held, deferred=@deferred, updated_at=@updatedAt WHERE id=@id",
    ).run({ ...next, held: next.held ? 1 : 0, deferred: next.deferred ? 1 : 0 });
  }
  /** PERMANENTLY delete a task card. Idempotent on a missing id (DELETE … WHERE matches nothing). HUMAN-only
   * (no MCP path) — an agent can only move a card to done; the REST route enforces the live-session guard. */
  deleteTask(id: string): void {
    this.db.prepare("DELETE FROM tasks WHERE id = ?").run(id);
  }
  /** Count of sessions still in processState 'live' bound to a task — the task-delete guard ("don't delete a
   * card out from under a running worker"), mirroring countLiveSessionsForAgent/InProject. */
  countLiveSessionsForTask(id: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE task_id = ? AND process_state = 'live'").get(id) as { c: number }).c;
  }
  /** The id of a session still in processState 'live' bound to this task, if any — the BOARD-WIDE
   * live-worker-on-task guard for worker_spawn (a SIBLING manager's worker on the same task must be visible,
   * so this is deliberately NOT manager-scoped like listWorkers). Returns undefined when no live session
   * holds the task — the legitimate re-spawn-after-rejected-merge case (the prior worker is DEAD, not live). */
  liveSessionIdForTask(id: string): string | undefined {
    const r = this.db.prepare("SELECT id FROM sessions WHERE task_id = ? AND process_state = 'live' ORDER BY created_at LIMIT 1").get(id) as { id: string } | undefined;
    return r?.id;
  }
  /** ALL sessions still in processState 'live' bound to this task — the sibling-retirement sweep set used by
   * confirmWorkerMerge/recycleWorker to graceful-stop any live session OTHER than the one being merged/recycled
   * BEFORE the shared worktree is deleted, so no zombie is left bound to a removed cwd (incident 35fc823f). The
   * single-id {@link liveSessionIdForTask} returns only the first; this returns the whole set. */
  listLiveSessionsForTask(id: string): Session[] {
    return (this.db.prepare("SELECT * FROM sessions WHERE task_id = ? AND process_state = 'live' ORDER BY created_at")
      .all(id) as Row[]).map(toSession);
  }

  /**
   * Atomic safe board-column layout change (task B). In ONE transaction: (1) apply the planned card
   * re-keys (renames old→new, removed-column cards → defaultLandingKey) IN ORDER; (2) sweep ANY remaining
   * card whose column_key is not in the new layout to defaultLandingKey — the unconditional backstop that
   * upholds the HARD INVARIANT (no task references a non-existent column), covering even a pre-existing
   * orphan the planner couldn't see; (3) persist the new columns onto the project's config override,
   * preserving every other config field; (4) ASSERT zero orphans remain or throw to roll the whole thing
   * back. The plan is computed by planColumnLayout (pure); this method only executes it transactionally.
   *
   * Pass `columns` (the final KanbanColumn[]), `rekeys` (ordered from→to), and `defaultLandingKey` (the
   * sweep target — must be one of `columns`' keys). Throws on an unknown project or a post-apply orphan.
   */
  applyBoardColumnLayout(
    projectId: string,
    columns: KanbanColumn[],
    rekeys: { from: string; to: string }[],
    defaultLandingKey: string,
  ): void {
    const project = this.getProject(projectId);
    if (!project) throw new Error("project not found");
    const validKeys = columns.map((c) => c.key);
    if (!validKeys.includes(defaultLandingKey)) throw new Error("defaultLandingKey must be one of the new columns");
    const placeholders = validKeys.map(() => "?").join(",");
    this.db.transaction(() => {
      const now = new Date().toISOString();
      for (const { from, to } of rekeys) {
        this.db.prepare("UPDATE tasks SET column_key = ?, updated_at = ? WHERE project_id = ? AND column_key = ?")
          .run(to, now, projectId, from);
      }
      // Backstop sweep: any card still on a key not in the new layout (incl. a pre-existing orphan) → landing.
      this.db.prepare(`UPDATE tasks SET column_key = ?, updated_at = ? WHERE project_id = ? AND column_key NOT IN (${placeholders})`)
        .run(defaultLandingKey, now, projectId, ...validKeys);
      // Persist the layout, preserving every other config field.
      this.db.prepare("UPDATE projects SET config_json = ? WHERE id = ?")
        .run(JSON.stringify({ ...project.config, kanbanColumns: columns }), projectId);
      // Invariant assertion (belt-and-suspenders): a non-empty orphan count rolls the transaction back.
      const orphans = (this.db.prepare(`SELECT COUNT(*) AS c FROM tasks WHERE project_id = ? AND column_key NOT IN (${placeholders})`)
        .get(projectId, ...validKeys) as { c: number }).c;
      if (orphans > 0) throw new Error(`column layout would orphan ${orphans} task(s) — aborted`);
    })();
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
  updateSchedule(id: string, patch: { cron?: string; enabled?: boolean; nextFireAt?: string; lastFiredAt?: string | null; kind?: "manager" | "auditor" | "workspace-auditor" }): void {
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
      `INSERT INTO wakes (id,session_id,wake_at,note,created_at,route)
       VALUES (@id,@sessionId,@wakeAt,@note,@createdAt,@route)`,
    ).run({ ...w, route: w.route ? JSON.stringify(w.route) : null });
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

  // --- poll jobs (local poll-job triggers, agent-tooling epic P3) ---
  insertPollJob(p: PollJob): void {
    this.db.prepare(
      `INSERT INTO poll_jobs
        (id,connection_id,path,method,interval_ms,next_poll_at,last_polled_at,items_path,id_path,
         cursor_json,mode,session_id,agent_id,enabled,consecutive_failures,last_error,created_at)
       VALUES
        (@id,@connectionId,@path,@method,@intervalMs,@nextPollAt,@lastPolledAt,@itemsPath,@idPath,
         @cursorJson,@mode,@sessionId,@agentId,@enabled,@consecutiveFailures,@lastError,@createdAt)`,
    ).run({
      ...p, enabled: p.enabled ? 1 : 0, lastPolledAt: p.lastPolledAt ?? null,
      sessionId: p.sessionId ?? null, agentId: p.agentId ?? null, cursorJson: p.cursorJson ?? null,
      lastError: p.lastError ?? null,
    });
  }
  listPollJobs(): PollJob[] {
    return (this.db.prepare("SELECT * FROM poll_jobs ORDER BY created_at, rowid").all() as Row[]).map(toPollJob);
  }
  getPollJob(id: string): PollJob | undefined {
    const r = this.db.prepare("SELECT * FROM poll_jobs WHERE id = ?").get(id) as Row | undefined;
    return r ? toPollJob(r) : undefined;
  }
  /** Partial edit (REST): any provided field is written; omitted fields are left as-is. */
  updatePollJob(id: string, patch: {
    path?: string; method?: string; intervalMs?: number; itemsPath?: string; idPath?: string;
    mode?: "wake" | "spawn"; sessionId?: string | null; agentId?: string | null; enabled?: boolean;
  }): void {
    const cols: Record<string, unknown> = {
      path: patch.path, method: patch.method, interval_ms: patch.intervalMs,
      items_path: patch.itemsPath, id_path: patch.idPath, mode: patch.mode,
      session_id: patch.sessionId, agent_id: patch.agentId,
      enabled: patch.enabled === undefined ? undefined : patch.enabled ? 1 : 0,
    };
    const names = Object.keys(cols).filter((k) => cols[k] !== undefined);
    if (names.length === 0) return;
    const set = names.map((c) => `${c} = ?`).join(", ");
    this.db.prepare(`UPDATE poll_jobs SET ${set} WHERE id = ?`).run(...names.map((c) => cols[c]), id);
  }
  deletePollJob(id: string): void {
    this.db.prepare("DELETE FROM poll_jobs WHERE id = ?").run(id);
  }
  /** Enabled poll jobs whose next_poll_at is at/earlier than nowIso — the PollService's due set. */
  listDuePollJobs(nowIso: string): PollJob[] {
    return (this.db.prepare("SELECT * FROM poll_jobs WHERE enabled = 1 AND next_poll_at <= ? ORDER BY next_poll_at")
      .all(nowIso) as Row[]).map(toPollJob);
  }
  /** CLAIM-FIRST (Scheduler finding-2): advance next_poll_at BEFORE the fetch side-effect, so a
   *  throwing/hanging fetch can't leave the slot un-advanced and double-fetch next tick. Overwritten
   *  again by markPolled/markPollFailed once the real outcome is known. */
  claimPollJob(id: string, nextPollAt: string): void {
    this.db.prepare("UPDATE poll_jobs SET next_poll_at = ? WHERE id = ?").run(nextPollAt, id);
  }
  /** Record a SUCCESSFUL poll: advance next_poll_at, persist the new cursor snapshot, reset the backoff
   *  counter and any prior error. */
  markPolled(id: string, patch: { lastPolledAt: string; nextPollAt: string; cursorJson: string | null }): void {
    this.db.prepare(
      "UPDATE poll_jobs SET last_polled_at = ?, next_poll_at = ?, cursor_json = ?, consecutive_failures = 0, last_error = NULL WHERE id = ?",
    ).run(patch.lastPolledAt, patch.nextPollAt, patch.cursorJson, id);
  }
  /** Record a FAILED poll: advance next_poll_at (backoff, computed by the caller), bump the failure
   *  counter, and persist the surfaced error — never touches the cursor. */
  markPollFailed(id: string, patch: { nextPollAt: string; error: string }): void {
    this.db.prepare(
      "UPDATE poll_jobs SET next_poll_at = ?, consecutive_failures = consecutive_failures + 1, last_error = ? WHERE id = ?",
    ).run(patch.nextPollAt, patch.error, id);
  }

  // --- companion reminders (Companion Memory & Reminders Design, Surface 2 s3 — the recurring engine) ---
  insertCompanionReminder(r: CompanionReminder): void {
    this.db.prepare(
      `INSERT INTO companion_reminders (id,session_id,cron,prompt,label,route,enabled,created_at)
       VALUES (@id,@sessionId,@cron,@prompt,@label,@route,@enabled,@createdAt)`,
    ).run({
      id: r.id, sessionId: r.sessionId, cron: r.cron, prompt: r.prompt,
      label: r.label ?? null, route: r.route ? JSON.stringify(r.route) : null,
      enabled: r.enabled ? 1 : 0, createdAt: r.createdAt,
    });
  }
  getCompanionReminder(id: string): CompanionReminder | undefined {
    const r = this.db.prepare("SELECT * FROM companion_reminders WHERE id = ?").get(id) as Row | undefined;
    return r ? toCompanionReminder(r) : undefined;
  }
  /** A session's reminders (any enabled state), chronological — the management/REST read (not yet wired). */
  listCompanionRemindersForSession(sessionId: string): CompanionReminder[] {
    return (this.db.prepare("SELECT * FROM companion_reminders WHERE session_id = ? ORDER BY created_at, rowid")
      .all(sessionId) as Row[]).map(toCompanionReminder);
  }
  /** Enabled reminders — the watcher's work set. Scoped to ONE session when given (the controller's
   *  per-session rearm, multi-companion runtime), else every session's (an admin/all-companions read). */
  listEnabledCompanionReminders(sessionId?: string): CompanionReminder[] {
    if (sessionId !== undefined) {
      return (this.db.prepare("SELECT * FROM companion_reminders WHERE session_id = ? AND enabled = 1 ORDER BY created_at, rowid")
        .all(sessionId) as Row[]).map(toCompanionReminder);
    }
    return (this.db.prepare("SELECT * FROM companion_reminders WHERE enabled = 1 ORDER BY created_at, rowid").all() as Row[]).map(toCompanionReminder);
  }
  deleteCompanionReminder(id: string): void {
    this.db.prepare("DELETE FROM companion_reminders WHERE id = ?").run(id);
  }
  setCompanionReminderEnabled(id: string, enabled: boolean): void {
    this.db.prepare("UPDATE companion_reminders SET enabled = ? WHERE id = ?").run(enabled ? 1 : 0, id);
  }

  // --- companion voice preferences (Companion Voice epic, VOICE-P1 — the per-route pref store) ---
  /** One route's stored pref, or undefined when none has ever been set (the resolver's default applies). */
  getCompanionVoicePref(sessionId: string, channel: string, chatId: string, senderId: string | null): CompanionVoicePref | undefined {
    const r = this.db.prepare(
      "SELECT * FROM companion_voice_prefs WHERE session_id = ? AND channel = ? AND chat_id = ? AND sender_id = ?",
    ).get(sessionId, channel, chatId, senderId ?? "") as Row | undefined;
    return r ? toCompanionVoicePref(r) : undefined;
  }
  /** A session's stored voice-pref rows (any route) — the human-only REST read. */
  listCompanionVoicePrefsForSession(sessionId: string): CompanionVoicePref[] {
    return (this.db.prepare("SELECT * FROM companion_voice_prefs WHERE session_id = ? ORDER BY created_at, rowid")
      .all(sessionId) as Row[]).map(toCompanionVoicePref);
  }
  /**
   * PARTIAL upsert keyed on (session_id, channel, chat_id, sender_id): a field omitted from `input` keeps
   * its existing stored value (or the column default on first insert) — so `/lang` (which only touches
   * stt_lang/tts_lang) never clobbers a `/voice` toggle already set for the same route, and vice versa.
   */
  upsertCompanionVoicePref(input: {
    sessionId: string; channel: string; chatId: string; senderId: string | null;
    sttLang?: string | null; ttsLang?: string | null; ttsVoice?: string | null; voiceReplies?: "on" | "off" | "auto";
  }): CompanionVoicePref {
    const sid = input.senderId ?? "";
    const existing = this.db.prepare(
      "SELECT * FROM companion_voice_prefs WHERE session_id = ? AND channel = ? AND chat_id = ? AND sender_id = ?",
    ).get(input.sessionId, input.channel, input.chatId, sid) as Row | undefined;
    const now = new Date().toISOString();
    const row: CompanionVoicePref = {
      sessionId: input.sessionId, channel: input.channel, chatId: input.chatId, senderId: input.senderId ?? null,
      sttLang: input.sttLang !== undefined ? input.sttLang : ((existing?.stt_lang as string | null) ?? null),
      ttsLang: input.ttsLang !== undefined ? input.ttsLang : ((existing?.tts_lang as string | null) ?? null),
      ttsVoice: input.ttsVoice !== undefined ? input.ttsVoice : ((existing?.tts_voice as string | null) ?? null),
      voiceReplies: input.voiceReplies !== undefined ? input.voiceReplies : toVoiceMode(existing?.voice_replies),
      createdAt: (existing?.created_at as string) ?? now,
      updatedAt: now,
    };
    this.db.prepare(
      `INSERT INTO companion_voice_prefs (session_id, channel, chat_id, sender_id, stt_lang, tts_lang, tts_voice, voice_replies, created_at, updated_at)
       VALUES (@sessionId, @channel, @chatId, @senderId, @sttLang, @ttsLang, @ttsVoice, @voiceReplies, @createdAt, @updatedAt)
       ON CONFLICT(session_id, channel, chat_id, sender_id) DO UPDATE SET
         stt_lang = @sttLang, tts_lang = @ttsLang, tts_voice = @ttsVoice, voice_replies = @voiceReplies, updated_at = @updatedAt`,
    ).run({ ...row, senderId: sid, voiceReplies: row.voiceReplies });
    return row;
  }

  // --- companion chat history (bug 0f01f234 — the durable store behind the "reload loses the whole
  // conversation" fix). Channel-keyed like companion_voice_prefs; today only the in-app channel writes here. ---
  /**
   * The session's currently OPEN conversation seq (ended_at IS NULL) — lazily opens conversation 1 (or
   * MAX(seq)+1, for the rare case a session has closed conversations but none open — see
   * `startNewCompanionConversation`) if none is open yet, so a brand-new session with zero chat history
   * never needs special-casing. INVARIANT: exactly one open conversation exists per session at a time; this
   * is the ONLY method that opens one, and it is idempotent (a second call with nothing closed in between
   * returns the SAME seq it just opened).
   */
  private currentConversationSeq(sessionId: string): number {
    const open = this.db.prepare("SELECT seq FROM companion_conversations WHERE session_id = ? AND ended_at IS NULL")
      .get(sessionId) as { seq: number } | undefined;
    if (open) return open.seq;
    const max = (this.db.prepare("SELECT MAX(seq) AS m FROM companion_conversations WHERE session_id = ?")
      .get(sessionId) as { m: number | null }).m;
    const seq = (max ?? 0) + 1;
    this.db.prepare("INSERT INTO companion_conversations (session_id, seq, started_at, ended_at) VALUES (?, ?, ?, NULL)")
      .run(sessionId, seq, new Date().toISOString());
    return seq;
  }
  /**
   * Evict whole ARCHIVED (closed) conversations once a session holds more than {@link MAX_RETAINED_CONVERSATIONS}
   * — deletes the oldest closed conversations' companion_messages rows AND their companion_conversations row,
   * never a partial/mid-conversation prune. Called ONLY from `startNewCompanionConversation`, i.e. only at a
   * close/open boundary — never mid-conversation, and never on the currently-open conversation (eviction only
   * ever removes conversations strictly older than the retained-count window, and the just-opened one is
   * always the newest).
   */
  private pruneOldConversations(sessionId: string): void {
    const keep = this.db.prepare("SELECT seq FROM companion_conversations WHERE session_id = ? ORDER BY seq DESC LIMIT ?")
      .all(sessionId, MAX_RETAINED_CONVERSATIONS) as { seq: number }[];
    if (keep.length < MAX_RETAINED_CONVERSATIONS) return; // nothing to evict yet
    const minKeep = Math.min(...keep.map((r) => r.seq));
    this.db.prepare("DELETE FROM companion_messages WHERE session_id = ? AND conversation_seq < ?").run(sessionId, minKeep);
    this.db.prepare("DELETE FROM companion_conversations WHERE session_id = ? AND seq < ?").run(sessionId, minKeep);
  }
  /**
   * The "/new"/"/reset" command's history-ARCHIVE half (replaces the old delete-everything
   * `clearAllCompanionMessages`, card 85f62475): closes the session's currently-open conversation (sets
   * ended_at=now) and opens the next one (seq=MAX+1), then evicts the oldest archived conversation(s) past
   * the retention cap. Every existing/prior-conversation row is RETAINED, tagged with its now-closed
   * conversation_seq — nothing here ever deletes a message that belongs to the conversation being closed.
   * The web/Telegram panel still empties immediately (the caller's `pushCleared` fires unconditionally,
   * regardless of this method's early return below) — only retention differs from the old delete.
   *
   * NO-OP GUARD: if the currently-open conversation has ZERO messages (or none is open yet), this returns
   * WITHOUT closing/opening anything — an empty conversation is reused rather than abandoned. Without this,
   * a burst of "/new" with nothing sent between each would mint a run of empty conversations that are never
   * surfaced in the history list (listCompanionConversations excludes them) but STILL consume a retention
   * slot each, so "/new"-spam could silently evict real, browsable history. The next actual message still
   * lazily opens/reuses the right conversation via `currentConversationSeq` either way.
   */
  startNewCompanionConversation(sessionId: string): void {
    const open = this.db.prepare("SELECT seq FROM companion_conversations WHERE session_id = ? AND ended_at IS NULL")
      .get(sessionId) as { seq: number } | undefined;
    if (open) {
      const { n } = this.db.prepare("SELECT COUNT(*) AS n FROM companion_messages WHERE session_id = ? AND conversation_seq = ?")
        .get(sessionId, open.seq) as { n: number };
      if (n === 0) return; // reuse the still-empty open conversation — nothing to archive
    }
    const now = new Date().toISOString();
    this.db.prepare("UPDATE companion_conversations SET ended_at = ? WHERE session_id = ? AND ended_at IS NULL")
      .run(now, sessionId);
    const max = (this.db.prepare("SELECT MAX(seq) AS m FROM companion_conversations WHERE session_id = ?")
      .get(sessionId) as { m: number | null }).m;
    this.db.prepare("INSERT INTO companion_conversations (session_id, seq, started_at, ended_at) VALUES (?, ?, ?, NULL)")
      .run(sessionId, (max ?? 0) + 1, now);
    this.pruneOldConversations(sessionId);
  }
  /** Record ONE chat turn, tagged with the session's CURRENT (open) conversation, then prune to the most
   *  recent {@link MAX_COMPANION_MESSAGES} rows for its (session, channel, conversation) — a ring buffer
   *  enforced on every insert, scoped to the open conversation ONLY (an archived/closed conversation never
   *  receives new rows, so it can never be reached by this prune — see `startNewCompanionConversation`'s
   *  count-based eviction for archived history instead). Callers (companion/controller.ts's inbound hook,
   *  companion/in-app.ts's outbound hook) wrap this in a try/catch: a history-record failure must never break
   *  the reply/inbound path it's mirroring — a dropped history row is acceptable, a dropped reply or a
   *  crashed inbound is not. */
  insertCompanionMessage(m: { id: string; sessionId: string; channel: string; chatId: string; author: "user" | "companion"; text: string; createdAt: string; viaVoice?: boolean }): void {
    const conversationSeq = this.currentConversationSeq(m.sessionId);
    this.db.prepare(
      `INSERT INTO companion_messages (id, session_id, channel, chat_id, author, text, created_at, via_voice, conversation_seq)
       VALUES (@id, @sessionId, @channel, @chatId, @author, @text, @createdAt, @viaVoice, @conversationSeq)`,
    ).run({ ...m, viaVoice: m.viaVoice ? 1 : 0, conversationSeq });
    this.db.prepare(
      `DELETE FROM companion_messages WHERE session_id = ? AND channel = ? AND conversation_seq = ? AND id NOT IN (
         SELECT id FROM companion_messages WHERE session_id = ? AND channel = ? AND conversation_seq = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
       )`,
    ).run(m.sessionId, m.channel, conversationSeq, m.sessionId, m.channel, conversationSeq, MAX_COMPANION_MESSAGES);
  }
  /** A session's stored chat history for ONE channel, chronological, across EVERY conversation (not scoped to
   *  current) — the "/new"/"/reset" command's history-clear half reads no history, but a test/future caller
   *  scoped to a single channel can. */
  listCompanionMessages(sessionId: string, channel: string): CompanionMessage[] {
    return (this.db.prepare("SELECT * FROM companion_messages WHERE session_id = ? AND channel = ? ORDER BY created_at, rowid")
      .all(sessionId, channel) as Row[]).map(toCompanionMessage);
  }
  /** A session's stored chat history across EVERY channel AND EVERY conversation, chronological (unified
   *  cross-channel chat, card 7d63e200) — an audit/test utility spanning the session's full lifetime.
   *  Interleaves in-app + Telegram (+ any future channel) rows by `created_at` so they render as one merged
   *  conversation; each row still carries its own `channel` for the per-bubble provenance badge. NOT what the
   *  live seed/REST route use post-85f62475 — see `listCurrentCompanionMessages` for the current-conversation-
   *  scoped read those need. */
  listAllCompanionMessages(sessionId: string): CompanionMessage[] {
    return (this.db.prepare("SELECT * FROM companion_messages WHERE session_id = ? ORDER BY created_at, rowid")
      .all(sessionId) as Row[]).map(toCompanionMessage);
  }
  /** A session's stored chat history across EVERY channel, scoped to ONLY its CURRENT (open) conversation —
   *  conversation history (card 85f62475): the human-only REST read (GET /api/companion/messages/:sessionId)
   *  and the web cockpit's reload-persists seed use this so a "/new" boundary is respected — a browser reload
   *  never resurfaces a conversation the owner already archived. Empty (not an error) for a session with no
   *  open conversation (i.e. it has never received a single message). */
  listCurrentCompanionMessages(sessionId: string): CompanionMessage[] {
    const open = this.db.prepare("SELECT seq FROM companion_conversations WHERE session_id = ? AND ended_at IS NULL")
      .get(sessionId) as { seq: number } | undefined;
    if (!open) return [];
    return this.listCompanionMessagesForConversation(sessionId, open.seq);
  }
  /** A session's stored chat history across EVERY channel for ONE specific conversation `seq` — the
   *  fetch-one-conversation half of the history REST surface (GET /api/companion/conversations/:sessionId/:seq).
   *  Empty for an unknown/never-existed seq (the REST layer 404s by checking `listCompanionConversations`
   *  first, not by trusting a non-empty result here). */
  listCompanionMessagesForConversation(sessionId: string, seq: number): CompanionMessage[] {
    return (this.db.prepare("SELECT * FROM companion_messages WHERE session_id = ? AND conversation_seq = ? ORDER BY created_at, rowid")
      .all(sessionId, seq) as Row[]).map(toCompanionMessage);
  }
  /** The session's conversation HISTORY LIST (card 85f62475) — one summary row per conversation that holds at
   *  least one message, newest-first (seq DESC), each with its message count and a short, single-line preview
   *  of its first message (truncated to {@link CONVERSATION_PREVIEW_MAX_CHARS} chars with newlines collapsed
   *  to spaces — the full text is available via `listCompanionMessagesForConversation`). A conversation with
   *  ZERO messages (e.g. two "/new" in a row with nothing sent between) is excluded via the INNER JOIN — there
   *  is nothing meaningful to preview or open for it. The human-only REST read (GET
   *  /api/companion/conversations/:sessionId). */
  listCompanionConversations(sessionId: string): CompanionConversationSummary[] {
    const rows = this.db.prepare(
      `SELECT c.seq AS seq, c.started_at AS startedAt, c.ended_at AS endedAt,
              COUNT(m.id) AS messageCount,
              (SELECT text FROM companion_messages
                 WHERE session_id = c.session_id AND conversation_seq = c.seq
                 ORDER BY created_at, rowid LIMIT 1) AS preview
       FROM companion_conversations c
       JOIN companion_messages m ON m.session_id = c.session_id AND m.conversation_seq = c.seq
       WHERE c.session_id = ?
       GROUP BY c.seq
       ORDER BY c.seq DESC`,
    ).all(sessionId) as { seq: number; startedAt: string; endedAt: string | null; messageCount: number; preview: string | null }[];
    return rows.map((r) => ({
      sessionId, seq: r.seq, startedAt: r.startedAt, endedAt: r.endedAt, messageCount: r.messageCount,
      preview: r.preview === null ? null : truncateConversationPreview(r.preview),
    }));
  }
  /** Wipe a session's stored chat history for ONE channel. Kept for a single-channel-scoped caller/test — not
   *  part of the "/new"/"/reset" flow (that's `startNewCompanionConversation`, which ARCHIVES rather than
   *  deletes, card 85f62475). A no-op (0 rows deleted) is not an error — a fresh companion with no prior
   *  history clears to the same empty state. */
  clearCompanionMessages(sessionId: string, channel: string): void {
    this.db.prepare("DELETE FROM companion_messages WHERE session_id = ? AND channel = ?").run(sessionId, channel);
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
    webhookUrl: (r.webhook_url as string) ?? null, idempotencyKey: (r.idempotency_key as string) ?? null,
    createdAt: r.created_at as string, startedAt: (r.started_at as string) ?? null, endedAt: (r.ended_at as string) ?? null,
  };
}
function toRunEvent(r0: unknown): RunEvent {
  const r = r0 as Row;
  return {
    id: r.id as string, projectId: r.project_id as string,
    keyId: (r.key_id as string) ?? null, runId: (r.run_id as string) ?? null,
    kind: r.kind as RunEventKind,
    detail: r.detail_json ? (JSON.parse(r.detail_json as string) as Record<string, unknown>) : null,
    createdAt: r.created_at as string,
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
    documentConversion: (r.document_conversion as number) === 1,
    restrictedTools: (r.restricted_tools as number) === 1,
    noCommit: (r.no_commit as number) === 1,
    // authenticated-egress connection-id allowlist; malformed/absent degrades to [] = no access.
    connections: (() => { try { return JSON.parse((r.connections as string) || "[]") as string[]; } catch { return []; } })(),
    // agent-tooling P4: registry-capability grants (raw passthrough); malformed/absent degrades to [] = none.
    capabilities: (() => { try { return JSON.parse((r.capabilities as string) || "[]") as CapabilityGrant[]; } catch { return []; } })(),
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
    documentConversion: (r.document_conversion as number) === 1,
    restrictedTools: (r.restricted_tools as number) === 1,
    noCommit: (r.no_commit as number) === 1,
    // pinned skill subset; NULL ⇒ null = deliver all. Defensive parse: a malformed value degrades to
    // null (deliver all), never throws toSession.
    skills: r.skills == null ? null : (() => { try { return JSON.parse(r.skills as string) as string[]; } catch { return null; } })(),
    // pinned connection-id allowlist; malformed/absent degrades to [] = no access (never "all").
    connections: (() => { try { return JSON.parse((r.connections as string) || "[]") as string[]; } catch { return []; } })(),
    // pinned registry-capability grants (agent-tooling P4); malformed/absent degrades to [] = none.
    capabilities: (() => { try { return JSON.parse((r.capabilities as string) || "[]") as CapabilityGrant[]; } catch { return []; } })(),
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
    held: (r.held as number) === 1,
    deferred: (r.deferred as number) === 1,
    createdAt: r.created_at as string, updatedAt: r.updated_at as string,
  };
}
function toPresetPrompt(r0: unknown): PresetPrompt {
  const r = r0 as Row;
  return {
    id: r.id as string, label: r.label as string, prompt: r.prompt as string,
    position: r.position as number,
    createdAt: r.created_at as string, updatedAt: r.updated_at as string,
  };
}
function toCompanionBinding(r0: unknown): CompanionBinding {
  const r = r0 as Row;
  return {
    sessionId: r.session_id as string, channel: r.channel as string, chatId: r.chat_id as string,
    scope: (r.scope as CompanionBinding["scope"]) ?? "dm",
    createdAt: (r.created_at as string) ?? "",
  };
}
function toCompanionAllowedSender(r0: unknown): CompanionAllowedSender {
  const r = r0 as Row;
  return {
    id: r.id as string, sessionId: r.session_id as string, channel: r.channel as string,
    senderId: r.sender_id as string, label: (r.label as string | null) ?? null,
    createdAt: (r.created_at as string) ?? "",
  };
}
/** Normalize a stored `voice_replies` cell to the tri-state mode: a legacy VOICE-P1 row stores it as the
 *  INTEGER 0/1 (SQLite may hand back either the number or its string form depending on the driver path),
 *  a VOICE-P4 row stores 'on'/'off'/'auto' directly. See the companion_voice_prefs schema comment (db.ts). */
function toVoiceMode(raw: unknown): "on" | "off" | "auto" {
  if (raw === "on" || raw === "off" || raw === "auto") return raw;
  return raw === 1 || raw === "1" ? "on" : "off";
}
function toCompanionVoicePref(r0: unknown): CompanionVoicePref {
  const r = r0 as Row;
  const senderId = r.sender_id as string;
  return {
    sessionId: r.session_id as string, channel: r.channel as string, chatId: r.chat_id as string,
    senderId: senderId.length > 0 ? senderId : null,
    sttLang: (r.stt_lang as string | null) ?? null,
    ttsLang: (r.tts_lang as string | null) ?? null,
    ttsVoice: (r.tts_voice as string | null) ?? null,
    voiceReplies: toVoiceMode(r.voice_replies),
    createdAt: (r.created_at as string) ?? "", updatedAt: (r.updated_at as string) ?? "",
  };
}
function toCompanionMessage(r0: unknown): CompanionMessage {
  const r = r0 as Row;
  return {
    id: r.id as string, sessionId: r.session_id as string, channel: r.channel as string, chatId: r.chat_id as string,
    author: r.author as CompanionMessage["author"], text: r.text as string, createdAt: (r.created_at as string) ?? "",
    viaVoice: (r.via_voice as number | undefined) === 1,
    conversationSeq: (r.conversation_seq as number | undefined) ?? 1,
  };
}
/** Collapse a preview candidate to one line and cap its length (card 85f62475's conversation-list preview). */
function truncateConversationPreview(text: string): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > CONVERSATION_PREVIEW_MAX_CHARS
    ? `${oneLine.slice(0, CONVERSATION_PREVIEW_MAX_CHARS)}…`
    : oneLine;
}
function toCompanionConfigRow(r0: unknown): CompanionConfigRow {
  const r = r0 as Row;
  return {
    sessionId: r.session_id as string, botTokenBlob: r.bot_token_blob as string,
    channel: (r.channel as string) ?? "telegram", allowedChatId: r.allowed_chat_id as string,
    chatScope: (r.chat_scope as CompanionConfigRow["chatScope"]) ?? "dm",
    heartbeatIntervalMinutes: (r.heartbeat_interval_minutes as number) ?? 0,
    heartbeatPrompt: (r.heartbeat_prompt as string | null) ?? null,
    enabled: (r.enabled as number) !== 0,
    provisioned: (r.provisioned as number) === 1,
    name: (r.name as string | null) ?? "",
    createdAt: (r.created_at as string) ?? "", updatedAt: (r.updated_at as string) ?? "",
  };
}
function toConnectionRow(r0: unknown): ConnectionRow {
  const r = r0 as Row;
  return {
    id: r.id as string, name: r.name as string, host: r.host as string,
    authScheme: r.auth_scheme as ConnectionAuthScheme, secretBlob: r.secret_blob as string,
    createdAt: (r.created_at as string) ?? "",
  };
}
function toCapabilityDefRow(r0: unknown): CapabilityDefRow {
  const r = r0 as Row;
  return {
    id: r.id as string, slug: r.slug as string, name: r.name as string, description: (r.description as string) ?? "",
    transport: r.transport as "stdio" | "http", kind: r.kind as CapabilityProvisionKind,
    provisionJson: r.provision_json as string, toolAllowlistJson: (r.tool_allowlist_json as string) ?? "[]",
    wantsScratchDir: (r.wants_scratch_dir as number) === 1, requiresConnection: (r.requires_connection as number) === 1,
    secretEnvVar: (r.secret_env_var as string) ?? null, createdAt: (r.created_at as string) ?? "",
  };
}
function toPresetPromptSuggestion(r0: unknown): PresetPromptSuggestion {
  const r = r0 as Row;
  return {
    id: r.id as string, label: r.label as string, prompt: r.prompt as string,
    rationale: (r.rationale as string | null) ?? null,
    status: r.status as PresetPromptSuggestion["status"],
    position: r.position as number,
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
  const routeJson = r.route as string | null | undefined;
  return {
    id: r.id as string, sessionId: r.session_id as string,
    wakeAt: r.wake_at as string, note: r.note as string, createdAt: r.created_at as string,
    ...(routeJson ? { route: JSON.parse(routeJson) as Wake["route"] } : {}),
  };
}
function toPollJob(r0: unknown): PollJob {
  const r = r0 as Row;
  return {
    id: r.id as string, connectionId: r.connection_id as string, path: r.path as string,
    method: r.method as string, intervalMs: r.interval_ms as number,
    nextPollAt: r.next_poll_at as string, lastPolledAt: (r.last_polled_at as string) ?? null,
    itemsPath: r.items_path as string, idPath: r.id_path as string,
    cursorJson: (r.cursor_json as string) ?? null,
    mode: r.mode as PollJob["mode"], sessionId: (r.session_id as string) ?? null,
    agentId: (r.agent_id as string) ?? null, enabled: (r.enabled as number) === 1,
    consecutiveFailures: r.consecutive_failures as number, lastError: (r.last_error as string) ?? null,
    createdAt: r.created_at as string,
  };
}
function toCompanionReminder(r0: unknown): CompanionReminder {
  const r = r0 as Row;
  const routeJson = r.route as string | null | undefined;
  return {
    id: r.id as string, sessionId: r.session_id as string, cron: r.cron as string,
    prompt: r.prompt as string, label: (r.label as string | null) ?? null,
    route: routeJson ? (JSON.parse(routeJson) as CompanionReminder["route"]) : null,
    enabled: (r.enabled as number) === 1, createdAt: r.created_at as string,
  };
}
