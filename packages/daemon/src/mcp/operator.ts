import type { IncomingMessage, ServerResponse } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { resolveConfig } from "@loom/shared";
import type { Db } from "../db.js";
import type { SessionService } from "../sessions/service.js";
import { GitWriter } from "../git/writer.js";
import { writeVaultFile } from "../vault/writer.js";

// Same envelope as the task / orchestration / platform / setup MCP servers.
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

/**
 * LIVE read of the `platform.operatorEnabled` gate (Bucket 2b) — mirrors `paths.ts` `isLoomDev`: read at
 * CALL time, never boot-memoized, so flipping the flag off revokes the surface on the very next request
 * instead of waiting for a daemon restart. Exported so the gateway REST spawn branch and any other
 * flag-gated caller reuse the exact same read (never a second, potentially-drifting resolution).
 */
export function isOperatorEnabled(db: Db): boolean {
  return resolveConfig(undefined, db.getPlatformConfig()).platform.operatorEnabled;
}

/**
 * Operator MCP server (Bucket 2b "Bounded Elevated Operator") — a per-install, OPT-IN, HUMAN-SPAWNED-ONLY
 * surface (`loom-operator`, served at /mcp-operator/:sessionId, role-gated to "operator" AND
 * platform.operatorEnabled) sitting between the fail-closed `loom-setup` operator and the LOOM_DEV
 * Platform Lead's elevated `loom-platform`.
 *
 * ╔═ TRUST BOUNDARY — the load-bearing security goal ═══════════════════════════════════════════════════╗
 * ║ This surface hands an agent session the ops Loom otherwise keeps HUMAN-ONLY — git checkout/create-   ║
 * ║ branch/commit/push + raw vault-file writes (see mcp/platform.ts's P3 block, which this MIRRORS in    ║
 * ║ capability). It is safe ONLY because of these load-bearing invariants:                                ║
 * ║   (1) DOUBLE GATE — resolveRole requires BOTH role==="operator" AND isOperatorEnabled(db) (a LIVE     ║
 * ║       read, not boot-memoized): flipping the human-only platform.operatorEnabled flag OFF 404s this   ║
 * ║       surface on the very next request, even for an already-spawned session. An "operator" session is ║
 * ║       HUMAN-CREATED ONLY (startOperator, human REST) — no agent/MCP tool mints one (session_spawn on   ║
 * ║       every agent-facing surface refuses role "operator"; setupRoleError excludes it; the profile      ║
 * ║       enum on the fail-closed setup surface never mints one either).                                   ║
 * ║   (2) OWN-WORKSPACE CONFINEMENT (the divergence from the Lead's P3 tools) — every writer resolves its  ║
 * ║       target project SERVER-SIDE from the CALLER'S OWN session (resolveOperatorProject below). There   ║
 * ║       is NO projectId argument anywhere on this router: an operator bound to project A structurally    ║
 * ║       cannot reach project B, even by supplying an id — the tool schema carries no such parameter.     ║
 * ║   (3) VERBATIM REUSE — every writer calls the EXISTING human-only helpers (git/writer.ts GitWriter,     ║
 * ║       vault/writer.ts writeVaultFile) unchanged, so the bounds/timeouts/traversal-guards/no-force-push  ║
 * ║       properties that make those ops safe are inherited, never re-implemented.                         ║
 * ║                                                                                                       ║
 * ║ EXPLICITLY ABSENT — DO NOT ADD ANY OF THESE (fail-closed BY NON-REGISTRATION):                          ║
 * ║   gateCommand/deployCommand/alertWebhook (no project_configure/create/update tool at all);              ║
 * ║   bundled skill_write (no skill-write tool at all — see the P3 doc box rationale on skillTools.ts);      ║
 * ║   cross-project reach — session_message / session_stop / agent_delete / agent_clone(_batch);            ║
 * ║   schedule_* (any kind); minting sessions/profiles — session_spawn / profile_create / update / assign;  ║
 * ║   the full-validator project_configure path (no config-set surface exists here at all).                ║
 * ║ Doc-box rule (verbatim, from the build spec): if injecting a hostile string could cause host exec,      ║
 * ║ data leaving the box, durable self-modification, or cross-project action — it stays out.                ║
 * ║                                                                                                       ║
 * ║ HONEST CAVEAT (Q7, owner-resolved): git_push never passes --force (GitWriter.push()), but the operator  ║
 * ║ session ALSO has native Bash in its own cwd — "no force-push" is load-bearing ONLY against the MCP       ║
 * ║ git_push tool, not against the session's own `git push --force`. Same accepted property as the Lead's   ║
 * ║ P3 git tools. The HARD boundaries (cross-project reach, host RCE beyond the session's own cwd, durable   ║
 * ║ self-modification) remain closed regardless.                                                            ║
 * ╚════════════════════════════════════════════════════════════════════════════════════════════════════╝
 *
 * Mirrors SetupMcpRouter/PlatformMcpRouter exactly: keyed by the URL-path session id, resolved
 * SERVER-SIDE, role-gated. Stateless: a fresh McpServer+transport per request, so no cached transport can
 * be wedged by a dropped stream.
 */
