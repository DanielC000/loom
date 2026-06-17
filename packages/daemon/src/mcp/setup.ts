import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Project, ProjectConfigOverride, Agent, Profile } from "@loom/shared";
import type { Db } from "../db.js";
import type { SessionService } from "../sessions/service.js";
import { isGitRepo } from "../git/reader.js";
import { validateProfile } from "../profiles/validate.js";
import { validateAgentProjectConfigOverride } from "./platform.js";
import { projectSessionList } from "./sessionView.js";
import { listSkills, readSkill, writeSkill, isValidSkillName, isBundledSkill } from "../skills/store.js";

// Same envelope as the task / orchestration / platform / audit MCP servers.
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

/**
 * Least-privilege guard for the UNGATED setup surface: a profile minted/edited here may carry ONLY
 * role manager|worker|setup|null — NEVER an elevated "platform" (or "auditor"). The shared
 * validateProfile stays deliberately broader (it still allows "platform" for the human REST + Platform
 * Lead surfaces, and already forbids "auditor"); this narrow check runs on the ALREADY-validated role
 * so the ungated Setup Assistant can never mint an elevated-role rig that a later default spawn could
 * silently elevate. Returns an error string when the role is forbidden, else null.
 */
const SETUP_ALLOWED_PROFILE_ROLES = new Set<string>(["manager", "worker", "setup"]);
function setupRoleError(role: string | null | undefined): string | null {
  if (role == null) return null; // null/undefined ⇒ a plain role-null profile, allowed
  if (SETUP_ALLOWED_PROFILE_ROLES.has(role)) return null;
  return `the setup surface cannot create or edit a profile with role "${role}" — only manager, worker, setup, or no role are allowed (an elevated platform/auditor rig is human-only).`;
}

/**
 * Setup MCP server (Setup Assistant E1-3) — the user-facing onboarding assistant's CURATED,
 * FAIL-CLOSED surface (`loom-setup`, served at /mcp-setup/:sessionId, role-gated to "setup").
 *
 * ╔═ TRUST BOUNDARY — the load-bearing security goal ═══════════════════════════════════════════════════╗
 * ║ The Setup Assistant SHIPS UNGATED to every loomctl user (core-seed, NOT LOOM_DEV-gated), so it is    ║
 * ║ the lower-privilege cousin of the dev-only Platform Lead. It must "act on the user's behalf"          ║
 * ║ (create/configure projects, agents, profiles) WITHOUT ever holding an elevated/outward capability.   ║
 * ║ FAIL-CLOSED BY CONSTRUCTION: a tool that is not registered here cannot be reached. This router        ║
 * ║ registers ONLY the curated subset below and reuses the EXISTING validators + Db/service handlers     ║
 * ║ (no re-implementation that could silently drop a guard):                                              ║
 * ║   reads     — list_all_projects / list_all_agents / list_all_sessions                                 ║
 * ║   structure — project_create / project_configure / project_update / agent_create                      ║
 * ║   rigs       — profile_create / profile_update / profile_assign                                       ║
 * ║   lifecycle  — session_spawn (manager|plain ONLY — never platform/auditor/worker/setup)               ║
 * ║   skills     — skill_list (read) / skill_write (USER skills ONLY, confirm-first — never bundled/dev)   ║
 * ║                                                                                                       ║
 * ║ EVERY config-setting path (create/configure/update) routes through validateAgentProjectConfigOverride ║
 * ║ — the AGENT validator — so orchestration.gateCommand (host-RCE via spawnSync at the merge gate) and   ║
 * ║ alertWebhook (data-exfil) are REJECTED unknown keys by construction. This is the deliberate posture   ║
 * ║ difference from PlatformMcpRouter, whose project_configure uses the FULL (human-equivalent) validator.║
 * ║                                                                                                       ║
 * ║ EXPLICITLY ABSENT (the elevated / dev-only / self-improvement surface) — DO NOT ADD ANY OF THESE:     ║
 * ║   git_checkout/create_branch/commit/push, vault_write (host/outward writers — human-only);            ║
 * ║   gateCommand/alertWebhook (excluded via the agent validator above);                                  ║
 * ║   session_message (cross-project, above-the-tree); session_stop;                                      ║
 * ║   schedule_create/schedule_update (esp. the auditor kind); project_archive (teardown);                ║
 * ║   platform_escalate, preset-suggestion, audit_file_finding (those live on other surfaces);            ║
 * ║   skill reset/publish-to-bundled (publishSkillToBundled writes the shipped ASSET — human-only REST,    ║
 * ║   like the vault/git writers); skill_write here is bounded to USER skills and cannot reach the asset.  ║
 * ║                                                                                                       ║
 * ║ A "setup" session ALSO 404s on the Lead's /mcp-platform (PlatformMcpRouter.resolveRole gates          ║
 * ║ "platform"), on /mcp-orch (OrchestrationMcpRouter gates manager|worker) and on /mcp-audit             ║
 * ║ (AuditMcpRouter gates "auditor") — and NO agent/MCP path can mint a "setup" session (session_spawn    ║
 * ║ here refuses it, exactly like platform refuses "platform"). So an agent/non-setup session can never   ║
 * ║ reach this surface, and a setup session can never self-elevate onto an elevated one.                  ║
 * ╚════════════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Mirrors PlatformMcpRouter / AuditMcpRouter exactly: keyed by the URL-path session id, resolved
 * SERVER-SIDE, role-gated (non-setup → 404, no surface). Stateless: a fresh McpServer+transport per
 * request, so no cached transport can be wedged by a dropped stream.
 */
