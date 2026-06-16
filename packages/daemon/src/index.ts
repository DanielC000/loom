import { resolveConfig } from "@loom/shared";
import { ensureDirs, PORT } from "./paths.js";
import { Db } from "./db.js";
import { sweepDeadSessions, watchClaudeProjects } from "./sessions/liveness.js";
import { snapshotTranscript } from "./sessions/transcript.js";
import { seedGlobalSkills } from "./skills/seed.js";
import { seedDefaultProfiles } from "./profiles/seed.js";
import { seedPlatformHome } from "./platform/seed.js";
import { seedSetupHome } from "./setup/seed.js";
import { maybeAutoLaunchSetup } from "./setup/first-run.js";
import { PtyHost } from "./pty/host.js";
import { SessionService } from "./sessions/service.js";
import { TaskMcpRouter } from "./mcp/server.js";
import { OrchestrationMcpRouter } from "./mcp/orchestration.js";
import { PlatformMcpRouter } from "./mcp/platform.js";
import { AuditMcpRouter } from "./mcp/audit.js";
import { SetupMcpRouter } from "./mcp/setup.js";
import { RunMcpRouter } from "./mcp/run.js";
import { OrchestrationControl } from "./orchestration/control.js";
import { Scheduler } from "./orchestration/scheduler.js";
import { RateLimitWatcher } from "./orchestration/rate-limit-watcher.js";
import { UsageStatusPoller } from "./orchestration/usage-status.js";
import { WakeService } from "./orchestration/wake.js";
import { ContextWatcher } from "./orchestration/context-watcher.js";
import { IdleWatcher } from "./orchestration/idle-watcher.js";
import { BusyWorkerWatcher } from "./orchestration/busy-worker-watcher.js";
import { CrashRecoveryWatcher, recordUnexpectedExit } from "./orchestration/crash-recovery-watcher.js";
import { DbBackupWatcher, resolveBackupConfig, takeBackup } from "./orchestration/db-backup.js";
import { AlertWebhookEmitter } from "./orchestration/alert-webhook.js";
import { recordClaudeRateLimit } from "./orchestration/usage-awareness.js";
import { rateLimitDeadline, rateLimitedUntil } from "./orchestration/usage-limit.js";
import { readRestartIntent, clearRestartIntent, protectedIdsFromIntent } from "./orchestration/restart.js";
import { buildServer } from "./gateway/server.js";
import { loomVersion } from "./version.js";

