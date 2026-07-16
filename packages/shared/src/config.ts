// Config model: platform default -> per-project override, resolved through ONE merge fn.
// This is also the machine-writable schema phase-2 AI-driven project creation will target.
import type { Profile, SessionRole, OrchestrationEventKind, CapabilityGrant } from "./types.js";

/**
 * Semantic role a board column plays in the worker lifecycle. Columns are identified by stable ROLE,
 * not by hardcoded key — so a column can be renamed/reordered without orphaning cards or breaking the
 * lifecycle logic that repoints to these roles (task B). Optional on the interface (existing stored
 * configs predate it and must still type-check; B's migration backfills them). Fresh projects ship
 * with the two REQUIRED roles `defaultLanding` + `terminal` set on the platform defaults below.
 */
export type ColumnRole =
  | "intake"
  | "defaultLanding"
  | "workReady"
  | "active"
  | "review"
  | "parked"
  | "terminal"
  | "mergeLanding";

export interface KanbanColumn {
  key: string;
  label: string;
  /** Semantic lifecycle role (see ColumnRole). Optional: stored configs may lack it. */
  role?: ColumnRole;
  /**
   * CSS color for the column header accent (e.g. "#6b8afd"). Optional; absent = today's look.
   * accentColor/wipLimit are set ONLY via the atomic PUT /api/projects/:id/columns endpoint
   * (updateBoardColumns); the generic config-override schema (mcp/platform.ts) deliberately omits them.
   */
  accentColor?: string;
  /** SOFT (advisory, non-blocking) work-in-progress limit. Optional; absent = no limit. See accentColor. */
  wipLimit?: number;
  /**
   * Marks a genuine dead-end/parking lane (e.g. "Dropped") whose cards are discounted from the idle
   * watchdog's "actionable" count, without per-card `deferred:true` toil. Optional; absent/false =
   * today's behavior (byte-identical). See accentColor.
   */
  excludeFromIdleWatchdog?: boolean;
}

/**
 * Resolve the column KEY a given lifecycle ROLE maps to on a board, so the daemon's lifecycle logic
 * (new-card landing, worker_spawn/report moves, terminal detection) never hardcodes a key and a column
 * can be renamed/reordered/removed without orphaning cards or breaking delegation (task B). Pass a
 * resolved config's `kanbanColumns` (every resolveConfig consumer has them).
 *
 * Documented fallbacks — these matter only for a board that lacks the role entirely (the migration +
 * fresh-project defaults guarantee `defaultLanding` + `terminal` are always present, so for those two
 * the fallback is purely defensive):
 *  - `terminal` → the LAST column's key (preserves today's `cols.at(-1)` terminal/excludeDone behavior).
 *  - `defaultLanding` → the FIRST column's key (cards always land somewhere visible; the ≥1-column
 *    floor guarantees one exists).
 *  - any other role absent → `undefined`; the caller treats that as "no such lane" (typically a no-op
 *    move, leaving the card in its current valid column — never inventing a non-existent key).
 *
 * Returns `undefined` only for a non-required role with no column, or an empty board.
 */
export function columnKeyForRole(
  columns: readonly KanbanColumn[],
  role: ColumnRole,
): string | undefined {
  if (!columns.length) return undefined;
  const exact = columns.find((c) => c.role === role);
  if (exact) return exact.key;
  if (role === "terminal") return columns[columns.length - 1]?.key; // last-as-terminal (today's behavior)
  if (role === "defaultLanding") return columns[0]?.key; // first column as the catch-all landing
  return undefined; // non-required role absent → caller decides (no move)
}

/** §9 permission policy. Default is acceptEdits + a warmup/read allowlist (NOT blanket skip). */
export interface PermissionPolicy {
  mode: "default" | "acceptEdits" | "plan" | "bypassPermissions";
  /** Allowlist patterns, e.g. "Bash(git status:*)". Auto-approved so warmup never blocks. */
  allow: string[];
  deny: string[];
  /**
   * Shift+Tab presses to inject shortly after the session starts, cycling the permission mode off
   * the gate-free boot default (`mode`) into the desired one. A FRESH spawn always boots in `mode`
   * (acceptEdits) to dodge the bypass-mode acceptance gate; this then steps it the way a human would.
   * Default 2 (acceptEdits → … → bypassPermissions in the current CLI). 0 = leave the boot mode.
   * Version-sensitive: tied to the CLI's Shift+Tab cycle order, so it's tunable here.
   * NOTE: the count is RELATIVE to the boot mode, so it's only correct from a known boot mode. Both a
   * fresh spawn AND `claude --resume` boot at the gate-free `mode` (acceptEdits) — `--resume` HONOURS
   * `--permission-mode`, it does NOT restore the persisted mode (claude 2.1.163; card f05e4897). A fresh
   * spawn blind-cycles this count to its target. The RESUME path instead feedback-cycles the footer
   * ABSOLUTELY to the mode this count maps to (SessionService.resume → host.ts cycleResumeToMode), so it
   * converges to the same target without depending on a fragile blind count on the boot-critical resume
   * path (a blind count there half-landed on plan / left it one short of auto — see that code).
   */
  startupModeCycles?: number;
}

export interface PtyGeometry {
  cols: number;
  rows: number;
}

/**
 * Obsidian auto-start (self-healing vault tooling). The `obsidian` CLI the vault skills use needs the
 * Obsidian DESKTOP PROCESS running (NOT the Local REST API — port 27124 can be down yet the CLI works
 * once the process is up). When `autoStart` is on, a session's vault preflight helper
 * (`assets/scripts/ensure-obsidian.mjs`) launches Obsidian if it's found down, then polls the CLI until
 * ready — falling back to direct filesystem access when disabled/headless/not-installed/launch-timeout
 * (NEVER a hard error). Plumbed to the helper as session env (`LOOM_OBSIDIAN_AUTOSTART` /
 * `LOOM_OBSIDIAN_PATH`) by resolveConfig — see `obsidianSessionEnv`. Default OFF (opt-in; Loom ships to
 * public npm, where a daemon-launched GUI process must be deliberately enabled).
 */
export interface ObsidianConfig {
  /** Launch Obsidian when the vault CLI finds it down. Default false (opt-in). */
  autoStart: boolean;
  /**
   * Override path to the Obsidian executable / `.app` bundle (the helper's OS-aware default is used when
   * absent). HUMAN-ONLY: this is an arbitrary host EXECUTABLE the daemon-spawned preflight launches, so —
   * exactly like `gateCommand` — the agent-facing config validator REJECTS it (only the human REST path
   * accepts a `path`). `autoStart` alone (a boolean using the OS-default install location) stays
   * agent-settable, so the Setup operator can enable the convenience without the host-launch escape hatch.
   */
  path?: string;
}

/**
 * Python tooling (document conversion + future Python-backed features). Loom owns ONE shared venv under
 * `<LOOM_HOME>/python/venv` and pip-installs packages into it on first use (see the daemon's `python/venv.ts`
 * `ensurePythonPackage`). The user supplies only a BASE Python interpreter (≥3.10): discovered on PATH
 * (`python3` → `python` → `py -3`) by default, or pointed at explicitly via `interpreterPath`.
 */
export interface PythonConfig {
  /**
   * Override path to the BASE Python INTERPRETER Loom runs to CREATE its shared venv (PATH discovery is used
   * when absent). HUMAN-ONLY: this is an arbitrary host EXECUTABLE the daemon launches, so — exactly like
   * `obsidian.path` / `gateCommand` — the agent-facing config validator REJECTS it (only the human REST path
   * accepts a `python` block). Loom installs PACKAGES into the venv; it NEVER installs the interpreter.
   */
  interpreterPath?: string;
}

/**
 * Codescape fleet-daemon wiring (epic `369dde3c`, card C2), per-PROJECT opt-in — LEAD RULING: NOT
 * per-profile. Gated ADDITIONALLY behind the daemon-wide `isCodescapeSupervisorEnabled()` (LOOM_DEV +
 * LOOM_CODESCAPE_ENABLED) — this flag alone never wires anything on a regular `loomctl` build. Benign
 * on/off boolean (no host-launch capability of its own — it only conditionally mounts an HTTP MCP entry
 * pointing at the ALREADY-running daemon-owned supervisor), so it stays agent-settable, mirroring `docLint`.
 */
export interface CodescapeConfig {
  enabled: boolean;
}

/**
 * Project-scoped SHARED memory tuning (card 2fd9abf9) — the FTS5 kickoff-injection budget, per-project
 * default `resolveConfig` layer → per-project override, exactly like every other numeric knob here (no ad
 * hoc reads). All three are benign tuning numbers (no host-launch/exfil capability, unlike `gateCommand`/
 * `alertWebhook`), so they stay on the AGENT-facing config validator too — see `platform.ts`.
 */
export interface MemoryConfig {
  /** Approximate token budget for the injected pinned+related digest (byte-length / 4 heuristic — no
   *  tokenizer/API call). Never exceeded; truncation is deterministic, mirroring the companion recall's
   *  byte-bounded digest. */
  budgetTokens: number;
  /** Max "related" (FTS5-matched, unpinned) notes considered per kickoff, before the token budget itself
   *  may truncate further. */
  topK: number;
  /** Per-project cap on UNPINNED notes; writing past it evicts the least-recently-RETRIEVED unpinned
   *  row(s) (owner decision #2). Pinned notes are never evicted and never counted. `<= 0` disables the cap. */
  maxNotes: number;
}

/**
 * Hard ceilings `resolveConfig` clamps `MemoryConfig` to, regardless of what a per-project override (or a
 * pathological operator-set value) asks for — bounds hardening so an accidental `memory_write`-in-a-loop
 * misconfiguration, or a fat-fingered platform default, can't bloat every kickoff or grow the DB unbounded.
 * `topK`'s floor is 1 (0 would silently disable related-note retrieval — use `budgetTokens:0` for that).
 */