export class SetupMcpRouter {
  // `db` drives the structural/profile/read ops directly (mirrors PlatformMcpRouter's direct-Db pattern —
  // the manager self-service service methods requireManager, so they can't be reused for a setup caller);
  // `sessions` drives session_spawn (cross-project lifecycle, no caller-role check inside). `import type`
  // keeps both compile-time-only (service.ts imports a value from a sibling module — a runtime import here
  // would cycle), mirroring PlatformMcpRouter.
  constructor(
    private db: Db,
    private sessions: SessionService,
  ) {}

  /** Role gate: ONLY a setup session gets this surface (the exact predicate handle() 404s on). */
  resolveRole(sessionId: string): { id: string } | null {
    return this.db.getSession(sessionId)?.role === "setup" ? { id: sessionId } : null;
  }

  buildServer(): McpServer {
    const db = this.db;
    const sessions = this.sessions;
    const server = new McpServer({ name: "loom-setup", version: "0.1.0" });

    // === structure (create-forward; NEVER teardown). All config goes through the AGENT validator. ===
    server.registerTool(
      "project_create",
      {
        description: "Create a Loom project bound to an existing git repo. repoPath MUST exist and be a git repository (rejected otherwise). vaultPath defaults to repoPath. Optional config is validated against the AGENT project-config schema — orchestration.gateCommand (host-RCE) and alertWebhook (exfil) are REJECTED unknown keys, so the setup assistant can never set them.",
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
          reserved: false, // a setup-created project is NEVER a reserved/system one (boot-seed only)
        };
        db.insertProject(project);
        return ok(project);
      },
    );

    server.registerTool(
      "project_configure",
      {
        description: "Set a project's config override, validated against the AGENT project-config schema (NOT the elevated platform validator). Replaces the project's override; resolveConfig merges it over the platform defaults. Can set columns/permission/pty/sessionEnv, but orchestration.gateCommand (host-RCE) and alertWebhook (data-exfil) — and any unknown key — are REJECTED and the stored config is left unchanged.",
        inputSchema: {
          projectId: z.string(),
          config: z.object({}).passthrough(),
        },
      },
      async ({ projectId, config }) => {
        if (!db.getProject(projectId)) return ok({ error: "project not found" });
        // FAIL-CLOSED: the AGENT validator — gateCommand/alertWebhook are rejected (unlike the Lead's
        // project_configure, which uses the full human-equivalent validator). This is the load-bearing
        // posture difference of the setup surface.
        const v = validateAgentProjectConfigOverride(config);
        if (!v.ok) return ok({ error: `invalid config: ${v.error}` });
        db.setProjectConfig(projectId, v.value);
        return ok({ ok: true, projectId, config: v.value });
      },
    );

