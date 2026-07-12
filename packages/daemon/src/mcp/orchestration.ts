import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { contextWindowForModel, resolveConfig, resolveProfile, QUESTION_STATES, QUESTION_TYPES, type SessionRole } from "@loom/shared";
import { QUESTION_ASK_INPUT_SHAPE, buildQuestionAsk, questionPullItem, auditRequestItem } from "./questionTool.js";
import type { Db } from "../db.js";
import type { PtyHost } from "../pty/host.js";
import type { SessionService } from "../sessions/service.js";
import { readTranscript, pageTranscript } from "../sessions/transcript.js";
import { UsageLimitError } from "../orchestration/usage-awareness.js";
import { CapQueueRejectedError } from "../orchestration/cap-queue.js";
import { nextFireAt } from "../orchestration/cron.js";
import { reminderNextFireAt, reminderNextFireAtBySession } from "../companion/reminders.js";
import type { CompanionReminder, CompanionRoute } from "../companion/types.js";
import { resolveIdPrefix } from "../id-prefix.js";
import { resolveWebDistDir } from "../paths.js";
import { loomVersion } from "../version.js";
import { lineageRootId } from "../sessions/platform-lead-prompt.js";
import {
  authorCompanionSkill,
  listCompanionSkills,
  readCompanionSkill,
  removeCompanionSkill,
} from "../skills/companion-store.js";
import {
  authorCompanionMemory,
  listCompanionMemories,
  readCompanionMemory,
  removeCompanionMemory,
} from "../skills/companion-memory-store.js";
import { registerCompanionCapabilities } from "../companion/capabilities.js";
import { createOwnerAttestation, OwnerConfirmStore } from "../companion/attestation.js";
import { CompanionTrustWindow } from "../companion/trust-window.js";

// Same envelope as the task MCP server (mcp/server.ts).
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

/**
 * Orchestration MCP server (phase-2 §A2/§A3) — a ROLE-BASED surface, keyed by the URL-path
 * session id and resolved SERVER-SIDE (the agent never names "which session"):
 *   - manager → the full coordination surface (list/status/transcript/spawn/stop/message);
 *   - worker  → worker_report + the read-only my_context ONLY (so a worker CANNOT spawn/list/stop —
 *               the depth-1 tree holds at the tool surface, not just the role gate);
 *   - plain/unknown → 404 (no surface).
 * Stateless: a fresh McpServer+transport per request (the URL-path session id supplies the role
 * binding). No cached transport, so a dropped stream can't wedge the surface mid-session.
 */
/**
 * Loom Companion hooks, threaded from index.ts (generalized to MULTI-companion by the multi-companion
 * runtime card). The `chat_reply` tool is registered ONLY on an ENABLED companion session's MCP server —
 * checked via Set membership (`companionSessionIds.has(sessionId)`), so N concurrently-armed companions
 * each get it on their OWN session — every OTHER manager/worker spawn's surface stays byte-identical and
 * never sees a stray tool (the "fully additive" discipline). Absent/empty ⇒ no session gets chat_reply.
 */
export interface CompanionHooks {
  /** Every currently-ENABLED companion session id — chat_reply is registered iff this Set has the session
   *  being served. Undefined/empty ⇒ off for everyone. The sessionId tested is always the MCP server's OWN
   *  closed-over session (never agent-suppliable), so this is a per-session gate, not a routing decision —
   *  it can never let one companion's tool call act on another's behalf. */
  companionSessionIds?: ReadonlySet<string>;
  /** Deliver the agent's chat_reply(text, voice?) back OUT to the chat bound to the session
   *  (companion/chat-gateway.ts). `voice` is the agent's PER-REPLY voice request (VOICE-P4, card
   *  edd11203) — consulted ONLY when the route's pref mode is "auto"; ignored for "on"/"off". The
   *  controller dispatches this by `sessionId` to THAT session's own gateway — never cross-wired. */
  deliverReply?: (sessionId: string, text: string, voice?: boolean) => Promise<{ delivered: boolean; reason?: string }>;
  /** Deliver a local file to the chat bound to the session, as a native image/document (the `media-out`
   *  lever, card 3a81b0f2). Wired into `GrantOutbound.deliverMediaToOwner` exactly like `deliverReply` is
   *  wired into `GrantOutbound.deliverToOwner`. */
  deliverMedia?: (sessionId: string, filePath: string) => Promise<{ delivered: boolean; reason?: string }>;
  /**
   * SERVER-DERIVED route capture for reminder_create — the current turn's originating companion route (or
   * null), read at schedule time exactly like wake_me (orchestration/wake.ts). The agent never passes a
   * route/channel.
   */
  getActiveTurnOrigin?: (sessionId: string) => CompanionRoute | null;
  /**
   * (Re)arm/disarm the live reminder watcher for the bound companion session — ARM-ON-CREATE. Called after
   * reminder_create/reminder_cancel writes (with the caller's OWN bound sessionId) so a freshly-created
   * reminder starts firing immediately instead of waiting for an unrelated config write to reconcile
   * (companion/controller.ts CompanionReplyHooks) — scoped to that session, never touching a sibling
   * companion's reminder watcher.
   */
  rearmReminders?: (sessionId: string) => Promise<void>;
}

export class OrchestrationMcpRouter {
  // `pty` is OPTIONAL and LAST — added after the constructor's existing (db, sessions, companion) shape
  // was already load-bearing across every test call site (many positional, some omitting `companion`
  // entirely). Appending it here keeps every existing call site byte-identical; a caller that doesn't
  // pass it just gets `lastEngineOutputAt: null` on every row (see fleetView/worker_status below).
  constructor(
    private db: Db,
    private sessions: SessionService,
    private companion: CompanionHooks = {},
    private pty?: PtyHost,
  ) {}

  // Companion injection-guard Primitive C's pending-proposal store (card 8e511951) — ONE per router
  // instance (a stateless per-request buildServer would otherwise lose a pending proposal before the
  // owner's confirming reply arrives). No lever proposes/confirms yet — this just gives `attest` (built in
  // buildServer below) somewhere durable to keep state across requests once one does.
  private readonly ownerConfirmStore = new OwnerConfirmStore();

  // Companion Trust Window (Framework Card 0) — ONE per router instance, same lifetime/rationale as
  // `ownerConfirmStore` above (in-memory, lost on restart is a fail-safe). Public so gateway/server.ts's
  // REST handlers can revoke every window for a session on the documented close paths (recycle/unbind/
  // binding-allowlist change/re-pair) via {@link closeCompanionTrustWindow} without reaching into the
  // instance directly.
  readonly trustWindow = new CompanionTrustWindow();

  /** Revoke every trust window held for `sessionId`, across every route/sender — called from the REST
   *  layer's own close paths (session recycle/unbind, a binding/allowlist change, a re-pair); a daemon
   *  restart closes every window automatically (in-memory). */
  closeCompanionTrustWindow(sessionId: string): void {
    this.trustWindow.closeAllForSession(sessionId);
  }

  /** Role gate: returns the session's id + orchestration role, or null (→ 404) for plain/unknown.
   *  Admits the Companion (assistant) too — it reaches this surface for its MINIMAL toolset (my_context +
   *  the companion-gated chat_reply); buildServer restricts what it actually registers. */
  resolveRole(sessionId: string): { id: string; role: SessionRole } | null {
    const role = this.db.getSession(sessionId)?.role;
    return role === "manager" || role === "worker" || role === "assistant" ? { id: sessionId, role } : null;
  }

  /**
   * READ-ONLY projection of the caller's project RESOLVED gateCommand (the build/DoD gate run in a
   * worker's worktree before merge), folded into `my_context` so a manager/worker can SEE the gate
   * without a new tool. Resolved through the ONE config mechanism (`resolveConfig`) — never the default
   * ad hoc — so a per-project override or human PATCH is reflected with no daemon restart.
   *
   * TRUST BOUNDARY — this is READ-ONLY by design (PL Auditor finding #9, signed off on option (b)).
   * `gateCommand` runs arbitrary host shell at daemon privilege, so it stays HUMAN-only-to-SET (same
   * class as the vault/git writers + alertWebhook). NO set/propose/confirm-queue surface exists here.
   * When NO gate is configured (the platform default is the empty string), this returns an explicit
   * `configured:false` + a note so the manager ASKS THE OWNER to set one (a human action) rather than
   * hand-rolling a gate string into a worker's DoD.
   */
  private resolvedGateCommand(projectId: string | undefined):
    | { configured: true; command: string }
    | { configured: false; command: null; note: string } {
    const project = projectId ? this.db.getProject(projectId) : undefined;
    const command = resolveConfig(project?.config).orchestration.gateCommand;
    if (command && command.trim() !== "") return { configured: true, command };
    return {
      configured: false,
      command: null,
      note: "none configured — this project has no build/DoD gateCommand. Ask the OWNER to set one " +
        "(a HUMAN-only action; agents cannot set it). Do NOT hand-roll a gate command into a worker's DoD.",
    };
  }

  /**
   * The caller's OWN measured context occupancy (server-derived from the URL-path session id — a
   * session can only ever read itself, so cross-session reads are impossible). Reuses the value the
   * Stop-time measurement path persists (`ctx_input_tokens`, via sessions/context.ts) — NO new
   * measurement. Returns `pct: null` + a note when not yet measured (never a fake 0%). Also folds in the
   * project's RESOLVED `gateCommand` (READ-ONLY — see resolvedGateCommand) and, for a companion (`role
   * === "assistant"`), its own delivery/channel introspection (see companionIntrospection).
   */
  private myContext(sessionId: string): Record<string, unknown> {
    const s = this.db.getSession(sessionId);
    const ctxInputTokens = s?.ctxInputTokens ?? null;
    const measuredAt = s?.ctxUpdatedAt ?? null;
    const gateCommand = this.resolvedGateCommand(s?.projectId);
    const companion = s?.role === "assistant" ? this.companionIntrospection(sessionId) : undefined;
    if (ctxInputTokens == null) {
      // Pre-first-turn: the transcript-derived `s.model` is still null (nothing measured yet), but the
      // CONFIGURED model is already known at spawn via the session's agent → Profile (`profile.model`,
      // the same value `resolveProfile` reads to pick --model). Reuse it so an unmeasured 1M-window
      // session reports its real window instead of the DEFAULT_CONTEXT_WINDOW fallback. `measured:false`
      // marks the reading explicit either way, so a genuine 200k (no profile / engine-default model —
      // truly unknown pre-turn) is never mistaken for a measured occupancy.
      const agent = s?.agentId ? this.db.getAgent(s.agentId) : undefined;
      const profile = agent?.profileId ? this.db.getProfile(agent.profileId) : undefined;
      const model = profile?.model ?? null;
      const contextWindow = contextWindowForModel(model);
      return {
        ctxInputTokens: null, contextWindow, pct: null, model, measuredAt, gateCommand, measured: false,
        note: "context not measured yet (no completed turn) — occupancy unknown; contextWindow/model " +
          "reflect the CONFIGURED profile model when set, else the DEFAULT_CONTEXT_WINDOW fallback",
        ...(companion ? { companion } : {}),
      };
    }
    const model = s?.model ?? null;
    const contextWindow = contextWindowForModel(model);
    return {
      ctxInputTokens,
      contextWindow,
      pct: Math.round((ctxInputTokens / contextWindow) * 100),
      model,
      measuredAt,
      gateCommand,
      ...(companion ? { companion } : {}),
    };
  }

