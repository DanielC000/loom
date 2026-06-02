// Config model: platform default -> per-project override, resolved through ONE merge fn.
// This is also the machine-writable schema phase-2 AI-driven project creation will target.

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
   * the gate-free boot default (`mode`) into the desired one. The spawn always boots in `mode`
   * (acceptEdits) to dodge the bypass-mode acceptance gate; this then steps it the way a human would.
   * Default 2 (acceptEdits → … → bypassPermissions in the current CLI). 0 = leave the boot mode.
   * Version-sensitive: tied to the CLI's Shift+Tab cycle order, so it's tunable here.
   */
  startupModeCycles?: number;
}

export interface PtyGeometry {
  cols: number;
  rows: number;
}

/** Phase-2 orchestration settings. */
export interface OrchestrationConfig {
  /**
   * Build/test command run in a worker's worktree before a merge (the build/DoD gate).
   * Empty string = no automated gate; at this stage the two-step manager review IS the gate.
   * (#17 will REQUIRE a non-empty gate before autonomy is enabled.)
   */
  gateCommand: string;
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
}

/** The fully-resolved, effective config for a project. */
export interface ResolvedConfig {
  kanbanColumns: KanbanColumn[];
  permission: PermissionPolicy;
  pty: PtyGeometry;
  /** Extra env applied to spawned sessions (merged over the spawn baseline). */
  sessionEnv: Record<string, string>;
  orchestration: OrchestrationConfig;
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
  docLint?: boolean;
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
  orchestration: { gateCommand: "", maxConcurrentWorkers: 3, maxConcurrentManagers: 3, schedulerEnabled: false, recycleAtContextRatio: 0.80 },
  docLint: true, // Pillar D vault-lint hook on by default
};

/** The single config-resolution mechanism, reused everywhere. */
export function resolveConfig(override: ProjectConfigOverride | undefined): ResolvedConfig {
  const d = PLATFORM_DEFAULTS;
  if (!override) return structuredClone(d);
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
      maxConcurrentWorkers: override.orchestration?.maxConcurrentWorkers ?? d.orchestration.maxConcurrentWorkers,
      maxConcurrentManagers: override.orchestration?.maxConcurrentManagers ?? d.orchestration.maxConcurrentManagers,
      schedulerEnabled: override.orchestration?.schedulerEnabled ?? d.orchestration.schedulerEnabled,
      recycleAtContextRatio: override.orchestration?.recycleAtContextRatio ?? d.orchestration.recycleAtContextRatio,
    },
    docLint: override.docLint ?? d.docLint,
  };
}
