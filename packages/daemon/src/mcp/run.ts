import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Db } from "../db.js";
import type { SessionService } from "../sessions/service.js";

// Same envelope as the task / orchestration / platform / audit MCP servers.
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

/**
 * Run MCP server (Agent Runs R2) — the ephemeral run's RESTRICTED surface: ONLY `submit_result`.
 *
 * ╔═ TRUST BOUNDARY — gated to role==="run" ════════════════════════════════════════════════════════════╗
 * ║ Mirrors AuditMcpRouter exactly: keyed by the URL-path session id, resolved SERVER-SIDE, role-gated.  ║
 * ║ A non-run session 404s here (no surface); a run session ALSO gets NOTHING ELSE — buildMcpServers     ║
 * ║ mounts ONLY loom-run for role==="run" (not even loom-tasks), and a run 404s on /mcp, /mcp-orch,      ║
 * ║ /mcp-platform, /mcp-audit (their resolveRole/resolveProject gates never match a run). So the run's   ║
 * ║ entire tool world is submit_result. Do NOT add any other tool here. Stateless: a fresh              ║
 * ║ McpServer+transport per request, so a dropped stream can't wedge the surface.                       ║
 * ╚═════════════════════════════════════════════════════════════════════════════════════════════════════╝
 */
export class RunMcpRouter {
  constructor(
    private db: Db,
    private sessions: SessionService,
  ) {}

  /** Role gate: ONLY a `run` session gets this surface (the exact predicate handle() 404s on). */
  resolveRole(sessionId: string): { id: string } | null {
    return this.db.getSession(sessionId)?.role === "run" ? { id: sessionId } : null;
  }

  /** Build the run's tool server, bound to the run's own session id (→ its run row, server-side). */
  buildServer(runSessionId: string): McpServer {
    const sessions = this.sessions;
    const server = new McpServer({ name: "loom-run", version: "0.1.0" });

    server.registerTool(
      "submit_result",
      {
        description:
          "Submit your final answer for this run and END. Pass your answer as `result` — a JSON " +
          "object/value matching the schema, NOT a stringified JSON string (e.g. pass {\"answer\":42}, " +
          "not \"{\\\"answer\\\":42}\"). If this run has a JSON Schema, `result` is validated against it " +
          "server-side: on a mismatch you get a structured validation error back — CORRECT your output and " +
          "call submit_result again (this is the only way to finish). On success the run is recorded + " +
          "completed and your session is torn down — do NOT keep working after it accepts. With no schema, " +
          "any JSON/text is accepted.",
        inputSchema: { result: z.any() },
      },
      async ({ result }) => {
        try {
          return ok(sessions.submitRunResult(runSessionId, result));
        } catch (e) {
          return ok({ ok: false, error: (e as Error).message });
        }
      },
    );

    return server;
  }

  /** HTTP entry for /mcp-run/:sessionId. `body` is the Fastify-parsed JSON (or undefined). */
  async handle(req: IncomingMessage, res: ServerResponse, sessionId: string, body: unknown): Promise<void> {
    if (!this.resolveRole(sessionId)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no run surface for this session" }));
      return;
    }
    // Stateless per request (see TaskMcpRouter): no cached transport to be wedged by a dropped stream.
    const server = this.buildServer(sessionId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /** No-op: stateless transports hold no per-session state to tear down (kept for the onExit hook). */
  dispose(_sessionId: string): void {}
}
