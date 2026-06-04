import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { SessionRole } from "@loom/shared";
import type { Db } from "../db.js";
import type { SessionService } from "../sessions/service.js";
import { readTranscript } from "../sessions/transcript.js";

// Same envelope as the task MCP server (mcp/server.ts).
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

/**
 * Orchestration MCP server (phase-2 §A2/§A3) — a ROLE-BASED surface, keyed by the URL-path
 * session id and resolved SERVER-SIDE (the agent never names "which session"):
 *   - manager → the full coordination surface (list/status/transcript/spawn/stop/message);
 *   - worker  → ONLY worker_report (so a worker CANNOT spawn/list/stop — the depth-1 tree holds
 *               at the tool surface, not just the role gate);
 *   - plain/unknown → 404 (no surface).
 * Stateless: a fresh McpServer+transport per request (the URL-path session id supplies the role
 * binding). No cached transport, so a dropped stream can't wedge the surface mid-session.
 */
export class OrchestrationMcpRouter {
  constructor(private db: Db, private sessions: SessionService) {}

  /** Role gate: returns the session's id + orchestration role, or null (→ 404) for plain/unknown. */
  resolveRole(sessionId: string): { id: string; role: SessionRole } | null {
    const role = this.db.getSession(sessionId)?.role;
    return role === "manager" || role === "worker" ? { id: sessionId, role } : null;
  }

