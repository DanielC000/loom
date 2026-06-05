import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Project, ProjectConfigOverride, PlatformConfigOverride, Agent } from "@loom/shared";
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
// Outbound alert webhook (external delivery). `url` must be a real URL; `events` is the kind
// subset to deliver on. Validated as strings here (the OrchestrationEventKind union is type-only —
// the emitter just `.includes()`-matches, so an unrecognized kind harmlessly never fires).
const alertWebhookSchema = z.object({
  url: z.string().url(),
  events: z.array(z.string().min(1)),
}).strict();
const orchestrationOverride = z.object({
  gateCommand: z.string().optional(),
  // Per-project, HUMAN-only timeout (ms) capping a gateCommand run. Pairs with gateCommand and is
  // omitted from the agent path with it (see agentOrchestrationOverride). Bounded 1000–1800000.
  gateCommandTimeoutMs: z.number().int().min(1000).max(1800000).optional(),
  // HUMAN-only (data-exfiltration vector — see agentOrchestrationOverride). Accepted on this human
  // path; dropped from the agent path so an agent can't redirect orchestration data off-box.
  alertWebhook: alertWebhookSchema.optional(),
  // Per-project, HUMAN-only timeout (ms) capping an alertWebhook POST. Pairs with alertWebhook and is
  // omitted from the agent path with it (see agentOrchestrationOverride). Bounded 500–60000.
  alertWebhookTimeoutMs: z.number().int().min(500).max(60000).optional(),
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
 * Agent-facing variant of the config schema. Two `orchestration` keys are TRUSTED/human-set ONLY and
 * MUST NOT be writable through the agent-facing loom-platform MCP path:
 *   - `gateCommand` — a STRING the daemon later runs via `spawnSync(..., { shell: true })` on the host
 *     (see `confirmWorkerMerge` in sessions/service.ts), i.e. host-RCE-capable by design.
 *   - `alertWebhook` — an outbound URL the daemon POSTs orchestration data to, i.e. a DATA-EXFILTRATION
 *     vector: an agent that could set it would redirect the event stream to an attacker endpoint.
 * Their paired per-project timeouts (`gateCommandTimeoutMs`/`alertWebhookTimeoutMs`) are HUMAN-only too
 * (lead decision) and dropped alongside them. We omit ALL FOUR from the orchestration shape; `.strict()`
 * then makes any of them a REJECTED unknown key, so an agent attempting to set one gets an error and the
 * stored config is left unchanged. DRY: this reuses the same base shapes — only `orchestration` is
 * narrowed. The REST PATCH path keeps the full `projectConfigOverrideSchema` (the human/trusted path),
 * so all four stay human-settable there.
 */
const agentOrchestrationOverride = orchestrationOverride
  .omit({ gateCommand: true, gateCommandTimeoutMs: true, alertWebhook: true, alertWebhookTimeoutMs: true })
  .strict();
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
 * Agent (loom-platform MCP) path validator: identical to the REST validator EXCEPT it rejects the
 * human-only `orchestration.gateCommand` (host-RCE-capable) and `orchestration.alertWebhook`
 * (data-exfiltration vector) — see the schema note above.
 */
export function validateAgentProjectConfigOverride(
  raw: unknown,
): { ok: true; value: ProjectConfigOverride } | { ok: false; error: string } {
  const r = agentProjectConfigOverrideSchema.safeParse(raw ?? {});
  if (!r.success) return { ok: false, error: formatZodIssues(r.error) };
  return { ok: true, value: r.data as ProjectConfigOverride };
}

/**
 * Daemon-GLOBAL platform override schema — a strict zod mirror of `PlatformConfigOverride` (deep-partial
 * of PlatformConfig). Every numeric is `.int()` and range-checked per the epic BOUNDS table, so an
 * out-of-range tuning value is rejected before it can persist + corrupt watcher cadences / timeouts.
 * `.strict()` on every sub-object rejects unknown keys (typo guard). This is HUMAN-only by construction:
 * the per-project schemas are `.strict()` and carry NO `platform` key, so an agent's `platform:{}` is
 * already a rejected unknown key — this schema only ever runs on the human REST `/api/platform/config`.
 */
const rateLimitOverride = z.object({
  defaultBackoffMs: z.number().int().min(60000).max(86400000).optional(),
  resetBufferMs: z.number().int().min(0).max(600000).optional(),
  deadlineAfterResetMs: z.number().int().min(60000).max(86400000).optional(),
  deadlineNoResetMs: z.number().int().min(600000).max(172800000).optional(),
  recencyWindowMs: z.number().int().min(0).max(86400000).optional(),
}).strict();
// Every watcher cadence shares the §bounds 5000–3600000 range (5s floor guards against busy-looping).
const watcherMs = z.number().int().min(5000).max(3600000).optional();
const watchersOverride = z.object({
  contextWatchMs: watcherMs,
  idleWatchMs: watcherMs,
  rateLimitWatchMs: watcherMs,
  usagePollMs: watcherMs,
  wakeMs: watcherMs,
  schedulerMs: watcherMs,
  reconcileMs: watcherMs,
}).strict();
const timeoutsOverride = z.object({
  gitOpMs: z.number().int().min(1000).max(120000).optional(),
  gitLocalMs: z.number().int().min(1000).max(120000).optional(),
  gitPushMs: z.number().int().min(1000).max(600000).optional(),
  provisionMs: z.number().int().min(10000).max(1800000).optional(),
  busyStaleMs: z.number().int().min(30000).max(1800000).optional(),
}).strict();
const platformConfigOverrideSchema = z.object({
  rateLimit: rateLimitOverride.optional(),
  watchers: watchersOverride.optional(),
  timeouts: timeoutsOverride.optional(),
}).strict();

/**
 * Validate a daemon-global platform override (the human REST `/api/platform/config` PATCH body).
 * Mirrors the project validators' shape: `{ok:true,value}` | `{ok:false,error}` with a field-named
 * reason. No agent variant — globals are human-only (see platformConfigOverrideSchema note).
 */
export function validatePlatformConfigOverride(
  raw: unknown,
): { ok: true; value: PlatformConfigOverride } | { ok: false; error: string } {
  const r = platformConfigOverrideSchema.safeParse(raw ?? {});
  if (!r.success) return { ok: false, error: formatZodIssues(r.error) };
  return { ok: true, value: r.data as PlatformConfigOverride };
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
          reserved: false, // an agent-created project is NEVER a reserved/system one (boot-seed only)
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
