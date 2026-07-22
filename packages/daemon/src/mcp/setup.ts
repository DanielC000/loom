import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Project, ProjectConfigOverride, Agent, Profile } from "@loom/shared";
import type { Db } from "../db.js";
import type { SessionService } from "../sessions/service.js";
import { isGitRepo, checkCommitIdentity } from "../git/reader.js";
import { bootstrapProjectDir, isExistingDir } from "../setup/bootstrap.js";
import { expandTilde } from "../paths.js";
import { validateProfile, agentProfileKeyError } from "../profiles/validate.js";
import { validateAgentPatch } from "../agents/validate.js";
import { validateAgentProjectConfigOverride, mergeConfigOverride, CONFIG_TOP_LEVEL_KEYS } from "./platform.js";
import { ensureVaultRoot } from "../vault/writer.js";
import { validateVaultPath } from "../projects/vault-path.js";
import { setProjectConfigSafe } from "../tasks/columns.js";
import { projectSessionList, filterSessionsByState, DEFAULT_SESSION_SUMMARY_CAP } from "./sessionView.js";
import { projectAgentList, DEFAULT_AGENT_SUMMARY_CAP } from "./agentView.js";
import { skillListData, skillWriteData } from "./skillTools.js";
import { getByIdPrefix } from "../id-prefix.js";
import { WORKFLOW_TEMPLATES, findWorkflowTemplate, applyWorkflowTemplate } from "../setup/templates.js";
import { spawnableRoleError } from "./spawnable-role.js";

// Same envelope as the task / orchestration / platform / audit MCP servers.
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

/**
 * Least-privilege guard for the UNGATED setup surface: a profile minted/edited here may carry ONLY
 * role manager|worker|setup|null — NEVER an elevated "platform"/"auditor" (or the end-user Auditor's
 * "workspace-auditor"). The shared validateProfile stays deliberately broader (it still allows
 * "platform" for the human REST + Platform Lead surfaces, and already forbids "auditor"/"workspace-auditor");
 * this narrow ALLOWLIST runs on the ALREADY-validated role so the ungated Setup Assistant can never mint
 * an elevated-role rig that a later default spawn could silently elevate. "workspace-auditor" is absent
 * from the allowlist, so the operator surface REJECTS it by construction (End-User Platform tier B1 —
 * it's caller-set only by the future startWorkspaceAuditor). Returns an error string when the role is
 * forbidden, else null. Exported so the role-guard unit test can exercise it directly.
 */