  private buildServer(sessionId: string, role: SessionRole): McpServer {
    const db = this.db;
    const sessions = this.sessions;
    const server = new McpServer({ name: "loom-orchestration", version: "0.1.0" });

    if (role === "worker") {
      // A worker's ENTIRE surface: report up to its manager. No spawn/list/stop.
      server.registerTool(
        "worker_report",
        {
          description: "Report your status up to your manager: moves your task (done→review, blocked→waiting) and notifies the manager. Call when done, blocked, or to checkpoint progress.",
          inputSchema: {
            status: z.enum(["done", "blocked", "progress"]),
            summary: z.string(),
            prUrl: z.string().optional(),
            needs: z.string().optional(),
          },
        },
        async ({ status, summary, prUrl, needs }) =>
          ok(sessions.workerReport(sessionId, { status, summary, prUrl, needs })),
      );
      return server;
    }

    // role === "manager": the full coordination surface.
    const managerSessionId = sessionId;

    server.registerTool(
      "worker_list",
      { description: "List the workers you (this manager) have spawned — your direct children.", inputSchema: {} },
      async () => ok(db.listWorkers(managerSessionId).map((w) => ({
        workerSessionId: w.id,
        taskId: w.taskId ?? null,
        processState: w.processState,
        busy: w.busy,
        branch: w.branch ?? null,
        ctxInputTokens: w.ctxInputTokens ?? null,
        model: w.model ?? null,
        lastActivity: w.lastActivity,
      }))),
    );

    server.registerTool(
      "worker_status",
      {
        description: "Get the full session record for one of your workers, by workerSessionId.",
        inputSchema: { workerSessionId: z.string() },
      },
      async ({ workerSessionId }) => {
        const w = db.getSession(workerSessionId);
        if (!w || w.parentSessionId !== managerSessionId) return ok({ error: "not your worker" });
        return ok(w);
      },
    );

    server.registerTool(
      "worker_transcript",
      {
        description: "Read one of your workers' transcript as clean ordered turns; optionally just the last N.",
        inputSchema: { workerSessionId: z.string(), lastN: z.number().optional() },
      },
      async ({ workerSessionId, lastN }) => {
        const w = db.getSession(workerSessionId);
        if (!w || w.parentSessionId !== managerSessionId) return ok({ error: "not your worker" });
        const turns = w.engineSessionId ? readTranscript(w.cwd, w.engineSessionId) : [];
        return ok(typeof lastN === "number" && lastN > 0 ? turns.slice(-lastN) : turns);
      },
    );

    server.registerTool(
      "worker_spawn",
      {
        description: "Spawn a worker on a task: creates an isolated git worktree + branch, starts a worker session in it, and moves the task to in_progress.",
        inputSchema: {
          taskId: z.string(),
          agentId: z.string().optional(),
          kickoffPrompt: z.string(),
        },
      },
      async ({ taskId, agentId, kickoffPrompt }) => {
        try {
          const worker = await sessions.spawnWorker(managerSessionId, { taskId, agentId, kickoffPrompt });
          return ok({ workerSessionId: worker.id, branch: worker.branch, worktreePath: worker.worktreePath });
        } catch (e) {
          // Surface a refused spawn (paused / over-cap / bad task) to the manager as data, not an
          // MCP protocol error — same envelope as the sibling lifecycle tools.
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "worker_stop",
      {
        description: "Stop one of your workers (graceful Ctrl-C by default, or hard kill). The worktree is retained.",
        inputSchema: { workerSessionId: z.string(), mode: z.enum(["graceful", "hard"]).optional() },
      },
      async ({ workerSessionId, mode }) => {
        try {
          sessions.stopWorker(managerSessionId, workerSessionId, mode ?? "graceful");
          return ok({ stopped: true });
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "worker_message",
      {
        description: "Send a message to one of your workers. Submitted as a turn if the worker is idle; queued FIFO and delivered on its next turn boundary if it's mid-turn.",
        inputSchema: { workerSessionId: z.string(), text: z.string() },
      },
      async ({ workerSessionId, text }) => {
        try {
          return ok(sessions.messageWorker(managerSessionId, workerSessionId, text));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "inbox_pull",
      {
        description:
          "Pull (return AND clear) every queued inbound message in YOUR inbox — worker reports and Loom " +
          "notifications that arrived while you were mid-turn and are waiting to be delivered. Use it when " +
          "you've ALREADY handled work proactively (e.g. you read a worker's worker_transcript and merged it): " +
          "those reports otherwise sit queued and later surface ONE-per-turn as redundant wasted turns. " +
          "Pulling consumes them in one shot so they won't re-surface; the underlying events stay recorded. " +
          "Returns {messages: string[]} (FIFO order, empty if your inbox is clear). If you DON'T pull, Loom " +
          "still delivers them the normal way — this is an optional fast-drain, not required.",
        inputSchema: {},
      },
      async () => {
        try {
          return ok(sessions.pullManagerInbox(managerSessionId));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "worker_recycle",
      {
        description: "Recycle a worker whose context has grown too large: closes it and spawns a FRESH worker in the SAME git worktree (code state kept) seeded with your handoff summary (intent kept). Same task + branch; gen+1. Read worker_transcript first and write the summary.",
        inputSchema: { workerSessionId: z.string(), handoffSummary: z.string() },
      },
      async ({ workerSessionId, handoffSummary }) => {
        try {
          const fresh = await sessions.recycleWorker(managerSessionId, workerSessionId, handoffSummary);
          return ok({ newWorkerSessionId: fresh.id, gen: fresh.gen, recycledFrom: fresh.recycledFrom });
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "worker_merge",
      {
        description: "STEP 1 of the merge gate: review a worker's branch diff (files changed + patch). No merge happens. You must review before confirming — there is no worker-side merge.",
        inputSchema: { workerSessionId: z.string() },
      },
      async ({ workerSessionId }) => {
        try {
          return ok(await sessions.reviewWorkerMerge(managerSessionId, workerSessionId));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "worker_merge_confirm",
      {
        description: "STEP 2: after reviewing, confirm the merge. Runs the build/DoD gate, and ONLY if green merges the branch --no-ff, removes the worktree, and moves the task to done. Fail-closed: a failed gate or a conflict leaves the repo untouched and the worktree retained.",
        inputSchema: { workerSessionId: z.string() },
      },
      async ({ workerSessionId }) => {
        try {
          return ok(await sessions.confirmWorkerMerge(managerSessionId, workerSessionId));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "daemon_restart",
      {
        description:
          "SELF-HOSTING ONLY (orchestrating Loom with Loom): rebuild + restart the Loom daemon so merged " +
          "daemon-`src` code goes LIVE in the running process. Use after you've merged worker branch(es) that " +
          "change the daemon and you need the new behavior actually running (e.g. to end-to-end verify it). " +
          "Loom REBUILDS FIRST: if the build fails it does NOT restart and returns the error (stays up — fix it " +
          "and retry). On a green build the daemon restarts: your pty and your live workers' ptys are dropped, " +
          "then you are AUTOMATICALLY resumed (your live workers too) with a note once it's back. Returns " +
          "{restarting:true} on success, or {restarting:false, error} if unsupervised / build failed.",
        inputSchema: { reason: z.string() },
      },
      async ({ reason }) => {
        try {
          return ok(await sessions.requestDaemonRestart(managerSessionId, reason));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "recycle_me",
      {
        description:
          "Recycle YOURSELF before your context fills up — hand off to a fresh successor manager. " +
          "Loom nudges you when you near your context limit; when you get that nudge: FIRST run /session-end " +
          "(log progress to the vault) and take stock, THEN call this with a self-contained continuationPrompt " +
          "for your successor — current goal, what's done, your in-flight workers and their tasks/status, the " +
          "next steps, and key decisions. Loom boots a fresh manager seeded with this agent's warm-up + your " +
          "continuationPrompt, re-parents your live workers onto it, and then closes you.",
        inputSchema: { continuationPrompt: z.string() },
      },
      async ({ continuationPrompt }) => {
        try {
          const fresh = await sessions.recycleManager(managerSessionId, continuationPrompt);
          return ok({ newManagerSessionId: fresh.id, gen: fresh.gen });
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "idle_report",
      {
        description:
          "Tell Loom's idle watchdog your disposition so it stops nudging you (or, later, knows to alert " +
          "the human) — call it when you end a turn with no active work. `state`: 'working' = back at it " +
          "(resumes normal watching); 'waiting' = nothing to do until something lands — optionally snooze " +
          "for `minutes` (defaults to the per-project idle snooze); 'blocked_human' = you need the human; " +
          "'done' = this agent's work is complete. Always clears your unanswered-nudge counter. Pass a short " +
          "`detail` to say why (recorded for the human).",
        inputSchema: {
          state: z.enum(["working", "waiting", "blocked_human", "done"]),
          detail: z.string().optional(),
          minutes: z.number().optional(),
        },
      },
      async ({ state, detail, minutes }) => {
        try {
          return ok(sessions.recordIdleReport(managerSessionId, state, { detail, minutes }));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    return server;
  }

  /** HTTP entry for /mcp-orch/:sessionId. `body` is the Fastify-parsed JSON (or undefined). */
  async handle(req: IncomingMessage, res: ServerResponse, sessionId: string, body: unknown): Promise<void> {
    const resolved = this.resolveRole(sessionId);
    if (!resolved) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no orchestration surface for this session" }));
      return;
    }

    // Stateless per request (see TaskMcpRouter): no cached transport to be deleted on a transient
    // onclose, so the worker_* surface can't vanish mid-session. Rebuilt each call from the role.
    const server = this.buildServer(sessionId, resolved.role);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /** No-op: stateless transports hold no per-session state to tear down (kept for the onExit hook). */
  dispose(_sessionId: string): void {}
}
