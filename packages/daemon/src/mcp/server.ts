import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { resolveConfig } from "@loom/shared";
import type { Db } from "../db.js";
import type { WakeService } from "../orchestration/wake.js";
import {
  listProjectTasks, getProjectTask, createProjectTask, updateProjectTask, DEFAULT_TASK_SUMMARY_CAP,
  listProjectTaskRequests, getProjectTaskRequest,
} from "./tasks.js";
import { writeProjectMemory, forgetProjectMemory, listProjectMemoryEntries, readProjectMemory } from "./memory.js";
import { performAuthenticatedRequest } from "../connections/request.js";
import { writeVaultFile } from "../vault/writer.js";
import { resolveAlias } from "./arg-alias.js";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

/**
 * List-shaped response, NEWLINE-DELIMITED (one JSON object per line) instead of a single
 * `JSON.stringify(array)` blob (card dc647ae2 part A). A wide `tasks_list` window (e.g.
 * excludeDone:false + a large limit/offset) can overflow the MCP tool-result cap; when the engine
 * spills an oversized result to a temp file, a SINGLE giant JSON-array line is unpaginatable —
 * `Read` can't offset/limit-slice one line, forcing a fragile manual char-slice. NDJSON keeps that
 * spill file (or a live grep) Read/grep-pageable one row at a time regardless of size.
 */
const okLines = (rows: unknown[]) => ({ content: [{ type: "text" as const, text: rows.map((r) => JSON.stringify(r)).join("\n") }] });

/** Task priority enum, shared by the create/update/list tool schemas (rejects any other string). */
export const prioritySchema = z.enum(["p0", "p1", "p2", "p3"]);

/**
 * Project-scoped task MCP server. The session id arrives in the URL path
 * (/mcp/:sessionId); we resolve session -> project SERVER-SIDE and bind every tool to that
 * project. The agent never supplies a projectId, so cross-project access is impossible by
 * construction (§6).
 *
 * Stateless: a fresh McpServer+transport is built per request (the URL path supplies the
 * session→project binding). No per-session transport is cached, so a dropped stream can never
 * wedge the surface — every request rebuilds the identical tools from the stable mapping.
 */
export class TaskMcpRouter {
  // `fetchOverride` is a TEST-ONLY seam for `authenticated_request` (mirrors the envelope's `keyPath`
  // swappable-backend seam) — production never passes a 3rd arg, so every real spawn is unaffected.
  constructor(private db: Db, private wakes: WakeService, private fetchOverride?: typeof fetch) {}

  resolveProject(sessionId: string): string | null {
    return this.db.getSession(sessionId)?.projectId ?? null;
  }

