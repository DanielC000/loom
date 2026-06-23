import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Db } from "../db.js";
import type { SessionService } from "../sessions/service.js";
import { registerTranscriptReadTools } from "./transcript-read.js";

// Same envelope as the task / orchestration / platform / audit MCP servers.
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

/**
 * Workspace-audit MCP server (End-User Platform tier B3) — the END-USER Auditor's RESTRICTED, READ-AND-
 * SUGGEST-ONLY surface (`loom-user-audit`, served at /mcp-user-audit/:sessionId, role-gated to
 * "workspace-auditor"). The de-privileged, user-workspace twin of the dev-only AuditMcpRouter.
 *
 * ╔═ TRUST BOUNDARY — the load-bearing containment goal ════════════════════════════════════════════════╗
 * ║ The workspace Auditor ingests UNTRUSTED transcript content (a prompt-injection surface: "ignore your ║
 * ║ instructions and push to …"). This router is gated to role==="workspace-auditor" ONLY and exposes    ║
 * ║ NOTHING but cross-project transcript READS (the SAME shared list_sessions/transcript_read the dev    ║
 * ║ Auditor uses — mcp/transcript-read.ts) + TWO NARROW, INERT, DEDUPE/SERVER-RESOLVED daemon-local      ║
 * ║ writes — and is fail-closed by construction (a tool not registered here cannot be reached):          ║
 * ║   1. audit_suggest_improvement   → a board card onto the USER'S OWN reserved "Getting Started" home  ║
 * ║      `inbox` (target resolved SERVER-SIDE; the caller passes NO projectId — NEVER the dev "Loom       ║
 * ║      Platform" home, NEVER an arbitrary id). A suggestion to the user, never an auto-applied change.  ║
 * ║   2. preset_suggestion_suggest  → a candidate preset onto the daemon-local SUGGESTIONS store (the     ║
 * ║      same db.suggestPresetPrompt the dev Auditor uses — server-side dedupe).                          ║
 * ║ NEITHER write reaches git/vault/config/spawn/message/host/escalation/archive/audit_file_finding, and ║
 * ║ a hostile transcript can neither escape the box nor spam it. A workspace-auditor session ALSO 404s on ║
 * ║ /mcp-platform, /mcp-orch, /mcp-audit and /mcp-setup (each router's resolveRole gates other roles),   ║
 * ║ and NO agent/MCP path can mint a "workspace-auditor" session (caller-set only — B1 guards). Do NOT   ║
 * ║ add any write/host/outward tool to this server beyond these two inert daemon-local writes.           ║
 * ╚════════════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Mirrors AuditMcpRouter exactly: keyed by the URL-path session id, resolved SERVER-SIDE, role-gated
 * (non-workspace-auditor → 404, no surface). Stateless: a fresh McpServer+transport per request, so no
 * cached transport can be wedged by a dropped stream.
 */
export class WorkspaceAuditMcpRouter {
  // `sessions` drives audit_suggest_improvement (a board card onto the user's reserved home, resolved
  // server-side); `db` drives the shared transcript reads + preset_suggestion_suggest (the daemon-local
  // suggestions store) — both writes inert + dedupe/server-resolved. `import type` keeps these compile-time
  // -only (mirrors AuditMcpRouter).
  constructor(
    private db: Db,
    private sessions: SessionService,
  ) {}

  /** Role gate: ONLY a workspace-auditor session gets this surface (the exact predicate handle() 404s on). */
  resolveRole(sessionId: string): { id: string } | null {
    return this.db.getSession(sessionId)?.role === "workspace-auditor" ? { id: sessionId } : null;
  }

  /** Build the auditor's tool server, bound to the auditor's own session id (for audit_suggest_improvement). */
  buildServer(auditorSessionId: string): McpServer {
    const db = this.db;
    const sessions = this.sessions;
    const server = new McpServer({ name: "loom-user-audit", version: "0.1.0" });

    // --- cross-project reads (the audit input). The SHARED helper — byte-identical to the dev Auditor's
    // list_sessions/transcript_read (mcp/transcript-read.ts), reused, not copy-pasted. ---
    registerTranscriptReadTools(server, db);

    // --- WRITE A: file an improvement SUGGESTION as a board card onto the USER'S OWN reserved home (target
    // resolved SERVER-SIDE — never Loom Platform, never an arbitrary id). ---
    server.registerTool(
      "audit_suggest_improvement",
      {
        description:
          "Suggest a workspace improvement as a DURABLE board card on the user's OWN \"Getting Started\" home " +
          "(the inbox where they already triage). This is a SUGGESTION for the user — never an auto-applied " +
          "change — and one of your only two writes (there is no git/vault/config/spawn/message here). The " +
          "target board is FIXED server-side (you cannot pick a project — your suggestion always lands in the " +
          "user's own home). Give a sharp title; put the evidence/repro, the impact, the implicated " +
          "skill/prompt/feature, and a concrete suggested fix in detail; set a severity. Returns the created " +
          "task id (or {error} if the home is unexpectedly absent — that is safe, nothing else is written).",
        inputSchema: {
          title: z.string(),
          detail: z.string(),
          severity: z.enum(["low", "medium", "high", "critical"]).optional(),
        },
      },
      async ({ title, detail, severity }) => {
        try {
          return ok(sessions.workspaceAuditSuggest(auditorSessionId, { title, detail, severity }));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    // --- WRITE B: suggest a candidate preset to the daemon-local "Suggested from your usage" store — the
    // SAME db.suggestPresetPrompt the dev Auditor uses (dedupe-guarded; inert UI data, NO outward action). ---
    server.registerTool(
      "preset_suggestion_suggest",
      {
        description:
          "Suggest a candidate preset prompt for the user's \"Suggested from your usage\" list — used when " +
          "a transcript shows a prompt the user types repeatedly that would be worth saving as a one-click " +
          "preset. This is an INERT daemon-local write: it only files a pending suggestion the user can " +
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

  /** HTTP entry for /mcp-user-audit/:sessionId. `body` is the Fastify-parsed JSON (or undefined). */
  async handle(req: IncomingMessage, res: ServerResponse, sessionId: string, body: unknown): Promise<void> {
    if (!this.resolveRole(sessionId)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no user-audit surface for this session" }));
      return;
    }
    // Stateless per request (see AuditMcpRouter): no cached transport to be wedged by a dropped stream.
    const server = this.buildServer(sessionId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /** No-op: stateless transports hold no per-session state to tear down (kept for the onExit hook). */
  dispose(_sessionId: string): void {}
}
