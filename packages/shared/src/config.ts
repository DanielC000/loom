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
 * per-profile. Gated ADDITIONALLY behind the daemon-wide `isCodescapeSupervisorEnabled()` (card 503a30a0:
 * `isLoomDev()` AND a codescape CLI actually detected present on the host — a private internal tool, never
 * a hand-set env toggle) — this flag alone never wires anything on a regular `loomctl` build (no host on a
 * vanilla install ever has the CLI). Benign on/off boolean (no host-launch capability of its own — it only
 * conditionally mounts an HTTP MCP entry pointing at the ALREADY-running daemon-owned supervisor).
 *
 * Type-only here (card 3bd8ef17): the runtime default+merge for this shape lives in
 * `resolveCodescapeConfig` below, deliberately OUTSIDE `ResolvedConfig`/`resolveConfig()` — that function
 * is what `packages/web` calls client-side (Settings/ColumnManager/Companion effective-value hints), and
 * `PLATFORM_DEFAULTS`'s literal keys ship verbatim into the built browser bundle whenever they're part of
 * that object. Codescape is a PRIVATE product end-user agents must never learn exists (project memory
 * `codescape-is-private-no-user-visible-surface`) — packages/web MUST NEVER import `resolveCodescapeConfig`
 * or `resolveCodescapeIntegrationPath`.
 */
export interface CodescapeConfig {
  enabled: boolean;
}

/**
 * DAEMON-ONLY resolver for the per-project `codescape.enabled` opt-in (see `CodescapeConfig`'s doc for
 * why this is deliberately NOT folded into `resolveConfig()`). `override` is the project's raw
 * config-override object (the same value a caller would otherwise pass to `resolveConfig()`) — reading
 * `codescape` off it directly here, rather than off a `ResolvedConfig` result, is what keeps the
 * `codescape` property key out of any code path `packages/web` pulls in. Mirrors `resolveConfig()`'s own
 * `??` default-merge discipline. `packages/web` must never import this.
 *
 * Typed as `unknown` (not `ProjectConfigOverride`, which deliberately no longer declares `codescape` —
 * see above): any caller's real `ProjectConfigOverride`-typed variable is still accepted unchanged
 * (anything is assignable to `unknown`), while the raw shape read inside stays independent of that
 * type's declared fields.
 */
