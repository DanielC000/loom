import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { contextWindowForModel, type SessionRole } from "@loom/shared";
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

  /**
   * The caller's OWN measured context occupancy (server-derived from the URL-path session id — a
   * session can only ever read itself, so cross-session reads are impossible). Reuses the value the
   * Stop-time measurement path persists (`ctx_input_tokens`, via sessions/context.ts) — NO new
   * measurement. Returns `pct: null` + a note when not yet measured (never a fake 0%).
   */
  private myContext(sessionId: string): Record<string, unknown> {
    const s = this.db.getSession(sessionId);
    const model = s?.model ?? null;
    const contextWindow = contextWindowForModel(model);
    const ctxInputTokens = s?.ctxInputTokens ?? null;
    const measuredAt = s?.ctxUpdatedAt ?? null;
    if (ctxInputTokens == null) {
      return { ctxInputTokens: null, contextWindow, pct: null, model, measuredAt,
        note: "context not measured yet (no completed turn) — occupancy unknown" };
    }
    return {
      ctxInputTokens,
      contextWindow,
      pct: Math.round((ctxInputTokens / contextWindow) * 100),
      model,
      measuredAt,
    };
  }

  /** Register `my_context` — available to ANY role (manager + worker); read-only, no args, no gating. */
  private registerMyContext(server: McpServer, sessionId: string): void {
    server.registerTool(
      "my_context",
      {
        description:
          "Read YOUR OWN context occupancy (no args — server-derived from your session). Returns " +
          "{ctxInputTokens, contextWindow, pct, model, measuredAt}: pct is your measured context size " +
          "as a percentage of your model's window. Use it at a clean seam to self-assess — a manager to " +
          "decide whether to recycle_me, a worker to worker_report that it's getting heavy. If not yet " +
          "measured, pct is null with a note (not a fake 0).",
        inputSchema: {},
      },
      async () => ok(this.myContext(sessionId)),
    );
  }

  private buildServer(sessionId: string, role: SessionRole): McpServer {
    const db = this.db;
    const sessions = this.sessions;
    const server = new McpServer({ name: "loom-orchestration", version: "0.1.0" });

    if (role === "worker") {
      this.registerMyContext(server, sessionId);
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

    this.registerMyContext(server, sessionId);

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
        description: "Spawn a worker on a task: creates an isolated git worktree + branch, starts a worker session in it, and moves the task to in_progress. agentId is REQUIRED and must be an explicit WORKER agent (e.g. Dev/Bugfix/QA/Docs) — NEVER your own manager agent. Spawning under a manager/platform-role agent is rejected.",
        inputSchema: {
          taskId: z.string(),
          agentId: z.string(),
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

    // --- Manager self-service management surface (Task 3de74275, Option B) -------------------------
    // Additive, MANAGER-ONLY tools (registered only on this branch) so an autonomous run can provision
    // its own rigs + structure instead of stalling on a human. The boundary (Option B): managers
    // ASSIGN existing human-authored profiles and create/edit STRUCTURE, but NEVER mint capabilities —
    // profile/skill/allowlist/gateCommand CREATE/edit stay human-only. gateCommand stays rejected on
    // this agent path (project_update routes config through validateAgentProjectConfigOverride). Each
    // tool re-checks the manager role server-side in the service (defense in depth).

    server.registerTool(
      "agent_assign_profile",
      {
        description:
          "Assign an EXISTING (human-authored) profile to an agent, or clear it (profileId: null). The " +
          "profile supplies role/model/allowlist/skills/browser at the agent's next NEW session. You can " +
          "only ASSIGN a profile a human already created — you cannot create or edit one (profile authoring " +
          "is human-only). A non-existent profileId is rejected. Use this to provision a rig (e.g. assign the " +
          "human-authored 'QA Tester' browser profile) without waiting on a human.",
        inputSchema: { agentId: z.string(), profileId: z.string().nullable() },
      },
      async ({ agentId, profileId }) => {
        try {
          return ok(sessions.assignAgentProfile(managerSessionId, agentId, profileId));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "agent_update",
      {
        description:
          "Update an agent's name (title) and/or startupPrompt (the project-specific brief injected as the " +
          "first turn of its next NEW session). Structural edit only — to change the agent's rig use " +
          "agent_assign_profile. Omitted fields are left as-is.",
        inputSchema: { agentId: z.string(), name: z.string().optional(), startupPrompt: z.string().optional() },
      },
      async ({ agentId, name, startupPrompt }) => {
        try {
          return ok(sessions.updateAgentPreset(managerSessionId, agentId, { name, startupPrompt }));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "project_update",
      {
        description:
          "Update a project's structural fields (name / vaultPath) and/or its config override. config is " +
          "schema-validated on the AGENT path: orchestration.gateCommand (host-RCE) and unknown keys are " +
          "REJECTED (that capability stays human-only). repoPath is not editable here. Omitted fields are " +
          "left as-is.",
        inputSchema: {
          projectId: z.string(),
          name: z.string().optional(),
          vaultPath: z.string().optional(),
          config: z.object({}).passthrough().optional(),
        },
      },
      async ({ projectId, name, vaultPath, config }) => {
        try {
          return ok(sessions.updateProjectStructural(managerSessionId, projectId, { name, vaultPath, config }));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "project_archive",
      {
        description:
          "Soft-archive a project: it disappears from the active project list, but its rows and sessions are " +
          "retained (not deleted). Structural, reversible-by-a-human.",
        inputSchema: { projectId: z.string() },
      },
      async ({ projectId }) => {
        try {
          return ok(sessions.archiveProjectAsManager(managerSessionId, projectId));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "schedule_create",
      {
        description:
          "Create a cron schedule that autonomously boots a manager session in an agent on each tick (5-field " +
          "cron). enabled defaults to true. An invalid cron expression is rejected. Low-risk autonomous wake — " +
          "the same kind of self-scheduling agents already do via wake_me.",
        inputSchema: { agentId: z.string(), cron: z.string(), enabled: z.boolean().optional() },
      },
      async ({ agentId, cron, enabled }) => {
        try {
          return ok(sessions.createSchedule(managerSessionId, { agentId, cron, enabled }));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "schedule_update",
      {
        description:
          "Update a schedule's cron and/or enabled flag. A changed cron recomputes the next fire (rejected if " +
          "invalid); enabled toggles the Scheduler on/off for this row. Omitted fields are left as-is.",
        inputSchema: { scheduleId: z.string(), cron: z.string().optional(), enabled: z.boolean().optional() },
      },
      async ({ scheduleId, cron, enabled }) => {
        try {
          return ok(sessions.updateScheduleAsManager(managerSessionId, scheduleId, { cron, enabled }));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    // --- Manager→Platform escalation (Platform Manager P4) ----------------------------------------
    // The ONE upward channel: a project manager reports a discovered Loom bug / friction UP to the
    // Platform Lead. DURABLE by design — it files a structured TASK onto the reserved "Loom Platform"
    // project's board (the Lead's inbox), which survives the common case where no Lead session is live.
    // This is the ONLY cross-project write a manager gets, and ONLY this structured escalation: the
    // target board is HARDCODED to the reserved home server-side (the manager never names a projectId),
    // so it can never become a general cross-project task-write. Down-tree messaging stays parent-scoped
    // (worker_message); session_message (the Lead's un-scoped delivery) is the PLATFORM surface, not here.
    server.registerTool(
      "platform_escalate",
      {
        description:
          "Escalate a discovered Loom bug or friction UP to the Platform Lead. Files a DURABLE, structured " +
          "task on the reserved Loom Platform board (the Lead's inbox — it survives whether or not a Lead " +
          "session is live), capturing your origin project + this manager session, the title, the detail/" +
          "evidence, and a severity. This is the ONLY cross-project write you have, and ONLY this escalation: " +
          "the target is the Platform board, fixed server-side (you cannot pick a project). Returns the created " +
          "Platform task id. Use it for platform-level problems (a Loom bug, a confusing tool/skill, friction " +
          "that slowed your workers) — NOT for your own project's task board (use tasks_create there).",
        inputSchema: {
          title: z.string(),
          detail: z.string(),
          severity: z.enum(["low", "medium", "high", "critical"]).optional(),
        },
      },
      async ({ title, detail, severity }) => {
        try {
          return ok(sessions.platformEscalate(managerSessionId, { title, detail, severity }));
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
