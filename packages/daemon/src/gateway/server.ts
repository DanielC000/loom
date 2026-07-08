import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Fastify, { type FastifyInstance, type FastifyReply } from "fastify";
import websocket from "@fastify/websocket";
import fastifyStatic from "@fastify/static";
import type { WebSocket } from "ws";
import type { TerminalInput, ShellTerminal, Project, Agent, Task, ProjectConfigOverride, Schedule, ApiKey, ApiKeyCaps, ApiKeyStatus, UsageHistory, SessionUsageHistory, CompanionRoute, UsageSample, AgentRun, RunStatus, Session, SessionRole, ProcessState, Wake, PollJob, OrchestrationEventKind } from "@loom/shared";
import { resolveConfig, columnKeyForRole } from "@loom/shared";
import { resolveWebDistDir, isLoomDev } from "../paths.js";
import { loomVersion, isPackagedInstall } from "../version.js";
import type { UpdateStatus } from "../update/check.js";
import { nextFireAt } from "../orchestration/cron.js";
import { MIN_POLL_INTERVAL_MS } from "../orchestration/poll.js";
import { readTranscript, readArchivedTranscript, archivedTranscriptExists, engineTranscriptExists, deleteProjectArchives } from "../sessions/transcript.js";
import { buildTimeline, diffTimelines } from "../sessions/audit.js";
import type { Db } from "../db.js";
import { inTestMode } from "../db.js";
import type { PtyHost } from "../pty/host.js";
import { detectDefaultShell } from "../pty/host.js";
import type { SessionService } from "../sessions/service.js";
import { deleteAgentCore } from "../sessions/delete-agent-core.js";
import type { TaskMcpRouter } from "../mcp/server.js";
import type { OrchestrationMcpRouter } from "../mcp/orchestration.js";
import type { PlatformMcpRouter } from "../mcp/platform.js";
import type { AuditMcpRouter } from "../mcp/audit.js";
import type { WorkspaceAuditMcpRouter } from "../mcp/user-audit.js";
import type { SetupMcpRouter } from "../mcp/setup.js";
import type { RunMcpRouter } from "../mcp/run.js";
import type { CompanionControl } from "../companion/controller.js";
import type { InAppChannel } from "../companion/in-app.js";
import { IN_APP_CHANNEL, decodeInAppAudioToTempFile } from "../companion/in-app.js";
import { TELEGRAM_CHANNEL } from "../companion/telegram.js";
import { maskCompanionConfig, findEnabledTokenCollision, findEnabledAgentCollision } from "../companion/store.js";
import { listConnections, createConnection, deleteConnection } from "../connections/store.js";
import { listCapabilitySummaries, createCapabilityDef, deleteCapabilityDef } from "../capabilities/registry.js";
import { encryptSecret, decryptSecret } from "../keys/envelope.js";
import { validateProjectConfigOverride, validatePlatformConfigOverride, validateColumnLayout } from "../mcp/platform.js";
import { setProjectConfigSafe } from "../tasks/columns.js";
import type { OrchestrationControl } from "../orchestration/control.js";
import type { UsageStatusPoller } from "../orchestration/usage-status.js";
import { clearClaudeRateLimit } from "../orchestration/usage-awareness.js";
import { GitReader } from "../git/reader.js";
import { GitWriter } from "../git/writer.js";
import { workerDiff } from "../git/worktrees.js";
import { checkRepoRebind } from "../projects/rebind.js";
import { listVaultTree, readVaultFile, statVaultFile, vaultFileContentType } from "../vault/browser.js";
import { writeVaultFile, createVaultFile, deleteVaultFile } from "../vault/writer.js";
import { listSkills, readSkill, writeSkill, deleteSkill, resetSkillToBundled, publishSkillToBundled, isValidSkillName, skillTemplate, skillUpdateAvailable, previewSkillMerge, adoptSkillUpdate, skillUpdateDiff } from "../skills/store.js";
import { validateProfile } from "../profiles/validate.js";
import { validateAgentPatch } from "../agents/validate.js";
import { cloneAgentCore } from "../agents/clone-core.js";
import { resetProfileToBundled } from "../profiles/seed.js";
import { profileCustomizationState, profileUpdateAvailable, previewProfileMerge, profileUpdateDiff, adoptProfileUpdate, type ProfileFieldResolution } from "../profiles/customization.js";
import { prewarmMarkitdown, resolvePrewarmInterpreterPath, getMarkitdownProvisionStatus } from "../python/prewarm.js";
import { PLATFORM_PROJECT_NAME } from "../platform/seed.js";
import { SETUP_PROJECT_NAME, COMPANION_AGENT_NAME } from "../setup/seed.js";
import { ASSISTANT_BASE_BRIEF } from "../sessions/assistant-prompt.js";
import { listCompanionSkills, readCompanionSkill, removeCompanionSkill } from "../skills/companion-store.js";
import { listCompanionMemories, readCompanionMemory, removeCompanionMemory, authorCompanionMemory } from "../skills/companion-memory-store.js";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/** Upper bound for the raw vault-file serving route. Vault attachments are normally small (images,
 *  PDFs); this is a guard against streaming a pathologically large file, not a real working limit —
 *  a file over the cap is refused with 413 rather than streamed. */
const VAULT_RAW_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

/** Whitelist guard for the human REST task surfaces — rejects any value outside the p0–p3 enum. */
const isTaskPriority = (v: unknown): v is Task["priority"] => v === "p0" || v === "p1" || v === "p2" || v === "p3";
// P5/B6: the valid Schedule.kind values a fire can route on — "manager" (default), the dev "auditor",
// and the end-user "workspace-auditor". Mirrors the Schedule.kind union (any new kind goes here too).
const isScheduleKind = (v: unknown): v is Schedule["kind"] => v === "manager" || v === "auditor" || v === "workspace-auditor";

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
  userAuditMcp: WorkspaceAuditMcpRouter;
  setupMcp: SetupMcpRouter;
  runMcp: RunMcpRouter;
  control: OrchestrationControl;
  usageStatus: UsageStatusPoller;
  /** The Companion hot-lifecycle CONTROLLER (a stable facade over the live ChatGateway + heartbeat), or
   *  null when the companion subsystem isn't wired. Threaded so the human-only /api/companion routes drive
   *  the RUNNING companion with NO restart: bindings POST/DELETE keep the gateway's routing map in sync
   *  (bind/unbind), and config POST/PUT/DELETE reconcile() the live adapter+heartbeat to the new DB config.
   *  Optional: absent/null keeps the routes serving db state, they just skip the live update. */
  companion?: CompanionControl | null;
  /** The STABLE in-app transport hub (default companion channel), or null when the companion subsystem
   *  isn't wired. Threaded so the /ws/companion/:sessionId route can attach a connected web client to the
   *  hub (so companion replies push to it). Optional/absent ⇒ the route accepts the socket but delivers
   *  nothing (no in-app transport) — additive, every existing path byte-identical when off. */
  inApp?: InAppChannel | null;
  /** Loopback control hook for `loom stop`: trigger the daemon's GRACEFUL shutdown (snapshot live
   * transcripts + clean watcher teardown, then exit 0). Wired by index.ts to the SAME path the
   * SIGINT/SIGTERM handlers use — Windows has no real SIGTERM, so the CLI can't signal a detached
   * daemon into the graceful path; this endpoint is how it reaches it cross-platform. */
  requestShutdown: () => void;
  /** Epic 2c-2 — the daemon's current npm "update available" status (read-only), served by
   *  GET /api/update-status. Optional so existing partial-stub tests still build a server; a missing
   *  accessor degrades to a safe `packaged:false` default (banner hidden). */
  updateStatus?: () => UpdateStatus;
  /** Epic 2c-2 — begin the self-update (spawn the detached `loom update` stop→install→start cycle). Wired
   *  by index.ts; reached ONLY via the loopback, packaged-gated POST /internal/update (never an MCP tool —
   *  same trust boundary as requestShutdown / the vault+git writers). Optional for the same reason as above. */
  beginSelfUpdate?: () => void;
}

/** The daemon's own non-UI route prefixes. An unmatched GET under any of these must NEVER fall back to
 * the SPA index.html — an unknown `/api/*` stays a JSON 404 (so clients see the real error, not HTML),
 * and `/ws` stays the websocket-upgrade route. Boundary-aware so a client route like `/apidocs` (were
 * one to exist) is NOT misclassified as the `/api` surface. */
const isReservedDaemonPath = (pathname: string): boolean =>
  ["/api", "/ws", "/mcp", "/internal"].some((p) => pathname === p || pathname.startsWith(`${p}/`));

/**
 * Sanitize a companion's given name BEFORE it is ever persisted or baked into the server-owned
 * ASSISTANT_BASE_BRIEF (composeAssistantStartupPrompt): drop every control character (codepoints 0-31 and
 * 127, which cover newlines/tabs/CR/etc.), collapse any remaining run of whitespace to a single space, then
 * trim. Without this, a name like "Aria" + a newline + "## Untrusted input" could inject structure into the
 * one region of the prompt that must never be user-editable — a single-line, printable name only. PURE +
 * exported so the hermetic test can assert it directly. (Char-code filtering, not a regex hex-escape class,
 * for source clarity.)
 */
export function sanitizeCompanionName(raw: string): string {
  const printable = Array.from(raw)
    .filter((ch) => { const code = ch.codePointAt(0) ?? 0; return code > 31 && code !== 127; })
    .join("");
  return printable.replace(/\s+/g, " ").trim();
}