export class OperatorMcpRouter {
  constructor(
    private db: Db,
    private sessions: SessionService,
    private gitWriteTimeouts?: { gitLocalMs: number; gitPushMs: number },
  ) {}

  /** Role gate: an "operator" session ONLY, AND ONLY while platform.operatorEnabled is on (read LIVE —
   *  see isOperatorEnabled's doc). Either failing ⇒ no surface, mirrors the sibling routers' resolveRole. */
  resolveRole(sessionId: string): { id: string } | null {
    if (!isOperatorEnabled(this.db)) return null;
    return this.db.getSession(sessionId)?.role === "operator" ? { id: sessionId } : null;
  }

  /**
   * Resolve the CALLING session's own project — the confinement mechanism (invariant (2) above). Every
   * writer/read tool calls this INSTEAD of taking a projectId argument, so the operator can never reach
   * any project but the one it was spawned into.
   */
  private resolveOperatorProject(callerSessionId?: string) {
    if (!callerSessionId) return null;
    const session = this.db.getSession(callerSessionId);
    if (!session) return null;
    return this.db.getProject(session.projectId) ?? null;
  }

  buildServer(callerSessionId?: string): McpServer {
    const db = this.db;
    const sessions = this.sessions;
    const gitWriteTimeouts = this.gitWriteTimeouts;
    const server = new McpServer({ name: "loom-operator", version: "0.1.0" });
    const ownProject = () => this.resolveOperatorProject(callerSessionId);

    // === git writes (reuse git/writer.ts GitWriter VERBATIM — bounded + non-interactive). NO projectId
    //     argument: the target repo is ALWAYS the caller's own project (own-workspace confinement). ===
    const gitWriterFor = (repoPath: string) => new GitWriter(repoPath, gitWriteTimeouts);

    server.registerTool(
      "git_checkout",
      {
        description: "Switch YOUR OWN project's repo to an EXISTING local branch (reuses the bounded, non-interactive human git-write path). No projectId — always your own project. Returns { ok:true, branch } or { ok:false, error } (unknown branch / dirty tree).",
        inputSchema: { branch: z.string() },
      },
      async ({ branch }) => {
        const p = ownProject();
        if (!p) return ok({ error: "no project for this session" });
        return ok(await gitWriterFor(p.repoPath).checkout(branch));
      },
    );

    server.registerTool(
      "git_create_branch",
      {
        description: "Create a NEW local branch off the current HEAD and switch to it (checkout -b), in YOUR OWN project's repo. Does NOT touch any remote. No projectId — always your own project. Returns { ok:true, branch } or { ok:false, error } (branch already exists / invalid name).",
        inputSchema: { name: z.string() },
      },
      async ({ name }) => {
        const p = ownProject();
        if (!p) return ok({ error: "no project for this session" });
        return ok(await gitWriterFor(p.repoPath).createBranch(name));
      },
    );

    server.registerTool(
      "git_commit",
      {
        description: "Stage ALL changes (add -A) and commit YOUR OWN project's repo with the given message — plain commit under the repo's configured identity (no -c overrides, no Co-Authored-By trailer). No projectId — always your own project. A clean tree is an EXPECTED no-op failure ('nothing to commit'). Returns { ok:true, hash } or { ok:false, error }.",
        inputSchema: { message: z.string() },
      },
      async ({ message }) => {
        const p = ownProject();
        if (!p) return ok({ error: "no project for this session" });
        return ok(await gitWriterFor(p.repoPath).commit(message));
      },
    );

    server.registerTool(
      "git_push",
      {
        description: "Push YOUR OWN project's current branch to its remote — the one genuinely-outward op. Reuses GitWriter.push() VERBATIM: a plain `git push`, retried as `git push -u origin <branch>` ONLY when the branch has no upstream; any other failure (unreachable/auth/rejected) is surfaced unchanged. Bounded + non-interactive so a credential-needing remote FAILS FAST rather than hanging. No force-push via this tool (see the router's HONEST CAVEAT doc — this does not constrain the session's own shell). No projectId — always your own project. Returns { ok:true, branch } or { ok:false, error }.",
        inputSchema: {},
      },
      async () => {
        const p = ownProject();
        if (!p) return ok({ error: "no project for this session" });
        return ok(await gitWriterFor(p.repoPath).push());
      },
    );

    // === vault write (reuse vault/writer.ts writeVaultFile VERBATIM — same mandatory path-traversal
    //     guard that confines every write to the project's vault root). NO projectId argument. ===
    server.registerTool(
      "vault_write",
      {
        description: "Write (create or overwrite) a UTF-8 text file under YOUR OWN project's vault, then commit it through the vault auto-committer (reuses vault/writer.ts writeVaultFile — its mandatory path-traversal guard confines the write to the vault root). No projectId — always your own project. Returns { ok:true, committed } or { ok:false, reason } ('traversal' on a path escape, 'is-dir', 'error').",
        inputSchema: { path: z.string(), content: z.string() },
      },
      async ({ path: relPath, content }) => {
        const p = ownProject();
        if (!p) return ok({ error: "no project for this session" });
        return ok(await writeVaultFile(p.vaultPath, relPath, content));
      },
    );

    // === reads (own-project only, v1 — bounded cross-project summary reads are optional/inert per the
    //     resolved sub-decisions and are deliberately omitted here). ===
    server.registerTool(
      "my_project",
      {
        description: "Read YOUR OWN project — the FULL record (name, repoPath, vaultPath, config override). No argument: always resolves to the project this operator session was spawned into. Read-only.",
        inputSchema: {},
      },
      async () => {
        const p = ownProject();
        return p ? ok(p) : ok({ error: "no project for this session" });
      },
    );

    // end_me — SELF-SCOPED terminal exit, mirrors the setup/platform routers' end_me exactly (no target
    // arg, always ends callerSessionId, never another session).
    server.registerTool(
      "end_me",
      {
        description:
          "Request graceful termination of YOUR OWN session — a terminal exit, no successor. Takes no " +
          "argument: Loom always ends the session calling this tool, never another. Loom REFUSES (does not " +
          "stop) if you have unconsumed inbound direction queued (a human composer turn you haven't acted " +
          "on yet) → {stopped:false, reason:\"queued-inbound\", pending:N} — end this turn so it drains " +
          "into your next turn, act on it, THEN re-call end_me. On pass: your session gracefully stops " +
          "(Ctrl-C×2, clean, resumable — the row lands on Archive) and this tool's own reply is delivered " +
          "before your pty dies.",
        inputSchema: {},
      },
      async () => {
        if (!callerSessionId) return ok({ error: "no caller session" });
        try {
          return ok(sessions.endMe(callerSessionId));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    return server;
  }

  /** HTTP entry for /mcp-operator/:sessionId. `body` is the Fastify-parsed JSON (or undefined). */
  async handle(req: IncomingMessage, res: ServerResponse, sessionId: string, body: unknown): Promise<void> {
    if (!this.resolveRole(sessionId)) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no operator surface for this session" }));
      return;
    }
    // Stateless per request (see PlatformMcpRouter/SetupMcpRouter): no cached transport to be wedged by a
    // dropped stream.
    const server = this.buildServer(sessionId);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  /** No-op: stateless transports hold no per-session state to tear down (kept for the onExit hook). */
  dispose(_sessionId: string): void {}
}
