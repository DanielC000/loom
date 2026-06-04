import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Project, ProjectConfigOverride, Agent } from "@loom/shared";
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
  // Concurrency caps gate worker_spawn / Scheduler manager launches: whole-number, ≥1 (a cap of 0
  // would deadlock all spawning), with a generous safety ceiling so a fat-fingered value can't
  // authorize a fleet-bomb.
  maxConcurrentWorkers: z.number().int().min(1).max(100).optional(),
  maxConcurrentManagers: z.number().int().min(1).max(100).optional(),
  schedulerEnabled: z.boolean().optional(),
  // Fraction of the model context window (0 disables); a ratio >1 or <0 is meaningless and would
  // corrupt the ContextWatcher's recycle trigger.
  recycleAtContextRatio: z.number().min(0).max(1).optional(),
  // Whole-minute leashes/counters; 0 is honored as a real value (disables the watcher / escalates
  // without nudging), so the floor is 0, not 1. Negative values are nonsensical.
  idleNudgeMinutes: z.number().int().min(0).optional(),
  maxUnansweredNudges: z.number().int().min(0).optional(),
  idleDefaultSnoozeMinutes: z.number().int().min(0).optional(),
}).strict();
const projectConfigOverrideSchema = z.object({
  kanbanColumns: z.array(kanbanColumn).optional(),
  permission: permissionOverride.optional(),
  pty: ptyOverride.optional(),
  sessionEnv: z.record(z.string(), z.string()).optional(),
  orchestration: orchestrationOverride.optional(),
  docLint: z.boolean().optional(),
}).strict();

/**
 * Agent-facing variant of the config schema. `orchestration.gateCommand` is a STRING the daemon
 * later runs via `spawnSync(..., { shell: true })` on the host (see `confirmWorkerMerge` in
 * sessions/service.ts) — i.e. host-RCE-capable by design. It is therefore TRUSTED/human-set only and
 * MUST NOT be writable through the agent-facing loom-platform MCP path. We drop it from the
 * orchestration shape; `.strict()` then makes any `gateCommand` key a REJECTED unknown key, so an
 * agent attempting to set it gets an error and the stored config is left unchanged. DRY: this reuses
 * the same base shapes — only `orchestration` is narrowed. The REST PATCH path keeps the full
 * `projectConfigOverrideSchema` (the human/trusted path), so gateCommand stays human-settable there.
 */
const agentOrchestrationOverride = orchestrationOverride.omit({ gateCommand: true }).strict();
const agentProjectConfigOverrideSchema = projectConfigOverrideSchema
  .extend({ orchestration: agentOrchestrationOverride.optional() })
  .strict();

function formatZodIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
}

/** REST/human path validator: the full schema (gateCommand allowed). */
export function validateProjectConfigOverride(
  raw: unknown,
): { ok: true; value: ProjectConfigOverride } | { ok: false; error: string } {
  const r = projectConfigOverrideSchema.safeParse(raw ?? {});
  if (!r.success) return { ok: false, error: formatZodIssues(r.error) };
  return { ok: true, value: r.data as ProjectConfigOverride };
}

/**
 * Agent (loom-platform MCP) path validator: identical to the REST validator EXCEPT it rejects
 * `orchestration.gateCommand` (host-RCE-capable; trusted/human-set only — see schema note above).
 */
export function validateAgentProjectConfigOverride(
  raw: unknown,
): { ok: true; value: ProjectConfigOverride } | { ok: false; error: string } {
  const r = agentProjectConfigOverrideSchema.safeParse(raw ?? {});
  if (!r.success) return { ok: false, error: formatZodIssues(r.error) };
  return { ok: true, value: r.data as ProjectConfigOverride };
}

/**
 * Platform MCP server (phase-2 Pillar C) — a platform-lead's surface for creating + configuring
 * projects/agents, so the autonomous queue can stand up NEW work, not just drain an existing board.
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
        const v = config === undefined ? { ok: true as const, value: {} as ProjectConfigOverride } : validateAgentProjectConfigOverride(config);
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
      "agent_create",
      {
        description: "Create an agent in a project. The startupPrompt is injected as the first turn when a session starts in this agent. Optionally assign an EXISTING (human-authored) profileId as the agent's rig — you can only assign a profile a human already created, never mint one (a non-existent profileId is rejected).",
        inputSchema: {
          projectId: z.string(),
          name: z.string(),
          startupPrompt: z.string().optional(),
          profileId: z.string().optional(),
        },
      },
      async ({ projectId, name, startupPrompt, profileId }) => {
        if (!db.getProject(projectId)) return ok({ error: "project not found" });
        // Option B: a manager/platform-lead may ASSIGN an existing human-authored profile but never
        // create one — a provided profileId MUST resolve (else reject). Absent ⇒ profile-less agent.
        if (profileId !== undefined && !db.getProfile(profileId)) return ok({ error: "profile not found" });
        const agent: Agent = {
          id: randomUUID(), projectId, name,
          startupPrompt: startupPrompt ?? "", position: db.listAgents(projectId).length,
          profileId: profileId ?? null, // assign the (validated) profile, or stay profile-less
        };
        db.insertAgent(agent);
        return ok(agent);
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
        const v = validateAgentProjectConfigOverride(config);
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