  private buildServer(projectId: string, sessionId: string): McpServer {
    const db = this.db;
    const wakes = this.wakes;
    const fetchOverride = this.fetchOverride;
    const server = new McpServer({ name: "loom-tasks", version: "0.1.0" });
    // `session` is resolved HERE (not further down, where it used to be computed only for the
    // authenticated_request/vault_write gates) so tasks_create/tasks_update below can also condition on
    // it — SAME conditional-registration pattern as those two tools (an omitted tool never reaches
    // tools/list, not a runtime denial).
    const session = db.getSession(sessionId);

    server.registerTool(
      "tasks_list",
      {
        description:
          "List this project's board tasks. Returns NEWLINE-DELIMITED JSON — one task object per line, NOT a JSON array — so a wide read stays Read/grep-pageable even if it spills to a file. DEFAULT: a lightweight SUMMARY ({id,title,columnKey,position,priority,updatedAt,merged}) — bodies OMITTED, terminal/done cards EXCLUDED. Pass includeBody:true for full bodies, or tasks_get(id) for one card. `merged` is this card's git-derived ship state — {sha,date} of its squash-merge commit on this project's repo if one is found, else null; null means NOT PROVEN merged (never merged, landed outside the scan window, or a git read failure), not an authoritative 'never merged' — treat a predecessor's 'unbuilt'/'won't-do' claim as suspect if merged is non-null. Filters: columns:[...] (only those column keys), excludeDone:false (include done), minPriority:p0|p1|p2|p3 (only tasks at or above it; lower number = higher priority), idPrefix (only ids starting with this), titleContains (case-insensitive title substring) — prefer a scoped filter over paging a huge window. Capped at " + DEFAULT_TASK_SUMMARY_CAP + " rows by default — page with limit/offset.",
        inputSchema: {
          columns: z.array(z.string()).optional(),
          excludeDone: z.boolean().optional(),
          includeBody: z.boolean().optional(),
          minPriority: prioritySchema.optional(),
          idPrefix: z.string().optional(),
          titleContains: z.string().optional(),
          limit: z.number().int().positive().optional(),
          offset: z.number().int().nonnegative().optional(),
        },
      },
      // Backstop the read with a default cap (caller-applied, the agentView/sessionView pattern) so an
      // includeBody read on a board with hundreds of cards can't overflow the tool-result cap.
      async (args) => okLines(await listProjectTasks(db, projectId, { ...args, limit: args.limit ?? DEFAULT_TASK_SUMMARY_CAP })),
    );
    server.registerTool(
      "tasks_get",
      {
        description: "Read ONE full task (title + body) by id; project-scoped. id accepts the full id OR an unambiguous 8-char id-prefix (mirrors project_get). `taskId` is accepted as an ALIAS for `id` (matches the taskId param name every sibling task tool uses) — pass either one (if both, id wins). An optional `projectId` is tolerated but ignored — this tool is already scoped to the caller's own project. Also returns a `requests` summary ({total, answered, pending, cancelled, items:[{id,type,title,state}]}) of any Requests connected to this task (soft-linked via taskId at question_ask time) — a task you're working may already carry a prior owner decision you'd otherwise miss; read one in full via task_request_get, or list them all via task_requests_list. Also returns `merged` — this card's git-derived ship state ({sha,date} of its squash-merge commit on this project's repo, else null). null means NOT PROVEN merged, never an authoritative 'never merged' — don't trust a stale handoff claiming this card is unbuilt without checking this first.",
        inputSchema: { id: z.string().optional(), taskId: z.string().optional(), projectId: z.string().optional() },
      },
      async ({ id, taskId }) => {
        const resolvedId = id ?? taskId;
        if (!resolvedId) return ok({ error: "id (or taskId) is required" });
        return ok(await getProjectTask(db, projectId, resolvedId));
      },
    );
    server.registerTool(
      "task_requests_list",
      {
        description:
          "List every Request (from question_ask) connected to ONE task — pending + answered + consumed + " +
          "cancelled alike — as lightweight NEWLINE-DELIMITED JSON rows: {id,type,title,state,answeredAt}. " +
          "NON-CONSUMING: unlike question_pull (which drains + consumes), this is a stable, re-readable " +
          "reference you can call again later or from a different agent/turn and still see the same " +
          "requests. Use task_request_get(id) for the full body/options/recommendation + answer. taskId " +
          "accepts the full id OR an unambiguous 8-char id-prefix (mirrors tasks_get).",
        inputSchema: { taskId: z.string() },
      },
      async ({ taskId }) => {
        const rows = listProjectTaskRequests(db, projectId, taskId);
        return "error" in rows ? ok(rows) : okLines(rows);
      },
    );
    server.registerTool(
      "task_request_get",
      {
        description:
          "Read ONE Request connected to a task, IN FULL: {id,type,title,body,options,recommendation," +
          "state,taskId,createdAt,answeredAt} plus its answer by type — `chosenOption`+`note` for " +
          "\"decision\"/\"input\", `approved`+`note` for \"permission\" (all null until answered), `ack` " +
          "ONLY (never the secret) for \"credential\" (null until provided). NON-CONSUMING: unlike " +
          "question_pull, reading this never flips the request's state — re-readable across turns/agents. " +
          "`id` is the request id (from tasks_get's `requests.items`/task_requests_list). Optional `taskId` " +
          "(full id or an unambiguous 8-char id-prefix) further scopes the lookup — if given, the request " +
          "must be connected to THAT task or this errors.",
        inputSchema: { id: z.string(), taskId: z.string().optional(), projectId: z.string().optional() },
      },
      async ({ id, taskId }) => ok(getProjectTaskRequest(db, projectId, id, taskId)),
    );
    // An "assistant" (Companion) session gets NEITHER tool — its only card-write path is the separately
    // grant-checked `board_create`/`board_update` (companion/capabilities.ts, mounted on loom-orchestration),
    // which take an EXPLICIT `project` param and are checked against a real `board-reach` act-mode grant.
    // Unlike those, tasks_create/tasks_update ALWAYS write to THIS session's own project with no grant
    // check at all — for the Companion that silently meant "your own bound board", which is exactly the
    // silent-wrong-board footgun this omission closes (a Companion asked to file to a NAMED project would
    // reach for this tool and misfile to its home board instead). Every other role is unaffected — this is
    // conditional TOOL REGISTRATION (an omitted tool never reaches tools/list), the same pattern already
    // used by authenticated_request/vault_write below.
    //
    // `session?.role !== "assistant"` reads fail-open on a null session (an unknown/expired sessionId
    // would take the TRUE branch and register the tools) — that's fine because it's UNREACHABLE, not
    // merely unlikely: `buildServer` is private with exactly ONE caller, `handle()` below, which resolves
    // `resolveProject(sessionId)` FIRST and returns a synchronous 404 ("unknown or expired session")
    // before ever calling `buildServer` — no `await` in between, so there's no TOCTOU window either. A
    // null `session` here can only mean the id resolved to a project moments ago but the session row is
    // now gone, which cannot happen within one synchronous request.
    if (session?.role !== "assistant") {
      server.registerTool(
        "tasks_create",
        {
          description: "Create a task on this project's board. priority p0|p1|p2|p3 (low number = higher priority), default p2.",
          inputSchema: { title: z.string(), body: z.string().optional(), columnKey: z.string().optional(), priority: prioritySchema.optional() },
        },
        async (args) => ok(createProjectTask(db, projectId, args)),
      );
      server.registerTool(
        "tasks_update",
        {
          description: "Update a task by id; project-scoped. PATCH-style: pass only the field(s) you're changing. id accepts the full id OR an unambiguous 8-char id-prefix (mirrors project_get); `taskId` is accepted as an ALIAS for `id` (matches the taskId param name every sibling task tool — tasks_get/task_requests_list/task_request_get — uses) — pass either one (if both, id wins). priority p0|p1|p2|p3 (low number = higher priority). held=true marks an owner-gated card the idle watchdog won't nag about — you MAY set this yourself. held=false CLEARS it, but only if held wasn't set by the owner: clearing an owner-set hold is REFUSED here (returns {error}, nothing written) — only the owner can release their own hold, via the board UI. deferred=true is YOUR OWN sequencing/dependency-gating marker — also discounted from the idle watchdog's actionable count, but (unlike held) never blocks worker_spawn. A column/priority/deferred/held-only move needs ONLY id + those fields — no body — and returns a TRIMMED ack ({id,title,columnKey,priority,position,held,deferred,heldBy,updatedAt,changed}, no body) instead of echoing the full card back. Pass body when you're intentionally editing it — that returns the full updated task, body included.",
          inputSchema: {
            id: z.string().optional(),
            taskId: z.string().optional(),
            title: z.string().optional(),
            body: z.string().optional(),
            columnKey: z.string().optional(),
            position: z.number().optional(),
            priority: prioritySchema.optional(),
            held: z.boolean().optional(),
            deferred: z.boolean().optional(),
          },
        },
        async ({ id, taskId, ...patch }) => {
          const resolvedId = resolveAlias(id, taskId);
          if (resolvedId === undefined) return ok({ error: "id (or taskId) is required" });
          return ok(updateProjectTask(db, projectId, resolvedId, patch, { sessionId }));
        },
      );
    }

    // Project-scoped SHARED memory (card 2fd9abf9) — universal, every project session, ANY worker may
    // write (owner decision #1: it's notes, not code/secrets). Pinned + FTS5-related notes are injected
    // into every kickoff (sessions/service.ts); these tools are the deliberate-capture write path.
    server.registerTool(
      "memory_write",
      {
        description:
          "Write (or UPDATE) a project-scoped note into this project's SHARED memory — durable knowledge " +
          "every worker/manager sees at kickoff, across sessions. `key` is a short stable slug (letters/" +
          "digits/-/_ only) that identifies this note: writing the SAME key again UPDATES it in place " +
          "(no duplicate accumulation) — prefer refining an existing key over minting a near-duplicate. " +
          "`text` is the note body. `pinned:true` marks it especially important — pinned notes are " +
          "injected IN FULL on EVERY kickoff and are never auto-evicted; leave it false/omitted for a note " +
          "that should surface only when it's RELEVANT (matched by full-text search against the kickoff/" +
          "task text). Optional `title` (short label, max 200 chars) and `tags` (string[]). Write " +
          "declarative facts/decisions worth remembering across sessions, not throwaway task chatter — " +
          "`text` is capped at 4000 bytes (a short, curated note, not a dumping ground); a too-long write " +
          "is rejected with `bytesOver` + the current note (if any) so you can trim without re-fetching. " +
          "UPDATING A NOTE THAT ALREADY EXISTS REQUIRES `baseVersion` — the `version` you last read for " +
          "this key (from memory_read, memory_list, or a prior memory_write's response; NOT its `updatedAt` " +
          "timestamp). Omitting it, or passing a stale one, is REJECTED with `conflict:true` and `current` " +
          "(the note as it stands right now) instead of silently overwriting someone else's write — re-read, " +
          "merge your change into `current.text`, and retry with `baseVersion: current.version`. A brand-new " +
          "key needs no base.",
        inputSchema: {
          key: z.string(),
          text: z.string(),
          title: z.string().optional(),
          pinned: z.boolean().optional(),
          tags: z.array(z.string()).optional(),
          baseVersion: z.number().int().optional(),
        },
      },
      async (args) => ok(writeProjectMemory(db, projectId, args)),
    );
    server.registerTool(
      "memory_forget",
      { description: "Delete a project-scoped memory note by key. Idempotent — deleting a missing key returns {ok:true,deleted:false}, never an error.", inputSchema: { key: z.string() } },
      async ({ key }) => ok(forgetProjectMemory(db, projectId, key)),
    );
    server.registerTool(
      "memory_list",
      { description: "List this project's SHARED memory notes (pinned first, then most-recently-updated). Returns NEWLINE-DELIMITED JSON, one note per line.", inputSchema: {} },
      async () => okLines(listProjectMemoryEntries(db, projectId)),
    );
    server.registerTool(
      "memory_read",
      { description: "Read ONE project-scoped memory note in full by key.", inputSchema: { key: z.string() } },
      async ({ key }) => ok(readProjectMemory(db, projectId, key)),
    );

    // Self-scheduled wake-ups (universal — every session, any role). Keyed to THIS session id.
    server.registerTool(
      "wake_me",
      {
        description:
          "Provide exactly one of `delaySeconds`/`minutes` or `wakeAt` (ISO). Schedule a one-shot wake-up: end your turn and go idle; you'll be re-prompted with `note` (or its alias `reason`) when it fires (re-submits as a fresh turn; auto-resumed if stopped). `minutes` is sugar for delaySeconds (×60) — if both are given, delaySeconds (the explicit form) wins. Use to WAIT for a known external process/condition — a build, render, deploy — instead of busy-polling. Min 30s, max 24h.",
        inputSchema: {
          delaySeconds: z.number().optional(),
          minutes: z.number().optional(),
          wakeAt: z.string().optional(),
          note: z.string().optional(),
          reason: z.string().optional(),
        },
      },
      async ({ delaySeconds, minutes, wakeAt, note, reason }) => {
        try {
          return ok(wakes.schedule(sessionId, { delaySeconds, minutes, wakeAt, note, reason }));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );
    server.registerTool(
      "wake_cancel",
      { description: "Cancel one of your pending wake-ups by id.", inputSchema: { wakeId: z.string() } },
      async ({ wakeId }) => ok(wakes.cancel(sessionId, wakeId)),
    );
    server.registerTool(
      "wake_list",
      { description: "List your pending wake-ups.", inputSchema: {} },
      async () => ok(wakes.list(sessionId)),
    );

    // Agent-tooling epic P2: the profile-gated authenticated-egress tool. OMITTED from tools/list
    // entirely (not merely denied) when this session has no pinned connections — a session's `connections`
    // allowlist is resolved from the session ROW (pinned at spawn from the Profile, mirrors browserTesting)
    // fresh on every request, since this router is stateless. The default daemon-global permission already
    // whole-server-allows "mcp__loom-tasks" (config.ts), so — UNLIKE browserTesting/documentConversion's
    // separate stdio MCP servers — no `--allowedTools` entry is needed here: conditional registration IS
    // the gate. The handler double-checks the requested connection id against this same pinned list
    // (defense in depth), so a future bug in this gate still can't reach a connection outside the grant.
    // (`session` is resolved above, ahead of tasks_create/tasks_update's own conditional registration.)
    const sessionConnections = session?.connections ?? [];
    if (sessionConnections.length > 0) {
      const guard = resolveConfig(undefined, db.getPlatformConfig()).platform.connections;
      server.registerTool(
        "authenticated_request",
        {
          description:
            "Perform a credential-injected HTTP request to one of THIS session's allowlisted connections " +
            "(set on your profile by the owner). Loom builds the URL from the connection's fixed host + your " +
            "`path` and injects the auth header server-side — you never see the secret and cannot set an " +
            "Authorization header yourself (rejected if you try). Redirects are NOT followed: a 3xx comes " +
            "back as {status, location} instead of being chased. `method` defaults to GET. `headers` may " +
            "carry NON-auth headers only. `body` may be a string or a JSON-serializable object (a JSON " +
            "object defaults Content-Type: application/json). Bounded by a request timeout and a response-" +
            "size cap; each connection also has a request-rate limit.",
          inputSchema: {
            connection: z.string(),
            path: z.string(),
            method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]).optional(),
            headers: z.record(z.string(), z.string()).optional(),
            body: z.union([z.string(), z.record(z.string(), z.any())]).optional(),
          },
        },
        async (args) => ok(await performAuthenticatedRequest({ db, fetchImpl: fetchOverride }, sessionConnections, guard, args, projectId)),
      );
    }

    // Card be8be211: the profile-gated confined vault-write tool — same shape as authenticated_request
    // immediately above (conditional registration IS the gate; OMITTED from tools/list entirely, not
    // merely denied, when this session's Profile didn't opt in). `projectId` is the SERVER-DERIVED
    // binding this whole router is keyed on (never agent-supplied — see the class doc), so the write can
    // only ever land in THIS session's own project vault; `path` is REQUIRED to be vault-relative and is
    // confined by vault/writer.ts's `resolveInVault` traversal guard (reused verbatim, not reimplemented).
    // Write-only (create/overwrite) — no delete tool is exposed here, matching the profile field's doc.
    if (session?.vaultWrite) {
      const project = db.getProject(projectId);
      if (project) {
        server.registerTool(
          "vault_write",
          {
            description:
              "Write (create or overwrite) a UTF-8 text note under THIS project's vault, then commit it " +
              "through the vault auto-committer. `path` is a vault-RELATIVE path (e.g. \"Design/My Note.md\") " +
              "— confined to the project's vault root; a `..`/absolute-path escape or a backslash is REJECTED. " +
              "Prefer the project's documented vault taxonomy folder for a well-behaved note rather than the " +
              "vault root. Returns { ok:true, committed } or { ok:false, reason } ('traversal' on a path " +
              "escape, 'is-dir', 'error'). There is no delete — this tool only ever creates or overwrites.",
            inputSchema: { path: z.string(), content: z.string() },
          },
          async ({ path: relPath, content }) => {
            if (!project.vaultPath) return ok({ error: "no vault path for this project" });
            return ok(await writeVaultFile(project.vaultPath, relPath, content));
          },
        );
      }
    }

    return server;
  }

  /** HTTP entry for /mcp/:sessionId. `body` is the Fastify-parsed JSON (or undefined). */
  async handle(req: IncomingMessage, res: ServerResponse, sessionId: string, body: unknown): Promise<void> {
    const projectId = this.resolveProject(sessionId);
    if (!projectId) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "unknown or expired session" }));
      return;
    }

    // Stateless per request: sessionIdGenerator undefined → no session state, no validation, so a
    // transient stream close can't strand the session. (The old per-session cache deleted the
    // transport on onclose, and claude never re-initialized a server it thought died → the
    // loom-tasks "drop".) The same surface is rebuilt every request from the session→project map.
    const server = this.buildServer(projectId, sessionId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /** No-op: stateless transports hold no per-session state to tear down (kept for the onExit hook). */
  dispose(_sessionId: string): void {}
}