    server.registerTool(
      "project_update",
      {
        description: "Structural edit of a project by id — name and/or vaultPath, and/or its config override (omitted fields left as-is). repoPath is not editable here. config (when given) is validated against the AGENT project-config schema, so orchestration.gateCommand and alertWebhook — and unknown keys — are REJECTED. 404 if the project is unknown. Returns the updated project.",
        inputSchema: {
          projectId: z.string(),
          name: z.string().optional(),
          vaultPath: z.string().optional(),
          config: z.object({}).passthrough().optional(),
        },
      },
      async ({ projectId, name, vaultPath, config }) => {
        if (!db.getProject(projectId)) return ok({ error: "project not found" });
        if (config !== undefined) {
          const v = validateAgentProjectConfigOverride(config);
          if (!v.ok) return ok({ error: `invalid config: ${v.error}` });
          db.setProjectConfig(projectId, v.value);
        }
        if (name !== undefined || vaultPath !== undefined) db.updateProject(projectId, { name, vaultPath });
        return ok(db.getProject(projectId));
      },
    );

    server.registerTool(
      "agent_create",
      {
        description: "Create an agent in a project. The startupPrompt is injected as the first turn when a session starts in this agent. Optionally assign an EXISTING (human/assistant-authored) profileId as the agent's rig — assignment only (use profile_create to mint a new one); a non-existent profileId is rejected.",
        inputSchema: {
          projectId: z.string(),
          name: z.string(),
          startupPrompt: z.string().optional(),
          profileId: z.string().optional(),
        },
      },
      async ({ projectId, name, startupPrompt, profileId }) => {
        if (!db.getProject(projectId)) return ok({ error: "project not found" });
        if (profileId !== undefined && !db.getProfile(profileId)) return ok({ error: "profile not found" });
        const agent: Agent = {
          id: randomUUID(), projectId, name,
          startupPrompt: startupPrompt ?? "", position: db.listAgents(projectId).length,
          profileId: profileId ?? null,
          // An agent created via the setup MCP is NEVER an API endpoint — publishing one is a HUMAN-only
          // trust-boundary action (the agent-edit REST surface). Mirrors PlatformMcpRouter.agent_create.
          endpoint: false, ioSchema: null,
        };
        db.insertAgent(agent);
        return ok(agent);
      },
    );

    // === rigs (profiles). Same strict validateProfile the human REST profile endpoints use — validation
    // is NOT loosened here. Managing the user's rigs is the assistant's core job. ===
    server.registerTool(
      "profile_create",
      {
        description: "Create a Profile (rig: role + permission allowDelta + skills subset + model + icon + browserTesting). role may be manager|worker|setup or omitted ONLY — an elevated \"platform\"/\"auditor\" role is rejected here (human-only). Otherwise validated by the SAME strict validator as POST /api/profiles; an unknown/invalid field is rejected and nothing is created.",
        inputSchema: { profile: z.object({}).passthrough() },
      },
      async ({ profile }) => {
        const v = validateProfile(profile);
        if (!v.ok) return ok({ error: `invalid profile: ${v.error}` });
        const roleErr = setupRoleError(v.value.role);
        if (roleErr) return ok({ error: roleErr });
        const created: Profile = { id: randomUUID(), ...v.value };
        db.insertProfile(created);
        return ok(created);
      },
    );

    server.registerTool(
      "profile_update",
      {
        description: "Edit an existing Profile by id: the patch is merged over the current profile, then re-validated by the same strict validator as PUT /api/profiles/:id (so a partial patch still passes). The RESULTING role may be manager|worker|setup or null ONLY — a patch that yields an elevated \"platform\"/\"auditor\" role is rejected (human-only). 404 if the id is unknown; an invalid result is rejected and the stored profile is left unchanged.",
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
        // Guard the RESOLVED role (after the merge) — a patch must not be able to elevate a rig to
        // platform/auditor via the ungated setup surface, even if the base profile already held it.
        const roleErr = setupRoleError(v.value.role);
        if (roleErr) return ok({ error: roleErr });
        db.updateProfile(profileId, v.value);
        return ok(db.getProfile(profileId));
      },
    );