async function main(): Promise<void> {
  ensureDirs();
  const seeded = seedGlobalSkills();
  if (seeded.length) console.log(`[boot] seeded global skill(s): ${seeded.join(", ")}`);
  // Pre-migration safety snapshot: back up the EXISTING DB before we open it (migrations run in the Db
  // constructor) and before boot-reconcile, so a bad migration/reconcile is recoverable to the pre-boot
  // state. Best-effort — takeBackup never throws and skips a fresh install (no DB yet); awaited so the
  // snapshot completes before the migrating connection opens. Gated on `enabled` (interval-0 only mutes
  // the periodic ticker).
  const backupCfg = resolveBackupConfig();
  if (backupCfg.enabled) await takeBackup({ reason: "boot", keep: backupCfg.keep });
  const db = new Db();
  // Seed Loom's bundled Profiles (platform-level rig) into the profiles table, seed-if-absent
  // like the skills seed — additive, idempotent, preserves user edits. The two Platform-layer profiles
  // (Platform-lead/Platform-audit) seed only under LOOM_DEV; the core profiles always seed.
  const seededProfiles = seedDefaultProfiles(db);
  if (seededProfiles.length) console.log(`[boot] seeded default profile(s): ${seededProfiles.join(", ")}`);
  // Setup Assistant E1: seed the reserved "Getting Started" onboarding home + its Setup Assistant agent,
  // seed-if-absent by name (idempotent; runs AFTER seedDefaultProfiles so the bundled Setup Assistant
  // profile exists to assign). UNGATED — unlike the platform home below, this ships to EVERY loomctl user
  // (no LOOM_DEV gate). Hidden from the project picker; surfaced via the always-available Setup page.
  const seededSetup = seedSetupHome(db);
  if (seededSetup.length) console.log(`[boot] seeded setup home: ${seededSetup.join(", ")}`);
  // Platform Manager P1: seed the reserved "Loom Platform" home + its Platform Lead / Platform Auditor
  // agents, seed-if-absent (idempotent; runs AFTER seedDefaultProfiles so the bundled platform profiles
  // exist to assign). Hidden from the project picker (db.listProjects), still Mission-Control visible.
  // The Lead is NOT spawned here (human REST action) and the Auditor is NOT scheduled here (P5).
  // DEV-ONLY: the whole Platform layer is gated behind LOOM_DEV — this no-ops for regular loomctl users.
  const seededPlatform = seedPlatformHome(db);
  if (seededPlatform.length) console.log(`[boot] seeded platform home: ${seededPlatform.join(", ")}`);
  // Resolve the daemon-global platform tuning ONCE at boot (SQLite singleton override ?? LOOM_* env ??
  // defaults). Every BOOT-BOUND consumer below — PtyHost busy-stale, SessionService git timeouts, the
  // watcher cadences — reads from this. A PATCH to platform.watchers/timeouts therefore takes effect on
  // the NEXT daemon restart (the resolve-live values — gate/webhook/rate-limit — re-resolve per call).
  const platformOverride = db.getPlatformConfig();
  const resolved = resolveConfig(undefined, platformOverride);
  const { watchers, timeouts } = resolved.platform;
  const recovered = db.recoverStaleSessions();
  if (recovered > 0) console.log(`[boot] reconciled ${recovered} stale session(s) -> exited`);
  const dead = sweepDeadSessions(db);
  if (dead > 0) console.log(`[boot] marked ${dead} session(s) dead (engine transcript gone)`);
  // Keep dead-ID state fresh as Claude's transcripts come and go.
  watchClaudeProjects(db, (n) => console.log(`[watch] marked ${n} session(s) dead`));

  // PtyHost callbacks persist runtime state into the registry (engine id on receipt; exit).
  // onExit references orchMcp (declared below) — only invoked at runtime, after init.
  const pty = new PtyHost({
    onEngineSessionId: (sessionId, engineId) => db.setEngineSessionId(sessionId, engineId),
    // Persist busy, and on the falling edge nudge the manager if a worker went idle without
    // reporting (stranded-worker guard; no-op for non-workers). `sessions` is assigned below but
    // this closure only runs at runtime — same forward-reference pattern as onExit→orchMcp.
    onBusy: (sessionId, busy) => { db.setBusy(sessionId, busy); if (!busy) sessions.notifyManagerOfIdleWorker(sessionId); },
    onContextStats: (sessionId, s) => db.setContextCounters(sessionId, { ctxInputTokens: s.inputTokens, ctxTurns: s.turns, model: s.model }),
    // §19c: persist the per-session park (resume-at + human lastError), arm the episode give-up
    // deadline (first cap sets it; re-caps keep it via COALESCE), AND record GLOBAL awareness (so
    // the Scheduler / worker_spawn won't fire into a known-limited account).
    onRateLimited: (sessionId, _until, detail) => {
      // RESOLVE-LIVE: re-derive the authoritative park (resume-at) + episode give-up deadline from the
      // daemon-global rate-limit knobs HERE, where db is in scope — so a PATCH to platform.rateLimit
      // takes effect with no restart. PtyHost is db-unaware by design (layering boundary); the `_until`
      // it passes is a module-default fallback we deliberately re-derive with the resolved config.
      const rl = resolveConfig(undefined, db.getPlatformConfig()).platform.rateLimit;
      const until = rateLimitedUntil(detail.resetsAtSeconds, new Date(), rl);
      db.setRateLimitedUntil(sessionId, until, `usage limit — resumes ${until}`);
      db.armRateLimitDeadline(sessionId, rateLimitDeadline(detail.resetsAtSeconds, new Date(), rl));
      recordClaudeRateLimit(detail.resetsAtSeconds);
    },
    // A hard stop fires no Stop hook, so clear busy on exit too — an exited pty is never busy.
    onExit: (sessionId, _code, info) => {
      db.setProcessState(sessionId, "exited");
      db.setBusy(sessionId, false);
      // Crash-recovery trigger: record a durable `session_died` event IFF this was an UNEXPECTED death
      // (`intended === false` — no pty.stop() was issued) of a resumable coordination/work session, so the
      // CrashRecoveryWatcher can bounded-auto-resume it. An intended stop records nothing (untouched); a
      // whole-daemon restart/crash never reaches here at all. Best-effort: never disturb the exit path.
      try { recordUnexpectedExit(db, sessionId, info.intended); } catch { /* never disturb the exit path */ }
      // Auto-snapshot the engine transcript on exit, while the JSONL still exists — so an archived
      // session keeps a readable transcript even after Claude later prunes the original (a session
      // goes 'dead' BECAUSE its JSONL was deleted). Best-effort: snapshotTranscript never throws, and
      // getSession is null for shell terminals (not DB sessions) → skipped.
      let exited;
      try {
        exited = db.getSession(sessionId);
        if (exited?.engineSessionId) snapshotTranscript(exited.cwd, exited.engineSessionId, exited.projectId, exited.id);
      } catch { /* never disturb the exit path */ }
      // Agent Runs R2: finalize the run row + GC its disposable snapshot cwd (the pty is now gone, so
      // its handles are released). Runs the SAME teardown whether the run completed via submit_result or
      // the session died first (→ failed). Best-effort: a throw here must not disturb the exit path.
      try { if (exited?.role === "run") sessions.onRunSessionExit(sessionId); } catch { /* never disturb the exit path */ }
      mcp.dispose(sessionId); orchMcp.dispose(sessionId); platformMcp.dispose(sessionId); setupMcp.dispose(sessionId); runMcp.dispose(sessionId);
    },
  }, { busyStaleMs: timeouts.busyStaleMs }); // BOOT-BOUND: stuck-busy self-heal threshold from resolved platform config

  const control = new OrchestrationControl(); // §17a safety rails (pause/kill); in-memory by design
  // BOOT-BOUND: thread the resolved git-op / provision timeouts into the bounded-git + provision seams
  // at SessionService's call-sites (worktree create/remove/branch-delete/merge-detect during boot-reconcile).
  const sessions = new SessionService(db, pty, control, { gitOpMs: timeouts.gitOpMs, provisionMs: timeouts.provisionMs, runTimeoutMs: timeouts.runMs });
  // Self-host restart recovery: a manager's `daemon_restart` left an intent naming the sessions to
  // bring back. Read it BEFORE the reconcile so the WHOLE fleet's worktrees are PROTECTED from pass-B GC
  // (recoverStaleSessions just marked every prior-run session 'exited', which would otherwise prune a
  // worktree we need to resume into). protectedIdsFromIntent spans the entire captured fleet across all
  // projects (P1 17df54c5) and tolerates an OLD-format intent (degrades to the requester + its workers).
  // The actual resume happens after the server is listening (its ptys need the MCP endpoints up). null
  // on a normal boot.
  const restartIntent = readRestartIntent();
  const protectedSessionIds = restartIntent ? protectedIdsFromIntent(restartIntent) : new Set<string>();
  // Boot-time orchestration reconcile (#22 run-2 + audit M4): finish any merge whose bookkeeping was
  // interrupted (branch merged but task/worktree not reconciled) and GC orphaned worktrees from
  // crashed workers. Runs AFTER recoverStaleSessions (no live pty holds a worktree) — pure git + db.
  // Best-effort cleanup: it must NEVER gate startup, so any unexpected failure is warned and swallowed
  // (a deterministic throw here would otherwise crash-loop the boot, since merging self-restarts the
  // dev daemon — and that would also block usage-limit auto-resume).
  try {
    const reconciled = await sessions.reconcileOrchestrationOnBoot(protectedSessionIds);
    if (reconciled.mergesFinished || reconciled.mergesFailed || reconciled.staleMergesResolved || reconciled.worktreesPruned || reconciled.worktreesKept) {
      console.log(`[boot] orchestration reconcile: finished ${reconciled.mergesFinished} orphaned merge(s), ${reconciled.mergesFailed} failed (retry next boot), resolved ${reconciled.staleMergesResolved} branch-gone dangling merge(s), pruned ${reconciled.worktreesPruned} orphaned worktree(s), kept ${reconciled.worktreesKept} holding unmerged/uncommitted work`);
    }
  } catch (err) {
    console.warn(`[boot] orchestration reconcile failed (continuing boot): ${(err as Error).message}`);
  }
  // Agent Runs R2: fail any run interrupted by a crash/restart (runs are ephemeral and do NOT resume) and
  // sweep orphaned run-snapshot dirs. Pure DB + fs, best-effort — never gate boot. recoverStaleSessions
  // already marked each interrupted run's `run` session exited, so this only finalizes the run rows.
  try {
    const runs = sessions.reconcileRunsOnBoot();
    if (runs.failed > 0) console.log(`[boot] failed ${runs.failed} interrupted run(s) (ephemeral — no resume) + swept run snapshots`);
  } catch (err) {
    console.warn(`[boot] run reconcile failed (continuing boot): ${(err as Error).message}`);
  }
  // WakeService (the `wake_me` primitive) needs SessionService.resume (auto-resume on fire), so it
  // comes after sessions. Always on — recovery/continuation, not autonomy-gated (like the rate-limit
  // watcher). BOOT-BOUND cadence from the resolved platform config (LOOM_WAKE_INTERVAL_MS env is read,
  // floor-clamped, inside resolveConfig; default 60s).
  const wakeIntervalMs = watchers.wakeMs;
  const wakes = new WakeService({ db, pty, resume: (id) => sessions.resume(id), intervalMs: wakeIntervalMs });
  // The task MCP hosts the universal wake tools, so it takes the WakeService.
  const mcp = new TaskMcpRouter(db, wakes);
  // OrchestrationMcpRouter needs SessionService (worker_spawn/worker_stop), so it comes after.
  const orchMcp = new OrchestrationMcpRouter(db, sessions);
  // Platform MCP (Pillar C / P2) needs the registry (project/agent/profile/schedule + config) AND
  // SessionService (the cross-project session_spawn/session_stop lifecycle ops). P3 also threads the
  // BOOT-BOUND git-write timeouts so the Lead's elevated git tools (git_checkout/commit/push) bound a
  // git op EXACTLY like the human REST git routes (gateway/server.ts resolves the same numbers).
  const platformMcp = new PlatformMcpRouter(db, sessions, { gitLocalMs: timeouts.gitLocalMs, gitPushMs: timeouts.gitPushMs });
  // Audit MCP (P5) — the Platform Auditor's RESTRICTED read-and-file-only surface. Needs the registry
  // (transcript reads + session list) AND SessionService (audit_file_finding → reserved Platform board).
  // Deliberately gets NO git-write timeouts: it has no git/vault/config/spawn tools, by design.
  const auditMcp = new AuditMcpRouter(db, sessions);
  // Setup MCP (Setup Assistant E1-3) — the ungated, user-facing onboarding assistant's CURATED,
  // fail-closed surface (project/agent/profile create+configure + manager|plain spawn). Needs the
  // registry (structural/profile/read ops) AND SessionService (session_spawn). Deliberately gets NO
  // git-write timeouts: it has no git/vault/config-elevation/schedule/message tool, by design.
  const setupMcp = new SetupMcpRouter(db, sessions);
  // Run MCP (Agent Runs R2) — the ephemeral run's restricted submit_result surface. Needs the registry
  // (resolve session→run) AND SessionService (validate + record + teardown). Gets NO git/vault timeouts.
  const runMcp = new RunMcpRouter(db, sessions);

  // Account-wide Claude plan-usage poller — one shared cached fetch of the OAuth usage endpoint, served
  // read-only to Mission Control via GET /api/usage/limits. Created here so the gateway can read its
  // cache; started below (after listen). BOOT-BOUND cadence from the resolved platform config
  // (LOOM_USAGE_POLL_INTERVAL_MS env read + floor-clamped inside resolveConfig; default 60s).
  const usageStatus = new UsageStatusPoller({ intervalMs: watchers.usagePollMs });

  // The graceful-shutdown path, shared by the SIGINT/SIGTERM handlers and the loopback
  // POST /internal/shutdown control hook (`loom stop`). Assigned BELOW, after the watchers it closes
  // over exist; the endpoint only fires at request time (long after boot), so this ref is always
  // populated by then. The buildServer thunk delegates to it.
  let gracefulShutdown: ((reason: string) => void) | null = null;

  const app = await buildServer({ db, pty, sessions, mcp, orchMcp, platformMcp, auditMcp, setupMcp, runMcp, control, usageStatus, requestShutdown: () => gracefulShutdown?.("POST /internal/shutdown") });
  await app.listen({ port: PORT, host: "127.0.0.1" }); // local-first: loopback only
  // eslint-disable-next-line no-console
  console.log(`Loom daemon v${loomVersion()} listening on http://127.0.0.1:${PORT}`);

  // Pillar B: the cron trigger layer. Boots a manager (interactive pty, never headless) on each
  // due schedule's tick. OPT-IN (autonomy earned gate-by-gate): only start when enabled via the
  // platform config OR the LOOM_SCHEDULER_ENABLED=1 env override. LOOM_SCHEDULER_INTERVAL_MS tunes
  // the tick cadence (default 60s) — tests use a short interval to avoid a 60s wait.
  const schedulerEnabled =
    process.env.LOOM_SCHEDULER_ENABLED === "1" || resolved.orchestration.schedulerEnabled;
  // BOOT-BOUND cadence from the resolved platform config (LOOM_SCHEDULER_INTERVAL_MS env read +
  // floor-clamped inside resolveConfig; default 60s).
  const intervalMs = watchers.schedulerMs;
  const maxConcurrentManagers = resolved.orchestration.maxConcurrentManagers;
  const scheduler = new Scheduler({ db, control, startManager: (agentId) => sessions.startManager(agentId), startAuditor: (agentId) => sessions.startAuditor(agentId), intervalMs, maxConcurrentManagers });
  if (schedulerEnabled) {
    scheduler.start();
    console.log(`[boot] scheduler enabled (tick ${intervalMs}ms)`);
  } else {
    console.log("[boot] scheduler disabled (set orchestration.schedulerEnabled or LOOM_SCHEDULER_ENABLED=1)");
  }

  // §19c-b usage-limit RESUME watcher — ALWAYS ON (recovery ≠ autonomy; a manually-started session
  // can hit the cap too), so it runs regardless of schedulerEnabled. LOOM_RATE_LIMIT_WATCH_INTERVAL_MS
  // tunes the tick for tests (default 60s).
  const watchIntervalMs = watchers.rateLimitWatchMs;
  const rateLimitWatcher = new RateLimitWatcher({ db, pty, intervalMs: watchIntervalMs });
  rateLimitWatcher.start();
  console.log(`[boot] usage-limit resume watcher on (tick ${watchIntervalMs}ms)`);

  // Account-wide plan-usage poller — start it now that the server is up (skips itself if there's no
  // credentials file). Read-only god-eye data for Mission Control; failures degrade to unavailable.
  usageStatus.start();
  console.log("[boot] plan-usage poller on (GET /api/usage/limits)");

  // The self-scheduled wake-up ticker (always on; reconciles past-due wakes fire-once on start()).
  wakes.start();
  console.log(`[boot] wake-up ticker on (tick ${wakeIntervalMs}ms)`);

  // Input-queue reconcile: self-heal stuck-busy sessions and drain any message held while the session
  // was busy / the human was typing — so a worker report never strands behind a phantom 'busy' or an
  // unfinished compose. The Stop hook is the fast path; this is the safety net (10s).
  const reconcileMs = watchers.reconcileMs;
  const reconcileTimer = setInterval(() => pty.reconcile(), reconcileMs);
  console.log(`[boot] input-queue reconcile on (tick ${reconcileMs}ms)`);

  // Periodic transcript-snapshot backstop — closes the hard-crash-no-signal gap the graceful
  // SIGINT/SIGTERM hook (5f838ef) can't cover: a kill-9 / power-loss fires NO signal, and a long-lived
  // session has no snapshot until it exits. A low-frequency timer snapshots every LIVE session's engine
  // transcript; snapshotTranscript is mtime-guarded → a cheap no-op when a session's JSONL is unchanged.
  // Best-effort: snapshotAllLive swallows per-session failures and never throws; the try guards the rest.
  // BOOT-BOUND cadence from the resolved platform config (LOOM_SNAPSHOT_INTERVAL_MS env, default ~7m).
  const snapshotMs = watchers.snapshotMs;
  const snapshotTimer = setInterval(() => {
    try { sessions.snapshotAllLive(); } catch { /* never let the periodic ticker throw */ }
  }, snapshotMs);
  console.log(`[boot] periodic transcript-snapshot on (tick ${snapshotMs}ms)`);

  // Manager context-recycle watcher — nudges a manager nearing its model's context window to hand off
  // to a fresh successor (run /session-end → recycle_me). Ratio scales with the model. 0 disables.
  const recycleRatio = Number(process.env.LOOM_RECYCLE_CONTEXT_RATIO) || resolved.orchestration.recycleAtContextRatio;
  const ctxWatchMs = watchers.contextWatchMs;
  const contextWatcher = new ContextWatcher({ db, pty, ratio: recycleRatio, intervalMs: ctxWatchMs });
  contextWatcher.start();
  console.log(`[boot] context-recycle watcher on (ratio ${recycleRatio}, tick ${ctxWatchMs}ms)`);

  // Asleep-at-the-Wheel watcher — nudges a LIVE manager that has silently dropped its orchestration
  // loop (idle, no live workers, backlog open) to report why and resume. Per-project leash via
  // resolveConfig (idleNudgeMinutes; 0 disables); recycle takes precedence (shares recycleRatio).
  const idleWatchMs = watchers.idleWatchMs;
  const idleWatcher = new IdleWatcher({ db, pty, control, recycleRatio, intervalMs: idleWatchMs });
  idleWatcher.start();
  console.log(`[boot] idle-manager watcher on (tick ${idleWatchMs}ms)`);

  // Busy-worker stuck watchdog — the inverse of the idle-manager watcher: surfaces a LIVE worker stuck
  // `busy` past the per-project `stuckWorkerMinutes` window (no turn boundary → stale lastActivity) to
  // its OWNING MANAGER as a `worker_stuck` event + a nudge it can act on (re-nudge / recycle). Never a
  // hard kill. Shares the idle-watch cadence (sibling watchdog); 0 disables per project.
  const busyWorkerWatcher = new BusyWorkerWatcher({ db, pty, control, intervalMs: idleWatchMs });
  busyWorkerWatcher.start();
  console.log(`[boot] busy-worker stuck watchdog on (tick ${idleWatchMs}ms)`);

  // Crash-recovery watchdog — the complement of resumeFleetOnBoot (which owns daemon-RESTART recovery):
  // bounded auto-resume of an ISOLATED session whose pty died UNEXPECTEDLY while the daemon stayed healthy
  // (the `session_died` trigger recorded in onExit). Caps attempts per project (crashRecoveryMaxAttempts;
  // 0 = off) via a persisted counter and ESCALATES on Mission Control after the cap instead of looping —
  // crash-loop safety is the load-bearing property. Resume re-spawns through the same hardened path.
  const crashRecoveryMs = watchers.crashRecoveryWatchMs;
  const crashRecoveryWatcher = new CrashRecoveryWatcher({
    db, control, pty, intervalMs: crashRecoveryMs,
    resume: (id) => { sessions.resume(id); return true; },
  });
  crashRecoveryWatcher.start();
  console.log(`[boot] crash-recovery watchdog on (tick ${crashRecoveryMs}ms)`);

  // Automatic DB-backup ticker — periodic online snapshots of loom.db into ~/.loom/backups/auto/,
  // rotated to the newest `keep`. Best-effort; never blocks/crashes. Disabled when backups are off or
  // the interval is 0. LOOM_BACKUP_INTERVAL_MS overrides the tick cadence for tests (otherwise minutes).
  const dbBackupWatcher = new DbBackupWatcher({
    enabled: backupCfg.enabled,
    intervalMinutes: backupCfg.intervalMinutes,
    keep: backupCfg.keep,
    intervalMs: Number(process.env.LOOM_BACKUP_INTERVAL_MS) || undefined,
  });
  dbBackupWatcher.start();
  console.log(
    backupCfg.enabled && backupCfg.intervalMinutes > 0
      ? `[boot] db-backup ticker on (every ${backupCfg.intervalMinutes}m, keep ${backupCfg.keep})`
      : `[boot] db-backup ticker off (${backupCfg.enabled ? "interval 0" : "disabled"})`,
  );

  // Outbound alert-webhook (external delivery): a passive listener on the orchestration event
  // chokepoint that POSTs to a HUMAN-configured `orchestration.alertWebhook` URL on matching event
  // kinds — best-effort + bounded, never blocks/breaks the event path. Registered AFTER the boot
  // reconcile so a restart's recovery events don't fire stale alerts. No external delivery happens
  // unless a human has configured a webhook for the project (default OFF).
  const alertWebhook = new AlertWebhookEmitter({ db });
  db.setEventListener((evt) => { void alertWebhook.onEvent(evt); });
  console.log("[boot] alert-webhook emitter registered (external delivery on configured projects)");

  // Self-host restart recovery (consume the intent read above): a manager deliberately restarted the
  // daemon (daemon_restart) to make merged code live. The daemon is ONE process for ALL projects, so the
  // restart tore down the WHOLE cross-project fleet — re-resume ALL of it (every manager, worker, plain
  // session), not just the requester (P1 17df54c5). resumeFleetOnBoot re-spawns each with its role +
  // linkage, injects nothing into the resume, gives the requester its "code is live" re-prompt and the
  // rest a continuation nudge, and honors a parked session's usage hold. Best-effort + runs once.
  if (restartIntent) {
    clearRestartIntent();
    const { resumed, skippedParked, failed } = sessions.resumeFleetOnBoot(restartIntent);
    console.log(
      `[boot] self-host restart: resumed ${resumed.length} session(s) across the fleet` +
      (skippedParked.length ? `, ${skippedParked.length} resumed-but-parked (usage hold honored)` : "") +
      (failed.length ? `, ${failed.length} unresumable (skipped)` : "") +
      ` (requester ${restartIntent.managerSessionId.slice(0, 8)})`,
    );
  }

  // Setup Assistant E1-6: FIRST-RUN auto-launch. On a brand-new/empty install (no ordinary projects + the
  // one-time app_meta marker unset) greet the user by auto-spawning the Setup Assistant ONCE; the marker
  // is stamped at launch so it never re-fires — not after a daemon_restart, not after the user later
  // deletes all their projects. Runs AFTER the server is listening (the spawned setup pty needs the MCP
  // endpoints up, exactly like the restart-intent resume above) and AFTER that resume (a restart is never
  // a fresh install — the marker is already set / ordinary projects exist — so this naturally no-ops then).
  // Best-effort: a fault here must never gate boot.
  try {
    const firstRun = maybeAutoLaunchSetup(db, sessions);
    if (firstRun.launched) console.log(`[boot] first-run: auto-launched Setup Assistant (session ${firstRun.sessionId.slice(0, 8)})`);
  } catch (err) {
    console.warn(`[boot] first-run setup auto-launch failed (continuing boot): ${(err as Error).message}`);
  }

  // The one graceful-teardown path — invoked by a SIGINT/SIGTERM signal AND by the loopback
  // POST /internal/shutdown control hook (the cross-platform `loom stop`, since Windows has no SIGTERM).
  gracefulShutdown = (reason: string) => {
    // Crash/shutdown transcript backstop: snapshot every LIVE session's engine transcript BEFORE we
    // exit. The pty onExit hook (the per-session snapshot trigger) never fires on a signal-kill, so
    // without this a long-lived session loses its transcript when Claude later prunes the JSONL.
    // Best-effort + never-throws (snapshotAllLive swallows per-session failures); must not block exit.
    try { const n = sessions.snapshotAllLive(); if (n > 0) console.log(`[shutdown] snapshotted ${n} live transcript(s)`); } catch { /* never block the exit */ }
    scheduler.stop(); rateLimitWatcher.stop(); usageStatus.stop(); wakes.stop(); clearInterval(reconcileTimer); clearInterval(snapshotTimer); contextWatcher.stop(); idleWatcher.stop(); busyWorkerWatcher.stop(); crashRecoveryWatcher.stop(); dbBackupWatcher.stop();
    console.log(`[shutdown] graceful stop (${reason})`);
    process.exit(0); // clean stop — NOT exit 75 (the supervisor's restart sentinel)
  };
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => gracefulShutdown!(sig));
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Loom daemon failed to start:", err);
  process.exit(1);
});