export const MEMORY_CONFIG_MAX = {
  budgetTokens: 8000,
  topK: 50,
  maxNotes: 1000,
} as const;

/**
 * Outbound alert webhook (Richer-notifications, external delivery). When set, the daemon POSTs a
 * small JSON payload to `url` on each orchestration event whose `kind` is in `events`, so the human
 * is alerted OUTSIDE the UI (a generic webhook works for Slack/Discord incoming-webhook URLs + any
 * custom endpoint). Best-effort + bounded — never blocks or breaks the orchestration event path.
 *
 * ⚠️ TRUST BOUNDARY (DATA-EXFILTRATION vector): a webhook URL redirects orchestration data off-box,
 * so — exactly like `gateCommand` — this is HUMAN-set ONLY. The agent-facing config validator
 * (`validateAgentProjectConfigOverride`) REJECTS it; only the human REST path accepts it. An agent
 * must never be able to point Loom's event stream at an attacker endpoint.
 */
export interface AlertWebhook {
  /** The endpoint the daemon POSTs to (Slack/Discord incoming-webhook URL or any custom receiver). */
  url: string;
  /** Which orchestration event kinds trigger a POST (e.g. merge_done, merge_rejected, idle_escalated). */
  events: OrchestrationEventKind[];
}

/** Phase-2 orchestration settings. */
export interface OrchestrationConfig {
  /**
   * HUMAN-only outbound alert webhook (see AlertWebhook). Absent by default (no external delivery).
   * Exfil-guarded: accepted on the human config path, REJECTED on the agent-facing path (like
   * gateCommand). Read through resolveConfig by the daemon's alert emitter.
   */
  alertWebhook?: AlertWebhook;
  /**
   * Per-project, HUMAN-only timeout (ms) for an outbound `alertWebhook` POST — pairs with
   * `alertWebhook`. Bounds the best-effort delivery so a hung receiver can't stall the event path.
   * Default 5000. No env layer (per-project + global only). Omitted from the agent-facing validator
   * (human-only, like its paired `alertWebhook`).
   */
  alertWebhookTimeoutMs: number;
  /**
   * Build/test command run in a worker's worktree before a merge (the build/DoD gate).
   * Empty string = no automated gate; at this stage the two-step manager review IS the gate.
   * (#17 will REQUIRE a non-empty gate before autonomy is enabled.)
   */
  gateCommand: string;
  /**
   * Per-project, HUMAN-only timeout (ms) for a `gateCommand` run — pairs with `gateCommand`. Caps how
   * long the build/DoD gate may run before it's killed. Default 120000. No env layer (per-project +
   * global only). Omitted from the agent-facing validator (human-only, like its paired `gateCommand`).
   */
  gateCommandTimeoutMs: number;
  /**
   * Scoped per-project DEPLOY command (design [[Scoped Per-Project Deploy — Design]], 13235b62): a
   * manager's OWN-project outward-exec primitive — mirrors `gateCommand` exactly. Run in the project's
   * `repoPath` cwd via the `deploy` manager tool; can be `git push` (triggers external CI), a deploy
   * script, or a webhook curl — the command itself IS the deploy. Empty string (default) = no deploy
   * configured, so the tool refuses ("ships inert"). HUMAN-only to set (host-RCE-capable exactly like
   * `gateCommand` — see the agent-facing validator note on `agentOrchestrationOverride` in
   * mcp/platform.ts); its presence on a project's config IS the owner's opt-in-once trust decision — no
   * separate per-deploy confirm.
   */
  deployCommand: string;
  /**
   * Per-project, HUMAN-only timeout (ms) for a `deployCommand` run — pairs with `deployCommand`, same
   * bounds/semantics as `gateCommandTimeoutMs`. Default 120000. No env layer (per-project + global
   * only). Omitted from the agent-facing validator (human-only, like its paired `deployCommand`).
   */
  deployCommandTimeoutMs: number;
  /**
   * Safety rail (§17a): hard cap on concurrently-LIVE workers per manager, gating worker_spawn.
   * At the cap the manager's next spawn is refused; in-flight workers keep running. Default 3.
   */
  maxConcurrentWorkers: number;
  /**
   * Safety rail (§19a hardening): hard cap on concurrently-LIVE manager sessions the cron Scheduler
   * will spawn. maxConcurrentWorkers caps workers PER manager; this caps the managers themselves, so
   * a burst of simultaneously-due schedules can't launch an unbounded fleet in one tick. At the cap
   * the Scheduler defers the remaining due schedules to the next tick (next_fire_at untouched). Default 3.
   */
  maxConcurrentManagers: number;
  /**
   * Host-load guard (card 301d8c01): hard cap on concurrently-RUNNING daemon-EXECUTED heavy gate runs
   * (the merge-confirm gate + the scoped-deploy gate — both spawn a human-set build/test command via
   * `runGateSequential`), across EVERY project on this daemon. A gate that can't acquire a slot QUEUES
   * (awaits) rather than being rejected. Daemon-GLOBAL, like `schedulerEnabled` — NOT a per-project
   * setting (there is no per-project equivalent; ProjectConfigOverride.orchestration deliberately omits
   * it), since host resource contention is a whole-daemon concern, not a per-project one. Default 1
   * (serialize daemon-run heavy gates) — set via the daemon-global PlatformConfigOverride, not a
   * project's own config.
   */
  maxConcurrentGates: number;
  /**
   * Pillar-B trigger gate (§19b): when false (default), the daemon does NOT start the cron
   * Scheduler, so no schedule auto-fires. Opt-in per the autonomy ladder — a daemon shouldn't
   * auto-spawn managers until explicitly switched on. The daemon reads the platform-default value
   * (this is a daemon-wide service, not per-project); env override: LOOM_SCHEDULER_ENABLED=1.
   */
  schedulerEnabled: boolean;
  /**
   * Manager context-recycle threshold: the fraction of a manager's MODEL context window
   * (`contextWindowForModel`, so it scales with the model — 1M for Opus/Sonnet 4.x, 200k otherwise)
   * at which the daemon's ContextWatcher nudges the manager to hand off to a fresh successor (run
   * /session-end, write a continuation prompt, call recycle_me). Agent-confirmed — the watcher only
   * prompts; the manager performs the handoff. Default 0.80; 0 disables. Env: LOOM_RECYCLE_CONTEXT_RATIO.
   */
  recycleAtContextRatio: number;
  /**
   * Context-recycle re-nudge cadence: minutes between successive ContextWatcher recycle nudges to a
   * manager that's over `recycleAtContextRatio` but hasn't handed off yet. The context analogue of the
   * idle watchdog's `idleNudgeMinutes` — a fired nudge isn't repeated for another full window. The whole
   * watcher is still gated by `recycleAtContextRatio` (0 there disables it); this only paces re-nudging.
   * Default 20.
   */
  recycleNudgeIntervalMinutes: number;
  /**
   * Context-recycle escalation cap: after this many CONSECUTIVE context-recycle nudges go unanswered (the
   * manager never recycles), the ContextWatcher escalates to the human (a `context_escalated` event the
   * web attention surface alerts on) instead of nudging into the void. The context analogue of the idle
   * watchdog's `maxUnansweredNudges`. Default 3.
   */
  maxUnansweredRecycleNudges: number;
  /**
   * Asleep-at-the-Wheel idle-manager watchdog. Minutes a LIVE manager may sit idle (busy=false, no live
   * workers, not snoozed/suppressed) before the watcher nudges it once. Default 45; 0 disables the
   * watcher entirely. Env LOOM_IDLE_NUDGE_MINUTES sets the platform default here (a per-project
   * override still wins). Sibling of recycleAtContextRatio.
   */
  idleNudgeMinutes: number;
  /**
   * Idle watchdog escalation cap: after this many CONSECUTIVE unanswered idle nudges (no idle_report
   * and no new orchestration activity) the watcher backs off and escalates to the human (policy →
   * suppressed) instead of nudging into the void. Default 2.
   */
  maxUnansweredNudges: number;
  /**
   * Idle watchdog snooze fallback: minutes to snooze when a manager reports `waiting` WITHOUT an
   * explicit `minutes`. Default 30: a conservative re-check interval — the manager can always pass
   * explicit `minutes` for a longer wait. Read by `service.ts` when a manager reports `waiting`.
   */
  idleDefaultSnoozeMinutes: number;
  /**
   * Idle-WORKER coverage (board card b9d479b0): minutes a LIVE worker may sit idle (`busy=false`) with
   * its task still unreported before IdleWatcher RE-nudges its manager (reusing the same reconciled
   * notifyManagerOfIdleWorker nudge the worker's own busy→false edge already fires once). Closes the
   * two-path asymmetry where an idle, unreported worker was watched by NOBODY — BusyWorkerWatcher only
   * covers `busy=true` workers, and a manager whose only live worker was idle used to be silently skipped
   * by the idle-manager predicate too. Sibling of `idleNudgeMinutes`; default 45 (same default); 0 disables.
   */
  idleWorkerMinutes: number;
  /**
   * Busy-worker LONG-TURN advisory: minutes a LIVE worker may sit `busy` in a SINGLE uninterrupted turn
   * (no turn boundary → `lastActivity` not advancing, since `setBusy` re-stamps it on every turn edge)
   * before the BusyWorkerWatcher surfaces it to the OWNING MANAGER as an informational heads-up (a
   * `worker_stuck` event + a busy-gated nudge — re-nudge or recycle if genuinely warranted; never a
   * hard kill). Sibling of `idleNudgeMinutes`, but for long-running workers rather than idle managers.
   * Default 60; 0 disables the watcher entirely. Deliberately a SOFT advisory, not a hang detector: a
   * worker mid-gate (build/test streaming output) and a genuinely hung worker look identical on this
   * signal alone — `lastActivity` only advances at turn edges, and a live-repainting TUI can't be told
   * apart from a hang by pty output either (PtyHost's own `healIfStuck` already clears `busy` once pty
   * output goes stale ≥5min, so `busy` staying true for the full window already implies recent output —
   * a dual pty-output gate would be unreachable dead code). Raise this per project if your builds
   * routinely run longer than 60 minutes.
   */
  stuckWorkerMinutes: number;
  /**
   * Crash-recovery watchdog (CrashRecoveryWatcher): the bounded cap on AUTO-RESUME attempts for a
   * resumable session whose pty died UNEXPECTEDLY while the daemon stayed healthy (a single pty death
   * NOT caused by pty.stop and NOT a whole-daemon restart — see the `session_died` event). After this
   * many re-deaths in one crash-loop episode the watchdog STOPS resuming and escalates loudly on Mission
   * Control instead of looping (the load-bearing crash-loop-safety property). A stable, still-live resume
   * resets the counter. Serves as BOTH the enable flag and the cap: 0 disables the watcher for the
   * project; default 3. Sibling of `stuckWorkerMinutes` — both are per-project orchestration leashes.
   */
  crashRecoveryMaxAttempts: number;
}