export async function buildServer(deps: GatewayDeps): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });

  // --- CSRF / DNS-rebind backstop (one onRequest hook, registered FIRST so it is inherited by EVERY plugin
  //     + route — the websocket and static plugins below included — i.e. UNIFORM coverage with no per-route
  //     N-1 gap; Fastify only inherits a parent hook into children registered AFTER it). The daemon binds
  //     127.0.0.1 only, but a loopback bind ALONE does not stop two browser-borne attacks:
  //       (a) CSRF — any cross-origin page the user visits can fire `mode:'no-cors'` side-effect POSTs
  //           (/api/orchestration/kill, /api/usage/clear-hold, /api/sessions/:id/stop); a no-cors request
  //           still carries the page's Origin header.
  //       (b) DNS-rebind — a page on attacker.com that rebinds its DNS to 127.0.0.1 can reach the host-RCE
  //           POST /api/terminals; the rebinding page still sends its OWN (attacker) Host header.
  //     The hook closes both:
  //       • Origin (anti-CSRF): if PRESENT, its hostname must be loopback (127.0.0.1 / localhost) — every
  //         external/rebind origin is refused 403. An ABSENT Origin is ALLOWED (fail-safe): the CLI,
  //         Run-API-key clients and server-to-server callers send none and MUST keep working.
  //       • Host (anti-DNS-rebind): the Host hostname must be loopback — a rebinding page still presents its
  //         attacker Host (evil.com[:port]) → 403. The hostname is the tell.
  //     We match the loopback HOSTNAME, not a single bound-port pin, deliberately: (1) the dev `pnpm web`
  //     proxy serves the UI from :5317 and forwards to the daemon, so the browser's Origin stays
  //     `http://localhost:5317` (changeOrigin rewrites Host, not Origin) — a bound-port-only Origin pin would
  //     sever the dev WebSocket + POSTs; (2) the in-process test suite injects with Host `localhost:80`, so a
  //     bound-port-only Host pin would 403 it; (3) the port adds no security here — both threats are external
  //     hostnames, and a loopback-port origin already implies local code execution. The bound-port loopback
  //     origin/host (paths.ts PORT = LOOM_PORT||4317, the same constant index.ts listens on) is of course a
  //     subset of "loopback hostname" and stays allowed. ADDITIVE: the /internal/* loopback (req.ip) gate
  //     below is untouched — defence in depth.
  const isLoopbackHostname = (h: string | null): boolean => h === "127.0.0.1" || h === "localhost";
  const hostnameOf = (raw: string, withScheme = false): string | null => {
    try { return new URL(withScheme ? raw : `http://${raw}`).hostname; } catch { return null; }
  };
  app.addHook("onRequest", async (req, reply) => {
    const origin = req.headers.origin;
    // PRESENT Origin must be loopback. An ABSENT Origin is the fail-safe ALLOW path for non-browser
    // clients (CLI / Run-API-key / server-to-server). A present-but-malformed Origin — including the
    // literal "null" origin (a sandboxed-iframe CSRF sends `Origin: null`), which fails to parse → not
    // loopback → 403 — is REJECTED (the safer behavior).
    if (typeof origin === "string" && origin.length > 0 && !isLoopbackHostname(hostnameOf(origin, true))) {
      return reply.code(403).send({ error: "cross-origin request refused" });
    }
    // Host must be present and loopback (DNS-rebind defence). Real HTTP clients always send Host; a
    // missing/non-loopback Host → reject.
    const host = req.headers.host;
    if (!isLoopbackHostname(typeof host === "string" && host.length > 0 ? hostnameOf(host) : null)) {
      return reply.code(403).send({ error: "host header not allowed" });
    }
  });

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

  // --- Workspace-auditor MCP (role-gated to 'workspace-auditor'; the END-USER Auditor's READ-AND-
  // SUGGEST-ONLY surface — End-User Platform tier B3). A distinct route + router so a workspace-auditor
  // session reaches ONLY its 4 curated tools: it 404s on /mcp-platform, /mcp-orch, /mcp-audit and
  // /mcp-setup (their resolveRole gate other roles), and NO agent/MCP path can mint a workspace-auditor
  // session (caller-set only), so a non-workspace-auditor session can never reach here. ---
  app.all("/mcp-user-audit/:sessionId", async (req, reply) => {
    const { sessionId } = req.params as { sessionId: string };
    reply.hijack();
    await deps.userAuditMcp.handle(req.raw, reply.raw, sessionId, req.body);
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
  // --- Update availability (Epic 2c-2, UI half) — READ-ONLY: the daemon's last npm-registry check on the
  // persisted release channel. The web reads this and shows an unobtrusive "Update available" banner ONLY
  // when `updateAvailable` (which requires `packaged:true` — a from-source daemon always reports
  // packaged:false, so the banner never shows on dev). No trust-boundary change; the actual update is the
  // separate loopback POST /internal/update below. A missing accessor (partial-stub test) → a safe default. ---
  app.get("/api/update-status", async (): Promise<UpdateStatus> =>
    deps.updateStatus
      ? deps.updateStatus()
      : { packaged: false, channel: "stable", installed: loomVersion(), latest: null, updateAvailable: false, checkedAt: null },
  );
  // --- God-eye read of the user's REAL Claude plan-usage (5h / 7d rate-limit windows). Served from a
  // single daemon-side cached poller (NOT fetched per-request; NOT an MCP tool; NOT a write surface).
  // Always 200: `available:false`+reason when the token is missing/expired or the upstream call failed. ---
  app.get("/api/usage/limits", async () => deps.usageStatus.getStatus());
  // Manual GLOBAL hold clear (HUMAN/REST only — trust boundary like the git/vault writers; NEVER an
  // MCP tool). Drops the global usage-awareness latch (~/.loom/tmp/claude-usage.json) so new
  // worker_spawn is unblocked. ADDITIVE: detection re-arms the latch on the next real cap.
  //
  // CASCADE + AUTO-NUDGE (owner requirement): clearing the global hold ALSO clears every session still
  // parked with a rate-limit AND resumes the LIVE ones — per-session this is exactly the proven
  // /api/sessions/:id/rate-limit/clear path (setRateLimitedUntil(null) + clearRateLimitDeadline +
  // resumeAfterRateLimit). So the user never has to retry each parked session by hand. The CLEAR
  // applies to every parked row (live or stale); the RESUME is scoped to LIVE (an exited session can't
  // resume — resumeAfterRateLimit also no-ops on a dead pty as a backstop). The global latch is dropped
  // ONCE up front (not per session). Returns how many live sessions were resumed.
  app.post("/api/usage/clear-hold", async () => {
    clearClaudeRateLimit();
    let resumed = 0;
    for (const s of deps.db.listRateLimited()) {
      deps.db.setRateLimitedUntil(s.id, null, null);
      deps.db.clearRateLimitDeadline(s.id);
      if (s.processState === "live" && deps.pty.resumeAfterRateLimit(s.id)) resumed++;
    }
    return { cleared: true, resumed };
  });
  // --- HISTORICAL token/cost usage over a timespan, optionally project-scoped. Read-only aggregation of
  // the `runs` table (Loom's only persisted time-series usage data — interactive sessions keep no history):
  // grand totals + per-project + per-agent breakdowns. Loopback, human-only, NOT an agent MCP tool — same
  // posture as /api/usage/limits above. `since` is a required ISO-8601 cutoff, CLAMPED to a sane window: a
  // missing/unparseable/future value defaults to the trailing 30 days, and a cutoff older than 1 year is
  // floored at 1 year ago (an unbounded scan is never what the caller wants). `projectId` is optional;
  // omitted or "all" → every project. The applied (clamped) since + filter are echoed back. ---
  app.get("/api/usage/history", async (req): Promise<UsageHistory> => {
    const { since, projectId } = req.query as { since?: string; projectId?: string };
    const nowMs = Date.now();
    const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
    const DEFAULT_MS = 30 * 24 * 60 * 60 * 1000;
    const parsed = since ? Date.parse(since) : NaN;
    // Clamp to (now - 1yr, now]: unparseable/future ⇒ default 30d back; older than 1yr ⇒ floor at 1yr.
    const sinceMs = Number.isFinite(parsed) && parsed <= nowMs
      ? Math.max(parsed, nowMs - YEAR_MS)
      : nowMs - DEFAULT_MS;
    const sinceIso = new Date(sinceMs).toISOString();
    const filter = projectId && projectId !== "all" ? projectId : null;
    const agg = deps.db.aggregateRunUsage({ sinceIso, projectId: filter });
    return { since: sinceIso, projectId: filter, ...agg };
  });
  // --- INTERACTIVE-session usage telemetry over a timespan (epic c9924bcd): grand totals + per-project +
  // per-agent + per-DAY breakdowns, aggregated read-only from the daemon-sampled `session_usage_samples`
  // table — the OWNER'S OWN interactive usage over time (DISTINCT from /api/usage/history above, which is
  // Agent-Runs-backed). Loopback, human-only, NOT an agent MCP tool — same posture as /api/usage/history.
  // The `since` clamp is IDENTICAL: a missing/unparseable/future value defaults to the trailing 30 days,
  // and a cutoff older than 1 year is floored at 1 year ago (never an unbounded scan). `projectId` is
  // optional; omitted or "all" → every project. The applied (clamped) since + filter are echoed back. ---
  app.get("/api/usage/sessions/history", async (req): Promise<SessionUsageHistory> => {
    const { since, projectId } = req.query as { since?: string; projectId?: string };
    const nowMs = Date.now();
    const YEAR_MS = 365 * 24 * 60 * 60 * 1000;
    const DEFAULT_MS = 30 * 24 * 60 * 60 * 1000;
    const parsed = since ? Date.parse(since) : NaN;
    // Clamp to (now - 1yr, now]: unparseable/future ⇒ default 30d back; older than 1yr ⇒ floor at 1yr.
    const sinceMs = Number.isFinite(parsed) && parsed <= nowMs
      ? Math.max(parsed, nowMs - YEAR_MS)
      : nowMs - DEFAULT_MS;
    const sinceIso = new Date(sinceMs).toISOString();
    const filter = projectId && projectId !== "all" ? projectId : null;
    const agg = deps.db.aggregateSessionUsage({ sinceIso, projectId: filter });
    return { since: sinceIso, projectId: filter, ...agg };
  });
  // --- Markitdown (shared Python venv) provisioning status + retry. HUMAN/REST-ONLY (loopback) — NOT an MCP
  // tool: provisioning launches a host process (venv-create + pip), the same host-launch trust posture as the
  // git/vault/gateCommand writers, so the agent surface never exposes it. GET is read-only (the classified
  // state/reason/errorTail the UI shows so the user can SEE why documentConversion isn't ready, replacing the
  // buried console.warn); POST re-kicks provisioning OFF the event loop — now that the kick is retryable (not a
  // permanent one-shot) this actually retries after a prior failure without a daemon restart. Both return the
  // current status. (`python.interpreterPath` itself is set via the existing human project-config REST — the
  // agent validator rejects it; no new write surface is needed here.)
  app.get("/api/python/provisioning", async () => getMarkitdownProvisionStatus());
  app.post("/api/python/provisioning/retry", async () => {
    prewarmMarkitdown(resolvePrewarmInterpreterPath(deps.db.listAllProjects()));
    return getMarkitdownProvisionStatus();
  });

  // A manager's orchestration_events timeline (chronological). READ-ONLY — emits no event.
  app.get("/api/orchestration/events", async (req) => {
    const { managerId } = req.query as { managerId?: string };
    return managerId ? deps.db.listEvents(managerId) : [];
  });

  // --- Session/run AUDIT LOG: a replayable, ordered event timeline + a diff primitive, served over Loom's
  // EXISTING durable record (the `orchestration_events` table + `sessions` metadata — no new capture). These
  // are READ-ONLY, HUMAN-only loopback readers (same trust posture as /api/orchestration/events and the run
  // audit reader — NEVER an agent MCP tool). Source of the protocol contract the web "fleet observability +
  // audit-replay" sibling card consumes. ---
  // The replayable timeline for ONE session (every event where it's the manager OR worker).
  app.get("/api/audit/session/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const timeline = buildTimeline(deps.db, "session", id);
    if (!timeline) return reply.code(404).send({ error: "session not found" });
    return timeline;
  });
  // The replayable timeline for a whole orchestration WAVE (a manager session + all its workers).
  app.get("/api/audit/wave/:managerId", async (req, reply) => {
    const managerId = (req.params as { managerId: string }).managerId;
    const timeline = buildTimeline(deps.db, "wave", managerId);
    if (!timeline) return reply.code(404).send({ error: "session not found" });
    return timeline;
  });
  // A structured diff of two timelines: ?a=<id>&b=<id>&scope=session|wave (scope applies to both sides,
  // default "session"). When `b` is omitted, it resolves to A's PREDECESSOR (the recycledFrom of the root
  // session) — the "run vs its predecessor" comparison; 400 when A has none. 400 on a missing `a`, 404 on an
  // unknown a/b root session.
  app.get("/api/audit/diff", async (req, reply) => {
    const q = req.query as { a?: string; b?: string; scope?: string };
    const scope = q.scope === "wave" ? "wave" : "session";
    if (!q.a) return reply.code(400).send({ error: "query param 'a' (session id) is required" });
    const aTimeline = buildTimeline(deps.db, scope, q.a);
    if (!aTimeline) return reply.code(404).send({ error: "session 'a' not found" });
    let bId = q.b;
    if (!bId) {
      const root = deps.db.getSession(q.a);
      if (!root?.recycledFrom) {
        return reply.code(400).send({ error: "no predecessor: 'a' was not recycled from a prior session — pass an explicit 'b'" });
      }
      bId = root.recycledFrom;
    }
    const bTimeline = buildTimeline(deps.db, scope, bId);
    if (!bTimeline) return reply.code(404).send({ error: "session 'b' not found" });
    return diffTimelines(aTimeline, bTimeline);
  });

  // --- Schedules (phase-2 Pillar B): cron triggers. next_fire_at is computed here on
  // create/update (the Scheduler advances it after each fire). ---
  app.get("/api/schedules", async () => deps.db.listSchedules());
  app.post("/api/schedules", async (req, reply) => {
    const b = (req.body ?? {}) as { agentId?: string; cron?: string; enabled?: boolean; kind?: string; prompt?: string | null };
    if (!b.agentId || !b.cron) return reply.code(400).send({ error: "agentId and cron required" });
    if (!deps.db.getAgent(b.agentId)) return reply.code(404).send({ error: "agent not found" });
    // P5/B6: kind selects what a fire spawns — "manager" (default), "auditor" (the dev read-and-file-only
    // Platform Auditor), or "workspace-auditor" (the suggest-only end-user Workspace Auditor). Reject any
    // other value rather than silently coercing.
    if (b.kind !== undefined && !isScheduleKind(b.kind)) {
      return reply.code(400).send({ error: 'kind must be "manager", "auditor", or "workspace-auditor"' });
    }
    let next: string;
    try { next = nextFireAt(b.cron, new Date()); } catch { return reply.code(400).send({ error: "invalid cron expression" }); }
    const schedule: Schedule = {
      id: randomUUID(), agentId: b.agentId, cron: b.cron,
      enabled: b.enabled ?? true, nextFireAt: next, lastFiredAt: null, createdAt: new Date().toISOString(),
      kind: (b.kind as Schedule["kind"]) ?? "manager",
      // Optional per-schedule custom prompt, appended to the agent's own startupPrompt on fire.
      prompt: b.prompt ?? null,
    };
    deps.db.insertSchedule(schedule);
    return reply.code(201).send(schedule);
  });
  app.post("/api/schedules/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deps.db.getSchedule(id)) return reply.code(404).send({ error: "schedule not found" });
    const b = (req.body ?? {}) as { cron?: string; enabled?: boolean; kind?: string; prompt?: string | null };
    if (b.kind !== undefined && !isScheduleKind(b.kind)) {
      return reply.code(400).send({ error: 'kind must be "manager", "auditor", or "workspace-auditor"' });
    }
    const patch: { cron?: string; enabled?: boolean; nextFireAt?: string; kind?: Schedule["kind"]; prompt?: string | null } = {};
    if (typeof b.enabled === "boolean") patch.enabled = b.enabled;
    if (isScheduleKind(b.kind)) patch.kind = b.kind;
    if (b.prompt !== undefined) patch.prompt = b.prompt;
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

  // --- Companion authorization admin (Companion epic Phase 1): the durable session↔chat bindings + the
  // per-binding group sender allowlist + the proactive HOME channel. HUMAN-ONLY loopback REST — there is
  // INTENTIONALLY NO MCP path (of ANY router: orchestration / platform / setup / audit). A chat-reachable,
  // injection-exposed companion agent must NOT be able to authorize new senders (or re-home itself) for
  // itself — same trust posture as the vault/git/api_keys human-only writers. The allowlist is consulted
  // LIVE by the db-backed CompanionAuth at inbound time, so an allowed-sender add/remove takes effect with
  // no restart; only the in-memory BINDING map needs a live poke (gateway.bind/unbind), done below. ---
  const COMPANION_ID_MAX = 200;
  const isNonBlankStr = (v: unknown, max = COMPANION_ID_MAX): v is string =>
    typeof v === "string" && v.trim().length > 0 && v.length <= max;
  app.get("/api/companion/bindings", async () => deps.db.listCompanionBindings());
  app.post("/api/companion/bindings", async (req, reply) => {
    const b = (req.body ?? {}) as { sessionId?: unknown; channel?: unknown; chatId?: unknown; scope?: unknown };
    if (!isNonBlankStr(b.sessionId)) return reply.code(400).send({ error: "sessionId must be a non-empty string" });
    const roleCheck = resolveCompanionAgent(b.sessionId.trim());
    if (!roleCheck.ok) return reply.code(roleCheck.code).send({ error: roleCheck.error });
    if (!isNonBlankStr(b.channel)) return reply.code(400).send({ error: "channel must be a non-empty string" });
    if (!isNonBlankStr(b.chatId)) return reply.code(400).send({ error: "chatId must be a non-empty string" });
    // scope is REQUIRED on the REST surface (product-safety): a human binding a GROUP chat MUST consciously
    // declare it. Defaulting to "dm" would silently admit EVERY member of a group chat bound by chatId
    // alone — reintroducing the multi-user hole this layer closes, by omission. (The ENV bootstrap keeps a
    // "dm" default — that path is the single-owner private chat, and requiring the var would break every
    // simple setup; only the REST surface, where group bindings are deliberately created, demands it.)
    if (b.scope !== "dm" && b.scope !== "group") return reply.code(400).send({ error: "scope is required and must be 'dm' or 'group'" });
    const scope = b.scope;
    let binding;
    try {
      binding = deps.db.upsertCompanionBinding({ sessionId: b.sessionId.trim(), channel: b.channel.trim(), chatId: b.chatId.trim(), scope });
    } catch (e) {
      // The UNIQUE (channel, chat_id) route index rejected a 2nd session claiming a bound route.
      return reply.code(409).send({ error: `that (channel, chatId) route is already bound to another session: ${(e as Error).message}` });
    }
    // Keep the live routing map in sync so the new/edited binding takes effect with no restart.
    deps.companion?.bind({ sessionId: binding.sessionId, channel: binding.channel, chatId: binding.chatId, scope: binding.scope });
    return reply.code(201).send(binding);
  });
  app.delete("/api/companion/bindings/:sessionId", async (req, reply) => {
    const sessionId = (req.params as { sessionId: string }).sessionId;
    const q = (req.query ?? {}) as { channel?: unknown };
    let channel: string | undefined;
    if (q.channel !== undefined) {
      if (!isNonBlankStr(q.channel)) return reply.code(400).send({ error: "channel must be a non-empty string" });
      channel = q.channel.trim();
    }
    // channel omitted → unchanged delete-ALL behavior; channel given → scope both the durable delete and
    // the live routing-map removal to that ONE channel, leaving the session's other channel(s) untouched.
    deps.db.deleteCompanionBinding(sessionId, channel);
    deps.companion?.unbind(sessionId, channel); // stop routing immediately (no stale in-memory binding until restart)
    return { ok: true };
  });

  // Per-binding allowlisted senders (the group-scope allowlist). GET is session-scoped (?sessionId=).
  app.get("/api/companion/allowed-senders", async (req, reply) => {
    const q = (req.query ?? {}) as { sessionId?: unknown };
    if (!isNonBlankStr(q.sessionId)) return reply.code(400).send({ error: "sessionId query param is required" });
    return deps.db.listAllowedSenders(q.sessionId.trim());
  });
  app.post("/api/companion/allowed-senders", async (req, reply) => {
    const b = (req.body ?? {}) as { sessionId?: unknown; channel?: unknown; senderId?: unknown; label?: unknown };
    if (!isNonBlankStr(b.sessionId)) return reply.code(400).send({ error: "sessionId must be a non-empty string" });
    const roleCheck = resolveCompanionAgent(b.sessionId.trim());
    if (!roleCheck.ok) return reply.code(roleCheck.code).send({ error: roleCheck.error });
    if (!isNonBlankStr(b.channel)) return reply.code(400).send({ error: "channel must be a non-empty string" });
    if (!isNonBlankStr(b.senderId)) return reply.code(400).send({ error: "senderId must be a non-empty string" });
    if (b.label !== undefined && b.label !== null && (typeof b.label !== "string" || b.label.length > COMPANION_ID_MAX)) {
      return reply.code(400).send({ error: `label must be a string of at most ${COMPANION_ID_MAX} characters` });
    }
    const label = typeof b.label === "string" ? b.label.trim() : null;
    const created = deps.db.addAllowedSender({ sessionId: b.sessionId.trim(), channel: b.channel.trim(), senderId: b.senderId.trim(), label });
    return reply.code(201).send(created);
  });
  app.delete("/api/companion/allowed-senders/:id", async (req) => {
    deps.db.removeAllowedSender((req.params as { id: string }).id);
    return { ok: true };
  });

  // The proactive HOME channel target (the proactive card 9488951e reads it), PER COMPANION SESSION
  // (multi-companion cross-delivery fix, task e849a487) — {channel, chatId}, keyed by ?sessionId=.
  app.get("/api/companion/home", async (req, reply) => {
    const q = req.query as { sessionId?: unknown };
    if (!isNonBlankStr(q.sessionId)) return reply.code(400).send({ error: "sessionId query param is required" });
    return deps.db.getCompanionHome(q.sessionId.trim());
  });
  app.put("/api/companion/home", async (req, reply) => {
    const b = (req.body ?? {}) as { sessionId?: unknown; channel?: unknown; chatId?: unknown };
    if (!isNonBlankStr(b.sessionId)) return reply.code(400).send({ error: "sessionId must be a non-empty string" });
    if (!isNonBlankStr(b.channel)) return reply.code(400).send({ error: "channel must be a non-empty string" });
    if (!isNonBlankStr(b.chatId)) return reply.code(400).send({ error: "chatId must be a non-empty string" });
    const sessionId = b.sessionId.trim();
    deps.db.setCompanionHome(sessionId, { channel: b.channel.trim(), chatId: b.chatId.trim() });
    // Refresh the controller's live `cfgs` cache (homeChannel/homeChatId) so no cfgs.home reader goes
    // stale — scoped to this one session, same pattern as the config POST/PUT/DELETE routes above.
    await deps.companion?.reconcile(sessionId);
    return deps.db.getCompanionHome(sessionId);
  });
  app.delete("/api/companion/home", async (req, reply) => {
    const q = req.query as { sessionId?: unknown };
    if (!isNonBlankStr(q.sessionId)) return reply.code(400).send({ error: "sessionId query param is required" });
    const sessionId = q.sessionId.trim();
    deps.db.clearCompanionHome(sessionId); // that session's proactive heartbeat turns OFF until a home is set again
    // Refresh the controller's live `cfgs` cache so a subsequent same-home match doesn't see the cleared
    // session's stale (now-wrong) home — scoped to this one session.
    await deps.companion?.reconcile(sessionId);
    return { ok: true };
  });

  // --- Companion DM-pairing: mint a one-time enrollment code (SECURITY). HUMAN-ONLY loopback REST, with
  // INTENTIONALLY NO MCP path (same trust posture as the bindings/allowlist/home writers above) — a
  // chat-reachable, injection-exposed companion agent must NEVER be able to mint an enrollment code for
  // itself (self-authorization). The plaintext code is returned ONCE here (the store keeps only a salted
  // hash); the human relays it to the person being enrolled, who redeems it by sending it to the chat.
  // The bound id at redemption is the AUTHENTICATED inbound metadata, never anything in this request. ---
  const PAIRING_TTL_DEFAULT_MIN = 10;
  const PAIRING_TTL_MAX_MIN = 15; // PL-stated 10–15 min window; short-TTL is a core anti-guessing defense
  app.post("/api/companion/pairing", async (req, reply) => {
    const b = (req.body ?? {}) as { sessionId?: unknown; grantType?: unknown; ttlMinutes?: unknown };
    if (!isNonBlankStr(b.sessionId)) return reply.code(400).send({ error: "sessionId must be a non-empty string" });
    const roleCheck = resolveCompanionAgent(b.sessionId.trim());
    if (!roleCheck.ok) return reply.code(roleCheck.code).send({ error: roleCheck.error });
    if (b.grantType !== "dm-bind" && b.grantType !== "group-sender") {
      return reply.code(400).send({ error: "grantType is required and must be 'dm-bind' or 'group-sender'" });
    }
    let ttlMinutes = PAIRING_TTL_DEFAULT_MIN;
    if (b.ttlMinutes !== undefined) {
      if (typeof b.ttlMinutes !== "number" || !Number.isFinite(b.ttlMinutes) || b.ttlMinutes <= 0 || b.ttlMinutes > PAIRING_TTL_MAX_MIN) {
        return reply.code(400).send({ error: `ttlMinutes must be a number in (0, ${PAIRING_TTL_MAX_MIN}]` });
      }
      ttlMinutes = b.ttlMinutes;
    }
    const minted = deps.db.mintPairingCode(
      { sessionId: b.sessionId.trim(), channel: TELEGRAM_CHANNEL, grantType: b.grantType, ttlMs: ttlMinutes * 60_000 },
      Date.now(),
    );
    return reply.code(201).send({ codeId: minted.codeId, code: minted.code, expiresAt: minted.expiresAt });
  });

  // --- Companion RUN config (Companion epic Phase 3): the DB-backed "how to RUN this companion" layer —
  // bot token (ENCRYPTED at rest via the envelope helper), channel, cadence, home, enabled — keyed by the
  // bound session id. HUMAN-ONLY loopback REST, INTENTIONALLY NO MCP path (of ANY router): a chat-reachable,
  // injection-exposed companion agent must NEVER be able to read or write its own bot token (same trust
  // posture as the bindings/allowlist/home writers + the git/vault/api_keys human-only writers). SECURITY:
  // the token is NEVER returned in clear or logged — every read is MASKED (configured + last-4 only). Every
  // write drives the RUNNING companion LIVE (no restart) via deps.companion.reconcile() AFTER the durable
  // write: an enable starts the adapter + arms the heartbeat, an edit re-arms/restarts, a disable/delete
  // tears it down to the OFF state. reconcile is best-effort (its own failures are logged, never 500 the
  // write) and serialized, so a burst of writes can't leak a long-poll or double-register chat_reply. ---
  const COMPANION_TOKEN_MAX = 4096;
  const COMPANION_PROMPT_MAX = 10_000;
  const COMPANION_CADENCE_MAX = 525_600; // one year in minutes — a generous upper bound, not a working value
  const homeOf = (sessionId: string) => deps.db.getCompanionHome(sessionId);
  // Validate + merge a config body against any existing row, returning either an error string (→ 400) or the
  // resolved upsert input (token encrypted). `requireCreateFields` is true for POST-create/PUT where the
  // full record must be present; on update the caller keeps existing values for omitted fields.
  const buildCompanionUpsert = (
    body: Record<string, unknown>,
    sessionId: string,
    existing: import("../db.js").CompanionConfigRow | undefined,
  ): { error: string } | {
    sessionId: string; botTokenBlob: string; channel: string; allowedChatId: string;
    chatScope: "dm" | "group"; heartbeatIntervalMinutes: number; heartbeatPrompt: string | null; enabled: boolean;
    name?: string;
  } => {
    // Bot token: required to CREATE (no existing row); on update, an omitted token keeps the stored blob.
    let botTokenBlob: string;
    if (isNonBlankStr(body.botToken, COMPANION_TOKEN_MAX)) {
      botTokenBlob = encryptSecret(body.botToken.trim());
    } else if (body.botToken !== undefined && body.botToken !== null) {
      return { error: `botToken must be a non-empty string of at most ${COMPANION_TOKEN_MAX} characters` };
    } else if (existing) {
      botTokenBlob = existing.botTokenBlob; // tokenless update — keep the encrypted token already stored
    } else {
      return { error: "botToken is required to create a companion config" };
    }
    // allowedChatId: required to create; kept on a partial update.
    let allowedChatId: string;
    if (isNonBlankStr(body.allowedChatId)) allowedChatId = body.allowedChatId.trim();
    else if (body.allowedChatId !== undefined) return { error: "allowedChatId must be a non-empty string" };
    else if (existing) allowedChatId = existing.allowedChatId;
    else return { error: "allowedChatId is required to create a companion config" };
    // channel: optional, defaults to the stored value or telegram.
    let channel: string;
    if (isNonBlankStr(body.channel)) channel = body.channel.trim();
    else if (body.channel !== undefined) return { error: "channel must be a non-empty string" };
    else channel = existing?.channel ?? TELEGRAM_CHANNEL;
    // chatScope: optional 'dm' | 'group'.
    let chatScope: "dm" | "group";
    if (body.chatScope === "dm" || body.chatScope === "group") chatScope = body.chatScope;
    else if (body.chatScope !== undefined) return { error: "chatScope must be 'dm' or 'group'" };
    else chatScope = existing?.chatScope ?? "dm";
    // heartbeatIntervalMinutes: optional non-negative integer (0 = off).
    let heartbeatIntervalMinutes: number;
    if (body.heartbeatIntervalMinutes !== undefined) {
      const n = body.heartbeatIntervalMinutes;
      if (typeof n !== "number" || !Number.isInteger(n) || n < 0 || n > COMPANION_CADENCE_MAX) {
        return { error: `heartbeatIntervalMinutes must be an integer in [0, ${COMPANION_CADENCE_MAX}]` };
      }
      heartbeatIntervalMinutes = n;
    } else heartbeatIntervalMinutes = existing?.heartbeatIntervalMinutes ?? 0;
    // heartbeatPrompt: optional string (null/blank clears back to the default).
    let heartbeatPrompt: string | null;
    if (body.heartbeatPrompt === undefined) heartbeatPrompt = existing?.heartbeatPrompt ?? null;
    else if (body.heartbeatPrompt === null) heartbeatPrompt = null;
    else if (typeof body.heartbeatPrompt !== "string" || body.heartbeatPrompt.length > COMPANION_PROMPT_MAX) {
      return { error: `heartbeatPrompt must be a string of at most ${COMPANION_PROMPT_MAX} characters` };
    } else heartbeatPrompt = body.heartbeatPrompt.trim() || null;
    // enabled: optional boolean.
    let enabled: boolean;
    if (typeof body.enabled === "boolean") enabled = body.enabled;
    else if (body.enabled !== undefined) return { error: "enabled must be a boolean" };
    else enabled = existing?.enabled ?? true;
    // name: optional given-name edit (Manage tab). OMITTED ⇒ leave undefined so db.upsertCompanionConfig's
    // own preserve-on-omit keeps the stored value; an explicit "" clears it (mirrors provision's contract).
    // Sanitized the SAME way as provision — this name reaches the identical composeAssistantStartupPrompt
    // injection on the companion's next spawn, so it must never carry structure-injecting control chars.
    let name: string | undefined;
    if (body.name !== undefined && body.name !== null) {
      if (typeof body.name !== "string" || body.name.length > COMPANION_ID_MAX) {
        return { error: `name must be a string of at most ${COMPANION_ID_MAX} characters` };
      }
      name = sanitizeCompanionName(body.name);
    }
    return { sessionId, botTokenBlob, channel, allowedChatId, chatScope, heartbeatIntervalMinutes, heartbeatPrompt, enabled, name };
  };
  // Reject a create/edit that would arm a Telegram token already used by another ENABLED companion (companion
  // multi-bot-token collision guard) — Telegram allows only ONE getUpdates consumer per token, so a shared
  // token is never valid; catching it here beats the reconcile-time skip-and-warn safety net (store.ts's
  // resolveAllEnabledConfigs). Only checked when the row being written is itself enabled and carries a token;
  // a disabled write or an in-app-only (tokenless) write is unaffected. Returns an error string, or null.
  const checkTokenCollision = (built: { sessionId: string; botTokenBlob: string; enabled: boolean }): string | null => {
    if (!built.enabled || !built.botTokenBlob) return null;
    let token: string;
    try {
      token = decryptSecret(built.botTokenBlob);
    } catch {
      return null; // we just encrypted this blob ourselves — a decrypt failure here should never block the write
    }
    const collidingSessionId = findEnabledTokenCollision(deps.db, token, built.sessionId);
    if (!collidingSessionId) return null;
    return `this Telegram bot token is already used by another enabled companion (session ${collidingSessionId.slice(0, 8)}) — Telegram allows only one getUpdates consumer per token; give this companion its own token or disable the other one first`;
  };
  // Optional home update carried on a config write — writes app_meta PER SESSION (never a value shared
  // across companions), returns error|null.
  const applyHomeIfPresent = (body: Record<string, unknown>, sessionId: string): string | null => {
    if (body.home === undefined || body.home === null) return null;
    const h = body.home as { channel?: unknown; chatId?: unknown };
    if (!isNonBlankStr(h.channel) || !isNonBlankStr(h.chatId)) return "home must be { channel, chatId } non-empty strings";
    deps.db.setCompanionHome(sessionId, { channel: h.channel.trim(), chatId: h.chatId.trim() });
    return null;
  };

  app.get("/api/companion/config", async () => {
    return deps.db.listCompanionConfigs().map((row) => maskCompanionConfig(row, homeOf(row.sessionId), process.env));
  });
  app.get("/api/companion/config/:sessionId", async (req, reply) => {
    const sessionId = (req.params as { sessionId: string }).sessionId;
    const row = deps.db.getCompanionConfig(sessionId);
    if (!row) return reply.code(404).send({ error: "no companion config for that session" });
    return maskCompanionConfig(row, homeOf(sessionId), process.env);
  });
  app.post("/api/companion/config", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (!isNonBlankStr(b.sessionId)) return reply.code(400).send({ error: "sessionId must be a non-empty string" });
    const sessionId = b.sessionId.trim();
    const roleCheck = resolveCompanionAgent(sessionId);
    if (!roleCheck.ok) return reply.code(roleCheck.code).send({ error: roleCheck.error });
    const existing = deps.db.getCompanionConfig(sessionId);
    const built = buildCompanionUpsert(b, sessionId, existing);
    if ("error" in built) return reply.code(400).send({ error: built.error });
    const tokenErr = checkTokenCollision(built);
    if (tokenErr) return reply.code(409).send({ error: tokenErr });
    const homeErr = applyHomeIfPresent(b, sessionId);
    if (homeErr) return reply.code(400).send({ error: homeErr });
    const row = deps.db.upsertCompanionConfig(built);
    await deps.companion?.reconcile(sessionId); // drive the running companion live (start/re-arm) — no restart, scoped to this session
    return reply.code(existing ? 200 : 201).send(maskCompanionConfig(row, homeOf(sessionId), process.env));
  });
  app.put("/api/companion/config/:sessionId", async (req, reply) => {
    const sessionId = (req.params as { sessionId: string }).sessionId;
    const existing = deps.db.getCompanionConfig(sessionId);
    if (!existing) return reply.code(404).send({ error: "no companion config for that session" });
    const b = (req.body ?? {}) as Record<string, unknown>;
    const built = buildCompanionUpsert(b, sessionId, existing);
    if ("error" in built) return reply.code(400).send({ error: built.error });
    const tokenErr = checkTokenCollision(built);
    if (tokenErr) return reply.code(409).send({ error: tokenErr });
    const homeErr = applyHomeIfPresent(b, sessionId);
    if (homeErr) return reply.code(400).send({ error: homeErr });
    const row = deps.db.upsertCompanionConfig(built);
    await deps.companion?.reconcile(sessionId); // drive the running companion live (re-arm/restart) — no restart, scoped to this session
    return maskCompanionConfig(row, homeOf(sessionId), process.env);
  });
  app.delete("/api/companion/config/:sessionId", async (req) => {
    const sessionId = (req.params as { sessionId: string }).sessionId;
    // Provenance-scoped teardown: read the row BEFORE the cascade delete so we know whether THIS endpoint's
    // provision minted the session (provisioned:true). A provisioned session is RETIRED with the config; a
    // pre-existing human-bound / env session (provisioned:false) is left running — deleting its run-config
    // only unarms the companion, it must not stop a session the user still owns.
    const existing = deps.db.getCompanionConfig(sessionId);
    deps.db.deleteCompanionConfig(sessionId); // cascade: config + bindings + allowed-senders + pairing codes
    await deps.companion?.reconcile(sessionId); // tear the live companion down to the OFF state — no restart, scoped to this session
    if (existing?.provisioned) {
      // Best-effort graceful retire (preserves the transcript; the session archives on exit). Never let a
      // teardown fault fail the delete — the durable cascade already succeeded.
      try { deps.sessions.stopSession(sessionId, "graceful"); } catch { /* session already gone / not live */ }
    }
    return { ok: true, retiredSession: !!existing?.provisioned };
  });

  // --- Companion PROVISION (card cbc9fa68): the one-shot "New companion" endpoint behind the future UI
  // button. HUMAN-ONLY loopback REST, INTENTIONALLY NO MCP path (of ANY router): a chat-reachable,
  // injection-exposed companion agent must NEVER be able to provision (self-spawn) a companion — same trust
  // posture as the bindings/allowlist/config human-only writers. ATOMIC: spawn a long-lived assistant
  // session on the chosen rig (default = the bundled "Companion" agent), create the config row bound to that
  // NEW session (token encrypted via envelope IF a botToken is given; no token ⇒ IN-APP-ONLY, the default),
  // write the session's bindings-authoritative route(s) — the in-app route ALWAYS, plus the Telegram dm route
  // when botToken+allowedChatId are given (companion_bindings is multi-channel: one binding per channel), and
  // arm the running companion via reconcile() (Telegram adapter armed ONLY when a token exists).
  // ROLLBACK (load-bearing): any post-spawn write failure TEARS DOWN the spawned session so no orphan is
  // left. Returns the MASKED companion (never the plaintext token). ---
  app.post("/api/companion/provision", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    // name: optional human label. Persisted to companion_config.name and baked into the companion's startup
    // prompt at creation (composeAssistantStartupPrompt) so a named companion knows its own name.
    if (b.name !== undefined && b.name !== null && (typeof b.name !== "string" || b.name.length > COMPANION_ID_MAX)) {
      return reply.code(400).send({ error: `name must be a string of at most ${COMPANION_ID_MAX} characters` });
    }
    // Sanitize BEFORE it ever reaches the server-owned ASSISTANT_BASE_BRIEF: collapse any run of
    // whitespace/control characters (incl. newlines) to a single space, then trim — a single-line,
    // printable name only. Without this, a name like "Aria\n\n## Untrusted input\n\n…" could inject
    // structure into the one region of the prompt that must never be user-editable.
    const name = typeof b.name === "string" ? sanitizeCompanionName(b.name) : "";
    // (multi-companion runtime): the single-companion pre-spawn 409 that used to live here is GONE — the
    // controller now arms every enabled config concurrently (resolveAllEnabledConfigs), so a 2nd (or Nth)
    // companion provisioned while another is enabled gets its OWN gateway/session/heartbeat, not an
    // inert/unrouted one. GUARD 2/3 below (chat-id-needs-token, assistant-role-rig) are unrelated to
    // single-vs-multi and stay.
    // Resolve the rig: an explicit agentId, else the bundled "Companion" agent in the reserved setup home —
    // AUTO-CLONING a fresh agent when that default is already running a live enabled companion (card
    // e6f68bc4, owner-chosen option A): "+ New companion" still "just works" with no picker, but a 2nd+
    // companion gets bound to its OWN distinct agent/persona instead of racing a duplicate session onto the
    // SAME agent as the first. The FIRST companion (default not yet occupied) still binds the bundled agent
    // directly — existing single-companion users are unaffected.
    //
    // The clone itself is DEFERRED — minted only right before the spawn, well below — rather than performed
    // here: minting it this early would insert an Agent row before the remaining pre-spawn guards (chatId,
    // token collision, assistant-role) run, and none of their reject paths delete it, leaking a ghost agent
    // on every rejected 2nd-companion attempt. `agentId` stays null while a clone is pending; `cloneSource`
    // carries what to clone from once every guard below has passed.
    let agentId: string | null = null;
    let cloneSource: { sourceAgentId: string; targetProjectId: string } | null = null;
    if (b.agentId !== undefined && b.agentId !== null) {
      if (!isNonBlankStr(b.agentId)) return reply.code(400).send({ error: "agentId must be a non-empty string" });
      if (!deps.db.getAgent(b.agentId.trim())) return reply.code(404).send({ error: "agent not found" });
      agentId = b.agentId.trim();
    } else {
      const home = deps.db.getReservedProjectByName(SETUP_PROJECT_NAME);
      const companionAgent = home ? deps.db.listAgents(home.id).find((a) => a.name === COMPANION_AGENT_NAME) : undefined;
      if (!home || !companionAgent) return reply.code(400).send({ error: "no default Companion rig is available — pass an explicit agentId" });
      if (findEnabledAgentCollision(deps.db, companionAgent.id)) {
        cloneSource = { sourceAgentId: companionAgent.id, targetProjectId: home.id };
      } else {
        agentId = companionAgent.id;
      }
    }
    // GUARD 3 (assistant-role rig, correctness + least-privilege): chat_reply is gated on role=assistant, so a
    // non-assistant rig yields a companion that can't reply — and binding a chat-reachable/injection-exposed
    // agent to a manager/platform/worker rig is a blast-radius escalation. REJECT any rig whose resolved
    // profile role isn't "assistant" (a profile-less / null-role agent is rejected too). The bundled Companion
    // rig is assistant, so the default path is unaffected; only an explicit non-assistant agentId is rejected.
    // A still-PENDING clone carries its source's profileId VERBATIM (cloneAgentCore), so checking the SOURCE
    // agent's role here is equivalent to checking the eventual clone's — without minting it early.
    const rigAgent = deps.db.getAgent(agentId ?? cloneSource!.sourceAgentId);
    const rigProfile = rigAgent?.profileId ? deps.db.getProfile(rigAgent.profileId) : undefined;
    if (rigProfile?.role !== "assistant") {
      return reply.code(400).send({ error: "a companion rig must be an assistant-role profile" });
    }
    // botToken: optional. Present ⇒ Telegram is ALSO wired (encrypted at rest); omitted ⇒ in-app-only.
    let botToken: string | null = null;
    if (isNonBlankStr(b.botToken, COMPANION_TOKEN_MAX)) botToken = b.botToken.trim();
    else if (b.botToken !== undefined && b.botToken !== null) {
      return reply.code(400).send({ error: `botToken must be a non-empty string of at most ${COMPANION_TOKEN_MAX} characters` });
    }
    // allowedChatId: the Telegram chat to bind (only meaningful WITH a token). Optional; validated when present.
    let allowedChatId = "";
    if (isNonBlankStr(b.allowedChatId)) allowedChatId = b.allowedChatId.trim();
    else if (b.allowedChatId !== undefined && b.allowedChatId !== null) {
      return reply.code(400).send({ error: "allowedChatId must be a non-empty string" });
    }
    // GUARD 2 (token needs a chat to reach): a botToken with NO allowedChatId would arm a Telegram long-poll
    // but write the IN-APP binding (the else branch below) — advertising telegram/tokenConfigured while being
    // unreachable over Telegram. REJECT. (No token + no chatId stays the in-app-only default.)
    if (botToken && !allowedChatId) {
      return reply.code(400).send({ error: "allowedChatId is required when botToken is given" });
    }
    // channel: the Telegram transport channel label (default telegram). Optional.
    let channel = TELEGRAM_CHANNEL;
    if (isNonBlankStr(b.channel)) channel = b.channel.trim();
    else if (b.channel !== undefined && b.channel !== null) {
      return reply.code(400).send({ error: "channel must be a non-empty string" });
    }
    // cadence: optional proactive heartbeat interval in minutes (0 = off).
    let cadence = 0;
    if (b.cadence !== undefined && b.cadence !== null) {
      if (typeof b.cadence !== "number" || !Number.isInteger(b.cadence) || b.cadence < 0 || b.cadence > COMPANION_CADENCE_MAX) {
        return reply.code(400).send({ error: `cadence must be an integer in [0, ${COMPANION_CADENCE_MAX}]` });
      }
      cadence = b.cadence;
    }
    // enabled: optional boolean (default true — a provisioned companion arms immediately).
    let enabled = true;
    if (typeof b.enabled === "boolean") enabled = b.enabled;
    else if (b.enabled !== undefined && b.enabled !== null) return reply.code(400).send({ error: "enabled must be a boolean" });
    // GUARD 4 (companion multi-bot-token collision guard): Telegram allows only ONE getUpdates consumer per
    // bot token — a token already armed on another ENABLED companion is never valid. Checked BEFORE spawning
    // the session: there's no reason to spawn+rollback for a precondition catchable up front.
    if (botToken && enabled) {
      const collidingSessionId = findEnabledTokenCollision(deps.db, botToken);
      if (collidingSessionId) {
        return reply.code(409).send({
          error: `this Telegram bot token is already used by another enabled companion (session ${collidingSessionId.slice(0, 8)}) — Telegram allows only one getUpdates consumer per token; give this companion its own token`,
        });
      }
    }
    // GUARD 5 (same-agent collision backstop, card e6f68bc4): an agent may host only ONE live enabled
    // companion at a time. Only meaningful for an ALREADY-resolved agentId (the explicit-agentId path) — a
    // still-PENDING clone (agentId null here) is by construction a brand-new agent that cannot already host
    // a companion, so it's exempt; this catches what the auto-clone doesn't — an EXPLICIT agentId that
    // collides with an already-live enabled companion, or any other race — before spawning a 2nd session
    // that would silently duplicate it.
    if (enabled && agentId) {
      const agentCollision = findEnabledAgentCollision(deps.db, agentId);
      if (agentCollision) {
        return reply.code(409).send({
          error: `this agent already has a live enabled companion (session ${agentCollision.slice(0, 8)}) — an agent can host only one enabled companion at a time; give this companion its own agent`,
        });
      }
    }
    // home: optional { channel, chatId } proactive target.
    let home: CompanionRoute | null = null;
    if (b.home !== undefined && b.home !== null) {
      const h = b.home as { channel?: unknown; chatId?: unknown };
      if (!isNonBlankStr(h.channel) || !isNonBlankStr(h.chatId)) return reply.code(400).send({ error: "home must be { channel, chatId } non-empty strings" });
      home = { channel: h.channel.trim(), chatId: h.chatId.trim() };
    }

    // Mint the DEFERRED clone now — every pre-spawn guard above has passed, so this insert and the session
    // spawn below live on the SAME guarded/rollback path (no orphan agent on a later spawn/post-spawn
    // failure — see the two rollback sites below). An unnamed clone gets a distinguishing numeric-suffixed
    // label instead of inheriting the bundled rig's bare name verbatim (else every unnamed companion would
    // be indistinguishable in the picker). cloneAgentCore's least-privilege guard is a no-op here (the
    // bundled Companion rig is always an assistant-role profile), but it stays load-bearing if that rig were
    // ever repointed at something elevated — REJECTED (403), not silently propagated.
    let clonedAgentId: string | null = null;
    if (cloneSource) {
      const source = deps.db.getAgent(cloneSource.sourceAgentId)!;
      const label = name || `${source.name} ${deps.db.listAgents(cloneSource.targetProjectId).length + 1}`;
      const cloned = cloneAgentCore(deps.db, cloneSource.sourceAgentId, cloneSource.targetProjectId, { nameOverride: label });
      if (!cloned.ok) return reply.code(403).send({ error: `failed to clone a new companion agent: ${cloned.error}` });
      agentId = cloned.agent.id;
      clonedAgentId = cloned.agent.id;
    }

    // (a) Spawn the long-lived assistant session on the chosen rig. A spawn failure here has nothing to roll
    // back except a just-minted clone (if any) — no session/config/binding was written yet. companionName
    // bakes the given name into the startup prompt at creation (a blank name is a harmless no-op — see
    // composeAssistantStartupPrompt).
    let sessionId: string;
    try {
      sessionId = deps.sessions.startNew(agentId!, { companionName: name }).id;
    } catch (e) {
      if (clonedAgentId) { try { deleteAgentCore(deps.db, clonedAgentId); } catch { /* best-effort — nothing else was written */ } }
      return reply.code(500).send({ error: `failed to spawn the companion session: ${(e as Error).message}` });
    }

    // (b–d) Everything AFTER the spawn is wrapped so a failure tears the session (and a just-cloned agent)
    // down (no orphan). The cascade delete cleans any partial config/binding writes; deleteSession + a hard
    // stop remove the row.
    try {
      // (b) config row bound to the NEW session — token encrypted IF given, else empty blob (no token stored).
      const row = deps.db.upsertCompanionConfig({
        sessionId,
        botTokenBlob: botToken ? encryptSecret(botToken) : "",
        channel: botToken ? channel : IN_APP_CHANNEL,
        allowedChatId,
        chatScope: "dm",
        heartbeatIntervalMinutes: cadence,
        heartbeatPrompt: null,
        enabled,
        name,
        provisioned: true, // origin marker — delete-companion retires THIS session (teardown symmetry)
      });
      // (c) the session's authoritative binding(s). companion_bindings is now MULTI-CHANNEL (one binding per
      // session PER channel), so a Telegram companion is reachable over Telegram AND the in-app cockpit panel
      // at once. Write the IN-APP route ALWAYS (chatId == the session id, loopback-authenticated — the cockpit
      // chat panel), and ADDITIVELY the Telegram dm route when a token + chat are given (its external reach).
      // Both go through the SAME human-only bindings/authz path (db.upsertCompanionBinding, keyed on
      // (session_id, channel)), so the Telegram write NEVER clobbers the in-app one.
      deps.db.upsertCompanionBinding({ sessionId, channel: IN_APP_CHANNEL, chatId: sessionId, scope: "dm" });
      if (botToken && allowedChatId) {
        deps.db.upsertCompanionBinding({ sessionId, channel, chatId: allowedChatId, scope: "dm" });
      }
      if (home) deps.db.setCompanionHome(sessionId, home);
      // (d) arm the running companion — reconcile builds the gateway from the bindings above; the Telegram
      // adapter arms ONLY when a token exists (in-app-only ⇒ no external adapter). reconcile is best-effort
      // (never throws), so it never triggers rollback — only a durable write failure above does. Scoped to
      // THIS newly-provisioned session — no other live companion is touched.
      await deps.companion?.reconcile(sessionId);
      return reply.code(201).send(maskCompanionConfig(row, homeOf(sessionId), process.env));
    } catch (e) {
      // ROLLBACK: tear the spawned session down so no orphan session/config/binding survives a partial write.
      try { deps.db.deleteCompanionConfig(sessionId); } catch { /* nothing written / already gone */ }
      try { deps.sessions.stopSession(sessionId, "hard"); } catch { /* pty already gone */ }
      try { deps.db.deleteSession(sessionId); } catch { /* row already gone */ }
      // A just-cloned agent has no reason to survive a rolled-back provision either — the session it was
      // minted for is already gone (deleteSession above), so deleteAgentCore's live-session check is clear.
      if (clonedAgentId) { try { deleteAgentCore(deps.db, clonedAgentId); } catch { /* best-effort */ } }
      await deps.companion?.reconcile(sessionId); // return the live companion to whatever the DB now reflects (OFF), scoped to this session
      return reply.code(500).send({ error: `companion provision failed and was rolled back: ${(e as Error).message}` });
    }
  });

  // --- Companion PERSONA + SELF-AUTHORED SKILLS: the companion's "brain" (card follow-up to the epic).
  // HUMAN-ONLY loopback REST, INTENTIONALLY NO MCP path (of ANY router) — same trust posture as every other
  // writer in this companion section: a chat-reachable, injection-exposed companion agent must never read
  // or rewrite its own standing instructions, or curate its own skill library, through a path a human didn't
  // drive. Both resolve "the companion" by sessionId (mirroring /api/companion/config/:sessionId above).
  //
  // PROMPT: GET/PUT the agent's own editable `startupPrompt` — the `own` half composeAssistantStartupPrompt
  // (sessions/assistant-prompt.ts) layers UNDER the server-owned ASSISTANT_BASE_BRIEF. The brief itself (the
  // companion's identity + untrusted-input posture + chat_reply doctrine) is a CODE CONSTANT — never read
  // from the DB or accepted from a request body — so it stays read-only BY CONSTRUCTION; GET returns it
  // alongside the editable prompt purely so the UI can preview the full composed opening.
  //
  // SKILLS: read (list + single) + curate (delete) over the SAME isolated per-companion store the companion
  // authors over MCP (skills/companion-store.ts, <LOOM_HOME>/companion-skills/<sessionId>/). Authoring stays
  // the companion's own on-demand job (skill_author over MCP) — no human REST create/edit here, only review
  // + prune.
  type ResolvedCompanionAgent =
    | { ok: true; agent: Agent }
    | { ok: false; code: number; error: string };
  const resolveCompanionAgent = (sessionId: string): ResolvedCompanionAgent => {
    const session = deps.db.getSession(sessionId);
    if (!session) return { ok: false, code: 404, error: "session not found" };
    if (session.role !== "assistant") return { ok: false, code: 400, error: "not a companion (assistant-role) session" };
    const agent = deps.db.getAgent(session.agentId);
    if (!agent) return { ok: false, code: 404, error: "agent not found" };
    return { ok: true, agent };
  };
  app.get("/api/companion/prompt/:sessionId", async (req, reply) => {
    const sessionId = (req.params as { sessionId: string }).sessionId;
    const r = resolveCompanionAgent(sessionId);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    return { sessionId, startupPrompt: r.agent.startupPrompt, baseBrief: ASSISTANT_BASE_BRIEF };
  });
  app.put("/api/companion/prompt/:sessionId", async (req, reply) => {
    const sessionId = (req.params as { sessionId: string }).sessionId;
    const r = resolveCompanionAgent(sessionId);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    const b = (req.body ?? {}) as { startupPrompt?: unknown };
    if (typeof b.startupPrompt !== "string" || b.startupPrompt.length > COMPANION_PROMPT_MAX) {
      return reply.code(400).send({ error: `startupPrompt must be a string of at most ${COMPANION_PROMPT_MAX} characters` });
    }
    deps.db.updateAgent(r.agent.id, { startupPrompt: b.startupPrompt });
    return { sessionId, startupPrompt: b.startupPrompt, baseBrief: ASSISTANT_BASE_BRIEF };
  });

  app.get("/api/companion/skills/:sessionId", async (req, reply) => {
    const sessionId = (req.params as { sessionId: string }).sessionId;
    const r = resolveCompanionAgent(sessionId);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    return { skills: listCompanionSkills(sessionId) };
  });
  app.get("/api/companion/skills/:sessionId/:name", async (req, reply) => {
    const { sessionId, name } = req.params as { sessionId: string; name: string };
    const r = resolveCompanionAgent(sessionId);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    const content = readCompanionSkill(sessionId, name);
    if (content == null) return reply.code(404).send({ error: `no skill "${name}"` });
    return { name, content };
  });
  app.delete("/api/companion/skills/:sessionId/:name", async (req, reply) => {
    const { sessionId, name } = req.params as { sessionId: string; name: string };
    const r = resolveCompanionAgent(sessionId);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    const result = removeCompanionSkill(sessionId, name);
    if (!result.ok) return reply.code(404).send({ error: result.error });
    return { ok: true, skills: result.skills };
  });

  // MEMORY: read (list + single) + curate (delete) over the companion's OWN isolated MEMORY.md store
  // (skills/companion-memory-store.ts, <LOOM_HOME>/companion-memory/<sessionId>/) — the sibling of SKILLS
  // above, same posture: authoring stays the companion's own on-demand job (a future memory-MCP surface),
  // no human REST create/edit here, only review + prune.
  app.get("/api/companion/memory/:sessionId", async (req, reply) => {
    const sessionId = (req.params as { sessionId: string }).sessionId;
    const r = resolveCompanionAgent(sessionId);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    return { memories: listCompanionMemories(sessionId) };
  });
  app.get("/api/companion/memory/:sessionId/:name", async (req, reply) => {
    const { sessionId, name } = req.params as { sessionId: string; name: string };
    const r = resolveCompanionAgent(sessionId);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    const content = readCompanionMemory(sessionId, name);
    if (content == null) return reply.code(404).send({ error: `no memory "${name}"` });
    return { name, content };
  });
  app.delete("/api/companion/memory/:sessionId/:name", async (req, reply) => {
    const { sessionId, name } = req.params as { sessionId: string; name: string };
    const r = resolveCompanionAgent(sessionId);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    const result = removeCompanionMemory(sessionId, name);
    if (!result.ok) return reply.code(404).send({ error: result.error });
    return { ok: true, memories: result.memories };
  });

  // REMINDERS: read (list) + curate (delete) over the companion's OWN `companion_reminders` rows
  // (Companion Memory & Reminders Design, Surface 2 s3 engine — companion/reminders.ts). Same posture as
  // MEMORY/SKILLS above: VIEW + PRUNE only, no human REST create/edit here — a reminder's own MCP
  // authoring tool (s4, a sibling card) is the only writer. DELETE needs no controller rearm: the watcher
  // re-reads `listEnabledCompanionReminders` fresh every tick (companion/reminders.ts `tick`), so a
  // deleted row is simply absent from the very next tick's query — nothing to re-arm.
  const companionReminderList = (sessionId: string) => deps.db.listCompanionRemindersForSession(sessionId).map((rem) => {
    let next: string | null = null;
    try { next = nextFireAt(rem.cron, new Date()); } catch { /* corrupt cron on the row — omit, don't 500 */ }
    return { id: rem.id, cron: rem.cron, prompt: rem.prompt, label: rem.label, enabled: rem.enabled, createdAt: rem.createdAt, nextFireAt: next };
  });
  app.get("/api/companion/reminders/:sessionId", async (req, reply) => {
    const sessionId = (req.params as { sessionId: string }).sessionId;
    const r = resolveCompanionAgent(sessionId);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    return { reminders: companionReminderList(sessionId) };
  });
  app.delete("/api/companion/reminders/:sessionId/:reminderId", async (req, reply) => {
    const { sessionId, reminderId } = req.params as { sessionId: string; reminderId: string };
    const r = resolveCompanionAgent(sessionId);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    const reminder = deps.db.getCompanionReminder(reminderId);
    if (!reminder || reminder.sessionId !== sessionId) return reply.code(404).send({ error: `no reminder "${reminderId}"` });
    deps.db.deleteCompanionReminder(reminderId);
    return { ok: true, reminders: companionReminderList(sessionId) };
  });

  // --- Companion CHAT HISTORY (bug 0f01f234 — the "reload loses the whole conversation" fix; UNIFIED
  // CROSS-CHANNEL CHAT, card 7d63e200; CONVERSATION HISTORY, card 85f62475): a READ-ONLY view over the
  // durable `companion_messages` rows the inbound/outbound record hooks write (controller.ts / in-app.ts /
  // chat-gateway.ts). Same posture as MEMORY/SKILLS/REMINDERS above (VIEW only). Returns the session's
  // CURRENT (open) conversation's rows only — a "/new" boundary is respected, so a browser reload never
  // resurfaces a conversation the owner already archived; see GET /api/companion/conversations/:sessionId
  // below to browse archived ones. Every channel's rows for that conversation, chronological — so the
  // owner's Telegram conversation (their messages + the companion's replies, including voice-note
  // transcripts) renders alongside the in-app history as ONE merged stream; each row still carries its own
  // `channel` (+ `viaVoice`) for the web panel's per-bubble provenance badge / mic indicator. The web
  // cockpit's CompanionChat panel calls this ONCE on mount (load-then-connect), THEN opens the live WS —
  // see companionChat.ts.
  app.get("/api/companion/messages/:sessionId", async (req, reply) => {
    const sessionId = (req.params as { sessionId: string }).sessionId;
    const r = resolveCompanionAgent(sessionId);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    return { messages: deps.db.listCurrentCompanionMessages(sessionId) };
  });

  // --- Companion CONVERSATION HISTORY (card 85f62475): browse the session's ARCHIVED conversations — every
  // "/new"/"/reset" closes the current conversation (retained, never deleted, up to the retention cap in
  // db.ts) and opens a fresh one. READ-ONLY, same posture as the routes above — no MCP path, human-only
  // loopback REST.
  app.get("/api/companion/conversations/:sessionId", async (req, reply) => {
    const sessionId = (req.params as { sessionId: string }).sessionId;
    const r = resolveCompanionAgent(sessionId);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    return { conversations: deps.db.listCompanionConversations(sessionId) };
  });
  // Fetch ONE conversation's full unified message list (every channel, chronological) — the history list's
  // drill-down. 404s when `seq` isn't a valid integer or names a conversation the session never had (checked
  // via listCompanionConversations rather than trusting an empty listCompanionMessagesForConversation result,
  // which is also empty for a conversation that legitimately has zero messages).
  app.get("/api/companion/conversations/:sessionId/:seq", async (req, reply) => {
    const { sessionId, seq: seqParam } = req.params as { sessionId: string; seq: string };
    const r = resolveCompanionAgent(sessionId);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    const seq = Number(seqParam);
    if (!Number.isInteger(seq)) return reply.code(400).send({ error: "seq must be an integer" });
    const conversation = deps.db.listCompanionConversations(sessionId).find((c) => c.seq === seq);
    if (!conversation) return reply.code(404).send({ error: "conversation not found" });
    return {
      conversation: { seq: conversation.seq, startedAt: conversation.startedAt, endedAt: conversation.endedAt },
      messages: deps.db.listCompanionMessagesForConversation(sessionId, seq),
    };
  });

  // --- Companion VOICE PREFERENCES (Companion Voice epic, VOICE-P1 foundation): a READ-ONLY view over the
  // per-route `companion_voice_prefs` rows the "/lang"/"/voice" slash-command router writes (commands.ts →
  // voice-prefs.ts). Same posture as MEMORY/SKILLS/REMINDERS above: VIEW only, no human REST write here —
  // the ONLY writer is the already-authorized inbound slash-command path, never a human-supplied body (a
  // human REST write would let anyone bypass the per-route authz the command router enforces).
  app.get("/api/companion/voice-prefs/:sessionId", async (req, reply) => {
    const sessionId = (req.params as { sessionId: string }).sessionId;
    const r = resolveCompanionAgent(sessionId);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    return { prefs: deps.db.listCompanionVoicePrefsForSession(sessionId) };
  });

  // --- Companion RESTRICTED TOOLS (blast-radius control, live-apply fix): restrictedTools is a SPAWN-TIME
  // property re-read from the SESSION ROW on every resume/fork/recycle (sessions/service.ts resolveAgentSpawn's
  // comment; `restrictedTools` on the row, NOT re-resolved from the Profile) — the Manage toggle used to edit
  // only the shared Companion Profile, which a resume-durable companion never re-reads, so the toggle did
  // nothing for an already-running companion. This writes the ROW directly instead. HUMAN-ONLY loopback REST,
  // INTENTIONALLY NO MCP path — same trust posture as the prompt/skills writers above: a chat-reachable,
  // injection-exposed companion agent must never widen its own tool surface. Resolves the SPECIFIC companion
  // by sessionId (mirrors resolveCompanionAgent above), never "the first assistant-role profile".
  // A write here has NO live effect until the session is next restarted (stop+resume) — restrictedTools
  // feeds `buildSpawnArgs`' `--disallowedTools` list, which is fixed at spawn time; the web UI surfaces that
  // plainly and gates the restart behind an explicit human confirm (never silently restarts a live companion).
  app.get("/api/companion/restricted-tools/:sessionId", async (req, reply) => {
    const sessionId = (req.params as { sessionId: string }).sessionId;
    const r = resolveCompanionAgent(sessionId);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    const session = deps.db.getSession(sessionId)!;
    return { sessionId, restrictedTools: session.restrictedTools ?? false };
  });
  app.put("/api/companion/restricted-tools/:sessionId", async (req, reply) => {
    const sessionId = (req.params as { sessionId: string }).sessionId;
    const r = resolveCompanionAgent(sessionId);
    if (!r.ok) return reply.code(r.code).send({ error: r.error });
    const b = (req.body ?? {}) as { restrictedTools?: unknown };
    if (typeof b.restrictedTools !== "boolean") {
      return reply.code(400).send({ error: "restrictedTools must be a boolean" });
    }
    deps.db.setRestrictedTools(sessionId, b.restrictedTools);
    return { sessionId, restrictedTools: b.restrictedTools };
  });

  // --- Owner-controlled encrypted credential store (agent-tooling epic, P1 foundation). HUMAN-ONLY
  // loopback REST, INTENTIONALLY NO MCP path (of ANY router): an agent in an ordinary project session must
  // never create, list, or read a connection's secret (same trust posture as the companion/vault/git
  // human-only writers). Reads are ALWAYS metadata only (name/host/authScheme/createdAt) — the secret is
  // encrypted at rest (envelope helper) and this layer never returns it. Validation (length bounds +
  // authScheme enum) is OWNED by `connections/store.ts` (createConnection throws a descriptive Error on
  // invalid input) — this handler only narrows the body's TYPE (so a non-string can't reach the store),
  // then maps the store's thrown validation error to a 400. See that module's doc for why the invariant
  // must not live only here. ---
  app.get("/api/connections", async () => listConnections(deps.db));
  app.post("/api/connections", async (req, reply) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b.name !== "string" || typeof b.host !== "string" || typeof b.secret !== "string") {
      return reply.code(400).send({ error: "name, host, and secret must be strings" });
    }
    if (b.authScheme !== "api-key" && b.authScheme !== "bearer") {
      return reply.code(400).send({ error: "authScheme must be 'api-key' or 'bearer'" });
    }
    try {
      const created = createConnection(deps.db, { name: b.name, host: b.host, authScheme: b.authScheme, secret: b.secret });
      return reply.code(201).send(created);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
  app.delete("/api/connections/:id", async (req) => {
    deleteConnection(deps.db, (req.params as { id: string }).id);
    return { ok: true };
  });

  // --- Capability registry catalog (agent-tooling epic P4): the two BUILTIN capabilities (browser-testing/
  // document-conversion) PLUS owner-added rows, listed as ONE unified REST-facing catalog. HUMAN-managed
  // ONLY (loopback REST), INTENTIONALLY NO MCP path — a capability grant can launch a host process and
  // bind egress, the same trust posture as connections above. Accepts all four provision kinds
  // (node-package/python-venv/bundled/command) — `command` is owner-typed-therefore-trusted, resolved to
  // an absolute path at save time (see capabilities/registry.ts). ---
  app.get("/api/capabilities", async () => listCapabilitySummaries(deps.db));
  app.post("/api/capabilities", async (req, reply) => {
    try {
      const created = createCapabilityDef(deps.db, (req.body ?? {}) as Parameters<typeof createCapabilityDef>[1]);
      return reply.code(201).send(created);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });
  app.delete("/api/capabilities/:id", async (req) => {
    deleteCapabilityDef(deps.db, (req.params as { id: string }).id);
    return { ok: true };
  });

  // --- Poll-job triggers (agent-tooling epic P3): local, human-configured cadence jobs the daemon
  // PollService fetches via a connection and wakes/spawns a session on new items. HUMAN-ONLY loopback
  // REST, INTENTIONALLY NO MCP path (mirrors connections/schedules) — a poll job references a connection,
  // so it inherits that surface's trust posture. ---
  const isPollMode = (v: unknown): v is PollJob["mode"] => v === "wake" || v === "spawn";
  /**
   * Validate a poll job's mode↔target pairing + target existence — the ONE check both create and update
   * must enforce (the two-path anti-pattern: an update that skipped this could patch a job into an
   * inconsistent mode/target pair that the tick's OWN structural guard then silently disables, turning a
   * fixable 400 into a vanished job). Called with the EFFECTIVE post-patch mode/sessionId/agentId — for
   * create that's just the body; for update it's the body merged over the existing row. Returns the
   * normalized {sessionId, agentId} to persist (the field for the OTHER mode is always cleared).
   */
  const validatePollTarget = (
    mode: PollJob["mode"], sessionId: string | null | undefined, agentId: string | null | undefined,
  ): { ok: true; sessionId: string | null; agentId: string | null } | { ok: false; status: number; error: string } => {
    if (mode === "wake") {
      if (!sessionId || !deps.db.getSession(sessionId)) return { ok: false, status: 404, error: "mode 'wake' requires an existing sessionId" };
      return { ok: true, sessionId, agentId: null };
    }
    if (!agentId || !deps.db.getAgent(agentId)) return { ok: false, status: 404, error: "mode 'spawn' requires an existing agentId" };
    return { ok: true, sessionId: null, agentId };
  };
  app.get("/api/poll-jobs", async () => deps.db.listPollJobs());
  app.post("/api/poll-jobs", async (req, reply) => {
    const b = (req.body ?? {}) as {
      connectionId?: string; path?: string; method?: string; intervalMs?: number;
      itemsPath?: string; idPath?: string; mode?: string; sessionId?: string; agentId?: string; enabled?: boolean;
    };
    if (!b.connectionId || !b.path) return reply.code(400).send({ error: "connectionId and path required" });
    if (!deps.db.getConnection(b.connectionId)) return reply.code(404).send({ error: "connection not found" });
    if (!b.path.startsWith("/")) return reply.code(400).send({ error: "path must start with '/'" });
    if (typeof b.intervalMs !== "number" || b.intervalMs < MIN_POLL_INTERVAL_MS) {
      return reply.code(400).send({ error: `intervalMs must be a number >= ${MIN_POLL_INTERVAL_MS}` });
    }
    if (!isPollMode(b.mode)) return reply.code(400).send({ error: "mode must be 'wake' or 'spawn'" });
    const target = validatePollTarget(b.mode, b.sessionId, b.agentId);
    if (!target.ok) return reply.code(target.status).send({ error: target.error });
    const job: PollJob = {
      id: randomUUID(), connectionId: b.connectionId, path: b.path, method: (b.method ?? "GET").toUpperCase(),
      intervalMs: b.intervalMs, nextPollAt: new Date().toISOString(), lastPolledAt: null,
      itemsPath: b.itemsPath ?? "", idPath: b.idPath ?? "id", cursorJson: null,
      mode: b.mode, sessionId: target.sessionId, agentId: target.agentId,
      enabled: b.enabled ?? true, consecutiveFailures: 0, lastError: null, createdAt: new Date().toISOString(),
    };
    deps.db.insertPollJob(job);
    return reply.code(201).send(job);
  });
  app.post("/api/poll-jobs/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const existing = deps.db.getPollJob(id);
    if (!existing) return reply.code(404).send({ error: "poll job not found" });
    const b = (req.body ?? {}) as {
      path?: string; method?: string; intervalMs?: number; itemsPath?: string; idPath?: string;
      mode?: string; sessionId?: string; agentId?: string; enabled?: boolean;
    };
    if (b.mode !== undefined && !isPollMode(b.mode)) return reply.code(400).send({ error: "mode must be 'wake' or 'spawn'" });
    // Mirror create's TYPE guard, not just the floor: a non-numeric intervalMs (e.g. a string) would
    // otherwise slip through `"abc" < MIN_POLL_INTERVAL_MS` (a NaN comparison → false) and get stored —
    // the tick's `new Date(now.getTime() + job.intervalMs).toISOString()` then throws on the CLAIM line,
    // which sits BEFORE the per-job try/catch, aborting the whole tick and starving every job ordered
    // after this one, every tick (the bad job never advances past this claim, so it re-throws forever).
    if (b.intervalMs !== undefined && (typeof b.intervalMs !== "number" || b.intervalMs < MIN_POLL_INTERVAL_MS)) {
      return reply.code(400).send({ error: `intervalMs must be a number >= ${MIN_POLL_INTERVAL_MS}` });
    }
    if (b.path !== undefined && !b.path.startsWith("/")) return reply.code(400).send({ error: "path must start with '/'" });
    // Re-validate the EFFECTIVE (post-patch) mode↔target pairing — a PATCH that changes mode, or that
    // changes sessionId/agentId, or that changes neither, must ALL land on a consistent, existing target;
    // never just the create path (see validatePollTarget's doc for why that asymmetry is a real bug).
    const effectiveMode: PollJob["mode"] = isPollMode(b.mode) ? b.mode : existing.mode;
    const effectiveSessionId = b.sessionId !== undefined ? b.sessionId : existing.sessionId;
    const effectiveAgentId = b.agentId !== undefined ? b.agentId : existing.agentId;
    const target = validatePollTarget(effectiveMode, effectiveSessionId, effectiveAgentId);
    if (!target.ok) return reply.code(target.status).send({ error: target.error });
    deps.db.updatePollJob(id, {
      path: b.path, method: b.method, intervalMs: b.intervalMs, itemsPath: b.itemsPath, idPath: b.idPath,
      mode: effectiveMode, sessionId: target.sessionId, agentId: target.agentId, enabled: b.enabled,
    });
    return deps.db.getPollJob(id);
  });
  app.delete("/api/poll-jobs/:id", async (req) => {
    deps.db.deletePollJob((req.params as { id: string }).id);
    return { ok: true };
  });

  // --- Hook relay target (loopback only) ---
  app.post("/internal/hook", async (req, reply) => {
    if (!LOOPBACK.has(req.ip)) return reply.code(403).send("forbidden");
    const body = req.body as { sessionId?: string; hook?: Record<string, unknown> };
    if (body?.sessionId && body.hook) deps.pty.deliverHook(body.sessionId, body.hook);
    return reply.send({ ok: true });
  });

  // --- Deja capture context target (loopback only; opt-in, card b3bd4841) — the daemon-side
  // origin_prompt + project resolution the deja-capture.mjs PostToolUse relay calls (behind its
  // injectable `resolveOriginContext(sessionId, port, fetchImpl)` seam). Trust posture mirrors
  // /internal/hook EXACTLY: loopback-gated, NOT an agent MCP tool, unreachable by any agent session.
  // Resolves sessionId -> the worker session's taskId -> the persisted task's title+body as the
  // origin_prompt (v1, Deja-mgr confirmed), plus the project name. 404s (never throws) on anything
  // unresolvable so the relay's best-effort caller degrades to a null context — never blocks the
  // write either way. PENDING ENRICHMENT (card b3bd4841, flagged for Lead scoping): the Deja mgr
  // wants origin_prompt to APPEND the triggering UserPromptSubmit turn when present (to differentiate
  // sibling A/B/C variants from one task) — but that turn is NOT persisted anywhere today (PtyHost.
  // deliverHook's UserPromptSubmit case only flips firstTurnStarted/busy; it never stores the prompt
  // text). Title+body is the durable v1 base either way; enrichment is a daemon-side-only addition to
  // THIS handler once persistence lands — the relay's `resolveOriginContext` needs no change.
  app.get("/internal/deja-context/:sessionId", async (req, reply) => {
    if (!LOOPBACK.has(req.ip)) return reply.code(403).send("forbidden");
    const { sessionId } = req.params as { sessionId: string };
    const session = deps.db.getSession(sessionId);
    if (!session?.taskId) return reply.code(404).send({ error: "no task associated with this session" });
    const task = deps.db.getTask(session.taskId);
    if (!task) return reply.code(404).send({ error: "task not found" });
    const project = deps.db.getProject(session.projectId);
    if (!project) return reply.code(404).send({ error: "project not found" });
    return reply.send({ originPrompt: `${task.title}\n\n${task.body}`, project: project.name });
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

  // --- Self-update control hook (Epic 2c-2, UI half) — the "Update & restart" button's target. Trust
  // posture mirrors /internal/shutdown EXACTLY: loopback-gated (the explicit !LOOPBACK → 403), NOT an
  // agent MCP tool, unreachable by any agent session (same boundary as gateCommand / the vault+git
  // writers). PACKAGED-ONLY (load-bearing): the npm reinstall is valid only for an npm-global `loomctl`
  // install — npm-installing over a checkout would be wrong — so a from-source daemon REFUSES with 409 and
  // a clear message (and its banner never shows anyway: GET /api/update-status reports packaged:false). On
  // a packaged install we ack 202 and defer the spawn one tick so the response flushes first; the detached
  // `loom update` (E2c-1) then runs stop→install→start. (A packaged end-user daemon runs NO supervisor, so
  // the exit-75 restart sentinel never applies here — the stop→install→start cycle is the restart path.) ---
  app.post("/internal/update", async (req, reply) => {
    if (!LOOPBACK.has(req.ip)) return reply.code(403).send("forbidden");
    if (!isPackagedInstall()) {
      return reply.code(409).send({ error: "update is only available for a packaged (npm-installed) Loom; this is a from-source daemon — update it with git." });
    }
    setTimeout(() => deps.beginSelfUpdate?.(), 50);
    return reply.code(202).send({ ok: true, updating: true });
  });

  // --- Test-only data seeding (card 32fd6f4c, extended by card 0954ed9c for the Companion Manage e2e
  // spec, by card d01311b6 for the unified terminal / sessions e2e spec — the `liveSessions` + `wakes`
  // kinds seed a live-but-NO-PTY session row + a pending wake so the unified <TerminalCard> chrome + the
  // SessionWakes sub-panel render with no real claude — and by card a53e6bc9, which adds `ptyGeometry`/
  // `ptyBytes` to `liveSessions[]` so a WS attach can ALSO replay a pinned geometry + canned bytes via
  // `deps.pty.seedCanned` (no real spawn, no in-browser monkeypatching) — closes the e2e seeding gap for
  // write paths an isolated e2e spec cannot otherwise reach:
  // `session_usage_samples` (written ONLY by the internal usage sampler), `runs` (filled ONLY by the
  // real-spawn-triggering POST /api/runs above, forbidden in the e2e fixture), and now a companion's
  // config/session/memory/reminders (writable in prod ONLY via `/api/companion/provision` — spawns a real
  // assistant session — or `/api/companion/config` — calls `reconcile()` and ARMS the runtime — both
  // forbidden in the e2e fixture's no-spawn-guard world). Gated on BOTH `inTestMode()` (LOOM_TEST=1,
  // which the e2e fixture already sets) AND loopback, so this NEVER mounts against — and is unreachable
  // even by IP against — a real daemon; zero prod surface, same posture as the other /internal/* routes
  // with an extra fail-closed layer. Inserts rows directly via deps.db (insertUsageSample/insertRun/
  // insertSession/upsertCompanionConfig/insertCompanionReminder) + the memory FILE store
  // (authorCompanionMemory), bypassing SessionService.startRun/PTY and companion reconcile entirely — no
  // agent ever spawns, no runtime ever arms. THE pattern for seeding daemon-only data from an e2e spec
  // (see Projects/Loom/Design/E2E Test Suite Design.md). ---
  if (inTestMode()) {
    app.post("/internal/test/seed", async (req, reply) => {
      if (!LOOPBACK.has(req.ip)) return reply.code(403).send("forbidden");
      const b = (req.body ?? {}) as {
        usageSamples?: Partial<UsageSample>[];
        runs?: Partial<AgentRun>[];
        // A plain, live-but-NO-PTY session row (terminal-unification stage 6, card d01311b6): boot-reconcile
        // only resumes live sessions at boot on the EMPTY DB, so a row inserted POST-boot is never
        // reconciled — no real claude spawns. It renders as `live` in the session list + the unified
        // <TerminalCard> chrome mounts; the /ws/term attach is a genuine no-op (pty.subscribe over a
        // non-existent live entry). `role:"plain"` (or null) is a role-less standalone session; any
        // SessionRole (manager/worker/setup/…) is stored verbatim so the fleet grouping + role-scoped
        // tabs behave. Assert on the CHROME/metadata, never a live pty stream.
        liveSessions?: {
          id?: string; projectId: string; agentId: string;
          role?: SessionRole | "plain" | null;
          parentSessionId?: string; taskId?: string; title?: string;
          busy?: boolean; branch?: string; model?: string; processState?: ProcessState;
          // (card a53e6bc9) Pinned terminal geometry + canned bytes to REPLAY on `/ws/term` attach — the
          // faithful-render gap the plain row above can't close (its WS attach is a genuine no-op). Either
          // key alone is enough to register a `deps.pty.seedCanned` entry keyed to this session's id;
          // omitted geometry falls back to the project's OWN resolved pty config (same default a real
          // spawn would use), and omitted bytes just replay the pinned geometry over a blank screen.
          ptyGeometry?: { cols: number; rows: number };
          ptyBytes?: string;
        }[];
        // A pending scheduled wake for a session — the ONLY way an e2e spec can make the SessionWakes
        // sub-panel render (it draws nothing when empty). DB-backed (insertWake), so it round-trips
        // through listWakesForSession / GET /api/sessions/:id/wakes with no live pty.
        wakes?: { sessionId: string; wakeAt?: string; note?: string }[];
        // CLEANUP: archive (leave the live rail) seeded live sessions once a spec is done with them — the
        // e2e worker daemon is SHARED across spec files, so a lingering `live` row would pollute a later
        // spec's GLOBAL "no live sessions" empty-state (e.g. the Usage page's Live-occupancy plane). Sets
        // archived_at (db.archiveSession); an unknown id is a harmless no-op.
        archiveSessions?: string[];
        companionSessions?: { id?: string; projectId: string; agentId: string; title?: string }[];
        companionConfigs?: {
          sessionId: string; enabled?: boolean; name?: string; botToken?: string; channel?: string;
          allowedChatId?: string; chatScope?: "dm" | "group";
          heartbeatIntervalMinutes?: number; heartbeatPrompt?: string | null;
        }[];
        companionMemories?: { sessionId: string; name: string; content: string }[];
        companionReminders?: { sessionId: string; cron?: string; prompt?: string; label?: string | null; enabled?: boolean }[];
        // Companion chat MESSAGES + conversation boundaries (conversation-history browser e2e, card 59e8e0c9).
        // The ONLY way an e2e spec can seed browsable conversation history: each message is inserted via the
        // real `insertCompanionMessage` (auto-tagged with the session's current open conversation), and each
        // `companionNewConversation` session id runs `startNewCompanionConversation` (archive the open
        // conversation, open the next) — the same archive path a live "/new" takes. Arrays process as whole
        // blocks in a single call, so to interleave (conversation 1 messages → archive → conversation 2
        // messages) a caller makes SEQUENTIAL seed calls (see the e2e fixture's seedCompanionConversations).
        companionMessages?: { sessionId: string; channel?: string; chatId?: string; author: "user" | "companion"; text: string; viaVoice?: boolean; createdAt?: string }[];
        companionNewConversation?: string[];
        // A direct orchestration_events audit row (card 12204d22: the Overview attention merge-card e2e).
        // The ONLY way an e2e spec can drive a `MERGE REQUEST` attention item — useAttention derives it from
        // a LIVE manager's `merge_request` event whose worker is live (lib/attention.ts), which the Overview
        // Attention section now renders as a rich Review-queue card. Inserted via deps.db.appendEvent (the
        // same writer the orchestration MCP uses); NEVER runs a real review/merge. `ts` defaults to now.
        orchestrationEvents?: {
          managerSessionId: string; kind: OrchestrationEventKind;
          workerSessionId?: string | null; taskId?: string | null; detail?: Record<string, unknown>;
        }[];
      };
      const usageSampleIds: string[] = [];
      for (const s of b.usageSamples ?? []) {
        if (typeof s.projectId !== "string" || typeof s.sessionId !== "string") {
          return reply.code(400).send({ error: "usageSamples[].projectId and sessionId are required strings" });
        }
        const id = randomUUID();
        deps.db.insertUsageSample({
          id, sessionId: s.sessionId, projectId: s.projectId,
          agentId: s.agentId ?? null, model: s.model ?? null,
          ts: s.ts ?? new Date().toISOString(),
          inputTokens: s.inputTokens ?? 0, outputTokens: s.outputTokens ?? 0,
          cacheCreationTokens: s.cacheCreationTokens ?? 0, cacheReadTokens: s.cacheReadTokens ?? 0,
          costUsd: s.costUsd ?? 0,
        });
        usageSampleIds.push(id);
      }
      const runIds: string[] = [];
      for (const r of b.runs ?? []) {
        if (typeof r.projectId !== "string" || typeof r.agentId !== "string") {
          return reply.code(400).send({ error: "runs[].projectId and agentId are required strings" });
        }
        const id = randomUUID();
        const createdAt = r.createdAt ?? new Date().toISOString();
        deps.db.insertRun({
          id, projectId: r.projectId, agentId: r.agentId, sessionId: r.sessionId ?? null,
          keyId: r.keyId ?? null, status: (r.status as RunStatus) ?? "completed",
          input: r.input ?? null, schema: r.schema ?? null, result: r.result ?? null,
          usage: r.usage ?? null, transcriptRef: r.transcriptRef ?? null, error: r.error ?? null,
          webhookUrl: r.webhookUrl ?? null, idempotencyKey: r.idempotencyKey ?? null,
          createdAt, startedAt: r.startedAt ?? createdAt, endedAt: r.endedAt ?? createdAt,
        });
        runIds.push(id);
      }
      // Companion session: a plain, NOT-LIVE (`exited`/`dead`) row on the assistant role — the minimal
      // shape resolveCompanionAgent (the Manage-tab reads) needs: a session whose agentId resolves to a
      // real agent. cwd defaults to the owning project's repoPath (mirrors a real spawn's cwd).
      const companionSessionIds: string[] = [];
      for (const s of b.companionSessions ?? []) {
        if (typeof s.projectId !== "string" || typeof s.agentId !== "string") {
          return reply.code(400).send({ error: "companionSessions[].projectId and agentId are required strings" });
        }
        const project = deps.db.getProject(s.projectId);
        if (!project) return reply.code(400).send({ error: `companionSessions[]: no project ${s.projectId}` });
        const id = typeof s.id === "string" && s.id ? s.id : randomUUID();
        const now = new Date().toISOString();
        const row: Session = {
          id, projectId: s.projectId, agentId: s.agentId, engineSessionId: null,
          title: s.title ?? null, cwd: project.repoPath, processState: "exited", resumability: "dead",
          busy: false, createdAt: now, lastActivity: now, lastError: null, role: "assistant",
        };
        deps.db.insertSession(row);
        companionSessionIds.push(id);
      }
      // Companion config row: same upsert the real (human-only) config writer uses, but skipping the
      // `deps.companion?.reconcile()` call that arms the live runtime. An optional `botToken` is encrypted
      // exactly like the real write path so the masked read-back (`tokenConfigured`/`tokenLast4`) behaves
      // identically to a production companion.
      const companionConfigSessionIds: string[] = [];
      for (const c of b.companionConfigs ?? []) {
        if (typeof c.sessionId !== "string") {
          return reply.code(400).send({ error: "companionConfigs[].sessionId is required" });
        }
        deps.db.upsertCompanionConfig({
          sessionId: c.sessionId,
          botTokenBlob: typeof c.botToken === "string" && c.botToken ? encryptSecret(c.botToken) : "",
          channel: c.channel ?? IN_APP_CHANNEL,
          allowedChatId: c.allowedChatId ?? "",
          chatScope: c.chatScope ?? "dm",
          heartbeatIntervalMinutes: c.heartbeatIntervalMinutes ?? 0,
          heartbeatPrompt: c.heartbeatPrompt ?? null,
          enabled: c.enabled ?? true,
          name: c.name ?? "",
        });
        companionConfigSessionIds.push(c.sessionId);
      }
      // Companion memory: authored straight into the companion's OWN MEMORY.md file store (there is no
      // DB table — companion-memory-store.ts is filesystem-backed), the same writer the companion's own
      // memory_author MCP tool calls.
      const companionMemoryNames: string[] = [];
      for (const m of b.companionMemories ?? []) {
        if (typeof m.sessionId !== "string" || typeof m.name !== "string" || typeof m.content !== "string") {
          return reply.code(400).send({ error: "companionMemories[].sessionId, name, and content are required strings" });
        }
        const r = authorCompanionMemory(m.sessionId, m.name, m.content);
        if (!r.ok) return reply.code(400).send({ error: r.error });
        companionMemoryNames.push(m.name);
      }
      // Companion reminders: a direct companion_reminders row (the real writer is the companion's own
      // reminder_* MCP tool — never REST). `route` is left null (no live binding to derive one from);
      // the Manage → Reminders view never reads route, only cron/prompt/label/enabled/nextFireAt.
      const companionReminderIds: string[] = [];
      for (const rem of b.companionReminders ?? []) {
        if (typeof rem.sessionId !== "string") {
          return reply.code(400).send({ error: "companionReminders[].sessionId is required" });
        }
        const id = randomUUID();
        deps.db.insertCompanionReminder({
          id, sessionId: rem.sessionId, cron: rem.cron ?? "0 9 * * *", prompt: rem.prompt ?? "Daily check-in — anything worth surfacing?",
          label: rem.label ?? null, route: null, enabled: rem.enabled ?? true, createdAt: new Date().toISOString(),
        });
        companionReminderIds.push(id);
      }
      // Companion chat messages: a direct `insertCompanionMessage` per row (auto-tagged with the session's
      // current open conversation). `chatId` defaults to the sessionId (the in-app loopback self-address).
      const companionMessageIds: string[] = [];
      for (const m of b.companionMessages ?? []) {
        if (typeof m.sessionId !== "string" || (m.author !== "user" && m.author !== "companion") || typeof m.text !== "string") {
          return reply.code(400).send({ error: "companionMessages[].sessionId, author ('user'|'companion'), and text are required" });
        }
        const id = randomUUID();
        deps.db.insertCompanionMessage({
          id, sessionId: m.sessionId, channel: m.channel ?? IN_APP_CHANNEL, chatId: m.chatId ?? m.sessionId,
          author: m.author, text: m.text, createdAt: m.createdAt ?? new Date().toISOString(), viaVoice: m.viaVoice ?? false,
        });
        companionMessageIds.push(id);
      }
      // Companion conversation boundaries: archive the open conversation + open the next (the "/new" path).
      for (const sid of b.companionNewConversation ?? []) {
        if (typeof sid !== "string") return reply.code(400).send({ error: "companionNewConversation[] must be session id strings" });
        deps.db.startNewCompanionConversation(sid);
      }
      // Live-but-no-PTY session rows (stage 6): inserted directly via deps.db.insertSession — NEVER
      // SessionService.startRun (which spawns a real claude). processState defaults to "live" so it
      // surfaces on the live rail (listAllSessions) + the ProjectTerminals/Terminals live filters;
      // resumability "resumable" mirrors a real live row. `role:"plain"` collapses to NULL (a role-less
      // standalone session).
      const liveSessionIds: string[] = [];
      for (const s of b.liveSessions ?? []) {
        if (typeof s.projectId !== "string" || typeof s.agentId !== "string") {
          return reply.code(400).send({ error: "liveSessions[].projectId and agentId are required strings" });
        }
        const project = deps.db.getProject(s.projectId);
        if (!project) return reply.code(400).send({ error: `liveSessions[]: no project ${s.projectId}` });
        const id = typeof s.id === "string" && s.id ? s.id : randomUUID();
        const now = new Date().toISOString();
        const row: Session = {
          id, projectId: s.projectId, agentId: s.agentId, engineSessionId: null,
          title: s.title ?? null, cwd: project.repoPath,
          processState: (s.processState as ProcessState | undefined) ?? "live",
          resumability: "resumable", busy: s.busy ?? false,
          createdAt: now, lastActivity: now, lastError: null,
          role: s.role && s.role !== "plain" ? (s.role as SessionRole) : null,
          parentSessionId: s.parentSessionId ?? null,
          taskId: s.taskId ?? null,
          branch: s.branch ?? null,
          model: s.model ?? null,
        };
        deps.db.insertSession(row);
        liveSessionIds.push(id);
        // (card a53e6bc9) Register a canned no-process pty entry ONLY when the caller asked for faithful
        // replay — a plain chrome-only seed (d01311b6's original shape) stays byte-identical (no pty
        // entry, WS attach still a no-op). Geometry falls back to this project's resolved default so a
        // spec that only cares about bytes doesn't have to know the project's config.
        if (s.ptyGeometry || typeof s.ptyBytes === "string") {
          deps.pty.seedCanned({
            id, cwd: project.repoPath,
            geometry: s.ptyGeometry ?? resolveConfig(project.config).pty,
            bytes: Buffer.from(s.ptyBytes ?? "", "utf8"),
          });
        }
      }
      // Pending wakes — a direct wakes row so the SessionWakes sub-panel has something to render. `wakeAt`
      // defaults ~1h out (a future, uncancelled wake); `route` null (no live companion turn to derive one).
      const wakeIds: string[] = [];
      for (const w of b.wakes ?? []) {
        if (typeof w.sessionId !== "string") {
          return reply.code(400).send({ error: "wakes[].sessionId is required" });
        }
        const id = randomUUID();
        const wake: Wake = {
          id, sessionId: w.sessionId,
          wakeAt: w.wakeAt ?? new Date(Date.now() + 3_600_000).toISOString(),
          note: w.note ?? "seeded wake — e2e", createdAt: new Date().toISOString(),
        };
        deps.db.insertWake(wake);
        wakeIds.push(id);
      }
      // Cleanup: archive the named sessions (idempotent; a missing row is a no-op). Also drop any
      // `seedCanned` pty entry (card a53e6bc9) — the e2e worker daemon is SHARED across spec files, so a
      // lingering canned entry would otherwise outlive its spec; a session with none is a harmless no-op.
      const archivedSessionIds: string[] = [];
      for (const sid of b.archiveSessions ?? []) {
        if (typeof sid !== "string") continue;
        deps.db.archiveSession(sid);
        deps.pty.dropCanned(sid);
        archivedSessionIds.push(sid);
      }
      // Orchestration audit events — appended straight through deps.db.appendEvent (no review/merge runs).
      // `ts` defaults to now; the attention derivation only needs the newest merge_request per worker.
      const orchestrationEventIds: string[] = [];
      for (const e of b.orchestrationEvents ?? []) {
        if (typeof e.managerSessionId !== "string" || typeof e.kind !== "string") {
          return reply.code(400).send({ error: "orchestrationEvents[].managerSessionId and kind are required strings" });
        }
        const id = randomUUID();
        deps.db.appendEvent({
          id, ts: new Date().toISOString(),
          managerSessionId: e.managerSessionId, workerSessionId: e.workerSessionId ?? null,
          taskId: e.taskId ?? null, kind: e.kind, detail: e.detail,
        });
        orchestrationEventIds.push(id);
      }
      return reply.code(201).send({
        ok: true, usageSampleIds, runIds,
        companionSessionIds, companionConfigSessionIds, companionMemoryNames, companionReminderIds,
        companionMessageIds,
        liveSessionIds, wakeIds, archivedSessionIds, orchestrationEventIds,
      });
    });
  }

  // --- REST: read ---
  app.get("/api/projects", async () => deps.db.listProjects());

  // --- Platform home discovery (Platform Manager P6): the reserved "Loom Platform" project + its
  // agents (the Platform Lead + Auditor), surfaced to the dedicated Platform UI section. The reserved
  // project is HIDDEN from the ordinary picker (GET /api/projects excludes reserved), so this READ-ONLY
  // endpoint is the one way the web discovers it. NO write/elevated capability lives here — the human
  // spawn/stop/schedule controls reuse the EXISTING agent-session, stop, and schedule REST routes.
  // 404 only if no reserved home exists (impossible after boot-seed). ---
  app.get("/api/platform/home", async (_req, reply) => {
    // NAME-SCOPED: resolve the Platform home by PLATFORM_PROJECT_NAME, NOT a bare `.find(reserved)`. A
    // second reserved home (the ungated "Platform" setup home) now coexists, so "the one reserved project"
    // is ambiguous and could return the setup home instead of Loom Platform (the live regression this
    // fixes). The setup home has its own discovery route below (GET /api/setup/home).
    const project = deps.db.getReservedProjectByName(PLATFORM_PROJECT_NAME);
    if (!project) return reply.code(404).send({ error: "no reserved Loom Platform project" });
    const agents = deps.db.listAgents(project.id);
    // LIVE-SESSION INFO: surface each platform agent's currently-LIVE sessions as a per-agent LIST, so the
    // UI can show how many Leads/Auditors are live and offer Resume/Attach. Multiple live Leads may coexist
    // (Spawn is create-only), so this is an informational roll-up, NOT a duplicate-Lead guard. Sourced from
    // db.liveSessions — the canonical live-over-recency query — so a recently-STOPPED session can NEVER mask
    // an idle-but-LIVE one. Each entry is a light summary (no transcript/cwd/branch); `role` distinguishes
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

  // --- Setup home discovery (Setup Assistant E1-7): the reserved "Platform" setup project + its Setup
  // Assistant agent(s), surfaced to the dedicated Setup page AND the project picker (this home is hidden
  // from GET /api/projects, so this READ-ONLY route is how the web discovers it). MIRRORS /api/platform/home
  // but NAME-SCOPED to the SETUP home (getReservedProjectByName(SETUP_PROJECT_NAME)) — the setup home must
  // NEVER be returned by a Platform-home lookup, nor vice-versa (distinct names: "Platform" vs "Loom
  // Platform"). Unlike the platform home this is UNGATED (the setup home seeds for every loomctl user, no
  // LOOM_DEV). READ-ONLY: the human attach/stop controls reuse the EXISTING agent-session + stop REST
  // routes; the web fetches this to find + attach the Setup Assistant session (liveSessions lets it reuse an
  // already-live one instead of minting a duplicate). 404 only if no setup home exists (impossible after
  // boot-seed). ---
  app.get("/api/setup/home", async (_req, reply) => {
    const project = deps.db.getReservedProjectByName(SETUP_PROJECT_NAME);
    if (!project) return reply.code(404).send({ error: "no reserved setup home" });
    const agents = deps.db.listAgents(project.id);
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
  // Restore a bundled skill to its shipped version (discards UI edits + re-syncs the base snapshot, so
  // mine=base=shipped) — the explicit destructive discard. 404 if the skill isn't bundled (nothing to reset to).
  app.post("/api/skills/:name/reset", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!isValidSkillName(name)) return reply.code(400).send({ error: "invalid skill name" });
    if (!resetSkillToBundled(name)) return reply.code(404).send({ error: "no bundled version for this skill" });
    return readSkill(name);
  });
  // "What shipped changed" since the user's last sync: base + current shipped asset, for the web to render
  // the incoming base→shipped diff next to "update available". 404 if not a bundled skill.
  app.get("/api/skills/:name/update-diff", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!isValidSkillName(name)) return reply.code(400).send({ error: "invalid skill name" });
    const d = skillUpdateDiff(name);
    if (!d) return reply.code(404).send({ error: "no bundled version for this skill" });
    return d;
  });
  // Preview the non-destructive 3-way adopt merge (base, mine, shipped). Only meaningful when an update is
  // available (409 otherwise). { clean:true, merged } for a one-click apply; { clean:false, merged, conflicts:[…] }
  // when the shipped delta overlaps the user's edits (conflicts for a per-hunk resolver; merged carries
  // git-style conflict markers for a whole-file side-by-side editor).
  app.get("/api/skills/:name/merge-preview", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!isValidSkillName(name)) return reply.code(400).send({ error: "invalid skill name" });
    if (!skillUpdateAvailable(name)) return reply.code(409).send({ error: "no update available" });
    const m = previewSkillMerge(name);
    if (!m) return reply.code(404).send({ error: "no bundled version for this skill" });
    return m;
  });
  // Adopt the shipped update NON-DESTRUCTIVELY: body { content } is the resolved SKILL.md (the clean
  // merged content, or the user-resolved content for a conflicted merge); an EMPTY/absent content adopts
  // the clean auto-merge (refused 409 if the merge actually conflicts — the resolver must supply content).
  // Writes mine, advances base=shipped. Guarded to updateAvailable; NEVER auto-applied.
  app.post("/api/skills/:name/adopt", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!isValidSkillName(name)) return reply.code(400).send({ error: "invalid skill name" });
    if (!skillUpdateAvailable(name)) return reply.code(409).send({ error: "no update available" });
    const b = (req.body ?? {}) as { content?: string };
    let content = b.content;
    if (typeof content !== "string" || content.length === 0) {
      const m = previewSkillMerge(name);
      if (!m) return reply.code(404).send({ error: "no bundled version for this skill" });
      if (!m.clean) return reply.code(409).send({ error: "merge has conflicts; resolve and resubmit content" });
      content = m.merged;
    }
    const updated = adoptSkillUpdate(name, content);
    if (!updated) return reply.code(404).send({ error: "no bundled version for this skill" });
    return updated;
  });
  // Inverse of reset: publish the store's edited SKILL.md back into the repo's bundled asset so the edit
  // becomes committable (HUMAN commits — this never commits). Restricted to existing bundled skills.
  // Trust-boundary write like the vault/git writers — HUMAN-only REST, NO agent MCP tool exposes it.
  // EDITION-GATED (fail-closed): the asset dir is the Loom git repo only in dev/self-host; for an end-user
  // npm install it's inside node_modules (wiped on update), so publish is meaningless there → 403 when not
  // isLoomDev(). Defense-in-depth: the web edition also hides the button.
  app.post("/api/skills/:name/publish", async (req, reply) => {
    const { name } = req.params as { name: string };
    if (!isValidSkillName(name)) return reply.code(400).send({ error: "invalid skill name" });
    if (!isLoomDev()) return reply.code(403).send({ error: "publish to repo is a dev/self-host-only feature" });
    if (!publishSkillToBundled(name)) return reply.code(404).send({ error: "no bundled version for this skill" });
    return { ok: true };
  });

  // --- Profiles (platform-level rig: role + allow/skills/model/icon + a UI-only description; the
  // injected prompt always comes from the agent). HUMAN-managed
  // ONLY (REST + later web UI) — profiles confer role + permission allowlists (= privilege), so they
  // are deliberately kept OFF the agent-writable MCP surface. Writes are schema-validated (strict,
  // typo-guarded) by validateProfile, mirroring the project-config validator. ---
  // Each profile carries computed customization state (bundled + customized/updateAvailable for
  // bundled-by-name rows; never persisted) — the profiles analog of listSkills's SkillSummary state.
  app.get("/api/profiles", async () =>
    deps.db.listProfiles().map((p) => ({ ...p, ...profileCustomizationState(deps.db, p.id) })));
  app.get("/api/profiles/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const p = deps.db.getProfile(id);
    if (!p) return reply.code(404).send({ error: "profile not found" });
    return { ...p, ...profileCustomizationState(deps.db, id) };
  });
  app.post("/api/profiles", async (req, reply) => {
    const v = validateProfile(req.body);
    if (!v.ok) return reply.code(400).send({ error: `invalid profile: ${v.error}` });
    const profile = { id: randomUUID(), ...v.value };
    deps.db.insertProfile(profile);
    // Pre-warm the shared markitdown venv NOW (off the event loop, best-effort) so the first session under
    // this profile finds the MCP already warm instead of hitting the provision-on-first-spawn cold-skip
    // window. Reuses the existing deduped async background kick — a no-op if the venv is already warm.
    if (profile.documentConversion) prewarmMarkitdown(resolvePrewarmInterpreterPath(deps.db.listAllProjects()));
    return reply.code(201).send(profile);
  });
  app.put("/api/profiles/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const existing = deps.db.getProfile(id);
    if (!existing) return reply.code(404).send({ error: "profile not found" });
    // Merge the patch over the existing profile, then validate the RESULT (so a partial patch that
    // omits required fields still passes). `id` is path-scoped, and bundled/customized/updateAvailable are
    // COMPUTED read-model fields the GET response now carries — drop all four so a verbatim round-trip PUT
    // (GET → PUT the same body) doesn't trip validateProfile's .strict() unknown-key guard.
    const { id: _drop, bundled: _b, customized: _c, updateAvailable: _u, ...patch } = (req.body ?? {}) as Record<string, unknown>;
    const { id: _eid, ...base } = existing;
    const v = validateProfile({ ...base, ...patch });
    if (!v.ok) return reply.code(400).send({ error: `invalid profile: ${v.error}` });
    deps.db.updateProfile(id, v.value);
    // Same cold-skip-window pre-warm as POST: if this save turns documentConversion ON, kick the shared
    // markitdown venv now (deduped async background job; no-op when already warm).
    if (v.value.documentConversion) prewarmMarkitdown(resolvePrewarmInterpreterPath(deps.db.listAllProjects()));
    return deps.db.getProfile(id);
  });
  // Delete is SAFE for assigned agents: a dangling profile_id resolves to the plain backstop (a
  // bundled profile re-seeds on next boot). Idempotent — mirrors the skills DELETE (no 404).
  app.delete("/api/profiles/:id", async (req) => {
    deps.db.deleteProfile((req.params as { id: string }).id);
    return { ok: true };
  });
  // Restore a bundled profile to its shipped fields (discards UI edits) — the profile analogue of the
  // skill reset. ALSO advances base=shipped (in resetProfileToBundled) so the result is pristine. 404 if
  // the id is unknown or its name isn't a bundled one (a user-created profile).
  app.post("/api/profiles/:id/reset", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!resetProfileToBundled(deps.db, id)) return reply.code(404).send({ error: "no bundled version for this profile" });
    return { ...deps.db.getProfile(id), ...profileCustomizationState(deps.db, id) };
  });
  // "What shipped changed" since the user's last sync: the base→shipped FIELD changes, for the web to render
  // the incoming update next to "update available". 404 if not a bundled-by-name profile.
  app.get("/api/profiles/:id/update-diff", async (req, reply) => {
    const d = profileUpdateDiff(deps.db, (req.params as { id: string }).id);
    if (!d) return reply.code(404).send({ error: "no bundled version for this profile" });
    return d;
  });
  // Preview the field-level 3-way adopt merge (base, mine, shipped). Only meaningful when an update is
  // available (409 otherwise). { clean:true, merged } for a one-click apply; { clean:false, merged, conflicts:[…] }
  // when fields differ all three ways (each conflict a wholesale mine-vs-shipped pick for the resolver).
  app.get("/api/profiles/:id/merge-preview", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const m = previewProfileMerge(deps.db, id);
    if (!m) return reply.code(404).send({ error: "no bundled version for this profile" });
    if (!profileUpdateAvailable(deps.db, id)) return reply.code(409).send({ error: "no update available" });
    return m;
  });
  // Adopt the shipped update NON-DESTRUCTIVELY: body { resolutions } maps each CONFLICT field to "mine" or
  // "shipped" (empty/absent adopts a clean auto-merge; refused 409 if conflicts are left unresolved).
  // Applies the merge, advances base=shipped. Guarded to updateAvailable; NEVER auto-applied. Mirrors the
  // skills adopt route (here per-field resolutions replace the skills' resolved-text content).
  app.post("/api/profiles/:id/adopt", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const body = (req.body ?? {}) as { resolutions?: Record<string, ProfileFieldResolution> };
    const r = adoptProfileUpdate(deps.db, id, body.resolutions ?? {});
    if (!r.ok) {
      if (r.reason === "not-bundled") return reply.code(404).send({ error: "no bundled version for this profile" });
      if (r.reason === "no-update") return reply.code(409).send({ error: "no update available" });
      return reply.code(409).send({ error: "merge has conflicts; resolve and resubmit", unresolved: r.unresolved });
    }
    return { ...deps.db.getProfile(id), ...profileCustomizationState(deps.db, id) };
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
  // Raw, binary-safe, content-typed vault file serving (read-only) — backs the Vault page's <img> /
  // sandboxed PDF embed / inline markdown images, which can't use the utf8 …/vault/file route (it
  // garbles binaries). SAME trust posture as …/vault/file: read-only browser, NOT a writer, NOT an
  // MCP tool. Guard is shared with readVaultFile (statVaultFile → traversal + symlink-escape check).
  // STREAMS via fs.createReadStream (never buffers); refuses files > VAULT_RAW_MAX_BYTES with 413 so
  // an enormous file can't blow up memory. nosniff so the browser honours our declared Content-Type.
  app.get("/api/projects/:id/vault/raw", async (req, reply) => {
    const p = deps.db.getProject((req.params as { id: string }).id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    const rel = (req.query as { path?: string }).path ?? "";
    if (!rel) return reply.code(400).send({ error: "path required" });
    const stat = statVaultFile(p.vaultPath, rel); // null on traversal/symlink-escape/missing/non-file
    if (!stat) return reply.code(404).send({ error: "file not found" });
    if (stat.size > VAULT_RAW_MAX_BYTES) return reply.code(413).send({ error: "file too large" });
    reply
      .header("Content-Type", vaultFileContentType(rel))
      .header("Content-Length", stat.size)
      .header("X-Content-Type-Options", "nosniff");
    return reply.send(fs.createReadStream(stat.real));
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
    const p = deps.db.getProject(id);
    if (!p) return reply.code(404).send({ error: "project not found" });
    const b = (req.body ?? {}) as { name?: unknown; vaultPath?: unknown; repoPath?: unknown };
    if (b.name !== undefined && (typeof b.name !== "string" || !b.name.trim()))
      return reply.code(400).send({ error: "name must be a non-empty string" });
    if (b.vaultPath !== undefined && (typeof b.vaultPath !== "string" || !b.vaultPath.trim()))
      return reply.code(400).send({ error: "vaultPath must be a non-empty string" });
    if (b.repoPath !== undefined && (typeof b.repoPath !== "string" || !b.repoPath.trim()))
      return reply.code(400).send({ error: "repoPath must be a non-empty string" });
    // repoPath REBIND (human-only): the SHARED guard (isGitRepo + live-worktree refusal), identical to
    // the elevated platform MCP project_update. A non-repo or a live worktree session blocks the write.
    const repoPath = b.repoPath === undefined ? undefined : (b.repoPath as string).trim();
    if (repoPath !== undefined) {
      // A repoPath REBIND repoints the project's git — more than metadata; REFUSE it on the reserved
      // Platform home (mirroring the DELETE/archive reserved refusals below). Benign metadata edits
      // (name / vaultPath) stay allowed on a reserved project.
      if (p.reserved) return reply.code(400).send({ error: "cannot rebind the repoPath of the reserved Loom Platform project" });
      const check = await checkRepoRebind(deps.db, id, repoPath);
      if (!check.ok) return reply.code(400).send({ error: check.error, ...(check.liveSessions ? { liveSessions: check.liveSessions } : {}) });
    }
    deps.db.updateProject(id, {
      name: b.name === undefined ? undefined : (b.name as string).trim(),
      vaultPath: b.vaultPath === undefined ? undefined : (b.vaultPath as string).trim(),
      repoPath,
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
    try {
      const result = deleteAgentCore(deps.db, id);
      return { ok: true, deleted: { agent: id, sessions: result.sessions } };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message === "agent not found") return reply.code(404).send({ error: message });
      return reply.code(400).send({ error: message });
    }
  });

  // Set a project's config override (the machine-writable config, schema-validated). Mirrors the
  // platform MCP's project_configure so UI/REST and the agent share one validator + store.
  app.patch("/api/projects/:id/config", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deps.db.getProject(id)) return reply.code(404).send({ error: "project not found" });
    const v = validateProjectConfigOverride((req.body as { config?: unknown })?.config ?? req.body);
    if (!v.ok) return reply.code(400).send({ error: `invalid config: ${v.error}` });
    // Route through the SAFE writer (not a blind setProjectConfig): a kanbanColumns change that drops/renames
    // a column re-keys the affected cards to the landing lane instead of ORPHANING them on a non-existent
    // column. A non-column patch stays byte-identical to the blind path. (tasks/columns.ts.)
    const wrote = setProjectConfigSafe(deps.db, id, v.value);
    if (!wrote.ok) return reply.code(400).send({ error: wrote.error });
    return deps.db.getProject(id);
  });

  // Atomic safe board-column layout change (task B) — the editor's mutation (card C), NOT the blind
  // config PATCH above. Diffs the desired layout against current, re-keys cards (renames + removals →
  // defaultLanding) and persists the columns in ONE transaction so no card is ever orphaned; HARD-rejects
  // a guard violation (no/duplicate defaultLanding+terminal, ≥1-column floor, bad rename) with a 400 +
  // reason, and returns soft warnings (dropping a non-required role lane) on success. HUMAN/REST-only.
  app.put("/api/projects/:id/columns", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (!deps.db.getProject(id)) return reply.code(404).send({ error: "project not found" });
    const v = validateColumnLayout(req.body);
    if (!v.ok) return reply.code(400).send({ error: `invalid column layout: ${v.error}` });
    const result = deps.sessions.updateBoardColumns(id, v.value.columns);
    if (!result.ok) return reply.code(400).send({ error: result.error });
    return { ok: true, columns: result.columns, warnings: result.warnings };
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
    // PATCH validation + normalization is shared with the elevated loom-platform agent_update MCP tool
    // (agents/validate.ts) so the two write paths can't diverge. allowEndpointFlags:true keeps the
    // HUMAN-only endpoint/ioSchema (Agent Runs R1) writable here — the MCP path passes false.
    const v = validateAgentPatch(req.body, (pid) => !!deps.db.getProfile(pid), { allowEndpointFlags: true });
    if (!v.ok) return reply.code(v.kind === "notFound" ? 404 : 400).send({ error: v.error });
    deps.db.updateAgent(id, v.patch);
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
  // Caps ARE enforced here (R4a): the per-key concurrency / daily-token / daily-spend caps each gate the start
  // below and return 429 (NO run starts), checked only when actually about to start a run (after idempotency
  // replay). There is still no queue backpressure — a non-capped run starts immediately. ---

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
    // Role-resolved default landing (not the hardcoded "backlog" key) so a renamed lane still receives
    // new cards; "backlog" is a defensive backstop only.
    const cols = resolveConfig(deps.db.getProject(projectId)?.config).kanbanColumns;
    const landing = columnKeyForRole(cols, "defaultLanding") ?? "backlog";
    // Validate an EXPLICIT columnKey against the resolved board; an unknown key falls back to the landing
    // lane (same as omitting it) so a bogus key can never strand the card on a phantom lane — invisible in
    // the board GET grouping and bypassing the orphan-safe re-keying setProjectConfigSafe/updateBoardColumns
    // provide. (The agent-facing MCP create/update hard-error instead; this REST path is human/UI-facing.)
    const columnKey = b.columnKey !== undefined && cols.some((c) => c.key === b.columnKey) ? b.columnKey : landing;
    const task: Task = {
      id: randomUUID(), projectId, title: b.title, body: b.body ?? "",
      columnKey, position: Date.now(),
      priority: b.priority ?? "p2", createdAt: now, updatedAt: now,
    };
    deps.db.insertTask(task);
    return reply.code(201).send(task);
  });

  // Update / move a task (kanban drag writes columnKey + position here — SAME store the
  // MCP task tools read/write, so UI and agent never diverge).
  app.post("/api/tasks/:id", async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const b = (req.body ?? {}) as Partial<Pick<Task, "title" | "body" | "columnKey" | "position" | "priority" | "held" | "deferred">>;
    if (b.priority !== undefined && !isTaskPriority(b.priority)) return reply.code(400).send({ error: "priority must be one of p0|p1|p2|p3" });
    if (b.held !== undefined && typeof b.held !== "boolean") return reply.code(400).send({ error: "held must be a boolean" });
    if (b.deferred !== undefined && typeof b.deferred !== "boolean") return reply.code(400).send({ error: "deferred must be a boolean" });
    // Validate a columnKey MOVE against the task's project board; an unknown key falls back to the landing
    // lane instead of writing blind → no card stranded on a phantom lane (invisible to the board GET).
    if (b.columnKey !== undefined) {
      const cols = resolveConfig(deps.db.getProject(deps.db.getTask(id)?.projectId ?? "")?.config).kanbanColumns;
      if (!cols.some((c) => c.key === b.columnKey)) b.columnKey = columnKeyForRole(cols, "defaultLanding") ?? "backlog";
    }
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
    // End-User Platform tier B5: spawn the de-privileged, user-facing Workspace Auditor on the curated
    // loom-user-audit MCP surface. HUMAN-REST only (like startAuditor/startSetup) — the session role is
    // locked to "workspace-auditor" via callerRole regardless of the agent's profile role. CREATE-ONLY
    // (NOT a singleton — gotcha #9): each "Review my workspace" click spawns a fresh ephemeral run.
    if (role === "workspace-auditor") return deps.sessions.startWorkspaceAuditor(id);
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
    // kind:"agent" — a human composer message is the human's own directive; it must land as its own turn.
    return reply.send(deps.pty.enqueueStdin(id, text, "human", undefined, undefined, "agent"));
  });
  // One-click graceful wrap-up (card f55bd338). Injects ONE wrap-up turn that tells the session to run
  // the /session-end skill (log progress to the board, leave it resumable) and then call the `end_me`
  // self-stop tool (card 3b015fc7) — so the human doesn't have to watch for the skill to finish and hit
  // Stop. HUMAN/REST only — NOT an agent MCP tool (same trust posture as stop/input). Role-gated to
  // NON-worker: a worker wraps up via worker_report → its manager gates/merges, so a human must never
  // end a worker out from under its manager (mirrors end_me being absent on the worker surface). This
  // route only ENQUEUES the turn; the safety check (no queued agent-inbound / no live workers) is
  // end_me's — if it refuses, the session simply stays live and the agent surfaces the reason.
  app.post("/api/sessions/:id/end", async (req, reply) => {
    const { id } = req.params as { id: string };
    const session = deps.db.getSession(id);
    if (!session) return reply.code(404).send({ error: "session not found" });
    if (session.role === "worker")
      return reply.code(403).send({ error: "cannot end a worker session; a worker wraps up via its manager" });
    const text =
      "Run the /session-end skill to wrap up (update the board task, leave it resumable), then call `end_me` to close this session.";
    // 'human' source + kind:"agent" — mirrors the composer input route exactly: a human directive that
    // must land as its own turn (not coalesced with a Loom operational nudge).
    return reply.send(deps.pty.enqueueStdin(id, text, "human", undefined, undefined, "agent"));
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
  // Archiving is AUTOMATIC now (card b37750a4): a session auto-archives when its pty exits and
  // auto-restores when it resumes — there is NO manual archive endpoint. Restore brings an archived
  // session back to the rail (view-only if dead); Delete is permanent (row(s) + snapshot). An
  // EXPECTED failure (not archived) comes back 400 with the reason so the UI shows it. ---
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

  // --- Live IN-APP companion chat: attach/detach (JSON chat + audio frames only) ---
  // The DEFAULT companion transport. DELIBERATELY SEPARATE from /ws/term above (which streams raw pty bytes):
  // a distinct route + a distinct JSON message channel, so the in-app chat multiplexes cleanly ALONGSIDE
  // terminal-attach on the SAME session with no collision (the chat WS never touches the pty stream). The
  // loopback cockpit IS the authenticated local user — NO bot token, NO pairing, NO external authz. INBOUND
  // (a message typed in the cockpit) routes through the SAME bindings-authoritative gateway
  // (companion.handleInAppInbound → gateway.handleInbound); a session with no in-app binding is rejected
  // there (this carries traffic only for an already-provisioned in-app companion — it creates nothing).
  // OUTBOUND companion replies arrive via the in-app hub (deps.inApp) pushing a { type:"chat" } frame here.
  // ADDITIVE: with no in-app companion, attach is a no-op and inbound is rejected — every session unaffected.
  //
  // VOICE (Companion Voice epic, VOICE-P4 inbound): a { type:"audio", data, mimeType } frame carries a
  // web-mic recording as base64 — untrusted bytes, decoded here (decodeInAppAudioToTempFile) into a
  // SERVER-GENERATED temp file under LOOM_HOME/tmp/companion-audio (never a client-supplied path), then
  // routed through companion.handleInAppAudioInbound exactly like typed text routes through
  // handleInAppInbound. The temp file's cleanup is normally owned by the STT pipeline's own download→
  // transcribe→cleanup discipline (via the in-app adapter's downloadAttachment, chat-gateway.ts's `finally`)
  // — but that path is only reached when the pipeline actually attempts transcription, so this route ALSO
  // best-effort-cleans-up in its own `finally` as a backstop against every other early-exit (companion-off,
  // no in-app binding, no transcriber injected) — a harmless no-op unlink if the inner path already removed it.
  app.get("/ws/companion/:sessionId", { websocket: true }, (socket: WebSocket, req) => {
    const { sessionId } = req.params as { sessionId: string };
    // Attach this web client to the in-app chat (chatId == sessionId — the loopback self-address) so the
    // adapter's send pushes companion replies here. No-op when the in-app hub isn't wired.
    const unsub = deps.inApp?.attach(sessionId, {
      deliver: (frame) => { if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame)); },
    });
    socket.on("message", (raw: Buffer) => {
      let msg: { type?: unknown; text?: unknown; data?: unknown; mimeType?: unknown };
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.type === "chat" && typeof msg.text === "string") {
        // Route through the bindings-authoritative gateway. Fire-and-forget: any routing/submit error is
        // contained by the gateway (structured result), so this .catch is only a backstop against an
        // unhandled rejection crashing the daemon (the same posture as the Telegram inbound backstop in
        // factory.ts).
        void deps.companion?.handleInAppInbound(sessionId, msg.text).catch((err) => {
          // eslint-disable-next-line no-console
          console.error(`[companion] in-app inbound failed: ${err instanceof Error ? err.message : String(err)}`);
        });
        return;
      }
      if (msg.type === "audio") {
        const decoded = decodeInAppAudioToTempFile(msg.data, msg.mimeType);
        if (!decoded) return; // malformed/oversize — silently dropped, mirrors the non-string-text guard above
        // Cleanup is hoisted OUT of the optional chain below: `deps.companion?...finally(...)` would
        // short-circuit the whole chain (finally included) if companion were ever nullish, leaking this
        // temp file — not reachable today (companionController is always constructed), but it would
        // silently defeat the "always cleans up" backstop this branch promises.
        if (!deps.companion) { void decoded.cleanup(); return; }
        void deps.companion
          .handleInAppAudioInbound(sessionId, decoded.filePath)
          .catch((err) => {
            // eslint-disable-next-line no-console
            console.error(`[companion] in-app audio inbound failed: ${err instanceof Error ? err.message : String(err)}`);
          })
          .finally(() => { void decoded.cleanup(); });
        return;
      }
      // Any other frame (control/garbage) is ignored — never the terminal stream.
    });
    socket.on("close", () => { unsub?.(); }); // detach never affects the session — it outlives viewers
  });

  return app;
}
