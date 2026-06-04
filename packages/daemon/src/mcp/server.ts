import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Db } from "../db.js";
import type { WakeService } from "../orchestration/wake.js";
import { listProjectTasks, getProjectTask, createProjectTask, updateProjectTask } from "./tasks.js";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

/** Task priority enum, shared by the create/update/list tool schemas (rejects any other string). */
export const prioritySchema = z.enum(["p0", "p1", "p2", "p3"]);

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
  constructor(private db: Db, private wakes: WakeService) {}

  resolveProject(sessionId: string): string | null {
    return this.db.getSession(sessionId)?.projectId ?? null;
  }

  private buildServer(projectId: string, sessionId: string): McpServer {
    const db = this.db;
    const wakes = this.wakes;
    const server = new McpServer({ name: "loom-tasks", version: "0.1.0" });

    server.registerTool(
      "tasks_list",
      {
        description:
          "List this project's board tasks. DEFAULT: a lightweight SUMMARY ({id,title,columnKey,position,priority,updatedAt}) — task bodies are OMITTED and terminal/done cards are EXCLUDED, so repeated calls stay bounded. Pass includeBody:true for full bodies, or tasks_get(id) to read one card in full. Filter with columns:[...] (only those column keys), excludeDone:false (include done cards), and/or minPriority:p0|p1|p2|p3 (only tasks at or above that priority; lower number = higher priority).",
        inputSchema: {
          columns: z.array(z.string()).optional(),
          excludeDone: z.boolean().optional(),
          includeBody: z.boolean().optional(),
          minPriority: prioritySchema.optional(),
        },
      },
      async (args) => ok(listProjectTasks(db, projectId, args)),
    );
    server.registerTool(
      "tasks_get",
      {
        description: "Read ONE full task (title + body) by id, within the current project.",
        inputSchema: { id: z.string() },
      },
      async ({ id }) => ok(getProjectTask(db, projectId, id)),
    );
    server.registerTool(
      "tasks_create",
      {
        description: "Create a task on the current project's board. priority is p0|p1|p2|p3 (low number = higher priority), default p2.",
        inputSchema: { title: z.string(), body: z.string().optional(), columnKey: z.string().optional(), priority: prioritySchema.optional() },
      },
      async (args) => ok(createProjectTask(db, projectId, args)),
    );
    server.registerTool(
      "tasks_update",
      {
        description: "Update a task by id, within the current project. priority is p0|p1|p2|p3 (low number = higher priority).",
        inputSchema: {
          id: z.string(),
          title: z.string().optional(),
          body: z.string().optional(),
          columnKey: z.string().optional(),
          position: z.number().optional(),
          priority: prioritySchema.optional(),
        },
      },
      async ({ id, ...patch }) => ok(updateProjectTask(db, projectId, id, patch)),
    );

    // Self-scheduled wake-ups (universal — every session, any role). Keyed to THIS session id.
    server.registerTool(
      "wake_me",
      {
        description:
          "Schedule a one-shot wake-up: end your turn and go idle, and you'll be re-prompted with `note` when it fires (it re-submits as a fresh turn; you're auto-resumed if you were stopped). Give exactly one of delaySeconds or wakeAt (ISO). Use this to WAIT for a known external process/condition — a build, a render, a deploy — instead of busy-polling. Min 30s out, max 24h.",
        inputSchema: {
          delaySeconds: z.number().optional(),
          wakeAt: z.string().optional(),
          note: z.string(),
        },
      },
      async ({ delaySeconds, wakeAt, note }) => {
        try {
          return ok(wakes.schedule(sessionId, { delaySeconds, wakeAt, note }));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );
    server.registerTool(
      "wake_cancel",
      { description: "Cancel one of your pending wake-ups by id.", inputSchema: { wakeId: z.string() } },
      async ({ wakeId }) => ok(wakes.cancel(sessionId, wakeId)),
    );
    server.registerTool(
      "wake_list",
      { description: "List your pending wake-ups.", inputSchema: {} },
      async () => ok(wakes.list(sessionId)),
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
    const server = this.buildServer(projectId, sessionId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /** No-op: stateless transports hold no per-session state to tear down (kept for the onExit hook). */
  dispose(_sessionId: string): void {}
}