export function resolveCodescapeConfig(override?: unknown): CodescapeConfig {
  const raw = override as { codescape?: Partial<CodescapeConfig> } | undefined;
  return { enabled: raw?.codescape?.enabled ?? false };
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

/**
 * Sweep G3: merge-gate retry policy (promoted from gate-runner.ts's module-load
 * `GATE_RETRY_ENABLED`/`GATE_RETRY_SETTLE_MS` constants, card bcba83a1's env-overridable knob) — whether
 * the merge gate auto-retries ONCE on a transient-kill classification (see `classifyGateFailure` in
 * gate-runner.ts) before reporting a rejection, and the settle delay before that retry. See
 * OrchestrationConfig.gateRetry for the resolution precedence.
 */
export interface GateRetryConfig {
  /** Master on/off for the one-time auto-retry. Default true. */
  enabled: boolean;
  /** Settle delay (ms) before the retry, giving transient memory pressure a chance to clear. Default 5000. */
  settleMs: number;
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
   * Safety rail (§19a hardening, narrowed by card 53edd8d5): hard cap on concurrently-LIVE manager
   * sessions the cron Scheduler ITSELF has spawned — counted via `Db.countLiveScheduledManagers`
   * (`Session.scheduledSpawn`), NOT the daemon-wide live-manager count. Standing human/Lead-spawned
   * managers do NOT count against this cap and can never block a cadence, however large the standing
   * fleet grows — only OTHER scheduler-spawned managers compete for this budget. maxConcurrentWorkers
   * caps workers PER manager; this caps the Scheduler's OWN concurrent manager spawns, so a burst of
   * simultaneously-due schedules can't launch an unbounded fleet in one tick. At the cap the Scheduler
   * defers the remaining due schedules to the next tick (next_fire_at untouched; the deferral is
   * recorded on the schedule row + a `schedule_fire_deferred` event — see Schedule.lastDeferredAt).
   * Default 3.
   *
   * **Fleet-wide since card 52ab5d45**: the Scheduler is ONE daemon-wide service (never scoped to a
   * project), so the value that actually reaches it comes only from the daemon-global
   * `PlatformConfigOverride.maxConcurrentManagers` (see the merge below, which mirrors
   * `maxConcurrentGates`'s daemon-global resolution) — a per-project override of THIS field is still
   * accepted by the per-project schema for backward compat, but is NOT read by the merge and has no
   * effect on the Scheduler.
   */
  maxConcurrentManagers: number;
  /**
   * Sweep G2 (mirrors maxConcurrentManagers/card 52ab5d45 exactly): daemon-GLOBAL fleet-wide cap on
   * concurrently-LIVE, SCHEDULER-SPAWNED auditor sessions (the dev Platform Auditor + the end-user
   * Workspace Auditor — `Db.countLiveAuditors`), a SEPARATE small budget from `maxConcurrentManagers` so
   * a fired auditor never consumes a manager slot and is never blocked by a full manager cap (and vice
   * versa; see `orchestration/scheduler.ts`'s AUDITOR BUDGET doc). Unlike `maxConcurrentManagers`, this
   * field never had a per-project predecessor, so the per-project schema does not accept it at all (like
   * `schedulerEnabled`/`maxConcurrentGates`) — the value that reaches the Scheduler comes only from the
   * daemon-global `PlatformConfigOverride.maxConcurrentAuditors`. Boot-bound like maxConcurrentManagers:
   * the Scheduler is constructed ONCE at boot (index.ts) and never re-reads this afterward, so a change
   * here needs a daemon restart to take effect. Default 2 (ZERO behavior change from today's
   * DEFAULT_MAX_CONCURRENT_AUDITORS constant in scheduler.ts).
   */
  maxConcurrentAuditors: number;
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
   * Sweep G3: merge-gate retry policy (see GateRetryConfig) — promoted from gate-runner.ts's module-load
   * `GATE_RETRY_ENABLED`/`GATE_RETRY_SETTLE_MS` constants to a LIVE-resolvable daemon-global config, so a
   * change takes effect on the very next gate retry with no daemon restart (mirrors `maxConcurrentGates`
   * immediately above — re-read fresh at the SAME confirmWorkerMerge call site; see gate-semaphore.ts's
   * own "cap read fresh per call" doc for the pattern this copies). Daemon-GLOBAL like maxConcurrentGates
   * — NOT a per-project setting (ProjectConfigOverride.orchestration deliberately omits it); the value
   * comes only from the daemon-global PlatformConfigOverride.gateRetry ?? the LOOM_GATE_RETRY_* env vars
   * (kept as a lower-priority CI/ops escape hatch, mirroring the watchers.*Ms precedent) ?? these
   * defaults (enabled:true, settleMs:5000 — zero behavior change from the old constants).
   */
  gateRetry: GateRetryConfig;
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
   * /loom-session-end, write a continuation prompt, call recycle_me). Agent-confirmed — the watcher only
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
  /**
   * Card c1f2f095 — the BASENAME of this project's manager resume doc, resolved against the project's
   * `vaultPath` (via `resolveResumeDocPath`, `daemon/sessions/resume-doc-notes.ts`) into the ABSOLUTE
   * path injected into every manager's "Where things live" spawn/recycle block AND checked by
   * `ResumeDocWatcher` — ONE resolution both sites share, so they can never derive two different
   * answers. Default `"Orchestrator Log.md"` (Loom's own convention) preserves today's behavior for
   * every project that doesn't override it. A project whose real doc uses a different filename (e.g.
   * a translated/renamed title) sets this so the daemon-injected path is actually authoritative,
   * instead of a hand-written "Resume doc:" prompt line drifting from the real file on disk.
   * Benign string (no host-launch/exfil capability) — stays on the agent-facing config path, but is
   * validated there as a STRICT BARE FILENAME (no path separators, no `..`) precisely because it's a
   * PATH COMPONENT the daemon then vouches for as authoritative in a TRUSTED prompt block; an
   * unvalidated value could otherwise be used to make a cold successor Read+trust an arbitrary host
   * file as its handoff state. See the validator in `daemon/mcp/platform.ts` and the defense-in-depth
   * vault-containment check in `resolveResumeDocPath`.
   */
  resumeDocFilename: string;
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
 * Codescape's integration config: PATH-only. The codescape supervisor (`codescape/supervisor.ts`
 * `resolveCodescapeBin`) resolves this `path` (DB override → `LOOM_CODESCAPE_BIN` → a bare
 * PATH-resolvable default name) only to spawn `ingest`/`serve` — the per-session MCP mount (P4 wiring,
 * card 088afc94) is a streamable-HTTP URL built from the manifest + the supervisor's live port
 * (`codescapeHttpMcpServer`, pty/host.ts), never a bin path. So an `mcpConfig`-shaped field is REJECTED at
 * validation (`mcp/platform.ts`'s `codescapeIntegrationOverride`) rather than silently accepted-and-ignored.
 */
export interface CodescapeIntegrationConfig {
  path?: string;
}

/**
 * DAEMON-ONLY resolver for the daemon-global `integrations.codescape.path` override — same reasoning as
 * `resolveCodescapeConfig` above (kept out of `PlatformConfig`/`resolveConfig()` so the literal key never
 * reaches the browser bundle `packages/web` pulls `resolveConfig()` into). `packages/web` must never
 * import this. Typed as `unknown` for the same reason as `resolveCodescapeConfig`'s param — see its doc.
 */
export function resolveCodescapeIntegrationPath(platformOverride?: unknown): string | undefined {
  const raw = platformOverride as { integrations?: { codescape?: CodescapeIntegrationConfig } } | undefined;
  return raw?.integrations?.codescape?.path;
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
  // NOTE: no `integrations` key here (card 3bd8ef17) — same reasoning as `ResolvedConfig`'s dropped
  // `codescape` field just above: `PlatformConfig` flows through `resolveConfig()`, which `packages/web`
  // calls client-side, so any field here ships into the browser bundle. See `resolveCodescapeIntegrationPath`.
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
  // NOTE: no `codescape` key here (card 3bd8ef17) — deliberately NOT part of `ResolvedConfig`/
  // `resolveConfig()`, which `packages/web` calls client-side (Settings/ColumnManager/Companion effective-
  // value hints) and which therefore ships whatever `PLATFORM_DEFAULTS` contains into the browser bundle.
  // Codescape is a PRIVATE product end-user agents must never learn exists (project memory
  // `codescape-is-private-no-user-visible-surface`) — see `resolveCodescapeConfig` below, the DAEMON-ONLY
  // equivalent that `packages/web` must never import.
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
  /**
   * Sweep G6: poll cadence (ms) for the daemon's periodic npm-registry "update available" check
   * (`UpdateCheckWatcher`, update/check.ts). DAEMON-GLOBAL + HUMAN-only, like `usageSampleIntervalMs`
   * above (not in ProjectConfigOverride). Precedence: platform override ?? LOOM_UPDATE_CHECK_INTERVAL_MS
   * env ?? hardcoded default. Default 21600000 (6h). Boot-bound: UpdateCheckWatcher is constructed ONCE
   * at boot, so a change needs a daemon restart to take effect.
   */
  updateCheckIntervalMs: number;
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
  // NOTE: no `codescape` key here either (card 3bd8ef17) — see `resolveCodescapeConfig`'s doc. The DB
  // still persists an agent-set `codescape.enabled` on the project's raw config JSON (mcp/platform.ts's
  // `projectConfigOverrideSchema` validates it independently of this type); `resolveCodescapeConfig`
  // reads it straight off that raw object, never through this typed interface.
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
  /**
   * Sweep G4: daemon-global auto-backup tuning (see ResolvedConfig.backup / BackupConfig) — deep-partial,
   * same shape as rateLimit/watchers/timeouts above, so tuning one field (e.g. `keep`) inherits the rest.
   * `intervalMinutes` also has an env layer (LOOM_BACKUP_INTERVAL_MINUTES); precedence is this override ??
   * the env var ?? the hardcoded default (mirrors the watcher cadences). `keep`/`enabled` have no env
   * layer. Boot-bound: DbBackupWatcher (the periodic ticker) is constructed ONCE at boot, so a change here
   * needs a daemon restart to take effect on the ticker — but see the `resolveBackupConfig` doc for the
   * ONE call site (the pre-migration boot snapshot) that structurally CANNOT consult this override at all
   * (it fires before the Db that stores it is even open).
   */
  backup?: Partial<BackupConfig>;
  /**
   * Sweep G3: see OrchestrationConfig.gateRetry. Daemon-GLOBAL, deep-partial group like `backup` above —
   * tuning one field (e.g. `settleMs`) inherits the other via the SAME field-by-field PATCH merge
   * (server.ts's `DEEP_MERGE_GROUPS`). UNLIKE `backup` (resolved onto ResolvedConfig.backup, a top-level
   * key), this resolves onto `ResolvedConfig.orchestration.gateRetry` — the same cross-nesting
   * `maxConcurrentGates` already does (override lives top-level here, resolves under `orchestration`)
   * because that's where the merge-gate retry call site already reads its sibling config
   * (`orchestration.gateCommandTimeoutMs`/`orchestration.maxConcurrentGates`). `enabled`/`settleMs` each
   * also have a LOOM_GATE_RETRY_* env layer beneath this override (mirrors backup.intervalMinutes's
   * precedence: override ?? env ?? default).
   */
  gateRetry?: Partial<GateRetryConfig>;
  /** See PlatformConfig.connections. */
  connections?: Partial<ConnectionsGuardConfig>;
  // NOTE: no `integrations` key here (card 3bd8ef17) — see `resolveCodescapeIntegrationPath`'s doc. The
  // DB still persists a human-set `integrations.codescape.path` on the platform config JSON
  // (mcp/platform.ts's `platformConfigOverrideSchema` validates it independently of this type);
  // `resolveCodescapeIntegrationPath` reads it straight off that raw object, never through this interface.
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
  /**
   * See OrchestrationConfig.maxConcurrentManagers. Daemon-GLOBAL fleet-wide cap on the cron
   * Scheduler's OWN concurrent manager spawns (card 52ab5d45), mirroring maxConcurrentGates's shape —
   * NOT a per-project setting. UNLIKE maxConcurrentGates (re-read live on every gate run), the
   * Scheduler is constructed ONCE at boot (index.ts) and never re-reads this afterward, so a change
   * here needs a daemon restart to take effect. Default 3 (ZERO behavior change from today's
   * PLATFORM_DEFAULTS value).
   */
  maxConcurrentManagers?: number;
  /**
   * See OrchestrationConfig.maxConcurrentAuditors (sweep G2, mirrors maxConcurrentManagers/card
   * 52ab5d45's shape). Daemon-GLOBAL SEPARATE budget for the cron Scheduler's own auditor spawns — NOT
   * a per-project setting, and unlike maxConcurrentManagers there is no per-project predecessor to stay
   * backward-compatible with. Boot-bound like maxConcurrentManagers: the Scheduler is constructed ONCE
   * at boot and never re-reads this afterward. Default 2 (ZERO behavior change from today's
   * DEFAULT_MAX_CONCURRENT_AUDITORS constant).
   */
  maxConcurrentAuditors?: number;
  /**
   * Sweep G5 (fixes a doc/code mismatch): see ResolvedConfig.usageSampleIntervalMs. Daemon-GLOBAL, no
   * per-project layer — the field's own doc already claimed this override was consulted; `resolveConfig`
   * previously never actually read it (always the hardcoded default). Boot-bound: the UsageSampler is
   * constructed ONCE at boot, so a change here needs a daemon restart to take effect.
   */
  usageSampleIntervalMs?: number;
  /** Sweep G5 (fixes a doc/code mismatch): see ResolvedConfig.usageSampleRetentionDays. Same daemon-
   *  global, boot-bound, previously-unconsulted-despite-its-doc shape as usageSampleIntervalMs above. */
  usageSampleRetentionDays?: number;
  /**
   * Sweep G6: see UpdateCheckWatcher / update/check.ts's DEFAULT_INTERVAL_MS. Daemon-GLOBAL poll cadence
   * for the npm-registry "update available" check, no per-project layer. Also has an env layer
   * (LOOM_UPDATE_CHECK_INTERVAL_MS); precedence is this override ?? the env var ?? the hardcoded default
   * (mirrors backup.intervalMinutes above). Boot-bound: UpdateCheckWatcher is constructed ONCE at boot.
   */
  updateCheckIntervalMs?: number;
}

/**
 * One bounded entry in `platform_config`'s change history (card db1e3503): the top-level keys that
 * changed in a single write, their prior + resulting values (JSON-comparable, scoped to just the changed
 * keys — not a full-blob snapshot), who wrote it where the write surface knows ("human" today — the human
 * REST PATCH is `platform_config`'s only write surface), and when. `Db.listPlatformConfigHistory` returns
 * these newest-first, capped to a bounded ring buffer — see `Db.recordPlatformConfigChange`.
 */
export interface PlatformConfigHistoryEntry {
  id: string;
  changedKeys: string[];
  prior: Record<string, unknown>;
  next: Record<string, unknown>;
  actor: string;
  createdAt: string;
}

/** Every field of `T` individually nullable — the per-field clear sentinel a `PlatformConfigPatch`
 *  ms-keyed group accepts (card ba9ccd75): `null` on one field clears just that field, omitting a
 *  field leaves it alone, distinct from the WHOLE-GROUP `null` (below) that clears the entire group. */
type NullableFields<T> = { [K in keyof T]?: T[K] | null };

/**
 * The wire body for `PATCH /api/platform/config` (card fd55ac8a, widened by card ba9ccd75): identical to
 * `PlatformConfigOverride` except the top-level keys the Settings global-config form can blank back to
 * "inherit" — the 5 scalar toggles (`schedulerEnabled`/`operatorEnabled`/`coalesceAgentMessages`/
 * `maxConcurrentGates`/`maxConcurrentManagers`) and the 3 ms-keyed sub-groups its field grid writes to
 * (`rateLimit`/`watchers`/`timeouts`) — also accept an explicit `null`. Whole-group `null` is the CLEAR sentinel: "delete this
 * key from the stored override, revert to the resolved default". Within a submitted group object, each
 * field is ALSO individually nullable (card ba9ccd75): a per-field `null` clears just that field, while
 * an OMITTED field (whether at the top level or nested inside a submitted group) means "not being
 * edited, leave whatever is already persisted alone" — the PATCH handler DEEP-merges these 3 groups onto
 * the persisted override, so "omitted = leave alone" now holds uniformly at both levels. Every other key
 * (`connections`/`integrations`/`remoteAccess`/`companionVoiceEnabled`) has no client-facing
 * blank-to-inherit control today, so it keeps its plain optional (present-or-absent) shape here too.
 */
export type PlatformConfigPatch = Omit<
  PlatformConfigOverride,
  "rateLimit" | "watchers" | "timeouts" | "backup" | "gateRetry" | "coalesceAgentMessages" | "operatorEnabled" | "schedulerEnabled" | "maxConcurrentGates" | "maxConcurrentManagers" | "maxConcurrentAuditors" | "usageSampleIntervalMs" | "usageSampleRetentionDays" | "updateCheckIntervalMs"
> & {
  rateLimit?: NullableFields<RateLimitConfig> | null;
  watchers?: NullableFields<WatcherConfig> | null;
  timeouts?: NullableFields<TimeoutConfig> | null;
  backup?: NullableFields<BackupConfig> | null;
  gateRetry?: NullableFields<GateRetryConfig> | null;
  coalesceAgentMessages?: boolean | null;
  operatorEnabled?: boolean | null;
  schedulerEnabled?: boolean | null;
  maxConcurrentGates?: number | null;
  maxConcurrentManagers?: number | null;
  maxConcurrentAuditors?: number | null;
  usageSampleIntervalMs?: number | null;
  usageSampleRetentionDays?: number | null;
  updateCheckIntervalMs?: number | null;
};

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
  orchestration: { gateCommand: "", gateCommandTimeoutMs: 120000, deployCommand: "", deployCommandTimeoutMs: 120000, alertWebhookTimeoutMs: 5000, maxConcurrentWorkers: 3, maxConcurrentManagers: 3, maxConcurrentAuditors: 2, maxConcurrentGates: 1, gateRetry: { enabled: true, settleMs: 5000 }, schedulerEnabled: false, recycleAtContextRatio: 0.80, recycleNudgeIntervalMinutes: 20, maxUnansweredRecycleNudges: 3, idleNudgeMinutes: 45, maxUnansweredNudges: 2, idleDefaultSnoozeMinutes: 30, idleWorkerMinutes: 45, stuckWorkerMinutes: 60, crashRecoveryMaxAttempts: 3, resumeDocFilename: "Orchestrator Log.md" },
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
    // NOTE: no `integrations` key here (card 3bd8ef17) — deliberately kept off `PLATFORM_DEFAULTS`, which
    // `packages/web` pulls into the browser bundle via `resolveConfig()`. See `resolveCodescapeIntegrationPath`.
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
  // NOTE: no `codescape` key here (card 3bd8ef17) — deliberately kept off `PLATFORM_DEFAULTS`/
  // `ResolvedConfig`, which `packages/web` pulls into the browser bundle via `resolveConfig()`. The
  // per-project opt-in defaults to off via `resolveCodescapeConfig`'s own `?? false`, not this object.
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
  updateCheckIntervalMs: 21600000, // 6h — matches update/check.ts's DEFAULT_INTERVAL_MS (zero behavior change)
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
export const LEGACY_CAPABILITY_SLUGS = { browserTesting: "browser-testing", documentConversion: "document-conversion" } as const;

/**
 * Bridge a profile/session's legacy `browserTesting`/`documentConversion` booleans + its
 * `capabilities` array into ONE resolved grant list (agent-tooling P4) — the back-compat seam that lets
 * `buildMcpServers` iterate a single list while every existing profile/session row (booleans set,
 * `capabilities` unset) keeps resolving to EXACTLY its pre-P4 grants, with zero data migration. Order:
 * legacy slots first (stable, matches today's mount order), then the
 * array verbatim. Called EXACTLY ONCE per resolution (buildMcpServers) — `capabilities` itself is never
 * pre-bridged (see the field doc above), so this is the only place legacy + new merge.
 */
export function resolveProfileCapabilities(p: { browserTesting?: boolean; documentConversion?: boolean; capabilities?: CapabilityGrant[] }): CapabilityGrant[] {
  const legacy: CapabilityGrant[] = [
    ...(p.browserTesting ? [{ slug: LEGACY_CAPABILITY_SLUGS.browserTesting }] : []),
    ...(p.documentConversion ? [{ slug: LEGACY_CAPABILITY_SLUGS.documentConversion }] : []),
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
    return { role: null, startupPrompt, allow: [], skills: null, model: null, icon: null, browserTesting: false, documentConversion: false, restrictedTools: false, noCommit: false, connections: [], vaultWrite: false, capabilities: [] };
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
 * Sweep G3: read the LOOM_GATE_RETRY_ENABLED env override for the merge-gate retry master switch —
 * promoted from gate-runner.ts's module-load constant of the same shape (`!== "0"`). Returned beneath the
 * PlatformConfigOverride layer in resolveConfig (an override still wins). Mirrors envIdleNudgeMinutes:
 * undefined when unset/blank so the layer beneath applies; process-guarded for the browser-bundled `shared`.
 */
function envGateRetryEnabled(): boolean | undefined {
  const raw = typeof process !== "undefined" ? process.env?.LOOM_GATE_RETRY_ENABLED : undefined;
  if (raw == null || raw.trim() === "") return undefined;
  return raw !== "0";
}

/**
 * Sweep G3: read the LOOM_GATE_RETRY_SETTLE_MS env override for the merge-gate retry settle delay.
 * UNLIKE the old `Number(process.env...) || 5_000` module constant it replaces, an explicit "0" IS
 * honored here (not swallowed) — matching this file's established `??`-discipline (see
 * envIdleNudgeMinutes's own note on why `||` is avoided). Returned beneath the PlatformConfigOverride
 * layer in resolveConfig (an override still wins).
 */
function envGateRetrySettleMs(): number | undefined {
  const raw = typeof process !== "undefined" ? process.env?.LOOM_GATE_RETRY_SETTLE_MS : undefined;
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * Sweep G6: read the LOOM_UPDATE_CHECK_INTERVAL_MS env override for the update-check poll cadence.
 * Returned at the platform-default layer of resolveConfig (a platform override still wins). UNLIKE
 * envIdleNudgeMinutes/envBackupIntervalMinutes, a non-positive value (0 or negative) is treated as unset
 * (returns undefined) rather than honored — this preserves the pre-existing `Number(env) || undefined`
 * behavior at the index.ts call site this replaces (0 was never a meaningful interval here; it would
 * hand `setInterval` a 0ms tick).
 */
function envUpdateCheckIntervalMs(): number | undefined {
  const raw = typeof process !== "undefined" ? process.env?.LOOM_UPDATE_CHECK_INTERVAL_MS : undefined;
  if (raw == null || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
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
    // NOTE: no `integrations` key here (card 3bd8ef17) — `resolvePlatform` feeds `ResolvedConfig.platform`,
    // which `resolveConfig()` returns to `packages/web` too. See `resolveCodescapeIntegrationPath`.
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
    // maxConcurrentGates/maxConcurrentManagers are likewise daemon-GLOBAL — same reasoning as
    // schedulerEnabled above. FIX (found while wiring card 52ab5d45): this fast path used to return the
    // structuredClone(d) value for BOTH untouched, so `resolveConfig(undefined, po)` silently ignored a
    // set `po.maxConcurrentGates`/`po.maxConcurrentManagers` — the exact call the Settings global-config
    // form's "effective:" hints make (`resolveConfig(undefined, override)`), so both hints were stale
    // (always showing the default) regardless of what was actually persisted. Real spawn/gate call sites
    // were unaffected (they resolve with a real project override, hitting the full merge below, which
    // already read `platformOverride` correctly for both fields) — this only reaches the fast path.
    base.orchestration.maxConcurrentGates = platformOverride?.maxConcurrentGates ?? d.orchestration.maxConcurrentGates;
    base.orchestration.maxConcurrentManagers = platformOverride?.maxConcurrentManagers ?? d.orchestration.maxConcurrentManagers;
    base.orchestration.maxConcurrentAuditors = platformOverride?.maxConcurrentAuditors ?? d.orchestration.maxConcurrentAuditors;
    // Sweep G3: gate-retry policy is likewise daemon-GLOBAL — same fast-path fix as maxConcurrentGates
    // above (this branch used to return the structuredClone(d) value untouched by platformOverride?.gateRetry,
    // same stale-hint bug class). Precedence override ?? env ?? default, field by field.
    base.orchestration.gateRetry = {
      enabled: platformOverride?.gateRetry?.enabled ?? envGateRetryEnabled() ?? d.orchestration.gateRetry.enabled,
      settleMs: platformOverride?.gateRetry?.settleMs ?? envGateRetrySettleMs() ?? d.orchestration.gateRetry.settleMs,
    };
    // Sweep G4: backup is likewise daemon-GLOBAL — same fast-path fix as maxConcurrentGates/
    // maxConcurrentManagers above (this branch used to return the structuredClone(d) value untouched by
    // platformOverride?.backup, so resolveConfig(undefined, po) silently ignored a set po.backup, same
    // stale-hint bug the maxConcurrentManagers fix note above describes). intervalMinutes keeps its env
    // layer (envBackup, read above); keep/enabled have no env layer.
    base.backup = {
      intervalMinutes: platformOverride?.backup?.intervalMinutes ?? envBackup ?? d.backup.intervalMinutes,
      keep: platformOverride?.backup?.keep ?? d.backup.keep,
      enabled: platformOverride?.backup?.enabled ?? d.backup.enabled,
    };
    // Sweep G5 (fixes the doc/code mismatch): usageSampleIntervalMs/usageSampleRetentionDays are
    // daemon-GLOBAL and previously NEVER consulted platformOverride on either resolveConfig path despite
    // their own field docs claiming they did — same class of bug as the maxConcurrentGates/
    // maxConcurrentManagers fast-path fix above.
    base.usageSampleIntervalMs = platformOverride?.usageSampleIntervalMs ?? d.usageSampleIntervalMs;
    base.usageSampleRetentionDays = platformOverride?.usageSampleRetentionDays ?? d.usageSampleRetentionDays;
    // Sweep G6: update-check poll cadence, daemon-GLOBAL with an env layer (mirrors backup.intervalMinutes).
    base.updateCheckIntervalMs = platformOverride?.updateCheckIntervalMs ?? envUpdateCheckIntervalMs() ?? d.updateCheckIntervalMs;
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
      // Fleet-wide scheduler cap (card 52ab5d45): daemon-GLOBAL like maxConcurrentGates below — a
      // per-project override is intentionally ignored here, not read (the cron Scheduler is ONE
      // daemon-wide service, never scoped to a specific project — see the field's own doc).
      maxConcurrentManagers: platformOverride?.maxConcurrentManagers ?? d.orchestration.maxConcurrentManagers,
      // Sweep G2: separate daemon-GLOBAL auditor budget, same resolution shape as maxConcurrentManagers
      // above — no per-project layer to consult at all (see OrchestrationConfig.maxConcurrentAuditors).
      maxConcurrentAuditors: platformOverride?.maxConcurrentAuditors ?? d.orchestration.maxConcurrentAuditors,
      // Daemon-GLOBAL (no per-project layer, like backup/platform below): the platform override (2nd
      // arg) wins over the default. A stale per-project `orchestration.schedulerEnabled` (accepted
      // before this field moved to PlatformConfigOverride) is intentionally ignored here, not read.
      schedulerEnabled: platformOverride?.schedulerEnabled ?? d.orchestration.schedulerEnabled,
      // Host-load guard (card 301d8c01): daemon-GLOBAL like schedulerEnabled — a per-project override
      // is intentionally ignored here, not read (see the field's own doc for why host contention isn't
      // a per-project concern).
      maxConcurrentGates: platformOverride?.maxConcurrentGates ?? d.orchestration.maxConcurrentGates,
      // Sweep G3: merge-gate retry policy — daemon-GLOBAL like maxConcurrentGates above (no per-project
      // layer; a per-project ProjectConfigOverride.orchestration has no gateRetry key at all), precedence
      // override ?? env ?? default (mirrors watchers.*Ms). Read IDENTICALLY to the fast path above.
      gateRetry: {
        enabled: platformOverride?.gateRetry?.enabled ?? envGateRetryEnabled() ?? d.orchestration.gateRetry.enabled,
        settleMs: platformOverride?.gateRetry?.settleMs ?? envGateRetrySettleMs() ?? d.orchestration.gateRetry.settleMs,
      },
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
      // Resume-doc basename (card c1f2f095). `??` so an explicit override survives; an empty string is
      // treated as "unset" by the resolver (resolveResumeDocPath), not by this merge.
      resumeDocFilename: override.orchestration?.resumeDocFilename ?? d.orchestration.resumeDocFilename,
    },
    // Daemon-global (no per-project override): platform override (2nd arg) ?? env ?? default, mirroring
    // resolvePlatform's watcher-cadence precedence. `??` (not `||`) so an explicit 0 is preserved (0
    // disables the periodic ticker / retains everything, whichever field is meaningfully 0).
    backup: {
      intervalMinutes: platformOverride?.backup?.intervalMinutes ?? envBackup ?? d.backup.intervalMinutes,
      keep: platformOverride?.backup?.keep ?? d.backup.keep,
      enabled: platformOverride?.backup?.enabled ?? d.backup.enabled,
    },
    // Daemon-global (no per-project layer): global override (2nd arg) ?? LOOM_* watcher env ?? default.
    platform: resolvePlatform(platformOverride),
    // Daemon-global (no per-project layer): global override (2nd arg) ?? default. See RemoteAccessConfig.
    remoteAccess: resolveRemoteAccess(platformOverride),
    docLint: override.docLint ?? d.docLint,
    // NOTE: no `codescape` key here (card 3bd8ef17) — this return value IS `ResolvedConfig`, which
    // `packages/web` gets back from `resolveConfig()` too. See `resolveCodescapeConfig`.
    obsidian,
    python,
    // Clamped to MEMORY_CONFIG_MAX (bounds hardening): an accidental memory_write-in-a-loop or a
    // pathological override/platform-default value can never bloat every kickoff or grow the DB unbounded.
    memory: {
      budgetTokens: Math.min(override.memory?.budgetTokens ?? d.memory.budgetTokens, MEMORY_CONFIG_MAX.budgetTokens),
      topK: Math.min(override.memory?.topK ?? d.memory.topK, MEMORY_CONFIG_MAX.topK),
      maxNotes: Math.min(override.memory?.maxNotes ?? d.memory.maxNotes, MEMORY_CONFIG_MAX.maxNotes),
    },
    // Daemon-global (no per-project layer): the session-usage sampler cadence + retention. Sweep G5 fixes
    // the doc/code mismatch — these previously fell straight to the platform default here, never actually
    // consulting `platformOverride` despite the field's own doc claiming they did. HUMAN-only; not in
    // ProjectConfigOverride, so an agent override can't reach them.
    usageSampleIntervalMs: platformOverride?.usageSampleIntervalMs ?? d.usageSampleIntervalMs,
    usageSampleRetentionDays: platformOverride?.usageSampleRetentionDays ?? d.usageSampleRetentionDays,
    // Sweep G6: update-check poll cadence, daemon-global with an env layer (mirrors backup.intervalMinutes
    // above). `??` so an explicit 0 from the override would be preserved, though the validator's 1h floor
    // makes that unreachable via the human PATCH path in practice.
    updateCheckIntervalMs: platformOverride?.updateCheckIntervalMs ?? envUpdateCheckIntervalMs() ?? d.updateCheckIntervalMs,
  };
}
