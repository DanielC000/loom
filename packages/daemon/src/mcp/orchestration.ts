import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Db } from "../db.js";
import type { SessionService } from "../sessions/service.js";
import { readTranscript } from "../sessions/transcript.js";

// Same envelope as the task MCP server (mcp/server.ts).
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

interface Live {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

/**
 * Orchestration MCP server (phase-2 §A2) — the MANAGER's read surface. The session id arrives
 * in the URL path (/mcp-orch/:sessionId); we resolve it to a manager SERVER-SIDE and bind every
 * tool to that manager. The agent never supplies a manager id, so a manager can only ever see
 * its OWN children (same guarantee as §6's task scoping).
 *
 * ROLE GATE: only sessions with role 'manager' get a surface at all — workers and plain
 * sessions resolve to 404 (no tools). One McpServer+transport per manager session, keyed by
 * the URL path (created on first request, reused so the initialize handshake holds).
 */
export class OrchestrationMcpRouter {
  private live = new Map<string, Live>();
  constructor(private db: Db, private sessions: SessionService) {}

  /** The role gate: returns the manager's own id, or null for non-managers / unknown sessions. */
  resolveManager(sessionId: string): string | null {
    return this.db.getSession(sessionId)?.role === "manager" ? sessionId : null;
  }

  private buildServer(managerSessionId: string): McpServer {
    const db = this.db;
    const sessions = this.sessions;
    const server = new McpServer({ name: "loom-orchestration", version: "0.1.0" });

    server.registerTool(
      "worker_list",
      { description: "List the workers you (this manager) have spawned — your direct children.", inputSchema: {} },
      async () => ok(db.listWorkers(managerSessionId).map((w) => ({
        workerSessionId: w.id,
        taskId: w.taskId ?? null,
        processState: w.processState,
        busy: w.busy,
        branch: w.branch ?? null,
        ctxInputTokens: w.ctxInputTokens ?? null,
        lastActivity: w.lastActivity,
      }))),
    );

    server.registerTool(
      "worker_status",
      {
        description: "Get the full session record for one of your workers, by workerSessionId.",
        inputSchema: { workerSessionId: z.string() },
      },
      async ({ workerSessionId }) => {
        const w = db.getSession(workerSessionId);
        if (!w || w.parentSessionId !== managerSessionId) return ok({ error: "not your worker" });
        return ok(w);
      },
    );

    server.registerTool(
      "worker_transcript",
      {
        description: "Read one of your workers' transcript as clean ordered turns; optionally just the last N.",
        inputSchema: { workerSessionId: z.string(), lastN: z.number().optional() },
      },
      async ({ workerSessionId, lastN }) => {
        const w = db.getSession(workerSessionId);
        if (!w || w.parentSessionId !== managerSessionId) return ok({ error: "not your worker" });
        const turns = w.engineSessionId ? readTranscript(w.cwd, w.engineSessionId) : [];
        return ok(typeof lastN === "number" && lastN > 0 ? turns.slice(-lastN) : turns);
      },
    );

    // --- lifecycle actions ---
    server.registerTool(
      "worker_spawn",
      {
        description: "Spawn a worker on a task: creates an isolated git worktree + branch, starts a worker session in it, and moves the task to in_progress.",
        inputSchema: {
          taskId: z.string(),
          topicId: z.string().optional(),
          kickoffPrompt: z.string(),
          skipPermissions: z.boolean().optional(), // accepted but IGNORED until autonomy rails (#17)
        },
      },
      async ({ taskId, topicId, kickoffPrompt }) => {
        const worker = await sessions.spawnWorker(managerSessionId, { taskId, topicId, kickoffPrompt });
        return ok({ workerSessionId: worker.id, branch: worker.branch, worktreePath: worker.worktreePath });
      },
    );

    server.registerTool(
      "worker_stop",
      {
        description: "Stop one of your workers (graceful Ctrl-C by default, or hard kill). The worktree is retained.",
        inputSchema: { workerSessionId: z.string(), mode: z.enum(["graceful", "hard"]).optional() },
      },
      async ({ workerSessionId, mode }) => {
        try {
          sessions.stopWorker(managerSessionId, workerSessionId, mode ?? "graceful");
          return ok({ stopped: true });
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "worker_message",
      {
        description: "Send a message to one of your workers. Submitted as a turn if the worker is idle; queued FIFO and delivered on its next turn boundary if it's mid-turn.",
        inputSchema: { workerSessionId: z.string(), text: z.string() },
      },
      async ({ workerSessionId, text }) => {
        try {
          return ok(sessions.messageWorker(managerSessionId, workerSessionId, text));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    return server;
  }

  /** HTTP entry for /mcp-orch/:sessionId. `body` is the Fastify-parsed JSON (or undefined). */
  async handle(req: IncomingMessage, res: ServerResponse, sessionId: string, body: unknown): Promise<void> {
    const managerId = this.resolveManager(sessionId);
    if (!managerId) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "not a manager session" }));
      return;
    }

    let entry = this.live.get(sessionId);
    if (!entry) {
      const server = this.buildServer(managerId);
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        enableJsonResponse: true,
      });
      transport.onclose = () => { this.live.delete(sessionId); };
      await server.connect(transport);
      entry = { server, transport };
      this.live.set(sessionId, entry);
    }
    await entry.transport.handleRequest(req, res, body);
  }

  /** Tear down a session's orchestration MCP server when the session ends. */
  dispose(sessionId: string): void {
    const entry = this.live.get(sessionId);
    if (!entry) return;
    void entry.transport.close();
    void entry.server.close();
    this.live.delete(sessionId);
  }
}