  /**
   * READ-ONLY companion self-introspection (Companion Delivery Introspection — owner-directed, 2026-07-12):
   * the bound channel(s) + each one's effective voice-reply mode, plus the LAST reply this companion
   * actually delivered (channel, text, and whether it went out as a synthesized voice clip — `text` doubles
   * as that clip's transcript, since TTS speaks exactly the reply text, so there is nothing further to
   * store). Folded into `my_context` (assistant role only, see myContext above) so a companion asked "send
   * the transcript of your last voice message" or "what did you just send, and where" can answer from real
   * state instead of re-guessing/re-pasting from its own turn history.
   *
   * TRUST BOUNDARY: this is a READ over the caller's OWN session ONLY — `sessionId` is the URL-path id
   * (never agent-suppliable, see resolveRole), so a companion can never introspect another session's
   * bindings or deliveries. Voice mode is resolved with `senderId: null`, mirroring EXACTLY how
   * ChatGateway.tryDeliverVoice itself resolves the outbound pref (a DM's key; a group's per-sender pref is
   * a documented, separate limitation — see voice-prefs.ts) — so what this reports is what actually governs
   * delivery, never a guess. `chatId` (the external platform identity, e.g. a Telegram chat id) is
   * deliberately omitted from the bindings list — the companion only needs to know WHICH channels it's
   * reachable on and their voice mode, not the raw external route.
   */
  private companionIntrospection(sessionId: string): Record<string, unknown> {
    const bindings = this.db.getCompanionBindingsForSession(sessionId).map((b) => ({
      channel: b.channel,
      voiceReplies: this.db.getCompanionVoicePref(sessionId, b.channel, b.chatId, null)?.voiceReplies ?? "off",
    }));
    const last = this.db.getLastCompanionDelivery(sessionId);
    return {
      bindings,
      lastDelivery: last
        ? { channel: last.channel, text: last.text, viaVoice: last.viaVoice, sentAt: last.createdAt }
        : null,
    };
  }

  /** Register `my_context` — available to ANY role (manager + worker); read-only, no args, no gating. */
  private registerMyContext(server: McpServer, sessionId: string): void {
    server.registerTool(
      "my_context",
      {
        description:
          "Read YOUR OWN context occupancy (no args — server-derived from your session). Returns " +
          "{ctxInputTokens, contextWindow, pct, model, measuredAt, gateCommand}: pct is your measured " +
          "context size as a percentage of your model's window. Use it at a clean seam to self-assess — " +
          "a manager to decide whether to recycle_me, a worker to worker_report that it's getting heavy. " +
          "If not yet measured (no completed turn), pct is null and `measured:false` is set explicitly — " +
          "contextWindow/model in that case reflect your CONFIGURED profile model (still accurate), not a " +
          "fake reading. `gateCommand` is the project's RESOLVED build/DoD gate, READ-ONLY: " +
          "{configured:true, command} when set, else {configured:false, command:null, note} — when " +
          "unconfigured, ASK THE OWNER to set one (a human-only action); never hand-roll a gate command " +
          "into a worker's DoD. If you are a Companion (chat_reply is on your tool list), the response ALSO " +
          "includes `companion`: {bindings: [{channel, voiceReplies}], lastDelivery: {channel, text, " +
          "viaVoice, sentAt} | null} — your OWN bound channel(s) + effective voice-reply mode, and the last " +
          "reply you actually delivered (`text` IS that clip's transcript when `viaVoice` is true). Use it " +
          "to answer 'what did you just send / on which channel / was it spoken' from real state.",
        inputSchema: {},
      },
      async () => ok(this.myContext(sessionId)),
    );
  }

  /**
   * Loom Companion: register `chat_reply` ONLY on an ENABLED companion session's MCP server (multi-companion
   * runtime — `companionSessionIds` may hold several concurrently-armed sessions; each gets its OWN
   * chat_reply on its OWN server build). Placed BEFORE the role split so a companion bound to EITHER a
   * manager or a worker session gets it; a session that isn't in the enabled set never registers it, keeping
   * every other spawn's tool surface byte-identical. The tool routes to THIS session's own delivery path
   * (deliverReply, dispatched by `sessionId` to that session's own gateway — never another companion's) — it
   * does NOT submit a turn (that would loop the reply back into the agent).
   */
  private registerChatReplyIfCompanion(server: McpServer, sessionId: string): void {
    if (!this.companion.companionSessionIds?.has(sessionId)) return;
    const deliverReply = this.companion.deliverReply;
    server.registerTool(
      "chat_reply",
      {
        description:
          "Reply to the user talking to you over the Loom Companion chat channel (e.g. Telegram). Pass " +
          "the reply `text`; it is delivered VERBATIM back to the chat you're bound to. This is your ONLY " +
          "way to reach that user — the incoming chat message was injected as this turn, and calling " +
          "chat_reply is how your answer gets OUT (it does NOT loop back in as a new turn). Mirrors " +
          "worker_report: emit one clean, final reply. Optional `voice:true` asks to SPEAK this reply " +
          "instead of texting it — it only has effect when the user's voice-reply setting is 'auto' (their " +
          "own on/off choice always wins otherwise); omit it (or pass false) to send plain text.",
        inputSchema: { text: z.string(), voice: z.boolean().optional() },
      },
      async ({ text, voice }) => {
        if (!deliverReply) return ok({ delivered: false, error: "companion transport not configured" });
        return ok(await deliverReply(sessionId, text, voice));
      },
    );
  }

  /**
   * Loom Companion (epic Phase 2): self-authored skills. Registered ONLY on an ENABLED companion session
   * (the SAME per-session gate as chat_reply) so every other manager/worker spawn's surface stays byte-identical.
   * The store is ISOLATED per companion under <LOOM_HOME>/companion-skills/<sessionId>/ (skills/companion-
   * store.ts): writes NEVER touch the global SKILLS_DIR and are NEVER injected into any session's
   * .claude/skills. Loading is ON-DEMAND — the companion consults skill_list (compact) then skill_read (full);
   * skill_author authors/refines-in-place (with a redundancy guard against near-duplicate NEW names) and
   * skill_remove curates.
   */
  private registerCompanionSkillTools(server: McpServer, sessionId: string): void {
    if (!this.companion.companionSessionIds?.has(sessionId)) return;

    server.registerTool(
      "skill_author",
      {
        description:
          "Author or REFINE one of YOUR OWN personal skills (a reusable playbook, private to you and " +
          "isolated from Loom's shared skills). `content` is the FULL SKILL.md (frontmatter `name`/" +
          "`description` + body). Authoring an EXISTING `name` REWRITES it in place — supply the whole " +
          "improved content (no appending, keep it bounded and self-consistent). A NEW name that closely " +
          "duplicates an existing skill is REJECTED with a note telling you to refine the existing one " +
          "instead. Returns the updated compact skill list, or {error}.",
        inputSchema: { name: z.string(), content: z.string() },
      },
      async ({ name, content }) => {
        const r = authorCompanionSkill(sessionId, name, content);
        return ok(r.ok ? { authored: name, skills: r.skills } : { error: r.error });
      },
    );

    server.registerTool(
      "skill_list",
      {
        description:
          "List YOUR OWN personal skills as compact {name, description} entries. Consult this when a request " +
          "may match something you've learned before, then skill_read the one that fits to load it in full.",
        inputSchema: {},
      },
      async () => ok({ skills: listCompanionSkills(sessionId) }),
    );

    server.registerTool(
      "skill_read",
      {
        description:
          "Read the FULL SKILL.md of one of YOUR OWN personal skills by name — the on-demand full load. Use " +
          "it after skill_list identifies a relevant skill, to load its steps before acting. Returns {name, " +
          "content}, or {error} if there's no such skill.",
        inputSchema: { name: z.string() },
      },
      async ({ name }) => {
        const content = readCompanionSkill(sessionId, name);
        return ok(content == null ? { error: `no skill "${name}"` } : { name, content });
      },
    );

    server.registerTool(
      "skill_remove",
      {
        description:
          "Remove one of YOUR OWN personal skills by name (curation/dedup). Returns the updated compact skill " +
          "list, or {error} if there's no such skill.",
        inputSchema: { name: z.string() },
      },
      async ({ name }) => {
        const r = removeCompanionSkill(sessionId, name);
        return ok(r.ok ? { removed: name, skills: r.skills } : { error: r.error });
      },
    );
  }

  /**
   * Loom Companion (epic Phase 2): self-authored DURABLE MEMORY — the sibling surface of
   * registerCompanionSkillTools (SAME per-session gate), backed by companion-memory-store.ts
   * (MEMORY.md entries, isolated per companion under <LOOM_HOME>/companion-memory/<sessionId>/, never the
   * global SKILLS_DIR). Agent surface ONLY — this card does NOT touch recall/turn-formation; a memory
   * entry authored here is not yet injected into any prompt.
   */
  private registerCompanionMemoryTools(server: McpServer, sessionId: string): void {
    if (!this.companion.companionSessionIds?.has(sessionId)) return;

    server.registerTool(
      "memory_write",
      {
        description:
          "Author or REFINE one of YOUR OWN durable memory entries (a fact worth remembering across " +
          "conversations, private to you). `content` is the FULL MEMORY.md (frontmatter `name`/" +
          "`description`/`pinned` + body). Authoring an EXISTING `name` REWRITES it in place — supply the " +
          "whole refined content (no appending, keep it bounded and self-consistent). A NEW name that " +
          "closely duplicates an existing memory is REJECTED with a note telling you to refine the " +
          "existing one instead. Returns the updated compact memory list, or {error}.",
        inputSchema: { name: z.string(), content: z.string() },
      },
      async ({ name, content }) => {
        const r = authorCompanionMemory(sessionId, name, content);
        return ok(r.ok ? { authored: name, memories: r.memories } : { error: r.error });
      },
    );

    server.registerTool(
      "memory_list",
      {
        description:
          "List YOUR OWN durable memory entries as compact {name, description, pinned} entries. Consult " +
          "this to see what you already remember before authoring a new entry or answering from memory.",
        inputSchema: {},
      },
      async () => ok({ memories: listCompanionMemories(sessionId) }),
    );

    server.registerTool(
      "memory_read",
      {
        description:
          "Read the FULL MEMORY.md of one of YOUR OWN durable memory entries by name. Returns {name, " +
          "content}, or {error} if there's no such entry.",
        inputSchema: { name: z.string() },
      },
      async ({ name }) => {
        const content = readCompanionMemory(sessionId, name);
        return ok(content == null ? { error: `no memory "${name}"` } : { name, content });
      },
    );

    server.registerTool(
      "memory_remove",
      {
        description:
          "Remove one of YOUR OWN durable memory entries by name (curation/dedup). Returns the updated " +
          "compact memory list, or {error} if there's no such entry.",
        inputSchema: { name: z.string() },
      },
      async ({ name }) => {
        const r = removeCompanionMemory(sessionId, name);
        return ok(r.ok ? { removed: name, memories: r.memories } : { error: r.error });
      },
    );
  }

