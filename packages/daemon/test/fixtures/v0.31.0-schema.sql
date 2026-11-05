-- Base SCHEMA text of packages/daemon/src/db.ts at tag v0.31.0, extracted verbatim with `git show v0.31.0:packages/daemon/src/db.ts`
-- (the SCHEMA template literal only). Committed so the afe1bc90 fan-out migration test boots a REAL pre-migration shape
-- (agents has NO connections/capabilities columns). Never regenerate from HEAD.

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
  reserved INTEGER NOT NULL DEFAULT 0,
  -- Reference-only repos a manager + its workers may READ but never own (JSON array of absolute host
  -- paths); repoPath stays the one primary repo. Added to existing DBs via the idempotent migration
  -- below; NOT NULL + constant DEFAULT '[]' backfills legacy rows to [] (mirrors connections/capabilities).
  reference_repos TEXT NOT NULL DEFAULT '[]',
  -- Deliberate no-build-gate declaration (card 58b0bb60): suppresses the per-merge "unverified: no
  -- gateCommand" warning for a project with no buildable code. Added to existing DBs via the idempotent
  -- migration below; NOT NULL + constant DEFAULT 0 backfills legacy rows to 0 (still warns, unchanged).
  no_gate_by_design INTEGER NOT NULL DEFAULT 0,
  -- Deny-glob merge-review warning (card d5d3bdc9): JSON array of globs that flag a WARNING (never a
  -- block) when worker_merge's branch diff ADDS a file under one. Added to existing DBs via the
  -- idempotent migration below; NOT NULL + constant DEFAULT backfills legacy rows to the same
  -- mockups/-catching default new projects get (unlike reference_repos, this default is non-empty).
  deny_globs TEXT NOT NULL DEFAULT '["mockups/**"]',
  -- Multi-repo epic (49136451) phase 1: WRITABLE repo registry (JSON array of {key,path,gateCommand?}),
  -- distinct from reference_repos (read-only). repo_path stays the one PRIMARY repo. Added to existing
  -- DBs via the idempotent migration below; NOT NULL + constant DEFAULT '[]' backfills legacy rows to []
  -- (mirrors reference_repos exactly).
  repos TEXT NOT NULL DEFAULT '[]',
  -- Card b98957e9: explicit vault-only fact, set once at creation; never re-derive it from
  -- repo_path/vault_path/isGitRepo again (see docs/decisions/b98957e9-…md — that heuristic
  -- misclassified a vault-only project the moment its folder became a git repo). Added to existing DBs
  -- via the idempotent migration below, which ALSO one-time-backfills legacy rows (see
  -- backfillVaultOnlyOnce) — NOT NULL + constant DEFAULT 0 here only covers a FRESH install, which
  -- never has pre-existing rows to backfill.
  vault_only INTEGER NOT NULL DEFAULT 0
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
  base_snapshot TEXT,
  -- Multi-harness epic (df1f94b0) Phase 1, card 353f6dc4: which vendor CLI a session under this rig
  -- spawns as. NULL = "claude" (today's only harness, byte-identical spawn) — HUMAN-set only, same
  -- trust class as gateCommand (selects which binary gets spawned).
  harness TEXT
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
-- Access-story Phase B (card 56ffe50a): the gateway token — the daemon-GLOBAL credential (v1 is a
-- single token, but the store allows more than one row) that authorizes a Tier-1 request over a
-- non-loopback remote bind (see gateway/trust-tier.ts). Modeled on api_keys (salted-hash at rest,
-- plaintext returned ONCE) but deliberately a SEPARATE table, not a reused api_keys row: a gateway
-- token has no project (api_keys.project_id is NOT NULL — a nullable-project hack would blur two
-- distinct credential kinds under one table) and no endpoint-agent allowlist / usage caps. Brand-new
-- table ⇒ CREATE TABLE IF NOT EXISTS is itself the additive migration (no ALTER needed); an existing
-- DB simply gains an empty table on next boot. HUMAN-managed only (loopback REST) — no MCP tool.
CREATE TABLE IF NOT EXISTS gateway_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL DEFAULT '',
  salt TEXT NOT NULL,                                   -- per-token random salt (hex)
  hash TEXT NOT NULL,                                   -- salted SHA-256 of the secret (hex) — never plaintext
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
  -- @decision 08c81809 — durable counterpart to PtyHost.hasReachedReady (in-memory only, lost on
  -- restart): the ISO instant markReady first latched, or NULL if never. See Session.reachedReadyAt's
  -- own doc for why this, not engine_session_id, is the correct boot-time recycle-settle discriminator.
  reached_ready_at TEXT,
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
  -- Multi-harness epic (df1f94b0) Phase 1, card 353f6dc4: which vendor CLI this session's pty runs,
  -- pinned at spawn from the session's Profile (mirrors browser_testing) and carried across every
  -- respawn (resume/fork/recycle) so a resumed Codex worker never silently respawns as claude. Nullable,
  -- no DEFAULT (mirrors repo_key's shape): NULL means "claude" — every legacy row keeps today's exact
  -- behavior with zero data migration.
  harness TEXT,
  parent_session_id TEXT,
  task_id TEXT,
  worktree_path TEXT,
  branch TEXT,
  -- Card b866ab64: for a REVIEW spawn only, the sha this worker's branch was actually forked from (the
  -- reviewed branch's tip at spawn time) — see Session.reviewBaseSha's doc. NULL on every non-review spawn.
  review_base_sha TEXT,
  gen INTEGER DEFAULT 0,
  recycled_from TEXT,
  -- @decision 08c81809 — durable "settle in flight" marker, set on the PREDECESSOR row only (never
  -- fresh's own row) in the SAME transaction as fresh's recycled_from link (insertRecycleSuccessor), so
  -- a daemon restart mid-settle can be reconciled at boot instead of stranding the lineage forever.
  -- NULL = no recycle settle in flight for this session. See reconcileStrandedRecycleSettles.
  recycle_settle_pending_for TEXT,
  -- @decision 54434e27 — do not clear this before the LATER phase
  -- (finishReconcilingHaltedRecycleSuccessors) has actually completed the lineage, and never reference it
  -- from a base-schema index/constraint (crashes any upgraded DB that predates this column).
  halted_recycle_pending_for TEXT,
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
  -- The manager's own most recent idle_report('waiting'|'done') call, DISTINCT from last_idle_nudge_at
  -- (which paces re-nudge cadence and is read as "a nudge was actually sent"). The reset-on-activity
  -- check anchors on max(last_idle_nudge_at, idle_disposition_at) so an orchestration event the manager
  -- produced BEFORE this disposition call can never retroactively invalidate it (card 86c9bdbd).
  idle_disposition_at TEXT,                            -- ISO ts | NULL (last idle_report waiting/done call)
  -- ContextWatcher per-manager recycle-nudge state (parity with the idle-watchdog columns above): persist
  -- the last context-nudge time + unanswered count so the re-nudge cadence + escalate-after-cap survive a
  -- daemon restart. No snooze column (unlike idle): a context nudge is answered by RECYCLING, not snoozing.
  context_nudge_policy TEXT NOT NULL DEFAULT 'watching', -- 'watching' | 'escalated'
  last_context_nudge_at TEXT,                            -- ISO ts | NULL (last context-recycle nudge fired)
  context_nudge_unanswered INTEGER NOT NULL DEFAULT 0,   -- consecutive unanswered context nudges
  -- Per-project session Archive (mirrors projects.archived_at): the ISO instant a dead/exited
  -- session was archived out of the rail. NULL = not archived. Excluded from the live lists.
  archived_at TEXT,
  -- Opt-in Companion "lead mode" (Option B, no guardrails): read LIVE by resolveCompanionGrant on every
  -- call (mirrors vault_write, NOT browser_testing — no respawn needed for a toggle to take effect).
  -- HUMAN-only REST write (PUT /api/companion/:sessionId/lead-mode); legacy rows backfill to 0 (off).
  companion_lead_mode INTEGER NOT NULL DEFAULT 0,
  -- Spawn-origin marker (card 53edd8d5): 1 iff this manager was booted BY THE CRON SCHEDULER. Read by
  -- countLiveScheduledManagers — the Scheduler's OWN manager-cap budget, separate from the standing
  -- human/Lead-spawned fleet. Legacy rows backfill to 0 (never scheduler-spawned, correct for history).
  scheduled_spawn INTEGER NOT NULL DEFAULT 0,
  -- Resume-half memory-recall dedup gate (card ea648f89, hardened by finding 0e08c0b7): sha256 hex of the
  -- LAST framed project-memory / companion-memory block actually delivered to this session's resume/fork
  -- turn-injection (NULL = nothing delivered yet). Persisted (not an in-memory cache) so a repeat resume
  -- with an unchanged digest can skip re-enqueueing it EVEN ACROSS a daemon restart. Added to existing DBs
  -- via the idempotent migration below.
  last_project_memory_digest TEXT,
  last_companion_memory_digest TEXT,
  -- Card 343441bd: count of COMPLETED worker turns (the Stop/StopFailure setBusy(false) edge ONLY — see
  -- PtyHostEvents.onTurnCompleted's doc for why the other setBusy(false) sites are deliberately excluded).
  -- Used to detect a manager directive that ages past N real turns with no worker_report — see the
  -- staleDirective projection in mcp/orchestration.ts. Legacy rows backfill to 0 (no completed turns known).
  turn_seq INTEGER NOT NULL DEFAULT 0,
  -- Card 788ed7f4: an open "owner message left without a disposition" episode, manager/platform-only
  -- (idle_report's own role gate — see recordIdleReport). Set from the composer route's ownerText the
  -- FIRST time an owner-authored message lands with none already pending — never overwritten by a LATER
  -- owner message in the same episode (a "ok" following a real ask must not replace it) — only the count
  -- bumps. Cleared either by a disposition tool call (tasks_create/platform_escalate/question_ask/
  -- question_resolve) or by idle_report surfacing it once (fire-once-then-clear). NEVER the raw owner
  -- text beyond this bounded excerpt reaches a console/daemon-log line — see recordPendingOwnerMessage's
  -- own doc. Nullable, no DEFAULT: every legacy row backfills to "no open episode".
  pending_owner_msg_excerpt TEXT,
  pending_owner_msg_at TEXT,
  pending_owner_msg_count INTEGER NOT NULL DEFAULT 0
);
-- Append-only orchestration audit trail (manager↔worker timeline; UI timeline in #18).
-- seq (attention-push watcher fix, CR-caught): the sqlite rowid is NOT a safe tail-poll cursor for this
-- table — rows ARE hard-deleted (deleteProject/deleteSession cascade), and sqlite REUSES rowids once the
-- row holding the current table-max is gone, which would silently drop an in-flight watcher's cursor past a
-- reused id and skip real alerts forever. seq is stamped from orchestration_event_seq below (an
-- AUTOINCREMENT counter table that NEVER reuses a value even across deletes) and is the ONLY column any
-- tail-poll cursor (Db.listEventsSince/getMaxEventSeq) may key off. Existing DBs get it via
-- migrateOrchestrationEvents() below (ADD COLUMN + backfill from the pre-migration rowid order, which is
-- still monotonic at that point — no reuse has happened yet).
CREATE TABLE IF NOT EXISTS orchestration_events (
  id TEXT PRIMARY KEY,
  ts TEXT NOT NULL,
  manager_session_id TEXT NOT NULL,
  worker_session_id TEXT,
  task_id TEXT,
  kind TEXT NOT NULL,
  detail_json TEXT,
  seq INTEGER
);
-- The never-reused monotonic sequence source for orchestration_events.seq (see its doc above). Kept as a
-- SINGLE-ROW counter (nextEventSeq trims older rows after every insert) — its own AUTOINCREMENT high-water
-- mark lives in sqlite's sqlite_sequence table and is NEVER lowered by deleting rows from THIS table, which
-- is exactly the never-reused guarantee seq needs.
CREATE TABLE IF NOT EXISTS orchestration_event_seq (
  n INTEGER PRIMARY KEY AUTOINCREMENT
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
  -- Provenance of the CURRENT held value (card 9b0373c0, Platform-Audit bb23d15a): 'human' | 'agent' |
  -- NULL (never set / held is currently false). Stamped SERVER-SIDE only -- never a client-suppliable
  -- field on any agent MCP tool -- so an agent can never forge 'human' to escape the clear-refusal guard
  -- in updateProjectTask (mcp/tasks.ts). NULLable (no NOT NULL/DEFAULT): a legacy row predates this
  -- column entirely; migrateTasks()'s ALTER TABLE ADD COLUMN backfills every pre-existing held=1 row to
  -- 'human' in place (held has always been documented owner-gated -- see Task.held's own doc), so a
  -- pre-migration hold isn't newly agent-clearable the moment this ships.
  held_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- Cron-triggered schedules (phase-2 Pillar B): the daemon Scheduler boots a manager on the tick.
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  -- Human-facing name (Schedules UI redesign). Mandatory on new creation (validated at the REST create
  -- surface + the builder); NULLABLE so a legacy row that predates names is not a migration hazard — it
  -- reads a derived default (describeCron(cron)) at the DB boundary (toSchedule).
  name TEXT,
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
  kind TEXT NOT NULL DEFAULT 'manager',
  -- Deferral observability (card 53edd8d5): the instant this schedule most recently transitioned INTO a
  -- deferred (budget-gated) state, + the human reason. Both NULL = not currently deferred. Set by
  -- markDeferred ONLY on a transition (never every tick); cleared by markFired on the next successful fire.
  last_deferred_at TEXT,
  last_deferred_reason TEXT
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
-- Durable record of a gate/merge/deploy PendingOpRegistry-or-equivalent op — a queryable TOMBSTONE, not
-- just a "surfaced pending" marker (card e3e40167, superseding the original edc1ec12/7afa6ea9 shape
-- below). A row is INSERTED the moment a "gate"/"merge" op is MINTED (SessionService's onOpMinted hook —
-- see PendingOpRegistry.attach's own doc), covering BOTH a fast op that settles inline within the
-- sync-attach budget and a slow one that degrades to pending — the original shape only ever wrote a row
-- for the LATTER (via onSurfacedPending), which made a fast op's opId indistinguishable from "never
-- existed" once settled (card e3e40167's central defect). A "deploy" op (card bed91595) does NOT go
-- through PendingOpRegistry at all — deployOwnProject is a single synchronous span (mint the opId, run
-- the gate, settle) with no separate "surfaced pending" window a caller can observe — so its row is
-- inserted (state:'pending') and immediately settled back-to-back, in the same synchronous call, never
-- surfaced_pending=1; see deployOwnProject's own comment for why this still closes the restart/eviction
-- gaps card 8052977a's in-process cache (removed by bed91595) could not. surfaced_pending flips to 1 the
-- moment a caller is actually told "pending" (mirrors the old row-existence signal); state starts
-- "pending" and moves to exactly one
-- TERMINAL value — "settled" (a normal settle, fast or surfaced), "evicted-dead-owner" (force-removed by
-- evictDeadOwner because its owning manager died — the run() may still be executing, unreachable; this is
-- NOT a verdict), or "orphaned-by-restart" (found still "pending" at boot after a real process death, by
-- EITHER of two boot sweeps — see below) — NEVER DELETED on any of these transitions (see gate_status's
-- tombstone read). reconcileOrphanedGateOps' boot sweep only ever selects rows that are BOTH
-- surfaced_pending=1 AND still state='pending' — a fast op that settled cleanly before a crash must never
-- resurface a false [loom:gate-failed] — and pushes a synthetic terminal nudge to the owning session (a
-- caller WAS told "pending" for these, so it is owed a real answer). reconcileUnsurfacedPendingGateOps
-- (card 7239c712) is the COMPLEMENT: rows still "pending" at boot with surfaced_pending=0 — nobody was ever
-- told "pending" for these (mergeBatch/deployOwnProject's own mint sites, neither of which ever flips
-- surfaced_pending at all — see their own insertPendingGateOp comments; card 81d795de deferred mergeBatch's
-- own SETTLE, not this mint-side flag, so this claim is unaffected), so it marks them
-- "orphaned-by-restart" too but pushes NO nudge; see that method's own doc for why. project_id is the scope
-- anchor gate_status's tombstone read
-- filters on (mirroring GateSemaphore.findByOpId's session/project candidate-set filter — a stranger
-- session/project must get the SAME "not found" family of answer a live op gives them, never "settled").
-- Rows are cascade-deleted alongside their project/agent (see deleteProject/deleteAgent) — permanent rows
-- would otherwise be an unbounded orphan class the transient shape never had to worry about.
-- NOT a brand-new-table-only additive migration: this table SHIPPED (card edc1ec12) before state/
-- surfaced_pending/project_id existed, so an ALTER TABLE (migratePendingGateOps, mirroring
-- migrateWakes/migrateCompanionMessages) is REQUIRED for every DB opened since then — CREATE TABLE IF NOT
-- EXISTS alone would silently no-op the column-add on any such DB. Contrast poll_jobs below, which really
-- is brand-new and needs no ALTER.
-- verdict/verdict_payload_json (card 4c5bf820) let a SETTLED "gate" (worker self-check) row carry its
-- terminal result — pass/fail/error/cancelled + duration + per-step timings + a bounded output tail —
-- readable via gate_status without the [loom:gate-done]/[loom:gate-failed] nudge being the only carrier.
-- verdict stays its OWN column (the discriminator gate_status branches on: NULL means "no verdict
-- recorded" — every legacy row, or a "gate"/"merge" row that hasn't settled yet — never fabricate one from
-- a partially-parsed payload). Everything else rides in ONE JSON blob (verdict_payload_json, see
-- PendingGateOpVerdict's own doc, in this file's TS below, for its shape) rather than one column per
-- field: nothing queries these field-by-field (always read whole, by opId), and a payload blob means a
-- FUTURE verdict field (e.g. a mainline/suite sha) is a JSON addition, not another migration.
-- STALE AS OF 4c5bf820, FIXED BY 9f6598dd THEN a1a8c5c4 — both columns did NOT stay NULL for a "merge"
-- row for long: 9f6598dd widened confirmWorkerMergeTracked's own onSettle to also call
-- settlePendingGateOp with a real verdict (settledAt/totalDurationMs/extended/gateDetail-on-fail), and
-- a1a8c5c4 further widened that same payload to also carry outputTail (the bounded tail) on BOTH
-- outcomes — closing the gap where a PASSING gate's output, "gate"-kind or "merge"-kind, was persisted
-- nowhere at all. Both kinds share one payload shape today; see PendingGateOpVerdict's own doc.
CREATE TABLE IF NOT EXISTS pending_gate_ops (
  op_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,             -- "gate" | "merge" | "deploy" (card bed91595)
  key TEXT NOT NULL,               -- the PendingOpRegistry key ("gate:<workerSessionId>" / "merge:<workerSessionId>")
                                    -- — or, for "deploy" (which never goes through PendingOpRegistry),
                                    -- the same "<kind>:<sessionId>" naming convention purely for legibility;
                                    -- never queried against (see findPendingGateOpByOpId's own scoping)
  owner_session_id TEXT NOT NULL,  -- who gets the synthetic nudge: the worker for "gate", the manager for
                                    -- "merge"/"deploy"
  task_id TEXT,
  branch TEXT,
  started_at TEXT NOT NULL,
  project_id TEXT,                                 -- added by migratePendingGateOps on an upgraded DB
  state TEXT NOT NULL DEFAULT 'pending',            -- added by migratePendingGateOps on an upgraded DB
  surfaced_pending INTEGER NOT NULL DEFAULT 1,      -- added by migratePendingGateOps; legacy rows backfill
                                                     -- to 1 — under the OLD shape a row's mere EXISTENCE
                                                     -- meant "surfaced pending", so a leftover legacy row
                                                     -- must still be swept by reconcileOrphanedGateOps
  verdict TEXT,                                     -- added by migratePendingGateOps; 'pass'|'fail'|'error'|
                                                     -- 'cancelled'|'skipped' (card a228dfb5, "merge" rows
                                                     -- only), NULL until a "gate" op settles with one
  verdict_payload_json TEXT                         -- added by migratePendingGateOps; see PendingGateOpVerdict
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
-- Local event triggers (Loom Event Triggers subsystem, card f5d07121 — T1, the data-layer FOUNDATION;
-- the always-on dispatcher + human-only REST are deferred follow-on cards). The internal-state
-- counterpart to poll_jobs above: instead of fetching an EXTERNAL endpoint, a trigger reacts to an
-- orchestration-lifecycle event ALREADY on the durable orchestration_events bus (see its seq column
-- doc above) via a per-trigger watermark cursor (last_seq), mirroring AttentionPushWatcher's own
-- per-subscriber watermark (companion/attention-push.ts — a bus POSITION) rather than poll_jobs'
-- item-id snapshot (there's no "item" here). On a match the (deferred) dispatcher wakes
-- target_session_id (mode 'wake') or spawns a fresh session in agent_id (mode 'spawn'). Brand-new table
-- => CREATE TABLE IF NOT EXISTS is itself the additive migration (no ALTER), exactly like poll_jobs/
-- connections/api_keys/runs above. PURE DATA in this card — nothing reads last_seq/last_fired_at forward
-- yet. Human-configured only (REST) — no MCP path (mirrors poll_jobs/connections/schedules).
CREATE TABLE IF NOT EXISTS event_triggers (
  id TEXT PRIMARY KEY,
  -- One of EVENT_TRIGGER_EVENT_KINDS (@loom/shared) -- a real OrchestrationEventKind already emitted on
  -- the bus today; validated at the REST create/update surface (deferred follow-on), not here.
  event_kind TEXT NOT NULL,
  -- Scope: NULL = every project; else only events whose owning session resolves to this project.
  project_id TEXT REFERENCES projects(id),
  -- 'wake' (nudge an existing target_session_id) or 'spawn' (fresh session in agent_id).
  mode TEXT NOT NULL,
  target_session_id TEXT REFERENCES sessions(id),
  agent_id TEXT REFERENCES agents(id),
  enabled INTEGER NOT NULL DEFAULT 1,
  -- Watermark cursor into orchestration_events.seq (Db.listEventsSince) -- every event with seq <= this
  -- has already been considered by this trigger. 0 = never scanned.
  last_seq INTEGER NOT NULL DEFAULT 0,
  -- Dedupe/rate-guard: when this trigger last actually fired (a delivered wake/spawn), NULL if never.
  -- The dispatcher enforces its own anti-hammer floor off this, mirroring poll_jobs'
  -- consecutive_failures-driven backoff / MIN_POLL_INTERVAL_MS anti-hammer floor.
  last_fired_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_triggers_enabled ON event_triggers(enabled);
-- Inbound webhook receiver (agent-tooling epic P5b, card 8fbedcac) — the Tier-2 public-ingress sibling of
-- event_triggers above: reacts to a SIGNED EXTERNAL POST (GitHub/Stripe/Standard-Webhooks/Loom generic)
-- at its own opaque path instead of the internal orchestration_events bus. 'path' is a random,
-- non-guessable slug (generated at creation, never human-chosen) — it is mounted at the ONE fixed
-- registered route pattern 'POST /hooks/:path' (gateway/trust-tier.ts classifies that pattern Tier-2).
-- secret_blob is envelope ciphertext (v1:iv:tag:ct), same encrypt-at-rest path as connections.secret_blob
-- — HMAC verification needs the PLAINTEXT secret to recompute against, so (unlike a verify-only salted
-- hash) this must be reversibly stored. mode/target_session_id/agent_id mirror event_triggers exactly —
-- agent_id (spawn mode) PINS the endpoint's target project + role via the agent's own profile. Brand-new
-- table => CREATE TABLE IF NOT EXISTS is itself the additive migration (no ALTER needed), exactly like
-- connections/event_triggers. Human-configured only (REST) — no MCP path (mirrors connections/
-- poll_jobs/event_triggers: an agent must never mint or list an inbound webhook endpoint or its secret).
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id TEXT PRIMARY KEY,
  path TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  source_type TEXT NOT NULL,          -- 'github' | 'stripe' | 'standard' | 'generic'
  secret_blob TEXT NOT NULL,          -- envelope ciphertext — NEVER plaintext
  mode TEXT NOT NULL,                 -- 'wake' (nudge an existing target_session_id) or 'spawn' (fresh session in agent_id)
  target_session_id TEXT REFERENCES sessions(id),
  agent_id TEXT REFERENCES agents(id),
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_fired_at TEXT
);
-- Webhook delivery idempotency (per endpoint): every VERIFIED delivery's (endpoint_id, delivery_id) is
-- recorded so a provider's at-least-once retry of the SAME delivery never double-fires a spawn/wake.
-- DB-backed (not in-memory) so the dedupe survives a daemon restart within the verify recipe's 300s
-- timestamp-tolerance window. Bounded via an opportunistic sweep of rows older than the tolerance window
-- (webhooks/store.ts), so this never grows unbounded across a long-lived endpoint.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  endpoint_id TEXT NOT NULL REFERENCES webhook_endpoints(id),
  delivery_id TEXT NOT NULL,
  received_at TEXT NOT NULL,
  PRIMARY KEY (endpoint_id, delivery_id)
);
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_received_at ON webhook_deliveries(received_at);
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
-- Bounded CHANGE HISTORY for platform_config (card db1e3503): the singleton row above only ever shows the
-- LATEST value, sharing one updated_at across every key, so a change can't be attributed to a key, an
-- actor, or a prior value. Each row is ONE write: the top-level keys that changed, their prior + resulting
-- values (scoped to just those keys), the actor where the write surface knows one, and when. A ring
-- buffer capped at PLATFORM_CONFIG_HISTORY_LIMIT rows, pruned on every insert (see
-- recordPlatformConfigChange) — this must never grow unbounded. Additive: CREATE TABLE IF NOT EXISTS, like
-- platform_config itself.
CREATE TABLE IF NOT EXISTS platform_config_history (
  id TEXT PRIMARY KEY,
  changed_keys TEXT NOT NULL,
  prior_json TEXT NOT NULL,
  next_json TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_platform_config_history_created_at ON platform_config_history(created_at);
-- Bounded PER-PROJECT change history for a project's config override (card a0cafef2, sibling of
-- platform_config_history above): projects.config_json only ever shows the LATEST value, so a change can't
-- be attributed to a key, an actor, or a prior value. Each row is ONE write, scoped to project_id: the
-- top-level keys that changed, their prior + resulting values, the TRUTHFUL actor the write surface
-- threads through (project config has THREE agent-facing writers alongside the one human REST PATCH — see
-- ProjectConfigHistoryEntry's doc — so, unlike platform_config_history, "human" is never hardcoded here),
-- and a timestamp. A ring buffer PER PROJECT capped at PROJECT_CONFIG_HISTORY_LIMIT rows, pruned on every
-- insert (see recordProjectConfigChange) — this must never grow unbounded, and a busy project can never
-- evict a quiet project's history. Additive: CREATE TABLE IF NOT EXISTS, like platform_config_history.
CREATE TABLE IF NOT EXISTS project_config_history (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  changed_keys TEXT NOT NULL,
  prior_json TEXT NOT NULL,
  next_json TEXT NOT NULL,
  actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_config_history_project_created ON project_config_history(project_id, created_at);
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
-- Card 6f13746c: the per-project MERGE-GATE INTERVAL state (see orchestration/merge-gate-interval.ts) — the durable
-- ungated-landing counter, the "gate owed" flag, the last passing gate and a ring of the last 6 periodic/owed gate
-- outcomes. Brand-new table ⇒ this CREATE TABLE IF NOT EXISTS is itself the additive migration (no ALTER, no index,
-- nothing referencing a migrate*()-added column). One row per (project, repo) — a pass in repo B must never reset repo A's count —
-- lazily created, the primary repo keyed "primary"; deleteProject cascades them. (Unreleased table: its shape was changed in place.)
CREATE TABLE IF NOT EXISTS project_merge_gate_state (
  project_id TEXT NOT NULL,
  repo_key TEXT NOT NULL DEFAULT 'primary',
  ungated_since_last_pass INTEGER NOT NULL DEFAULT 0,
  gate_owed INTEGER NOT NULL DEFAULT 0,
  last_pass_at TEXT,
  last_pass_sha TEXT,
  recent_json TEXT NOT NULL DEFAULT '[]',
  last_failure_json TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, repo_key)
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
  created_at TEXT,
  -- Outbound-suppression flag (card 7578dea2) — see CompanionBinding.flaggedNonPrivate's own doc (shared
  -- types.ts) for the full rationale. Added to an existing DB by migrateCompanionBindingFlags() below.
  flagged_non_private INTEGER NOT NULL DEFAULT 0
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
-- Access-story Phase C (card 6bc02f50): per-ip failed-remote-gateway-auth counters — the SAME
-- sliding-window lockout primitive as companion_pairing_attempts above (generalized into
-- security/lockout.ts), keyed on the remote caller's ip instead of (channel, sender_id). Only a WRONG
-- (non-empty, malformed/unknown/bad-secret) presented token counts as a failure — an entirely absent
-- token is ordinary unauthenticated first contact, not a credential-guessing signal — so the trust-tier
-- hook's onRequest gate rejects WITHOUT even verifying the token while locked. Times are epoch-ms
-- INTEGERs like companion_pairing_attempts.
CREATE TABLE IF NOT EXISTS gateway_auth_attempts (
  ip TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  locked_until INTEGER
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
  updated_at TEXT,
  -- Zero-reply detector (card 48e8d289): see CompanionConfigRow.lastChatReplyTurnSeq/zeroReplyAlertTurnSeq
  -- for the full contract. Both nullable, no NOT NULL/DEFAULT/index/FK referencing either — a legacy row
  -- backfills to NULL on the ADD COLUMN migration below, which reply-watch.ts's lazy-baseline path treats
  -- as "not yet observed" (never as an instant zero-turn streak), so an upgraded long-lived companion can
  -- never trip the alert on its very first post-migration turn.
  last_chat_reply_turn_seq INTEGER,
  zero_reply_alert_turn_seq INTEGER,
  -- Card a8480338: 1 ⇒ this session's bootstrap Telegram binding has ALREADY been genuinely seeded once
  -- (either by factory.ts's env-bootstrap path the first time it ever saw zero bindings, or by the
  -- provision endpoint minting the session's own binding directly) — a DIFFERENT fact than "a binding
  -- currently exists". Once set, factory.ts's bootstrap-seed NEVER fires again for this session, even
  -- after every binding is later deleted (an owner revoke) — without this, re-seeding keyed on "zero
  -- bindings right now" would silently UNDO a deliberate revoke on the next gateway build (daemon restart).
  -- DEFAULT 0 here (a brand-new row has never been seeded yet); see COMPANION_CONFIG_ADDED_COLUMNS below for
  -- why an existing DB's ADD COLUMN backfill uses a DIFFERENT default.
  bindings_seeded INTEGER NOT NULL DEFAULT 0
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
-- inserted INTEGER (e.g. the JS number 1 becomes the TEXT value "1", not the INTEGER 1 SQLite stores today),
-- which would corrupt a genuinely-legacy row on write. INTEGER affinity has the opposite (safe) behavior: it
-- only converts a TEXT value when that text IS a well-formed number; 'on'/'off'/'auto' aren't, so they're
-- stored verbatim, while a legacy 0/1
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
  conversation_seq INTEGER NOT NULL DEFAULT 1,  -- which conversation this turn belongs to (see companion_conversations)
  proactive INTEGER NOT NULL DEFAULT 0  -- 1 iff this outbound reply's turn was a daemon-driven heartbeat/reminder/attention-push submit (proactive event-line producer) — always 0 for author='user'
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
-- Companion CAPABILITY GRANTS (Companion Capability & Permission-Lever Framework, §1) — the ONE data
-- model every opt-in Companion "lever" (session-status, decisions-relay, session-steer, board-reach,
-- vault-read, media-out, …) is gated on. A capability is enabled by the PRESENCE of a row (session_id,
-- capability, project_id) — no row ⇒ that lever's tools are never registered (registerCompanionCapabilities
-- below), so it stays inert + invisible, exactly like the chat_reply/skill_*/memory_*/reminder_* companion
-- gate. Brand-new table ⇒ CREATE TABLE IF NOT EXISTS is itself the additive migration (an existing DB
-- gains an empty table on boot; zero rows ⇒ every capability OFF, byte-identical to today).
--   • session_id  — the companion session this grant is scoped to (like companion_bindings/reminders);
--     grants are read PER-SESSION, never the global table (mirrors the bindings per-session read).
--   • capability  — the lever slug ('session-status' | 'decisions-relay' | 'attention-push' |
--     'session-steer' | 'board-reach' | 'vault-read' | 'media-out').
--   • project_id  — the project this grant scopes to; NULL = the companion's OWN bound project (the
--     narrow default — a grant that omits a project can never accidentally reach a project the owner
--     didn't name). A capability that spans several projects gets one row per project.
--   • mode        — 'read' | 'act': a read grant NEVER implies act; act is only ever the explicit
--     stronger row (Section 1's read-vs-act granularity).
--   • config_json — lever-specific extra scope (decision-class allowlist, alert classes, path roots, …),
--     opaque to the framework; NEVER holds a secret. Defaults to '{}'.
-- UNIQUE (session_id, capability, project_id) is the upsert key — SQLite treats NULL as DISTINCT in a
-- UNIQUE index, so a project_id-NULL "own project" grant and a project_id-set grant for the SAME
-- capability legitimately coexist as separate rows (both are meaningful, distinct scopes).
-- HUMAN-managed only over loopback REST (POST/PUT/DELETE /api/companion/:sessionId/grants) — there is
-- INTENTIONALLY NO MCP path, same trust posture as companion_bindings/companion_config: an
-- injection-exposed Companion must never widen its own capability. The grants table JOINS the existing
-- session-retire/unbind cascade (deleteCompanionBinding/deleteCompanionConfig/deleteSession/deleteProject/
-- deleteAgent below) so a recycled session id can never inherit a stale grant.
CREATE TABLE IF NOT EXISTS companion_capability_grants (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  project_id TEXT,
  mode TEXT NOT NULL DEFAULT 'read',
  config_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_companion_grants_scope
  ON companion_capability_grants(session_id, capability, project_id);
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
  created_at TEXT NOT NULL,
  -- OAuth2 (agent-tooling epic P5a) — NON-SECRET columns only; an 'oauth2' row's secret_blob holds the
  -- JSON token bundle {clientSecret,accessToken,refreshToken,expiresAt}, still ONE envelope blob (reuses
  -- the same encrypt-at-rest path as api-key/bearer's raw-string secret). NULL/0 on every api-key/bearer
  -- row (unused by those schemes) — byte-identical for every row that predates this phase. Added to
  -- existing DBs by migrateConnections() below (fresh installs already have them via this CREATE TABLE).
  provider TEXT,
  client_id TEXT,
  auth_url TEXT,
  token_url TEXT,
  scopes TEXT,
  token_expires_at TEXT,
  oauth_needs_reauth INTEGER NOT NULL DEFAULT 0,
  -- Project scope (card f2abce7e). NULL = GLOBAL — reachable by any profile that allowlists it, exactly as
  -- every connection behaved before this column existed (every pre-f2abce7e row backfills to NULL here).
  -- Set = usable ONLY by that project's own sessions (see connections/store.ts isConnectionUsableByProject
  -- and the resolution seams in connections/request.ts + index.ts's resolveConnectionSecret) — fail-closed:
  -- a cross-project session whose profile allowlists this id resolves NOTHING. Added to existing DBs by
  -- migrateConnections() below (fresh installs already have it via this CREATE TABLE). No FK (matches
  -- companion_capability_grants.project_id) — a deleted project simply orphans its scoped connections as
  -- unreachable rather than needing a cascade.
  project_id TEXT
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
-- Owner-declared SYMMETRIC project link (board card 2349d90c) — the sole gate for the manager<->manager
-- peer_message cross-project channel: a manager may message a peer project's manager ONLY if the owner
-- has linked the two projects here. GLOBAL / daemon-wide, HUMAN-managed only over the loopback REST
-- surface — NO MCP path (same trust posture as connections/capability_defs above): an agent must never be
-- able to link projects itself and so widen its own cross-project reach. project_a_id/project_b_id are
-- always stored canonically ordered (lexicographically smaller id first, see Db.createProjectLink) so a
-- pair is represented exactly once regardless of which side the owner declared it from; the unique index
-- below enforces that at the storage layer too. Brand-new table => CREATE TABLE IF NOT EXISTS is itself the
-- additive migration (no ALTER needed), exactly like connections/capability_defs.
CREATE TABLE IF NOT EXISTS project_links (
  id TEXT PRIMARY KEY,
  project_a_id TEXT NOT NULL REFERENCES projects(id),
  project_b_id TEXT NOT NULL REFERENCES projects(id),
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_links_pair ON project_links(project_a_id, project_b_id);
-- Manager→human DECISION INBOX (card 8701bdbb, daemon core / child A), generalized (card 695ebab0) into
-- a durable, TYPED Requests object via the 'type' discriminator: 'decision' (the original shape, and the
-- default — backward-compat for every pre-695ebab0 caller), 'input' (freeform-text, no options),
-- 'permission' (authorize/deny an action; ask-time payload in permission_action/permission_scope/
-- permission_expires_at), 'credential' (a NEVER-ECHO secret ask; ask-time payload credential_env_var, the
-- answer's ciphertext in secret_blob — see Db.answerCredentialQuestion). Brand-new table => CREATE TABLE
-- IF NOT EXISTS is itself the additive migration for a fresh install (no ALTER needed), exactly like
-- runs/api_keys/connections/poll_jobs above; an EXISTING DB (already has questions from card 8701bdbb)
-- picks up the type/task_id/permission_*/credential_env_var/secret_blob columns via migrateQuestions()
-- below (ALTER TABLE ADD COLUMN — see QUESTION_ADDED_COLUMNS), backfilling every legacy row to
-- type='decision' in place. task_id is a deliberately SOFT link (no REFERENCES/FK): a deleted task must
-- not orphan this request's history row. options_json/recommendation are nullable ('decision'-only; a
-- pure-blocker ask carries neither); chosen_option/note are written by the human-only REST answer
-- endpoint (and, for 'credential', secret_blob instead — chosen_option/note are NEVER used for that type,
-- so the plaintext secret never lands in an agent-readable column). The manager-only ask/pull MCP tools +
-- the human-only REST answer route are the only writers — no agent MCP tool answers its own question
-- (mirrors the human-only-write trust posture of vault/git).
CREATE TABLE IF NOT EXISTS questions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id),  -- CURRENT routing target, NOT provenance: reparentQuestions
                                            -- (below) unconditionally rewrites this on every manager/Lead recycle,
                                            -- so a row's session_id reflects whichever seat is LIVE now, not who
                                            -- filed it. See filed_by_session_id (card cb7d6998) for the filer.
  filed_by_session_id TEXT,                -- the ORIGINAL filing session id, set ONCE at insert, NEVER touched by
                                            -- reparentQuestions — deliberately no REFERENCES (a soft, historical
                                            -- pointer, like task_id below: the filing session may later be
                                            -- hard-deleted without orphaning this row). NULL on a legacy row
                                            -- created before this column existed — see QUESTION_ADDED_COLUMNS'
                                            -- own doc for why that NULL is unrecoverable, not just unset.
  project_id TEXT NOT NULL REFERENCES projects(id),
  type TEXT NOT NULL DEFAULT 'decision',   -- 'decision' | 'input' | 'permission' | 'credential'
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  options_json TEXT,
  recommendation TEXT,
  task_id TEXT,                            -- soft link to tasks(id) — deliberately no FK, see doc above
  permission_action TEXT,
  permission_scope TEXT,                   -- 'once' | 'standing', 'permission' type only — maps to
                                            -- Question.permissionScopeHint (card 6d5a6280): the ASKING
                                            -- AGENT's typed suggestion, never the human's decision. See
                                            -- decided_scope below for what was actually granted.
  permission_expires_at TEXT,
  decided_scope TEXT,                      -- 'once' | 'standing', the human's ANSWER-TIME grant; set only
                                            -- on decision='authorize' (fix(mcp): persist/surface scope+expiry)
  decided_expires_at TEXT,                 -- absolute ISO expiry paired with decided_scope; advisory only —
                                            -- see Question.decidedExpiresAt's doc
  credential_env_var TEXT,
  secret_blob TEXT,                        -- envelope ciphertext (v1:iv:tag:ct), 'credential' type only —
                                            -- NEVER mapped into the Question object (see toQuestion)
  provision_target TEXT,                   -- ask-time JSON {connection:{name,host},binding?:{profileId}} —
                                            -- credential auto-provisioning v1 (card 193de09e), INTENT only
  provision_connection_id TEXT,            -- set ONLY by the answer boundary once provisioned
  provision_binding_state TEXT,            -- 'pending' | 'applied' once provisioned; NULL ('none') otherwise
  fulfillment_target TEXT,                 -- ask-time JSON {profileId,key,expectedValue?} — grant-fulfilment
                                            -- observation (card 3880f783), 'permission' type only, INTENT only
  state TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'answered' | 'consumed' | 'cancelled'
  chosen_option TEXT,
  note TEXT,
  created_at TEXT NOT NULL,
  answered_at TEXT,
  consumed_at TEXT,
  last_surfaced_state TEXT,                -- decisions-relay dedup signature (card 0c1365d0), NULL = never surfaced
  last_surfaced_at TEXT,
  cancelled_reason TEXT,                   -- question_cancel/dismiss (only ever set alongside state='cancelled')
  cancelled_by TEXT,                       -- 'agent' | 'human'
  cancelled_at TEXT
);
-- Serves both the manager's pull (session_id + state='answered') and a future project-scoped inbox read.
CREATE INDEX IF NOT EXISTS idx_questions_session ON questions(session_id, state);
-- idx_questions_task (on task_id, card 695ebab0's soft task link) is deliberately NOT created here: on a
-- legacy DB predating that column, this CREATE TABLE IF NOT EXISTS is a no-op (the table already exists in
-- its OLD shape) but a CREATE INDEX in this same unconditional block would still run against the
-- not-yet-added column and throw "no such column: task_id". It's created in migrateQuestions() below,
-- AFTER the ALTER TABLE ADD COLUMN — see QUESTION_ADDED_COLUMNS.
-- Serves the answered-stuck watchdog's full scan (listAnsweredStuckQuestions: state='answered' AND
-- answered_at <= ?) and pullAnsweredQuestionsForAgent's per-agent join (card f88e91f0) — both filter on
-- state before/without a known session_id, which idx_questions_session (session_id-leading) can't serve.
CREATE INDEX IF NOT EXISTS idx_questions_state_answered ON questions(state, answered_at);
-- Card af08f7e8: the DELIVERY record for a sessionEnv-delivered credential (card 82b22817), deliberately
-- decoupled from the asking session's own questions row above — that row's session_id is a NOT NULL FK,
-- and deleteSession/deleteAgent/deleteProject cascade-delete every questions row for a session regardless
-- of state, so an answered credential's secret_blob + full history would otherwise be permanently destroyed
-- by an ordinary Archive-tab session delete, with zero warning. This table has NO FK to sessions/agents/
-- questions: source_question_id is a soft, historical pointer (mirrors questions.task_id), so a delivery
-- record survives long after the asking session (and its questions row) is gone. Never hard-deleted on
-- revoke — same "retain, never destroy" posture as questions.cancelled_at (see cancelQuestion's own doc):
-- revoked_at/revoked_by/revoked_reason mark a row terminal without erasing it. Only deleteProject
-- cascades this table (project_id is a NOT NULL FK) — deleting/archiving a SESSION or AGENT never touches
-- it, which is the whole point of the decoupling.
CREATE TABLE IF NOT EXISTS delivered_credentials (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  credential_env_var TEXT NOT NULL,
  secret_blob TEXT NOT NULL,               -- envelope ciphertext (v1:iv:tag:ct) — same shape as
                                            -- questions.secret_blob; NEVER mapped into any agent-reachable
                                            -- or human-REST-listed shape (see toDeliveredCredentialSummary)
  source_question_id TEXT,                 -- soft link to questions(id) — no FK, may outlive it
  delivered_at TEXT NOT NULL,              -- = the answering question's answered_at
  revoked_at TEXT,
  revoked_by TEXT,                         -- 'human' — this row is only ever revoked human-side
  revoked_reason TEXT,
  -- Card f44cc187: set ONCE, permanently, the first time resolveCredentialSessionEnv finds this row's
  -- credential_env_var reserved/invalid (a deny-list widening can silently de-provision an already-live
  -- credential). Dedupe key for BOTH the once-per-row durable credential_undeliverable event and the
  -- per-spawn console log (see markCredentialUndeliverableNotified's own doc) -- never cleared, never
  -- re-fires for the same row. NULL for every row that has never hit the backstop. Added to existing DBs by
  -- migrateDeliveredCredentialsAddedColumns() below (fresh installs already have it via this CREATE TABLE).
  undeliverable_notified_at TEXT
);
-- Serves the live-delivery read (resolveCredentialSessionEnv's project_id + revoked_at IS NULL scan) and
-- the human-only list surface.
CREATE INDEX IF NOT EXISTS idx_delivered_credentials_project ON delivered_credentials(project_id, revoked_at);
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
-- Card 3df86c87 — typed task-to-task relations (docs/decisions/3df86c87-*.md). A NEW table, so its indexes
-- live here (unlike idx_tasks_parent, which indexes the migrate-added tasks.parent_id and is created in
-- migrateTasks() after the ALTER). No FKs: deletion is application-level (deleteTask/deleteProject).
CREATE TABLE IF NOT EXISTS task_relations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  -- blocks: from BLOCKS to. discovered-from: from was discovered while working to. related: stored once, from < to.
  from_task_id TEXT NOT NULL,
  to_task_id TEXT NOT NULL,
  type TEXT NOT NULL,
  -- Two INDEPENDENT bits on a blocks edge (tasks/edge-state.ts): declared = the user's explicit dependency
  -- (blockedBy/blocks writes only; also 1 on related/discovered-from rows), gates_deferral = backs the
  -- target's deferredUntilTaskId alias (alias writes + auto-release only). released = history only: the alias
  -- auto-released this edge and nothing declared it (display-only, never a live dependency). A row exists iff
  -- any of the three is set. NOTE: unreleased shape — a dev LOOM_HOME that booted an earlier draft keeps its
  -- old task_relations columns (CREATE TABLE IF NOT EXISTS); recreate it (drop the table) there.
  declared INTEGER NOT NULL DEFAULT 0,
  gates_deferral INTEGER NOT NULL DEFAULT 0,
  released INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  CHECK (declared = 1 OR gates_deferral = 1 OR released = 1),
  UNIQUE (from_task_id, to_task_id, type)
);
CREATE INDEX IF NOT EXISTS idx_task_relations_to ON task_relations(to_task_id, type);
CREATE INDEX IF NOT EXISTS idx_task_relations_project ON task_relations(project_id, type);
CREATE INDEX IF NOT EXISTS idx_orch_events_mgr ON orchestration_events(manager_session_id, ts);
-- worker_session_id, ts, kind are all ORIGINAL columns on this table (present since its very first
-- CREATE TABLE, unlike a later ALTER-added column) — so, like idx_orch_events_mgr above, these two are
-- plain CREATE INDEX IF NOT EXISTS additions that apply to every existing DB the moment exec(SCHEMA) runs
-- on boot; no ALTER TABLE / migrateXxx() step is needed for them (card bf0b902c).
-- idx_orch_events_worker: listEventsForWorker's WHERE worker_session_id = ? ORDER BY ts, rowid (~20 call
-- sites, incl. the crash-recovery watcher's per-candidate read and boot-reconcile) was a full SCAN of
-- every orchestration_events row plus a temp B-tree sort — measured 3.2-3.4ms/query on a 17.8k-row table,
-- and multiplied across every crash-recovery candidate every 60s that alone blocked the event loop for
-- seconds at a time (better-sqlite3 is synchronous). This index makes it an indexed SEARCH; sqlite's
-- implicit trailing rowid on every index entry also already satisfies the ORDER BY ts, rowid tie-break,
-- so no separate sort step is needed either.
-- idx_orch_events_kind: backs Db.listWorkerSessionIdsWithEventKind's WHERE kind IN (...) query — the crash-
-- recovery watcher's ONE indexed query to derive its candidate set (sessions that have EVER recorded a
-- session_died/worker_report_undelivered trigger) instead of walking every resumable session in the fleet
-- to find out which ones even have one (scope item 2 of bf0b902c). worker_session_id trailing makes the
-- DISTINCT projection index-only (no row lookups against the table itself).
CREATE INDEX IF NOT EXISTS idx_orch_events_worker ON orchestration_events(worker_session_id, ts);
CREATE INDEX IF NOT EXISTS idx_orch_events_kind ON orchestration_events(kind, worker_session_id);
-- Card db316c89: a partial expression index scoped to the one kind every msgId delivery-lookup filters
-- on — isQueuedMessageDelivered, listUndeliveredQueuedMessages, listUnresolvedQueuedMessagesForWorker and
-- getQueuedMessageDeliveredAt all narrow to kind = 'session_message_delivered' before extracting
-- detail_json's msgId, so this is the one partial predicate that serves every msgId json_extract they all
-- run (measured: a 39-54ms synchronous json_extract scan over every delivered row, growing linearly with
-- orchestration_events — on every drain, done report, resume, and all 4 recycle carries). kind and
-- detail_json are both ORIGINAL columns (present since this table's very first CREATE TABLE), so — like
-- idx_orch_events_worker/idx_orch_events_kind above — this is a plain CREATE INDEX IF NOT EXISTS applied
-- unconditionally on every boot; no ALTER TABLE / migrateXxx() step is needed. A query must repeat the
-- exact kind = 'session_message_delivered' predicate for sqlite to prove it can use this partial index —
-- see each call site's own EXPLAIN QUERY PLAN.
CREATE INDEX IF NOT EXISTS idx_orch_events_delivered_msgid
  ON orchestration_events(json_extract(detail_json, '$.msgId'))
  WHERE kind = 'session_message_delivered';
-- Shared project memory (card 2fd9abf9): a project-scoped durable knowledge store any worker/manager can
-- write to (memory_write), retrieved by FTS5 and injected into every kickoff (pinned always + top-K
-- related-on-match), so fleet-shared decisions/facts survive across sessions instead of living only in
-- hand-curated docs. UNIQUE(project_id, key) makes memory_write an upsert-by-key — a second write to the
-- same key overwrites in place (see upsertProjectMemory), never a duplicate row. version (below) was
-- added post-launch by card a5f98bb4 (the optimistic-concurrency guard) — applied to existing DBs by
-- migrateProjectMemory() below (fresh installs already have it via this CREATE TABLE).
CREATE TABLE IF NOT EXISTS project_memory (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  key TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,      -- pinned notes ride IN FULL on every kickoff, NEVER evicted
  tags TEXT NOT NULL DEFAULT '[]',        -- JSON string[]
  version INTEGER NOT NULL DEFAULT 1,     -- monotonic CAS token (card a5f98bb4) — +1 on every write, in SQL
  request_ids TEXT,                       -- nullable JSON string[] of linked Request ids (card e6d270b3);
                                           -- NULL means "links nothing" — resolved against the LIVE requests
                                           -- store at read time, never frozen here (see toProjectMemoryEntry
                                           -- + sessions/project-memory-request-links.ts)
  trigger_glob TEXT NOT NULL DEFAULT '',  -- card aeec1880: optional path-glob predicate gating a pinned
                                           -- note's delivery to a matching kickoff; '' (mirrors title's own
                                           -- empty-means-unset convention) = no predicate, behaves exactly
                                           -- like an ordinary pinned note. See ProjectMemoryEntry.triggerGlob.
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_retrieved_at TEXT,                 -- NULL until first retrieved; feeds LRU-by-retrieval eviction
  retrieval_count INTEGER NOT NULL DEFAULT 0,
  UNIQUE(project_id, key)
);
CREATE INDEX IF NOT EXISTS idx_project_memory_project ON project_memory(project_id, pinned, last_retrieved_at);
-- FTS5 full-text index over title+text, kept in sync via the triggers below (an external-content table
-- keyed by rowid, so the index can never drift from project_memory). Pure local BM25 ranking — no
-- embedding endpoint, no metered API call (the v1 "zero metered tokens" constraint). This is the daemon's
-- first FTS5 usage; confirm better-sqlite3's bundled SQLite has FTS5 compiled in (it does by default).
CREATE VIRTUAL TABLE IF NOT EXISTS project_memory_fts USING fts5(
  title, text, content='project_memory', content_rowid='rowid'
);
CREATE TRIGGER IF NOT EXISTS project_memory_ai AFTER INSERT ON project_memory BEGIN
  INSERT INTO project_memory_fts(rowid, title, text) VALUES (new.rowid, new.title, new.text);
END;
CREATE TRIGGER IF NOT EXISTS project_memory_ad AFTER DELETE ON project_memory BEGIN
  INSERT INTO project_memory_fts(project_memory_fts, rowid, title, text) VALUES ('delete', old.rowid, old.title, old.text);
END;
-- Scoped to "OF title, text" so a pure retrieval-bump UPDATE (touchProjectMemoryRetrieved, which only
-- ever writes last_retrieved_at/retrieval_count) never fires this trigger — no needless FTS churn on
-- every retrieval.
CREATE TRIGGER IF NOT EXISTS project_memory_au AFTER UPDATE OF title, text ON project_memory BEGIN
  INSERT INTO project_memory_fts(project_memory_fts, rowid, title, text) VALUES ('delete', old.rowid, old.title, old.text);
  INSERT INTO project_memory_fts(rowid, title, text) VALUES (new.rowid, new.title, new.text);
END;
