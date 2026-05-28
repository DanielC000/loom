import { resolveConfig } from "@loom/shared";
import { ensureDirs, PORT } from "./paths.js";
import { Db } from "./db.js";
import { sweepDeadSessions, watchClaudeProjects } from "./sessions/liveness.js";
import { seedGlobalSkills } from "./skills/seed.js";
import { PtyHost } from "./pty/host.js";
import { SessionService } from "./sessions/service.js";
import { TaskMcpRouter } from "./mcp/server.js";
import { OrchestrationMcpRouter } from "./mcp/orchestration.js";
import { OrchestrationControl } from "./orchestration/control.js";
import { Scheduler } from "./orchestration/scheduler.js";
import { recordClaudeRateLimit } from "./orchestration/usage-awareness.js";
import { buildServer } from "./gateway/server.js";

async function main(): Promise<void> {
  ensureDirs();
  const seeded = seedGlobalSkills();
  if (seeded.length) console.log(`[boot] seeded global skill(s): ${seeded.join(", ")}`);
  const db = new Db();
  const recovered = db.recoverStaleSessions();
  if (recovered > 0) console.log(`[boot] reconciled ${recovered} stale session(s) -> exited`);
  const dead = sweepDeadSessions(db);
  if (dead > 0) console.log(`[boot] marked ${dead} session(s) dead (engine transcript gone)`);
  // Keep dead-ID state fresh as Claude's transcripts come and go.
  watchClaudeProjects(db, (n) => console.log(`[watch] marked ${n} session(s) dead`));

  const mcp = new TaskMcpRouter(db);

  // PtyHost callbacks persist runtime state into the registry (engine id on receipt; exit).
  // onExit references orchMcp (declared below) — only invoked at runtime, after init.
  const pty = new PtyHost({
    onEngineSessionId: (sessionId, engineId) => db.setEngineSessionId(sessionId, engineId),
    onBusy: (sessionId, busy) => db.setBusy(sessionId, busy),
    onContextStats: (sessionId, s) => db.setContextCounters(sessionId, { ctxInputTokens: s.inputTokens, ctxTurns: s.turns }),
    // §19c: persist the per-session park (resume-at + human lastError) AND record GLOBAL awareness
    // (so the Scheduler / worker_spawn won't fire into a known-limited account).
    onRateLimited: (sessionId, until, detail) => {
      db.setRateLimitedUntil(sessionId, until, detail.message);
      recordClaudeRateLimit(detail.resetsAtSeconds);
    },
    // A hard stop fires no Stop hook, so clear busy on exit too — an exited pty is never busy.
    onExit: (sessionId) => { db.setProcessState(sessionId, "exited"); db.setBusy(sessionId, false); mcp.dispose(sessionId); orchMcp.dispose(sessionId); },
  });

  const control = new OrchestrationControl(); // §17a safety rails (pause/kill); in-memory by design
  const sessions = new SessionService(db, pty, control);
  // OrchestrationMcpRouter needs SessionService (worker_spawn/worker_stop), so it comes after.
  const orchMcp = new OrchestrationMcpRouter(db, sessions);

  const app = await buildServer({ db, pty, sessions, mcp, orchMcp, control });
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
  const scheduler = new Scheduler({ db, control, startManager: (topicId) => sessions.startManager(topicId), intervalMs });
  if (schedulerEnabled) {
    scheduler.start();
    console.log(`[boot] scheduler enabled (tick ${intervalMs}ms)`);
  } else {
    console.log("[boot] scheduler disabled (set orchestration.schedulerEnabled or LOOM_SCHEDULER_ENABLED=1)");
  }
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => { scheduler.stop(); process.exit(0); });
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Loom daemon failed to start:", err);
  process.exit(1);
});
