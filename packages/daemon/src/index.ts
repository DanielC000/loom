import { resolveConfig } from "@loom/shared";
import { ensureDirs, PORT } from "./paths.js";
import { Db } from "./db.js";
import { sweepDeadSessions, watchClaudeProjects } from "./sessions/liveness.js";
import { seedGlobalSkills } from "./skills/seed.js";
import { seedDefaultProfiles } from "./profiles/seed.js";
import { PtyHost } from "./pty/host.js";
import { SessionService } from "./sessions/service.js";
import { TaskMcpRouter } from "./mcp/server.js";
import { OrchestrationMcpRouter } from "./mcp/orchestration.js";
import { PlatformMcpRouter } from "./mcp/platform.js";
import { OrchestrationControl } from "./orchestration/control.js";
import { Scheduler } from "./orchestration/scheduler.js";
import { RateLimitWatcher } from "./orchestration/rate-limit-watcher.js";
import { WakeService } from "./orchestration/wake.js";
import { ContextWatcher } from "./orchestration/context-watcher.js";
import { IdleWatcher } from "./orchestration/idle-watcher.js";
import { recordClaudeRateLimit } from "./orchestration/usage-awareness.js";
import { rateLimitDeadline } from "./orchestration/usage-limit.js";
import { readRestartIntent, clearRestartIntent } from "./orchestration/restart.js";
import { buildServer } from "./gateway/server.js";