/**
 * Daemon-global automatic-backup settings. NOT per-project — the SQLite DB is one file the whole
 * daemon shares, so the daemon reads these off the platform default (like `schedulerEnabled`), not a
 * per-project override. The auto-backup service snapshots `loom.db` on boot, on this interval, and
 * before a self-host restart, rotating the newest `keep`.
 */
export interface BackupConfig {
  /** Minutes between periodic auto-snapshots. 0 disables ONLY the periodic ticker (boot/pre-restart
   *  snapshots still fire while `enabled`). Default 60. Env: LOOM_BACKUP_INTERVAL_MINUTES. */
  intervalMinutes: number;
  /** How many newest auto snapshots to retain in backups/auto/ (older pruned by mtime). Default 48. */
  keep: number;
  /** Master switch. false disables ALL auto backups (boot + periodic + pre-restart). Default true. */
  enabled: boolean;
}

/**
 * Daemon-global rate-limit handling numbers (used by usage-limit/usage-awareness). DAEMON-GLOBAL —
 * not per-project; the daemon reads these off the resolved `platform` grouping (the daemon supplies
 * the global override from its SQLite store; `shared` stays browser-pure). HUMAN-only.
 */
export interface RateLimitConfig {
  /** Backoff (ms) applied when a rate limit is hit with no parseable reset time. Default 18000000 (5h). */
  defaultBackoffMs: number;
  /** Slack (ms) added past a parsed reset time before resuming, so we don't wake a hair early. Default 10000. */
  resetBufferMs: number;
  /** Max wait (ms) we'll schedule a resume for when a reset time WAS parsed. Default 1800000 (30m). */
  deadlineAfterResetMs: number;
  /** Max wait (ms) we'll schedule a resume for when NO reset time was parsed. Default 21600000 (6h). */
  deadlineNoResetMs: number;
  /** How recent (ms) a rate-limit signal must be to still count as active. Default 21600000 (6h). */
  recencyWindowMs: number;
  /**
   * Utilization (0–100 scale, matching UsageWindow.utilization) at/above which a plan-usage window
   * counts as EXHAUSTED for the no-hook-reset resume fallback (usage-limit.ts's
   * resumeResetFromUsageStatus). Default 95.
   */
  exhaustedThresholdPct: number;
}

/**
 * Daemon-global watcher/ticker cadences (ms). DAEMON-GLOBAL — read off the resolved `platform`
 * grouping at boot (these are boot-bound: a change needs a daemon restart). Each cadence has a
 * matching `LOOM_*_INTERVAL_MS` env override, read in the resolver beneath the global override and
 * FLOOR-CLAMPED to the §bounds watcher floor (5000ms) so a stray `…=0` can't busy-loop the daemon.
 */
export interface WatcherConfig {
  /** ContextWatcher tick (LOOM_CONTEXT_WATCH_INTERVAL_MS). Default 60000. */
  contextWatchMs: number;
  /** IdleWatcher tick (LOOM_IDLE_WATCH_INTERVAL_MS). Default 60000. */
  idleWatchMs: number;
  /** RateLimitWatcher tick (LOOM_RATE_LIMIT_WATCH_INTERVAL_MS). Default 60000. */
  rateLimitWatchMs: number;
  /** UsageStatusPoller cadence (LOOM_USAGE_POLL_INTERVAL_MS). Default 60000. */
  usagePollMs: number;
  /** Wake/scheduler-due tick (LOOM_WAKE_INTERVAL_MS). Default 60000. */
  wakeMs: number;
  /** Cron Scheduler tick (LOOM_SCHEDULER_INTERVAL_MS). Default 60000. */
  schedulerMs: number;
  /** Boot-reconcile cadence (LOOM_RECONCILE_INTERVAL_MS). Default 10000. */
  reconcileMs: number;
  /**
   * Periodic transcript-snapshot tick (LOOM_SNAPSHOT_INTERVAL_MS). Default 420000 (7m). A low-frequency
   * backstop that snapshots every LIVE session's engine transcript, closing the hard-crash-no-signal gap
   * the graceful SIGINT/SIGTERM hook can't cover (kill-9/power-loss fires no signal; a long-lived session
   * has no snapshot until it exits). Cheap — snapshotTranscript is mtime-guarded → a no-op when unchanged.
   */
  snapshotMs: number;
  /**
   * CrashRecoveryWatcher tick (LOOM_CRASH_RECOVERY_WATCH_INTERVAL_MS). Default 60000. Cadence at which
   * the watchdog scans for resumable sessions that died unexpectedly (daemon healthy) and bounded-resumes
   * them; per-project enable + cap lives in `orchestration.crashRecoveryMaxAttempts` (0 = off).
   */
  crashRecoveryWatchMs: number;
  /** PollService tick (LOOM_POLL_INTERVAL_MS) — the local poll-job trigger layer, agent-tooling epic P3.
   *  Default 60000. Independently tunable from wakeMs: poll jobs hit an external host (through the P2
   *  connection guard's own rate limiter), so an owner may want a coarser cadence than the internal
   *  wake/schedule tickers. */
  pollMs: number;
}

/**
 * Daemon-global operation timeouts (ms). DAEMON-GLOBAL — read off the resolved `platform` grouping.
 * The git/provision timeouts are boot-bound (threaded into bounded-git/provision deps at boot);
 * `busyStaleMs` is a pty-host constructor opt. No env layer. HUMAN-only.
 */
export interface TimeoutConfig {
  /** Bounded remote git op (fetch/push paths via worktrees). Default 15000. */
  gitOpMs: number;
  /** Bounded LOCAL git op. Default 15000. */
  gitLocalMs: number;
  /** Bounded git PUSH. Default 45000. */
  gitPushMs: number;
  /** Worktree provision timeout. Default 180000. */
  provisionMs: number;
  /** PTY busy-flag stale threshold. Default 300000. */
  busyStaleMs: number;
  /**
   * Agent Runs hard run-timeout (ms): the wall-clock ceiling an ephemeral `run` may stay non-terminal
   * before it is force-marked `timed_out` + torn down (backstops an agent that finishes without ever
   * calling submit_result). Boot-bound into SessionService like the git timeouts. Default 600000 (10m).
   */
  runMs: number;
}

/**
 * Bounds for the P2 `authenticated_request` MCP tool (agent-tooling epic) — the request timeout +
 * response-size cap that keep a hung/huge upstream response from wedging the daemon, plus the
 * per-connection rate/spend guard the design flagged as a LEAD DEFAULT (owner-veto item before merge).
 */
export interface ConnectionsGuardConfig {
  /** Request timeout (ms) via AbortSignal. Default 20000 (20s). */
  requestTimeoutMs: number;
  /** Response body cap (bytes); exceeding it aborts the read and errors the call. Default 1000000 (1MB). */
  maxResponseBytes: number;
  /** Max requests a single connection may make within `rateLimitWindowMs`. Default 30. */
  rateLimitMax: number;
  /** Sliding rate-limit window (ms). Default 300000 (5m). */
  rateLimitWindowMs: number;
}

/**
 * A full stdio MCP server invocation spec — command + optional args[] + optional env{} — exactly the
 * shape a host tool's OWN "add this MCP server" export takes (e.g. Open Design's `claude mcp add-json`
 * payload). Card e8eee68c: some host tools' real invocation can't be expressed as a single bin path plus
 * one hardcoded subcommand arg — Open Design's desktop-app distribution needs a two-arg command
 * (`[daemon-cli.mjs, "mcp"]`) PLUS three env vars (its data dir, its sidecar IPC pipe, an
 * Electron-run-as-node flag) to reach its running desktop app's sidecar. When a tool's
 * `HostToolIntegrationConfig.mcpConfig` is set, its resolver injects this VERBATIM instead of deriving
 * `{command, args}` from `path` via `resolveHostToolBin` — no "mcp" arg is appended, no shape-guessing.
 */
