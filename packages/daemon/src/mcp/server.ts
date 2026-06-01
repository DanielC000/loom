import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Db } from "../db.js";
import { listProjectTasks, createProjectTask, updateProjectTask } from "./tasks.js";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

/**
 * Project-scoped task MCP server. The session id arrives in the URL path
 * (/mcp/:sessionId); we resolve session -> project SERVER-SIDE and bind every tool to that
 * project. The agent never supplies a projectId, so cross-project access is impossible by
 * construction (§6).
 *
 * Stateless: a fresh McpServer+transport is built per request (the URL path supplies the
 * session→project binding). No per-session transport is cached, so a dropped stream can never
 * wedge the surface — every request rebuilds the identical tools from the stable mapping.
 */
export class TaskMcpRouter {
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

    // Stateless per request: sessionIdGenerator undefined → no session state, no validation, so a
    // transient stream close can't strand the session. (The old per-session cache deleted the
    // transport on onclose, and claude never re-initialized a server it thought died → the
    // loom-tasks "drop".) The same surface is rebuilt every request from the session→project map.
    const server = this.buildServer(projectId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /** No-op: stateless transports hold no per-session state to tear down (kept for the onExit hook). */
  dispose(_sessionId: string): void {}
}