    server.registerTool(
      "profile_assign",
      {
        description: "Assign an EXISTING profile to an agent (explicit agentId + profileId). Both the agent and the profile must already exist (404 otherwise). Assignment only — it never mints a profile (use profile_create).",
        inputSchema: { agentId: z.string(), profileId: z.string() },
      },
      async ({ agentId, profileId }) => {
        if (!db.getAgent(agentId)) return ok({ error: "agent not found" });
        if (!db.getProfile(profileId)) return ok({ error: "profile not found" });
        db.updateAgent(agentId, { profileId });
        return ok(db.getAgent(agentId));
      },
    );

    // === reads (orient the assistant) ===
    server.registerTool(
      "list_all_projects",
      {
        description: "List every live project across the platform, INCLUDING reserved/system homes. Excludes archived projects. Returns project rows.",
        inputSchema: {},
      },
      async () => ok(db.listAllProjects()),
    );

    server.registerTool(
      "list_all_agents",
      {
        description: "List agents across the platform. Optional projectId narrows to one project (unknown id ⇒ []). With no filter, aggregates the agents of every live project. Returns lightweight agent rows.",
        inputSchema: { projectId: z.string().optional() },
      },
      async ({ projectId }) => {
        if (projectId !== undefined) return ok(db.listAgents(projectId));
        return ok(db.listAllProjects().flatMap((p) => db.listAgents(p.id)));
      },
    );

    server.registerTool(
      "list_all_sessions",
      {
        description: "List live sessions across the platform (archived excluded), each enriched with its project + agent name. Optional projectId narrows to one project. DEFAULT returns a lightweight SUMMARY per session so the list stays bounded; pass full:true for whole session records. Optional limit/offset paginate (rows ordered by last activity, newest first).",
        inputSchema: {
          projectId: z.string().optional(),
          full: z.boolean().optional(),
          limit: z.number().int().positive().optional(),
          offset: z.number().int().nonnegative().optional(),
        },
      },
      async ({ projectId, full, limit, offset }) => {
        const all = db.listAllSessions();
        const filtered = projectId === undefined ? all : all.filter((s) => s.projectId === projectId);
        return ok(projectSessionList(filtered, { full, limit, offset }));
      },
    );

