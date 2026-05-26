import type { IncomingMessage, ServerResponse } from "node:http";
import type { Db } from "../db.js";
import { listProjectTasks, createProjectTask, updateProjectTask } from "./tasks.js";

/**
 * Project-scoped task MCP server. The session id arrives in the URL path
 * (/mcp/:sessionId). We resolve session -> project SERVER-SIDE and every tool operates
 * only on that project. The agent never supplies a projectId → cross-project access is
 * impossible by construction (§6).
 *
 * NOTE: the JSON-RPC transport is wired to @modelcontextprotocol/sdk's
 * StreamableHTTPServerTransport as the first build step. The scoping resolver and the
 * task tool logic (./tasks.ts) below are the load-bearing parts and are already real.
 */
export class TaskMcpRouter {
  constructor(private db: Db) {}

  /** Resolve the project for a session id, or null if unknown/expired. */
  resolveProject(sessionId: string): string | null {
    return this.db.getSession(sessionId)?.projectId ?? null;
  }

  /** Tool implementations, pre-bound to a resolved projectId. */
  tools(projectId: string) {
    return {
      tasks_list: () => listProjectTasks(this.db, projectId),
      tasks_create: (i: { title: string; body?: string; columnKey?: string }) =>
        createProjectTask(this.db, projectId, i),
      tasks_update: (id: string, patch: Record<string, unknown>) =>
        updateProjectTask(this.db, projectId, id, patch),
    };
  }

  /** HTTP entry for /mcp/:sessionId. Returns true if handled. */
  async handle(req: IncomingMessage, res: ServerResponse, sessionId: string): Promise<void> {
    const projectId = this.resolveProject(sessionId);
    if (!projectId) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unknown or expired session" }));
      return;
    }
    // TODO(build-step-1): connect an McpServer (tools above) to a
    // StreamableHTTPServerTransport and delegate: await transport.handleRequest(req, res, body).
    res.writeHead(501, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "MCP transport not yet wired", projectId }));
  }
}