  /**
   * Loom Companion Reminders (Companion Memory & Reminders Design, Surface 2 s4): the RECURRING reminders
   * engine's agent surface — the sibling of registerCompanionMemoryTools/registerCompanionSkillTools (SAME
   * per-session gate). Unlike those, there is NO spawn surface here either: a reminder only
   * ever targets the companion's OWN session (server-derived sessionId, never agent-passed — mirrors "the
   * agent never passes a projectId"). Cron is validated AT THE BOUNDARY (never relying on the watcher's
   * defensive catch), the route is captured SERVER-SIDE exactly like wake_me, and create/cancel drive
   * ARM-ON-CREATE via the injected `rearmReminders` hook so a freshly-created reminder starts firing
   * immediately instead of waiting on an unrelated config write's reconcile.
   */
  private registerCompanionReminderTools(server: McpServer, sessionId: string): void {
    if (!this.companion.companionSessionIds?.has(sessionId)) return;
    const db = this.db;

    server.registerTool(
      "reminder_create",
      {
        description:
          "Create a RECURRING reminder that fires a proactive [loom:reminder] turn into YOUR OWN session on " +
          "a cron schedule (5-field cron expression) — distinct from the one-shot wake_me. `prompt` is what " +
          "you'll be re-prompted with EVERY time it fires; `label` is an optional human-facing name. The " +
          "reply route is captured SERVER-SIDE from your current turn (you never pass one), so a later fire " +
          "can chat_reply back to the SAME chat. Starts armed immediately. Returns {reminderId, nextFireAt}, " +
          "or {error} on an invalid cron expression.",
        inputSchema: { cron: z.string(), prompt: z.string(), label: z.string().optional() },
      },
      async ({ cron, prompt, label }) => {
        const now = new Date();
        try {
          nextFireAt(cron, now); // validate AT THE BOUNDARY — never rely on the watcher's defensive catch.
        } catch {
          return ok({ error: `invalid cron expression: ${cron}` });
        }
        const route = this.companion.getActiveTurnOrigin?.(sessionId) ?? null;
        const reminder: CompanionReminder = {
          id: randomUUID(), sessionId, cron, prompt, label: label ?? null,
          route, enabled: true, createdAt: now.toISOString(),
        };
        db.insertCompanionReminder(reminder);
        await this.companion.rearmReminders?.(sessionId); // ARM-ON-CREATE — must fire without a later config write.
        return ok({ reminderId: reminder.id, nextFireAt: reminderNextFireAt(db, reminder) });
      },
    );

    server.registerTool(
      "reminder_list",
      {
        description:
          "List YOUR OWN recurring reminders (any enabled state) as {id, cron, prompt, label, enabled, " +
          "nextFireAt}.",
        inputSchema: {},
      },
      async () => {
        const reminders = db.listCompanionRemindersForSession(sessionId);
        // Single shared event-log scan for the whole list (CR#3 L3) instead of one scan per reminder.
        const nextFireById = reminderNextFireAtBySession(db, reminders);
        return ok(reminders.map((r) => ({
          id: r.id, cron: r.cron, prompt: r.prompt, label: r.label, enabled: r.enabled,
          nextFireAt: nextFireById.get(r.id) ?? null,
        })));
      },
    );

    server.registerTool(
      "reminder_cancel",
      {
        description:
          "Cancel one of YOUR OWN recurring reminders by id (scoped — can never touch another session's " +
          "reminder). Returns {cancelled}.",
        inputSchema: { reminderId: z.string() },
      },
      async ({ reminderId }) => {
        const r = db.getCompanionReminder(reminderId);
        if (!r || r.sessionId !== sessionId) return ok({ cancelled: false });
        db.deleteCompanionReminder(reminderId);
        await this.companion.rearmReminders?.(sessionId); // disarm too — a now-empty reminder set tears the watcher down.
        return ok({ cancelled: true });
      },
    );
  }

