import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import type { WebSocket } from "ws";
import type { TerminalInput, ShellTerminal, Project, Agent, Task, ProjectConfigOverride, Schedule, ApiKey, ApiKeyCaps, ApiKeyStatus } from "@loom/shared";
import { resolveConfig } from "@loom/shared";
import { resolveWebDistDir } from "../paths.js";
import { loomVersion } from "../version.js";
import { nextFireAt } from "../orchestration/cron.js";
import { readTranscript, readArchivedTranscript, archivedTranscriptExists, engineTranscriptExists, deleteArchivedTranscript, deleteProjectArchives } from "../sessions/transcript.js";
import type { Db } from "../db.js";
import type { PtyHost } from "../pty/host.js";
import { detectDefaultShell } from "../pty/host.js";
import type { SessionService } from "../sessions/service.js";
import type { TaskMcpRouter } from "../mcp/server.js";
import type { OrchestrationMcpRouter } from "../mcp/orchestration.js";
import type { PlatformMcpRouter } from "../mcp/platform.js";
import type { AuditMcpRouter } from "../mcp/audit.js";
import type { SetupMcpRouter } from "../mcp/setup.js";
import type { RunMcpRouter } from "../mcp/run.js";
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

/** Bounds for the Preset Prompts REST surface (label = short button text; prompt = the text to send). */
const PRESET_LABEL_MAX = 200;
const PRESET_PROMPT_MAX = 10_000;
const PRESET_RATIONALE_MAX = 2_000;
/** Validate a preset string field: must be a non-blank string within its bound. Returns an error
 *  message (for a 400) or null when valid. */
const validatePresetField = (name: string, v: unknown, max: number): string | null => {
  if (typeof v !== "string") return `${name} must be a string`;
  if (v.trim().length === 0) return `${name} must not be empty`;
  if (v.length > max) return `${name} must be at most ${max} characters`;
  return null;
};

export interface GatewayDeps {
  db: Db;
  pty: PtyHost;
  sessions: SessionService;
  mcp: TaskMcpRouter;
  orchMcp: OrchestrationMcpRouter;
  platformMcp: PlatformMcpRouter;
  auditMcp: AuditMcpRouter;
  setupMcp: SetupMcpRouter;
  runMcp: RunMcpRouter;
  control: OrchestrationControl;
  usageStatus: UsageStatusPoller;
  /** Loopback control hook for `loom stop`: trigger the daemon's GRACEFUL shutdown (snapshot live
   * transcripts + clean watcher teardown, then exit 0). Wired by index.ts to the SAME path the
   * SIGINT/SIGTERM handlers use — Windows has no real SIGTERM, so the CLI can't signal a detached
   * daemon into the graceful path; this endpoint is how it reaches it cross-platform. */
  requestShutdown: () => void;
}

/** The daemon's own non-UI route prefixes. An unmatched GET under any of these must NEVER fall back to
 * the SPA index.html — an unknown `/api/*` stays a JSON 404 (so clients see the real error, not HTML),
 * and `/ws` stays the websocket-upgrade route. Boundary-aware so a client route like `/apidocs` (were
 * one to exist) is NOT misclassified as the `/api` surface. */
const isReservedDaemonPath = (pathname: string): boolean =>
  ["/api", "/ws", "/mcp", "/internal"].some((p) => pathname === p || pathname.startsWith(`${p}/`));

