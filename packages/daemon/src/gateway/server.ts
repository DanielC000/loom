import { randomUUID } from "node:crypto";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import websocket from "@fastify/websocket";
import type { WebSocket } from "ws";
import type { TerminalInput, ShellTerminal, Project, Agent, Task, ProjectConfigOverride, Schedule } from "@loom/shared";
import { resolveConfig } from "@loom/shared";
import { nextFireAt } from "../orchestration/cron.js";
import { readTranscript, readArchivedTranscript, archivedTranscriptExists } from "../sessions/transcript.js";
import type { Db } from "../db.js";
import type { PtyHost } from "../pty/host.js";
import { detectDefaultShell } from "../pty/host.js";
import type { SessionService } from "../sessions/service.js";
import type { TaskMcpRouter } from "../mcp/server.js";
import type { OrchestrationMcpRouter } from "../mcp/orchestration.js";
import type { PlatformMcpRouter } from "../mcp/platform.js";
import { validateProjectConfigOverride, validatePlatformConfigOverride } from "../mcp/platform.js";
import type { OrchestrationControl } from "../orchestration/control.js";
import type { UsageStatusPoller } from "../orchestration/usage-status.js";
import { clearClaudeRateLimit } from "../orchestration/usage-awareness.js";
import { GitReader } from "../git/reader.js";
import { GitWriter } from "../git/writer.js";
import { workerDiff } from "../git/worktrees.js";
import { listVaultTree, readVaultFile } from "../vault/browser.js";
import { writeVaultFile, createVaultFile, deleteVaultFile } from "../vault/writer.js";
import { listSkills, readSkill, writeSkill, deleteSkill, resetSkillToBundled, publishSkillToBundled, isValidSkillName, skillTemplate } from "../skills/store.js";
import { validateProfile } from "../profiles/validate.js";
import { resetProfileToBundled } from "../profiles/seed.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Whitelist guard for the human REST task surfaces — rejects any value outside the p0–p3 enum. */
const isTaskPriority = (v: unknown): v is Task["priority"] => v === "p0" || v === "p1" || v === "p2" || v === "p3";

export interface GatewayDeps {
  db: Db;
  pty: PtyHost;
  sessions: SessionService;
  mcp: TaskMcpRouter;
  orchMcp: OrchestrationMcpRouter;
  platformMcp: PlatformMcpRouter;
  control: OrchestrationControl;
  usageStatus: UsageStatusPoller;
}

