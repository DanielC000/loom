import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Db } from "../db.js";
import { listProjectTasks, createProjectTask, updateProjectTask } from "./tasks.js";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

interface Live {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

/**
 * Project-scoped task MCP server. The session id arrives in the URL path
 * (/mcp/:sessionId); we resolve session -> project SERVER-SIDE and bind every tool to that
 * project. The agent never supplies a projectId, so cross-project access is impossible by
 * construction (§6).
 *
 * One McpServer+transport per Loom session (the URL path IS the routing key), created on
 * first request and reused so the MCP initialize handshake holds across requests.
 */
export class TaskMcpRouter {
  private live = new Map<string, Live>();
  constructor(private db: Db) {}

  resolveProject(sessionId: string): string | null {
    return this.db.getSession(sessionId)?.projectId ?? null;
  }

  private buildServer(projectId: string): McpServer {
    const db = this.db;
    const server = new McpServer({ name: "loom-tasks", version: "0.1.0" });

    server.registerTool(
      "tasks_list",
      { description: "List all tasks on the current project's board.", inputSchema: {} },
      async () => ok(listProjectTasks(db, projectId)),
    );
    server.registerTool(
      "tasks_create",
      {
        description: "Create a task on the current project's board.",
        inputSchema: { title: z.string(), body: z.string().optional(), columnKey: z.string().optional() },
      },
      async (args) => ok(createProjectTask(db, projectId, args)),
    );
    server.registerTool(
      "tasks_update",
      {
        description: "Update a task by id, within the current project.",
        inputSchema: {
          id: z.string(),
          title: z.string().optional(),
          body: z.string().optional(),
          columnKey: z.string().optional(),
          position: z.number().optional(),
        },
      },
      async ({ id, ...patch }) => ok(updateProjectTask(db, projectId, id, patch)),
    );
    return server;
  }

  /** HTTP entry for /mcp/:sessionId. `body` is the Fastify-parsed JSON (or undefined). */
  async handle(req: IncomingMessage, res: ServerResponse, sessionId: string, body: unknown): Promise<void> {
    const projectId = this.resolveProject(sessionId);
    if (!projectId) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unknown or expired session" }));
      return;
    }

    let entry = this.live.get(sessionId);
    if (!entry) {
      const server = this.buildServer(projectId);
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

  /** Tear down a session's MCP server when the session ends. */
  dispose(sessionId: string): void {
    const entry = this.live.get(sessionId);
    if (!entry) return;
    void entry.transport.close();
    void entry.server.close();
    this.live.delete(sessionId);
  }
}