export interface HostToolMcpSpec {
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

/**
 * A single optional host-tool integration's DB-persisted configuration. `path` is an absolute PATH to
 * the tool's own executable/entry script (a host EXEC fact, exactly like `obsidian.path`/
 * `python.interpreterPath`) — unset means "no DB override," and the resolver falls back to its own
 * `LOOM_*_BIN` env var, never to a hardcoded path. `mcpConfig` (card e8eee68c) is the escape hatch for a
 * tool whose real invocation needs more than a bin path — see {@link HostToolMcpSpec}; when set it wins
 * over `path`/the env fallback entirely. Consumed by openDesign's resolver ONLY — Codescape is
 * PATH-only (see {@link CodescapeIntegrationConfig}) since `codescapeMcpServer` only ever resolves a bin
 * path, never a full stdio spec. See card 8dc5ebb9 (host-tool integrations: DB-persisted paths + Settings
 * UI).
 */
export interface HostToolIntegrationConfig {
  path?: string;
  mcpConfig?: HostToolMcpSpec;
}

/**
 * Codescape's integration config: PATH-only, deliberately narrower than {@link HostToolIntegrationConfig}.
 * `codescapeMcpServer` (pty/host.ts) resolves via a bin path (DB override → `LOOM_CODESCAPE_BIN` → a bare
 * PATH-resolvable default name) and never reads a full stdio spec, so `mcpConfig` is REJECTED at
 * validation (`mcp/platform.ts`'s `codescapeIntegrationOverride`) rather than silently accepted-and-
 * ignored — a hand-authored `mcpConfig` on codescape used to validate, persist, and thread through
 * `resolvePlatform` while never actually being read.
 */
export interface CodescapeIntegrationConfig {
  path?: string;
}

/**
 * Daemon-global optional host-tool integration paths (Open Design, Codescape, …) — HOST-MACHINE facts,
 * not per-project. Each named key is its own resolver's concern; this is deliberately a fixed, named
 * shape (like `obsidian`/`python`/`codescape` above), NOT a generic `Record<string,...>`, so it keeps the
 * same `.strict()` typo-guard every other config domain gets — adding a future tool means adding a new
 * named key here + its own resolver, exactly like every other integration in this file. Default `{}` per
 * tool (no DB path set) — see PLATFORM_DEFAULTS.platform.integrations.
 */
export interface IntegrationsConfig {
  openDesign: HostToolIntegrationConfig;
  codescape: CodescapeIntegrationConfig;
}

/**
 * Daemon-global "platform" tuning grouping: rate-limit numbers, watcher cadences, operation timeouts.
 * NOT per-project — like `backup`/`schedulerEnabled`, the daemon shares ONE of these. The daemon
 * supplies an optional global override (its SQLite-persisted singleton blob) as the 2nd arg to
 * `resolveConfig`; `shared` itself stays browser-pure and only reads `process`-guarded `LOOM_*` env.
 */
export interface PlatformConfig {
  rateLimit: RateLimitConfig;
  watchers: WatcherConfig;
  timeouts: TimeoutConfig;
  /** P2 authenticated-request bounds + per-connection rate guard. See ConnectionsGuardConfig. */
  connections: ConnectionsGuardConfig;
  /** Host-tool integration paths (Open Design, Codescape, …). See IntegrationsConfig. */
  integrations: IntegrationsConfig;
  /**
   * Message-delivery behavior toggle (owner-directed, 2026-07-03): when a recipient is busy and
   * inbound messages queue, should an AGENT/human-authored message (a manager→worker direction, a
   * worker→manager report, a Lead session_message, a human composer turn, a companion inbound) be
   * delivered as its OWN turn (one-per-turn, so distinct directives are never mashed into one wall of
   * text), or coalesced into a single concatenated turn together with any other queued agent messages
   * (today's legacy full-coalesce behavior)? Loom's own operational nudges (idle/context/busy-stuck
   * watchdogs, restart/boot continuation notes, rate-limit/usage nudges, memory-recall injection) always
   * coalesce regardless of this flag — only AGENT-kind entries are gated by it. Default false (= the new
   * one-per-turn behavior); set true to restore the pre-2026-07 full-coalesce behavior. Read ONCE by
   * PtyHost's drain path (a pty-host constructor opt, boot-bound like `timeouts.busyStaleMs`), never
   * re-resolved per message. DAEMON-GLOBAL (no per-project layer) + HUMAN-only, mirroring the rest of
   * `PlatformConfig`.
   */
  coalesceAgentMessages: boolean;
  /**
   * Opt-in gate for companion VOICE (STT/TTS) provisioning (owner-directed 2026-07-06): faster-whisper
   * (~500MB) and kokoro-onnx (~197MB) are heavyweight Python installs that used to provision automatically
   * the moment a companion was configured. Default OFF — the owner decides if/when to pull those installs
   * down. OFF is fully inert: boot pre-warm (`prewarmStt`/`prewarmTts`) is skipped entirely, and
   * `companion/stt.ts`'s `createFasterWhisperTranscriber` / `companion/tts.ts`'s `createKokoroSynthesizer`
   * never kick venv provisioning and report `isReady()===false`, so voice notes/replies degrade through
   * their EXISTING text paths (transcribe-unavailable / null synth) exactly as if faster-whisper/kokoro-onnx
   * were never installed. ON restores today's auto-provisioning behavior. Read ONCE at daemon boot (like
   * `coalesceAgentMessages`) — a toggle takes effect on the next daemon restart. DAEMON-GLOBAL (no
   * per-project layer) + HUMAN-only, mirroring the rest of `PlatformConfig`.
   */
  companionVoiceEnabled: boolean;
  /**
   * Bucket 2b "Elevated Operator" gate (owner-approved spec): master switch for the `operator` session
   * role's `loom-operator` MCP surface (own-workspace git writers + vault_write). Default OFF. Read LIVE
   * at every gate (mirrors `paths.ts` `isLoomDev` — NOT boot-memoized like `coalesceAgentMessages`/
   * `companionVoiceEnabled` above), so flipping it off revokes the surface on the very next request
   * instead of waiting for a restart. DAEMON-GLOBAL (no per-project layer) + HUMAN-only, mirroring the
   * rest of `PlatformConfig`.
   */
  operatorEnabled: boolean;
}

/** Default for `PlatformConfig.companionVoiceEnabled` — a single named constant so flipping the shipped
 *  default is a one-line change. OFF: companion voice provisioning is explicit human opt-in. */
export const COMPANION_VOICE_ENABLED_DEFAULT = false;

/** Default for `PlatformConfig.operatorEnabled` — a single named constant, mirroring
 *  `COMPANION_VOICE_ENABLED_DEFAULT`. OFF: the Elevated Operator surface is explicit human opt-in. */
export const OPERATOR_ENABLED_DEFAULT = false;

/**
 * Access-story Phase A (card 766f8b50) — daemon-global remote-bind config. NOT per-project — like
 * `backup`/`platform`, the daemon shares ONE of these. Ships INERT: `enabled:false` + `bindHost:
 * "127.0.0.1"` by default, so today's loopback-only bind is byte-identical. `enabled` is the master
 * switch a future phase reads before ever attempting a non-loopback `.listen()`; `bindHost` is the
 * interface that later bind targets (still ignored while a boot-time token guard refuses it — see
 * gateway/trust-tier.ts `canOpenRemoteListener`). `tls`/`rateLimit` are Phase C concerns (TLS material +
 * a remote-request limiter), actually consumed starting Phase C (card 6bc02f50). The gateway TOKEN
 * itself does NOT live here — Phase B stores it in a keyed table, never in config.
 *
 * **Token rotation (P5b hardening follow-up, card 80e2093f, item 1):** rotating a gateway token
 * (`Db.rotateGatewayToken`) is an IMMEDIATE cutover — the old token's salt+hash is overwritten in place, so
 * it stops verifying the instant rotation happens, breaking any remote client still presenting it until it
 * picks up the new one. This is INTENTIONAL, not a bug — the store deliberately does not do a dual-accept
 * grace TTL, keeping the auth surface simple (exactly one valid secret per token row at a time). If a
 * live remote client needs to switch tokens without a connectivity gap, use the store's existing
 * multi-token support as a manual grace procedure instead: mint a SECOND gateway token, distribute it to
 * every remote client, confirm they've all switched over, THEN revoke/delete the OLD token (rather than
 * rotating it) — every other token stays valid throughout. See `Db.rotateGatewayToken`'s own doc comment.
 *
 * **`bindHost` all-interfaces mode (item 2):** `0.0.0.0` (and its IPv6 counterpart `::`) is an explicit,
 * OWNER-DECIDED supported bind target — see `bindHost`'s own doc below.
 */
export interface RemoteAccessConfig {
  /** Master switch — a non-loopback bind is only ever attempted when true. Default false. */
  enabled: boolean;
  /**
   * Interface a later phase binds when `enabled`. Default "127.0.0.1" (loopback — no-op today).
   * `0.0.0.0` (or IPv6 `::`) is explicitly ACCEPTED and supported: it binds ALL interfaces, putting every
   * device on the local network in scope to reach the gateway (not just this host). This is NOT an auth
   * bypass — every non-loopback peer, LAN or otherwise, still has to clear the same gateway-token +
   * TLS-or-tailnet wall as any other remote bind (see `canOpenRemoteListener`/`tlsRequirementSatisfied` in
   * gateway/trust-tier.ts) — but it IS a deliberately broad exposure surface, so a daemon that actually
   * opens it logs a plain startup warning (see `isAllInterfacesBindHost`, consumed in index.ts) rather than
   * doing it silently, and the Settings UI surfaces the same "reachable from your LAN" note.
   */
  bindHost: string;
  /**
   * TLS material for the remote listener (Phase C). MANDATORY whenever `bindHost` is non-loopback AND
   * not a `.ts.net` tailnet address (a tailnet link is already encrypted; anything else is wss-only over
   * untrusted transport) — absent/unreadable in that case boot-refuses the remote bind and falls back to
   * loopback (see gateway/trust-tier.ts `canOpenRemoteListener`/`tlsRequirementSatisfied`).
   */
  tls?: { certPath: string; keyPath: string };
  /**
   * Remote-request rate limiting (Phase C) — on by default whenever a remote bind is enabled (see the
   * default in PLATFORM_DEFAULTS.remoteAccess.rateLimit below); tunable, never fully absent once
   * `enabled`. Scoped to the REMOTE interface only — the loopback fast path is exempt (see
   * gateway/remote-rate-limit.ts).
   */
  rateLimit?: {
    /** Sliding-window request cap per remote caller ip, per minute. */
    perIpPerMin: number;
    /** Sliding-window request cap per presented gateway token, per minute. */
    perTokenPerMin: number;
    /** Auth-failure backoff/lockout, keyed on the caller's ip — reuses the SAME sliding-window-lockout
     *  primitive (security/lockout.ts) as the companion DM-pairing coordinator's rate-limit. */
    authFailLockout: { maxAttempts: number; windowMs: number; lockoutMs: number };
  };
}

/** The fully-resolved, effective config for a project. */
export interface ResolvedConfig {
  kanbanColumns: KanbanColumn[];
  permission: PermissionPolicy;
  pty: PtyGeometry;
  /** Extra env applied to spawned sessions (merged over the spawn baseline). */
  sessionEnv: Record<string, string>;
  orchestration: OrchestrationConfig;
  /** Daemon-global auto-backup settings (read off the platform default; not per-project). */
  backup: BackupConfig;
  /**
   * Daemon-global platform tuning (rate-limit numbers, watcher cadences, op timeouts). Not
   * per-project; resolved from the optional global override (2nd arg) ?? LOOM_* env ?? defaults.
   */
  platform: PlatformConfig;
  /**
   * Daemon-global remote-bind config (access-story Phase A). Not per-project — resolved from the
   * optional global override (2nd arg, same as `platform`), no per-project layer. See RemoteAccessConfig.
   */
  remoteAccess: RemoteAccessConfig;
  /**
   * Pillar D: wire the mechanical vault-lint PostToolUse hook into this project's sessions
   * (flags doc-hygiene anti-patterns on .md vault writes). Default true; set false to disable.
   */
  docLint: boolean;
  /** Codescape fleet-daemon MCP wiring, per-project opt-in (card C2). Default false — see CodescapeConfig. */
  codescape: CodescapeConfig;
  /** Obsidian auto-start (self-healing vault tooling). Default OFF — see ObsidianConfig. */
  obsidian: ObsidianConfig;
  /** Python tooling (shared Loom-managed venv). Only `interpreterPath` is configurable — see PythonConfig. */
  python: PythonConfig;
  /** Project-scoped shared-memory FTS5 kickoff-injection tuning (card 2fd9abf9) — see MemoryConfig. */
  memory: MemoryConfig;
  /**
   * Session-usage telemetry sampler cadence (ms): how often the daemon's background sampler reads each
   * LIVE session's transcript and appends a usage DELTA sample (epic c9924bcd, card B). DAEMON-GLOBAL —
   * like `backup`/`schedulerEnabled`, the daemon reads this off the platform default, NOT a per-project
   * override (so it's HUMAN-only by construction; the agent-facing validator never sees it). Default
   * 300000 (5m).
   */
  usageSampleIntervalMs: number;
  /**
   * Session-usage telemetry retention (days): samples older than this are pruned so the
   * `session_usage_samples` table stays bounded (epic c9924bcd, card B's pruner). DAEMON-GLOBAL +
   * HUMAN-only, exactly like `usageSampleIntervalMs`. Default 90.
   */
  usageSampleRetentionDays: number;
}

/** Per-project overrides. Deep-partial of ResolvedConfig; anything omitted inherits the default. */
export interface ProjectConfigOverride {
  kanbanColumns?: KanbanColumn[];
  permission?: Partial<PermissionPolicy>;
  pty?: Partial<PtyGeometry>;
  sessionEnv?: Record<string, string>;
  orchestration?: Partial<OrchestrationConfig>;
  // NOTE: no `backup` key — auto-backup is daemon-GLOBAL (one shared DB file), not per-project. The
  // daemon reads it off the platform default (+ LOOM_BACKUP_INTERVAL_MINUTES env), like schedulerEnabled.
  // NOTE: no `platform` key either — platform tuning is daemon-GLOBAL (one shared daemon), supplied as
  // resolveConfig's SEPARATE 2nd arg (PlatformConfigOverride), never nested in a per-project override.
  docLint?: boolean;
  /** See ResolvedConfig.codescape. */
  codescape?: Partial<CodescapeConfig>;
  obsidian?: Partial<ObsidianConfig>;
  python?: Partial<PythonConfig>;
  /** See ResolvedConfig.memory. */
  memory?: Partial<MemoryConfig>;
}

/**
 * Daemon-global platform override — the SEPARATE 2nd arg to `resolveConfig`, NOT part of a per-project
 * override. Deep-partial of PlatformConfig: each sub-group optional, each field within it optional, so
 * the human can tune one number and inherit the rest. The daemon loads this from its SQLite singleton
 * blob and threads it in; absent → platform defaults (+ LOOM_* watcher env) = today's behavior.
 */
export interface PlatformConfigOverride {
  rateLimit?: Partial<RateLimitConfig>;
  watchers?: Partial<WatcherConfig>;
  timeouts?: Partial<TimeoutConfig>;
  /** See PlatformConfig.connections. */
  connections?: Partial<ConnectionsGuardConfig>;
  /** See PlatformConfig.integrations. Deep-partial: setting one tool's path leaves the other untouched. */
  integrations?: { openDesign?: HostToolIntegrationConfig; codescape?: CodescapeIntegrationConfig };
  /** See PlatformConfig.coalesceAgentMessages. */
  coalesceAgentMessages?: boolean;
  /** See PlatformConfig.companionVoiceEnabled. */
  companionVoiceEnabled?: boolean;
  /** See PlatformConfig.operatorEnabled. */
  operatorEnabled?: boolean;
  /** See RemoteAccessConfig. Deep-partial: `tls`/`rateLimit` replace whole when present. */
  remoteAccess?: Partial<RemoteAccessConfig>;
  /**
   * See OrchestrationConfig.schedulerEnabled. Daemon-GLOBAL, like backup/coalesceAgentMessages — NOT
   * a per-project setting (there is no per-project equivalent; ProjectConfigOverride.orchestration
   * deliberately omits it). The daemon reads this off the platform default (+ LOOM_SCHEDULER_ENABLED
   * env, which wins when set).
   */
  schedulerEnabled?: boolean;
  /** See OrchestrationConfig.maxConcurrentGates. Daemon-GLOBAL host-load guard (card 301d8c01), like
   *  schedulerEnabled — NOT a per-project setting. */
  maxConcurrentGates?: number;
}

export const PLATFORM_DEFAULTS: ResolvedConfig = {
  kanbanColumns: [
    { key: "inbox", label: "Inbox", role: "intake" },
    { key: "backlog", label: "Backlog", role: "defaultLanding" },
    { key: "todo", label: "To Do", role: "workReady" },
    { key: "in_progress", label: "In Progress", role: "active" },
    { key: "waiting", label: "Waiting", role: "parked" },
    { key: "review", label: "Review", role: "review" },
    { key: "done", label: "Done", role: "terminal" },
  ],
  permission: {
    mode: "acceptEdits",
    allow: [
      // Loom's own project-scoped task tools — safe by construction (server derives the
      // project from the session id), so always auto-approved. Without this the agent
      // would hang on a permission prompt when calling tasks_* unattended.
      "mcp__loom-tasks",
      "Bash(obsidian:*)",
      "Bash(git status:*)",
      "Bash(git log:*)",
      "Bash(git diff:*)",
    ],
    deny: [],
    // Boot gate-free in acceptEdits, then Shift+Tab twice into the target mode (the human step).
    startupModeCycles: 2,
  },
  pty: { cols: 80, rows: 24 }, // fixed geometry; viewers scale by font size (no resize). 80x24 (classic terminal size) keeps scaled text comfortably readable in tiled panes.
  sessionEnv: {
    // Keep output on the main screen so xterm scrollback retains history.
    CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN: "1",
    // Mitigate the repaint-tearing artifact seen during streaming (spike finding).
    CLAUDE_CODE_ALT_SCREEN_FULL_REPAINT: "1",
  },
  // no automated gate by default (the two-step review is the gate); cap concurrent workers at 3;
  // the cron Scheduler is OFF by default (opt-in via config or LOOM_SCHEDULER_ENABLED=1)
  orchestration: { gateCommand: "", gateCommandTimeoutMs: 120000, deployCommand: "", deployCommandTimeoutMs: 120000, alertWebhookTimeoutMs: 5000, maxConcurrentWorkers: 3, maxConcurrentManagers: 3, maxConcurrentGates: 1, schedulerEnabled: false, recycleAtContextRatio: 0.80, recycleNudgeIntervalMinutes: 20, maxUnansweredRecycleNudges: 3, idleNudgeMinutes: 45, maxUnansweredNudges: 2, idleDefaultSnoozeMinutes: 30, idleWorkerMinutes: 45, stuckWorkerMinutes: 60, crashRecoveryMaxAttempts: 3 },
  // auto-backup on by default: snapshot loom.db on boot + hourly + before a self-host restart, keep 48
  backup: { intervalMinutes: 60, keep: 48, enabled: true },
  // daemon-global platform tuning defaults (rate-limit numbers, watcher cadences, op timeouts). These
  // mirror the hardcoded module consts at each call-site; the global override (resolveConfig's 2nd arg)
  // + LOOM_* watcher env layer beneath. See RateLimitConfig/WatcherConfig/TimeoutConfig for unit docs.
  platform: {
    rateLimit: { defaultBackoffMs: 18000000, resetBufferMs: 10000, deadlineAfterResetMs: 1800000, deadlineNoResetMs: 21600000, recencyWindowMs: 21600000, exhaustedThresholdPct: 95 },
    watchers: { contextWatchMs: 60000, idleWatchMs: 60000, rateLimitWatchMs: 60000, usagePollMs: 60000, wakeMs: 60000, schedulerMs: 60000, reconcileMs: 10000, snapshotMs: 420000, crashRecoveryWatchMs: 60000, pollMs: 60000 },
    timeouts: { gitOpMs: 15000, gitLocalMs: 15000, gitPushMs: 45000, provisionMs: 180000, busyStaleMs: 300000, runMs: 600000 },
    // P2 authenticated-request bounds: 20s timeout, 1MB response cap, 30 req/5min per connection.
    connections: { requestTimeoutMs: 20000, maxResponseBytes: 1000000, rateLimitMax: 30, rateLimitWindowMs: 300000 },
    // No DB path set for either tool by default — each resolver falls back to its own LOOM_*_BIN env var
    // (card 8dc5ebb9). Byte-identical-when-absent: an empty override here changes nothing vs. today.
    integrations: { openDesign: {}, codescape: {} },
    // Default false = deliver agent/human messages one-per-turn (the 2026-07-03 owner-directed fix).
    coalesceAgentMessages: false,
    // Default OFF (COMPANION_VOICE_ENABLED_DEFAULT) — companion voice provisioning is explicit opt-in.
    companionVoiceEnabled: COMPANION_VOICE_ENABLED_DEFAULT,
    // Default OFF (OPERATOR_ENABLED_DEFAULT) — the Bucket 2b Elevated Operator surface is explicit opt-in.
    operatorEnabled: OPERATOR_ENABLED_DEFAULT,
  },
  // Access-story Phase A: OFF + loopback by default — ships inert (see RemoteAccessConfig). The
  // rateLimit default is carried here too (Phase C) so it applies the moment a human flips `enabled`
  // without also having to specify tunables — harmless while disabled.
  remoteAccess: {
    enabled: false, bindHost: "127.0.0.1",
    rateLimit: { perIpPerMin: 120, perTokenPerMin: 120, authFailLockout: { maxAttempts: 5, windowMs: 600000, lockoutMs: 900000 } },
  },
  docLint: true, // Pillar D vault-lint hook on by default
  codescape: { enabled: false }, // opt-in Codescape MCP wiring (card C2) — off by default
  // Obsidian auto-start OFF by default: opt-in per project (a daemon-launched GUI process is deliberate).
  obsidian: { autoStart: false },
  // Python: no base-interpreter override by default — the daemon discovers python3/python/`py -3` on PATH.
  // Loom owns + provisions the shared venv on first use of a Python-backed capability (e.g. documentConversion).
  python: {},
  // Project-scoped shared memory (card 2fd9abf9): ~4000 tokens is generous for a handful of pinned notes
  // plus a sizeable related-tier slice without dominating a turn (mirrors MEMORY_RECALL_MAX_BYTES's
  // sizing rationale); topK 8 related notes considered per kickoff; maxNotes 500 unpinned notes per
  // project before LRU-by-retrieval eviction kicks in (small-corpus assumption from the design doc).
  memory: { budgetTokens: 4000, topK: 8, maxNotes: 500 },
  // Session-usage telemetry (epic c9924bcd): daemon-global sampler cadence (5m) + sample retention (90d).
  usageSampleIntervalMs: 300000,
  usageSampleRetentionDays: 90,
};

/**
 * Derive the session-env vars the vault preflight helper (`assets/scripts/ensure-obsidian.mjs`) reads
 * from a RESOLVED ObsidianConfig. Returns `{}` when `autoStart` is OFF (the default), so an off project's
 * resolved `sessionEnv` is BYTE-IDENTICAL to before this feature — additive-when-off, mirroring the
 * browserTesting discipline. When ON it emits `LOOM_OBSIDIAN_AUTOSTART=1` plus `LOOM_OBSIDIAN_PATH` when a
 * path override is set. (The daemon adds `LOOM_OBSIDIAN_PREFLIGHT` — the absolute helper path — at the
 * spawn seam, since that path is daemon-side and not knowable in browser-pure `shared`.)
 */
export function obsidianSessionEnv(o: ObsidianConfig): Record<string, string> {
  if (!o.autoStart) return {};
  const env: Record<string, string> = { LOOM_OBSIDIAN_AUTOSTART: "1" };
  if (o.path) env.LOOM_OBSIDIAN_PATH = o.path;
  return env;
}

/**
 * Carry the HUMAN-only base-Python override (`python.interpreterPath`) to the daemon's venv-provisioning
 * resolver via the EXISTING `sessionEnv` transport (mirrors `obsidianSessionEnv`). Emits
 * `LOOM_PYTHON_INTERPRETER` ONLY when an interpreter path is configured — otherwise `{}`, so a project that
 * never sets it has a BYTE-IDENTICAL resolved `sessionEnv` (additive-when-absent, the browserTesting
 * discipline). The daemon reads this off the session env at the spawn seam and hands it to the shared-venv
 * provisioner; it never widens the agent surface (the value is human-only by construction — the agent-facing
 * config validator rejects `python.interpreterPath`).
 */
export function pythonSessionEnv(p: PythonConfig): Record<string, string> {
  if (!p.interpreterPath) return {};
  return { LOOM_PYTHON_INTERPRETER: p.interpreterPath };
}

// --- Profiles: the resolved "who" ------------------------------------------------------

/**
 * The effective "who" for a session — an agent resolved against its (optional) Profile.
 * Sibling of ResolvedConfig: one shape the spawn path reads, produced by ONE resolver.
 */
export interface ResolvedProfile {
  /** Orchestration role; null = a plain session (today's default). */
  role: SessionRole | null;
  /** The startup prompt to inject on a NEW session — ALWAYS the agent's own prompt. */
  startupPrompt: string;
  /** Permission allowlist delta the profile contributes (layered onto the config allow at spawn). */
  allow: string[];
  /** Skill-name subset to deliver; null = deliver all (today's behavior). */
  skills: string[] | null;
  /** Model id to spawn with; null = engine default. */
  model: string | null;
  /** UI icon; null = none. */
  icon: string | null;
  /** Opt-in browser-automation: inject a per-session Playwright MCP at spawn. Backstops to false. */
  browserTesting: boolean;
  /** Opt-in document-conversion: inject a per-session markitdown MCP at spawn. Backstops to false. */
  documentConversion: boolean;
  /** Opt-in Open Design: inject a per-session OD MCP server at spawn iff OD resolves on this host.
   *  Backstops to false. Not gated by isLoomDev() (OD is public OSS). */
  openDesign: boolean;
  /** Restricted-tools: append the curated dangerous native tools to `--disallowedTools` at spawn
   *  (blast-radius control for a chat-reachable Companion). Backstops to false. */
  restrictedTools: boolean;
  /** Declared no-commit role: a read-only worker whose 0-commit done auto-retires + skips the
   *  forgot-to-commit warning. NO spawn-time effect (lifecycle-only). Backstops to false. */
  noCommit: boolean;
  /** Authenticated-egress connection-id allowlist for the `authenticated_request` tool. Backstops to
   *  `[]` (NOT "all" — the secure default direction, unlike `skills`). */
  connections: string[];
  /** Opt-in confined vault-write grant for the `vault_write` tool (loom-tasks MCP) — write-only, scoped
   *  to this session's OWN project vault root. Backstops to false. */
  vaultWrite: boolean;
  /**
   * Agent-tooling P4: the profile's OWN `capabilities` grants, a RAW passthrough — mirrors
   * `connections`/`skills` (no derived merging here). Backstops to `[]`. Deliberately does NOT fold in
   * the legacy `browserTesting`/`documentConversion` booleans (those stay separate fields on this same
   * shape, exactly as before) — the two are bridged into ONE iteration list in exactly one place,
   * `buildMcpServers` (host.ts), via {@link resolveProfileCapabilities}. Bridging here too would double
   * the legacy grants wherever both this field and the booleans are read together.
   */
  capabilities: CapabilityGrant[];
}

/** The permanently-reserved builtin capability slugs the legacy boolean flags bridge to (P4). */
export const LEGACY_CAPABILITY_SLUGS = { browserTesting: "browser-testing", documentConversion: "document-conversion", openDesign: "open-design" } as const;

/**
 * Bridge a profile/session's legacy `browserTesting`/`documentConversion` booleans + its
 * `capabilities` array into ONE resolved grant list (agent-tooling P4) — the back-compat seam that lets
 * `buildMcpServers` iterate a single list while every existing profile/session row (booleans set,
 * `capabilities` unset) keeps resolving to EXACTLY its pre-P4 grants, with zero data migration. Order:
 * legacy slots first (stable, matches today's mount order), then the
 * array verbatim. Called EXACTLY ONCE per resolution (buildMcpServers) — `capabilities` itself is never
 * pre-bridged (see the field doc above), so this is the only place legacy + new merge.
 */
export function resolveProfileCapabilities(p: { browserTesting?: boolean; documentConversion?: boolean; openDesign?: boolean; capabilities?: CapabilityGrant[] }): CapabilityGrant[] {
  const legacy: CapabilityGrant[] = [
    ...(p.browserTesting ? [{ slug: LEGACY_CAPABILITY_SLUGS.browserTesting }] : []),
    ...(p.documentConversion ? [{ slug: LEGACY_CAPABILITY_SLUGS.documentConversion }] : []),
    ...(p.openDesign ? [{ slug: LEGACY_CAPABILITY_SLUGS.openDesign }] : []),
  ];
  return [...legacy, ...(p.capabilities ?? [])];
}

/**
 * Resolve an agent + its (optional) Profile into the effective spawn shape — the sibling of
 * resolveConfig for the "who". Clean separation of jobs: the **injected startup prompt ALWAYS comes
 * from the agent** (`agent.startupPrompt ?? ""`; an empty prompt = a session that boots but is inert,
 * acceptable by design); the **profile supplies role/allow/skills/model/icon** — the rig. A profile
 * carries NO prompt (its `description` is a UI-only blurb), so there is no prompt-merge.
 *
 * A null/absent profile is the BACKSTOP — it yields EXACTLY today's plain behavior: a role-null
 * session, no allow delta / skill filter / model / icon, the agent's own prompt verbatim.
 */
export function resolveProfile(
  agent: { startupPrompt: string | null },
  profile?: Profile | null,
): ResolvedProfile {
  // The injected prompt is sourced from the agent regardless of whether a profile is present.
  const startupPrompt = agent.startupPrompt ?? "";
  if (!profile) {
    // The backstop: a null/absent profile confers NO browser/document capability (false) — today's behavior.
    return { role: null, startupPrompt, allow: [], skills: null, model: null, icon: null, browserTesting: false, documentConversion: false, openDesign: false, restrictedTools: false, noCommit: false, connections: [], vaultWrite: false, capabilities: [] };
  }
  return {
    role: profile.role ?? null,
    startupPrompt,
    allow: profile.allowDelta ?? [],
    skills: profile.skills ?? null,
    model: profile.model ?? null,
    icon: profile.icon ?? null,
    // Pass the flag through when the profile sets it; backstop false for an unset/absent flag.
    browserTesting: profile.browserTesting ?? false,
    documentConversion: profile.documentConversion ?? false,
    openDesign: profile.openDesign ?? false,
    // Restricted-tools (subtractive spawn effect: dangerous native tools → --disallowedTools). Backstop false.
    restrictedTools: profile.restrictedTools ?? false,
    // Declared no-commit role (lifecycle-only; no spawn-time effect). Backstop false.
    noCommit: profile.noCommit ?? false,
    // Authenticated-egress connection-id allowlist. Backstop [] (NOT "all" — the secure default).
    connections: profile.connections ?? [],
    // Confined vault-write grant for the vault_write tool. Backstop false.
    vaultWrite: profile.vaultWrite ?? false,
    // Registry-capability grants — RAW passthrough (see the field doc on ResolvedProfile). Backstop [].
    capabilities: profile.capabilities ?? [],
  };
}

/**
 * Read the LOOM_IDLE_NUDGE_MINUTES env override for the idle-watchdog leash (the only one of the new
 * orchestration keys with an env var). Returned at the platform-default layer of resolveConfig, so a
 * per-project override still wins. Returns undefined when unset / blank / non-numeric so the hardcoded
 * default applies; an explicit "0" is honored as a real value (0 disables the watcher) — which is why
 * we parse explicitly instead of the `Number(...) || default` idiom (that would swallow 0). Guarded
 * for `process`-less environments (shared is also bundled into the browser web app, which never sets
 * this var).
 */
function envIdleNudgeMinutes(): number | undefined {
  const raw = typeof process !== "undefined" ? process.env?.LOOM_IDLE_NUDGE_MINUTES : undefined;
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Read the LOOM_BACKUP_INTERVAL_MINUTES env override for the auto-backup periodic cadence. Returned
 * at the platform-default layer of resolveConfig (a per-project override still wins). Mirrors
 * envIdleNudgeMinutes: undefined when unset/blank/non-numeric so the hardcoded default applies, but an
 * explicit "0" IS honored as a real value (0 disables the periodic ticker). Guarded for `process`-less
 * environments (shared is also bundled into the browser web app, which never sets this var).
 */
function envBackupIntervalMinutes(): number | undefined {
  const raw = typeof process !== "undefined" ? process.env?.LOOM_BACKUP_INTERVAL_MINUTES : undefined;
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * §bounds watcher floor (ms): the minimum any watcher cadence may resolve to. The global override is
 * range-checked on the human path (task B's validator); but the LOOM_*_INTERVAL_MS ENV reads are not
 * validated anywhere, so we floor-clamp them HERE — a stray `LOOM_CONTEXT_WATCH_INTERVAL_MS=0` would
 * otherwise busy-loop the daemon. Mirrors the §bounds `watchers.* 5000–3600000` lower bound.
 */
const WATCHER_FLOOR_MS = 5000;

/**
 * Read a watcher-cadence `LOOM_*_INTERVAL_MS` env override (ms). Mirrors envIdleNudgeMinutes: undefined
 * when unset/blank/non-numeric so the layer beneath applies, and `process`-guarded (shared is bundled
 * into the browser, which never sets these). UNLIKE the minute helpers, an explicit "0" is NOT
 * swallowed at parse (so the env IS treated as set — `??` discipline) but is then FLOOR-CLAMPED to
 * WATCHER_FLOOR_MS so it can't busy-loop. Negatives clamp up too.
 */
function envWatcherIntervalMs(name: string): number | undefined {
  const raw = typeof process !== "undefined" ? process.env?.[name] : undefined;
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(n, WATCHER_FLOOR_MS);
}

/**
 * Resolve the daemon-global `platform` grouping. Per global value the precedence is
 * **global override ?? LOOM_* env ?? hardcoded default** — there is NO per-project layer for globals.
 * Only the watcher cadences have an env layer (floor-clamped); rateLimit + timeouts are override-or-default.
 * `??` (not `||`) so an explicit 0 in the override survives where it's meaningful (e.g. resetBufferMs).
 */
function resolvePlatform(po: PlatformConfigOverride | undefined): PlatformConfig {
  const d = PLATFORM_DEFAULTS.platform;
  return {
    rateLimit: {
      defaultBackoffMs: po?.rateLimit?.defaultBackoffMs ?? d.rateLimit.defaultBackoffMs,
      resetBufferMs: po?.rateLimit?.resetBufferMs ?? d.rateLimit.resetBufferMs,
      deadlineAfterResetMs: po?.rateLimit?.deadlineAfterResetMs ?? d.rateLimit.deadlineAfterResetMs,
      deadlineNoResetMs: po?.rateLimit?.deadlineNoResetMs ?? d.rateLimit.deadlineNoResetMs,
      recencyWindowMs: po?.rateLimit?.recencyWindowMs ?? d.rateLimit.recencyWindowMs,
      exhaustedThresholdPct: po?.rateLimit?.exhaustedThresholdPct ?? d.rateLimit.exhaustedThresholdPct,
    },
    watchers: {
      contextWatchMs: po?.watchers?.contextWatchMs ?? envWatcherIntervalMs("LOOM_CONTEXT_WATCH_INTERVAL_MS") ?? d.watchers.contextWatchMs,
      idleWatchMs: po?.watchers?.idleWatchMs ?? envWatcherIntervalMs("LOOM_IDLE_WATCH_INTERVAL_MS") ?? d.watchers.idleWatchMs,
      rateLimitWatchMs: po?.watchers?.rateLimitWatchMs ?? envWatcherIntervalMs("LOOM_RATE_LIMIT_WATCH_INTERVAL_MS") ?? d.watchers.rateLimitWatchMs,
      usagePollMs: po?.watchers?.usagePollMs ?? envWatcherIntervalMs("LOOM_USAGE_POLL_INTERVAL_MS") ?? d.watchers.usagePollMs,
      wakeMs: po?.watchers?.wakeMs ?? envWatcherIntervalMs("LOOM_WAKE_INTERVAL_MS") ?? d.watchers.wakeMs,
      schedulerMs: po?.watchers?.schedulerMs ?? envWatcherIntervalMs("LOOM_SCHEDULER_INTERVAL_MS") ?? d.watchers.schedulerMs,
      reconcileMs: po?.watchers?.reconcileMs ?? envWatcherIntervalMs("LOOM_RECONCILE_INTERVAL_MS") ?? d.watchers.reconcileMs,
      snapshotMs: po?.watchers?.snapshotMs ?? envWatcherIntervalMs("LOOM_SNAPSHOT_INTERVAL_MS") ?? d.watchers.snapshotMs,
      crashRecoveryWatchMs: po?.watchers?.crashRecoveryWatchMs ?? envWatcherIntervalMs("LOOM_CRASH_RECOVERY_WATCH_INTERVAL_MS") ?? d.watchers.crashRecoveryWatchMs,
      pollMs: po?.watchers?.pollMs ?? envWatcherIntervalMs("LOOM_POLL_INTERVAL_MS") ?? d.watchers.pollMs,
    },
    timeouts: {
      gitOpMs: po?.timeouts?.gitOpMs ?? d.timeouts.gitOpMs,
      gitLocalMs: po?.timeouts?.gitLocalMs ?? d.timeouts.gitLocalMs,
      gitPushMs: po?.timeouts?.gitPushMs ?? d.timeouts.gitPushMs,
      provisionMs: po?.timeouts?.provisionMs ?? d.timeouts.provisionMs,
      busyStaleMs: po?.timeouts?.busyStaleMs ?? d.timeouts.busyStaleMs,
      runMs: po?.timeouts?.runMs ?? d.timeouts.runMs,
    },
    connections: {
      requestTimeoutMs: po?.connections?.requestTimeoutMs ?? d.connections.requestTimeoutMs,
      maxResponseBytes: po?.connections?.maxResponseBytes ?? d.connections.maxResponseBytes,
      rateLimitMax: po?.connections?.rateLimitMax ?? d.connections.rateLimitMax,
      rateLimitWindowMs: po?.connections?.rateLimitWindowMs ?? d.connections.rateLimitWindowMs,
    },
    integrations: {
      openDesign: {
        path: po?.integrations?.openDesign?.path ?? d.integrations.openDesign.path,
        mcpConfig: po?.integrations?.openDesign?.mcpConfig ?? d.integrations.openDesign.mcpConfig,
      },
      codescape: { path: po?.integrations?.codescape?.path ?? d.integrations.codescape.path },
    },
    coalesceAgentMessages: po?.coalesceAgentMessages ?? d.coalesceAgentMessages,
    companionVoiceEnabled: po?.companionVoiceEnabled ?? d.companionVoiceEnabled,
    operatorEnabled: po?.operatorEnabled ?? d.operatorEnabled,
  };
}

/**
 * Resolve the daemon-global `remoteAccess` block. Mirrors `resolvePlatform`: global override ?? default,
 * no per-project layer, no env layer (this is a fresh Phase A surface with no legacy env var to honor).
 */
function resolveRemoteAccess(po: PlatformConfigOverride | undefined): RemoteAccessConfig {
  const d = PLATFORM_DEFAULTS.remoteAccess;
  const resolved: RemoteAccessConfig = {
    enabled: po?.remoteAccess?.enabled ?? d.enabled,
    bindHost: po?.remoteAccess?.bindHost ?? d.bindHost,
  };
  const tls = po?.remoteAccess?.tls ?? d.tls;
  if (tls !== undefined) resolved.tls = tls;
  const rateLimit = po?.remoteAccess?.rateLimit ?? d.rateLimit;
  if (rateLimit !== undefined) resolved.rateLimit = rateLimit;
  return resolved;
}

/**
 * The single config-resolution mechanism, reused everywhere. The optional 2nd arg `platformOverride`
 * is the daemon-GLOBAL tuning override (the daemon's SQLite singleton blob); absent → platform defaults
 * + LOOM_* env = today's behavior, so every existing single-arg caller is byte-identical.
 */
export function resolveConfig(
  override: ProjectConfigOverride | undefined,
  platformOverride?: PlatformConfigOverride,
): ResolvedConfig {
  const d = PLATFORM_DEFAULTS;
  // The LOOM_IDLE_NUDGE_MINUTES / LOOM_BACKUP_INTERVAL_MINUTES env overrides apply at the platform-
  // default layer, so they must be honored even on the no-override fast path (otherwise
  // `resolveConfig(undefined)` would ignore them).
  const envIdle = envIdleNudgeMinutes();
  const envBackup = envBackupIntervalMinutes();
  if (!override) {
    const base = structuredClone(d);
    if (envIdle !== undefined) base.orchestration.idleNudgeMinutes = envIdle;
    if (envBackup !== undefined) base.backup.intervalMinutes = envBackup;
    // schedulerEnabled is daemon-GLOBAL (like backup/platform below), so it's read off the platform
    // override even on this no-(project)-override fast path.
    base.orchestration.schedulerEnabled = platformOverride?.schedulerEnabled ?? d.orchestration.schedulerEnabled;
    // obsidian defaults OFF on this fast path → obsidianSessionEnv({autoStart:false}) is {} → base.sessionEnv
    // stays byte-identical to today (no injection). Nothing to do; left explicit for the next reader.
    // Daemon-global tuning still applies on the no-(project)-override fast path: the global override
    // (2nd arg) + LOOM_* watcher env layer beneath, so `resolveConfig(undefined, po)` honors them.
    base.platform = resolvePlatform(platformOverride);
    base.remoteAccess = resolveRemoteAccess(platformOverride);
    return base;
  }
  // Resolve the obsidian field (autoStart + optional path override), then derive its session-env so the
  // preflight helper reads it via the EXISTING sessionEnv transport. path is optional — only carried when set.
  const obsidian: ObsidianConfig = { autoStart: override.obsidian?.autoStart ?? d.obsidian.autoStart };
  const obsidianPath = override.obsidian?.path ?? d.obsidian.path;
  if (obsidianPath !== undefined) obsidian.path = obsidianPath;
  // Resolve the python field (only the optional base-interpreter override), then derive its session-env so
  // the venv-provisioning resolver reads it via the EXISTING sessionEnv transport (mirrors obsidian).
  const python: PythonConfig = {};
  const interpreterPath = override.python?.interpreterPath ?? d.python.interpreterPath;
  if (interpreterPath !== undefined) python.interpreterPath = interpreterPath;
  return {
    kanbanColumns: override.kanbanColumns ?? structuredClone(d.kanbanColumns),
    permission: {
      mode: override.permission?.mode ?? d.permission.mode,
      // UNION (not replace) the override allowlist onto the baseline, deduped + order-preserving. The
      // baseline allow (mcp__loom-tasks + git globs) is LOAD-BEARING — it stops the unattended
      // permission-prompt hang, and the spawn path does NOT re-add it. A project that customizes `allow`
      // to add one glob must keep the baseline, so we merge instead of substituting. When the override
      // sets no allow this is a deduped copy of the (duplicate-free) baseline = byte-identical to before.
      allow: [...new Set([...d.permission.allow, ...(override.permission?.allow ?? [])])],
      deny: override.permission?.deny ?? [...d.permission.deny],
      startupModeCycles: override.permission?.startupModeCycles ?? d.permission.startupModeCycles,
    },
    pty: {
      cols: override.pty?.cols ?? d.pty.cols,
      rows: override.pty?.rows ?? d.pty.rows,
    },
    // obsidian-derived env goes LAST so the dedicated `obsidian` config field is authoritative over a
    // manually-set sessionEnv key (when autoStart is OFF this spread is `{}` → byte-identical to before).
    sessionEnv: { ...d.sessionEnv, ...(override.sessionEnv ?? {}), ...obsidianSessionEnv(obsidian), ...pythonSessionEnv(python) },
    orchestration: {
      gateCommand: override.orchestration?.gateCommand ?? d.orchestration.gateCommand,
      // Per-project timeout pairing gateCommand (no env layer). `??` so an explicit value survives.
      gateCommandTimeoutMs: override.orchestration?.gateCommandTimeoutMs ?? d.orchestration.gateCommandTimeoutMs,
      // Scoped per-project deploy (mirrors gateCommand's resolution exactly).
      deployCommand: override.orchestration?.deployCommand ?? d.orchestration.deployCommand,
      // Per-project timeout pairing deployCommand (no env layer). `??` so an explicit value survives.
      deployCommandTimeoutMs: override.orchestration?.deployCommandTimeoutMs ?? d.orchestration.deployCommandTimeoutMs,
      // Optional + absent by default (d has none): the override value or undefined (no external delivery).
      alertWebhook: override.orchestration?.alertWebhook ?? d.orchestration.alertWebhook,
      // Per-project timeout pairing alertWebhook (no env layer). `??` so an explicit value survives.
      alertWebhookTimeoutMs: override.orchestration?.alertWebhookTimeoutMs ?? d.orchestration.alertWebhookTimeoutMs,
      maxConcurrentWorkers: override.orchestration?.maxConcurrentWorkers ?? d.orchestration.maxConcurrentWorkers,
      maxConcurrentManagers: override.orchestration?.maxConcurrentManagers ?? d.orchestration.maxConcurrentManagers,
      // Daemon-GLOBAL (no per-project layer, like backup/platform below): the platform override (2nd
      // arg) wins over the default. A stale per-project `orchestration.schedulerEnabled` (accepted
      // before this field moved to PlatformConfigOverride) is intentionally ignored here, not read.
      schedulerEnabled: platformOverride?.schedulerEnabled ?? d.orchestration.schedulerEnabled,
      // Host-load guard (card 301d8c01): daemon-GLOBAL like schedulerEnabled — a per-project override
      // is intentionally ignored here, not read (see the field's own doc for why host contention isn't
      // a per-project concern).
      maxConcurrentGates: platformOverride?.maxConcurrentGates ?? d.orchestration.maxConcurrentGates,
      recycleAtContextRatio: override.orchestration?.recycleAtContextRatio ?? d.orchestration.recycleAtContextRatio,
      // Context-recycle re-nudge cadence + escalation cap (per-project, no env layer). `??` so an explicit
      // value (incl. 0) survives the merge — mirrors maxUnansweredNudges below.
      recycleNudgeIntervalMinutes: override.orchestration?.recycleNudgeIntervalMinutes ?? d.orchestration.recycleNudgeIntervalMinutes,
      maxUnansweredRecycleNudges: override.orchestration?.maxUnansweredRecycleNudges ?? d.orchestration.maxUnansweredRecycleNudges,
      // Precedence: per-project override > LOOM_IDLE_NUDGE_MINUTES env > hardcoded default. `??` (not
      // `||`) so an explicit 0 at any layer is preserved (0 disables the watcher).
      idleNudgeMinutes: override.orchestration?.idleNudgeMinutes ?? envIdle ?? d.orchestration.idleNudgeMinutes,
      maxUnansweredNudges: override.orchestration?.maxUnansweredNudges ?? d.orchestration.maxUnansweredNudges,
      idleDefaultSnoozeMinutes: override.orchestration?.idleDefaultSnoozeMinutes ?? d.orchestration.idleDefaultSnoozeMinutes,
      // `??` (not `||`) so an explicit 0 (disables the idle-worker watcher) survives the merge.
      idleWorkerMinutes: override.orchestration?.idleWorkerMinutes ?? d.orchestration.idleWorkerMinutes,
      // `??` (not `||`) so an explicit 0 (disables the watcher) survives the merge.
      stuckWorkerMinutes: override.orchestration?.stuckWorkerMinutes ?? d.orchestration.stuckWorkerMinutes,
      // Crash-recovery auto-resume cap (0 disables the watcher). `??` so an explicit 0 survives.
      crashRecoveryMaxAttempts: override.orchestration?.crashRecoveryMaxAttempts ?? d.orchestration.crashRecoveryMaxAttempts,
    },
    // Daemon-global (no per-project override): platform default, with the env applying to the cadence
    // at this layer. `??` (not `||`) so an explicit env 0 is preserved (0 disables the periodic ticker).
    backup: {
      intervalMinutes: envBackup ?? d.backup.intervalMinutes,
      keep: d.backup.keep,
      enabled: d.backup.enabled,
    },
    // Daemon-global (no per-project layer): global override (2nd arg) ?? LOOM_* watcher env ?? default.
    platform: resolvePlatform(platformOverride),
    // Daemon-global (no per-project layer): global override (2nd arg) ?? default. See RemoteAccessConfig.
    remoteAccess: resolveRemoteAccess(platformOverride),
    docLint: override.docLint ?? d.docLint,
    codescape: { enabled: override.codescape?.enabled ?? d.codescape.enabled },
    obsidian,
    python,
    // Clamped to MEMORY_CONFIG_MAX (bounds hardening): an accidental memory_write-in-a-loop or a
    // pathological override/platform-default value can never bloat every kickoff or grow the DB unbounded.
    memory: {
      budgetTokens: Math.min(override.memory?.budgetTokens ?? d.memory.budgetTokens, MEMORY_CONFIG_MAX.budgetTokens),
      topK: Math.min(override.memory?.topK ?? d.memory.topK, MEMORY_CONFIG_MAX.topK),
      maxNotes: Math.min(override.memory?.maxNotes ?? d.memory.maxNotes, MEMORY_CONFIG_MAX.maxNotes),
    },
    // Daemon-global (no per-project layer): the session-usage sampler cadence + retention. Always the
    // platform default (HUMAN-only; not in ProjectConfigOverride, so an agent override can't reach them).
    usageSampleIntervalMs: d.usageSampleIntervalMs,
    usageSampleRetentionDays: d.usageSampleRetentionDays,
  };
}
