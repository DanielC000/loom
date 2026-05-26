import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import type { TerminalInput, Project, Topic, Task, ProjectConfigOverride } from "@loom/shared";
import type { Db } from "../db.js";
import type { PtyHost } from "../pty/host.js";
import type { SessionService } from "../sessions/service.js";
import type { TaskMcpRouter } from "../mcp/server.js";
import { GitReader } from "../git/reader.js";
import { listVaultTree, readVaultFile } from "../vault/browser.js";

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
    reply.hijack(); // hand raw req/res to the MCP transport; pass the Fastify-parsed body
    await deps.mcp.handle(req.raw, reply.raw, sessionId, req.body);
  });

  // --- Hook relay target (loopback only) ---
  app.post("/internal/hook", async (req, reply) => {
    if (!LOOPBACK.has(req.ip)) return reply.code(403).send("forbidden");
    const body = req.body as { sessionId?: string; hook?: Record<string, unknown> };
    if (body?.sessionId && body.hook) deps.pty.deliverHook(body.sessionId, body.hook);
    return reply.send({ ok: true });
  });

  // --- REST: read ---
  app.get("/api/projects", async () => deps.db.listProjects());
  app.get("/api/projects/:id/topics", async (req) =>
    deps.db.listTopics((req.params as { id: string }).id));
  app.get("/api/projects/:id/tasks", async (req) =>
    deps.db.listTasks((req.params as { id: string }).id));
  app.get("/api/topics/:id/sessions", async (req) =>
    deps.db.listSessions((req.params as { id: string }).id));
  // All running/known sessions across projects — for the global Live Terminals grid.
  app.get("/api/sessions", async () => deps.db.listAllSessions());

  // Read-only vault browser (§7: no editing from the UI in phase 1).
  app.get("/api/projects/:id/vault", async (req, reply) => {
    const p = deps.db.getProject((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    return listVaultTree(p.vaultPath);
  });
  app.get("/api/projects/:id/vault/file", async (req, reply) => {
    const p = deps.db.getProject((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    const rel = (req.query as { path?: string }).path ?? "";
    const content = readVaultFile(p.vaultPath, rel);
    if (content === null) return reply.code(404).send({ error: "file not found" });
    return { path: rel, content };
  });

  // Read-only git view (§: no commit/checkout/push from the UI in phase 1).
  app.get("/api/projects/:id/git/log", async (req, reply) => {
    const p = deps.db.getProject((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    return new GitReader(p.repoPath).log();
  });
  app.get("/api/projects/:id/git/branches", async (req, reply) => {
    const p = deps.db.getProject((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    return new GitReader(p.repoPath).branches();
  });

  // --- REST: create / bind ---
  app.post("/api/projects", async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; repoPath?: string; vaultPath?: string; config?: ProjectConfigOverride };
    if (!b.name || !b.repoPath || !b.vaultPath)
      return reply.code(400).send({ error: "name, repoPath, vaultPath required" });
    const project: Project = {
      id: randomUUID(), name: b.name, repoPath: b.repoPath, vaultPath: b.vaultPath,
      config: b.config ?? {}, createdAt: new Date().toISOString(), archivedAt: null,
    };
    deps.db.insertProject(project);
    return reply.code(201).send(project);
  });

  app.post("/api/projects/:id/topics", async (req, reply) => {
    const projectId = (req.params as { id: string }).id;
    if (!deps.db.getProject(projectId)) return reply.code(404).send({ error: "project not found" });
    const b = (req.body ?? {}) as { name?: string; startupPrompt?: string };
    if (!b.name) return reply.code(400).send({ error: "name required" });
    const topic: Topic = {
      id: randomUUID(), projectId, name: b.name,
      startupPrompt: b.startupPrompt ?? "", position: deps.db.listTopics(projectId).length,
    };
    deps.db.insertTopic(topic);
    return reply.code(201).send(topic);
  });

  app.post("/api/projects/:id/tasks", async (req, reply) => {
    const projectId = (req.params as { id: string }).id;
    if (!deps.db.getProject(projectId)) return reply.code(404).send({ error: "project not found" });
    const b = (req.body ?? {}) as { title?: string; body?: string; columnKey?: string };
    if (!b.title) return reply.code(400).send({ error: "title required" });
    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(), projectId, title: b.title, body: b.body ?? "",
      columnKey: b.columnKey ?? "backlog", position: Date.now(), createdAt: now, updatedAt: now,
    };
    deps.db.insertTask(task);
    return reply.code(201).send(task);
  });

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