export async function buildServer(deps: GatewayDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  await app.register(websocket);

  // --- Single-process mode (Releases v1, Part 1): serve the PREBUILT web viewport from the daemon's own
  // loopback origin, so the whole app runs as ONE process on one port (the prerequisite for `npx loomctl`).
  // ADDITIVE + dev-safe: in dev the vite server (:5317) still serves the UI and proxies /api + /ws here,
  // so `pnpm web` is byte-for-byte unchanged — this only adds a second way to reach the UI. The web app
  // calls RELATIVE /api + /ws, so serving it from this same origin needs NO web change. A MISSING dist is
  // tolerated: log once + skip static; the API/WS daemon still boots (dev before a web build, or an
  // API-only deployment). Resolver (LOOM_WEB_DIST override → bundled → monorepo) lives in paths.ts.
  const webDist = resolveWebDistDir();
  if (fs.existsSync(path.join(webDist, "index.html"))) {
    await app.register(fastifyStatic, { root: webDist, index: ["index.html"] });
    // SPA fallback: an unmatched GET that is NOT a reserved daemon path serves index.html, so the client
    // router owns deep links (e.g. /board). @fastify/static's wildcard serves any real asset first and
    // only routes a genuine miss here. The reserved-path guard is what keeps this from swallowing the
    // /api JSON 404s or the /ws upgrade — those fall through to the normal JSON 404 below.
    app.setNotFoundHandler((req, reply) => {
      const pathname = req.url.split("?")[0] ?? req.url;
      if (req.method === "GET" && !isReservedDaemonPath(pathname)) return reply.sendFile("index.html");
      return reply.code(404).send({ error: "not found" });
    });
    // eslint-disable-next-line no-console
    console.log(`[gateway] serving web viewport from ${webDist} (single-process mode)`);
  } else {
    // eslint-disable-next-line no-console
    console.log(`[gateway] no built web viewport at ${webDist} — serving API/WS only (run a web build, or set LOOM_WEB_DIST, to enable single-process mode)`);
  }

  // BOOT-BOUND git-write timeouts: resolve the daemon-global `platform.timeouts` ONCE at boot (this
  // fn runs once, from index.ts) and thread gitLocalMs/gitPushMs into every GitWriter the human REST
  // git routes construct. A PATCH to these takes effect on the next daemon restart (the lead verifies
  // this post-merge). GitWriter floors each to ≥1s, so a misconfig can't make every git write fail-fast.
  const gitWriteTimeouts = (() => {
    const t = resolveConfig(undefined, deps.db.getPlatformConfig()).platform.timeouts;
    return { gitLocalMs: t.gitLocalMs, gitPushMs: t.gitPushMs };
  })();

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

  // --- Platform-auditor MCP (role-gated to 'auditor'; READ-AND-FILE-ONLY transcript review — P5).
  // A distinct route + router so an auditor session NEVER reaches the Lead's elevated /mcp-platform
  // (its resolveRole gates role==="platform") — the load-bearing P5 prompt-injection containment. ---
  app.all("/mcp-audit/:sessionId", async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    reply.hijack();
    await deps.auditMcp.handle(req.raw, reply.raw, sessionId, req.body);
  });

  // --- Setup-Assistant MCP (role-gated to 'setup'; the ungated, user-facing onboarding assistant's
  // CURATED fail-closed surface — E1-3). A distinct route + router so a 'setup' session reaches ONLY its
  // curated tools: it 404s on /mcp-platform, /mcp-orch, /mcp-audit (their resolveRole gate other roles),
  // and no agent/MCP path can mint a 'setup' session, so a non-setup session can never reach here. ---
  app.all("/mcp-setup/:sessionId", async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    reply.hijack();
    await deps.setupMcp.handle(req.raw, reply.raw, sessionId, req.body);
  });

  // --- Agent-Run MCP (role-gated to 'run'; the ephemeral run's ONLY tool is submit_result — R2). A
  // distinct route + router so a `run` session reaches NOTHING but its restricted surface (it 404s on
  // every other /mcp* route, and buildMcpServers mounts only loom-run for it — not even loom-tasks). ---
  app.all("/mcp-run/:sessionId", async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    reply.hijack();
    await deps.runMcp.handle(req.raw, reply.raw, sessionId, req.body);
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
  // --- Daemon version (Releases v1, Part 3) — the user-facing `loom` package version, read at RUNTIME
  // from the umbrella package.json (loomVersion() walks up to the `name:"loom"` package.json; NO hardcoded
  // second copy that can drift). READ-ONLY on this existing REST surface — no trust-boundary change; the
  // web footer fetches it. ⚠️ Part 2 must keep a `name:"loom"` package.json on the daemon's walk-up path
  // (or set LOOM_VERSION) so this still resolves from the PACKAGED form, not just the monorepo. ---
  app.get("/api/version", async () => ({ version: loomVersion() }));
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
    const b = (req.body ?? {}) as { agentId?: string; cron?: string; enabled?: boolean; kind?: string };
    if (!b.agentId || !b.cron) return reply.code(400).send({ error: "agentId and cron required" });
    if (!deps.db.getAgent(b.agentId)) return reply.code(404).send({ error: "agent not found" });
    // P5: kind selects what a fire spawns — "manager" (default) or "auditor" (the read-and-file-only
    // Platform Auditor). Reject any other value rather than silently coercing.
    if (b.kind !== undefined && b.kind !== "manager" && b.kind !== "auditor") {
      return reply.code(400).send({ error: 'kind must be "manager" or "auditor"' });
    }
    let next: string;
    try { next = nextFireAt(b.cron, new Date()); } catch { return reply.code(400).send({ error: "invalid cron expression" }); }
    const schedule: Schedule = {
      id: randomUUID(), agentId: b.agentId, cron: b.cron,
      enabled: b.enabled ?? true, nextFireAt: next, lastFiredAt: null, createdAt: new Date().toISOString(),
      kind: (b.kind as Schedule["kind"]) ?? "manager",
    };
    deps.db.insertSchedule(schedule);
    return reply.code(201).send(schedule);
  });
  app.post("/api/schedules/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deps.db.getSchedule(id)) return reply.code(404).send({ error: "schedule not found" });
    const b = (req.body ?? {}) as { cron?: string; enabled?: boolean; kind?: string };
    if (b.kind !== undefined && b.kind !== "manager" && b.kind !== "auditor") {
      return reply.code(400).send({ error: 'kind must be "manager" or "auditor"' });
    }
    const patch: { cron?: string; enabled?: boolean; nextFireAt?: string; kind?: "manager" | "auditor" } = {};
    if (typeof b.enabled === "boolean") patch.enabled = b.enabled;
    if (b.kind === "manager" || b.kind === "auditor") patch.kind = b.kind;
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

  // --- Preset Prompts (the GLOBAL "terminal action-buttons" store): a daemon-wide list of label+prompt
  // presets the web composer sends to a session on click, managed INLINE in the UI (full CRUD). Plain
  // human/UI data — there is intentionally NO MCP path (an agent never reaches this) and NO trust-boundary
  // concern (unlike gateCommand / the git+vault writers). Ordered by position; POST appends at the end. ---
  app.get("/api/preset-prompts", async () => deps.db.listPresetPrompts());
  app.post("/api/preset-prompts", async (req, reply) => {
    const b = (req.body ?? {}) as { label?: unknown; prompt?: unknown };
    const err = validatePresetField("label", b.label, PRESET_LABEL_MAX) ?? validatePresetField("prompt", b.prompt, PRESET_PROMPT_MAX);
    if (err) return reply.code(400).send({ error: err });
    const created = deps.db.createPresetPrompt({ label: (b.label as string).trim(), prompt: b.prompt as string });
    return reply.code(201).send(created);
  });
  app.put("/api/preset-prompts/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deps.db.getPresetPrompt(id)) return reply.code(404).send({ error: "preset prompt not found" });
    const b = (req.body ?? {}) as { label?: unknown; prompt?: unknown; position?: unknown };
    const patch: { label?: string; prompt?: string; position?: number } = {};
    if (b.label !== undefined) {
      const e = validatePresetField("label", b.label, PRESET_LABEL_MAX);
      if (e) return reply.code(400).send({ error: e });
      patch.label = (b.label as string).trim();
    }
    if (b.prompt !== undefined) {
      const e = validatePresetField("prompt", b.prompt, PRESET_PROMPT_MAX);
      if (e) return reply.code(400).send({ error: e });
      patch.prompt = b.prompt as string;
    }
    if (b.position !== undefined) {
      if (typeof b.position !== "number" || !Number.isFinite(b.position)) return reply.code(400).send({ error: "position must be a finite number" });
      patch.position = b.position;
    }
    deps.db.updatePresetPrompt(id, patch);
    return deps.db.getPresetPrompt(id);
  });
  app.delete("/api/preset-prompts/:id", async (req) => {
    deps.db.deletePresetPrompt((req.params as { id: string }).id);
    return { ok: true };
  });

  // --- Preset Prompt SUGGESTIONS (the "Suggested from your usage" store): candidate presets proposed by
  // the Platform Auditor (via the role-gated preset_suggestion_suggest MCP tool) or the human/UI, awaiting
  // an in-app Adopt/Dismiss. GET lists PENDING only. POST is a DEDUPE-GUARDED upsert (here for
  // completeness/testability — the real producer is the Auditor's narrow MCP tool); a prompt already
  // present as a preset OR any-status suggestion is a no-op ({deduped:true}). Adopt mints a real preset
  // from the suggestion; dismiss marks it dismissed (404 on a missing id). Like preset-prompts: plain
  // human/UI data, ordered by position. ---
  app.get("/api/preset-prompt-suggestions", async () => deps.db.listPresetPromptSuggestions());
  app.post("/api/preset-prompt-suggestions", async (req, reply) => {
    const b = (req.body ?? {}) as { label?: unknown; prompt?: unknown; rationale?: unknown };
    const err = validatePresetField("label", b.label, PRESET_LABEL_MAX) ?? validatePresetField("prompt", b.prompt, PRESET_PROMPT_MAX);
    if (err) return reply.code(400).send({ error: err });
    if (b.rationale !== undefined && b.rationale !== null) {
      if (typeof b.rationale !== "string") return reply.code(400).send({ error: "rationale must be a string" });
      if (b.rationale.length > PRESET_RATIONALE_MAX) return reply.code(400).send({ error: `rationale must be at most ${PRESET_RATIONALE_MAX} characters` });
    }
    const rationale = typeof b.rationale === "string" ? b.rationale.trim() : null;
    const res = deps.db.suggestPresetPrompt({ label: (b.label as string).trim(), prompt: b.prompt as string, rationale });
    if (res.deduped) return reply.code(200).send({ deduped: true, reason: res.reason });
    return reply.code(201).send(res.suggestion);
  });
  app.post("/api/preset-prompt-suggestions/:id/adopt", async (req, reply) => {
    // missing id → 404; an already-adopted/dismissed id throws → 409 Conflict (stale list / double-click).
    let created;
    try { created = deps.db.adoptPresetPromptSuggestion((req.params as { id: string }).id); }
    catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
    if (!created) return reply.code(404).send({ error: "preset prompt suggestion not found" });
    return reply.code(201).send(created);
  });
  app.post("/api/preset-prompt-suggestions/:id/dismiss", async (req, reply) => {
    // missing id → 404; an already-adopted/dismissed id throws → 409 Conflict (stale list / double-click).
    let ok;
    try { ok = deps.db.dismissPresetPromptSuggestion((req.params as { id: string }).id); }
    catch (e) { return reply.code(409).send({ error: (e as Error).message }); }
    if (!ok) return reply.code(404).send({ error: "preset prompt suggestion not found" });
    return { ok: true };
  });

  // --- Hook relay target (loopback only) ---
  app.post("/internal/hook", async (req, reply) => {
    if (!LOOPBACK.has(req.ip)) return reply.code(403).send("forbidden");
    const body = req.body as { sessionId?: string; hook?: Record<string, unknown> };
    if (body?.sessionId && body.hook) deps.pty.deliverHook(body.sessionId, body.hook);
    return reply.send({ ok: true });
  });

  // --- Graceful shutdown control hook (loopback only) — the cross-platform stop path for `loom stop`.
  // Windows detached processes have NO real SIGTERM, so the management CLI can't signal a backgrounded
  // daemon into its graceful teardown; it POSTs here instead. This triggers the SAME path the
  // SIGINT/SIGTERM handlers run (snapshot live transcripts → stop every watcher → exit 0). Exits 0
  // (clean stop), NOT 75 (75 is the supervisor's RESTART sentinel — a stop must never relaunch).
  // Trust posture mirrors /internal/hook EXACTLY: loopback-gated, NOT an agent MCP tool, unreachable by
  // any agent session (same boundary as the gate/vault/git writers). We ack 202 first and defer the exit
  // one tick so the response flushes before the process dies (the CLI reads the ack, then polls the port
  // until it stops answering).
  app.post("/internal/shutdown", async (req, reply) => {
    if (!LOOPBACK.has(req.ip)) return reply.code(403).send("forbidden");
    setTimeout(() => deps.requestShutdown(), 50);
    return reply.code(202).send({ ok: true, stopping: true });
  });

  // --- REST: read ---
  app.get("/api/projects", async () => deps.db.listProjects());

  // --- Platform home discovery (Platform Manager P6): the reserved "Loom Platform" project + its
  // agents (the Platform Lead + Auditor), surfaced to the dedicated Platform UI section. The reserved
  // project is HIDDEN from the ordinary picker (GET /api/projects excludes reserved), so this READ-ONLY
  // endpoint is the one way the web discovers it. NO write/elevated capability lives here — the human
  // spawn/stop/schedule controls reuse the EXISTING agent-session, stop, and schedule REST routes.
  // 404 only if no reserved home exists (impossible after boot-seed). ---
  app.get("/api/platform/home", async (_req, reply) => {
    const project = deps.db.listAllProjects().find((p) => p.reserved);
    if (!project) return reply.code(404).send({ error: "no reserved Loom Platform project" });
    const agents = deps.db.listAgents(project.id);
    // LIVE-SESSION INFO (duplicate-singleton guard): surface each platform agent's currently-LIVE
    // sessions so a spawn decision sees an existing live Lead/Auditor before minting a SECOND (a manager
    // once spawned a duplicate Lead because this endpoint omitted liveness). Sourced from db.liveSessions
    // — the canonical live-over-recency query — so a recently-STOPPED Lead can NEVER mask an idle-but-LIVE
    // one. Each entry is a light summary (no transcript/cwd/branch); `role` is the singleton key
    // ("platform" = Lead, "auditor" = Auditor) and `agentId` lets a consumer roll up per-agent counts.
    const liveSessions = agents.flatMap((a) =>
      deps.db.liveSessions(a.id).map((s) => ({
        id: s.id, agentId: s.agentId, role: s.role,
        processState: s.processState, busy: s.busy,
        createdAt: s.createdAt, lastActivity: s.lastActivity,
      })),
    );
    return { project, agents, liveSessions };
  });

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

  // Vault WRITE (HUMAN/REST + the role-gated PLATFORM exception). No loom-tasks/orchestration MCP tool
  // exposes it — ordinary agents already write via their session cwd + the auto-committer. The Platform
  // Lead (P3) reaches writeVaultFile through the platform MCP `vault_write`, gated strictly to
  // role==="platform". Every op is vault-confined by writer.ts's path-traversal guard and commits
  // through the SAME path as the auto-committer. A traversal escape → 400 (never writes).
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

  // Git WRITE — HUMAN/REST + the role-gated PLATFORM exception. This is a TRUST-BOUNDARY surface like
  // the vault writer and gateCommand: checkout/commit and ESPECIALLY push (outward-facing, network,
  // irreversible) are absent from the loom-tasks/orchestration (manager/worker) MCP servers — no
  // ordinary agent can checkout/commit/push. The Platform Lead (P3) reaches the SAME GitWriter through
  // the platform MCP, gated strictly to role==="platform" (a human-created-only session). Every op is
  // bounded + non-interactive in GitWriter (a hung push can't wedge the daemon). An EXPECTED git failure
  // (dirty tree, no upstream, conflict) comes back as 200 { ok:false, error } so the UI shows the
  // reason — never a 500.
  app.post("/api/projects/:id/git/checkout", async (req, reply) => {
    const p = deps.db.getProject((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    const branch = ((req.body ?? {}) as { branch?: string }).branch;
    if (!branch) return reply.code(400).send({ error: "branch required" });
    return new GitWriter(p.repoPath, gitWriteTimeouts).checkout(branch);
  });
  app.post("/api/projects/:id/git/branch", async (req, reply) => {
    const p = deps.db.getProject((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    const name = ((req.body ?? {}) as { name?: string }).name;
    if (!name) return reply.code(400).send({ error: "name required" });
    return new GitWriter(p.repoPath, gitWriteTimeouts).createBranch(name);
  });
  app.post("/api/projects/:id/git/commit", async (req, reply) => {
    const p = deps.db.getProject((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    const message = ((req.body ?? {}) as { message?: string }).message;
    if (!message) return reply.code(400).send({ error: "message required" });
    // Plain commit under the repo's configured identity — no -c overrides, no Co-Authored-By trailer.
    return new GitWriter(p.repoPath, gitWriteTimeouts).commit(message);
  });
  app.post("/api/projects/:id/git/push", async (req, reply) => {
    const p = deps.db.getProject((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    return new GitWriter(p.repoPath, gitWriteTimeouts).push();
  });

  // --- REST: create / bind ---
  app.post("/api/projects", async (req, reply) => {
    const b = (req.body ?? {}) as { name?: string; repoPath?: string; vaultPath?: string; config?: ProjectConfigOverride };
    if (!b.name || !b.repoPath || !b.vaultPath)
      return reply.code(400).send({ error: "name, repoPath, vaultPath required" });
    const project: Project = {
      id: randomUUID(), name: b.name, repoPath: b.repoPath, vaultPath: b.vaultPath,
      config: b.config ?? {}, createdAt: new Date().toISOString(), archivedAt: null,
      reserved: false, // a human-created project via REST is an ordinary project (never reserved/system)
    };
    deps.db.insertProject(project);
    return reply.code(201).send(project);
  });

  // Soft-archived projects (read-only) — the web "Archived" section that surfaces restore / permanent-
  // delete. Static path, declared before /api/projects/:id so it never collides with the param routes.
  app.get("/api/projects/archived", async () => deps.db.listArchivedProjects());

  // --- HUMAN-only project management (rename / archive / restore / PERMANENT delete). These are
  // DESTRUCTIVE, trust-boundary surfaces exposed ONLY here on the loopback REST — exactly like session
  // archive/delete + gateCommand. NO agent MCP tool (loom-tasks / loom-orchestration / loom-platform /
  // loom-audit) reaches any of them: an agent can never rename, archive, or delete a project/agent.
  // Two GUARDS, server-side with clear 4xx: (a) the reserved "Loom Platform" home is NEVER archivable
  // or deletable; (b) a project/agent with any LIVE session is blocked ("stop the fleet first"). ---

  // STRUCTURAL edit of a project (name / vaultPath). Distinct from the config PATCH below (the
  // validated machine config). Allowed on a reserved project (metadata only — not a removal).
  app.patch("/api/projects/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deps.db.getProject(id)) return reply.code(404).send({ error: "project not found" });
    const b = (req.body ?? {}) as { name?: unknown; vaultPath?: unknown };
    if (b.name !== undefined && (typeof b.name !== "string" || !b.name.trim()))
      return reply.code(400).send({ error: "name must be a non-empty string" });
    if (b.vaultPath !== undefined && (typeof b.vaultPath !== "string" || !b.vaultPath.trim()))
      return reply.code(400).send({ error: "vaultPath must be a non-empty string" });
    deps.db.updateProject(id, {
      name: b.name === undefined ? undefined : (b.name as string).trim(),
      vaultPath: b.vaultPath === undefined ? undefined : (b.vaultPath as string).trim(),
    });
    return deps.db.getProject(id);
  });

  // Soft-remove (archive) a project — hides it from the project list; rows/sessions are retained.
  // GUARD: refuse the reserved home; refuse while any session is live (stop the fleet first).
  app.delete("/api/projects/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const p = deps.db.getProject(id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    if (p.reserved) return reply.code(400).send({ error: "cannot archive the reserved Loom Platform project" });
    const live = deps.db.countLiveSessionsInProject(id);
    if (live > 0) return reply.code(400).send({ error: `cannot archive a project with live sessions — stop the fleet first (${live} still live)` });
    deps.db.archiveProject(id);
    return { ok: true };
  });

  // Restore a soft-archived project back to the picker (clear archived_at) — mirrors session restore.
  app.post("/api/projects/:id/restore", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deps.db.getProject(id)) return reply.code(404).send({ error: "project not found" });
    deps.db.restoreProject(id);
    return deps.db.getProject(id);
  });

  // PERMANENTLY delete a project (DISTINCT from the bare DELETE archive above) — irreversible CASCADE of
  // its agents/sessions/tasks/schedules/keys/runs + their on-disk transcript snapshots. The strong
  // type-the-name confirm is the web's job; this just enforces the guards then executes. GUARD: refuse
  // the reserved home; refuse while any session is live.
  app.delete("/api/projects/:id/permanent", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const p = deps.db.getProject(id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    if (p.reserved) return reply.code(400).send({ error: "cannot delete the reserved Loom Platform project" });
    const live = deps.db.countLiveSessionsInProject(id);
    if (live > 0) return reply.code(400).send({ error: `cannot delete a project with live sessions — stop the fleet first (${live} still live)` });
    const { sessionIds } = deps.db.deleteProject(id);
    deleteProjectArchives(id); // best-effort: drop the whole LOOM_HOME/archives/<id> snapshot dir
    return { ok: true, deleted: { project: id, agents: true, sessions: sessionIds.length } };
  });

  // PERMANENTLY delete an agent (CASCADE its sessions + their wakes/snapshots, its schedules, its runs).
  // HUMAN-only; no archive intermediate (an agent has no soft-archive). GUARD: refuse while any of the
  // agent's sessions is live ("stop the fleet first"). The web hides this for the reserved project's agents.
  app.delete("/api/agents/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const a = deps.db.getAgent(id);
    if (!a) return reply.code(404).send({ error: "agent not found" });
    const live = deps.db.countLiveSessionsForAgent(id);
    if (live > 0) return reply.code(400).send({ error: `cannot delete an agent with live sessions — stop the fleet first (${live} still live)` });
    const { sessionIds } = deps.db.deleteAgent(id);
    for (const sid of sessionIds) deleteArchivedTranscript(a.projectId, sid); // best-effort snapshot cleanup
    return { ok: true, deleted: { agent: id, sessions: sessionIds.length } };
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
      endpoint: false, ioSchema: null, // Agent Runs R1: new agents are non-endpoint (flip via PATCH below)
    };
    deps.db.insertAgent(agent);
    return reply.code(201).send(agent);
  });

  // Edit an agent preset (name / startup prompt / profile / Agent Runs endpoint flag). Same store the
  // spawn path reads, so a saved prompt is injected as the first turn of the NEXT new session.
  // The `endpoint` flag + `ioSchema` are a HUMAN-only trust-boundary surface (Agent Runs R1): flagging
  // an agent API-exposable is exposed ONLY here on the loopback REST, NEVER via an MCP tool (the
  // orchestration/platform agent-write tools enumerate name/startupPrompt/profileId only) — an agent
  // can never self-publish as an endpoint, mirroring how profile role / gateCommand are gated.
  app.post("/api/agents/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deps.db.getAgent(id)) return reply.code(404).send({ error: "agent not found" });
    const b = (req.body ?? {}) as { name?: string; startupPrompt?: string; profileId?: string | null; endpoint?: unknown; ioSchema?: unknown };
    // Assigning a profile: a non-null profileId must reference a real profile (null CLEARS — the agent
    // falls back to the plain backstop). Pass the whole patch through; updateAgent writes only the
    // provided keys (`profileId: null` clears, an absent key leaves the assignment as-is).
    if (b.profileId != null && !deps.db.getProfile(b.profileId)) return reply.code(404).send({ error: "profile not found" });
    if (b.endpoint !== undefined && typeof b.endpoint !== "boolean") return reply.code(400).send({ error: "endpoint must be a boolean" });
    // Build the patch so only PRESENT keys reach updateAgent ("ioSchema" in patch is the clear signal).
    const patch: { name?: string; startupPrompt?: string; profileId?: string | null; endpoint?: boolean; ioSchema?: unknown | null } = {};
    if ("name" in b) patch.name = b.name;
    if ("startupPrompt" in b) patch.startupPrompt = b.startupPrompt;
    if ("profileId" in b) patch.profileId = b.profileId;
    if (b.endpoint !== undefined) patch.endpoint = b.endpoint as boolean;
    if ("ioSchema" in b) patch.ioSchema = b.ioSchema ?? null;
    deps.db.updateAgent(id, patch);
    return deps.db.getAgent(id);
  });

  // --- Agent Runs R1: project-scoped API keys (HUMAN-only, loopback REST — a TRUST-BOUNDARY surface
  // like the git/vault writers + the platform elevated surface). Minting / rotating / revoking a key
  // and editing its endpoint-agent allowlist are exposed ONLY here; NO MCP server (loom-tasks /
  // loom-orchestration / loom-platform / loom-audit) carries a key tool, so no agent can self-mint or
  // publish a key. The SECRET is hashed at rest (db) and returned PLAINTEXT exactly ONCE (on create +
  // rotate) — list/get never carry the secret or its hash. No run execution here (that's R2/R3). ---
  const KEY_STATUSES = new Set(["active", "paused", "revoked"]);
  // Validate the per-key caps blob: each dimension is omitted/null (uncapped) or a non-negative finite
  // number. Returns the normalized ApiKeyCaps, or an error string.
  const parseCaps = (raw: unknown): { ok: true; caps: ApiKeyCaps } | { ok: false; error: string } => {
    const src = (raw ?? {}) as Record<string, unknown>;
    const fields = ["maxConcurrentRuns", "dailyTokenCap", "dailySpendCap"] as const;
    const caps: ApiKeyCaps = { maxConcurrentRuns: null, dailyTokenCap: null, dailySpendCap: null };
    for (const f of fields) {
      const v = src[f];
      if (v === undefined || v === null) { caps[f] = null; continue; }
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return { ok: false, error: `${f} must be a non-negative number or null` };
      caps[f] = v;
    }
    return { ok: true, caps };
  };
  // Validate an endpoint-agent allowlist: an array whose every id is an endpoint=true agent in the project.
  const parseAllowlist = (projectId: string, raw: unknown): { ok: true; ids: string[] } | { ok: false; error: string } => {
    if (raw === undefined) return { ok: true, ids: [] };
    if (!Array.isArray(raw) || !raw.every((x) => typeof x === "string")) return { ok: false, error: "endpointAgentIds must be a string[]" };
    const v = deps.db.validateEndpointAllowlist(projectId, raw as string[]);
    if (!v.ok) return { ok: false, error: `agent ${v.badId} is not an endpoint agent in this project` };
    return { ok: true, ids: raw as string[] };
  };

  app.get("/api/projects/:id/keys", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deps.db.getProject(id)) return reply.code(404).send({ error: "project not found" });
    return deps.db.listApiKeys(id); // PUBLIC metadata only (no secret/hash)
  });
  app.post("/api/projects/:id/keys", async (req, reply) => {
    const projectId = (req.params as { id: string }).id;
    if (!deps.db.getProject(projectId)) return reply.code(404).send({ error: "project not found" });
    const b = (req.body ?? {}) as { name?: string; endpointAgentIds?: unknown; caps?: unknown; status?: unknown };
    if (b.status !== undefined && !KEY_STATUSES.has(b.status as string)) return reply.code(400).send({ error: "status must be active|paused|revoked" });
    const allow = parseAllowlist(projectId, b.endpointAgentIds);
    if (!allow.ok) return reply.code(400).send({ error: allow.error });
    const caps = parseCaps(b.caps);
    if (!caps.ok) return reply.code(400).send({ error: caps.error });
    const { key, plaintext } = deps.db.createApiKey({
      projectId, name: (b.name ?? "").toString(), endpointAgentIds: allow.ids, caps: caps.caps,
      status: b.status as ApiKeyStatus | undefined,
    });
    // The ONE time the plaintext is returned — the client must store it now (never recoverable after).
    return reply.code(201).send({ key, plaintext });
  });
  // Edit a key's metadata: name / endpoint-agent allowlist / caps / status (pause + revoke live here).
  app.post("/api/keys/:keyId", async (req, reply) => {
    const keyId = (req.params as { keyId: string }).keyId;
    const existing = deps.db.getApiKey(keyId);
    if (!existing) return reply.code(404).send({ error: "key not found" });
    const b = (req.body ?? {}) as { name?: string; endpointAgentIds?: unknown; caps?: unknown; status?: unknown };
    const patch: { name?: string; endpointAgentIds?: string[]; caps?: ApiKeyCaps; status?: ApiKeyStatus } = {};
    if (typeof b.name === "string") patch.name = b.name;
    if (b.endpointAgentIds !== undefined) {
      const allow = parseAllowlist(existing.projectId, b.endpointAgentIds);
      if (!allow.ok) return reply.code(400).send({ error: allow.error });
      patch.endpointAgentIds = allow.ids;
    }
    if (b.caps !== undefined) {
      const caps = parseCaps(b.caps);
      if (!caps.ok) return reply.code(400).send({ error: caps.error });
      patch.caps = caps.caps;
    }
    if (b.status !== undefined) {
      if (!KEY_STATUSES.has(b.status as string)) return reply.code(400).send({ error: "status must be active|paused|revoked" });
      patch.status = b.status as ApiKeyStatus;
    }
    deps.db.updateApiKey(keyId, patch);
    return deps.db.getApiKey(keyId);
  });
  // Rotate a key's secret — invalidates the old plaintext, returns the new plaintext ONCE.
  app.post("/api/keys/:keyId/rotate", async (req, reply) => {
    const keyId = (req.params as { keyId: string }).keyId;
    const rotated = deps.db.rotateApiKey(keyId);
    if (!rotated) return reply.code(404).send({ error: "key not found" });
    return reply.send(rotated); // { key, plaintext }
  });
  // Hard-delete a key (permanent). A soft revoke (keep the audit row) is POST /api/keys/:id {status:'revoked'}.
  app.delete("/api/keys/:keyId", async (req, reply) => {
    const keyId = (req.params as { keyId: string }).keyId;
    if (!deps.db.getApiKey(keyId)) return reply.code(404).send({ error: "key not found" });
    deps.db.deleteApiKey(keyId);
    return { ok: true };
  });
  // Agent Runs R4a — per-key KILL-SWITCH (HUMAN-only, loopback, same trust-boundary surface as the key
  // admin above; NO MCP path). Pause the key FIRST (R1's authenticateApiKey blocks `paused`, so no NEW
  // run can auth mid-cancel), THEN cancel every in-flight run for the key via the R2/R3 teardown path.
  // The "buggy app looping runs burns the Max sub" guard — stronger than pause/revoke, which only block
  // NEW runs. Returns { cancelled: n }. Idempotent: a re-kill cancels nothing new and stays paused.
  app.post("/api/keys/:keyId/kill", async (req, reply) => {
    const keyId = (req.params as { keyId: string }).keyId;
    if (!deps.db.getApiKey(keyId)) return reply.code(404).send({ error: "key not found" });
    deps.db.updateApiKey(keyId, { status: "paused" });
    const inflight = deps.db.listInFlightRunsForKey(keyId);
    for (const r of inflight) deps.sessions.cancelRun(r.id);
    return { cancelled: inflight.length };
  });

  // --- Agent Runs R3: the PUBLIC key-authed run API (the FIRST authed surface). Still LOOPBACK (the whole
  // daemon binds 127.0.0.1; this adds Bearer auth ON TOP — the human-only routes above stay unauthed-loopback,
  // unchanged). FAIL CLOSED: a missing/invalid key NEVER falls through to starting a run. A key reaches ONLY
  // its own project's allowlisted endpoint agents, and GET/cancel are own-run-scoped (another key's run → 404).
  // Caps are STORED (R1) but NOT enforced here (R4); runs start immediately (no queue backpressure — R4). ---

  /** Extract the Bearer token (the raw key plaintext); null when the header is absent/non-Bearer. */
  const bearerToken = (req: { headers: Record<string, unknown> }): string | null => {
    const h = req.headers["authorization"];
    if (typeof h !== "string" || !h.startsWith("Bearer ")) return null;
    const t = h.slice("Bearer ".length).trim();
    return t.length ? t : null;
  };
  /**
   * Authenticate a run request, FAILING CLOSED. On success → the public ApiKey. On failure → sends the
   * reply (401 for malformed/unknown/bad-secret — NEVER leaking which; 403 for paused/revoked, a valid
   * secret on a deactivated key) and returns null so the caller aborts. A missing token authenticates as
   * `malformed` (db.authenticateApiKey(null)) → 401.
   */
  const authRunKey = (req: { headers: Record<string, unknown> }, reply: FastifyReply): ApiKey | null => {
    const auth = deps.db.authenticateApiKey(bearerToken(req));
    if (auth.ok) return auth.key;
    if (auth.reason === "paused" || auth.reason === "revoked") { reply.code(403).send({ error: `API key ${auth.reason}` }); return null; }
    reply.code(401).send({ error: "invalid API key" }); // malformed | unknown | bad-secret — do NOT distinguish
    return null;
  };

  // POST /api/runs — start a run (key-authed, async). 202 + { runId } on success.
  app.post("/api/runs", async (req, reply) => {
    const key = authRunKey(req, reply);
    if (!key) return reply; // authRunKey already sent 401/403
    const b = (req.body ?? {}) as { agent?: unknown; input?: unknown; schema?: unknown; webhook?: unknown; idempotencyKey?: unknown };
    if (typeof b.agent !== "string" || !b.agent) return reply.code(400).send({ error: "agent (id) required" });
    // Authorize: the agent MUST be on THIS key's endpoint allowlist (⇒ endpoint=true + same project, per R1).
    // A key can reach ONLY its own project's allowlisted endpoint agents — never another project's.
    if (!key.endpointAgentIds.includes(b.agent)) return reply.code(403).send({ error: "agent not allowlisted for this key" });
    // R3 hardening: re-check the LIVE endpoint flag — allowlist membership is captured at allowlist-edit
    // time, so un-endpointing an agent (PATCH {endpoint:false}) doesn't scrub it from keys that already
    // listed it. Refuse here for a clean 403 (startRun ALSO enforces this as the choke-point invariant).
    if (deps.db.getAgent(b.agent)?.endpoint !== true) return reply.code(403).send({ error: "agent is not an endpoint" });
    if (b.webhook !== undefined && b.webhook !== null && typeof b.webhook !== "string") return reply.code(400).send({ error: "webhook must be a string URL" });
    if (b.idempotencyKey !== undefined && b.idempotencyKey !== null && typeof b.idempotencyKey !== "string") return reply.code(400).send({ error: "idempotencyKey must be a string" });
    const webhook = (b.webhook as string | undefined) ?? null;
    const idempotencyKey = typeof b.idempotencyKey === "string" && b.idempotencyKey ? b.idempotencyKey : null;
    // Idempotency: a prior run for THIS (key, idempotencyKey) → return it, starting NO second run (no
    // double-spend of Max quota). Checked before AND, on a lost race, after the start (unique-index catch).
    if (idempotencyKey) {
      const existing = deps.db.getRunByIdempotency(key.id, idempotencyKey);
      if (existing) return reply.code(202).send({ runId: existing.id });
    }
    // Agent Runs R4a — per-key caps, enforced ONLY when actually about to START a new run (AFTER the
    // idempotency replay above, which starts nothing). Concurrency is the deterministic must-have; the
    // daily token cap is a coarse best-effort backstop over the R2 usage snapshot (no spend cap — Loom
    // has no cost model yet; see [[Agent Runs]]). At/over a cap → 429 and NO run starts.
    // Agent Runs follow-up #1 — best-effort run AUDIT at a cap-rejection. A 429 here creates NO run row, so
    // without this record the throttle is completely invisible (nothing in the runs list/UI). Wrapped so an
    // audit-store fault NEVER changes the 429 response or the cap logic — we only ADD the record alongside
    // the (unchanged) enforcement below. `observed` is captured from the SAME query the gate compares.
    const recordCapReject = (cap: "concurrency" | "daily_token" | "daily_spend", limit: number, observed: number) => {
      try {
        deps.db.insertRunEvent({
          id: randomUUID(), projectId: key.projectId, keyId: key.id, runId: null,
          kind: "cap_rejected", detail: { cap, limit, observed, agentId: b.agent },
          createdAt: new Date().toISOString(),
        });
      } catch { /* audit is best-effort — a write fault must never break the 429 / cap path */ }
    };
    if (key.caps.maxConcurrentRuns != null) {
      const inFlight = deps.db.countInFlightRunsForKey(key.id);
      if (inFlight >= key.caps.maxConcurrentRuns) {
        recordCapReject("concurrency", key.caps.maxConcurrentRuns, inFlight);
        return reply.code(429).send({ error: "concurrency cap reached" });
      }
    }
    if (key.caps.dailyTokenCap != null) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const used = deps.db.sumKeyTokensSince(key.id, since);
      if (used >= key.caps.dailyTokenCap) {
        recordCapReject("daily_token", key.caps.dailyTokenCap, used);
        return reply.code(429).send({ error: "daily token cap reached" });
      }
    }
    // Agent Runs #2 — daily SPEND cap (USD): mirrors the token-cap branch over `db.sumKeySpendSince`
    // (sum of per-run `usage.costUsd` across the trailing 24h). At/over the cap → 429 and NO run starts;
    // a cap_rejected audit row records it (best-effort, same store as the other caps). Best-effort by
    // nature — costUsd is 0 for unpriced models — so it's a backstop, not a hard billing guarantee.
    if (key.caps.dailySpendCap != null) {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const spent = deps.db.sumKeySpendSince(key.id, since);
      if (spent >= key.caps.dailySpendCap) {
        recordCapReject("daily_spend", key.caps.dailySpendCap, spent);
        return reply.code(429).send({ error: "daily spend cap reached" });
      }
    }
    try {
      const { run } = await deps.sessions.startRun({
        agentId: b.agent, input: b.input ?? null, schema: b.schema ?? null, keyId: key.id, webhook, idempotencyKey,
      });
      return reply.code(202).send({ runId: run.id });
    } catch (e) {
      // A concurrent same-idempotency start lost the unique-index race → return the winner's run, no double-start.
      if (idempotencyKey) {
        const existing = deps.db.getRunByIdempotency(key.id, idempotencyKey);
        if (existing) return reply.code(202).send({ runId: existing.id });
      }
      return reply.code(500).send({ error: `could not start run: ${(e as Error).message}` });
    }
  });

  // GET /api/runs/:id — poll a run (key-authed, OWN-run-scoped). A run owned by another key → 404 (never
  // reveal another key's run exists). Returns the public job view: { status, result?, usage?, transcriptRef?, error? }.
  app.get("/api/runs/:id", async (req, reply) => {
    const key = authRunKey(req, reply);
    if (!key) return reply;
    const id = (req.params as { id: string }).id;
    const run = deps.db.getRun(id);
    if (!run || run.keyId !== key.id) return reply.code(404).send({ error: "run not found" });
    return reply.send({
      status: run.status,
      result: run.result ?? null,
      usage: run.usage ?? null,
      transcriptRef: run.transcriptRef ?? null,
      error: run.error ?? null,
    });
  });

  // POST /api/runs/:id/cancel — cancel a run (key-authed, OWN-run-scoped). Non-terminal → cancelled +
  // teardown (R2 graceful-stop path); already-terminal → idempotent no-op returning its state.
  app.post("/api/runs/:id/cancel", async (req, reply) => {
    const key = authRunKey(req, reply);
    if (!key) return reply;
    const id = (req.params as { id: string }).id;
    const run = deps.db.getRun(id);
    if (!run || run.keyId !== key.id) return reply.code(404).send({ error: "run not found" });
    const { status } = deps.sessions.cancelRun(run.id);
    return reply.send({ runId: run.id, status });
  });

  // --- Agent Runs R4a: the HUMAN run REST (the R4b Runs UI's data source). UNAUTHED loopback, like every
  // other /api/projects/:id route — DELIBERATELY OFF the R3 key-authed path (no Bearer) and OUT of every
  // MCP surface (no agent reaches it). Project-scoped (not key-scoped): the human operator sees ALL of a
  // project's runs across every key, with the FULL row (incl. keyId/input/result/usage/error/timestamps).
  // The per-run view is a DISTINCT path from the key-authed GET /api/runs/:id (which stays own-run-scoped). ---
  app.get("/api/projects/:id/runs", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deps.db.getProject(id)) return reply.code(404).send({ error: "project not found" });
    return deps.db.listRuns(id); // full AgentRun rows, newest first
  });
  app.get("/api/projects/:id/runs/:runId", async (req, reply) => {
    const { id, runId } = req.params as { id: string; runId: string };
    const run = deps.db.getRun(runId);
    if (!run || run.projectId !== id) return reply.code(404).send({ error: "run not found" });
    return run; // full AgentRun row (human view)
  });
  // A run's transcript for the R4b Runs detail pane. R2 retains a snapshot at `transcriptRef` so the
  // transcript survives JSONL pruning, but the session-transcript route (GET /api/sessions/:id/transcript)
  // only falls back to a snapshot on `archivedAt`, which run sessions never get → old runs showed "No
  // transcript yet" despite a retained snapshot. Serve it run-scoped instead: prefer the LIVE engine JSONL
  // while it exists (fresh runs), else the retained snapshot (keyed by projectId+sessionId, == transcriptRef).
  app.get("/api/projects/:id/runs/:runId/transcript", async (req, reply) => {
    const { id, runId } = req.params as { id: string; runId: string };
    const run = deps.db.getRun(runId);
    if (!run || run.projectId !== id) return reply.code(404).send({ error: "run not found" });
    if (!run.sessionId) return []; // a snapshot-failed run never spawned a session — nothing to read
    const s = deps.db.getSession(run.sessionId);
    if (s?.engineSessionId && engineTranscriptExists(s.cwd, s.engineSessionId)) return readTranscript(s.cwd, s.engineSessionId);
    return readArchivedTranscript(run.projectId, run.sessionId); // retained snapshot (transcriptRef); [] if none
  });
  // Human cancel — reuse the same teardown path as the key-authed cancel (cancelRun is idempotent on a
  // terminal run). Project-scoped existence check (a run in another project → 404).
  app.post("/api/projects/:id/runs/:runId/cancel", async (req, reply) => {
    const { id, runId } = req.params as { id: string; runId: string };
    const run = deps.db.getRun(runId);
    if (!run || run.projectId !== id) return reply.code(404).send({ error: "run not found" });
    const { status } = deps.sessions.cancelRun(run.id);
    return reply.send({ runId: run.id, status });
  });
  // Agent Runs follow-up #1 — the run AUDIT TRAIL reader (HUMAN/loopback, project-scoped; SAME unauthed
  // posture as the runs list above, OFF the R3 key-authed path + every MCP surface). Surfaces the events
  // that have no run row of their own — chiefly cap-rejections (a 429 at POST /api/runs creates NO run, so
  // it's otherwise invisible) — newest-first, bounded (default 200; optional ?limit clamped to [1,1000]).
  app.get("/api/projects/:id/run-events", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deps.db.getProject(id)) return reply.code(404).send({ error: "project not found" });
    const raw = parseInt(String((req.query as { limit?: string })?.limit ?? ""), 10);
    const limit = Number.isFinite(raw) ? Math.min(Math.max(raw, 1), 1000) : 200;
    return deps.db.listRunEvents(id, limit); // full RunEvent rows, newest first
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

  // PERMANENTLY delete a task card — a DESTRUCTIVE/irreversible HUMAN action (drawer Delete button).
  // Trust boundary: there is intentionally NO MCP path to this (an agent can only move a card to done);
  // only the loopback human REST surface deletes. GUARD: refuse while a LIVE session is bound to the task
  // ("don't delete a card out from under a running worker"), mirroring the project/agent live > 0 guards
  // above. Idempotent on a missing id (no 404), like the other DELETE routes.
  app.delete("/api/tasks/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const live = deps.db.countLiveSessionsForTask(id);
    if (live > 0) return reply.code(400).send({ error: `cannot delete a task with a live session bound to it — stop the worker first (${live} still live)` });
    deps.db.deleteTask(id);
    return { ok: true };
  });

  app.post("/api/agents/:id/sessions", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const { role } = (req.body as { role?: string }) ?? {};
    // Agent Runs R2: a `run` session is EPHEMERAL and internally-started only — no human/agent spawn route
    // mints one (the public keyed POST /api/runs trigger is R3). Refuse it the way platform/auditor are
    // role-locked, so role="run" can never be created via this surface.
    if (role === "run") { reply.code(400); return { error: "the 'run' session kind is not human-spawnable; Agent Runs are started internally (R3 adds the keyed trigger)" }; }
    if (role === "manager") return deps.sessions.startManager(id);
    if (role === "platform") return deps.sessions.startPlatformLead(id);
    // P5: spawn the read-and-file-only Platform Auditor. HUMAN-REST only (like startPlatformLead) — the
    // session role is locked to "auditor" via callerRole, regardless of the agent's profile role.
    if (role === "auditor") return deps.sessions.startAuditor(id);
    // Setup Assistant E1-5: spawn the SINGLETON, ungated Setup Assistant on the curated loom-setup MCP
    // surface. HUMAN-REST only (like startPlatformLead/startAuditor) — the session role is locked to
    // "setup" via callerRole regardless of the agent's profile role; a live setup session is reused.
    if (role === "setup") return deps.sessions.startSetup(id);
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
  // session is busy or the human is mid-compose. They drain automatically; the human can also
  // delete/edit/reorder them via the mutators below. Each entry carries a stable id so a mutation
  // targets a specific message (not a drifting array index). Shown in the UI.
  app.get("/api/sessions/:id/queue", async (req) =>
    ({ pending: deps.pty.getPendingEntries((req.params as { id: string }).id) }));
  // Human-facing queue mutators (delete/edit/reorder a HELD entry). HUMAN/REST ONLY — like
  // /input, /stop and /merge these are a trust boundary and are NOT exposed as agent MCP tools; an
  // agent can never reorder or rewrite another session's pending turns. All three are id-addressed and
  // delegate to the synchronous PtyHost mutators (no pty write), so they're safe at any time and a
  // stale/already-drained id is a graceful no-op (false), never a 500. 404 only for an unknown session;
  // 403 (`refused`) when the op targets a 'system' entry (a worker report / nudge) — those are read-only.
  app.delete("/api/sessions/:id/queue/:entryId", async (req, reply) => {
    const { id, entryId } = req.params as { id: string; entryId: string };
    if (!deps.db.getSession(id)) return reply.code(404).send({ error: "session not found" });
    const r = deps.pty.deleteQueued(id, entryId);
    if (r.refused) return reply.code(403).send({ error: "entry is not human-owned", ...r });
    return reply.send(r);
  });
  app.patch("/api/sessions/:id/queue/:entryId", async (req, reply) => {
    const { id, entryId } = req.params as { id: string; entryId: string };
    const { text } = (req.body as { text?: string }) ?? {};
    if (typeof text !== "string" || !text.trim()) return reply.code(400).send({ error: "text required" });
    if (!deps.db.getSession(id)) return reply.code(404).send({ error: "session not found" });
    const r = deps.pty.editQueued(id, entryId, text);
    if (r.refused) return reply.code(403).send({ error: "entry is not human-owned", ...r });
    return reply.send(r);
  });
  app.patch("/api/sessions/:id/queue", async (req, reply) => {
    const { id } = req.params as { id: string };
    const { orderedIds } = (req.body as { orderedIds?: unknown }) ?? {};
    if (!Array.isArray(orderedIds) || orderedIds.some((x) => typeof x !== "string"))
      return reply.code(400).send({ error: "orderedIds (string[]) required" });
    if (!deps.db.getSession(id)) return reply.code(404).send({ error: "session not found" });
    const r = deps.pty.reorderQueued(id, orderedIds as string[]);
    if (r.refused) return reply.code(403).send({ error: "entry is not human-owned", ...r });
    return reply.send(r);
  });
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
    // 'human' source: ONLY this composer path tags its entries human; every programmatic enqueue
    // (worker reports, nudges, resume notes) defaults to 'system'. That tag is what gates the mutators.
    return reply.send(deps.pty.enqueueStdin(id, text, "human"));
  });
  // Human-initiated merge of a worker's branch (the Review panel / #18c). Runs the daemon's
  // fail-closed build gate then squash-merges (one clean commit); manager is derived from the worker's
  // parent so the existing ownership check holds. Returns { merged } or { merged:false, reason }.
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
