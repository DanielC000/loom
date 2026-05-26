import { ensureDirs, PORT } from "./paths.js";
import { Db } from "./db.js";
import { PtyHost } from "./pty/host.js";
import { SessionService } from "./sessions/service.js";
import { TaskMcpRouter } from "./mcp/server.js";
import { buildServer } from "./gateway/server.js";

async function main(): Promise<void> {
  ensureDirs();
  const db = new Db();

  const mcp = new TaskMcpRouter(db);

  // PtyHost callbacks persist runtime state into the registry (engine id on receipt; exit).
  const pty = new PtyHost({
    onEngineSessionId: (sessionId, engineId) => db.setEngineSessionId(sessionId, engineId),
    onExit: (sessionId) => { db.setProcessState(sessionId, "exited"); mcp.dispose(sessionId); },
  });

  const sessions = new SessionService(db, pty);

  const app = await buildServer({ db, pty, sessions, mcp });
  await app.listen({ port: PORT, host: "127.0.0.1" }); // local-first: loopback only
  // eslint-disable-next-line no-console
  console.log(`Loom daemon listening on http://127.0.0.1:${PORT}`);
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Loom daemon failed to start:", err);
  process.exit(1);
});
