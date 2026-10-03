import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Project, ProjectConfigOverride, Agent, Profile } from "@loom/shared";
import { redactAlertWebhookInConfig } from "@loom/shared";
import type { Db } from "../db.js";
import type { SessionService } from "../sessions/service.js";
import { isGitRepo, checkCommitIdentity } from "../git/reader.js";
import { bootstrapProjectDir, isExistingDir } from "../setup/bootstrap.js";
import { expandTilde } from "../paths.js";
import { validateProfile, agentProfileKeyError, agentAssignableProfileError, LOCKED_PROFILE_ROLES } from "../profiles/validate.js";
import { reservedProjectAgentBoundToProfile } from "../agents/clone-core.js";
import { validateAgentPatch, resolveStartupPromptEdit } from "../agents/validate.js";
import { agentCreatePromptWarning, agentUpdatePromptWarning } from "../agents/promptLint.js";
import { validateAgentProjectConfigOverride, mergeConfigOverride, AGENT_CONFIG_TOP_LEVEL_KEYS } from "./platform.js";
import { ensureVaultRoot } from "../vault/writer.js";
import { validateVaultPath, checkVaultPathUpdate, checkVaultRepoTripleContainment, checkVaultOnlyOnUpdate } from "../projects/vault-path.js";
import { setProjectConfigSafe } from "../tasks/columns.js";
import { projectSessionList, filterSessionsByState, DEFAULT_SESSION_SUMMARY_CAP } from "./sessionView.js";
import { projectAgentList, DEFAULT_AGENT_SUMMARY_CAP } from "./agentView.js";
import { projectFields, agentFields, profileFields } from "./entityRowFields.js";
import { spillableAgentGet, spillRowsIfLarge, SPILL_INLINE_BUDGET_CHARS } from "../spill.js";
import { skillListData, skillWriteData } from "./skillTools.js";
import { getByIdPrefix } from "../id-prefix.js";
import { WORKFLOW_TEMPLATES, findWorkflowTemplate, applyWorkflowTemplate, templateAssignableProfileError } from "../setup/templates.js";
import { spawnableRoleError } from "./spawnable-role.js";
import { strictShape } from "./arg-alias.js";

// Same envelope as the task / orchestration / platform / audit MCP servers.
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

/**
 * Least-privilege guard: SETUP_ALLOWED_PROFILE_ROLES permits ONLY manager|worker|null — never an
 * elevated platform/auditor/workspace-auditor (validateProfile stays deliberately broader, human/Lead-only).
 * workspace-auditor is rejected here by construction, caller-set only by the future startWorkspaceAuditor.
 * @decision a933613e — operator/assistant are ALSO excluded here, but not as elevated roles: their
 * session role is locked at their own spawn path, never by this profile field alone.
 *
 * "setup" is excluded here too (card 4d70cc06's code-review ratchet): `PROFILE_SPAWNABLE_ROLES`
 * (`sessions/service.ts`) already drops "setup" at spawn, so a setup-role rig minted through THIS
 * surface is useless — and since `setupLockedRoleError` below refuses ever editing one again once it
 * exists, letting `profile_create` mint one while `profile_update` immediately refused to touch it again
 * was a one-way ratchet with no legitimate use on the other side. Excluding it at MINT time too closes
 * that gap instead of leaving it half-closed.
 *
 * Returns an error string when the role is forbidden, else null. Exported so the role-guard unit test can
 * exercise it directly.
 */
const SETUP_ALLOWED_PROFILE_ROLES = new Set<string>(["manager", "worker"]);
export function setupRoleError(role: string | null | undefined): string | null {
  if (role == null) return null; // null/undefined ⇒ a plain role-null profile, allowed
  if (SETUP_ALLOWED_PROFILE_ROLES.has(role)) return null;
  return `the setup surface cannot create or edit a profile with role "${role}" — only manager, worker, or no role are allowed (platform/auditor/workspace-auditor is elevated + human-only; operator/assistant/setup are excluded here too, but because their session role — or, for "setup", this surface's own operating identity — is locked to an explicit spawn path, not because they're elevated).`;
}

/**
 * Roles this ungated surface may never rebind AWAY FROM, clear, rename, or silently rewrite ONCE
 * ASSIGNED — the target's CURRENT role, never the incoming one (that's `agentAssignableProfileError`'s
 * job at an assignment site, or `setupRoleError`'s at a mint site).
 *
 * @decision 4d70cc06 — do not let this surface rebind/clear/rename an agent, or edit a profile, whose
 * role is anything but manager/worker/null — however the caller reached it (a fresh bind, a rename, a
 * prompt append).
 *
 * Alias of the shared `LOCKED_PROFILE_ROLES` (profiles/validate.ts, card 509176c8) — kept under this
 * file's own established name since its doc comments + the 4d70cc06 decision record already reference it
 * that way. `skills/inject.ts` shares the SAME underlying set for a sibling lock.
 */
const SETUP_LOCKED_ROLES = LOCKED_PROFILE_ROLES;

/** Bare role-lock check against `SETUP_LOCKED_ROLES`, shared by `setupMayTouchAgentError` below and
 *  `profile_update`'s own guard. `subject` names what's being checked, for the error text only. */
function setupLockedRoleError(role: string | null | undefined, subject: string): string | null {
  if (role == null || !SETUP_LOCKED_ROLES.has(role)) return null;
  return `the setup surface cannot edit ${subject} — its role is "${role}", and it may already carry elevated or locked capabilities (e.g. a Companion's withdrawn restrictedTools, an Auditor's brief, or the Setup Assistant's own rig) that this ungated surface must never rebind, clear, or rewrite. Only a human (Profiles/Agents UI or REST) may touch it.`;
}

/**
 * ONE predicate for "may the ungated setup surface touch this EXISTING agent AT ALL" — ANY edit,
 * including a bare rename (card 4d70cc06, B2 + M1 + the code-review's reserved-home name-hijack finding:
 * renaming the real "Companion" away and `agent_create`-ing an impostor under that name would DoS
 * `gateway/server.ts`'s by-NAME default-companion resolution, so a rename can never be the exempt case).
 * Refuses when the agent's CURRENT rig role is locked (`SETUP_LOCKED_ROLES` above) — regardless of what
 * NEW profile the caller is trying to assign, that's `agentAssignableProfileError`'s job — or when the agent lives in a
 * reserved/system project (the Setup Assistant's own home, or the dev-only "Loom Platform" home): every
 * standing agent seeded there (Setup Assistant, Companion, Workspace Auditor, Elevated Operator, and
 * under LOOM_DEV the Platform Lead/Audit) is one of Loom's own agents, never a user's, even on the rare
 * occasion one carries no profile at all. Returns an error string, or null when the agent is safe to touch.
 */