  private buildServer(sessionId: string, role: SessionRole): McpServer {
    const db = this.db;
    const sessions = this.sessions;
    const pty = this.pty;
    const server = new McpServer({ name: "loom-orchestration", version: "0.1.0" });

    // Companion spike: additive, single-session-gated chat_reply (see registerChatReplyIfCompanion).
    this.registerChatReplyIfCompanion(server, sessionId);
    // Companion Phase 2: additive, single-session-gated self-authored skill tools (SAME gate as chat_reply).
    this.registerCompanionSkillTools(server, sessionId);
    // Companion Phase 2: additive, single-session-gated self-authored durable memory tools (SAME gate).
    this.registerCompanionMemoryTools(server, sessionId);
    // Companion Reminders s4: additive, single-session-gated RECURRING reminder tools (SAME gate).
    this.registerCompanionReminderTools(server, sessionId);
    // Companion Capability & Permission-Lever Framework §2: the ONE chokepoint for every opt-in lever
    // (session-status, …) — gated PER-CAPABILITY on a companion_capability_grants row for THIS session,
    // not on companionSessionIds (a lever can be granted even before/without the chat_reply gate, though
    // in practice today's only lever targets the same assistant-role companions). Zero grant rows ⇒ this
    // is a no-op for every session (additive, byte-identical to today). ALSO role-gated to "assistant"
    // (belt-and-suspenders — see registerCompanionCapabilities' doc).
    const attest = createOwnerAttestation(
      { getActiveTurnOwnerText: (sid) => pty?.getActiveTurnOwnerText(sid) ?? null },
      this.ownerConfirmStore,
    );
    // `pty` is optional on this router (see the constructor's own doc) — every method below degrades to a
    // harmless no-op/null when it's absent, exactly like the `attest` wiring just above. `outbound` wraps
    // `this.companion.deliverReply` — the SAME rail `chat_reply` uses (CompanionHooks.deliverReply →
    // ChatGateway.deliverReply), which resolves the delivery target from the CURRENT turn's own origin —
    // a lever never supplies/guesses a route. Missing/failed delivery degrades to `false` (fail closed);
    // never throws.
    registerCompanionCapabilities(server, sessionId, role, db, attest, {
      getActiveTurnOrigin: (sid) => pty?.getActiveTurnOrigin(sid) ?? null,
      // Optional-chained on the METHOD too (not just `pty`): a test double built before this card added
      // getActiveTurnSenderId (every existing companion-lever test's fake pty) must not THROW here — it
      // degrades to null exactly like a real dead/unknown session would, never breaking an existing test.
      getActiveTurnSenderId: (sid) => pty?.getActiveTurnSenderId?.(sid) ?? null,
      enqueueStdin: (sid, text, source, onDeliver, route, kind, questionId) =>
        pty?.enqueueStdin(sid, text, source, onDeliver, route, kind, questionId) ?? { delivered: false, reason: "session-dead" },
    }, {
      deliverToOwner: async (sid, text) => {
        try {
          const result = await this.companion.deliverReply?.(sid, text);
          return result?.delivered === true;
        } catch {
          return false; // fail closed — a throwing delivery path must never look like a successful send.
        }
      },
      // `media-out` lever's own outbound seam (card 3a81b0f2) — mirrors `deliverToOwner` but sends a file.
      // Unlike `deliverToOwner`'s boolean fail-closed contract, the lever needs to tell the difference
      // between "the channel just doesn't support media" (degrade gracefully) and an actual send failure,
      // so this returns the full `{delivered, reason?}` rather than collapsing it to a boolean.
      deliverMediaToOwner: async (sid, filePath) => {
        try {
          const result = await this.companion.deliverMedia?.(sid, filePath);
          return result ?? { delivered: false, reason: "unsupported-channel" };
        } catch {
          return { delivered: false, reason: "send-failed" }; // fail closed — never look like a success.
        }
      },
    }, {
      // `session-steer` lever's own seam (card 305a54fb) — a narrow, SCOPED slice of `SessionService`.
      // message/steer reuse the SAME durable cross-session delivery mechanics as the Platform Lead's own
      // `session_message`/`redirectWorker`, framed distinctly (`[loom:from-owner-via-companion]` /
      // `[loom:from-owner-via-companion:redirect]`); stop/resume reuse `stopSession`/`resume` UNCHANGED —
      // scope/roleFilter/Primitive-A enforcement all live in the lever, not here.
      messageSession: (sid, text, senderSessionId) => sessions.messageSessionAsCompanion(sid, text, senderSessionId),
      redirectSession: (sid, text, senderSessionId) => sessions.redirectSessionAsCompanion(sid, text, senderSessionId),
      stopSession: (sid, mode) => sessions.stopSession(sid, mode),
      resumeSession: (sid) => sessions.resume(sid),
      // `session-spawn` lever's own seam (Tier X, manager|plain ONLY) — the SAME SessionService spawn
      // the Platform Lead's own `session_spawn` uses (mcp/platform.ts). The role refusal is enforced in
      // the LEVER itself (before this is ever called); `senderSessionId` is threaded through for
      // traceability only, mirroring messageSession/redirectSession's own trailing param — the backing
      // op does not itself consume it. `role` is validated to "manager"|"plain" by the lever's own
      // spawnableRoleError guard before this is reachable, so the narrowing cast here is safe.
      spawnSession: (projectId, agentId, role, _senderSessionId) =>
        sessions.spawnSessionAsPlatform(projectId, agentId, role as "manager" | "plain"),
    }, this.trustWindow);

    // Companion (epic Phase 1): the long-lived `assistant` role gets a MINIMAL surface — the read-only
    // my_context PLUS (only when this IS the bound companion session) the chat_reply registered just above.
    // DELIBERATELY no manager spawn/stop/list surface and no writer (least-privilege — the restricted tool
    // profile is a later card). Returns before the manager fall-through below.
    if (role === "assistant") {
      this.registerMyContext(server, sessionId);
      return server;
    }

    if (role === "worker") {
      this.registerMyContext(server, sessionId);
      // A worker's ENTIRE surface: report up to its manager. No spawn/list/stop.
      server.registerTool(
        "worker_report",
        {
          description: "Report your status up to your manager: moves your task (done→review, blocked→waiting) and notifies the manager. Call when done, blocked, or to checkpoint progress. Returns a `deliveryStatus` (delivered-live | queued | boarded | dropped): your manager got it now, it's queued for its next turn, or it's durably boarded for a parked/offline manager (Loom auto-wakes it) — all safe; only `dropped` means it reached nobody. `noChanges` is an OPTIONAL flag on a `done` report for a LEGITIMATE no-op — you reviewed only, investigated and found nothing to change, or your deliverable lives outside this repo (e.g. a mockup) — where the CORRECT outcome is 0 commits. Set it and a 0-commit done skips the 'you likely forgot to commit' warning and auto-retires your session cleanly (frees your manager's concurrency slot, no worker_stop needed) — the same clean exit a declared no-commit role gets. Omit it (or a done that DID commit) and behavior is unchanged; a 0-commit done without it still warns, so don't set it unless the no-op is genuinely intentional.",
          inputSchema: {
            status: z.enum(["done", "blocked", "progress"]),
            summary: z.string(),
            prUrl: z.string().optional(),
            needs: z.string().optional(),
            noChanges: z.boolean().optional(),
          },
        },
        async ({ status, summary, prUrl, needs, noChanges }) =>
          ok(await sessions.workerReport(sessionId, { status, summary, prUrl, needs, noChanges })),
      );
      return server;
    }

    // role === "manager": the full coordination surface.
    const managerSessionId = sessionId;

    this.registerMyContext(server, sessionId);

    // Additive "reported / awaiting-review" projection (read-only — never touches report DELIVERY).
    // A worker that called worker_report(done|blocked) ends its turn and sits at busy:false —
    // indistinguishable in the raw session record from a plain idle-live worker. Derive it from the
    // worker's orchestration_events so a manager can SEE "reported, awaiting review" in
    // worker_status/worker_list without reading the transcript.
    //
    // FRESHNESS — mirrors the busy-worker-watcher's "is this the worker's latest relevant event?"
    // test (it skips a worker_stuck older than the current turn). We can't reuse its `ts > lastActivity`
    // compare directly: setBusy re-stamps last_activity on the end-of-turn FALLING edge too, so a
    // just-reported idle worker's lastActivity lands just AFTER its report — a ts compare couldn't tell
    // "still waiting" from "resumed a new turn." Event ORDERING can: every exit from awaiting-review
    // (manager message_worker → new turn, recycle, stop, merge_request/merge_done) appends a LATER
    // worker-keyed event. So the report is "current" iff it is the worker's MOST-RECENT event
    // (listEventsForWorker is chronological). A later worker_report(progress) is not terminal → not
    // awaiting. reportedState carries the live state when awaiting, else null (kept consistent with
    // awaitingReview so a non-null reportedState always means "waiting on my review right now").
    const reportedProjection = (workerSessionId: string): {
      reportedState: "done" | "blocked" | null;
      awaitingReview: boolean;
    } => {
      const events = db.listEventsForWorker(workerSessionId);
      const latest = events[events.length - 1];
      const status =
        latest?.kind === "worker_report" ? (latest.detail?.status as string | undefined) : undefined;
      return status === "done" || status === "blocked"
        ? { reportedState: status, awaitingReview: true }
        : { reportedState: null, awaitingReview: false };
    };

    // Card 93609ef3: a recycled SUCCESSOR manager (fresh sessionId via recycleManager) must still be able
    // to READ a worker its PREDECESSOR spawned — `recycleManager` only re-parents LIVE workers
    // (reparentLiveWorkers), so a worker that had already reported done/blocked/exited before the recycle
    // keeps `parentSessionId` pointing at the now-retired predecessor, and an exact-match guard locks the
    // successor out of exactly the findings it needs to act on. Scope READS by LINEAGE instead of exact
    // parent: walk both sessions' `recycledFrom` chains to their roots (the same `lineageRootId` helper the
    // Platform Lead resume-doc scoping already uses) and compare roots — same lineage ⇒ readable.
    const workerReadableByManager = (w: { parentSessionId?: string | null }): boolean => {
      if (!w.parentSessionId) return false;
      if (w.parentSessionId === managerSessionId) return true;
      const managerSession = db.getSession(managerSessionId);
      const parentSession = db.getSession(w.parentSessionId);
      if (!managerSession || !parentSession) return false;
      return lineageRootId(db, managerSession) === lineageRootId(db, parentSession);
    };

    // --- Fleet-lockout self-heal (P1: a manager locked out of its OWN live fleet) -------------------
    // SYMPTOM: worker_list returns a manager's workers (exact `parent_session_id` match, db.listWorkers),
    // but every per-id op (worker_status/worker_message/worker_redirect/worker_merge/...) rejected
    // "not your worker" — the WRITE ops (worker_stop/worker_message/worker_redirect/worker_set_mode/
    // worker_recycle/worker_merge/worker_merge_confirm, all via sessions.* in service.ts) do an EXACT
    // `worker.parentSessionId !== managerSessionId` check, unlike the lineage-tolerant read guard just
    // above. The ONLY previously-known recovery was a full daemon_restart (boot-reconcile's
    // reparentLiveWorkers, run only from recycleManager/boot — never on-demand for a LIVE manager whose
    // worker's parent_session_id has otherwise drifted from its own session id).
    //
    // Exact drift MECHANISM is still unconfirmed from source (see the worker task's write-up) — every
    // read of `sessionId` inside a single request is the same closure, and getSession/listWorkers are
    // uncached direct SQL, so the two guards SHOULD always agree from what's visible here. Ship the
    // self-heal as defense-in-depth regardless: it's cheap, safe (scoped to this manager's own lineage,
    // see workerReadableByManager above), and closes the "must restart the whole daemon" gap even if the
    // root cause turns out to be elsewhere (a race, a missed reparent on some other path, etc).
    //
    // FIX: before ANY per-id op reaches its exact-match guard, RE-DERIVE ownership by lineage (the same
    // tolerant check reads already use) and, if this manager's lineage genuinely owns the row but its
    // `parent_session_id` is stale, RELINK it in place (a scoped single-row update — never the bulk
    // process_state='live'-gated reparentLiveWorkers). The downstream exact-match guards in service.ts
    // are UNCHANGED — they still reject a non-owned worker exactly as before; this only ever repairs a
    // row this manager's OWN lineage already owns, so it can never grant access across managers/projects.
    // Logs the disagreement (op, worker id, both session ids) so a genuine repro finally pins the seam.
    const ensureWorkerLinked = (workerSessionId: string, op: string) => {
      const w = db.getSession(workerSessionId);
      if (!w || w.parentSessionId === managerSessionId) return w; // no row, or already correctly linked
      if (!workerReadableByManager(w)) return w; // genuinely not this manager's lineage — leave it to the "not your worker" guard
      console.warn(
        `[orchestration] worker/manager parent desync self-healed: op=${op} worker=${workerSessionId} ` +
        `managerSessionId(closure)=${managerSessionId} row.parentSessionId=${w.parentSessionId ?? "null"}`,
      );
      db.relinkWorkerToManager(w.id, managerSessionId);
      return { ...w, parentSessionId: managerSessionId };
    };

    // The fleet view — the manager's direct children as a compact list. Shared by worker_list and the
    // no-arg worker_status call (a manager's reflexive `worker_status({})` aliases to this rather than
    // throwing a schema-validation error).
    //
    // CLIENT-TIMEOUT RESILIENCE (card fb8df559 Part 1): each real worker row gains a `pendingMerge`
    // field (non-null while a worker_merge_confirm for it is still running its gate) — read-only, never
    // consumed by this view. worker_list's TOP-LEVEL shape stays a BARE ARRAY (no breaking change): a
    // pending worker_spawn has no worker row yet (inserted only once createWorktree resolves), so it's
    // appended as an ADDITIVE PLACEHOLDER row instead — `workerSessionId:null`, `pendingSpawn` set,
    // `processState:"starting"`, `reportedState:null`, `awaitingReview:false`, so an existing "count live
    // workers" / "find one awaiting review" consumer skips it rather than miscounting a phantom worker.
    //
    // `rateLimitedUntil`/`rateLimitDeadline` (card b16320bc): additive — a non-limited worker's row is
    // otherwise unchanged, both fields simply read null. Without this, a worker parked on a usage cap
    // (§19c — detectUsageLimit's StopFailure signal, or the weekly/account TEXT-sentinel fallback in
    // pty/host.ts) showed as plain `busy:false` here, indistinguishable from a healthy idle worker; a
    // manager had to worker_status(id) — or read the transcript — to discover the park. worker_status(id)
    // already surfaced both fields (it returns the full session record), so this closes the SAME gap for
    // the fleet view without adding a new field/scanner.
    //
    // `lastEngineOutputAt`: an INTRA-TURN liveness signal, additive alongside the DB-persisted
    // `lastActivity` (which only moves at turn boundaries — hook events). Reads pty/host.ts's in-memory
    // `Live.lastOutputAt`, stamped on EVERY engine-output chunk (already fed to the busy-stale self-heal —
    // see healIfStuck) — so it keeps advancing THROUGH a single long turn and only goes stale once the
    // engine truly stops producing. Lets a manager tell "busy + progressing" (recent) from "possibly
    // wedged" (stale) at a glance, without spending a worker_transcript pull. `undefined` (session not
    // live in this process, e.g. exited/never spawned here) reads as `null`, same as every other
    // optional field on this row.
    const fleetView = () => {
      const workers = db.listWorkers(managerSessionId).map((w) => ({
        workerSessionId: w.id,
        taskId: w.taskId ?? null,
        processState: w.processState,
        busy: w.busy,
        branch: w.branch ?? null,
        ctxInputTokens: w.ctxInputTokens ?? null,
        model: w.model ?? null,
        lastActivity: w.lastActivity,
        lastEngineOutputAt: pty?.getLastOutputAt(w.id) ?? null,
        pendingMerge: sessions.peekPendingMerge(w.id) ?? null,
        rateLimitedUntil: w.rateLimitedUntil ?? null,
        rateLimitDeadline: w.rateLimitDeadline ?? null,
        ...reportedProjection(w.id),
      }));
      const pendingSpawns = sessions.listPendingSpawns(managerSessionId).map((op) => ({
        workerSessionId: null,
        taskId: op.taskId,
        processState: "starting" as const,
        busy: false,
        branch: null,
        ctxInputTokens: null,
        model: null,
        lastActivity: op.startedAt,
        lastEngineOutputAt: null,
        pendingMerge: null,
        rateLimitedUntil: null,
        rateLimitDeadline: null,
        pendingSpawn: { opId: op.opId, startedAt: op.startedAt },
        reportedState: null,
        awaitingReview: false,
      }));
      // A worker_spawn REJECTED purely because the concurrency cap was full gets its own ADDITIVE
      // placeholder row — distinct from `pendingSpawn` above (which is an IN-FLIGHT spawn still
      // provisioning): this one never started at all. `workerSessionId:null`,
      // `processState:"cap-queued"` (a value no real worker row ever has), `reportedState:null`,
      // `awaitingReview:false` — so an existing "count live workers" / "find one awaiting review"
      // consumer skips it exactly like a pendingSpawn row. See CapQueueRegistry's class doc: this is a
      // VISIBILITY marker only — nothing auto-dispatches it; the manager re-drives it via worker_spawn.
      const capQueued = sessions.listCapQueuedSpawns(managerSessionId).map((e) => ({
        workerSessionId: null,
        taskId: e.taskId,
        processState: "cap-queued" as const,
        busy: false,
        branch: null,
        ctxInputTokens: null,
        model: null,
        lastActivity: e.queuedAt,
        lastEngineOutputAt: null,
        pendingMerge: null,
        rateLimitedUntil: null,
        rateLimitDeadline: null,
        capQueued: { opId: e.opId, agentId: e.agentId, taskId: e.taskId, kickoffLabel: e.kickoffLabel, queuedAt: e.queuedAt },
        reportedState: null,
        awaitingReview: false,
      }));
      return [...workers, ...pendingSpawns, ...capQueued];
    };

    server.registerTool(
      "worker_list",
      { description: "List the workers you (this manager) have spawned — your direct children. `reportedState` (done|blocked|null) + `awaitingReview` flag a worker that has called worker_report and is sitting idle awaiting your review (cleared once it resumes a turn / is merged). `pendingMerge` (non-null) on a row means a worker_merge_confirm for it is still running its gate in the background — poll here or re-call worker_merge_confirm to fetch the result once ready. `rateLimitedUntil`/`rateLimitDeadline` (non-null) mean the worker is PARKED ON A USAGE CAP — busy will read false but this is NOT a healthy idle worker; it resumes on its own once `rateLimitedUntil` passes (`rateLimitDeadline` is the give-up horizon). `lastEngineOutputAt` is an INTRA-TURN liveness signal, distinct from `lastActivity` (which only moves at turn boundaries): it advances on every chunk of engine output, so it keeps moving THROUGH a single long turn — a recent `lastEngineOutputAt` on a `busy:true` row means the engine is actively producing (busy + progressing); a stale one means it may be wedged. Cheaper than a worker_transcript pull just to check liveness. `null` means the session isn't live in this daemon process. A worker_spawn still running past the sync-wait budget shows up as an ADDITIVE placeholder row: `workerSessionId:null`, `pendingSpawn:{opId,startedAt}`, `processState:\"starting\"` — not a real worker yet, so don't count it as live or awaiting review; poll here or re-call worker_spawn (same taskId/agentId/kickoffPrompt) to fetch the result. A worker_spawn REJECTED outright because the concurrency cap was full ALSO shows up as an ADDITIVE placeholder row — distinct from the pending one above: `workerSessionId:null`, `processState:\"cap-queued\"`, `capQueued:{opId,agentId,taskId,kickoffLabel,queuedAt}` — the intent never started at all, it's just a VISIBILITY marker so you don't forget to re-drive it; nothing auto-dispatches it, and it clears itself once you successfully worker_spawn the same taskId (or, for a taskless spawn, the same agentId) again. Never count either placeholder as live or awaiting review.", inputSchema: {} },
      async () => ok(fleetView()),
    );

    server.registerTool(
      "worker_status",
      {
        description: "Get the full session record for one of your workers, by workerSessionId. Includes the derived `reportedState` (done|blocked|null) + `awaitingReview` flag — set when the worker has called worker_report and is idle awaiting your review, cleared once it resumes a turn / is merged. Also includes `lastEngineOutputAt`, the intra-turn liveness signal (see worker_list) — recent vs. `lastActivity` tells you whether a busy worker is actively progressing or possibly wedged. Called with NO workerSessionId, it returns the fleet view (same as worker_list) so a reflexive no-arg call just works.",
        inputSchema: { workerSessionId: z.string().optional() },
      },
      async ({ workerSessionId }) => {
        // No id → fleet view (alias worker_list), so worker_status({}) never throws a schema error.
        if (!workerSessionId) return ok(fleetView());
        const w = ensureWorkerLinked(workerSessionId, "worker_status");
        if (!w || !workerReadableByManager(w)) return ok({ error: "not your worker" });
        return ok({
          ...w,
          lastEngineOutputAt: pty?.getLastOutputAt(w.id) ?? null,
          pendingMerge: sessions.peekPendingMerge(w.id) ?? null,
          ...reportedProjection(w.id),
        });
      },
    );

    server.registerTool(
      "worker_transcript",
      {
        description:
          "Read one of your workers' transcript as clean ordered turns. PAGINATION: a large transcript " +
          "would overflow the tool-result cap (and spill to an unreadable 1-line temp file), so reads are " +
          "bounded to ONE page — the SAME envelope the auditor's transcript_read uses. With NO paging arg " +
          "a transcript that fits one page returns the bare turns array (as before); otherwise — or " +
          "whenever you pass offset/limit/turnRange — it returns a page envelope {turns, totalTurns, " +
          "offset, returned, nextOffset}. Page deterministically by calling again with offset:nextOffset " +
          "until nextOffset is null (covers the whole transcript, no gaps/overlaps). `lastN` is a SEPARATE " +
          "backward-compat shortcut for 'just the last N turns': it takes PRECEDENCE over offset/limit/ " +
          "turnRange (pass one style or the other, not both) and always returns the bare last-N array, " +
          "never a page envelope.",
        inputSchema: {
          workerSessionId: z.string(),
          lastN: z.number().optional(),
          offset: z.number().int().nonnegative().optional(),
          limit: z.number().int().positive().optional(),
          turnRange: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]).optional(),
        },
      },
      async ({ workerSessionId, lastN, offset, limit, turnRange }) => {
        const w = ensureWorkerLinked(workerSessionId, "worker_transcript");
        if (!w || !workerReadableByManager(w)) return ok({ error: "not your worker" });
        const turns = w.engineSessionId ? readTranscript(w.cwd, w.engineSessionId) : [];
        if (typeof lastN === "number" && lastN > 0) return ok(turns.slice(-lastN));
        const page = pageTranscript(turns, { offset, limit, turnRange });
        const explicit = offset !== undefined || limit !== undefined || turnRange !== undefined;
        return ok(!explicit && page.offset === 0 && page.nextOffset === null ? page.turns : page);
      },
    );

    server.registerTool(
      "worker_relink",
      {
        description:
          "Explicit self-heal backstop for ONE worker: re-derive its ownership by lineage and repair a " +
          "stale `parent_session_id` in place, WITHOUT a daemon restart. Every other per-worker tool " +
          "(worker_status/worker_transcript/worker_message/worker_redirect/worker_stop/worker_set_mode/" +
          "worker_recycle/worker_merge/worker_merge_confirm) already runs this SAME repair automatically " +
          "before it acts, so you normally never need to call this directly — it exists as a standalone " +
          "diagnostic/backstop (e.g. to eagerly repair a worker, or confirm its link status, before " +
          "touching it any other way). Scoped to YOUR OWN lineage ONLY (walks the same recycledFrom-chain " +
          "check every read tool uses) — can never relink a worker belonging to another manager or another " +
          "project. Returns {found, wasStale, relinked, parentSessionId} — relinked (and wasStale, always " +
          "equal) is true only if a stale link was actually repaired just now; false with found:true means " +
          "NOTHING was relinked — check `parentSessionId` to tell why: equal to your OWN session id means " +
          "it was already correctly linked, any other id means the worker genuinely isn't yours.",
        inputSchema: { workerSessionId: z.string() },
      },
      async ({ workerSessionId }) => {
        const before = db.getSession(workerSessionId);
        if (!before) return ok({ found: false, wasStale: false, relinked: false, parentSessionId: null });
        const alreadyLinked = before.parentSessionId === managerSessionId;
        const owned = workerReadableByManager(before);
        const after = ensureWorkerLinked(workerSessionId, "worker_relink");
        return ok({
          found: true,
          wasStale: owned && !alreadyLinked,
          relinked: owned && !alreadyLinked,
          parentSessionId: after?.parentSessionId ?? before.parentSessionId ?? null,
        });
      },
    );

    server.registerTool(
      "worker_spawn",
      {
        description: "Spawn a worker: creates an isolated git worktree + branch and starts a worker session in it. agentId is REQUIRED and must be an explicit WORKER agent (e.g. Dev/Bugfix/QA/Docs) — NEVER your own manager agent. Spawning under a manager/platform-role agent is rejected. agentId accepts EITHER the agent's id OR its NAME/slug (resolved within your project; a bad value returns a 'did you mean' hint). taskId is OPTIONAL — pass it to bind the worker to a board task (moves the task to in_progress; accepts EITHER the full id OR an unambiguous 8-char id-prefix, resolved within your project; an ambiguous prefix errors naming the candidate ids); OMIT it for a TASKLESS spawn — an ad-hoc spike/no-commit worker (e.g. a read-only Code Reviewer pointed at another worker's branch via its kickoffPrompt) that gets its own isolated worktree with no board card to falsify or hijack. A taskless worker reports up via worker_report exactly like a tasked one, just with no card to move — it never lands in a review lane, so retire it yourself with worker_stop once you've read its report. If it produced commits you actually want landed, worker_merge_confirm still works on it (the branch merges onto main; there's just no card to move to done, since it never had one) — task it for real instead if you want the normal review-lane flow. The one-live-worker-per-task guard only ever applies to a REAL taskId — a taskless spawn never competes for it (so a read-only reviewer can run alongside a live author on the SAME logical work without a throwaway vehicle card, and two taskless spawns never collide with each other). CLIENT-TIMEOUT RESILIENT: a fast spawn returns {workerSessionId,branch,worktreePath} exactly as before; a slow one (worktree provisioning taking a while) instead returns {opId,status:\"pending\",taskId} — poll via worker_list (a placeholder row) or RE-CALL worker_spawn with the SAME taskId (or the same omission)/agentId/kickoffPrompt (idempotent-retryable for a TASKED retry: it attaches to the SAME in-flight spawn rather than starting a second one, and never throws 'already in flight'; a TASKLESS retry has no stable identity to dedupe against and may start a second taskless worker — retire the extra with worker_stop if so). WASTED-DISPATCH ADVISORY (tasked spawns only): if the card's title already appears — verbatim, once coerced to a commit subject the same way a squash-merge coerces one — as a commit on the project's mainline within its recent history, the result ALSO carries `shippedMatch:{sha,subject,mainBranch}` plus a human-readable `warning` naming the matching commit; this NEVER blocks the spawn (the worker still starts) — it's a flag for YOU to verify before letting it proceed, since the fix may already be shipped. Absent on a non-match, a taskless spawn, or any other spawn shape (byte-identical to before). CONCURRENCY-CAP REJECTION: if the cap is full, the result is `{error:\"concurrency cap reached (N)\"}` exactly as before, PLUS `capQueued:{opId,taskId,queuedAt}` — the intent was recorded and is now visible as a placeholder row in worker_list, so it's never silently lost; re-call worker_spawn with the same args once a slot frees (nothing auto-dispatches it for you).",
        inputSchema: {
          taskId: z.string().optional(),
          agentId: z.string(),
          kickoffPrompt: z.string(),
        },
      },
      async ({ taskId, agentId, kickoffPrompt }) => {
        // A usage-limit refusal carries a STRUCTURED retry-after deadline (PL Auditor finding #7) so the
        // manager can schedule a wake to it instead of guessing (and the daemon also auto-wakes it on
        // hold-clear). Surface `retryAfter` alongside the message — NOT a bare string. A concurrency-cap
        // refusal similarly carries the recorded cap-queued marker — surface `capQueued` alongside the
        // message so the caller knows the intent is now visible in worker_list, not lost. Neither
        // spawnWorkerTracked throws synchronously (a slow/attached call resolves through the registry
        // instead), so both are checked on BOTH the settled-failed result AND a defensive catch below.
        const asUsageLimitOrMessage = (e: unknown) =>
          e instanceof UsageLimitError ? { error: e.message, retryAfter: e.retryAfter }
          : e instanceof CapQueueRejectedError ? { error: e.message, capQueued: e.capQueued }
          : { error: e instanceof Error ? e.message : String(e) };
        try {
          const r = await sessions.spawnWorkerTracked(managerSessionId, { taskId, agentId, kickoffPrompt });
          if (!r.settled) return ok({ opId: r.op.opId, status: "pending", taskId, note: "still spawning — poll worker_list (a pendingSpawn placeholder row) or re-call worker_spawn with the SAME taskId/agentId/kickoffPrompt to fetch the result once ready." });
          if (!r.ok) return ok(asUsageLimitOrMessage(r.error));
          const worker = r.value;
          // Wasted-dispatch advisory (card 7b5944fc): additive-only — omitted entirely on no match, so a
          // non-matching spawn's result is byte-identical to before this field existed.
          const shipped = worker.shippedMatch
            ? {
                shippedMatch: worker.shippedMatch,
                warning: `heads up: this card's title matches merged commit ${worker.shippedMatch.sha} ('${worker.shippedMatch.subject}') on ${worker.shippedMatch.mainBranch} — it may already be shipped; verify before proceeding.`,
              }
            : {};
          return ok({ workerSessionId: worker.id, branch: worker.branch, worktreePath: worker.worktreePath, ...shipped });
        } catch (e) {
          // Other refusals (paused / over-cap / bad task) stay a bare { error } string — same envelope as
          // the sibling lifecycle tools.
          return ok(asUsageLimitOrMessage(e));
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
          ensureWorkerLinked(workerSessionId, "worker_stop");
          sessions.stopWorker(managerSessionId, workerSessionId, mode ?? "graceful");
          return ok({ stopped: true });
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "worker_set_mode",
      {
        description:
          "Drive one of your workers' permission mode to an ABSOLUTE target — the manual recovery override " +
          "for when a worker has landed in (or been pushed into) a bad mode. A worker can NEVER change its " +
          "own mode (Shift+Tab is a human TUI keystroke; ExitPlanMode/EnterPlanMode are disallowed for a " +
          "worker), so messaging it can't fix a bad mode — this is daemon-driven instead. mode is ONE of " +
          "acceptEdits|auto|plan (bypassPermissions and anything else are REJECTED — a worker must never be " +
          "escalated out of its sandbox). Pure keystroke injection: bypasses the busy/turn queue (~0 worker " +
          "tokens), does not submit a turn. Returns the FEEDBACK-VERIFIED landed mode (read off the footer " +
          "after the cycle settles) — may differ from `mode` if the cycle gave up early.",
        inputSchema: { workerSessionId: z.string(), mode: z.enum(["acceptEdits", "auto", "plan"]) },
      },
      async ({ workerSessionId, mode }) => {
        try {
          ensureWorkerLinked(workerSessionId, "worker_set_mode");
          const landed = await sessions.setWorkerMode(managerSessionId, workerSessionId, mode);
          return ok({ landed });
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "worker_message",
      {
        description: "Send a message to one of your workers. Submitted as a turn if the worker is idle; queued FIFO and delivered on its next turn boundary if it's mid-turn. If several messages stack up while it's busy, they're COALESCED and delivered together as ONE turn (FIFO order, newest last) — so a later message supersedes/augments earlier ones in the same turn rather than replaying one-per-turn. On `delivered:false`, `reason` tells you which: \"held\" (queued, will land) vs \"session-dead\" (the worker is gone — DROPPED, not queued; re-dispatch or recycle instead of waiting).",
        inputSchema: { workerSessionId: z.string(), text: z.string() },
      },
      async ({ workerSessionId, text }) => {
        try {
          ensureWorkerLinked(workerSessionId, "worker_message");
          return ok(sessions.messageWorker(managerSessionId, workerSessionId, text));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "worker_redirect",
      {
        description:
          "FORCEFULLY redirect one of your workers — the \"land it NOW\" steer. This ENDS the worker's " +
          "CURRENT turn immediately and REPLACES its entire pending direction with this ONE instruction, " +
          "delivered as its next turn. Use it ONLY when you must change course NOW and cannot wait for the " +
          "worker to finish — e.g. you've spotted it building the wrong thing. CONTRAST with worker_message, " +
          "which is ADDITIVE and NON-interrupting (it queues behind the current turn and coalesces with other " +
          "pending messages); prefer worker_message unless you truly need to interrupt. " +
          "CAUTION: the interrupt may land MID-EDIT, leaving the worker's working tree partly changed — so " +
          "phrase `text` so the worker FIRST reconciles/inspects its working tree (e.g. `git status`, finish " +
          "or revert the half-done edit) BEFORE acting on the new direction. Any messages that were queued for " +
          "the worker are discarded (superseded by this one). Returns {delivered} — true if it went out as a " +
          "turn immediately (worker was idle), false if queued to land right after the interrupt clears.",
        inputSchema: { workerSessionId: z.string(), text: z.string() },
      },
      async ({ workerSessionId, text }) => {
        try {
          ensureWorkerLinked(workerSessionId, "worker_redirect");
          return ok(sessions.redirectWorker(managerSessionId, workerSessionId, text));
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
          "those reports otherwise sit queued and later surface as a redundant wasted turn (coalesced into one). " +
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

    // --- Manager→human Requests object (card 8701bdbb, generalized by card 695ebab0) ---------------
    // ask (question_ask) is NON-BLOCKING by design: it inserts a 'pending' row and returns immediately
    // so an autonomous manager keeps orchestrating the rest of its fleet instead of stalling on a human
    // reply. The human answers it OUT OF BAND (the human-only REST endpoint in gateway/server.ts — the
    // web UI for that is a separate child B), which ALSO enqueues a one-time push nudge into this
    // manager's own pty (reusing the existing enqueueStdin(kind:"agent") rail — see gateway/server.ts).
    // pull (question_pull) is the manager's own pickup: it atomically reads+consumes every 'answered'
    // question so a durable answer survives a daemon restart and is still pullable after resume.
    server.registerTool(
      "question_ask",
      {
        description:
          "Ask the HUMAN something you need them for — NON-BLOCKING: creates a durable, answerable " +
          "request and returns IMMEDIATELY, so you keep orchestrating the rest of your fleet instead of " +
          "blocking this turn on a reply. `title`+`body` frame the ask. `type` picks the shape (defaults " +
          "to \"decision\"): \"decision\" — `options` is an OPTIONAL array of choices for the human to " +
          "pick between (omit for a pure blocker — free-text note only) and `recommendation` is an " +
          "OPTIONAL suggested answer shown as a nudge, not enforced. \"input\" — a freeform-text ask, no " +
          "options. \"permission\" — ask the human to authorize/deny an irreversible/outward/spend " +
          "action; `action` (REQUIRED) describes it, `scope` (\"once\"|\"standing\", optional) is the " +
          "requested grant lifetime, `expiresAt` (optional ISO timestamp) is a requested expiry — this is " +
          "an ask/answer channel, not a second gate: it does not itself block anything, so if the action " +
          "must actually WAIT on the answer, hold it yourself. \"credential\" — ask for a secret " +
          "(API key/token) under a NEVER-ECHO model: you will NEVER receive the plaintext, only an ack " +
          "once it's provided; `envVar` (optional) hints the env var/config key you expect it under. " +
          "`taskId` (optional) softly links this to a board task. You'll get a one-time push nudge into " +
          "your own session when the human answers; call question_pull (e.g. when you reach the point " +
          "this was blocking) to fetch the answer. Returns {questionId}.",
        inputSchema: QUESTION_ASK_INPUT_SHAPE,
      },
      async (input) => {
        const projectId = db.getSession(managerSessionId)?.projectId;
        if (!projectId) return ok({ error: "no project for this session" });
        const built = buildQuestionAsk(input, { sessionId: managerSessionId, projectId, db });
        if ("error" in built) return ok({ error: built.error });
        const { question } = built;
        db.insertQuestion(question);
        // Event-emit twin (attention-push signal source, Lead fork 2b) — additive, no existing consumer
        // (alert-webhook's events[] allowlist, web attention) lists this new kind, so this is inert for them.
        db.appendEvent({
          id: randomUUID(), ts: question.createdAt, managerSessionId,
          kind: "question_asked", detail: { questionId: question.id, title: question.title },
        });
        return ok({ questionId: question.id });
      },
    );

    server.registerTool(
      "question_pull",
      {
        description:
          "Pull (return AND consume) every ANSWERED request you've asked via question_ask — your " +
          "requests-inbox pickup. Each entry carries {questionId, title, type, ...}: a \"decision\"/" +
          "\"input\" entry has {chosenOption, note} (chosenOption is one of the options you offered, or " +
          "null); a \"permission\" entry has {approved, note}; a \"credential\" entry has {ack} — NEVER " +
          "the secret itself. Pulling consumes them in one shot (flips them to 'consumed') so they won't " +
          "be returned again — call this when you reach the point the request was blocking, or after the " +
          "push nudge tells you one was answered. Returns {questions: [...]} (empty if none are answered " +
          "yet — a still-'pending' request is NOT returned; keep orchestrating and check back later).",
        inputSchema: {},
      },
      async () => {
        // Scoped by AGENT LINEAGE, not this exact session id (card f88e91f0) — so a fresh (non-recycle)
        // successor manager on the SAME agent still sees decisions its predecessor filed, not just a
        // recycle successor (which reparentQuestions already handles as a fast path).
        const asker = db.getSession(managerSessionId);
        if (!asker) return ok({ error: "session not found" });
        const answered = db.pullAnsweredQuestionsForAgent(asker.agentId, new Date().toISOString());
        // Purge any OTHER still-queued answer-nudge for a question this same pull just consumed — a
        // multi-answer batch enqueues one nudge per answer, but this pull drains them all atomically, so
        // every nudge past the first is now stale (card bbc46336 follow-up). Does not touch the nudge for
        // whichever question drained AS this turn (it already delivered — never queued).
        if (answered.length > 0) {
          sessions.purgeAnsweredQuestionNudges(managerSessionId, answered.map((q) => q.id));
        }
        return ok({ questions: answered.map(questionPullItem) });
      },
    );

    // requests_list (card 988bb585 follow-up): a NON-CONSUMING, board-wide read of YOUR OWN project's
    // Requests — the gap between question_pull (consumes, answered-only, no taskId filter) and
    // task_requests_list/task_request_get (task-scoped only). Mirrors the Platform Auditor's cross-project
    // requests_list (mcp/audit.ts) — same filters, same per-type answer shaping (questionTool.ts's
    // auditRequestItem/questionAnswerByType) so the credential never-echo guarantee can't drift between the
    // two read surfaces — but scoped SERVER-SIDE to this manager's own project (no projectId param; a
    // manager can never read another project's requests, unlike the Auditor's platform-wide read).
    server.registerTool(
      "requests_list",
      {
        description:
          "List Requests (decision/input/permission/credential asks) for YOUR OWN project, board-wide — " +
          "the non-consuming complement to question_pull (which only returns ANSWERED requests and " +
          "CONSUMES them). Use this to survey pending/answered/consumed requests, including ones asked " +
          "with no taskId or asked by a predecessor manager on this project. NON-CONSUMING — reading NEVER " +
          "drains or flips state; calling it twice returns the same records. Returns, per row: {id, " +
          "projectId, sessionId, agentId, taskId, type, title, state, createdAt, answeredAt, consumedAt} " +
          "plus an answer summary by type — chosenOption/note for decision|input, approved/note for " +
          "permission, ack ONLY for credential (NEVER the secret — a pending row's answer fields read null " +
          "rather than a misleading false-ish value). Filters (all optional, AND'd): state " +
          "(pending|answered|consumed), type (decision|input|permission|credential), includeConsumed " +
          "(false by default — folds already-consumed requests in alongside the rest; an explicit " +
          "state:\"consumed\" always shows consumed regardless of this flag). Newest-first (createdAt DESC).",
        inputSchema: {
          state: z.enum(QUESTION_STATES).optional(),
          type: z.enum(QUESTION_TYPES).optional(),
          includeConsumed: z.boolean().optional(),
        },
      },
      async ({ state, type, includeConsumed }) => {
        const projectId = db.getSession(managerSessionId)?.projectId;
        if (!projectId) return ok({ error: "no project for this session" });
        const rows = db.listQuestionsForAudit({ projectId, state, type, excludeConsumed: !includeConsumed });
        return ok(rows.map(auditRequestItem));
      },
    );

    server.registerTool(
      "worker_recycle",
      {
        description: "Recycle a worker whose context has grown too large: closes it and spawns a FRESH worker in the SAME git worktree (code state kept) seeded with your handoff summary (intent kept). Same task + branch; gen+1. Read worker_transcript first and write the summary. `handoffSummary` is the canonical param; `continuationPrompt` (the sibling recycle_me tool's name for the same concept) is accepted as an ALIAS — pass either one (if both are given, handoffSummary wins).",
        inputSchema: { workerSessionId: z.string(), handoffSummary: z.string().optional(), continuationPrompt: z.string().optional() },
      },
      async ({ workerSessionId, handoffSummary, continuationPrompt }) => {
        const summary = handoffSummary ?? continuationPrompt;
        if (!summary) return ok({ error: "handoffSummary (or continuationPrompt) is required" });
        try {
          ensureWorkerLinked(workerSessionId, "worker_recycle");
          const fresh = await sessions.recycleWorker(managerSessionId, workerSessionId, summary);
          return ok({ newWorkerSessionId: fresh.id, gen: fresh.gen, recycledFrom: fresh.recycledFrom });
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "worker_merge",
      {
        description:
          "STEP 1 of the merge gate: review a worker's branch diff. By DEFAULT returns a bounded DIFFSTAT — " +
          "the list of changed files with per-file +/- and the insertion/deletion totals — so it will NOT " +
          "overflow the display on a large change (where the full patch is biggest/riskiest). Pass " +
          "fullDiff:true to ALSO get the full unified patch for line-level review (the full patch is " +
          "unbounded and may itself overflow on a very large change — review the diffstat first, then pull " +
          "the patch). Pass `files` (an array of exact/substring path matches) and/or `pathGlob` (a glob " +
          "like 'packages/daemon/src/mcp/*.ts') to scope BOTH the diffstat and the patch to matching file(s) " +
          "— pull one file's hunk at a time on a large multi-file change instead of the whole patch. Omit " +
          "both for the full unfiltered diff (unchanged). If the (possibly filtered) patch is still too " +
          "large to inline safely, it's written to a scratch file instead — UTF-8, real line breaks, " +
          "Read-pageable with offset/limit — and the response carries patchFile/patchChars + a note in " +
          "place of the inline patch. No merge happens; you must review before confirming (there is no " +
          "worker-side merge).",
        inputSchema: { workerSessionId: z.string(), fullDiff: z.boolean().optional(), files: z.array(z.string()).optional(), pathGlob: z.string().optional() },
      },
      async ({ workerSessionId, fullDiff, files, pathGlob }) => {
        try {
          ensureWorkerLinked(workerSessionId, "worker_merge");
          return ok(await sessions.reviewWorkerMerge(managerSessionId, workerSessionId, { includePatch: fullDiff === true, files, pathGlob }));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "worker_merge_confirm",
      {
        description: "STEP 2: after reviewing, confirm the merge. Runs the build/DoD gate, and ONLY if green merges the branch as ONE squash commit, removes the worktree, and moves the task to done. The staged set is re-derived at confirm time (never a stale snapshot), so a valid +N-commit branch merges on the FIRST call. Fail-closed: a failed gate or a conflict leaves the repo untouched and the worktree retained. A genuine no-op is distinguishable via emptyKind: ALREADY_MERGED (branch already in main → finished idempotently, merged:true) vs STAGE_EMPTY_RETRY (no diff to merge → merged:false, worktree retained). A gate rejection (reason:\"build gate failed\") carries `gateDetail: {phase, failedStep, failingTest, stderrTail, exitCode, signal, timedOut}` — the failing phase (typecheck|test|build) if derivable, the failed step's own command, the first recognizable failing-test/assertion line if extractable, and a bounded (~4KB) stdout+stderr tail — so you can diagnose a real test failure vs. a flake vs. a build break without re-running the gate blind; the same detail is also folded into the `[loom:merge-rejected]` notification text. If the project has NO gateCommand configured, a successful merge carries {warning:\"unverified: ...\"} — the merge landed but was NOT checked by any build/DoD gate. NESTED-REPO SAFETY: after a successful merge, the worktree is force-removed (it always carries expected ephemeral untracked content — node_modules, dist, build caches). If the worktree ALSO contains a nested git repository (a subdirectory with its own `.git` — e.g. something cloned into it, which can hold real unpushed work), the removal is REFUSED and the worktree is RETAINED intact — the merge itself already landed, only the cleanup is deferred; the result carries {warning} naming the nested path(s). Move/push that content out yourself and re-confirm, or pass forceRemoveWorktree:true if you've confirmed the nested content is disposable (default false — the safe choice). CLIENT-TIMEOUT RESILIENT: a fast confirm returns {merged,...,opId} exactly as before (now stamped with a correlation `opId`); a slow one (the gate genuinely takes a while) instead returns {opId,status:\"pending\",workerSessionId} — rather than polling, wait for the async `[loom:merge-done]`/`[loom:merge-rejected]`/`[loom:merge-failed]` nudge, which carries this SAME opId (plus the worker/task) so you can match it to this call even with several merges pending at once; or poll via worker_list (this worker's `pendingMerge` field) or RE-CALL worker_merge_confirm with the SAME workerSessionId (idempotent-retryable: it attaches to the SAME in-flight gate/merge rather than re-running it, and never throws 'already in flight').",
        inputSchema: { workerSessionId: z.string(), forceRemoveWorktree: z.boolean().optional() },
      },
      async ({ workerSessionId, forceRemoveWorktree }) => {
        try {
          ensureWorkerLinked(workerSessionId, "worker_merge_confirm");
          const r = await sessions.confirmWorkerMergeTracked(managerSessionId, workerSessionId, forceRemoveWorktree);
          if (!r.settled) return ok({ opId: r.op.opId, status: "pending", workerSessionId, note: "gate/merge still running — poll worker_list (this worker's pendingMerge field) or re-call worker_merge_confirm with the SAME workerSessionId to fetch the result once ready." });
          if (!r.ok) return ok({ error: r.error instanceof Error ? r.error.message : String(r.error) });
          return ok(r.value);
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
          "{restarting:true} on success, or {restarting:false, error} if unsupervised / build failed. If the " +
          "deploy going live also touches scripts/daemon-supervisor.mjs (the OUTER process that spawned this " +
          "daemon and is NOT re-execed by this restart), the success result additionally carries " +
          "{supervisorChanged:true, supervisorWarning} — those lines are silently inert until a human does a " +
          "manual `pnpm daemon:stable`; never report that part of the change as fully live.",
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
      "deploy",
      {
        description:
          "Deploy/push YOUR OWN project — least-privilege, no promotion to a cross-project Lead needed. " +
          "Runs the project's HUMAN-configured `orchestration.deployCommand` (a build script, `git push`, " +
          "or a deploy webhook curl — whatever the owner set up) in the project's own repo, bounded by a " +
          "per-project timeout. There is NO projectId/host/branch/repo param — the project is always YOUR " +
          "OWN, derived server-side from this session; you can never deploy anything else. Refuses with " +
          "{deployed:false,reason} if the project has no deployCommand configured (ask the owner to set " +
          "one — it's a human-only, opt-in-once setting) or if you've hit the per-manager deploy rate " +
          "limit. `reason` is a short note for the audit trail only — it is never part of the command run. " +
          "On success returns {deployed:true}; on a failed run returns {deployed:false,reason,exitCode," +
          "outputTail} with a bounded stdout+stderr tail to diagnose from.",
        inputSchema: { reason: z.string() },
      },
      async ({ reason }) => {
        try {
          return ok(await sessions.deployOwnProject(managerSessionId, reason));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    // GAP 2: a deploy/served-state read so post-daemon_restart verification doesn't need curl. Minimal by
    // design — just what's trivially available server-side: the umbrella package version, the served web
    // bundle's asset filename (Vite hashes it, e.g. "index-Ab12Cd34.js", so a changed hash after a restart
    // proves the NEW web build actually went live — null if the dist isn't built/found), this daemon
    // process's uptime, and a cross-project live-session count (a coarse "the fleet is still here"
    // sanity check, not a per-project breakdown — worker_list/worker_status already cover that scoped view).
    server.registerTool(
      "served_status",
      {
        description:
          "Read what THIS daemon process is actually serving right now — for post-daemon_restart " +
          "verification without falling back to curl. Returns {version (the loom/loomctl package version), " +
          "webBundle (the served assets/index-<hash>.js filename, or null if the web dist isn't built/found " +
          "— a changed hash after a restart proves the new web build is live), uptimeSeconds (this process's), " +
          "liveSessionCount (ACROSS ALL projects — a coarse sanity signal; use worker_list for your own " +
          "fleet)}.",
        inputSchema: {},
      },
      async () => {
        const webDist = resolveWebDistDir();
        let webBundle: string | null = null;
        try {
          const assetsDir = path.join(webDist, "assets");
          webBundle = fs.readdirSync(assetsDir).find((f) => /^index-.*\.js$/.test(f)) ?? null;
        } catch { /* dist not built / no assets dir — webBundle stays null */ }
        const liveSessionCount = db.listAllSessions().filter((s) => s.processState === "live").length;
        return ok({ version: loomVersion(), webBundle, uptimeSeconds: Math.round(process.uptime()), liveSessionCount });
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
          "continuationPrompt, re-parents your live workers onto it, and then closes you. `continuationPrompt` " +
          "is the canonical param; `handoffSummary` (the sibling worker_recycle tool's name for the same " +
          "concept) is accepted as an ALIAS — pass either one (if both are given, continuationPrompt wins).",
        inputSchema: { continuationPrompt: z.string().optional(), handoffSummary: z.string().optional() },
      },
      async ({ continuationPrompt, handoffSummary }) => {
        const prompt = continuationPrompt ?? handoffSummary;
        if (!prompt) return ok({ error: "continuationPrompt (or handoffSummary) is required" });
        try {
          const fresh = await sessions.recycleManager(managerSessionId, prompt);
          return ok({ newManagerSessionId: fresh.id, gen: fresh.gen });
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    // end_me — the no-successor sibling of recycle_me (card 3b015fc7). Self-scoped: NO target arg, always
    // ends managerSessionId (the URL-path session), never another. Two gates (queued inbound / live
    // workers) may REFUSE — see SessionService.endMe's doc for the full contract.
    server.registerTool(
      "end_me",
      {
        description:
          "Request graceful termination of YOUR OWN session — a terminal exit, NO successor (unlike " +
          "recycle_me, which hands off to a fresh one). Takes no argument: Loom always ends the session " +
          "calling this tool, never another. Loom runs two safety checks first and REFUSES (does not stop) " +
          "if either trips: (1) you have unconsumed inbound direction queued (manager redirect/message, a " +
          "human composer turn, companion inbound you haven't acted on yet) → {stopped:false, " +
          "reason:\"queued-inbound\", pending:N} — end this turn so it drains into your next turn, act on " +
          "it, THEN re-call end_me; (2) you have ≥1 LIVE worker → {stopped:false, reason:\"live-workers\", " +
          "count:N} — recycle_me or worker_stop them first, then re-call end_me. On pass: your session " +
          "gracefully stops (Ctrl-C×2, clean, resumable — the row lands on Archive) and this tool's own " +
          "reply is delivered before your pty dies.",
        inputSchema: {},
      },
      async () => {
        try {
          return ok(sessions.endMe(managerSessionId));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "idle_report",
      {
        description:
          "Tell Loom's idle watchdog your disposition so it stops nudging you — call it when you end a " +
          "turn with no active work. `state`: 'working' = back at it (resumes normal watching); 'waiting' " +
          "= nothing to do until something lands — optionally snooze for `minutes` (defaults to the " +
          "per-project idle snooze); 'done' = this agent's work is complete. If you need the human, file " +
          "a Request via `question_ask` instead. Always clears your unanswered-nudge counter. Pass a " +
          "short `detail` to say why (recorded for the human).",
        inputSchema: {
          state: z.enum(["working", "waiting", "done"]),
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

    // Read-only agent directory (same scoping posture as worker_list): list the project's agents so a
    // manager can resolve a recycle/handoff's agent-id PREFIX (e.g. "b5d7304f…") to a full id, and pick
    // the right worker agent for worker_spawn — WITHOUT raw loom.db or REST. Project is derived
    // SERVER-SIDE from this manager's session (the agent passes no projectId), so it can never list
    // another project's agents. `role` is the agent's resolved PROFILE role (resolveProfile — the
    // canonical mechanism, exactly as the platform page derives it); null for a plain/profile-less agent.
    // browserTesting/documentConversion/dejaCorpus/restrictedTools are the SAME resolveProfile output profile_get/
    // profile_list already surface (mcp/platform.ts) — reused here so a manager can match a worker prompt
    // to real provisioning without a spawn-and-inspect round-trip (Auditor finding 64430a50).
    server.registerTool(
      "agent_list",
      {
        description:
          "List the agents (rigs) in YOUR project — read-only. Use it to resolve a recycle/handoff's " +
          "agent-id PREFIX (e.g. 'b5d7304f…') to a full id, and to choose the right worker agent for " +
          "worker_spawn. Your project is derived SERVER-SIDE from your session (you pass NO projectId, so " +
          "you can never list another project's agents — same scoping as worker_list). Returns each agent's " +
          "{id, name, role (resolved from its bound profile — null for a plain agent), profileId, position, " +
          "browserTesting, documentConversion, dejaCorpus, restrictedTools (resolved from the assigned/default " +
          "profile — same resolution profile_get/profile_list use; false when profile-less or the profile " +
          "leaves a flag unset)}, ordered by position.",
        inputSchema: {},
      },
      async () => {
        const projectId = db.getSession(managerSessionId)?.projectId;
        if (!projectId) return ok({ error: "no project for this session" });
        return ok(db.listAgents(projectId).map((a) => {
          const resolved = resolveProfile(a, a.profileId ? db.getProfile(a.profileId) : undefined);
          return {
            id: a.id,
            name: a.name,
            role: resolved.role,
            profileId: a.profileId,
            position: a.position,
            browserTesting: resolved.browserTesting,
            documentConversion: resolved.documentConversion,
            dejaCorpus: resolved.dejaCorpus,
            restrictedTools: resolved.restrictedTools,
          };
        }));
      },
    );

    // Single-record FULL read (Task GAP 1): agent_list's summary deliberately drops startupPrompt (some
    // are large, e.g. ~6.6KB for a Code Reviewer rig — inlining every prompt into the fleet view would
    // bloat it), so a manager needing to SEE one agent's full prompt before a safe read-modify-write
    // (agent_update) previously had to fall back to curl'ing the human REST surface. agentId resolution
    // mirrors worker_spawn/agent_list: exact id, else an unambiguous 8-char id-PREFIX (resolveIdPrefix) —
    // both scoped to THIS manager's OWN project (agents.find/resolveIdPrefix search only db.listAgents
    // (projectId) results), so an id from another project simply doesn't match (falls through to
    // "agent not found", never leaking cross-project existence).
    server.registerTool(
      "agent_get",
      {
        description:
          "Read ONE agent in YOUR project — the FULL record INCLUDING its startupPrompt (agent_list's " +
          "summary deliberately drops it — some prompts are large, e.g. ~6.6KB for a Code Reviewer rig), " +
          "PLUS its resolved browserTesting/documentConversion/dejaCorpus/restrictedTools capability flags (from its " +
          "assigned/default profile — same resolution profile_get/profile_list use; false when profile-less " +
          "or the profile leaves a flag unset). Use this before a safe read-modify-write via agent_update " +
          "(its appendToStartupPrompt mode lets you add to what you read here without retyping the whole " +
          "prompt), and to check an agent's real provisioning before assuming it from its prompt. agentId " +
          "accepts the full id OR an unambiguous 8-char id-prefix (same resolution as worker_spawn/" +
          "agent_list). Your project is derived SERVER-SIDE (you pass no projectId) — an agent outside YOUR " +
          "project resolves as not-found, same scoping as worker_list/agent_list. Error if unknown or an " +
          "ambiguous prefix (the error names the candidate ids).",
        inputSchema: { agentId: z.string() },
      },
      async ({ agentId }) => {
        const projectId = db.getSession(managerSessionId)?.projectId;
        if (!projectId) return ok({ error: "no project for this session" });
        const agents = db.listAgents(projectId);
        const withResolvedFlags = (a: (typeof agents)[number]) => {
          const resolved = resolveProfile(a, a.profileId ? db.getProfile(a.profileId) : undefined);
          return {
            ...a,
            browserTesting: resolved.browserTesting,
            documentConversion: resolved.documentConversion,
            dejaCorpus: resolved.dejaCorpus,
            restrictedTools: resolved.restrictedTools,
          };
        };
        const exact = agents.find((a) => a.id === agentId);
        if (exact) return ok(withResolvedFlags(exact));
        const r = resolveIdPrefix(agents, agentId);
        if (r.kind === "found") return ok(withResolvedFlags(r.record));
        if (r.kind === "ambiguous") {
          return ok({ error: `ambiguous agent id-prefix '${agentId}' — it matches ${r.ids.join(", ")}; pass more characters or the full id` });
        }
        return ok({ error: "agent not found" });
      },
    );

    server.registerTool(
      "agent_assign_profile",
      {
        description:
          "Assign an EXISTING (human-authored) profile to an agent, or clear it (profileId: null). The " +
          "profile supplies role/model/allowlist/skills/browser at the agent's next NEW session. You can " +
          "only ASSIGN a profile a human already created — you cannot create or edit one (profile authoring " +
          "is human-only). A non-existent profileId is rejected. Use this to provision a rig (e.g. assign the " +
          "human-authored 'QA Tester' browser profile) without waiting on a human. The target agent must be in " +
          "YOUR project (an agent outside it is REJECTED).",
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
          "Update an agent's name (title) and/or startupPrompt (the project-specific brief that LEADS the " +
          "opening of its next NEW session — prepended ahead of any dynamic kickoff/handoff; an empty brief " +
          "leaves the opening as the dynamic part alone). Structural edit only — to change the agent's rig use " +
          "agent_assign_profile. Two ways to touch startupPrompt: `startupPrompt` REPLACES it wholesale (as " +
          "before); `appendToStartupPrompt` CONCATENATES onto the EXISTING prompt (joined with a blank line) " +
          "so you never have to round-trip the full text for a small addition — read the current prompt first " +
          "with agent_get. Passing BOTH in the same call is REJECTED (pick one). The target agent must be in " +
          "YOUR project (an agent outside it is REJECTED). Omitted fields are left as-is.",
        inputSchema: {
          agentId: z.string(),
          name: z.string().optional(),
          startupPrompt: z.string().optional(),
          appendToStartupPrompt: z.string().optional(),
        },
      },
      async ({ agentId, name, startupPrompt, appendToStartupPrompt }) => {
        try {
          return ok(sessions.updateAgentPreset(managerSessionId, agentId, { name, startupPrompt, appendToStartupPrompt }));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "agent_delete",
      {
        description:
          "PERMANENTLY delete one of YOUR project's agents (an agentId outside your project is REJECTED — " +
          "reuses sessions.deleteAgentAsManager, which calls the SAME service path as the human DELETE " +
          "/api/agents/:id and the Platform Lead's agent_delete: db.deleteAgent cascades the agent's " +
          "sessions/schedules/runs and best-effort drops their transcript snapshots). Refuses while any of " +
          "the agent's sessions is still LIVE (\"stop the fleet first\" — same guard as the human path); stop " +
          "it first. 404 (\"agent not found\") if the id is unknown. FULL id required (no 8-char prefix, like " +
          "agent_update). Returns { deleted:true, agentId, sessions:<n> }.",
        inputSchema: { agentId: z.string() },
      },
      async ({ agentId }) => {
        try {
          return ok(sessions.deleteAgentAsManager(managerSessionId, agentId));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "profile_delete",
      {
        description:
          "PERMANENTLY delete a Profile (rig) by id — HAZARD: profiles are SHARED across projects, so this " +
          "REFUSES (naming the blocking agents/projects) unless the profile is referenced ONLY by agents in " +
          "YOUR OWN project (or by none at all) — a single-project manager can never delete a rig another " +
          "project depends on. The scan covers ARCHIVED foreign projects too (archived is soft/restorable, " +
          "not gone — a reference there still blocks). Reuses sessions.deleteProfileAsManager, which calls the SAME db.deleteProfile " +
          "the human DELETE /api/profiles/:id and the Platform Lead's profile_delete use — a reference confined " +
          "to your own project does NOT block delete (matches the human path's safe-by-design cascade: a " +
          "dangling profileId resolves to the plain backstop). 404 (\"profile not found\") if the id is unknown. " +
          "FULL id required (no 8-char prefix). Returns { deleted:true, profileId }.",
        inputSchema: { profileId: z.string() },
      },
      async ({ profileId }) => {
        try {
          return ok(sessions.deleteProfileAsManager(managerSessionId, profileId));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "project_update",
      {
        description:
          "Update a project's structural fields (name / vaultPath) and/or its config override — YOUR project " +
          "only (a projectId outside your own is REJECTED; platform_escalate is your one cross-project write). " +
          "config is schema-validated on the AGENT path: orchestration.gateCommand (host-RCE) and unknown keys " +
          "are REJECTED (that capability stays human-only). repoPath is not editable here. Omitted fields are " +
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
          "retained (not deleted). Structural, reversible-by-a-human. YOUR project only — a projectId outside " +
          "your own (e.g. the reserved Loom Platform home) is REJECTED.",
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
          "the same kind of self-scheduling agents already do via wake_me. The target agent must be in YOUR " +
          "project (an agent outside it is REJECTED). Optional `prompt` is a custom task description, APPENDED " +
          "to the agent's own startupPrompt (agent prompt first, then this as a clearly-delimited block) when " +
          "the schedule fires — omit for today's behavior (agent prompt only). Optional `name` is a " +
          "human-facing label shown in the Schedules UI; omit it and a friendly default is derived from " +
          "the cron (e.g. \"Every day at 9:00 AM\").",
        inputSchema: { agentId: z.string(), cron: z.string(), enabled: z.boolean().optional(), prompt: z.string().optional(), name: z.string().optional() },
      },
      async ({ agentId, cron, enabled, prompt, name }) => {
        try {
          return ok(sessions.createSchedule(managerSessionId, { agentId, cron, enabled, prompt, name }));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "schedule_update",
      {
        description:
          "Update a schedule's cron, enabled flag, and/or custom prompt. A changed cron recomputes the next " +
          "fire (rejected if invalid); enabled toggles the Scheduler on/off for this row; prompt is appended to " +
          "the agent's own startupPrompt on fire (pass an empty string to clear it). The schedule's agent must " +
          "be in YOUR project (a schedule outside it is REJECTED). Omitted fields are left as-is; a blank " +
          "`name` is ignored (a schedule always keeps a name).",
        inputSchema: { scheduleId: z.string(), cron: z.string().optional(), enabled: z.boolean().optional(), prompt: z.string().optional(), name: z.string().optional() },
      },
      async ({ scheduleId, cron, enabled, prompt, name }) => {
        try {
          return ok(sessions.updateScheduleAsManager(managerSessionId, scheduleId, { cron, enabled, prompt, name }));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    // --- Manager→Platform escalation (Platform Manager P4) ----------------------------------------
    // The ONE upward channel: a project manager reports a discovered Loom bug / friction UP to the
    // Platform Lead. DURABLE by design — it files a structured TASK onto the reserved "Loom Platform"
    // project's board (the Lead's inbox), which survives the common case where no Lead session is live.
    // This is ONE of the manager's two structured cross-project writes (the other is peer_message, below):
    // the target board here is HARDCODED to the reserved home server-side (the manager never names a
    // projectId), so it can never become a general cross-project task-write. Down-tree messaging stays
    // parent-scoped (worker_message); session_message (the Lead's un-scoped delivery) is the PLATFORM
    // surface, not here.
    server.registerTool(
      "platform_escalate",
      {
        description:
          "Escalate a discovered Loom bug or friction UP to the Platform Lead. Files a DURABLE, structured " +
          "task on the reserved Loom Platform board (the Lead's inbox — it survives whether or not a Lead " +
          "session is live), capturing your origin project + this manager session, the title, the detail/" +
          "evidence, and a severity. The target is the Platform board, fixed server-side (you cannot pick a " +
          "project) — for a LINKED peer project's manager instead, use peer_message. Returns the created " +
          "Platform task id plus a `deliveryStatus` (delivered-live | queued | boarded | dropped): `boarded` " +
          "means no Lead session was live but the board task is durably filed (the normal, safe case) — only " +
          "`dropped` warrants concern. Use it for platform-level problems (a Loom bug, a confusing tool/skill, " +
          "friction that slowed your workers) — NOT for your own project's task board (use tasks_create there).",
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

    // --- Manager↔manager cross-project channel (board card 2349d90c) --------------------------------
    // The manager's OTHER structured cross-project write, alongside platform_escalate above. Unlike that
    // hardcoded-target escalation, `targetProjectId` here is caller-chosen but gated server-side on
    // `project_links` — an owner-declared, HUMAN-only table with NO MCP path (an agent can never create a
    // link itself, only use one the owner already made). Delivers ONLY to the target project's LIVE
    // manager session (never a worker/platform/auditor); when none is live, the message is durably boarded
    // on the target project's own board instead of dropped. Reuses the same framed, kind:"agent",
    // one-per-turn delivery channel as worker_message/session_message — a data message only, no privilege
    // travels with it. Rate-limited per calling manager session.
    server.registerTool(
      "peer_message",
      {
        description:
          "Message a LINKED peer project's manager — the sanctioned manager↔manager cross-project channel " +
          "(replaces hand-relaying contract Q&A through the Platform Lead). `targetProjectId` MUST be a " +
          "project the owner has explicitly LINKED to yours (ask the owner to link them first if not — " +
          "there is no way to link projects yourself). Rejected if: the target is your own project, the " +
          "target project doesn't exist, the two projects aren't linked, or you're sending too fast (a " +
          "per-session rate limit). Delivers to the target project's LIVE manager session ONLY — never a " +
          "worker or any other role there. If no manager session is live in the target project right now, " +
          "the message is durably BOARDED as a task on that project's OWN board instead of being dropped — " +
          "its manager will see it next time it attaches. Returns `deliveryStatus` (delivered-live | queued " +
          "| boarded) plus `taskId` when boarded. This is DATA delivery only — the recipient acts on it " +
          "within its OWN project and gains no reach into yours except replying through this same primitive. " +
          "The delivered frame ([loom:from-manager · <name> · projectId:<id> · sessionId:<id>]) stamps YOUR " +
          "project id and this manager session's id, so a recipient can reply with peer_message using that " +
          "projectId as ITS targetProjectId — no need to ask the owner to relay it.",
        inputSchema: { targetProjectId: z.string(), text: z.string() },
      },
      async ({ targetProjectId, text }) => {
        try {
          return ok(sessions.messagePeerManager(managerSessionId, targetProjectId, text));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "escalation_status",
      {
        description:
          "READ-ONLY: check whether the Platform Lead has picked up / resolved an escalation YOUR PROJECT " +
          "filed via platform_escalate — closes the gap where a manager re-escalates work the Lead already " +
          "claimed. Pass `taskId` (the id platform_escalate returned) to check one escalation; omit it to " +
          "list every escalation ever filed from your project, most-recent first. Scoped server-side to " +
          "YOUR OWN project's origin — a taskId outside that set (another project's escalation, or unknown) " +
          "returns `{found:false}` uniformly, never an error, so this can't be used to probe another " +
          "project's escalations. Each escalation reports its CURRENT title (the Lead may have refined it — " +
          "itself a sign it was seen), a `status` of pending (still in the landing lane — not yet picked " +
          "up), in_progress (moved into a working lane — picked up), resolved (in a done/terminal column), " +
          "or closed (the task was deleted/archived), its columnKey, and updatedAt. No writes.",
        inputSchema: { taskId: z.string().optional() },
      },
      async ({ taskId }) => {
        try {
          return ok(sessions.escalationStatus(managerSessionId, { taskId }));
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
