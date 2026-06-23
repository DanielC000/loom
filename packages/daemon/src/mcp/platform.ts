import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Project, ProjectConfigOverride, PlatformConfigOverride, Agent, Profile, Schedule } from "@loom/shared";
import type { Db } from "../db.js";
import type { SessionService } from "../sessions/service.js";
import { isGitRepo } from "../git/reader.js";
import { checkRepoRebind } from "../projects/rebind.js";
import { GitWriter } from "../git/writer.js";
import { writeVaultFile } from "../vault/writer.js";
import { nextFireAt } from "../orchestration/cron.js";
import { validateProfile } from "../profiles/validate.js";
import { validateAgentPatch } from "../agents/validate.js";
import { projectSessionList, filterSessionsByState, DEFAULT_SESSION_SUMMARY_CAP } from "./sessionView.js";
import { skillListData, skillWriteData, skillWriteInputSchema } from "./skillTools.js";

// Same envelope as the task / orchestration MCP servers.
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

/**
 * The machine-writable config schema the architecture promised: a strict zod mirror of
 * ProjectConfigOverride. `.strict()` everywhere rejects unknown keys (typo guard); types are
 * checked too. ONE validator, shared by project_create + project_configure + the REST PATCH path.
 */
// ColumnRole (shared) mirror — kept in lockstep with the ColumnRole union in shared/src/config.ts.
const columnRole = z.enum([
  "intake", "defaultLanding", "workReady", "active", "review", "parked", "humanHold", "terminal",
]);
const kanbanColumn = z.object({ key: z.string(), label: z.string(), role: columnRole.optional() }).strict();
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
  // Busy-worker stuck window (whole minutes; 0 disables the watcher). Same 0-floor rationale as above.
  stuckWorkerMinutes: z.number().int().min(0).optional(),
  // Crash-recovery auto-resume cap (whole number; 0 disables the watcher, serves as enable + cap). A
  // generous ceiling guards a fat-fingered value from authorizing an unbounded resume loop. 0-floor
  // honored as a real value (disable), same rationale as the leashes above.
  crashRecoveryMaxAttempts: z.number().int().min(0).max(100).optional(),
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
  snapshotMs: watcherMs,
  crashRecoveryWatchMs: watcherMs,
}).strict();
const timeoutsOverride = z.object({
  gitOpMs: z.number().int().min(1000).max(120000).optional(),
  gitLocalMs: z.number().int().min(1000).max(120000).optional(),
  gitPushMs: z.number().int().min(1000).max(600000).optional(),
  provisionMs: z.number().int().min(10000).max(1800000).optional(),
  busyStaleMs: z.number().int().min(30000).max(1800000).optional(),
  runMs: z.number().int().min(30000).max(3600000).optional(), // Agent Runs hard run-timeout: 30s..1h
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
 * Body validator for the atomic board-column layout API (task B): a non-empty `columns` array of desired
 * columns, each with key/label, an optional `role`, and an optional `prevKey` marking a KEY rename. Type
 * + shape only — the LIFECYCLE guards (exactly one defaultLanding/terminal, ≥1 floor, valid rename source)
 * live in planColumnLayout, which has the current board to diff against. HUMAN/REST-only (the editor's
 * surface); there is no agent MCP path to it, like the config PATCH.
 */
const desiredColumn = z.object({
  key: z.string().min(1),
  label: z.string().min(1),
  role: columnRole.optional(),
  prevKey: z.string().min(1).optional(),
}).strict();
const columnLayoutSchema = z.object({ columns: z.array(desiredColumn).min(1) }).strict();

export function validateColumnLayout(
  raw: unknown,
): { ok: true; value: { columns: z.infer<typeof desiredColumn>[] } } | { ok: false; error: string } {
  const r = columnLayoutSchema.safeParse(raw ?? {});
  if (!r.success) return { ok: false, error: formatZodIssues(r.error) };
  return { ok: true, value: r.data };
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
  //
  // `gitWriteTimeouts` (P3) are the BOOT-BOUND git-write budgets (resolved once at boot from the
  // daemon-global platform.timeouts, exactly like SessionService's gitOpMs/provisionMs and the gateway's
  // REST git routes), threaded into every GitWriter the elevated git tools construct so a platform git op
  // is bounded EXACTLY like the human REST path. Optional → GitWriter falls back to its module-const
  // defaults (the 2-arg test construction), each floored to ≥1s by GitWriter so a misconfig can't make
  // every git write fail-fast.
  constructor(
    private db: Db,
    private sessions: SessionService,
    private gitWriteTimeouts?: { gitLocalMs: number; gitPushMs: number },
  ) {}

  /** Role gate: only a platform-lead gets this surface. */
  resolveRole(sessionId: string): { id: string } | null {
    return this.db.getSession(sessionId)?.role === "platform" ? { id: sessionId } : null;
  }

  private buildServer(callerSessionId?: string): McpServer {
    const db = this.db;
    const sessions = this.sessions;
    const gitWriteTimeouts = this.gitWriteTimeouts;
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
        // project_create's optional config stays on the AGENT validator deliberately: setting the
        // elevated gateCommand/alertWebhook is the job of the dedicated elevated path (project_configure,
        // full validator). Create-then-configure keeps the host-RCE/exfil keys off the creation flow.
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
          // Agent Runs R1: an agent created via MCP is NEVER an endpoint — publishing an agent as an API
          // endpoint is a HUMAN-only trust-boundary action (the agent-edit REST surface), so this
          // capability-gated create path always mints a non-endpoint agent.
          endpoint: false, ioSchema: null,
        };
        db.insertAgent(agent);
        return ok(agent);
      },
    );

    server.registerTool(
      "agent_update",
      {
        description:
          "Edit an existing agent by id (cross-project). PATCH semantics: only the keys you pass are applied — an omitted key is left as-is; profileId:null CLEARS the assignment (the agent falls back to the plain backstop). Validation is REUSED from the human REST POST /api/agents/:id (agents/validate.ts), so a non-null profileId must reference a real profile (rejected otherwise) exactly like the REST path. 404 if the agent id is unknown. Edits apply to the agent's NEXT new session. NOTE: the HUMAN-only Agent Runs endpoint/ioSchema flags are NOT settable here (human-REST-only, like POST /api/agents/:id's endpoint flag) — use this for name/startupPrompt/profileId.",
        inputSchema: {
          agentId: z.string(),
          name: z.string().optional(),
          startupPrompt: z.string().optional(),
          profileId: z.string().nullable().optional(),
        },
      },
      async (rawArgs) => {
        const { agentId } = rawArgs as { agentId: string };
        if (!db.getAgent(agentId)) return ok({ error: "agent not found" });
        // Drop agentId; the rest IS the PATCH. Use the raw args object so an explicit profileId:null is
        // PRESENT (clears) while an omitted key stays absent (left as-is) — the same presence semantics
        // the REST path relies on. allowEndpointFlags:false: endpoint/ioSchema aren't in the inputSchema,
        // so they can't arrive — the flag is belt-and-suspenders against the human-only Agent Runs surface.
        const { agentId: _aid, ...rawPatch } = rawArgs as Record<string, unknown>;
        const v = validateAgentPatch(rawPatch, (pid) => !!db.getProfile(pid), { allowEndpointFlags: false });
        if (!v.ok) return ok({ error: v.error });
        db.updateAgent(agentId, v.patch);
        return ok(db.getAgent(agentId));
      },
    );

    server.registerTool(
      "project_configure",
      {
        description: "Set a project's config override (validated against the FULL project-config schema). Replaces the project's override; resolveConfig merges it over the platform defaults. As an ELEVATED platform-role tool (P3, trust boundary) this may set the human-only keys the agent path rejects — orchestration.gateCommand / alertWebhook (+ their timeouts) — bounded EXACTLY as the human REST PATCH path (e.g. gateCommandTimeoutMs 1000–1800000, alertWebhookTimeoutMs 500–60000, alertWebhook.url must be a real URL; unknown keys rejected).",
        inputSchema: {
          projectId: z.string(),
          config: z.object({}).passthrough(),
        },
      },
      async ({ projectId, config }) => {
        if (!db.getProject(projectId)) return ok({ error: "project not found" });
        // P3 ELEVATION (trust boundary): the platform role is HUMAN-EQUIVALENT, so config-set on THIS
        // platform-route tool goes through the FULL human/REST validator (validateProjectConfigOverride) —
        // NOT validateAgentProjectConfigOverride. The full validator carries the SAME bounds the REST PATCH
        // path applies, so gateCommand/alertWebhook are settable but still bounded; out-of-bounds/unknown
        // keys are rejected and the stored config is left unchanged. This bypass is keyed STRICTLY to this
        // platform route (resolveRole 404s non-platform); the manager/worker orchestration MCP keeps using
        // validateAgentProjectConfigOverride, which still REJECTS gateCommand/alertWebhook (unchanged).
        const v = validateProjectConfigOverride(config);
        if (!v.ok) return ok({ error: `invalid config: ${v.error}` });
        db.setProjectConfig(projectId, v.value);
        return ok({ ok: true, projectId, config: v.value });
      },
    );

    // === P2 — the Lead's cross-project management surface (read + structural). All platform-role-gated
    // (the router 404s a non-platform session). Each takes an explicit cross-project id and reuses the
    // SAME service/Db methods the human REST paths use. The elevated outward/host ops (gateCommand,
    // alertWebhook, git checkout/commit/push, vault writes) are the P3 block at the BOTTOM of this
    // surface (gateCommand/alertWebhook land via project_configure's full validator, above). ===

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
        description: "List sessions across the platform (archived excluded), each enriched with its project + agent name. state (default \"live\") filters by PROCESS lifecycle: \"live\" = non-exited sessions only (the bounded default — finished sessions that have NOT been archived are dropped, so the feed doesn't grow without limit); \"exited\" = terminated sessions only (history); \"all\" = both. Optional projectId narrows to one project. DEFAULT returns a lightweight SUMMARY per session (id, projectId, projectName, agentName, role, processState, busy, archivedAt, createdAt, lastActivity, model, ctxInputTokens, ctxTurns) so the list stays bounded; heavy fields (title, cwd, engineSessionId, branch, worktree, lineage, errors) are dropped. Pass full:true for whole session records. Optional limit/offset paginate (rows ordered by last activity, newest first); summary reads are capped at " + DEFAULT_SESSION_SUMMARY_CAP + " rows by default — page with limit/offset for more.",
        inputSchema: {
          projectId: z.string().optional(),
          state: z.enum(["live", "exited", "all"]).optional(),
          full: z.boolean().optional(),
          limit: z.number().int().positive().optional(),
          offset: z.number().int().nonnegative().optional(),
        },
      },
      async ({ projectId, state, full, limit, offset }) => {
        const all = filterSessionsByState(db.listAllSessions(), state ?? "live");
        const filtered = projectId === undefined ? all : all.filter((s) => s.projectId === projectId);
        // Backstop the summary feed so an `all`/`exited` history read can't overflow with no explicit limit.
        const effLimit = limit ?? (full ? undefined : DEFAULT_SESSION_SUMMARY_CAP);
        return ok(projectSessionList(filtered, { full, limit: effLimit, offset }));
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
        description: "Structural edit of any project by id — name, vaultPath, and/or repoPath (omitted fields left as-is). Config changes go through project_configure. repoPath REBINDS the project to a different repo: it MUST exist and be a git repository (rejected otherwise, exactly like project_create), and the rebind is REFUSED while the project has any live session occupying a worktree (those would be stranded — the offending sessions are named). This elevated/human-only surface is the ONLY place repoPath is editable. 404 if the project is unknown. Returns the updated project.",
        inputSchema: { projectId: z.string(), name: z.string().optional(), vaultPath: z.string().optional(), repoPath: z.string().optional() },
      },
      async ({ projectId, name, vaultPath, repoPath }) => {
        if (!db.getProject(projectId)) return ok({ error: "project not found" });
        // repoPath REBIND (elevated/human-only): fronted by the SHARED guard (isGitRepo + live-worktree
        // refusal), identical to the human REST PATCH path. Non-repo or a live worktree → reject, no write.
        if (repoPath !== undefined) {
          const check = await checkRepoRebind(db, projectId, repoPath);
          if (!check.ok) return ok({ error: check.error, ...(check.liveSessions ? { liveSessions: check.liveSessions } : {}) });
        }
        db.updateProject(projectId, { name, vaultPath, repoPath });
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
        description: "Create a cron schedule that boots a session in an agent (explicit cross-project agentId) on each tick (5-field cron). kind selects WHAT it spawns: \"manager\" (default — a manager session that runs the orchestration loop), \"auditor\" (the read-and-file-only Platform Auditor, spawned with a locked auditor role), or \"workspace-auditor\" (the suggest-only end-user Workspace Auditor, spawned with a locked workspace-auditor role). enabled defaults to true. An unknown agent or an invalid cron is rejected. next_fire_at is computed here.",
        inputSchema: { agentId: z.string(), cron: z.string(), enabled: z.boolean().optional(), kind: z.enum(["manager", "auditor", "workspace-auditor"]).optional() },
      },
      async ({ agentId, cron, enabled, kind }) => {
        if (!db.getAgent(agentId)) return ok({ error: "agent not found" });
        let next: string;
        try { next = nextFireAt(cron, new Date()); } catch { return ok({ error: "invalid cron expression" }); }
        const schedule: Schedule = {
          id: randomUUID(), agentId, cron, enabled: enabled ?? true,
          nextFireAt: next, lastFiredAt: null, createdAt: new Date().toISOString(),
          kind: kind ?? "manager",
        };
        db.insertSchedule(schedule);
        return ok(schedule);
      },
    );

    server.registerTool(
      "schedule_update",
      {
        description: "Update a schedule's cron, enabled flag, and/or kind (\"manager\"|\"auditor\"|\"workspace-auditor\") by id. A changed cron recomputes next_fire_at (rejected if invalid); enabled toggles the Scheduler for this row; kind changes what a fire spawns. Omitted fields are left as-is. 404 if the schedule is unknown.",
        inputSchema: { scheduleId: z.string(), cron: z.string().optional(), enabled: z.boolean().optional(), kind: z.enum(["manager", "auditor", "workspace-auditor"]).optional() },
      },
      async ({ scheduleId, cron, enabled, kind }) => {
        if (!db.getSchedule(scheduleId)) return ok({ error: "schedule not found" });
        const patch: { cron?: string; enabled?: boolean; nextFireAt?: string; kind?: "manager" | "auditor" | "workspace-auditor" } = {};
        if (typeof enabled === "boolean") patch.enabled = enabled;
        if (kind !== undefined) patch.kind = kind;
        if (typeof cron === "string") {
          try { patch.nextFireAt = nextFireAt(cron, new Date()); } catch { return ok({ error: "invalid cron expression" }); }
          patch.cron = cron;
        }
        db.updateSchedule(scheduleId, patch);
        return ok(db.getSchedule(scheduleId));
      },
    );

    // === P4 — cross-project messaging (the Lead's side). session_message lets the Lead — which stands
    // ABOVE the manager/worker tree — deliver a message to ANY live session in ANY project, with NO
    // parent/child scoping (the deliberate widening over the manager's parent-gated worker_message). It is
    // DELIVERY ONLY: it reuses the stdin-enqueue channel and never spawns. The upward half of the channel,
    // platform_escalate, lives on the MANAGER surface (mcp/orchestration.ts) — NOT here. ===
    server.registerTool(
      "session_message",
      {
        description:
          "Message ANY live session by id, cross-project (the Lead is above the manager/worker tree, so " +
          "there is NO parent/child scoping). Submitted as a turn if the target is idle; queued FIFO and " +
          "delivered on its next turn boundary if it's mid-turn. Framed [loom:from-platform] so the receiver " +
          "knows the source. DELIVERY ONLY — this never spawns anything. 404 if the session is unknown or not live.",
        inputSchema: { sessionId: z.string(), text: z.string() },
      },
      async ({ sessionId, text }) => {
        try {
          // Thread the LEAD's own session id (the URL-path caller) as the durable sender, so a queued
          // dispatch that a daemon restart interrupts can be surfaced back to THIS Lead on resume to
          // re-send (card 2ca18433). `callerSessionId` is always set on the live request path.
          return ok(sessions.messageSessionAsPlatform(sessionId, text, callerSessionId));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    // ===================================================================================================
    // === P3 — THE LEAD'S ELEVATED / HUMAN-EQUIVALENT SURFACE (TRUST BOUNDARY) ===========================
    // ===================================================================================================
    // These tools hand the platform role the ops Loom keeps HUMAN-ONLY everywhere else — git
    // checkout/create-branch/commit/push + raw vault-file writes (and, above, gateCommand/alertWebhook via
    // project_configure's full validator). They are safe ONLY because of two load-bearing invariants:
    //   (1) ROLE GATE — the whole router is gated to role==="platform" (resolveRole 404s manager/worker/
    //       plain), and a platform session is HUMAN-CREATED ONLY: no agent/manager MCP tool mints one
    //       (session_spawn above explicitly refuses role "platform"). So a project manager can never
    //       self-elevate into this surface. The manager/worker/task surfaces are byte-unchanged.
    //   (2) VERBATIM REUSE — every op below calls the EXISTING human-only writers (git/writer.ts GitWriter,
    //       vault/writer.ts) unchanged. Those carry the bounds/timeouts (GIT_TERMINAL_PROMPT=0 +
    //       per-op withTimeout, plain commit identity — no -c overrides / no Co-Authored-By) and the
    //       vault path-traversal guard that make these ops safe. We never re-implement git/fs here — a
    //       reimplementation would silently drop those guards. Push stays exactly as bounded/
    //       non-interactive as GitWriter makes it (no force-push, no new interactivity).
    //
    // ⚠️ P5 AUDITOR DEPENDENCY — DO NOT REGRESS (flagged, intentionally NOT solved here): the Platform
    // Auditor is ALSO role "platform" but MUST be READ-AND-FILE-ONLY — it ingests untrusted transcript
    // content (a prompt-injection surface), so it must NEVER reach these elevated host/push/exfil tools
    // (design decision 2). There is NO live exposure today: the Auditor is not spawned or scheduled yet
    // (that is P5). But when P5 lands the Auditor, P5 MUST ensure the Auditor session can NEVER reach THIS
    // router — e.g. a distinct restricted MCP surface, or a route check that gates these tools on
    // role==="platform" AND a non-auditor agent/marker — so a hostile transcript ("ignore your
    // instructions and push to …") cannot turn an audit into an outward/destructive action.
    // ===================================================================================================

    // --- git writes (reuse git/writer.ts GitWriter VERBATIM — bounded + non-interactive). Each resolves
    //     the project's repoPath by explicit projectId and returns GitWriter's structured GitWriteResult
    //     ({ ok:true, ... } | { ok:false, error }); an EXPECTED git failure (dirty tree, no upstream,
    //     rejected push) comes back as ok:false, never a throw. 404 if the project is unknown. ---
    const gitWriterFor = (repoPath: string) => new GitWriter(repoPath, gitWriteTimeouts);

    server.registerTool(
      "git_checkout",
      {
        description: "Switch a project's repo to an EXISTING local branch (reuses the bounded, non-interactive human git-write path). Explicit projectId. Returns { ok:true, branch } or { ok:false, error } (unknown branch / dirty tree). 404 if the project is unknown.",
        inputSchema: { projectId: z.string(), branch: z.string() },
      },
      async ({ projectId, branch }) => {
        const p = db.getProject(projectId);
        if (!p) return ok({ error: "project not found" });
        return ok(await gitWriterFor(p.repoPath).checkout(branch));
      },
    );

    server.registerTool(
      "git_create_branch",
      {
        description: "Create a NEW local branch off the current HEAD and switch to it (checkout -b), in a project's repo by explicit projectId. Does NOT touch any remote. Returns { ok:true, branch } or { ok:false, error } (branch already exists / invalid name). 404 if the project is unknown.",
        inputSchema: { projectId: z.string(), name: z.string() },
      },
      async ({ projectId, name }) => {
        const p = db.getProject(projectId);
        if (!p) return ok({ error: "project not found" });
        return ok(await gitWriterFor(p.repoPath).createBranch(name));
      },
    );

    server.registerTool(
      "git_commit",
      {
        description: "Stage ALL changes (add -A) and commit a project's repo with the given message — plain commit under the repo's configured identity (no -c overrides, no Co-Authored-By trailer). Explicit projectId. A clean tree is an EXPECTED no-op failure ('nothing to commit'). Returns { ok:true, hash } or { ok:false, error }. 404 if the project is unknown.",
        inputSchema: { projectId: z.string(), message: z.string() },
      },
      async ({ projectId, message }) => {
        const p = db.getProject(projectId);
        if (!p) return ok({ error: "project not found" });
        return ok(await gitWriterFor(p.repoPath).commit(message));
      },
    );

    server.registerTool(
      "git_push",
      {
        description: "Push a project's current branch to its remote — the one genuinely-outward op. Reuses GitWriter.push() VERBATIM: a plain `git push`, retried as `git push -u origin <branch>` ONLY when the branch has no upstream; any other failure (unreachable/auth/rejected) is surfaced unchanged. Bounded + non-interactive (GIT_TERMINAL_PROMPT=0 + push timeout) so a credential-needing remote FAILS FAST rather than hanging. No force-push. Explicit projectId. Returns { ok:true, branch } or { ok:false, error }. 404 if the project is unknown.",
        inputSchema: { projectId: z.string() },
      },
      async ({ projectId }) => {
        const p = db.getProject(projectId);
        if (!p) return ok({ error: "project not found" });
        return ok(await gitWriterFor(p.repoPath).push());
      },
    );

    // --- vault writes (reuse vault/writer.ts writeVaultFile VERBATIM — same mandatory path-traversal
    //     guard that confines every write to the project's vault root, then commits through the vault
    //     auto-committer). Explicit projectId + vault-relative path. ---
    server.registerTool(
      "vault_write",
      {
        description: "Write (create or overwrite) a UTF-8 text file under a project's vault, then commit it through the vault auto-committer (reuses vault/writer.ts writeVaultFile — its mandatory path-traversal guard confines the write to the vault root). Explicit projectId + a vault-relative path. Returns { ok:true, committed } or { ok:false, reason } ('traversal' on a path escape, 'is-dir', 'error'). 404 if the project is unknown.",
        inputSchema: { projectId: z.string(), path: z.string(), content: z.string() },
      },
      async ({ projectId, path: relPath, content }) => {
        const p = db.getProject(projectId);
        if (!p) return ok({ error: "project not found" });
        return ok(await writeVaultFile(p.vaultPath, relPath, content));
      },
    );

    // --- skills (the SUPERSET-closing pair: the ONLY two tools the ungated loom-setup surface carried
    //     that the Lead lacked — see test/surface-subset.mjs). REUSES the SAME validated handlers as
    //     loom-setup (mcp/skillTools.ts), so the confirm-first gate + kebab-slug guard cannot diverge.
    //     skill_list is an identical read; skill_write is the Lead's ELEVATED variant (allowBundledAsset
    //     :true) — its WRITE TARGET reaches the SOURCE-OF-TRUTH bundled ASSET, not only the user store,
    //     which is why it lives in this P3 elevated block (it reuses publishSkillToBundled, the same
    //     store→asset path the human POST /api/skills/:name/publish route uses — no guard bypassed). See
    //     the WRITE TARGET box in mcp/skillTools.ts for the full rationale. ---
    server.registerTool(
      "skill_list",
      {
        description:
          "List the skills in the user's skill store. Each entry has name, description, bundled (a Loom-shipped skill, kept in sync with its asset) and editable (= !bundled). USER (editable) skills ALSO include their full SKILL.md `content` so you can edit them in place; a bundled skill's content is omitted here (use skill_write to edit a bundled skill's source-of-truth asset). Read-only.",
        inputSchema: {},
      },
      async () => ok(skillListData()),
    );

    server.registerTool(
      "skill_write",
      {
        description:
          "Create or update a skill (the Lead's ELEVATED, superset variant of the operator's skill_write). The editable unit is the skill's SKILL.md (frontmatter name/description + body); the full `content` you pass REPLACES it. name must be a kebab slug (a-z, 0-9, -, ≤64 chars). Edits apply to new sessions on next spawn.\n" +
          "WRITE TARGET — unlike the loom-setup operator (USER store only), THIS surface can edit a BUNDLED Loom skill: for a bundled name it writes the SOURCE-OF-TRUTH shipped ASSET (assets/skills/<name>/SKILL.md) via the same validated publish path the human Skills UI uses (store then store→asset, leaving them in sync / diverged:false). A USER (non-bundled) name writes the user store, exactly like the operator surface.\n" +
          "CONFIRM-FIRST (load-bearing): NEVER call this without first showing the user the skill name + content and getting their explicit confirmation. Pass confirm:true to attest you have done so; a missing/false confirm is rejected and nothing is written.",
        inputSchema: skillWriteInputSchema,
      },
      // allowBundledAsset:TRUE — the Lead's bundled-asset edit (the operator surface passes false).
      async ({ name, content, confirm }) => ok(skillWriteData({ name, content, confirm }, { allowBundledAsset: true })),
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
    // Thread the caller (Lead) session id so session_message can record it as the durable sender.
    const server = this.buildServer(sessionId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /** No-op: stateless transports hold no per-session state to tear down (kept for the onExit hook). */
  dispose(_sessionId: string): void {}
}
