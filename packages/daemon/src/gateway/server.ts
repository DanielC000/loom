import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import type { TerminalInput } from "@loom/shared";
import type { Db } from "../db.js";
import type { PtyHost } from "../pty/host.js";
import type { SessionService } from "../sessions/service.js";
import type { TaskMcpRouter } from "../mcp/server.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export interface GatewayDeps {
  db: Db;
  pty: PtyHost;
  sessions: SessionService;
  mcp: TaskMcpRouter;
}

export async function buildServer(deps: GatewayDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocket);

  // --- Project-scoped task MCP (session id in the path; project resolved server-side) ---
  app.all("/mcp/:sessionId", async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    reply.hijack();
    await deps.mcp.handle(req.raw, reply.raw, sessionId);
  });

  // --- Hook relay target (loopback only) ---
  app.post("/internal/hook", async (req, reply) => {
    if (!LOOPBACK.has(req.ip)) return reply.code(403).send("forbidden");
    const body = req.body as { sessionId?: string; hook?: Record<string, unknown> };
    if (body?.sessionId && body.hook) deps.pty.deliverHook(body.sessionId, body.hook);
    return reply.send({ ok: true });
  });

  // --- REST (representative subset; expanded during the build) ---
  app.get("/api/projects", async () => deps.db.listProjects());
  app.get("/api/projects/:id/topics", async (req) =>
    deps.db.listTopics((req.params as { id: string }).id));
  app.get("/api/projects/:id/tasks", async (req) =>
    deps.db.listTasks((req.params as { id: string }).id));
  app.get("/api/topics/:id/sessions", async (req) =>
    deps.db.listSessions((req.params as { id: string }).id));

  app.post("/api/topics/:id/sessions", async (req) =>
    deps.sessions.startNew((req.params as { id: string }).id));
  app.post("/api/sessions/:id/resume", async (req) =>
    deps.sessions.resume((req.params as { id: string }).id));
  app.post("/api/sessions/:id/stop", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { mode } = (req.body as { mode?: "graceful" | "hard" }) ?? {};
    deps.pty.stop(id, mode === "hard" ? "hard" : "graceful");
    return reply.send({ ok: true });
  });

  // --- Live terminal: attach/detach (binary pty bytes + JSON control) ---
  app.get("/ws/term/:sessionId", { websocket: true }, (socket: WebSocket, req) => {
    const { sessionId } = req.params as { sessionId: string };
    const unsub = deps.pty.subscribe(sessionId, {
      onData: (b) => { if (socket.readyState === socket.OPEN) socket.send(b); },
      onControl: (e) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(e)); },
    });
    socket.on("message", (raw: Buffer) => {
      let msg: TerminalInput;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "stdin") deps.pty.writeStdin(sessionId, msg.data);
      else if (msg.type === "repaint") deps.pty.repaint(sessionId);
    });
    socket.on("close", unsub); // detach does NOT kill the pty — sessions outlive viewers
  });

  return app;
}
