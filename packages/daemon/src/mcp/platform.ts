import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Project, ProjectConfigOverride, Topic } from "@loom/shared";
import type { Db } from "../db.js";
import { isGitRepo } from "../git/reader.js";

// Same envelope as the task / orchestration MCP servers.
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

/**
 * The machine-writable config schema the architecture promised: a strict zod mirror of
 * ProjectConfigOverride. `.strict()` everywhere rejects unknown keys (typo guard); types are
 * checked too. ONE validator, shared by project_create + project_configure + the REST PATCH path.
 */
const kanbanColumn = z.object({ key: z.string(), label: z.string() }).strict();
const permissionOverride = z.object({
  mode: z.enum(["default", "acceptEdits", "plan", "bypassPermissions"]).optional(),
  allow: z.array(z.string()).optional(),
  deny: z.array(z.string()).optional(),
}).strict();
const ptyOverride = z.object({ cols: z.number().optional(), rows: z.number().optional() }).strict();
const orchestrationOverride = z.object({
  gateCommand: z.string().optional(),
  maxConcurrentWorkers: z.number().optional(),
  maxConcurrentManagers: z.number().optional(),
  schedulerEnabled: z.boolean().optional(),
  recycleAtContextRatio: z.number().optional(),
}).strict();
const projectConfigOverrideSchema = z.object({
  kanbanColumns: z.array(kanbanColumn).optional(),
  permission: permissionOverride.optional(),
  pty: ptyOverride.optional(),
  sessionEnv: z.record(z.string(), z.string()).optional(),
  orchestration: orchestrationOverride.optional(),
  docLint: z.boolean().optional(),
}).strict();

export function validateProjectConfigOverride(
  raw: unknown,
): { ok: true; value: ProjectConfigOverride } | { ok: false; error: string } {
  const r = projectConfigOverrideSchema.safeParse(raw ?? {});
  if (!r.success) {
    const msg = r.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { ok: false, error: msg };
  }
  return { ok: true, value: r.data as ProjectConfigOverride };
}

/**
 * Platform MCP server (phase-2 Pillar C) — a platform-lead's surface for creating + configuring
 * projects/topics, so the autonomous queue can stand up NEW work, not just drain an existing board.
 * Mirrors the orchestration MCP exactly: keyed by the URL-path session id, resolved SERVER-SIDE,
 * role-gated to 'platform' (manager/worker/plain → 404, no surface). Stateless: a fresh
 * McpServer+transport per request, so no cached transport can be wedged by a dropped stream.
 */
export class PlatformMcpRouter {
  constructor(private db: Db) {}

  /** Role gate: only a platform-lead gets this surface. */
  resolveRole(sessionId: string): { id: string } | null {
    return this.db.getSession(sessionId)?.role === "platform" ? { id: sessionId } : null;
  }

  private buildServer(): McpServer {
    const db = this.db;
    const server = new McpServer({ name: "loom-platform", version: "0.1.0" });

    server.registerTool(
      "project_create",
      {
        description: "Create a Loom project bound to an existing git repo. repoPath MUST exist and be a git repository (rejected otherwise). vaultPath defaults to repoPath. Optional config is validated against the project-config schema.",
        inputSchema: {
          name: z.string(),
          repoPath: z.string(),
          vaultPath: z.string().optional(),
          config: z.object({}).passthrough().optional(),
        },
      },
      async ({ name, repoPath, vaultPath, config }) => {
        const v = config === undefined ? { ok: true as const, value: {} as ProjectConfigOverride } : validateProjectConfigOverride(config);
        if (!v.ok) return ok({ error: `invalid config: ${v.error}` });
        if (!(await isGitRepo(repoPath))) return ok({ error: `repoPath is not an existing git repository: ${repoPath}` });
        const project: Project = {
          id: randomUUID(), name, repoPath, vaultPath: vaultPath ?? repoPath,
          config: v.value, createdAt: new Date().toISOString(), archivedAt: null,
        };
        db.insertProject(project);
        return ok(project);
      },
    );

    server.registerTool(
      "topic_create",
      {
        description: "Create a topic in a project. The startupPrompt is injected as the first turn when a session starts in this topic.",
        inputSchema: {
          projectId: z.string(),
          name: z.string(),
          startupPrompt: z.string().optional(),
        },
      },
      async ({ projectId, name, startupPrompt }) => {
        if (!db.getProject(projectId)) return ok({ error: "project not found" });
        const topic: Topic = {
          id: randomUUID(), projectId, name,
          startupPrompt: startupPrompt ?? "", position: db.listTopics(projectId).length,
        };
        db.insertTopic(topic);
        return ok(topic);
      },
    );

    server.registerTool(
      "project_configure",
      {
        description: "Set a project's config override (validated against the project-config schema). Replaces the project's override; resolveConfig merges it over the platform defaults.",
        inputSchema: {
          projectId: z.string(),
          config: z.object({}).passthrough(),
        },
      },
      async ({ projectId, config }) => {
        if (!db.getProject(projectId)) return ok({ error: "project not found" });
        const v = validateProjectConfigOverride(config);
        if (!v.ok) return ok({ error: `invalid config: ${v.error}` });
        db.setProjectConfig(projectId, v.value);
        return ok({ ok: true, projectId, config: v.value });
      },
    );

    return server;
  }

  /** HTTP entry for /mcp-platform/:sessionId. `body` is the Fastify-parsed JSON (or undefined). */
  async handle(req: IncomingMessage, res: ServerResponse, sessionId: string, body: unknown): Promise<void> {
    if (!this.resolveRole(sessionId)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no platform surface for this session" }));
      return;
    }
    // Stateless per request (see TaskMcpRouter): no cached transport to be wedged by a dropped stream.
    const server = this.buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /** No-op: stateless transports hold no per-session state to tear down (kept for the onExit hook). */
  dispose(_sessionId: string): void {}
}
