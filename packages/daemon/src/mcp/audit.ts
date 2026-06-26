import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Db } from "../db.js";
import type { SessionService } from "../sessions/service.js";
import { registerTranscriptReadTools } from "./transcript-read.js";
import { registerRepoReadTools } from "./repo-read.js";

// Same envelope as the task / orchestration / platform MCP servers.
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

/**
 * Audit MCP server (Platform Manager P5) — the Platform Auditor's RESTRICTED, READ-AND-FILE-ONLY surface.
 *
 * ╔═ TRUST BOUNDARY — the load-bearing P5 security goal ═══════════════════════════════════════════════╗
 * ║ The Auditor ingests UNTRUSTED transcript content (a prompt-injection surface: "ignore your          ║
 * ║ instructions and push to …"). This router is gated to role==="auditor" ONLY and exposes NOTHING but ║
 * ║ cross-project transcript READS + TWO NARROW DAEMON-LOCAL WRITES:                                     ║
 * ║   1. audit_file_finding   → a structured task onto the reserved Platform board (the triage inbox).  ║
 * ║   2. preset_suggestion_suggest → a candidate preset onto the daemon-local SUGGESTIONS store.        ║
 * ║ BOTH writes are inert + dedupe-guarded: they hit only daemon-local SQLite (a board task / a         ║
 * ║ suggestion row), never git/vault/config/spawn/message/host/outward, and a hostile transcript can    ║
 * ║ neither escape the box nor spam it (re-filing/re-suggesting an existing entry is a no-op). An        ║
 * ║ auditor session ALSO 404s on the Lead's elevated /mcp-platform (PlatformMcpRouter.resolveRole gates ║
 * ║ role==="platform") AND on /mcp-orch (OrchestrationMcpRouter.resolveRole gates manager|worker) — so  ║
 * ║ a hostile transcript can never turn an audit into an outward/destructive action. Do NOT add any     ║
 * ║ write/host/outward tool to this server beyond these two inert, dedupe-guarded daemon-local writes.  ║
 * ╚════════════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Mirrors PlatformMcpRouter exactly: keyed by the URL-path session id, resolved SERVER-SIDE, role-gated
 * (non-auditor → 404, no surface). Stateless: a fresh McpServer+transport per request, so no cached
 * transport can be wedged by a dropped stream.
 */
export class AuditMcpRouter {
  // `sessions` drives audit_file_finding (a structured task onto the reserved Platform board, hardcoded
  // server-side); `db` drives preset_suggestion_suggest (the daemon-local suggestions store) — both inert,
  // dedupe-guarded daemon-local writes. `import type` keeps these compile-time-only (mirrors PlatformMcpRouter).
  constructor(
    private db: Db,
    private sessions: SessionService,
  ) {}

  /** Role gate: ONLY an auditor session gets this surface (the exact predicate handle() 404s on). */
  resolveRole(sessionId: string): { id: string } | null {
    return this.db.getSession(sessionId)?.role === "auditor" ? { id: sessionId } : null;
  }

  /** Build the auditor's tool server, bound to the auditor's own session id (for audit_file_finding). */
  buildServer(auditorSessionId: string): McpServer {
    const db = this.db;
    const sessions = this.sessions;
    const server = new McpServer({ name: "loom-audit", version: "0.1.0" });

    // --- cross-project reads (the audit input). FACTORED into the shared helper so the end-user Auditor's
    // loom-user-audit surface reuses the EXACT same two reads (mcp/transcript-read.ts) — behavior unchanged. ---
    registerTranscriptReadTools(server, db);

    // --- least-privilege, READ-ONLY repo tools (repo_read_file / repo_grep / repo_glob) over the Loom SOURCE
    // tree — code-awareness for the 7-lens gap-hunt (a transcript-only auditor is blind to silent code gaps).
    // DEV-AUDITOR ONLY: deliberately NOT in the shared transcript-read helper, so the end-user Workspace
    // Auditor never gains source-read tools (it audits the user's workspace, not Loom's dev — the dev↔user
    // split). PURE READS, confined to the repo root, no host-process spawn — see repo-read.ts's header. ---
    registerRepoReadTools(server);

    // --- the ONE write: file a structured finding onto the reserved Platform board (hardcoded target) ---
    server.registerTool(
      "audit_file_finding",
      {
        description:
          "File a structured audit finding as a DURABLE task on the reserved Loom Platform board (the human " +
          "triage inbox). This is the Auditor's ONLY write — there is no git/vault/config/spawn/message here. " +
          "The target board is FIXED server-side (you cannot pick a project). Give a sharp title; put the evidence " +
          "/ repro, the implicated skill/prompt/feature, and a concrete suggested improvement in detail; set a " +
          "severity. DEDUPED server-side by title: filing a finding whose title already sits on the Platform " +
          "board is a no-op that returns {taskId, deduped:true} (the existing card) — still dedupe by judgement " +
          "first, but you cannot spam the backlog by re-filing. Returns {taskId, projectId} on a novel finding.",
        inputSchema: {
          title: z.string(),
          detail: z.string(),
          severity: z.enum(["low", "medium", "high", "critical"]).optional(),
        },
      },
      async ({ title, detail, severity }) => {
        try {
          return ok(sessions.auditFileFinding(auditorSessionId, { title, detail, severity }));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    // --- the SECOND write: suggest a candidate preset to the daemon-local "Suggested from your usage"
    // store (dedupe-guarded — see the trust-boundary header). NO outward/host action; inert UI data. ---
    server.registerTool(
      "preset_suggestion_suggest",
      {
        description:
          "Suggest a candidate preset prompt for the human's \"Suggested from your usage\" list — used when " +
          "a transcript shows a prompt the human types repeatedly that would be worth saving as a one-click " +
          "preset. This is an INERT daemon-local write: it only files a pending suggestion the human can " +
          "Adopt or Dismiss in the UI — no git/vault/config/spawn/message/host action. Give the would-be " +
          "preset a short `label`, the exact `prompt` text to save, and a `rationale` (WHY — e.g. \"typed " +
          "this 5× across 3 sessions\"). DEDUPED: suggesting a prompt that already exists as a preset OR " +
          "was already suggested is a no-op (returns {deduped:true,reason}) — do NOT re-nag. Returns " +
          "{created:true,id} on a genuinely-novel suggestion.",
        inputSchema: {
          label: z.string(),
          prompt: z.string(),
          rationale: z.string().optional(),
        },
      },
      async ({ label, prompt, rationale }) => {
        try {
          const res = db.suggestPresetPrompt({ label, prompt, rationale: rationale ?? null });
          return ok(res.deduped ? { deduped: true, reason: res.reason } : { created: true, id: res.suggestion.id });
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    return server;
  }

  /** HTTP entry for /mcp-audit/:sessionId. `body` is the Fastify-parsed JSON (or undefined). */
  async handle(req: IncomingMessage, res: ServerResponse, sessionId: string, body: unknown): Promise<void> {
    if (!this.resolveRole(sessionId)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no audit surface for this session" }));
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