const SETUP_ALLOWED_PROFILE_ROLES = new Set<string>(["manager", "worker", "setup"]);
export function setupRoleError(role: string | null | undefined): string | null {
  if (role == null) return null; // null/undefined ⇒ a plain role-null profile, allowed
  if (SETUP_ALLOWED_PROFILE_ROLES.has(role)) return null;
  return `the setup surface cannot create or edit a profile with role "${role}" — only manager, worker, setup, or no role are allowed (an elevated platform/auditor/workspace-auditor rig is human-only).`;
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
 * ║   structure — project_create (bind existing) / project_init (NEW dir under the sanctioned base, the    ║
 * ║               operator's ONLY host-write — confined to WORKSPACE_ROOT) / project_configure /           ║
 * ║               project_update / agent_create                                                            ║
 * ║   rigs       — profile_create / profile_update / profile_assign                                       ║
 * ║   templates  — template_list (read) / template_apply (apply a named workflow template to an           ║
 * ║               EXISTING project — reuses agent_create + task-insert only, NO new writer surface;       ║
 * ║               setupRoleError guard, binds existing profiles only, unknown template/project rejected)  ║
 * ║   lifecycle  — session_spawn (manager|plain ONLY — never platform/auditor/worker/setup);              ║
 * ║                project_archive (SOFT, reversible — REFUSES a reserved/system home; rows retained);     ║
 * ║                end_me (SELF-SCOPED terminal exit, no target arg — always ends the CALLING setup        ║
 * ║                session, never another; card 3b015fc7)                                                 ║
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
 * ║   schedule_create/schedule_update (esp. the auditor kind);                                             ║
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

  buildServer(callerSessionId?: string): McpServer {
    const db = this.db;
    const sessions = this.sessions;
    const server = new McpServer({ name: "loom-setup", version: "0.1.0" });

    // === structure (create-forward + ONE soft, reversible, reserved-guarded teardown: project_archive).
    // All config goes through the AGENT validator. ===
    server.registerTool(
      "project_create",
      {
        description: "Bind a Loom project to an EXISTING path (use project_init to create one from nothing). Give repoPath to bind a CODE project — it MUST exist and be a git repository (rejected otherwise); vaultPath is OPTIONAL for a code project (an Obsidian vault for design docs) — omit it for a project with no vault bound (never defaulted to repoPath, which would make the auto-committer watch the code repo itself). OMIT repoPath and give vaultPath to set up a VAULT-ONLY (research/notes) project whose folder need NOT be a git repo — vaultPath must be an existing directory, and repoPath binds to it too. Optional config is validated against the AGENT project-config schema — orchestration.gateCommand (host-RCE) and alertWebhook (exfil) are REJECTED unknown keys, so the setup assistant can never set them.",
        inputSchema: {
          name: z.string(),
          repoPath: z.string().optional(),
          vaultPath: z.string().optional(),
          config: z.object({}).passthrough().optional(),
        },
      },
      async ({ name, repoPath, vaultPath, config }) => {
        const v = config === undefined ? { ok: true as const, value: {} as ProjectConfigOverride } : validateAgentProjectConfigOverride(config);
        if (!v.ok) return ok({ error: `invalid config: ${v.error}` });
        // Expand a leading `~` (shell expansion Node never sees) BEFORE isGitRepo/isExistingDir, so the
        // STORED path is already the expanded absolute one.
        if (repoPath !== undefined) repoPath = expandTilde(repoPath);
        if (vaultPath !== undefined) vaultPath = expandTilde(vaultPath);
        if (vaultPath) {
          const vaultCheck = validateVaultPath(vaultPath);
          if (!vaultCheck.ok) return ok({ error: vaultCheck.error });
          vaultPath = vaultCheck.value;
        }
        let repo: string;
        let vault: string;
        let isCodeRepo = false;
        if (repoPath !== undefined) {
          // CODE project: repoPath must be an existing git repository. vaultPath is OPTIONAL — an
          // omitted vaultPath stores "" (no vault bound), NEVER defaulted to repoPath: that would make
          // the vault auto-committer watch + auto-commit the user's CODE repo, fighting the worker/
          // merge flow (card cdc3792d).
          if (!(await isGitRepo(repoPath))) return ok({ error: `repoPath is not an existing git repository: ${repoPath}` });
          repo = repoPath;
          vault = vaultPath ?? "";
          // Scaffold the vault root so it's writable immediately (a vault_write against an uncreated
          // root otherwise looks like a path escape) — only when a real vaultPath was actually given.
          if (vault) ensureVaultRoot(vault);
          isCodeRepo = true;
        } else {
          // VAULT-ONLY project: no repo. vaultPath must be an existing directory (need NOT be a git repo) —
          // a research/notes user whose vault isn't a code repo. The project's cwd binds to that folder too.
          if (vaultPath === undefined) return ok({ error: "provide repoPath (an existing git repo) or vaultPath (an existing notes folder for a vault-only project)" });
          if (!isExistingDir(vaultPath)) return ok({ error: `vaultPath is not an existing directory: ${vaultPath}` });
          repo = vaultPath;
          vault = vaultPath;
        }
        const project: Project = {
          id: randomUUID(), name, repoPath: repo, vaultPath: vault,
          config: v.value, createdAt: new Date().toISOString(), archivedAt: null,
          reserved: false, // a setup-created project is NEVER a reserved/system one (boot-seed only)
          referenceRepos: [],
          noGateByDesign: false, // human-only flag (card 58b0bb60); never agent-settable, see project_update
          denyGlobs: ["mockups/**"], // human-only flag (card d5d3bdc9); never agent-settable, see project_update
        };
        db.insertProject(project);
        // Bind-time commit-identity assert (CODE repos only — a vault-only notes folder takes no commits):
        // surface a NON-blocking advisory if no resolvable identity (a later worker/merge commit would
        // FAIL) or one inappropriate for the origin host (the GitHub-vs-Forgejo rule, reused from the git
        // helper). It never blocks the bind — the project is already persisted; the warning rides the result.
        if (isCodeRepo) {
          const identity = await checkCommitIdentity(repo);
          if (identity.warning) return ok({ ...project, identityWarning: identity.warning });
        }
        return ok(project);
      },
    );

    // project_init — the ONE host-write the ungated operator gains, fail-closed by construction: it creates
    // a BRAND-NEW project directory ONLY under the SANCTIONED workspace base (WORKSPACE_ROOT, inside
    // LOOM_HOME), so a fresh user with NO existing repo/folder can be onboarded end-to-end. The caller never
    // supplies a host path — the dir is derived from `name` (or `dirName`), confined to the base, traversal/
    // escape rejected (see bootstrapProjectDir). kind "git" (default) `git init`s a code repo; kind "vault"
    // leaves a plain notes/research folder. This adds NO general host-writer/escalation surface — the write
    // is bounded to one fixed base with hardcoded ops, exactly the least-privilege envelope the surface keeps.
    server.registerTool(
      "project_init",
      {
        description: "Create a BRAND-NEW project from scratch for a user with NO existing repo or folder. Loom creates a fresh directory under its sanctioned workspace base (inside LOOM_HOME) and binds the project to it — you canNOT point this at an arbitrary host path. The directory name is derived from `name` (or pass an explicit `dirName`); both are confined to the sanctioned base and traversal/escape is rejected. kind \"git\" (default) runs `git init` so the project is a code repo ready for workers; kind \"vault\" leaves it a plain notes/research folder (no git). repoPath and vaultPath both bind to the created directory. To bind an EXISTING repo or notes folder instead, use project_create. Optional config is validated against the AGENT schema (gateCommand/alertWebhook rejected).",
        inputSchema: {
          name: z.string(),
          kind: z.enum(["git", "vault"]).optional(),
          dirName: z.string().optional(),
          config: z.object({}).passthrough().optional(),
        },
      },
      async ({ name, kind, dirName, config }) => {
        const v = config === undefined ? { ok: true as const, value: {} as ProjectConfigOverride } : validateAgentProjectConfigOverride(config);
        if (!v.ok) return ok({ error: `invalid config: ${v.error}` });
        const isGit = (kind ?? "git") === "git";
        const boot = await bootstrapProjectDir({ name, dirName, git: isGit });
        if (!boot.ok) return ok({ error: boot.error });
        const project: Project = {
          // kind "git": no vault bound (never defaulted to the fresh code repo — that would make the
          // vault auto-committer watch + auto-commit it, card a247ab11). kind "vault": the created dir
          // IS the vault.
          id: randomUUID(), name, repoPath: boot.dir, vaultPath: isGit ? "" : boot.dir,
          config: v.value, createdAt: new Date().toISOString(), archivedAt: null,
          reserved: false, // a setup-created project is NEVER a reserved/system one (boot-seed only)
          referenceRepos: [],
          noGateByDesign: false, // human-only flag (card 58b0bb60); never agent-settable, see project_update
          denyGlobs: ["mockups/**"], // human-only flag (card d5d3bdc9); never agent-settable, see project_update
        };
        db.insertProject(project);
        // Same bind-time identity assert as project_create, for the git kind (a vault folder takes no
        // commits). A fresh `git init` repo usually has no LOCAL identity, so this surfaces (non-blocking)
        // whether a global identity is even resolvable before a worker ever tries to commit here.
        if (isGit) {
          const identity = await checkCommitIdentity(boot.dir);
          if (identity.warning) return ok({ ...project, identityWarning: identity.warning });
        }
        return ok(project);
      },
    );

    server.registerTool(
      "project_configure",
      {
        description: "PATCH a project's config override: the given keys are DEEP-MERGED into the project's EXISTING override (a single-key change preserves your other overrides — it does NOT clobber them; arrays like kanbanColumns and scalars replace, nested objects merge). projectId accepts the full id OR an unambiguous 8-char id-prefix (mirrors project_get). Validated against the AGENT project-config schema (NOT the elevated platform validator); resolveConfig merges the result over the platform defaults. Settable top-level keys: kanbanColumns (the board's column layout — array of {key,label,role?}), permission, pty, sessionEnv, orchestration, docLint, obsidian. The human-only orchestration.gateCommand (host-RCE) and alertWebhook (data-exfil), obsidian.path/python (host-launch) — and any unknown key — are REJECTED and the stored config is left unchanged.",
        inputSchema: {
          projectId: z.string(),
          config: z.object({}).passthrough(),
        },
      },
      async ({ projectId, config }) => {
        // Accepts a full id OR an unambiguous 8-char id-prefix (mirrors project_get / list_all_agents) —
        // resolve ONCE up front so every subsequent use (merge base + the writer + the final re-read) is
        // keyed off the resolved FULL id, never the raw (possibly-prefix) input.
        const resolved = getByIdPrefix(projectId, (id) => db.getProject(id), () => db.listAllProjects(), "project");
        if ("error" in resolved) return ok(resolved);
        const project = resolved;
        const resolvedProjectId = project.id;
        // FAIL-CLOSED: the AGENT validator — gateCommand/alertWebhook are rejected (unlike the Lead's
        // project_configure, which uses the full human-equivalent validator). This is the load-bearing
        // posture difference of the setup surface.
        const v = validateAgentProjectConfigOverride(config);
        // List the valid top-level keys on rejection so a fat-fingered key (the kanbanColumns-vs-"columns"
        // confusion that motivated this card) converges instead of giving up. gateCommand/alertWebhook/
        // obsidian.path/python stay human-only and are deliberately omitted from the agent-settable hint.
        if (!v.ok) return ok({ error: `invalid config: ${v.error}`, validTopLevelKeys: CONFIG_TOP_LEVEL_KEYS });
        // PATCH/MERGE (card 28c21fe1): deep-merge the VALIDATED partial into the existing override instead
        // of replacing it, so setting one key never clobbers a board's other overrides. The trust boundary
        // is UNCHANGED: the partial is validated by the AGENT validator ABOVE (a human-only key is a
        // rejected unknown and never reaches the merge); a PRE-EXISTING human-set key is preserved but the
        // operator can never INTRODUCE one through this path. The merged whole is not re-validated (see
        // mergeConfigOverride) — re-running the agent validator over a preserved human key would falsely reject.
        const merged = mergeConfigOverride(project.config, v.value);
        // Route through the SAFE writer (not a blind setProjectConfig): a kanbanColumns change that drops/
        // renames a column re-keys the affected cards to the landing lane instead of ORPHANING them on a
        // non-existent column. A non-column / same-key-set patch stays byte-identical to the blind path.
        // (tasks/columns.ts — mirrors the Lead's project_configure + the REST PATCH.)
        const wrote = setProjectConfigSafe(db, resolvedProjectId, merged);
        if (!wrote.ok) return ok({ error: wrote.error });
        return ok({ ok: true, projectId: resolvedProjectId, config: db.getProject(resolvedProjectId)?.config ?? merged });
      },
    );

    server.registerTool(
      "project_update",
      {
        description: "Structural edit of a project by id — name and/or vaultPath, and/or its config override (omitted fields left as-is). repoPath, referenceRepos, and denyGlobs are not editable here (human-only, via the REST/UI). config (when given) is validated against the AGENT project-config schema, so orchestration.gateCommand and alertWebhook — and unknown keys — are REJECTED. 404 if the project is unknown. Returns the updated project.",
        inputSchema: {
          projectId: z.string(),
          name: z.string().optional(),
          vaultPath: z.string().optional(),
          config: z.object({}).passthrough().optional(),
        },
      },
      async ({ projectId, name, vaultPath, config }) => {
        const project = db.getProject(projectId);
        if (!project) return ok({ error: "project not found" });
        if (config !== undefined) {
          const v = validateAgentProjectConfigOverride(config);
          if (!v.ok) return ok({ error: `invalid config: ${v.error}` });
          // PATCH/MERGE — match project_configure: deep-merge the VALIDATED partial into the project's
          // EXISTING override instead of whole-replacing it, so editing one key (e.g. a rename via name/
          // vaultPath alongside a single config key) never CLOBBERS a board's other config overrides.
          // setProjectConfigSafe writes the WHOLE object it's handed (it only re-keys orphaned cards on a
          // column-set change, it does NOT merge), so the merge must happen here. The trust boundary is
          // unchanged: a human-only key is a rejected unknown above and never reaches the merge; the merged
          // whole isn't re-validated (a preserved pre-existing human key would falsely fail the agent validator).
          const merged = mergeConfigOverride(project.config, v.value);
          const wrote = setProjectConfigSafe(db, projectId, merged);
          if (!wrote.ok) return ok({ error: wrote.error });
        }
        if (vaultPath !== undefined) vaultPath = expandTilde(vaultPath);
        if (vaultPath) {
          const vaultCheck = validateVaultPath(vaultPath);
          if (!vaultCheck.ok) return ok({ error: vaultCheck.error });
          vaultPath = vaultCheck.value;
        }
        if (name !== undefined || vaultPath !== undefined) db.updateProject(projectId, { name, vaultPath });
        return ok(db.getProject(projectId));
      },
    );

    // SOFT teardown — the ONE lifecycle cap the operator gains (design Part A / A1). Reuses the dev
    // PlatformMcpRouter.project_archive shape VERBATIM: soft-archive by id (hidden from the active list;
    // rows + sessions retained), REFUSE a reserved/system project so the operator can NEVER archive its
    // own "Getting Started" home (or the dev "Loom Platform" home), 404 on unknown. No outward/host
    // capability — purely local + reversible, so it's the only safe teardown for the ungated surface.
    server.registerTool(
      "project_archive",
      {
        description: "Soft-archive a project by id (hidden from the active list; rows + sessions retained — reversible). REFUSES a reserved/system project so you can never archive the workspace's own home. 404 if unknown.",
        inputSchema: { projectId: z.string() },
      },
      async ({ projectId }) => {
        const p = db.getProject(projectId);
        if (!p) return ok({ error: "project not found" });
        // Guard: never let the operator archive a reserved/system home (the "Getting Started" / "Loom Platform" home).
        if (p.reserved) return ok({ error: "cannot archive a reserved/system project (the workspace home)" });
        db.archiveProject(projectId);
        return ok({ archived: true, projectId });
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

    // Edit an EXISTING agent (the gap that collapsed "action these workspace cards for me" into
    // "here's text, paste it into the UI" — every such card amends an agent's startupPrompt). Mirrors
    // PlatformMcpRouter.agent_update VERBATIM (reuses the SAME validateAgentPatch the human REST POST
    // /api/agents/:id uses, with allowEndpointFlags:false — the human-only endpoint/ioSchema flags aren't
    // even in the inputSchema). LEAST-PRIVILEGE ADDITION over the platform twin: assigning a profile whose
    // RESOLVED role is elevated (platform/auditor/workspace-auditor) is REJECTED here via setupRoleError,
    // exactly like profile_create/update — a setup operator can never elevate an agent by binding it to an
    // elevated rig (which a later default spawn could silently honor). profileId:null CLEARS the assignment.
    server.registerTool(
      "agent_update",
      {
        description:
          "Edit an existing agent by id (cross-project) so you can action workspace-improvement cards directly — amend its startupPrompt / rename it / (re)assign its profile — instead of handing the user text to paste. PATCH semantics: only the keys you pass are applied (omitted keys left as-is); profileId:null CLEARS the assignment (the agent falls back to the plain backstop). agentId accepts the full id OR an unambiguous 8-char id-prefix (same resolution as agent_get). 404 if the agent id is unknown; error if the prefix is ambiguous (names the candidate ids). Edits apply to the agent's NEXT new session. LEAST-PRIVILEGE: the human-only endpoint/ioSchema flags are NOT settable here, and you may NOT assign a profile whose role is platform/auditor/workspace-auditor (a setup operator can never elevate an agent — that's human-only).",
        inputSchema: {
          agentId: z.string(),
          name: z.string().optional(),
          startupPrompt: z.string().optional(),
          profileId: z.string().nullable().optional(),
        },
      },
      async (rawArgs) => {
        const { agentId } = rawArgs as { agentId: string };
        // card (agent_get/agent_update prefix asymmetry): resolve agentId EXACTLY like agent_get does —
        // full id, else an unambiguous 8-char id-prefix across every project (getByIdPrefix) — so a prefix
        // that reads fine here also writes, instead of a silent "agent not found".
        const resolved = getByIdPrefix(agentId, (id) => db.getAgent(id), () => db.listAllProjects().flatMap((p) => db.listAgents(p.id)), "agent");
        if ("error" in resolved) return ok(resolved);
        // Drop agentId; the rest IS the PATCH. Raw args so an explicit profileId:null is PRESENT (clears)
        // while an omitted key stays absent (left as-is) — the same presence semantics the REST path relies
        // on. allowEndpointFlags:false (also absent from inputSchema) keeps the Agent Runs surface human-only.
        const { agentId: _aid, ...rawPatch } = rawArgs as Record<string, unknown>;
        const v = validateAgentPatch(rawPatch, (pid) => !!db.getProfile(pid), { allowEndpointFlags: false });
        if (!v.ok) return ok({ error: v.error });
        // LEAST-PRIVILEGE (setup-only, ON TOP of the shared validator): a non-null profileId is validated to
        // EXIST by validateAgentPatch above, so getProfile resolves — reject if its role is elevated, so the
        // ungated setup surface can never bind an agent to a platform/auditor/workspace-auditor rig.
        if (v.patch.profileId != null) {
          const roleErr = setupRoleError(db.getProfile(v.patch.profileId)?.role);
          if (roleErr) return ok({ error: roleErr });
        }
        db.updateAgent(resolved.id, v.patch);
        return ok(db.getAgent(resolved.id));
      },
    );

    // === templates (Guided Onboarding & Templates, onboarding C2) — read the canonical presets + apply one
    // to an EXISTING project. NO new writer surface: applyWorkflowTemplate (setup/templates.ts) writes only
    // ordinary agent-create + task-insert rows, and checks every templated agent's resolved profile role
    // against setupRoleError before writing it — the same least-privilege allowlist the rest of this surface
    // enforces, so a template can never be an elevation back-door. ===
    server.registerTool(
      "template_list",
      {
        description:
          "List the available workflow templates: each has a name, description, and a roster summary " +
          "(name + bound profile name) of the agents it stands up. Read-only, no secrets, no writes.",
        inputSchema: {},
      },
      async () =>
        ok(
          WORKFLOW_TEMPLATES.map((t) => ({
            name: t.name,
            description: t.description,
            agents: t.agents.map((a) => ({ name: a.name, profileName: a.profileName })),
          })),
        ),
    );

    server.registerTool(
      "template_apply",
      {
        description:
          "Apply a named workflow template to an EXISTING project (by projectId): stands up its agents — " +
          "each bound to an EXISTING bundled profile by name, never minted — and seeds its starter board " +
          "cards. Reuses the existing agent_create + task-insert writers only, no new writer surface. " +
          "Fail-closed: an unknown templateName, an unknown projectId, an unknown profileName, or a " +
          "template whose agent resolves to an elevated profile role (platform/auditor/workspace-auditor) " +
          "are all rejected and nothing is written.",
        inputSchema: {
          projectId: z.string(),
          templateName: z.string(),
        },
      },
      async ({ projectId, templateName }) => {
        // Same project-scope guard as project_configure/project_update/agent_create: resolve by exact id
        // via db.getProject, 404 on unknown — the operator's reach is bounded to a project that actually
        // exists, never widened to an arbitrary/unresolvable target.
        const project = db.getProject(projectId);
        if (!project) return ok({ error: "project not found" });
        const template = findWorkflowTemplate(templateName);
        if (!template) return ok({ error: `unknown workflow template: "${templateName}"` });
        try {
          return ok(applyWorkflowTemplate(db, template, projectId));
        } catch (e) {
          // applyWorkflowTemplate throws on an unknown profileName or an elevated resolved role
          // (setupRoleError) — surface as a clean tool error, not an uncaught exception.
          return ok({ error: (e as Error).message });
        }
      },
    );

    // === rigs (profiles). Same strict validateProfile the human REST profile endpoints use — validation
    // is NOT loosened here. Managing the user's rigs is the assistant's core job. ===
    server.registerTool(
      "profile_create",
      {
        description: "Create a Profile (rig: role + permission allowDelta + skills subset + model + icon + browserTesting + documentConversion + restrictedTools + noCommit). role may be manager|worker|setup or omitted ONLY — an elevated \"platform\"/\"auditor\" role is rejected here (human-only). `connections`/`capabilities`/`vaultWrite` are ALSO rejected here — human-only via the Profiles UI/REST: `connections` grants access to real external secrets, `capabilities` can launch a host process / inject an MCP server, and `vaultWrite` grants confined write access into a project's vault. Otherwise validated by the SAME strict validator as POST /api/profiles; an unknown/invalid field is rejected and nothing is created.",
        inputSchema: { profile: z.object({}).passthrough() },
      },
      async ({ profile }) => {
        const forbiddenErr = agentProfileKeyError(profile);
        if (forbiddenErr) return ok({ error: forbiddenErr });
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
        description: "Edit an existing Profile by id: the patch is merged over the current profile, then re-validated by the same strict validator as PUT /api/profiles/:id (so a partial patch still passes). The RESULTING role may be manager|worker|setup or null ONLY — a patch that yields an elevated \"platform\"/\"auditor\" role is rejected (human-only). The patch may not touch `connections`/`capabilities`/`vaultWrite` (authenticated-egress grants / registry-capability grants / the confined vault-write grant — all human-only, via the Profiles UI/REST); a profile that already has one of these set keeps it across an unrelated patch. 404 if the id is unknown; an invalid result is rejected and the stored profile is left unchanged.",
        inputSchema: { profileId: z.string(), patch: z.object({}).passthrough() },
      },
      async ({ profileId, patch }) => {
        const existing = db.getProfile(profileId);
        if (!existing) return ok({ error: "profile not found" });
        // Mirror the REST PUT: drop `id` from both sides so a verbatim round-trip doesn't trip .strict().
        const { id: _pid, ...patchNoId } = patch as Record<string, unknown>;
        // Reject on the RAW incoming patch (before merge) — a profile that already has `connections` set
        // via human REST must survive an unrelated agent patch untouched; only the agent's OWN attempt to
        // introduce/change the key is rejected.
        const forbiddenErr = agentProfileKeyError(patchNoId);
        if (forbiddenErr) return ok({ error: forbiddenErr });
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
        description: "Assign an EXISTING profile to an agent (explicit agentId + profileId). Both the agent and the profile must already exist (404 otherwise). agentId accepts the full id OR an unambiguous 8-char id-prefix (same resolution as agent_get); error if ambiguous (names the candidate ids). Assignment only — it never mints a profile (use profile_create).",
        inputSchema: { agentId: z.string(), profileId: z.string() },
      },
      async ({ agentId, profileId }) => {
        const agent = getByIdPrefix(agentId, (id) => db.getAgent(id), () => db.listAllProjects().flatMap((p) => db.listAgents(p.id)), "agent");
        if ("error" in agent) return ok(agent);
        const assigned = db.getProfile(profileId);
        if (!assigned) return ok({ error: "profile not found" });
        // LEAST-PRIVILEGE (setup-only): mirror agent_update — reject binding an agent to a profile whose
        // RESOLVED role is elevated (platform/auditor/workspace-auditor), so the ungated setup surface can
        // never plant a latent elevation by this back door. A manager/null/plain rig still assigns fine.
        const roleErr = setupRoleError(assigned.role);
        if (roleErr) return ok({ error: roleErr });
        db.updateAgent(agent.id, { profileId });
        return ok(db.getAgent(agent.id));
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
        description: "List agents across the platform. Optional projectId narrows to one project — accepts the full id OR an unambiguous 8-char id-prefix (mirrors project_get); an unknown/ambiguous id is an EXPLICIT error, never a silent []. With no filter, aggregates the agents of every live project. DEFAULT returns a lightweight SUMMARY per agent (id, projectId, name, position, profileId, endpoint) so the aggregate stays bounded; the heavy startupPrompt + ioSchema are DROPPED. Pass full:true for whole agent rows. Summary reads are capped at " + DEFAULT_AGENT_SUMMARY_CAP + " rows by default. PAGINATION: with NO offset/limit passed and the whole matching set fits in one page, returns the bare agents array (today's shape, unchanged) — otherwise, or whenever you pass offset/limit explicitly, it returns a page envelope {agents, total, returned, offset, nextOffset}, the SAME shape session_transcript uses: total is the true matching-row count, nextOffset is offset+returned while more remains, else null. Page deterministically by calling again with offset:nextOffset until it is null — a capped read is thus self-evidently partial, never mistake a bare array at the cap for 'that's everything'.",
        inputSchema: {
          projectId: z.string().optional(),
          full: z.boolean().optional(),
          limit: z.number().int().positive().optional(),
          offset: z.number().int().nonnegative().optional(),
        },
      },
      async ({ projectId, full, limit, offset }) => {
        // projectId resolves EXACTLY like the sibling cross-project reads (project_get/list_all_sessions) —
        // full id OR unambiguous 8-char prefix, error on unknown/ambiguous (sibling of card 7097f3fb / f10093f).
        let resolvedProjectId: string | undefined;
        if (projectId !== undefined) {
          const project = getByIdPrefix(projectId, (id) => db.getProject(id), () => db.listAllProjects(), "project");
          if ("error" in project) return ok(project);
          resolvedProjectId = project.id;
        }
        const all = resolvedProjectId !== undefined
          ? db.listAgents(resolvedProjectId)
          : db.listAllProjects().flatMap((p) => db.listAgents(p.id));
        // Backstop the summary feed so an aggregate read can't overflow the tool-result cap with no limit.
        const effLimit = limit ?? (full ? undefined : DEFAULT_AGENT_SUMMARY_CAP);
        const total = all.length;
        const off = offset ?? 0;
        const page = projectAgentList(all, { full, limit: effLimit, offset });
        const returned = page.length;
        // nextOffset mirrors session_transcript's pageTranscript convention exactly: offset+returned while
        // more remains under the SAME effective limit, else null — never set when effLimit is unbounded
        // (full:true with no explicit limit already read everything there is).
        const nextOffset = effLimit !== undefined && off + returned < total ? off + returned : null;
        const explicit = offset !== undefined || limit !== undefined;
        // Card 57cb355d / 6500b707: a capped read with NO cap signal let a caller mistake "capped at N" for
        // "N total" — mirrors the platform surface's list_all_agents (c30cf4aa) exactly.
        // Mirror session_transcript's own shape — bare array when the whole matching set fit in one page
        // and the caller didn't page explicitly (today's behavior, unchanged); otherwise the envelope.
        return ok(!explicit && nextOffset === null ? page : { agents: page, total, returned, offset: off, nextOffset });
      },
    );

    server.registerTool(
      "list_all_sessions",
      {
        description: "List sessions across the platform (archived excluded), each enriched with its project + agent name. state (default \"live\") filters by PROCESS lifecycle: \"live\" = non-exited sessions only (the bounded default — finished but un-archived sessions are dropped so the feed doesn't grow without limit); \"exited\" = terminated sessions only (history); \"all\" = both. Optional projectId narrows to one project — accepts the full id OR an unambiguous 8-char id-prefix (mirrors project_get); an unknown/ambiguous id is an EXPLICIT error, never a silent []. DEFAULT returns a lightweight SUMMARY per session so the list stays bounded; pass full:true for whole session records. Optional limit/offset paginate (rows ordered by last activity, newest first); summary reads are capped at " + DEFAULT_SESSION_SUMMARY_CAP + " rows by default. PAGINATION: with NO offset/limit passed and the whole matching set fits in one page, returns the bare sessions array (today's shape, unchanged) — otherwise, or whenever you pass offset/limit explicitly, it returns a page envelope {sessions, total, returned, offset, nextOffset}, the SAME shape session_transcript uses: total is the true matching-row count, nextOffset is offset+returned while more remains, else null. Page deterministically by calling again with offset:nextOffset until it is null — a capped read is thus self-evidently partial, never mistake a bare array at the cap for 'that's everything'.",
        inputSchema: {
          projectId: z.string().optional(),
          state: z.enum(["live", "exited", "all"]).optional(),
          full: z.boolean().optional(),
          limit: z.number().int().positive().optional(),
          offset: z.number().int().nonnegative().optional(),
        },
      },
      async ({ projectId, state, full, limit, offset }) => {
        // projectId resolves EXACTLY like the sibling cross-project reads (project_get) — full id OR
        // unambiguous 8-char prefix, error on unknown/ambiguous — mirrors the platform.ts fix (card 7097f3fb).
        let resolvedProjectId: string | undefined;
        if (projectId !== undefined) {
          const project = getByIdPrefix(projectId, (id) => db.getProject(id), () => db.listAllProjects(), "project");
          if ("error" in project) return ok(project);
          resolvedProjectId = project.id;
        }
        const all = filterSessionsByState(db.listAllSessions(), state ?? "live");
        const filtered = resolvedProjectId === undefined ? all : all.filter((s) => s.projectId === resolvedProjectId);
        const effLimit = limit ?? (full ? undefined : DEFAULT_SESSION_SUMMARY_CAP);
        const total = filtered.length;
        const off = offset ?? 0;
        const page = projectSessionList(filtered, { full, limit: effLimit, offset });
        const returned = page.length;
        // nextOffset mirrors session_transcript's pageTranscript convention exactly: offset+returned while
        // more remains under the SAME effective limit, else null — never set when effLimit is unbounded
        // (full:true with no explicit limit already read everything there is).
        const nextOffset = effLimit !== undefined && off + returned < total ? off + returned : null;
        const explicit = offset !== undefined || limit !== undefined;
        // Card 9ad4dce7: list_all_sessions was the sibling gap list_all_agents (6500b707) already closed.
        // Mirror session_transcript's own shape — bare array when the whole matching set fit in one page
        // and the caller didn't page explicitly (today's behavior, unchanged); otherwise the envelope.
        return ok(!explicit && nextOffset === null ? page : { sessions: page, total, returned, offset: off, nextOffset });
      },
    );

    // Single-record FULL reads (so the operator stops reading via empty-payload mutators — e.g. a
    // `profile_update {}` round-trip just to see a profile). Read-only, scoped like the list_all_* reads;
    // each returns the WHOLE record (incl. the heavy startupPrompt / config the summary feeds drop), or a
    // not-found error. No mutation, no host/outward capability.
    server.registerTool(
      "agent_get",
      {
        description: "Read ONE agent by id — the FULL record incl. its startupPrompt and profileId (the list_all_agents summary drops startupPrompt). Accepts the full id OR an unambiguous 8-char id-prefix (the short id shown in the UI). Read-only. Error if the id is unknown or an ambiguous prefix (the error names the candidate ids).",
        inputSchema: { agentId: z.string() },
      },
      async ({ agentId }) =>
        ok(getByIdPrefix(agentId, (id) => db.getAgent(id), () => db.listAllProjects().flatMap((p) => db.listAgents(p.id)), "agent")),
    );

    server.registerTool(
      "profile_get",
      {
        description: "Read ONE profile (rig) by id — the FULL record (role, permission allowDelta, skills subset, model, icon, browserTesting, documentConversion, restrictedTools, noCommit). Accepts the full id OR an unambiguous 8-char id-prefix. Read-only. Error if the id is unknown or an ambiguous prefix (the error names the candidate ids).",
        inputSchema: { profileId: z.string() },
      },
      async ({ profileId }) =>
        ok(getByIdPrefix(profileId, (id) => db.getProfile(id), () => db.listProfiles(), "profile")),
    );

    server.registerTool(
      "project_get",
      {
        description: "Read ONE project by id — the FULL record incl. its config override (so you can see what's set before a project_configure PATCH). Accepts the full id OR an unambiguous 8-char id-prefix. Read-only. Error if the id is unknown or an ambiguous prefix (the error names the candidate ids).",
        inputSchema: { projectId: z.string() },
      },
      async ({ projectId }) =>
        ok(getByIdPrefix(projectId, (id) => db.getProject(id), () => db.listAllProjects(), "project")),
    );

    // === lifecycle (session_spawn — manager|plain ONLY). Reuses the platform router's hard invariant
    // VERBATIM (sessions.spawnSessionAsPlatform): a setup session can never mint a privileged session. The
    // role refusal itself is the SAME manager|plain-only check as platform.ts's own session_spawn and the
    // companion session-spawn lever, via the ONE shared spawnableRoleError helper (mcp/spawnable-role.ts)
    // — so all three agent-facing spawn surfaces can never drift apart on error text or the allowed set. ===
    server.registerTool(
      "session_spawn",
      {
        description:
          "Spawn a session into a project by explicit projectId + agentId. role MUST be \"manager\" or \"plain\" ONLY: \"manager\" gets the orchestration surface; \"plain\" is a vanilla role-null session (even on a profile agent). NEVER spawns a \"platform\", \"auditor\", \"setup\", or \"operator\" session (no self-elevation) and NEVER a \"worker\" (a worker needs a manager parent + task — a manager's orchestration job). Any other role value is rejected.",
        inputSchema: { projectId: z.string(), agentId: z.string(), role: z.string() },
      },
      async ({ projectId, agentId, role }) => {
        // HARD INVARIANT: only manager|plain may be minted here. Reject platform/auditor/setup/operator
        // (self-elevation) and worker (manager-owned) — and anything else — explicitly, as data.
        const roleError = spawnableRoleError(role);
        if (roleError) return ok({ error: roleError });
        try {
          // Narrowed by spawnableRoleError above (only "manager"/"plain" reach here).
          return ok(sessions.spawnSessionAsPlatform(projectId, agentId, role as "manager" | "plain"));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    // end_me (card 3b015fc7) — SELF-SCOPED terminal exit: NO target arg, always ends callerSessionId (the
    // URL-path setup session), never another. Mirrors the manager/Lead end_me; the live-workers gate never
    // applies to a setup session (it has no parented children).
    server.registerTool(
      "end_me",
      {
        description:
          "Request graceful termination of YOUR OWN session — a terminal exit, no successor. Takes no " +
          "argument: Loom always ends the session calling this tool, never another. Loom REFUSES (does not " +
          "stop) if you have unconsumed inbound direction queued (a human composer turn you haven't acted " +
          "on yet) → {stopped:false, reason:\"queued-inbound\", pending:N} — end this turn so it drains " +
          "into your next turn, act on it, THEN re-call end_me. On pass: your session gracefully stops " +
          "(Ctrl-C×2, clean, resumable — the row lands on Archive) and this tool's own reply is delivered " +
          "before your pty dies.",
        inputSchema: {},
      },
      async () => {
        if (!callerSessionId) return ok({ error: "no caller session" });
        try {
          return ok(sessions.endMe(callerSessionId));
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
      async () => ok(skillListData()),
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
      // Shared handler (mcp/skillTools.ts) with allowBundledAsset:FALSE — the load-bearing setup bound:
      // USER store ONLY, a bundled name is REJECTED. Same validated logic the Lead's loom-platform
      // skill_write reuses (with allowBundledAsset:true), so the confirm/slug guards can't diverge.
      async ({ name, content, confirm }) => ok(skillWriteData({ name, content, confirm }, { allowBundledAsset: false })),
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
    const server = this.buildServer(sessionId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /** No-op: stateless transports hold no per-session state to tear down (kept for the onExit hook). */
  dispose(_sessionId: string): void {}
}