    // === lifecycle (session_spawn — manager|plain ONLY). Reuses the platform router's hard invariant
    // VERBATIM (sessions.spawnSessionAsPlatform): a setup session can never mint a privileged session. ===
    server.registerTool(
      "session_spawn",
      {
        description:
          "Spawn a session into a project by explicit projectId + agentId. role MUST be \"manager\" or \"plain\" ONLY: \"manager\" gets the orchestration surface; \"plain\" is a vanilla role-null session (even on a profile agent). NEVER spawns a \"platform\", \"auditor\", \"worker\", or \"setup\" session (no self-elevation; a worker needs a manager parent + task). Any other role value is rejected.",
        inputSchema: { projectId: z.string(), agentId: z.string(), role: z.string() },
      },
      async ({ projectId, agentId, role }) => {
        // HARD INVARIANT: only manager|plain may be minted here. Reject platform/auditor/setup
        // (self-elevation) and worker (manager-owned) — and anything else — explicitly, as data.
        if (role !== "manager" && role !== "plain") {
          return ok({
            error: `session_spawn refuses role "${role}" — only "manager" or "plain" may be spawned here. ` +
              "A platform/auditor/setup session is human-REST/boot-only (no self-elevation) and a worker requires a manager parent + task.",
          });
        }
        try {
          return ok(sessions.spawnSessionAsPlatform(projectId, agentId, role));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    // === skills (the user's skill store — USER skills ONLY; never the bundled/dev set) ===
    // The assistant can read + write the user's ~/.loom/skills store directly in-chat (v1 only pointed
    // the user at the Skills UI). BOUNDED STRICTLY to USER skills: skill_write REJECTS any bundled/shipped
    // skill name (isBundledSkill) so it can never modify the bundled/dev skill set — the human Skills UI
    // owns reset/publish of those (publishSkillToBundled, the only path to the asset, is NOT reachable
    // here). writeSkill only ever writes the store (never ASSET_SKILLS), and isValidSkillName is the
    // anti-traversal guard (kebab slug == dir name). CONFIRM-FIRST: skill_write requires an explicit
    // confirm:true, and the setup-assistant doctrine instructs the agent to show the user the skill +
    // get confirmation before calling it (the surface carries no outward capability, so this is the only
    // genuinely-mutating-the-user's-config tool here).
    server.registerTool(
      "skill_list",
      {
        description:
          "List the skills in the user's skill store. Each entry has name, description, bundled (a Loom-shipped skill — read-only on this surface) and editable (= !bundled). USER (editable) skills ALSO include their full SKILL.md `content` so you can edit them in place; a bundled skill's content is omitted here (edit those via the Skills UI). Read-only.",
        inputSchema: {},
      },
      async () => {
        const skills = listSkills().map((s) => {
          const editable = !s.bundled;
          return { ...s, editable, ...(editable ? { content: readSkill(s.name)?.content ?? "" } : {}) };
        });
        return ok({ skills });
      },
    );

    server.registerTool(
      "skill_write",
      {
        description:
          "Create or update a skill in the USER skill store (~/.loom/skills). The editable unit is the skill's SKILL.md (frontmatter name/description + body); the full `content` you pass REPLACES it. name must be a kebab slug (a-z, 0-9, -, ≤64 chars). Edits apply to new sessions on next spawn.\n" +
          "BOUNDED TO USER SKILLS: this REJECTS any name that is a Loom-bundled/shipped skill (e.g. worker, orchestrate, setup-assistant, the platform-* dev skills) — it can NEVER modify the bundled/dev skill set. Use the Skills UI to edit a bundled skill.\n" +
          "CONFIRM-FIRST (load-bearing): NEVER call this without first showing the user the skill name + content and getting their explicit confirmation. Pass confirm:true to attest you have done so; a missing/false confirm is rejected and nothing is written.",
        inputSchema: {
          name: z.string(),
          content: z.string(),
          confirm: z.boolean().optional(),
        },
      },
      async ({ name, content, confirm }) => {
        // CONFIRM-FIRST gate: refuse unless the agent attests it confirmed with the user. The real
        // enforcement is the setup-assistant doctrine (show + confirm before calling); this tool-level
        // attestation makes the requirement legible and fails closed if the agent skips it.
        if (confirm !== true) {
          return ok({ error: "skill_write requires confirm:true — first show the user the skill name + full content and get their explicit confirmation, then retry with confirm:true." });
        }
        if (!isValidSkillName(name)) {
          return ok({ error: "invalid skill name (kebab-case: a-z, 0-9, -, ≤64 chars)" });
        }
        // BOUND (load-bearing): USER skills ONLY. A bundled/shipped name is rejected so this surface can
        // never create a divergent store copy of — or otherwise touch — the bundled/dev skill set.
        if (isBundledSkill(name)) {
          return ok({ error: `"${name}" is a bundled Loom skill — skill_write is bounded to USER skills and cannot modify the bundled/dev skill set. Edit a bundled skill via the Skills UI.` });
        }
        if (!writeSkill(name, content)) return ok({ error: "invalid skill name" });
        return ok({ ok: true, name, bundled: false, skill: listSkills().find((s) => s.name === name) ?? null });
      },
    );

    return server;
  }

  /** HTTP entry for /mcp-setup/:sessionId. `body` is the Fastify-parsed JSON (or undefined). */
  async handle(req: IncomingMessage, res: ServerResponse, sessionId: string, body: unknown): Promise<void> {
    if (!this.resolveRole(sessionId)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no setup surface for this session" }));
      return;
    }
    // Stateless per request (see PlatformMcpRouter): no cached transport to be wedged by a dropped stream.
    const server = this.buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /** No-op: stateless transports hold no per-session state to tear down (kept for the onExit hook). */
  dispose(_sessionId: string): void {}
}
