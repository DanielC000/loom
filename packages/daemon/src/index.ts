import { ensureDirs, PORT } from "./paths.js";
import { Db } from "./db.js";
import { sweepDeadSessions, watchClaudeProjects } from "./sessions/liveness.js";
import { seedGlobalSkills } from "./skills/seed.js";
import { PtyHost } from "./pty/host.js";
import { SessionService } from "./sessions/service.js";
import { TaskMcpRouter } from "./mcp/server.js";
import { OrchestrationMcpRouter } from "./mcp/orchestration.js";
import { OrchestrationControl } from "./orchestration/control.js";
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
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Loom daemon failed to start:", err);
  process.exit(1);
});
