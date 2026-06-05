import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Project, ProjectConfigOverride, PlatformConfigOverride, Agent, Profile, Schedule } from "@loom/shared";
import type { Db } from "../db.js";
import type { SessionService } from "../sessions/service.js";
import { isGitRepo } from "../git/reader.js";
import { nextFireAt } from "../orchestration/cron.js";
import { validateProfile } from "../profiles/validate.js";

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
  // `sessions` (the SessionService) drives session_spawn/session_stop — the cross-project lifecycle
  // ops. Mirrors OrchestrationMcpRouter(db, sessions). `import type` keeps it a compile-time-only
  // reference (service.ts imports a value from THIS module — a runtime import here would cycle).
  constructor(private db: Db, private sessions: SessionService) {}

  /** Role gate: only a platform-lead gets this surface. */
  resolveRole(sessionId: string): { id: string } | null {
    return this.db.getSession(sessionId)?.role === "platform" ? { id: sessionId } : null;
  }

  private buildServer(): McpServer {
    const db = this.db;
    const sessions = this.sessions;
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

    // === P2 — the Lead's cross-project management surface (read + structural). All platform-role-gated
    // (the router 404s a non-platform session). Each takes an explicit cross-project id and reuses the
    // SAME service/Db methods the human REST paths use. The elevated outward/host ops (gateCommand,
    // alertWebhook, git checkout/commit/push, vault writes) are P3 — deliberately NOT here. ===

    // --- cross-project reads ---
    server.registerTool(
      "list_all_projects",
      {
        description: "List every live project across the platform, INCLUDING the reserved/system home (the ordinary project picker hides reserved ones; this admin view does not). Excludes archived projects. Returns project rows.",
        inputSchema: {},
      },
      async () => ok(db.listAllProjects()),
    );

    server.registerTool(
      "list_all_agents",
      {
        description: "List agents across the platform. Optional projectId narrows to one project (unknown id ⇒ []). With no filter, aggregates the agents of every live project (incl. the reserved home). Returns lightweight agent rows.",
        inputSchema: { projectId: z.string().optional() },
      },
      async ({ projectId }) => {
        if (projectId !== undefined) return ok(db.listAgents(projectId));
        // No db.listAllAgents — aggregate across every live project (reuses listAllProjects + listAgents).
        return ok(db.listAllProjects().flatMap((p) => db.listAgents(p.id)));
      },
    );

    server.registerTool(
      "list_all_sessions",
      {
        description: "List live sessions across the platform (the Mission-Control feed; archived excluded), each enriched with its project + agent name. Optional projectId narrows to one project. Returns lightweight session rows.",
        inputSchema: { projectId: z.string().optional() },
      },
      async ({ projectId }) => {
        const all = db.listAllSessions();
        return ok(projectId === undefined ? all : all.filter((s) => s.projectId === projectId));
      },
    );

    // --- profiles (cross-project rigs). HUMAN-EQUIVALENT ops — gated to the platform role only; the
    // manager/worker surfaces can only ASSIGN a profile, never mint one. Same strict validator
    // (validateProfile) the human REST profile endpoints use; validation is NOT loosened here. ---
    server.registerTool(
      "profile_create",
      {
        description: "Create a cross-project Profile (rig: role + permission allowDelta + skills subset + model + icon + browserTesting). Validated by the SAME strict validator as POST /api/profiles; an unknown/invalid field is rejected and nothing is created.",
        inputSchema: { profile: z.object({}).passthrough() },
      },
      async ({ profile }) => {
        const v = validateProfile(profile);
        if (!v.ok) return ok({ error: `invalid profile: ${v.error}` });
        const created: Profile = { id: randomUUID(), ...v.value };
        db.insertProfile(created);
        return ok(created);
      },
    );

    server.registerTool(
      "profile_update",
      {
        description: "Edit an existing Profile by id: the patch is merged over the current profile, then re-validated by the same strict validator as PUT /api/profiles/:id (so a partial patch still passes). 404 if the id is unknown; an invalid result is rejected and the stored profile is left unchanged.",
        inputSchema: { profileId: z.string(), patch: z.object({}).passthrough() },
      },
      async ({ profileId, patch }) => {
        const existing = db.getProfile(profileId);
        if (!existing) return ok({ error: "profile not found" });
        // Mirror the REST PUT: drop `id` from both sides so a verbatim round-trip doesn't trip .strict().
        const { id: _pid, ...patchNoId } = patch as Record<string, unknown>;
        const { id: _eid, ...base } = existing;
        const v = validateProfile({ ...base, ...patchNoId });
        if (!v.ok) return ok({ error: `invalid profile: ${v.error}` });
        db.updateProfile(profileId, v.value);
        return ok(db.getProfile(profileId));
      },
    );

    server.registerTool(
      "profile_assign",
      {
        description: "Assign an EXISTING profile to an agent (cross-project, explicit agentId). Both the agent and the profile must already exist (404 otherwise). Assignment only — it never mints a profile (use profile_create).",
        inputSchema: { agentId: z.string(), profileId: z.string() },
      },
      async ({ agentId, profileId }) => {
        if (!db.getAgent(agentId)) return ok({ error: "agent not found" });
        if (!db.getProfile(profileId)) return ok({ error: "profile not found" });
        db.updateAgent(agentId, { profileId });
        return ok(db.getAgent(agentId));
      },
    );

    // --- sessions (cross-project lifecycle) ---
    server.registerTool(
      "session_spawn",
      {
        description:
          "Spawn a session into ANY project by explicit projectId + agentId. role MUST be \"manager\" or \"plain\" ONLY: \"manager\" gets the orchestration surface; \"plain\" is a vanilla role-null session (even on a profile agent). NEVER spawns a \"platform\" session (human-REST-only — no self-elevation) and NEVER a \"worker\" (a worker needs a manager parent + a task; that stays a manager's orchestration job). Any other role value is rejected.",
        inputSchema: { projectId: z.string(), agentId: z.string(), role: z.string() },
      },
      async ({ projectId, agentId, role }) => {
        // HARD INVARIANT (single most important of this phase): only manager|plain may be minted here.
        // Reject platform (self-elevation) and worker (manager-owned) — and anything else — explicitly.
        if (role !== "manager" && role !== "plain") {
          return ok({
            error: `session_spawn refuses role "${role}" — only "manager" or "plain" may be spawned here. ` +
              "A platform session is human-REST-only (no self-elevation) and a worker requires a manager parent + task (a manager's orchestration job).",
          });
        }
        try {
          return ok(sessions.spawnSessionAsPlatform(projectId, agentId, role));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "session_stop",
      {
        description: "Stop ANY session by id (cross-project). mode \"graceful\" (default — clean Ctrl-C ×2, resumable) or \"hard\" (pty.kill escalation); both orphan-free. Mirrors POST /api/sessions/:id/stop. 404 if the session is unknown.",
        inputSchema: { sessionId: z.string(), mode: z.enum(["graceful", "hard"]).optional() },
      },
      async ({ sessionId, mode }) => {
        try {
          return ok(sessions.stopSession(sessionId, mode ?? "graceful"));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    // --- projects (cross-project structural edits; config changes go through project_configure) ---
    server.registerTool(
      "project_update",
      {
        description: "Structural edit of any project by id — name and/or vaultPath (omitted fields left as-is). Config changes go through project_configure. 404 if the project is unknown. Returns the updated project.",
        inputSchema: { projectId: z.string(), name: z.string().optional(), vaultPath: z.string().optional() },
      },
      async ({ projectId, name, vaultPath }) => {
        if (!db.getProject(projectId)) return ok({ error: "project not found" });
        db.updateProject(projectId, { name, vaultPath });
        return ok(db.getProject(projectId));
      },
    );

    server.registerTool(
      "project_archive",
      {
        description: "Soft-archive any project by id (hidden from the active list; rows + sessions retained). REFUSES a reserved/system project — the Lead must never archive the platform home. 404 if unknown.",
        inputSchema: { projectId: z.string() },
      },
      async ({ projectId }) => {
        const p = db.getProject(projectId);
        if (!p) return ok({ error: "project not found" });
        // Guard: never let the Lead archive its own reserved home (or any system project).
        if (p.reserved) return ok({ error: "cannot archive a reserved/system project (the Loom Platform home)" });
        db.archiveProject(projectId);
        return ok({ archived: true, projectId });
      },
    );

    // --- schedules (cross-project; explicit agentId — the platform analogue of the manager self-service
    // schedule tools). Mirrors POST /api/schedules: validate agent, compute next_fire_at, persist. ---
    server.registerTool(
      "schedule_create",
      {
        description: "Create a cron schedule that boots a manager session in an agent (explicit cross-project agentId) on each tick (5-field cron). enabled defaults to true. An unknown agent or an invalid cron is rejected. next_fire_at is computed here.",
        inputSchema: { agentId: z.string(), cron: z.string(), enabled: z.boolean().optional() },
      },
      async ({ agentId, cron, enabled }) => {
        if (!db.getAgent(agentId)) return ok({ error: "agent not found" });
        let next: string;
        try { next = nextFireAt(cron, new Date()); } catch { return ok({ error: "invalid cron expression" }); }
        const schedule: Schedule = {
          id: randomUUID(), agentId, cron, enabled: enabled ?? true,
          nextFireAt: next, lastFiredAt: null, createdAt: new Date().toISOString(),
        };
        db.insertSchedule(schedule);
        return ok(schedule);
      },
    );

    server.registerTool(
      "schedule_update",
      {
        description: "Update a schedule's cron and/or enabled flag by id. A changed cron recomputes next_fire_at (rejected if invalid); enabled toggles the Scheduler for this row. Omitted fields are left as-is. 404 if the schedule is unknown.",
        inputSchema: { scheduleId: z.string(), cron: z.string().optional(), enabled: z.boolean().optional() },
      },
      async ({ scheduleId, cron, enabled }) => {
        if (!db.getSchedule(scheduleId)) return ok({ error: "schedule not found" });
        const patch: { cron?: string; enabled?: boolean; nextFireAt?: string } = {};
        if (typeof enabled === "boolean") patch.enabled = enabled;
        if (typeof cron === "string") {
          try { patch.nextFireAt = nextFireAt(cron, new Date()); } catch { return ok({ error: "invalid cron expression" }); }
          patch.cron = cron;
        }
        db.updateSchedule(scheduleId, patch);
        return ok(db.getSchedule(scheduleId));
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
