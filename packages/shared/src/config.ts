// Config model: platform default -> per-project override, resolved through ONE merge fn.
// This is also the machine-writable schema phase-2 AI-driven project creation will target.
import type { Profile, SessionRole, OrchestrationEventKind } from "./types.js";

export interface KanbanColumn {
  key: string;
  label: string;
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
   * Asleep-at-the-Wheel idle-manager watchdog (FOUNDATION ONLY — nothing reads this yet; the
   * IdleWatcher ticker is a later task). Minutes a LIVE manager may sit idle (busy=false, no live
   * workers, not snoozed/suppressed) before the watcher nudges it once. Default 45; 0 disables the
   * watcher entirely. Env LOOM_IDLE_NUDGE_MINUTES sets the platform default here (a per-project
   * override still wins). Sibling of recycleAtContextRatio.
   */
  idleNudgeMinutes: number;
  /**
   * Idle watchdog escalation cap: after this many CONSECUTIVE unanswered idle nudges (no idle_report
   * and no new orchestration activity) the watcher backs off and escalates to the human (policy →
   * suppressed) instead of nudging into the void. Default 2. (Foundation only — unread for now.)
   */
  maxUnansweredNudges: number;
  /**
   * Idle watchdog snooze fallback: minutes to snooze when a manager reports `waiting` WITHOUT an
   * explicit `minutes`. Default 30. (Foundation only — unread for now.) NOTE: the design note
   * specifies this key but gives no number; 30 chosen as a conservative re-check interval — the
   * manager can always pass explicit `minutes` for a longer wait. Confirm/adjust when wiring.
   */
  idleDefaultSnoozeMinutes: number;
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
 * Daemon-global "platform" tuning grouping: rate-limit numbers, watcher cadences, operation timeouts.
 * NOT per-project — like `backup`/`schedulerEnabled`, the daemon shares ONE of these. The daemon
 * supplies an optional global override (its SQLite-persisted singleton blob) as the 2nd arg to
 * `resolveConfig`; `shared` itself stays browser-pure and only reads `process`-guarded `LOOM_*` env.
 */
export interface PlatformConfig {
  rateLimit: RateLimitConfig;
  watchers: WatcherConfig;
  timeouts: TimeoutConfig;
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
   * Pillar D: wire the mechanical vault-lint PostToolUse hook into this project's sessions
   * (flags doc-hygiene anti-patterns on .md vault writes). Default true; set false to disable.
   */
  docLint: boolean;
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
}

export const PLATFORM_DEFAULTS: ResolvedConfig = {
  kanbanColumns: [
    { key: "backlog", label: "Backlog" },
    { key: "todo", label: "To Do" },
    { key: "in_progress", label: "In Progress" },
    { key: "waiting", label: "Waiting" },
    { key: "review", label: "Review" },
    { key: "done", label: "Done" },
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
  orchestration: { gateCommand: "", gateCommandTimeoutMs: 120000, alertWebhookTimeoutMs: 5000, maxConcurrentWorkers: 3, maxConcurrentManagers: 3, schedulerEnabled: false, recycleAtContextRatio: 0.80, idleNudgeMinutes: 45, maxUnansweredNudges: 2, idleDefaultSnoozeMinutes: 30 },
  // auto-backup on by default: snapshot loom.db on boot + hourly + before a self-host restart, keep 48
  backup: { intervalMinutes: 60, keep: 48, enabled: true },
  // daemon-global platform tuning defaults (rate-limit numbers, watcher cadences, op timeouts). These
  // mirror the hardcoded module consts at each call-site; the global override (resolveConfig's 2nd arg)
  // + LOOM_* watcher env layer beneath. See RateLimitConfig/WatcherConfig/TimeoutConfig for unit docs.
  platform: {
    rateLimit: { defaultBackoffMs: 18000000, resetBufferMs: 10000, deadlineAfterResetMs: 1800000, deadlineNoResetMs: 21600000, recencyWindowMs: 21600000 },
    watchers: { contextWatchMs: 60000, idleWatchMs: 60000, rateLimitWatchMs: 60000, usagePollMs: 60000, wakeMs: 60000, schedulerMs: 60000, reconcileMs: 10000 },
    timeouts: { gitOpMs: 15000, gitLocalMs: 15000, gitPushMs: 45000, provisionMs: 180000, busyStaleMs: 300000, runMs: 600000 },
  },
  docLint: true, // Pillar D vault-lint hook on by default
};

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
    // The backstop: a null/absent profile confers NO browser capability (false) — today's behavior.
    return { role: null, startupPrompt, allow: [], skills: null, model: null, icon: null, browserTesting: false };
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
    },
    watchers: {
      contextWatchMs: po?.watchers?.contextWatchMs ?? envWatcherIntervalMs("LOOM_CONTEXT_WATCH_INTERVAL_MS") ?? d.watchers.contextWatchMs,
      idleWatchMs: po?.watchers?.idleWatchMs ?? envWatcherIntervalMs("LOOM_IDLE_WATCH_INTERVAL_MS") ?? d.watchers.idleWatchMs,
      rateLimitWatchMs: po?.watchers?.rateLimitWatchMs ?? envWatcherIntervalMs("LOOM_RATE_LIMIT_WATCH_INTERVAL_MS") ?? d.watchers.rateLimitWatchMs,
      usagePollMs: po?.watchers?.usagePollMs ?? envWatcherIntervalMs("LOOM_USAGE_POLL_INTERVAL_MS") ?? d.watchers.usagePollMs,
      wakeMs: po?.watchers?.wakeMs ?? envWatcherIntervalMs("LOOM_WAKE_INTERVAL_MS") ?? d.watchers.wakeMs,
      schedulerMs: po?.watchers?.schedulerMs ?? envWatcherIntervalMs("LOOM_SCHEDULER_INTERVAL_MS") ?? d.watchers.schedulerMs,
      reconcileMs: po?.watchers?.reconcileMs ?? envWatcherIntervalMs("LOOM_RECONCILE_INTERVAL_MS") ?? d.watchers.reconcileMs,
    },
    timeouts: {
      gitOpMs: po?.timeouts?.gitOpMs ?? d.timeouts.gitOpMs,
      gitLocalMs: po?.timeouts?.gitLocalMs ?? d.timeouts.gitLocalMs,
      gitPushMs: po?.timeouts?.gitPushMs ?? d.timeouts.gitPushMs,
      provisionMs: po?.timeouts?.provisionMs ?? d.timeouts.provisionMs,
      busyStaleMs: po?.timeouts?.busyStaleMs ?? d.timeouts.busyStaleMs,
      runMs: po?.timeouts?.runMs ?? d.timeouts.runMs,
    },
  };
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
    // Daemon-global tuning still applies on the no-(project)-override fast path: the global override
    // (2nd arg) + LOOM_* watcher env layer beneath, so `resolveConfig(undefined, po)` honors them.
    base.platform = resolvePlatform(platformOverride);
    return base;
  }
  return {
    kanbanColumns: override.kanbanColumns ?? structuredClone(d.kanbanColumns),
    permission: {
      mode: override.permission?.mode ?? d.permission.mode,
      allow: override.permission?.allow ?? [...d.permission.allow],
      deny: override.permission?.deny ?? [...d.permission.deny],
      startupModeCycles: override.permission?.startupModeCycles ?? d.permission.startupModeCycles,
    },
    pty: {
      cols: override.pty?.cols ?? d.pty.cols,
      rows: override.pty?.rows ?? d.pty.rows,
    },
    sessionEnv: { ...d.sessionEnv, ...(override.sessionEnv ?? {}) },
    orchestration: {
      gateCommand: override.orchestration?.gateCommand ?? d.orchestration.gateCommand,
      // Per-project timeout pairing gateCommand (no env layer). `??` so an explicit value survives.
      gateCommandTimeoutMs: override.orchestration?.gateCommandTimeoutMs ?? d.orchestration.gateCommandTimeoutMs,
      // Optional + absent by default (d has none): the override value or undefined (no external delivery).
      alertWebhook: override.orchestration?.alertWebhook ?? d.orchestration.alertWebhook,
      // Per-project timeout pairing alertWebhook (no env layer). `??` so an explicit value survives.
      alertWebhookTimeoutMs: override.orchestration?.alertWebhookTimeoutMs ?? d.orchestration.alertWebhookTimeoutMs,
      maxConcurrentWorkers: override.orchestration?.maxConcurrentWorkers ?? d.orchestration.maxConcurrentWorkers,
      maxConcurrentManagers: override.orchestration?.maxConcurrentManagers ?? d.orchestration.maxConcurrentManagers,
      schedulerEnabled: override.orchestration?.schedulerEnabled ?? d.orchestration.schedulerEnabled,
      recycleAtContextRatio: override.orchestration?.recycleAtContextRatio ?? d.orchestration.recycleAtContextRatio,
      // Precedence: per-project override > LOOM_IDLE_NUDGE_MINUTES env > hardcoded default. `??` (not
      // `||`) so an explicit 0 at any layer is preserved (0 disables the watcher).
      idleNudgeMinutes: override.orchestration?.idleNudgeMinutes ?? envIdle ?? d.orchestration.idleNudgeMinutes,
      maxUnansweredNudges: override.orchestration?.maxUnansweredNudges ?? d.orchestration.maxUnansweredNudges,
      idleDefaultSnoozeMinutes: override.orchestration?.idleDefaultSnoozeMinutes ?? d.orchestration.idleDefaultSnoozeMinutes,
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
    docLint: override.docLint ?? d.docLint,
  };
}
