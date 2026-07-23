import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import type { Db } from "../db.js";
import type { SessionService } from "../sessions/service.js";
import { registerTranscriptReadTools } from "./transcript-read.js";
import { registerScopedRepoReadTools, type ScopedRootResolution } from "./repo-read.js";
import { skillListData } from "./skillTools.js";
import { readSkill, isValidSkillName } from "../skills/store.js";

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
 * ║ NOTHING but cross-project READS (the SAME shared list_sessions/transcript_read the dev Auditor uses —║
 * ║ mcp/transcript-read.ts — plus the agent-prompt / skill-text READS it critiques against, plus the     ║
 * ║ OWN-PROJECT-CONFINED source reads below) + a small, fully-confined set of INERT, DEDUPE/SERVER-       ║
 * ║ RESOLVED daemon-local writes + ONE confined outward nudge — and is fail-closed by construction (a     ║
 * ║ tool not registered here cannot be reached):                                                          ║
 * ║   0. repo_read_file / repo_grep / repo_glob → READ-ONLY reads over ONE project's source tree, scoped  ║
 * ║      PER CALL by a caller-supplied `projectId` resolved SERVER-SIDE to that project's OWN `repoPath`   ║
 * ║      (never another project's root — reuses `registerScopedRepoReadTools`, mcp/repo-read.ts, the SAME  ║
 * ║      confinement gate + bound constants as the dev Auditor's fixed-root repo_* tools). An unknown      ║
 * ║      projectId or a project with no readable repo root is a clean {error}, never a crash or an         ║
 * ║      arbitrary-host-file read. Pure reads: no write, no exec/shell, no git mutation.                   ║
 * ║   1. audit_suggest_improvement   → a board card onto the USER'S OWN reserved "Platform" home         ║
 * ║      `inbox` (target resolved SERVER-SIDE; the caller passes NO projectId — NEVER the dev "Loom       ║
 * ║      Platform" home, NEVER an arbitrary id). A suggestion to the user, never an auto-applied change.  ║
 * ║      It ALSO fires the same confined operator nudge as audit_handoff (below) so a suggestion reaches  ║
 * ║      an actor; the card is the durable record either way.                                            ║
 * ║   2. preset_suggestion_suggest  → a candidate preset onto the daemon-local SUGGESTIONS store (the     ║
 * ║      same db.suggestPresetPrompt the dev Auditor uses — server-side dedupe).                          ║
 * ║   3. audit_handoff              → a CONFINED, best-effort live nudge to EXACTLY ONE session: the live ║
 * ║      operator of the user's OWN home (sessions.workspaceAuditHandoff → nudgeHomeOperator, server-     ║
 * ║      resolved; the caller names NO target and supplies NO free-form payload — the note is framed      ║
 * ║      server-side). This is NOT the generic harness SendMessage (no Loom routing) and is NOT arbitrary ║
 * ║      cross-session messaging — it can reach ONLY the home operator. Inert if no operator is live.     ║
 * ║   4. end_me                     → SELF-SCOPED terminal exit (card 3b015fc7): NO target arg, always    ║
 * ║      ends the CALLING workspace-auditor session, never another — a hostile transcript can only ever   ║
 * ║      end THIS scan, never spawn/stop/message a different session.                                     ║
 * ║ The READS (transcript / agent-prompt / skill-text) are pure reads; NO write reaches git/vault/config/ ║
 * ║ spawn/host/escalation/archive/audit_file_finding, the nudge can target NOTHING but the home operator, ║
 * ║ and a hostile transcript can neither escape the box nor spam it. A workspace-auditor session ALSO     ║
 * ║ 404s on /mcp-platform, /mcp-orch, /mcp-audit and /mcp-setup (each router's resolveRole gates other    ║
 * ║ roles), and NO agent/MCP path can mint a "workspace-auditor" session (caller-set only — B1 guards).  ║
 * ║ Do NOT add any write/host/outward tool beyond these inert daemon-local writes + the home-only nudge. ║
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
    // list_sessions/transcript_read (mcp/transcript-read.ts), reused, not copy-pasted. This surface DOES
    // register agent_prompt_read (below) — name it in list_sessions' shared description (the dev Auditor's
    // call site omits this, since loom-audit has no agent_prompt_read tool). ---
    registerTranscriptReadTools(server, db, { callerSessionId: auditorSessionId, agentPromptToolName: "agent_prompt_read" });

    // --- READ: own-project source (repo_read_file / repo_grep / repo_glob), scoped PER CALL by a
    // caller-supplied projectId resolved SERVER-SIDE to that project's OWN repoPath — never another
    // project's root. Reuses the dev Auditor's confinement gate + bound constants (mcp/repo-read.ts; see
    // the trust-boundary banner above, item 0) rather than hand-rolling a new path guard. ---
    registerScopedRepoReadTools(server, (projectId): ScopedRootResolution => {
      const project = db.getProject(projectId);
      if (!project) return { error: "unknown project" };
      if (!project.repoPath || project.repoPath.trim() === "") {
        return { error: "project has no repoPath to read source from (e.g. a repo-less vault-only project)" };
      }
      return { root: project.repoPath };
    });

    // --- READ: the CURRENT agent prompt the auditor is critiquing. Reading the live startupPrompt (instead
    // of reverse-engineering it from transcripts) lets a suggestion verify against what the agent ACTUALLY
    // runs — so it never re-suggests a rule the prompt already has. Pure read; agentId comes from
    // list_sessions (full:true, or the summary `agentId`). ---
    server.registerTool(
      "agent_prompt_read",
      {
        description:
          "Read an agent's CURRENT startup prompt (the exact text it is spawned with) so a suggestion is " +
          "verified against what the agent ACTUALLY runs — never inferred from a transcript, and never a " +
          "duplicate \"add another rule\" finding for a rule the prompt already states. Pass the `agentId` " +
          "from list_sessions (full:true, or the summary's `agentId`). Returns {id, projectId, name, " +
          "startupPrompt} or {error} if the id is unknown. Read-only.",
        inputSchema: { agentId: z.string() },
      },
      async ({ agentId }) => {
        const a = db.getAgent(agentId);
        if (!a) return ok({ error: "agent not found" });
        return ok({ id: a.id, projectId: a.projectId, name: a.name, startupPrompt: a.startupPrompt });
      },
    );

    // --- READ: the skill store the auditor critiques. skill_list enumerates (name, description, bundled);
    // skill_read returns ONE skill's full SKILL.md text (bundled OR user) so a suggestion checks the CURRENT
    // skill body instead of guessing. Both pure reads. ---
    server.registerTool(
      "skill_list",
      {
        description:
          "List the skills in the user's skill store (the skills delivered to their sessions) — each entry " +
          "has name, description, bundled (a Loom-shipped skill) and editable (= !bundled). USER (editable) " +
          "skills also include their full SKILL.md `content`; for a BUNDLED skill's full text use skill_read. " +
          "Read-only — use it to ground a skill critique in what is actually installed.",
        inputSchema: {},
      },
      async () => {
        try { return ok(skillListData()); }
        catch (e) { return ok({ error: (e as Error).message }); }
      },
    );
    server.registerTool(
      "skill_read",
      {
        description:
          "Read ONE skill's CURRENT full SKILL.md text by `name` (works for BUNDLED and USER skills) so a " +
          "suggestion verifies against the actual skill body instead of inferring it from a transcript — " +
          "avoiding a duplicate finding for guidance the skill already gives. Returns {name, content} or " +
          "{error} if the name is invalid / not found. Read-only.",
        inputSchema: { name: z.string() },
      },
      async ({ name }) => {
        if (!isValidSkillName(name)) return ok({ error: "invalid skill name" });
        const s = readSkill(name);
        return ok(s ?? { error: "skill not found" });
      },
    );

    // --- WRITE A: file an improvement SUGGESTION as a board card onto the USER'S OWN reserved home (target
    // resolved SERVER-SIDE — never Loom Platform, never an arbitrary id). ---
    server.registerTool(
      "audit_suggest_improvement",
      {
        description:
          "Suggest a workspace improvement as a DURABLE board card on the user's OWN \"Platform\" home " +
          "(the inbox where they already triage). This is a SUGGESTION for the user — never an auto-applied " +
          "change — and one of your only two writes (no git/vault/config/spawn here — just this card and the " +
          "confined home-operator nudge it fires, below). The " +
          "target board is FIXED server-side (you cannot pick a project — your suggestion always lands in the " +
          "user's own home). Give a sharp title; put the evidence/repro, the impact, the implicated " +
          "skill/prompt/feature, and a concrete suggested fix in detail; set a severity. It ALSO fires a " +
          "best-effort live nudge to your home's Platform operator so the suggestion reaches an actor (the " +
          "card is the durable record regardless). Returns {taskId, projectId, deliveryStatus} — " +
          "deliveryStatus is `delivered-live`/`queued` if the operator is live, else `boarded` (the card " +
          "sits on the now-visible home board) — or {error} if the home is unexpectedly absent (safe; " +
          "nothing is written).",
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

    // --- HANDOFF: a CONFINED, best-effort nudge to the user's home operator — the auditor's one way to
    // reach an actor for the batch it just filed (board card 5eb8438a). Server-resolved target (ONLY the
    // live home operator) + server-framed note: NOT the generic harness SendMessage and NOT arbitrary
    // cross-session messaging. Inert if no operator is live (the cards are the durable inbox). ---
    server.registerTool(
      "audit_handoff",
      {
        description:
          "Hand your filed suggestions off to your home's Platform operator with a single best-effort live " +
          "nudge — call it ONCE after filing a batch of audit_suggest_improvement cards so the operator " +
          "knows to review/apply them. This is your ONLY way to reach an actor, and it is fully confined: " +
          "it can reach NOTHING but your home's live operator (you name no target), and it sends a fixed " +
          "framed heads-up, not free-form text — the forwarded text is 100% server-composed, you cannot " +
          "inject any payload. Optional `count` (how many suggestions you filed — shown in the nudge). " +
          "Returns {deliveryStatus}: `delivered-live`/`queued` if the operator is live, else `boarded` (no " +
          "live operator — your cards already sit on the home board for them to find). The cards are the " +
          "durable record; this nudge never loses anything.",
        inputSchema: {
          count: z.number().int().positive().optional(),
        },
      },
      async ({ count }) => {
        try {
          return ok(sessions.workspaceAuditHandoff(auditorSessionId, { count }));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    // --- WRITE D: end_me (card 3b015fc7) — SELF-SCOPED terminal exit, so the audit doctrine can end a
    // scan pass cleanly. NO target arg: always ends auditorSessionId. ---
    server.registerTool(
      "end_me",
      {
        description:
          "Request graceful termination of YOUR OWN session — a terminal exit, no successor. Call this at " +
          "the end of a scan pass (the audit doctrine's normal wrap-up). Takes no argument: Loom always " +
          "ends the session calling this tool, never another. Loom REFUSES (does not stop) if you have " +
          "unconsumed inbound direction queued (a human composer turn you haven't acted on yet) → " +
          "{stopped:false, reason:\"queued-inbound\", pending:N} — end this turn so it drains into your " +
          "next turn, act on it, THEN re-call end_me. On pass: your session gracefully stops (Ctrl-C×2, " +
          "clean, resumable — the row lands on Archive) and this tool's own reply is delivered before your " +
          "pty dies.",
        inputSchema: {},
      },
      async () => {
        try {
          return ok(sessions.endMe(auditorSessionId));
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