async function main(): Promise<void> {
  ensureDirs();
  const seeded = seedGlobalSkills();
  if (seeded.length) console.log(`[boot] seeded global skill(s): ${seeded.join(", ")}`);
  const db = new Db();
  // Seed Loom's bundled Agent Profiles (platform-level "who") into the profiles table, seed-if-absent
  // like the skills seed — additive, idempotent, preserves user edits. Phase-1 read path only.
  const seededProfiles = seedDefaultProfiles(db);
  if (seededProfiles.length) console.log(`[boot] seeded default profile(s): ${seededProfiles.join(", ")}`);
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
    onRateLimited: (sessionId, until, detail) => {
      db.setRateLimitedUntil(sessionId, until, detail.message);
      db.armRateLimitDeadline(sessionId, rateLimitDeadline(detail.resetsAtSeconds));
      recordClaudeRateLimit(detail.resetsAtSeconds);
    },
    // A hard stop fires no Stop hook, so clear busy on exit too — an exited pty is never busy.
    onExit: (sessionId) => { db.setProcessState(sessionId, "exited"); db.setBusy(sessionId, false); mcp.dispose(sessionId); orchMcp.dispose(sessionId); platformMcp.dispose(sessionId); },
  });

  const control = new OrchestrationControl(); // §17a safety rails (pause/kill); in-memory by design
  const sessions = new SessionService(db, pty, control);
  // Self-host restart recovery: a manager's `daemon_restart` left an intent naming the sessions to
  // bring back. Read it BEFORE the reconcile so those workers' worktrees are PROTECTED from pass-B GC
  // (recoverStaleSessions just marked them 'exited', which would otherwise prune the worktree we need
  // to resume into). The actual resume happens after the server is listening (its ptys need the MCP
  // endpoints up). null on a normal boot.
  const restartIntent = readRestartIntent();
  const protectedSessionIds = new Set(restartIntent?.workerSessionIds ?? []);
  // Boot-time orchestration reconcile (#22 run-2 + audit M4): finish any merge whose bookkeeping was
  // interrupted (branch merged but task/worktree not reconciled) and GC orphaned worktrees from
  // crashed workers. Runs AFTER recoverStaleSessions (no live pty holds a worktree) — pure git + db.
  // Best-effort cleanup: it must NEVER gate startup, so any unexpected failure is warned and swallowed
  // (a deterministic throw here would otherwise crash-loop the boot, since merging self-restarts the
  // dev daemon — and that would also block usage-limit auto-resume).
  try {
    const reconciled = await sessions.reconcileOrchestrationOnBoot(protectedSessionIds);
    if (reconciled.mergesFinished || reconciled.mergesFailed || reconciled.worktreesPruned) {
      console.log(`[boot] orchestration reconcile: finished ${reconciled.mergesFinished} orphaned merge(s), ${reconciled.mergesFailed} failed (retry next boot), pruned ${reconciled.worktreesPruned} orphaned worktree(s)`);
    }
  } catch (err) {
    console.warn(`[boot] orchestration reconcile failed (continuing boot): ${(err as Error).message}`);
  }
  // WakeService (the `wake_me` primitive) needs SessionService.resume (auto-resume on fire), so it
  // comes after sessions. Always on — recovery/continuation, not autonomy-gated (like the rate-limit
  // watcher). LOOM_WAKE_INTERVAL_MS tunes the tick for tests (default 60s).
  const wakeIntervalMs = Number(process.env.LOOM_WAKE_INTERVAL_MS) || 60_000;
  const wakes = new WakeService({ db, pty, resume: (id) => sessions.resume(id), intervalMs: wakeIntervalMs });
  // The task MCP hosts the universal wake tools, so it takes the WakeService.
  const mcp = new TaskMcpRouter(db, wakes);
  // OrchestrationMcpRouter needs SessionService (worker_spawn/worker_stop), so it comes after.
  const orchMcp = new OrchestrationMcpRouter(db, sessions);
  // Platform MCP (Pillar C) only needs the registry (project/topic creation + config).
  const platformMcp = new PlatformMcpRouter(db);

  const app = await buildServer({ db, pty, sessions, mcp, orchMcp, platformMcp, control });
  await app.listen({ port: PORT, host: "127.0.0.1" }); // local-first: loopback only
  // eslint-disable-next-line no-console
  console.log(`Loom daemon listening on http://127.0.0.1:${PORT}`);

  // Pillar B: the cron trigger layer. Boots a manager (interactive pty, never headless) on each
  // due schedule's tick. OPT-IN (autonomy earned gate-by-gate): only start when enabled via the
  // platform config OR the LOOM_SCHEDULER_ENABLED=1 env override. LOOM_SCHEDULER_INTERVAL_MS tunes
  // the tick cadence (default 60s) — tests use a short interval to avoid a 60s wait.
  const schedulerEnabled =
    process.env.LOOM_SCHEDULER_ENABLED === "1" || resolveConfig(undefined).orchestration.schedulerEnabled;
  const intervalMs = Number(process.env.LOOM_SCHEDULER_INTERVAL_MS) || 60_000;
  const maxConcurrentManagers = resolveConfig(undefined).orchestration.maxConcurrentManagers;
  const scheduler = new Scheduler({ db, control, startManager: (topicId) => sessions.startManager(topicId), intervalMs, maxConcurrentManagers });
  if (schedulerEnabled) {
    scheduler.start();
    console.log(`[boot] scheduler enabled (tick ${intervalMs}ms)`);
  } else {
    console.log("[boot] scheduler disabled (set orchestration.schedulerEnabled or LOOM_SCHEDULER_ENABLED=1)");
  }

  // §19c-b usage-limit RESUME watcher — ALWAYS ON (recovery ≠ autonomy; a manually-started session
  // can hit the cap too), so it runs regardless of schedulerEnabled. LOOM_RATE_LIMIT_WATCH_INTERVAL_MS
  // tunes the tick for tests (default 60s).
  const watchIntervalMs = Number(process.env.LOOM_RATE_LIMIT_WATCH_INTERVAL_MS) || 60_000;
  const rateLimitWatcher = new RateLimitWatcher({ db, pty, intervalMs: watchIntervalMs });
  rateLimitWatcher.start();
  console.log(`[boot] usage-limit resume watcher on (tick ${watchIntervalMs}ms)`);

  // The self-scheduled wake-up ticker (always on; reconciles past-due wakes fire-once on start()).
  wakes.start();
  console.log(`[boot] wake-up ticker on (tick ${wakeIntervalMs}ms)`);

  // Input-queue reconcile: self-heal stuck-busy sessions and drain any message held while the session
  // was busy / the human was typing — so a worker report never strands behind a phantom 'busy' or an
  // unfinished compose. The Stop hook is the fast path; this is the safety net (10s).
  const reconcileMs = Number(process.env.LOOM_RECONCILE_INTERVAL_MS) || 10_000;
  const reconcileTimer = setInterval(() => pty.reconcile(), reconcileMs);
  console.log(`[boot] input-queue reconcile on (tick ${reconcileMs}ms)`);

  // Manager context-recycle watcher — nudges a manager nearing its model's context window to hand off
  // to a fresh successor (run /session-end → recycle_me). Ratio scales with the model. 0 disables.
  const recycleRatio = Number(process.env.LOOM_RECYCLE_CONTEXT_RATIO) || resolveConfig(undefined).orchestration.recycleAtContextRatio;
  const ctxWatchMs = Number(process.env.LOOM_CONTEXT_WATCH_INTERVAL_MS) || 60_000;
  const contextWatcher = new ContextWatcher({ db, pty, ratio: recycleRatio, intervalMs: ctxWatchMs });
  contextWatcher.start();
  console.log(`[boot] context-recycle watcher on (ratio ${recycleRatio}, tick ${ctxWatchMs}ms)`);

  // Asleep-at-the-Wheel watcher — nudges a LIVE manager that has silently dropped its orchestration
  // loop (idle, no live workers, backlog open) to report why and resume. Per-project leash via
  // resolveConfig (idleNudgeMinutes; 0 disables); recycle takes precedence (shares recycleRatio).
  const idleWatchMs = Number(process.env.LOOM_IDLE_WATCH_INTERVAL_MS) || 60_000;
  const idleWatcher = new IdleWatcher({ db, pty, control, recycleRatio, intervalMs: idleWatchMs });
  idleWatcher.start();
  console.log(`[boot] idle-manager watcher on (tick ${idleWatchMs}ms)`);

  // Self-host restart recovery (consume the intent read above): a manager deliberately restarted the
  // daemon (daemon_restart) to make merged code live. Re-resume its live workers, then the manager,
  // and tell the manager the rebuild+restart is done so it can carry on (e.g. verify the live daemon).
  // Best-effort: an unresumable session is skipped (dead transcript / gone worktree). Runs once.
  if (restartIntent) {
    clearRestartIntent();
    const tryResume = (id: string): boolean => {
      try { sessions.resume(id); return true; } catch { return false; }
    };
    const workersResumed = restartIntent.workerSessionIds.filter(tryResume).length;
    if (tryResume(restartIntent.managerSessionId)) {
      pty.enqueueStdin(
        restartIntent.managerSessionId,
        `[loom:daemon-restarted] Rebuild + restart complete — your merged daemon code is now LIVE in the ` +
        `running daemon (reason: ${restartIntent.reason}). ${workersResumed}/${restartIntent.workerSessionIds.length} ` +
        `of your live workers were resumed. You can now end-to-end verify the live behavior. Continue.`,
      );
      console.log(`[boot] self-host restart: resumed manager ${restartIntent.managerSessionId.slice(0, 8)} (+${workersResumed} worker(s))`);
    } else {
      console.warn(`[boot] self-host restart: manager ${restartIntent.managerSessionId.slice(0, 8)} could not be resumed`);
    }
  }

  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { scheduler.stop(); rateLimitWatcher.stop(); wakes.stop(); clearInterval(reconcileTimer); contextWatcher.stop(); idleWatcher.stop(); process.exit(0); });
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Loom daemon failed to start:", err);
  process.exit(1);
});