function setupMayTouchAgentError(db: Db, agent: Agent): string | null {
  const project = db.getProject(agent.projectId);
  if (project?.reserved) {
    return "the setup surface cannot edit an agent that lives in a reserved/system project (the workspace home) — this may be the Setup Assistant, Companion, Workspace Auditor, Elevated Operator, or (dev-only) a Platform Lead/Audit agent. Only a human (Profiles/Agents UI or REST) may edit it.";
  }
  const role = agent.profileId != null ? db.getProfile(agent.profileId)?.role : null;
  return setupLockedRoleError(role, "an agent (via its current rig)");
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
 * ║               agentAssignableProfileError guard, binds existing profiles only, unknown                ║
 * ║               template/project rejected)                                                              ║
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
 * @decision 3b015fc7 — end_me above must never take a target argument; binding it to the caller's
 * own session id is the whole least-privilege guarantee.
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
    // @decision 90dc3c8c — every tool registered on this server is auto-approved under codex
    // (CODEX_AUTO_APPROVE_MCP_SERVER_IDS, pty/host.ts) the instant it merges — no separate review.

    // === structure (create-forward + ONE soft, reversible, reserved-guarded teardown: project_archive).
    // All config goes through the AGENT validator. ===
    server.registerTool(
      "project_create",
      {
        description: "Bind a Loom project to an EXISTING path (use project_init to create one from nothing). Give repoPath to bind a CODE project — it MUST exist and be a git repository (rejected otherwise); vaultPath is OPTIONAL for a code project (an Obsidian vault for design docs) — omit it for a project with no vault bound (never defaulted to repoPath, which would make the auto-committer watch the code repo itself). OMIT repoPath and give vaultPath to set up a VAULT-ONLY (research/notes) project whose folder need NOT be a git repo — vaultPath must be an existing directory, and repoPath binds to it too. Optional config is validated against the AGENT project-config schema — orchestration.gateCommand (host-RCE) and alertWebhook (exfil) are REJECTED unknown keys, so the setup assistant can never set them.",
        inputSchema: strictShape({
          name: z.string(),
          repoPath: z.string().optional(),
          vaultPath: z.string().optional(),
          config: z.object({}).passthrough().optional(),
        }),
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
          // Card 5ba4412d (+ review follow-up): the SHARED containment check on the full {repoPath,
          // vaultPath, repos} triple — this surface never accepts `repos`, so it's always [] here.
          const tripleCheck = await checkVaultRepoTripleContainment({ repoPath: repo, vaultPath: vault, repos: [] });
          if (!tripleCheck.ok) return ok({ error: tripleCheck.error });
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
          repos: [], // human-only registry (multi-repo epic 49136451); never agent-settable, see project_update
          vaultOnly: !isCodeRepo, // the vault-only branch above — no separate repo was ever given
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
        inputSchema: strictShape({
          name: z.string(),
          kind: z.enum(["git", "vault"]).optional(),
          dirName: z.string().optional(),
          config: z.object({}).passthrough().optional(),
        }),
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
          repos: [], // human-only registry (multi-repo epic 49136451); never agent-settable, see project_update
          vaultOnly: !isGit, // kind "vault": the created dir IS the vault, no separate repo
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
        description: "PATCH a project's config override: the given keys are DEEP-MERGED into the project's EXISTING override (a single-key change preserves your other overrides — it does NOT clobber them; arrays like kanbanColumns and scalars replace, nested objects merge). projectId accepts the full id OR an unambiguous 8-char id-prefix (mirrors project_get). Validated against the AGENT project-config schema (NOT the elevated platform validator); resolveConfig merges the result over the platform defaults. Settable top-level keys: kanbanColumns (the board's column layout — array of {key,label,role?}), permission, pty, orchestration, docLint, codescape (codescape.enabled — the per-project Codescape opt-in toggle), obsidian (autoStart only — obsidian.path is human-only, see below), python (accepted, but currently has no agent-settable fields — python.interpreterPath is human-only, see below), memory (memory.budgetTokens / topK / maxNotes — project-scoped shared-memory tuning, each clamped to MEMORY_CONFIG_MAX). The human-only orchestration.gateCommand (host-RCE) and alertWebhook (data-exfil), obsidian.path and python.interpreterPath (host-launch), sessionEnv (the internal transport those same host-launch fields ride in as env vars — allowing it would re-open the same capability), and harness (the default vendor CLI a worker spawns) — and any unknown key — are REJECTED and the stored config is left unchanged. The returned config MASKS sessionEnv values (same-length filler, never the real secret) — a pre-existing human-set value never round-trips here as plaintext, even on a patch that never touched it.",
        inputSchema: strictShape({
          projectId: z.string(),
          config: z.object({}).passthrough(),
        }),
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
        // confusion that motivated this card) converges instead of giving up. AGENT_CONFIG_TOP_LEVEL_KEYS
        // (not the platform router's CONFIG_TOP_LEVEL_KEYS) — this surface validates against the AGENT
        // schema, which omits sessionEnv entirely; hinting the full key set here would repeat the exact
        // false-positive card `a6f1b29b` fixed in this tool's description, just in the rejection payload
        // instead of the prose.
        if (!v.ok) return ok({ error: `invalid config: ${v.error}`, validTopLevelKeys: AGENT_CONFIG_TOP_LEVEL_KEYS });
        // PATCH/MERGE (card 28c21fe1): deep-merge the VALIDATED partial into the existing override instead
        // of replacing it, so setting one key never clobbers a board's other overrides. The trust boundary
        // is UNCHANGED: the partial is validated by the AGENT validator ABOVE (a human-only key is a
        // rejected unknown and never reaches the merge); a PRE-EXISTING human-set key is preserved but the
        // operator can never INTRODUCE one through this path. The merged whole is not re-validated (see
        // mergeConfigOverride) — re-running the agent validator over a preserved human key would falsely reject.
        // additiveOnlyRotationGuard (card 1069c8e1): agent-facing surface — rotationMarkers/
        // rotationLiveCommitmentsFloor may only grow through this path, never shrink.
        // additiveOnlyPermissionDenyGuard (card f021e26d): same reasoning — an agent patch can never wipe
        // a human-set permission.deny list.
        const merged = mergeConfigOverride(project.config, v.value, { additiveOnlyRotationGuard: true, additiveOnlyPermissionDenyGuard: true });
        // Route through the SAFE writer (not a blind setProjectConfig): a kanbanColumns change that drops/
        // renames a column re-keys the affected cards to the landing lane instead of ORPHANING them on a
        // non-existent column. A non-column / same-key-set patch stays byte-identical to the blind path.
        // (tasks/columns.ts — mirrors the Lead's project_configure + the REST PATCH.)
        // actor (card a0cafef2): this is an AGENT-facing surface (the Setup Assistant / "Platform"
        // operator, ships to ALL users) — hardcoding "human" would be a false attribution.
        const wrote = setProjectConfigSafe(db, resolvedProjectId, merged, callerSessionId ? `setup:${callerSessionId}` : "setup");
        if (!wrote.ok) return ok({ error: wrote.error });
        // @decision 5d6e0ace — sessionEnv NEVER appears here as a value-shaped string (masked or real): a
        // masked value is itself an ACCEPTED write payload (idempotent + unrecoverable). sessionEnvKeys
        // (lengths only) is a key this schema's .strict() rejects, so resubmitting `config` verbatim fails.
        //
        // This surface's OWN agent validator already rejects sessionEnv outright, so the round-trip the
        // decision above guards against is unreachable HERE — kept identical to platform.ts for a
        // consistent response shape across both project_configure tools.
        const finalConfig = db.getProject(resolvedProjectId)?.config ?? merged;
        const { sessionEnv, ...configSansSessionEnv } = finalConfig;
        const sessionEnvKeys = sessionEnv
          ? Object.fromEntries(Object.entries(sessionEnv).map(([name, value]) => [name, String(value ?? "").length]))
          : undefined;
        // @decision eccd874c — alertWebhook.url is masked here too: this surface can never WRITE it, but a
        // benign change (e.g. docLint) still echoes the project's PRE-EXISTING config, which would
        // otherwise leak a value this agent could never have set itself.
        const maskedConfig = redactAlertWebhookInConfig(configSansSessionEnv);
        return ok({
          ok: true, projectId: resolvedProjectId,
          config: sessionEnvKeys === undefined ? maskedConfig : { ...maskedConfig, sessionEnvKeys },
        });
      },
    );

    server.registerTool(
      "project_update",
      {
        description: "Structural edit of a project by id — name and/or vaultPath, and/or its config override (omitted fields left as-is). repoPath, referenceRepos, repos (the writable multi-repo registry), and denyGlobs are not editable here (human-only, via the REST/UI). config (when given) is validated against the AGENT project-config schema, so orchestration.gateCommand and alertWebhook — and unknown keys — are REJECTED. 404 if the project is unknown. Returns the updated project. The returned config's sessionEnv values are MASKED (same-length bullet filler, never the real secret) — feeding a masked value back as a later write is rejected, not silently stored.",
        inputSchema: strictShape({
          projectId: z.string(),
          name: z.string().optional(),
          vaultPath: z.string().optional(),
          config: z.object({}).passthrough().optional(),
        }),
      },
      async ({ projectId, name, vaultPath, config }) => {
        const project = db.getProject(projectId);
        if (!project) return ok({ error: "project not found" });
        // SHARED update guard (card 6a48b759): trim/expand/absolute-validate a real rebind, and refuse an
        // explicit "" that would strand a VAULT-ONLY project — the same guard the human REST PATCH path,
        // the manager's project_update, and platform's project_update all now share. Runs FIRST, before
        // any write (code review on 87e21134): together with the containment check just below, these are
        // this handler's ONLY awaits depending on project state (isGitRepo) — running both before the
        // config write means a rejected vaultPath can never leave a PARTIAL apply.
        const vaultCheck = await checkVaultPathUpdate(project, vaultPath);
        if (!vaultCheck.ok) return ok({ error: vaultCheck.error });
        vaultPath = vaultCheck.value;
        // Card 5ba4412d review follow-up: the SHARED containment check on the full effective triple — this
        // surface can never touch repoPath/repos itself, so the only field that can trigger it is vaultPath.
        if (vaultPath !== undefined) {
          const tripleCheck = await checkVaultRepoTripleContainment(
            { repoPath: project.repoPath, vaultPath, repos: project.repos },
            { pairingIsIntentional: project.vaultOnly },
          );
          if (!tripleCheck.ok) return ok({ error: tripleCheck.error });
        }
        // Card b98957e9 (fix round): the SHARED vaultOnly-flag guard — this surface can never touch
        // repoPath, so a vaultPath move that would unpair a vault-only project is REFUSED outright rather
        // than silently leaving a stale `true` fact behind (see checkVaultOnlyOnUpdate's own doc).
        const vaultOnlyCheck = checkVaultOnlyOnUpdate(project, { vaultPath });
        if (!vaultOnlyCheck.ok) return ok({ error: vaultOnlyCheck.error });
        const vaultOnlyPatch = vaultOnlyCheck.vaultOnlyPatch;
        // Re-read AFTER the await, and do every write below off THIS row with NO further await in
        // between — so nothing can land between reading and writing. (The vaultPath validation above
        // still ran against the PRE-await snapshot — a narrower, single-await residual, not something
        // this re-read closes; see checkVaultPathUpdate's own doc for what it checks and when.)
        const fresh = db.getProject(projectId);
        if (!fresh) return ok({ error: "project not found" });
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
          // additiveOnlyRotationGuard (card 1069c8e1) + additiveOnlyPermissionDenyGuard (card f021e26d):
          // same reasoning as project_configure above.
          const merged = mergeConfigOverride(fresh.config, v.value, { additiveOnlyRotationGuard: true, additiveOnlyPermissionDenyGuard: true });
          // actor (card a0cafef2): agent-facing surface, same reasoning as project_configure above.
          const wrote = setProjectConfigSafe(db, projectId, merged, callerSessionId ? `setup:${callerSessionId}` : "setup");
          if (!wrote.ok) return ok({ error: wrote.error });
        }
        if (name !== undefined || vaultPath !== undefined) db.updateProject(projectId, { name, vaultPath, vaultOnly: vaultOnlyPatch });
        return ok(projectFields(db.getProject(projectId)));
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
        inputSchema: strictShape({ projectId: z.string() }),
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
        description: "Create an agent in a project. The startupPrompt is injected as the first turn when a session starts in this agent. Optionally assign an EXISTING (human/assistant-authored) profileId as the agent's rig — assignment only (use profile_create to mint a new one); a non-existent profileId is rejected. LEAST-PRIVILEGE: profileId is rejected if its role is anything but manager/worker/null, or if it carries a human-only field (agentAssignableProfileError, profiles/validate.ts), symmetric with agent_update/profile_assign. REJECTED outright when projectId is a reserved/system project (the workspace home) — this closes a name-hijack: a same-named impostor agent (e.g. a fake \"Companion\") could otherwise be created there to collide with the real one that gateway/server.ts resolves BY NAME.",
        inputSchema: strictShape({
          projectId: z.string(),
          name: z.string(),
          startupPrompt: z.string().optional(),
          profileId: z.string().optional(),
        }),
      },
      async ({ projectId, name, startupPrompt, profileId }) => {
        const project = db.getProject(projectId);
        if (!project) return ok({ error: "project not found" });
        // card 4d70cc06 (code review, reserved-home name-hijack): refuse creating ANY agent into a
        // reserved/system project — otherwise a same-named impostor (e.g. "Companion") could be minted
        // there to collide with gateway/server.ts's by-NAME resolution of the real one.
        if (project.reserved) return ok({ error: "the setup surface cannot create an agent in a reserved/system project (the workspace home) — only a human (Agents UI or REST) may add an agent there." });
        if (profileId !== undefined) {
          const profile = db.getProfile(profileId);
          if (!profile) return ok({ error: "profile not found" });
          // M2 (card 4d70cc06): agent_update/profile_assign already gate a profileId through the shared
          // predicate — agent_create was the odd path that skipped it, accepting e.g. an assistant-role
          // profile straight onto a brand-new agent. Strict/default (no elevated roles) per the 3de74275
          // decision record's amendment: the ungated setup surface never administers an elevated rig.
          const assignErr = agentAssignableProfileError(profile);
          if (assignErr) return ok({ error: assignErr });
        }
        const agent: Agent = {
          id: randomUUID(), projectId, name,
          startupPrompt: startupPrompt ?? "", position: db.listAgents(projectId).length,
          profileId: profileId ?? null,
          // An agent created via the setup MCP is NEVER an API endpoint — publishing one is a HUMAN-only
          // trust-boundary action (the agent-edit REST surface). Mirrors PlatformMcpRouter.agent_create.
          endpoint: false, ioSchema: null,
        };
        db.insertAgent(agent);
        // Advisory only (card 5338a86a) — never blocks the create; see agents/promptLint.ts.
        const warning = agentCreatePromptWarning(db, { startupPrompt, profileId });
        return ok(warning ? { ...agent, promptWarning: warning } : agent);
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
          "Edit an existing agent by id (cross-project) so you can action workspace-improvement cards directly — amend its startupPrompt / rename it / (re)assign its profile — instead of handing the user text to paste. PATCH semantics: only the keys you pass are applied (omitted keys left as-is); profileId:null CLEARS the assignment (the agent falls back to the plain backstop). THREE ways to touch startupPrompt, mutually exclusive (pick at most one): `startupPrompt` REPLACES it wholesale (as before); `appendToStartupPrompt` CONCATENATES onto the EXISTING prompt (joined with a blank line); `replaceInStartupPrompt: {old, new}` edits ONE clause mid-document WITHOUT retyping the whole prompt — `old` is matched against the agent's CURRENT server-side prompt and REJECTED with no write unless it occurs EXACTLY ONCE (0 matches = not found; 2+ = ambiguous, add more surrounding context). Read the current prompt first with agent_get. Passing more than one of the three modes in the same call is REJECTED. agentId accepts the full id OR an unambiguous 8-char id-prefix (same resolution as agent_get). 404 if the agent id is unknown; error if the prefix is ambiguous (names the candidate ids). Edits apply to the agent's NEXT new session. LEAST-PRIVILEGE: the human-only endpoint/ioSchema flags are NOT settable here, and you may NOT assign a profile whose role is anything but manager/worker/null (a setup operator can never elevate an agent — that's human-only). And the WHOLE call is REJECTED outright — a bare rename included — when the TARGET agent's CURRENT rig role is anything but manager/worker/null, or when the agent lives in a reserved/system project (the Setup Assistant, Companion, Workspace Auditor, Elevated Operator, or dev-only Platform Lead/Audit): this surface can never touch one of Loom's own standing agents, however it's reached, including renaming one to collide with (hijack) another agent's name. Above ~" + SPILL_INLINE_BUDGET_CHARS + " chars the updated startupPrompt spills to a scratch file instead of inlining (same shape as agent_get), and the response becomes {..., startupPromptFile, startupPromptChars, note} in place of `startupPrompt`.",
        inputSchema: strictShape({
          agentId: z.string(),
          name: z.string().optional(),
          startupPrompt: z.string().optional(),
          appendToStartupPrompt: z.string().optional(),
          replaceInStartupPrompt: z.object({ old: z.string(), new: z.string() }).optional(),
          profileId: z.string().nullable().optional(),
        }),
      },
      async (rawArgs) => {
        const { agentId } = rawArgs as { agentId: string };
        // card (agent_get/agent_update prefix asymmetry): resolve agentId EXACTLY like agent_get does —
        // full id, else an unambiguous 8-char id-prefix across every project (getByIdPrefix) — so a prefix
        // that reads fine here also writes, instead of a silent "agent not found".
        const resolved = getByIdPrefix(agentId, (id) => db.getAgent(id), () => db.listAllProjects().flatMap((p) => db.listAgents(p.id)), "agent");
        if ("error" in resolved) return ok(resolved);
        // LEAST-PRIVILEGE (card 4d70cc06, B2 + M1 + the code-review's reserved-home name-hijack finding):
        // refuse the ENTIRE edit — a bare rename included — before even looking at the patch, when the
        // TARGET agent is currently locked/reserved. A rename is exactly how "Companion" could be
        // hijacked (rename the real one away, then agent_create an impostor under that name), so a
        // rename can never be the exempt case. What the caller is trying to change it TO is a separate,
        // later concern (setupRoleError below).
        const lockErr = setupMayTouchAgentError(db, resolved);
        if (lockErr) return ok({ error: lockErr });
        // Drop agentId; the rest IS the PATCH. Raw args so an explicit profileId:null is PRESENT (clears)
        // while an omitted key stays absent (left as-is) — the same presence semantics the REST path relies
        // on. allowEndpointFlags:false (also absent from inputSchema) keeps the Agent Runs surface human-only.
        const { agentId: _aid, appendToStartupPrompt, replaceInStartupPrompt, ...rawPatch } = rawArgs as Record<string, unknown>;
        // resolveStartupPromptEdit (agents/validate.ts) is the SAME pure algorithm the manager-surface
        // agent_update (orchestration.ts → sessions.updateAgentPreset) uses for mode resolution — shared
        // because it's pure text transformation with no auth/scoping baked in. This surface's OWN
        // least-privilege role check (below) and cross-project resolution (getByIdPrefix above) stay
        // entirely outside the shared helper.
        let resolvedStartupPrompt: string | undefined;
        try {
          resolvedStartupPrompt = resolveStartupPromptEdit(resolved.startupPrompt, {
            startupPrompt: rawPatch.startupPrompt as string | undefined,
            appendToStartupPrompt: appendToStartupPrompt as string | undefined,
            replaceInStartupPrompt: replaceInStartupPrompt as { old: string; new: string } | undefined,
          });
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
        if (resolvedStartupPrompt !== undefined) rawPatch.startupPrompt = resolvedStartupPrompt;
        const v = validateAgentPatch(rawPatch, (pid) => !!db.getProfile(pid), { allowEndpointFlags: false });
        if (!v.ok) return ok({ error: v.error });
        // LEAST-PRIVILEGE (setup-only, ON TOP of the shared validator): a non-null profileId is validated to
        // EXIST by validateAgentPatch above, so getProfile resolves — reject if its role is elevated, or if
        // it carries a human-only field (agentAssignableProfileError, profiles/validate.ts), so the ungated
        // setup surface can never bind an agent to an elevated rig or a human-only-field-carrying profile.
        if (v.patch.profileId != null) {
          const assignErr = agentAssignableProfileError(db.getProfile(v.patch.profileId)!);
          if (assignErr) return ok({ error: assignErr });
        }
        // Advisory only (card 5338a86a) — never blocks the update; see agents/promptLint.ts.
        const warning = agentUpdatePromptWarning(db, resolved, v.patch);
        db.updateAgent(resolved.id, v.patch);
        const updated = agentFields(db.getAgent(resolved.id))!;
        const withWarning = warning ? { ...updated, promptWarning: warning } : updated;
        // card 91fef05a: same unbounded-startupPrompt shape spillableAgentGet already protects for
        // agent_get — a PATCH that touches/keeps a large prompt echoes it right back in the response.
        return ok(callerSessionId ? spillableAgentGet(callerSessionId, "agent-update-spills", withWarning.id, withWarning) : withWarning);
      },
    );

    // === templates (Guided Onboarding & Templates, onboarding C2) — read the canonical presets + apply one
    // to an EXISTING project. NO new writer surface: applyWorkflowTemplate (setup/templates.ts) writes only
    // ordinary agent-create + task-insert rows.
    //
    // @decision 3de74275 — template_apply itself (below), not applyWorkflowTemplate, checks every
    // templated agent's resolved profile (templateAssignableProfileError) before applying — the human-only
    // REST route shares applyWorkflowTemplate and keeps its pre-card, no-check behaviour. ===
    server.registerTool(
      "template_list",
      {
        description:
          "List the available workflow templates: each has a name, description, and a roster summary " +
          "(name + bound profile name) of the agents it stands up. Read-only, no secrets, no writes.",
        inputSchema: strictShape({}),
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
          "Fail-closed: an unknown templateName, an unknown projectId, an unknown profileName, a " +
          "template whose agent resolves to a role other than manager/worker/null, one whose resolved " +
          "profile carries a human-only field (see agentAssignableProfileError in profiles/validate.ts), " +
          "or a reserved/system projectId (the workspace home — closes the same name-hijack agent_create " +
          "refuses) are all rejected and nothing is written.",
        inputSchema: strictShape({
          projectId: z.string(),
          templateName: z.string(),
        }),
      },
      async ({ projectId, templateName }) => {
        // Same project-scope guard as project_configure/project_update/agent_create: resolve by exact id
        // via db.getProject, 404 on unknown — the operator's reach is bounded to a project that actually
        // exists, never widened to an arbitrary/unresolvable target.
        const project = db.getProject(projectId);
        if (!project) return ok({ error: "project not found" });
        // card 4d70cc06 (code review): same reserved-home refusal as agent_create — a template's own
        // agent-create writes are NOT exempt from the name-hijack this closes.
        if (project.reserved) return ok({ error: "the setup surface cannot apply a workflow template to a reserved/system project (the workspace home) — only a human (Agents UI or REST) may add agents there." });
        const template = findWorkflowTemplate(templateName);
        if (!template) return ok({ error: `unknown workflow template: "${templateName}"` });
        // @decision 3de74275 — this EARLY pre-check gives a clearer error at the point of the actual
        // request; it is NOT the only defense — applyWorkflowTemplate's own check (role unconditional,
        // field fail-closed) backstops it, so removing this call changes the error text, never the outcome.
        const assignErr = templateAssignableProfileError(db, template);
        if (assignErr) return ok({ error: assignErr });
        try {
          return ok(applyWorkflowTemplate(db, template, projectId));
        } catch (e) {
          // applyWorkflowTemplate throws on an unknown profileName or a resolved profile that fails its
          // own role/field check (the pre-check above is redundant here, not exhaustive) — surface as a
          // clean tool error, not an uncaught exception.
          return ok({ error: (e as Error).message });
        }
      },
    );

    // === rigs (profiles). Same strict validateProfile the human REST profile endpoints use — validation
    // is NOT loosened here. Managing the user's rigs is the assistant's core job. ===
    server.registerTool(
      "profile_create",
      {
        description: "Create a Profile (rig: role + skills subset + model + icon + restrictedTools + noCommit). role may be manager|worker or omitted ONLY — every other role (elevated platform/auditor/workspace-auditor, or operator/assistant/setup, whose session role is locked to an explicit spawn path) is rejected here (human-only). `connections`/`capabilities`/`vaultWrite`/`harness`/`browserTesting`/`documentConversion`/`allowDelta` are ALSO rejected here — human-only via the Profiles UI/REST: `connections` grants access to real external secrets, `capabilities` can launch a host process / inject an MCP server, `vaultWrite` grants confined write access into a project's vault, `harness` selects the spawn binary, `browserTesting`/`documentConversion` launch a per-session browser/subprocess capability, and `allowDelta` widens the spawn permission allowlist (e.g. `Bash(*)`) — ask the human to set any of these in the Profiles UI. Otherwise validated by the SAME strict validator as POST /api/profiles; an unknown/invalid field is rejected and nothing is created.",
        inputSchema: strictShape({ profile: z.object({}).passthrough() }),
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
        description: "Edit an existing Profile by id: the patch is merged over the current profile, then re-validated by the same strict validator as PUT /api/profiles/:id (so a partial patch still passes). The RESULTING role may be manager|worker or null ONLY — a patch that yields any other role (elevated platform/auditor/workspace-auditor, or operator/assistant/setup) is rejected (human-only). LEAST-PRIVILEGE: REJECTED outright, before the patch is even validated, when the profile's CURRENT (pre-patch) role is anything but manager/worker/null — this includes the Setup Assistant's own rig, so this surface can never self-modify, and closes a patch that clears `role` to null in the SAME call that also strips another field (e.g. a Companion's restrictedTools), which would otherwise pass the resolved-role check below. Flipping `role` to \"manager\" is REJECTED if this profile is already bound to an agent in a reserved/system project (a manager session can never start there) — a profile is shared across projects, so this can strand an agent you never directly touched. The patch may not touch `connections`/`capabilities`/`vaultWrite`/`harness`/`browserTesting`/`documentConversion`/`allowDelta` (authenticated-egress grants / registry-capability grants / the confined vault-write grant / the spawn binary / the browser-automation + document-conversion capabilities / the spawn permission allowlist delta — all human-only, via the Profiles UI/REST); a profile that already has one of these set keeps it across an unrelated patch. 404 if the id is unknown; an invalid result is rejected and the stored profile is left unchanged.",
        inputSchema: strictShape({ profileId: z.string(), patch: z.object({}).passthrough() }),
      },
      async ({ profileId, patch }) => {
        const existing = db.getProfile(profileId);
        if (!existing) return ok({ error: "profile not found" });
        // LEAST-PRIVILEGE (card 4d70cc06, M1): refuse ANY patch to an already-locked profile — including
        // the Setup Assistant's own "setup"-role rig (self-modification) — checked on the EXISTING role,
        // before the patch is merged/validated. Catches the bypass a post-merge-only check would miss: a
        // patch that clears `role` to null in the SAME call that also strips e.g. restrictedTools would
        // otherwise pass setupRoleError below (null is always allowed) while the write still landed.
        const lockErr = setupLockedRoleError(existing.role, "a profile");
        if (lockErr) return ok({ error: lockErr });
        // Mirror the REST PUT: drop `id` from both sides so a verbatim round-trip doesn't trip .strict().
        const { id: _pid, ...patchNoId } = patch as Record<string, unknown>;
        // Reject on the RAW incoming patch (before merge) — a profile that already has `connections` set
        // via human REST must survive an unrelated agent patch untouched; only the agent's OWN attempt to
        // introduce/change the key is rejected.
        const forbiddenErr = agentProfileKeyError(patchNoId);
        if (forbiddenErr) return ok({ error: forbiddenErr });
        const { id: _eid, ...base } = existing;
        // previousRole + the raw un-merged patch let validateProfile's assistant-role restrictedTools
        // gate (card 8feb55b8) tell a genuine role TRANSITION into "assistant" (must state
        // restrictedTools) apart from an unrelated edit to an already-assistant profile (must not be
        // forced to restate it). (In practice setupRoleError below never lets a resolved role reach
        // "assistant" through this ungated surface anyway — this keeps the validator self-consistent
        // regardless of caller.)
        const v = validateProfile({ ...base, ...patchNoId }, { previousRole: existing.role, patch: patchNoId });
        if (!v.ok) return ok({ error: `invalid profile: ${v.error}` });
        // Guard the RESOLVED role (after the merge) — a patch must not be able to elevate a rig to
        // platform/auditor via the ungated setup surface, even if the base profile already held it.
        const roleErr = setupRoleError(v.value.role);
        if (roleErr) return ok({ error: roleErr });
        // @decision ced4285e — the profile-role-change route; gated on a FLIP into "manager" so an
        // unrelated patch to an already-manager profile is never refused.
        if (existing.role !== "manager" && v.value.role === "manager") {
          const stranding = reservedProjectAgentBoundToProfile(db, profileId);
          if (stranding) {
            return ok({ error: `cannot set role to "manager": this profile is bound to agent "${stranding.agent.name}" (${stranding.agent.id}) in reserved/system project "${stranding.project.name}" (${stranding.project.id}) — a manager session can never start there (see the session-start reserved-home guard); only a human may do this.` });
          }
        }
        db.updateProfile(profileId, v.value);
        return ok(profileFields(db.getProfile(profileId)));
      },
    );

    server.registerTool(
      "profile_assign",
      {
        description: "Assign an EXISTING profile to an agent (explicit agentId + profileId). Both the agent and the profile must already exist (404 otherwise). agentId accepts the full id OR an unambiguous 8-char id-prefix (same resolution as agent_get); error if ambiguous (names the candidate ids). Assignment only — it never mints a profile (use profile_create). LEAST-PRIVILEGE: REJECTED outright when the TARGET agent's CURRENT rig role is anything but manager/worker/null, or when it lives in a reserved/system project — regardless of which profile you're trying to assign it — and separately rejected when the NEW profile's role is anything but manager/worker/null, or when it carries a human-only field (see agentAssignableProfileError in profiles/validate.ts).",
        inputSchema: strictShape({ agentId: z.string(), profileId: z.string() }),
      },
      async ({ agentId, profileId }) => {
        const agent = getByIdPrefix(agentId, (id) => db.getAgent(id), () => db.listAllProjects().flatMap((p) => db.listAgents(p.id)), "agent");
        if ("error" in agent) return ok(agent);
        // LEAST-PRIVILEGE (card 4d70cc06, B2): the TARGET agent's CURRENT rig/home, checked BEFORE the
        // new profile even resolves — a rebind or clear away from an already-locked rig is refused
        // regardless of what it's being rebound TO.
        const lockErr = setupMayTouchAgentError(db, agent);
        if (lockErr) return ok({ error: lockErr });
        const assigned = db.getProfile(profileId);
        if (!assigned) return ok({ error: "profile not found" });
        // LEAST-PRIVILEGE (setup-only): mirror agent_update — reject binding an agent to a profile whose
        // RESOLVED role is elevated (platform/auditor/workspace-auditor), or that carries a human-only
        // field (agentAssignableProfileError, profiles/validate.ts), so the ungated setup surface can
        // never plant a latent elevation or launder such a grant by this back door (strict/default). A
        // manager/null/plain rig with no such grant still assigns fine.
        const assignErr = agentAssignableProfileError(assigned);
        if (assignErr) return ok({ error: assignErr });
        db.updateAgent(agent.id, { profileId });
        return ok(agentFields(db.getAgent(agent.id)));
      },
    );

    // === reads (orient the assistant) ===
    server.registerTool(
      "list_all_projects",
      {
        description: "List every live project across the platform, INCLUDING reserved/system homes. Excludes archived projects. Returns project rows. Every row's config.sessionEnv values are MASKED (same-length bullet filler, never the real secret) — feeding a masked value back as a later write is rejected, not silently stored. Above ~" + SPILL_INLINE_BUDGET_CHARS + " chars the rows spill to a scratch file as NDJSON instead of inlining, and the response becomes {projectsFile, projectsChars, rowCount, note}.",
        inputSchema: strictShape({}),
      },
      async () => {
        // Two-step, deliberately: `rawProjects` is the unmasked read, `rows` is what actually reaches
        // `ok(...)` (both inline and via the spill file) — keeping the mask visible as its own statement,
        // never chained directly onto the raw getter, is what keeps this legible to
        // mcp-project-fields-chokepoint-guard.mjs's static scan (card 91fef05a review).
        const rawProjects = db.listAllProjects();
        const rows = rawProjects.map(projectFields);
        if (!callerSessionId) return ok(rows);
        const spill = spillRowsIfLarge(callerSessionId, "list-all-projects-spills", "all", rows, SPILL_INLINE_BUDGET_CHARS);
        if (spill.inline) return ok(rows);
        return ok({ projectsFile: spill.file, projectsChars: spill.chars, rowCount: spill.rowCount, note: spill.note });
      },
    );

    server.registerTool(
      "list_all_agents",
      {
        description: "List agents across the platform. Optional projectId narrows to one project — accepts the full id OR an unambiguous 8-char id-prefix (mirrors project_get); an unknown/ambiguous id is an EXPLICIT error, never a silent []. With no filter, aggregates the agents of every live project. DEFAULT returns a lightweight SUMMARY per agent (id, projectId, name, position, profileId, endpoint) so the aggregate stays bounded; the heavy startupPrompt + ioSchema are DROPPED. Pass full:true for whole agent rows. Summary reads are capped at " + DEFAULT_AGENT_SUMMARY_CAP + " rows by default. PAGINATION: with NO offset/limit passed and the whole matching set fits in one page, returns the bare agents array (today's shape, unchanged) — otherwise, or whenever you pass offset/limit explicitly, it returns a page envelope {agents, total, returned, offset, nextOffset}, the SAME shape session_transcript uses: total is the true matching-row count, nextOffset is offset+returned while more remains, else null. Page deterministically by calling again with offset:nextOffset until it is null — a capped read is thus self-evidently partial, never mistake a bare array at the cap for 'that's everything'.",
        inputSchema: strictShape({
          projectId: z.string().optional(),
          full: z.boolean().optional(),
          limit: z.number().int().positive().optional(),
          offset: z.number().int().nonnegative().optional(),
        }),
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

    // DELIBERATE DIVERGENCE from platform.ts's list_all_sessions (card 2fb68e76, DoD-3): the Lead's
    // elevated surface (mcp/platform.ts) gained a `scope` axis (live/archived/all) so it can see the
    // archived half of a worktree-path aliasing pair — a cross-project forensics need this router does
    // NOT share. This is the least-privilege, human-driven onboarding/maintenance operator: nothing in
    // its job (project/agent/profile setup) needs archived cross-project session history, and widening
    // the archived-session surface here only grows this router's blast radius for no offsetting use case
    // (this router's whole design principle — see the class doc comment above — is a curated, minimal
    // subset, not "mirror the elevated surface's reads"). So this tool is UNCHANGED: archived rows stay
    // excluded, always. Revisit only if a genuine setup-surface need for archived session history shows up.
    server.registerTool(
      "list_all_sessions",
      {
        description: "List sessions across the platform (archived excluded — this router deliberately does not expose archived-session history; see card 2fb68e76's DoD-3 decision recorded just above this tool). ⚠️ Because of that, any worktreePath/branch aliasing question is structurally UNDER-COUNTED here: the dangling half of a worktree-path pairing (a stopped/crashed worker whose worktree still lingers) is overwhelmingly an ARCHIVED row this tool cannot ever return — use the Platform Lead's list_all_sessions (mcp/platform.ts) for that. Each row is enriched with its project + agent name. state (default \"live\") filters by PROCESS lifecycle: \"live\" = non-exited sessions only (the bounded default — finished but un-archived sessions are dropped so the feed doesn't grow without limit); \"exited\" = terminated sessions only (history); \"all\" = both. Optional projectId narrows to one project — accepts the full id OR an unambiguous 8-char id-prefix (mirrors project_get); an unknown/ambiguous id is an EXPLICIT error, never a silent []. DEFAULT returns a lightweight SUMMARY per session so the list stays bounded; pass full:true for whole session records. Optional limit/offset paginate (rows ordered by last activity, newest first); summary reads are capped at " + DEFAULT_SESSION_SUMMARY_CAP + " rows by default. PAGINATION: with NO offset/limit passed and the whole matching set fits in one page, returns the bare sessions array (today's shape, unchanged) — otherwise, or whenever you pass offset/limit explicitly, it returns a page envelope {sessions, total, returned, offset, nextOffset}, the SAME shape session_transcript uses: total is the true matching-row count, nextOffset is offset+returned while more remains, else null. Page deterministically by calling again with offset:nextOffset until it is null — a capped read is thus self-evidently partial, never mistake a bare array at the cap for 'that's everything'.",
        inputSchema: strictShape({
          projectId: z.string().optional(),
          state: z.enum(["live", "exited", "all"]).optional(),
          full: z.boolean().optional(),
          limit: z.number().int().positive().optional(),
          offset: z.number().int().nonnegative().optional(),
        }),
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
        inputSchema: strictShape({ agentId: z.string() }),
      },
      async ({ agentId }) => {
        const agent = getByIdPrefix(agentId, (id) => db.getAgent(id), () => db.listAllProjects().flatMap((p) => db.listAgents(p.id)), "agent");
        if ("error" in agent) return ok(agent);
        const fields = agentFields(agent)!;
        // Card bf0fd0f3: same single-large-value spill as the manager/platform surfaces' agent_get.
        // No callerSessionId (should not happen on a real request path) falls back to the pre-spill
        // shape rather than pass an undefined recipient into spillTextIfLarge.
        return ok(callerSessionId ? spillableAgentGet(callerSessionId, "agent-get-spills", fields.id, fields) : fields);
      },
    );

    server.registerTool(
      "profile_get",
      {
        description: "Read ONE profile (rig) by id — the FULL record (role, permission allowDelta, skills subset, model, icon, browserTesting, documentConversion, restrictedTools, noCommit). Accepts the full id OR an unambiguous 8-char id-prefix. Read-only. Error if the id is unknown or an ambiguous prefix (the error names the candidate ids).",
        inputSchema: strictShape({ profileId: z.string() }),
      },
      async ({ profileId }) => {
        const profile = getByIdPrefix(profileId, (id) => db.getProfile(id), () => db.listProfiles(), "profile");
        if ("error" in profile) return ok(profile);
        return ok(profileFields(profile));
      },
    );

    server.registerTool(
      "project_get",
      {
        description: "Read ONE project by id — the FULL record incl. its config override (so you can see what's set before a project_configure PATCH). Accepts the full id OR an unambiguous 8-char id-prefix. Read-only. Error if the id is unknown or an ambiguous prefix (the error names the candidate ids). The returned config's sessionEnv values are MASKED (same-length bullet filler, never the real secret) — feeding a masked value back as a later write is rejected, not silently stored.",
        inputSchema: strictShape({ projectId: z.string() }),
      },
      async ({ projectId }) => {
        const project = getByIdPrefix(projectId, (id) => db.getProject(id), () => db.listAllProjects(), "project");
        if ("error" in project) return ok(project);
        return ok(projectFields(project));
      },
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
          "Spawn a session into a project by explicit projectId + agentId. projectId and agentId each accept the full id OR an unambiguous 8-char id-prefix (the short id Loom displays), exactly like project_get/agent_get — an ambiguous prefix errors naming the candidate ids; agentId is resolved among the RESOLVED project's own agents. role MUST be \"manager\" or \"plain\" ONLY: \"manager\" gets the orchestration surface; \"plain\" is a vanilla role-null session (even on a profile agent). NEVER spawns a \"platform\", \"auditor\", \"setup\", or \"operator\" session (no self-elevation) and NEVER a \"worker\" (a worker needs a manager parent + task — a manager's orchestration job). Any other role value is rejected.",
        inputSchema: strictShape({ projectId: z.string(), agentId: z.string(), role: z.string() }),
      },
      async ({ projectId, agentId, role }) => {
        // HARD INVARIANT: only manager|plain may be minted here. Reject platform/auditor/setup/operator
        // (self-elevation) and worker (manager-owned) — and anything else — explicitly, as data.
        const roleError = spawnableRoleError(role);
        if (roleError) return ok({ error: roleError });
        try {
          // Narrowed by spawnableRoleError above (only "manager"/"plain" reach here). projectId/agentId
          // prefix resolution (card e6a756ea) lives in spawnSessionAsPlatform itself.
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
        inputSchema: strictShape({}),
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
          "List the skills in the user's skill store. Each entry has name, description, bundled (a Loom-shipped skill — read-only on this surface) and editable (= !bundled). USER (editable) skills ALSO include their full SKILL.md `content` so you can edit them in place; a bundled skill's content is omitted here (edit those via the Skills UI). Read-only. Above ~" + SPILL_INLINE_BUDGET_CHARS + " chars the skills spill to a scratch file instead of inlining, and the response becomes a `{skillsFile,skillsChars,rowCount,note}` pointer at that same NDJSON text.",
        inputSchema: strictShape({}),
      },
      async () => ok(skillListData(callerSessionId)),
    );

    server.registerTool(
      "skill_write",
      {
        description:
          "Create or update a skill in the USER skill store (~/.loom/skills). The editable unit is the skill's SKILL.md (frontmatter name/description + body); the full `content` you pass REPLACES it. name must be a kebab slug (a-z, 0-9, -, ≤64 chars). Edits apply to new sessions on next spawn.\n" +
          "BOUNDED TO USER SKILLS: this REJECTS any name that is a Loom-bundled/shipped skill (e.g. worker, orchestrate, setup-assistant, the platform-* dev skills) — it can NEVER modify the bundled/dev skill set. Use the Skills UI to edit a bundled skill.\n" +
          "CONFIRM-FIRST (load-bearing): NEVER call this without first showing the user the skill name + content and getting their explicit confirmation. Pass confirm:true to attest you have done so; a missing/false confirm is rejected and nothing is written.",
        inputSchema: strictShape({
          name: z.string(),
          content: z.string(),
          confirm: z.boolean().optional(),
        }),
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