export async function buildServer(deps: GatewayDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocket);

  // --- Project-scoped task MCP (session id in the path; project resolved server-side) ---
  app.all("/mcp/:sessionId", async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    reply.hijack(); // hand raw req/res to the MCP transport; pass the Fastify-parsed body
    await deps.mcp.handle(req.raw, reply.raw, sessionId, req.body);
  });

  // --- Manager-scoped orchestration MCP (role-gated; manager derived server-side) ---
  app.all("/mcp-orch/:sessionId", async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    reply.hijack();
    await deps.orchMcp.handle(req.raw, reply.raw, sessionId, req.body);
  });

  // --- Platform-lead MCP (role-gated to 'platform'; project/agent creation — Pillar C) ---
  app.all("/mcp-platform/:sessionId", async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    reply.hijack();
    await deps.platformMcp.handle(req.raw, reply.raw, sessionId, req.body);
  });

  // --- Orchestration safety rails (§17a): pause/kill switch + status. These gate worker_spawn
  // (server-side, in spawnWorker); kill also hard-stops in-flight workers. scope = "global"
  // (default) or a manager session id. ---
  app.post("/api/orchestration/pause", async (req) => {
    const { scope } = (req.body as { scope?: string }) ?? {};
    deps.control.pause(scope ?? "global");
    return { ok: true, pausedScopes: deps.control.pausedScopes() };
  });
  app.post("/api/orchestration/resume", async (req) => {
    const { scope } = (req.body as { scope?: string }) ?? {};
    deps.control.resume(scope ?? "global");
    return { ok: true, pausedScopes: deps.control.pausedScopes() };
  });
  app.post("/api/orchestration/kill", async () => ({ stopped: deps.sessions.killAllWorkers() }));
  app.get("/api/orchestration/status", async () => ({ pausedScopes: deps.control.pausedScopes() }));
  // --- God-eye read of the user's REAL Claude plan-usage (5h / 7d rate-limit windows). Served from a
  // single daemon-side cached poller (NOT fetched per-request; NOT an MCP tool; NOT a write surface).
  // Always 200: `available:false`+reason when the token is missing/expired or the upstream call failed. ---
  app.get("/api/usage/limits", async () => deps.usageStatus.getStatus());
  // Manual GLOBAL hold clear (HUMAN/REST only — trust boundary like the git/vault writers; NEVER an
  // MCP tool). Drops the global usage-awareness latch (~/.loom/tmp/claude-usage.json) so new
  // worker_spawn is unblocked WITHOUT touching any session — for a transient overload with real
  // headroom. ADDITIVE: detection re-arms the latch on the next real cap.
  app.post("/api/usage/clear-hold", async () => { clearClaudeRateLimit(); return { cleared: true }; });
  // A manager's orchestration_events timeline (chronological). READ-ONLY — emits no event.
  app.get("/api/orchestration/events", async (req) => {
    const { managerId } = req.query as { managerId?: string };
    return managerId ? deps.db.listEvents(managerId) : [];
  });

  // --- Schedules (phase-2 Pillar B): cron triggers. next_fire_at is computed here on
  // create/update (the Scheduler advances it after each fire). ---
  app.get("/api/schedules", async () => deps.db.listSchedules());
  app.post("/api/schedules", async (req, reply) => {
    const b = (req.body ?? {}) as { agentId?: string; cron?: string; enabled?: boolean };
    if (!b.agentId || !b.cron) return reply.code(400).send({ error: "agentId and cron required" });
    if (!deps.db.getAgent(b.agentId)) return reply.code(404).send({ error: "agent not found" });
    let next: string;
    try { next = nextFireAt(b.cron, new Date()); } catch { return reply.code(400).send({ error: "invalid cron expression" }); }
    const schedule: Schedule = {
      id: randomUUID(), agentId: b.agentId, cron: b.cron,
      enabled: b.enabled ?? true, nextFireAt: next, lastFiredAt: null, createdAt: new Date().toISOString(),
    };
    deps.db.insertSchedule(schedule);
    return reply.code(201).send(schedule);
  });
  app.post("/api/schedules/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deps.db.getSchedule(id)) return reply.code(404).send({ error: "schedule not found" });
    const b = (req.body ?? {}) as { cron?: string; enabled?: boolean };
    const patch: { cron?: string; enabled?: boolean; nextFireAt?: string } = {};
    if (typeof b.enabled === "boolean") patch.enabled = b.enabled;
    if (typeof b.cron === "string") {
      try { patch.nextFireAt = nextFireAt(b.cron, new Date()); } catch { return reply.code(400).send({ error: "invalid cron expression" }); }
      patch.cron = b.cron;
    }
    deps.db.updateSchedule(id, patch);
    return deps.db.getSchedule(id);
  });
  app.delete("/api/schedules/:id", async (req) => {
    deps.db.deleteSchedule((req.params as { id: string }).id);
    return { ok: true };
  });

  // --- Hook relay target (loopback only) ---
  app.post("/internal/hook", async (req, reply) => {
    if (!LOOPBACK.has(req.ip)) return reply.code(403).send("forbidden");
    const body = req.body as { sessionId?: string; hook?: Record<string, unknown> };
    if (body?.sessionId && body.hook) deps.pty.deliverHook(body.sessionId, body.hook);
    return reply.send({ ok: true });
  });

  // --- REST: read ---
  app.get("/api/projects", async () => deps.db.listProjects());

  // --- Loom-managed skills (the UI-editable skill store; delivered to sessions project-local) ---
  app.get("/api/skills", async () => listSkills());
  app.get("/api/skills/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const s = readSkill(name);
    if (!s) return reply.code(404).send({ error: "skill not found" });
    return s;
  });
  app.post("/api/skills", async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; content?: string };
    if (!b.name || !isValidSkillName(b.name)) return reply.code(400).send({ error: "invalid skill name (kebab-case: a-z, 0-9, -)" });
    if (readSkill(b.name)) return reply.code(409).send({ error: "skill already exists" });
    writeSkill(b.name, b.content ?? skillTemplate(b.name));
    return reply.code(201).send({ name: b.name });
  });
  app.put("/api/skills/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    const b = (req.body ?? {}) as { content?: string };
    if (typeof b.content !== "string") return reply.code(400).send({ error: "content required" });
    if (!writeSkill(name, b.content)) return reply.code(400).send({ error: "invalid skill name" });
    return { ok: true };
  });
  app.delete("/api/skills/:name", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!isValidSkillName(name)) return reply.code(400).send({ error: "invalid skill name" });
    deleteSkill(name);
    return { ok: true };
  });
  // Restore a bundled skill to its shipped version (discards UI edits) — the explicit fix for the
  // seed-if-absent gap. 404 if the skill isn't bundled (nothing to reset to).
  app.post("/api/skills/:name/reset", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!isValidSkillName(name)) return reply.code(400).send({ error: "invalid skill name" });
    if (!resetSkillToBundled(name)) return reply.code(404).send({ error: "no bundled version for this skill" });
    return readSkill(name);
  });
  // Inverse of reset: publish the store's edited SKILL.md back into the repo's bundled asset so the edit
  // becomes committable (HUMAN commits — this never commits). Restricted to existing bundled skills.
  // Trust-boundary write like the vault/git writers — HUMAN-only REST, NO agent MCP tool exposes it.
  app.post("/api/skills/:name/publish", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!isValidSkillName(name)) return reply.code(400).send({ error: "invalid skill name" });
    if (!publishSkillToBundled(name)) return reply.code(404).send({ error: "no bundled version for this skill" });
    return { ok: true };
  });

  // --- Profiles (platform-level rig: role + allow/skills/model/icon + a UI-only description; the
  // injected prompt always comes from the agent). HUMAN-managed
  // ONLY (REST + later web UI) — profiles confer role + permission allowlists (= privilege), so they
  // are deliberately kept OFF the agent-writable MCP surface. Writes are schema-validated (strict,
  // typo-guarded) by validateProfile, mirroring the project-config validator. ---
  app.get("/api/profiles", async () => deps.db.listProfiles());
  app.get("/api/profiles/:id", async (req, reply) => {
    const p = deps.db.getProfile((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "profile not found" });
    return p;
  });
  app.post("/api/profiles", async (req, reply) => {
    const v = validateProfile(req.body);
    if (!v.ok) return reply.code(400).send({ error: `invalid profile: ${v.error}` });
    const profile = { id: randomUUID(), ...v.value };
    deps.db.insertProfile(profile);
    return reply.code(201).send(profile);
  });
  app.put("/api/profiles/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const existing = deps.db.getProfile(id);
    if (!existing) return reply.code(404).send({ error: "profile not found" });
    // Merge the patch over the existing profile, then validate the RESULT (so a partial patch that
    // omits required fields still passes). `id` is path-scoped — drop it from both sides so a verbatim
    // round-trip PUT (GET → PUT the same body) doesn't trip .strict()'s unknown-key guard.
    const { id: _drop, ...patch } = (req.body ?? {}) as Record<string, unknown>;
    const { id: _eid, ...base } = existing;
    const v = validateProfile({ ...base, ...patch });
    if (!v.ok) return reply.code(400).send({ error: `invalid profile: ${v.error}` });
    deps.db.updateProfile(id, v.value);
    return deps.db.getProfile(id);
  });
  // Delete is SAFE for assigned agents: a dangling profile_id resolves to the plain backstop (a
  // bundled profile re-seeds on next boot). Idempotent — mirrors the skills DELETE (no 404).
  app.delete("/api/profiles/:id", async (req) => {
    deps.db.deleteProfile((req.params as { id: string }).id);
    return { ok: true };
  });
  // Restore a bundled profile to its shipped fields (discards UI edits) — the profile analogue of the
  // skill reset. 404 if the id is unknown or its name isn't a bundled one (a user-created profile).
  app.post("/api/profiles/:id/reset", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!resetProfileToBundled(deps.db, id)) return reply.code(404).send({ error: "no bundled version for this profile" });
    return deps.db.getProfile(id);
  });

  app.get("/api/projects/:id/agents", async (req) =>
    deps.db.listAgents((req.params as { id: string }).id));
  app.get("/api/projects/:id/tasks", async (req) =>
    deps.db.listTasks((req.params as { id: string }).id));
  // Board = resolved kanban columns (config default→override) + the project's tasks.
  app.get("/api/projects/:id/board", async (req, reply) => {
    const p = deps.db.getProject((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    return { columns: resolveConfig(p.config).kanbanColumns, tasks: deps.db.listTasks(p.id) };
  });
  // Transcript = Claude's session JSONL rendered to clean turns (canonical history). For an ARCHIVED
  // session the live JSONL is usually gone, so prefer the on-exit snapshot; fall through to the live
  // transcript when no snapshot exists (a session archived while still dead has neither → []).
  app.get("/api/sessions/:id/transcript", async (req) => {
    const s = deps.db.getSession((req.params as { id: string }).id);
    if (!s) return [];
    if (s.archivedAt && archivedTranscriptExists(s.projectId, s.id)) return readArchivedTranscript(s.projectId, s.id);
    if (!s.engineSessionId) return [];
    return readTranscript(s.cwd, s.engineSessionId);
  });
  // A worker's branch diff for the orchestration view (read-only — does NOT call reviewWorkerMerge,
  // so it appends no merge_request event; the manager's two-step gate is the only thing that does).
  app.get("/api/sessions/:id/diff", async (req, reply) => {
    const s = deps.db.getSession((req.params as { id: string }).id);
    if (!s?.branch) return reply.code(404).send({ error: "session has no branch" });
    const p = deps.db.getProject(s.projectId);
    if (!p) return reply.code(404).send({ error: "project not found" });
    // Lifecycle-robust: live worktree (uncommitted) → committed branch → reconstructed merge diff.
    const d = await workerDiff(p.repoPath, { branch: s.branch, worktreePath: s.worktreePath ?? null });
    if (!d) return reply.code(404).send({ error: "no diff available (no worktree, and branch gone/unmergeable)" });
    return d;
  });
  app.get("/api/agents/:id/sessions", async (req) =>
    deps.db.listSessions((req.params as { id: string }).id));
  // All running/known sessions across projects — for the global Live Terminals grid.
  app.get("/api/sessions", async () => deps.db.listAllSessions());

  // Read-only vault browser (§7: no editing from the UI in phase 1).
  app.get("/api/projects/:id/vault", async (req, reply) => {
    const p = deps.db.getProject((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    return listVaultTree(p.vaultPath);
  });
  app.get("/api/projects/:id/vault/file", async (req, reply) => {
    const p = deps.db.getProject((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    const rel = (req.query as { path?: string }).path ?? "";
    const content = readVaultFile(p.vaultPath, rel);
    if (content === null) return reply.code(404).send({ error: "file not found" });
    return { path: rel, content };
  });

  // Vault WRITE (HUMAN/REST only — no MCP tool: agents already write via their session cwd +
  // the auto-committer). Every op is vault-confined by writer.ts's path-traversal guard and
  // commits through the SAME path as the auto-committer. A traversal escape → 400 (never writes).
  const writeReply = (reply: FastifyReply, r: Awaited<ReturnType<typeof writeVaultFile>>, relPath: string) => {
    if (r.ok) return { ok: true, path: relPath, committed: r.committed };
    if (r.reason === "traversal") return reply.code(400).send({ error: "path escapes the vault root" });
    if (r.reason === "exists") return reply.code(409).send({ error: "file already exists" });
    if (r.reason === "not-found") return reply.code(404).send({ error: "file not found" });
    if (r.reason === "is-dir") return reply.code(400).send({ error: "path is a directory" });
    return reply.code(500).send({ error: "write failed" });
  };
  // Write/overwrite a file (Save).
  app.put("/api/projects/:id/vault/file", async (req, reply) => {
    const p = deps.db.getProject((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    const b = (req.body ?? {}) as { path?: string; content?: string };
    if (!b.path || typeof b.content !== "string") return reply.code(400).send({ error: "path and content required" });
    return writeReply(reply, await writeVaultFile(p.vaultPath, b.path, b.content), b.path);
  });
  // Create a new file (409 if it already exists).
  app.post("/api/projects/:id/vault/file", async (req, reply) => {
    const p = deps.db.getProject((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    const b = (req.body ?? {}) as { path?: string; content?: string };
    if (!b.path) return reply.code(400).send({ error: "path required" });
    return writeReply(reply, await createVaultFile(p.vaultPath, b.path, b.content ?? ""), b.path);
  });
  // Delete a file.
  app.delete("/api/projects/:id/vault/file", async (req, reply) => {
    const p = deps.db.getProject((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    const rel = (req.query as { path?: string }).path ?? "";
    if (!rel) return reply.code(400).send({ error: "path required" });
    return writeReply(reply, await deleteVaultFile(p.vaultPath, rel), rel);
  });

  // Git view — read (log/branches) + write (checkout/commit/push/create-branch).
  app.get("/api/projects/:id/git/log", async (req, reply) => {
    const p = deps.db.getProject((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    return new GitReader(p.repoPath).log();
  });
  app.get("/api/projects/:id/git/branches", async (req, reply) => {
    const p = deps.db.getProject((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    return new GitReader(p.repoPath).branches();
  });

  // Git WRITE — HUMAN/REST ONLY. This is a TRUST-BOUNDARY surface like the vault writer and
  // gateCommand: checkout/commit and ESPECIALLY push (outward-facing, network, irreversible) are
  // DELIBERATELY absent from every MCP server — no agent (loom-tasks/orchestration/platform) can
  // checkout/commit/push. Every op is bounded + non-interactive in GitWriter (a hung push can't wedge
  // the daemon). An EXPECTED git failure (dirty tree, no upstream, conflict) comes back as
  // 200 { ok:false, error } so the UI shows the reason — never a 500.
  app.post("/api/projects/:id/git/checkout", async (req, reply) => {
    const p = deps.db.getProject((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    const branch = ((req.body ?? {}) as { branch?: string }).branch;
    if (!branch) return reply.code(400).send({ error: "branch required" });
    return new GitWriter(p.repoPath).checkout(branch);
  });
  app.post("/api/projects/:id/git/branch", async (req, reply) => {
    const p = deps.db.getProject((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    const name = ((req.body ?? {}) as { name?: string }).name;
    if (!name) return reply.code(400).send({ error: "name required" });
    return new GitWriter(p.repoPath).createBranch(name);
  });
  app.post("/api/projects/:id/git/commit", async (req, reply) => {
    const p = deps.db.getProject((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    const message = ((req.body ?? {}) as { message?: string }).message;
    if (!message) return reply.code(400).send({ error: "message required" });
    // Plain commit under the repo's configured identity — no -c overrides, no Co-Authored-By trailer.
    return new GitWriter(p.repoPath).commit(message);
  });
  app.post("/api/projects/:id/git/push", async (req, reply) => {
    const p = deps.db.getProject((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    return new GitWriter(p.repoPath).push();
  });

  // --- REST: create / bind ---
  app.post("/api/projects", async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; repoPath?: string; vaultPath?: string; config?: ProjectConfigOverride };
    if (!b.name || !b.repoPath || !b.vaultPath)
      return reply.code(400).send({ error: "name, repoPath, vaultPath required" });
    const project: Project = {
      id: randomUUID(), name: b.name, repoPath: b.repoPath, vaultPath: b.vaultPath,
      config: b.config ?? {}, createdAt: new Date().toISOString(), archivedAt: null,
    };
    deps.db.insertProject(project);
    return reply.code(201).send(project);
  });

  // Soft-remove (archive) a project — hides it from the project list; rows/sessions are retained.
  app.delete("/api/projects/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deps.db.getProject(id)) return reply.code(404).send({ error: "project not found" });
    deps.db.archiveProject(id);
    return { ok: true };
  });

  // Set a project's config override (the machine-writable config, schema-validated). Mirrors the
  // platform MCP's project_configure so UI/REST and the agent share one validator + store.
  app.patch("/api/projects/:id/config", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deps.db.getProject(id)) return reply.code(404).send({ error: "project not found" });
    const v = validateProjectConfigOverride((req.body as { config?: unknown })?.config ?? req.body);
    if (!v.ok) return reply.code(400).send({ error: `invalid config: ${v.error}` });
    deps.db.setProjectConfig(id, v.value);
    return deps.db.getProject(id);
  });

  // --- Daemon-GLOBAL platform tuning (rate-limit numbers / watcher cadences / op timeouts) ---
  // HUMAN-only + NOT project-scoped (one shared daemon), exactly like the trust-boundary project
  // config PATCH above: NO agent MCP tool exposes this surface — globals are human-set only. GET
  // returns the stored override + the resolved platform group; PATCH validates → 400 on bad, else
  // upserts the singleton blob. (Boot-bound values take effect on the next daemon restart; rate-limit
  // & webhook timeouts resolve live — see the epic's restart-split.)
  app.get("/api/platform/config", async () => {
    const override = deps.db.getPlatformConfig();
    return { override, resolved: resolveConfig(undefined, override).platform };
  });
  app.patch("/api/platform/config", async (req, reply) => {
    const v = validatePlatformConfigOverride((req.body as { config?: unknown })?.config ?? req.body);
    if (!v.ok) return reply.code(400).send({ error: `invalid platform config: ${v.error}` });
    deps.db.setPlatformConfig(v.value);
    return { ok: true, override: v.value };
  });

  app.post("/api/projects/:id/agents", async (req, reply) => {
    const projectId = (req.params as { id: string }).id;
    if (!deps.db.getProject(projectId)) return reply.code(404).send({ error: "project not found" });
    const b = (req.body ?? {}) as { name?: string; startupPrompt?: string };
    if (!b.name) return reply.code(400).send({ error: "name required" });
    const agent: Agent = {
      id: randomUUID(), projectId, name: b.name,
      startupPrompt: b.startupPrompt ?? "", position: deps.db.listAgents(projectId).length,
      profileId: null, // additive: agents start profile-less (P3 wires up profile assignment)
    };
    deps.db.insertAgent(agent);
    return reply.code(201).send(agent);
  });

  // Edit an agent preset (name / startup prompt). Same store the spawn path reads, so a saved
  // prompt is injected as the first turn of the NEXT new session in this agent.
  app.post("/api/agents/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deps.db.getAgent(id)) return reply.code(404).send({ error: "agent not found" });
    const b = (req.body ?? {}) as { name?: string; startupPrompt?: string; profileId?: string | null };
    // Assigning a profile: a non-null profileId must reference a real profile (null CLEARS — the agent
    // falls back to the plain backstop). Pass the whole patch through; updateAgent writes only the
    // provided keys (`profileId: null` clears, an absent key leaves the assignment as-is).
    if (b.profileId != null && !deps.db.getProfile(b.profileId)) return reply.code(404).send({ error: "profile not found" });
    deps.db.updateAgent(id, b);
    return deps.db.getAgent(id);
  });

  app.post("/api/projects/:id/tasks", async (req, reply) => {
    const projectId = (req.params as { id: string }).id;
    if (!deps.db.getProject(projectId)) return reply.code(404).send({ error: "project not found" });
    const b = (req.body ?? {}) as { title?: string; body?: string; columnKey?: string; priority?: string };
    if (!b.title) return reply.code(400).send({ error: "title required" });
    if (b.priority !== undefined && !isTaskPriority(b.priority)) return reply.code(400).send({ error: "priority must be one of p0|p1|p2|p3" });
    const now = new Date().toISOString();
    const task: Task = {
      id: randomUUID(), projectId, title: b.title, body: b.body ?? "",
      columnKey: b.columnKey ?? "backlog", position: Date.now(),
      priority: b.priority ?? "p2", createdAt: now, updatedAt: now,
    };
    deps.db.insertTask(task);
    return reply.code(201).send(task);
  });

  // Update / move a task (kanban drag writes columnKey + position here — SAME store the
  // MCP task tools read/write, so UI and agent never diverge).
  app.post("/api/tasks/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as Partial<Pick<Task, "title" | "body" | "columnKey" | "position" | "priority">>;
    if (b.priority !== undefined && !isTaskPriority(b.priority)) return reply.code(400).send({ error: "priority must be one of p0|p1|p2|p3" });
    deps.db.updateTask(id, b);
    return { ok: true };
  });

  app.post("/api/agents/:id/sessions", async (req) => {
    const id = (req.params as { id: string }).id;
    const { role } = (req.body as { role?: string }) ?? {};
    if (role === "manager") return deps.sessions.startManager(id);
    if (role === "platform") return deps.sessions.startPlatformLead(id);
    // P3 force-plain override (web "Spawn → force plain"): a VANILLA session even in an agent with a
    // manager/platform profile — bypasses the profile entirely (role null, agent's own prompt, no allow
    // delta). Absent/undefined role = auto (the profile's role applies — P2 default).
    if (role === "plain") return deps.sessions.startNew(id, { forcePlain: true });
    return deps.sessions.startNew(id);
  });
  // Manual (human) resume from the UI — the ONE resume path allowed to force-resurrect a RECYCLED
  // session (allowSuperseded). The automatic paths (wake / rate-limit / boot) cannot; only the user
  // may deliberately bring a retired session back, to inspect or recover it.
  app.post("/api/sessions/:id/resume", async (req) =>
    deps.sessions.resume((req.params as { id: string }).id, { allowSuperseded: true }));
  app.post("/api/sessions/:id/fork", async (req) =>
    deps.sessions.forkSession((req.params as { id: string }).id));
  // Pending one-shot wake-ups scheduled for a session (the wake_me primitive) — read-only.
  app.get("/api/sessions/:id/wakes", async (req) =>
    deps.db.listWakesForSession((req.params as { id: string }).id));
  // A session's queued (not-yet-delivered) inbound messages — worker reports / turns held while the
  // session is busy or the human is mid-compose. Read-only; they drain automatically. Shown in the UI.
  app.get("/api/sessions/:id/queue", async (req) =>
    ({ pending: deps.pty.getPending((req.params as { id: string }).id) }));
  // Cancel one of a session's pending wakes (scoped: the wake must belong to that session).
  app.delete("/api/sessions/:id/wakes/:wakeId", async (req, reply) => {
    const { id, wakeId } = req.params as { id: string; wakeId: string };
    const w = deps.db.getWake(wakeId);
    if (!w || w.sessionId !== id) return reply.code(404).send({ error: "wake not found for this session" });
    deps.db.deleteWake(wakeId);
    return reply.send({ cancelled: true });
  });
  app.post("/api/sessions/:id/stop", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { mode } = (req.body as { mode?: "graceful" | "hard" }) ?? {};
    deps.pty.stop(id, mode === "hard" ? "hard" : "graceful");
    return reply.send({ ok: true });
  });
  // Manual per-session rate-limit override + retry-now (HUMAN/REST only — trust boundary like
  // stop/merge, NEVER an MCP tool). MIRRORS RateLimitWatcher.resume() exactly (the proven recovery
  // path): end the park, clear the episode deadline, relax the global awareness latch, and (if the
  // session is live) re-submit the held turn — so a transient overload no longer strands a session
  // for hours. No-op-safe on a session that isn't parked. ADDITIVE: the auto-resume watcher + the
  // detect path are untouched. Returns the updated session (404 if unknown).
  app.post("/api/sessions/:id/rate-limit/clear", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deps.db.getSession(id)) return reply.code(404).send({ error: "session not found" });
    deps.db.setRateLimitedUntil(id, null, null);
    deps.db.clearRateLimitDeadline(id);
    clearClaudeRateLimit();
    deps.pty.resumeAfterRateLimit(id); // re-submits the held turn; false (no-op) if not live
    return reply.send(deps.db.getSession(id));
  });
  // Send a turn to a session through the busy-gated queue, so a human composer and the
  // programmatic worker_report enqueue share ONE coordinated submission path (the daemon owns
  // the Enter). Returns { delivered:true } if it went out now, { delivered:false, position:N }
  // if held until the in-flight turn ends, or { delivered:false } if the session isn't live.
  app.post("/api/sessions/:id/input", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { text } = (req.body as { text?: string }) ?? {};
    if (typeof text !== "string" || !text.trim()) return reply.code(400).send({ error: "text required" });
    return reply.send(deps.pty.enqueueStdin(id, text));
  });
  // Human-initiated merge of a worker's branch (the Review panel / #18c). Runs the daemon's
  // fail-closed build gate then merges --no-ff; manager is derived from the worker's parent so the
  // existing ownership check holds. Returns { merged } or { merged:false, reason }.
  app.post("/api/sessions/:id/merge", async (req, reply) => {
    const { id } = req.params as { id: string };
    const worker = deps.db.getSession(id);
    if (!worker) return reply.code(404).send({ error: "session not found" });
    if (!worker.parentSessionId) return reply.code(400).send({ error: "not a worker (no manager)" });
    try {
      return reply.send(await deps.sessions.confirmWorkerMerge(worker.parentSessionId, id));
    } catch (e) {
      return reply.code(400).send({ error: (e as Error).message });
    }
  });

  // --- Per-project session Archive (HUMAN/REST only — like stop/fork/merge, NEVER an MCP tool).
  // Archive moves a dead/exited session (a manager cascades to its workers) out of the rail + god-eye
  // views; the snapshot was already captured on exit. Restore brings one back (view-only if dead);
  // Delete is permanent (row(s) + snapshot). An EXPECTED failure (live group / not archived) comes
  // back 400 with the reason so the UI shows it. ---
  app.post("/api/sessions/:id/archive", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deps.db.getSession(id)) return reply.code(404).send({ error: "session not found" });
    try { return reply.send(deps.sessions.archiveSession(id)); }
    catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
  app.post("/api/sessions/:id/restore", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deps.db.getSession(id)) return reply.code(404).send({ error: "session not found" });
    try { return reply.send(deps.sessions.restoreSession(id)); }
    catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
  app.delete("/api/sessions/:id/archive", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deps.db.getSession(id)) return reply.code(404).send({ error: "session not found" });
    try { return reply.send(deps.sessions.deleteArchivedSession(id)); }
    catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });
  // Archived sessions for a project's Archive tab, each tagged with whether a transcript snapshot
  // was captured on exit (false ⇒ "no transcript captured" — it was already dead when archived).
  app.get("/api/projects/:id/archive", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deps.db.getProject(id)) return reply.code(404).send({ error: "project not found" });
    return deps.db.listArchivedSessions(id).map((s) => ({ ...s, snapshotExists: archivedTranscriptExists(id, s.id) }));
  });
  // Cross-project Archive (god-eye): archived sessions across ALL projects, each enriched with
  // projectId/projectName (already on the SessionListItem) + snapshotExists, newest-archived first.
  // Read-only; the cross-project Archive page groups these Project → Agent.
  app.get("/api/archived-sessions", async () =>
    deps.db.listAllArchivedSessions().map((s) => ({ ...s, snapshotExists: archivedTranscriptExists(s.projectId, s.id) })));

  // --- Plain SHELL terminals (human-only): spawn pwsh/cmd/bash in a project's repo cwd ---
  //
  // ╔═ TRUST BOUNDARY — HUMAN-ONLY, NEVER AN MCP TOOL ═════════════════════════════════════════════╗
  // ║ POST /api/terminals takes an arbitrary executable path = HOST RCE BY DESIGN, the same hazard   ║
  // ║ class as orchestration.gateCommand (which the agent-facing config validator REJECTS for this   ║
  // ║ exact reason). It is therefore exposed ONLY here, on the loopback-only REST surface, and is     ║
  // ║ DELIBERATELY absent from every MCP server (loom-tasks / loom-orchestration / loom-platform).   ║
  // ║ A manager/worker agent that could spawn an arbitrary shell would escape the acceptEdits sandbox ║
  // ║ → full host compromise. Do NOT add an MCP tool for this. (See PtyHost.spawnShell.)             ║
  // ╚═════════════════════════════════════════════════════════════════════════════════════════════════╝
  app.get("/api/terminals", async () => deps.pty.listShells());
  // The host's detected default shell — prefills the "+ Shell" modal (the human can override it).
  app.get("/api/terminals/default-shell", async () => ({ command: detectDefaultShell() }));
  app.post("/api/terminals", async (req, reply) => {
    const b = (req.body ?? {}) as { projectId?: string; command?: string; args?: string[]; label?: string };
    if (!b.projectId) return reply.code(400).send({ error: "projectId required" });
    const p = deps.db.getProject(b.projectId);
    if (!p) return reply.code(404).send({ error: "project not found" });
    const command = (b.command ?? "").trim() || detectDefaultShell();
    const args = Array.isArray(b.args) ? b.args.filter((a) => typeof a === "string") : [];
    const id = randomUUID();
    // Initial size = the project's resolved pty grid; the viewer resizes to fit its pane on attach.
    const geometry = resolveConfig(p.config).pty;
    const label = (b.label ?? "").trim() || `${p.name} · shell`;
    deps.pty.spawnShell({ id, cwd: p.repoPath, command, args, geometry, label });
    const term: ShellTerminal = { id, cwd: p.repoPath, command, label, alive: true };
    return reply.code(201).send(term);
  });
  // Kill a shell terminal (the tile's close/kill button). Hard kill — a shell has no graceful resumable
  // stop like a Claude session; pty.kill tears down the tree (node-pty Job Object, no orphans). The
  // onExit handler then drops it from the live map. Idempotent (a no-op if already gone).
  app.delete("/api/terminals/:id", async (req) => {
    deps.pty.stop((req.params as { id: string }).id, "hard");
    return { ok: true };
  });

  // --- Live terminal: attach/detach (binary pty bytes + JSON control) ---
  // Shared by Claude sessions AND shell terminals (same `live` map): the transport is pty-generic.
  app.get("/ws/term/:sessionId", { websocket: true }, (socket: WebSocket, req) => {
    const { sessionId } = req.params as { sessionId: string };
    const unsub = deps.pty.subscribe(sessionId, {
      onData: (b) => { if (socket.readyState === socket.OPEN) socket.send(b); },
      onControl: (e) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(e)); },
    });
    socket.on("message", (raw: Buffer) => {
      let msg: TerminalInput;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      // RAW passthrough — NOT the busy-gated enqueueStdin (which is for programmatic agent turns).
      if (msg.type === "stdin") deps.pty.writeStdin(sessionId, msg.data);
      else if (msg.type === "repaint") deps.pty.repaint(sessionId);
      // resize is honored for SHELL terminals only; a no-op for pinned Claude ptys (see PtyHost.resize).
      else if (msg.type === "resize") deps.pty.resize(sessionId, msg.cols, msg.rows);
    });
    socket.on("close", unsub); // detach does NOT kill the pty — sessions/shells outlive viewers
  });

  return app;
}
