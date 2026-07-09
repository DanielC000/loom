/**
 * Companion Capability & Permission-Lever Framework — §2, the plug-in pattern (one enforcement point, not
 * one per lever). See `Projects/Loom/Design/Companion Capability & Permission-Lever Framework.md` (vault).
 *
 * A capability is enabled by the PRESENCE of a `companion_capability_grants` row (db.ts): no grant ⇒ its
 * tools are never registered on the companion's MCP surface, so it stays inert + invisible — mirroring the
 * existing `chat_reply`/`skill_*`/`memory_*`/`reminder_*` per-session companion gate
 * (`companionSessionIds.has(sessionId)` in mcp/orchestration.ts). `resolveCompanionGrant` is the ONE
 * enforcement gate every lever is read through; `registerCompanionCapabilities` is the single chokepoint
 * that iterates the registry once per `buildServer` call. Every lever's tool handler ALSO re-checks scope
 * at call time (belt-and-suspenders — mirrors why companion/factory.ts re-scopes bindings even though the
 * controller already dispatches by session id): a bug in registration-gating alone must not open the door.
 */
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CompanionRoute, Question, Session, SessionRole, Task, TaskPriority } from "@loom/shared";
import { resolveConfig } from "@loom/shared";
import type { Db } from "../db.js";
import { createProjectTask, listProjectTasks, updateProjectTask, type TaskSummary } from "../mcp/tasks.js";
import { listVaultTree, readVaultFile, resolveVaultFilePath, statVaultFile } from "../vault/browser.js";
import type { OwnerAttestation } from "./attestation.js";

const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(data) }] });

/** The lever catalog (Framework §4). Only `session-status` is BUILT by this card — the rest are named here
 *  so the grants REST validator (gateway/server.ts) can reject an unknown/typo'd slug now, before their
 *  own cards land, without a REST change per lever. */
export const COMPANION_CAPABILITY_SLUGS = [
  "session-status", "decisions-relay", "attention-push", "session-steer",
  "board-reach", "vault-read", "media-out",
] as const;
export type CapabilitySlug = (typeof COMPANION_CAPABILITY_SLUGS)[number];

/** One project's resolved {mode, config} within a capability's scope — see {@link ResolvedGrantScope}. */
export interface ProjectGrant {
  mode: "read" | "act";
  config: Record<string, unknown>;
}

/**
 * One capability's resolved scope for ONE companion session — PER-PROJECT, never a cross-project collapsed
 * value. This is load-bearing (CR fix): the design note's invariant is "a read grant NEVER implies act" —
 * a companion granted `read` on project A and `act` on project B must NOT let a lever treat project A as
 * act-eligible. Collapsing to a single scope-wide mode (the pre-CR shape) would let a lever that checks
 * `scope.mode === 'act'` act on EVERY granted project once ANY one of them was act-granted — a per-project
 * privilege escalation, on the most-injection-exposed surface in Loom. So a lever asks about the SPECIFIC
 * project it is acting on (`modeFor`/`mayAct`/`configFor`), never the scope as a whole. `projectIds` is the
 * convenience for a READ-ONLY lever (like `session-status`) that only needs "which projects am I scoped
 * to" and never reads mode/config at all.
 */
export interface ResolvedGrantScope {
  /** Every granted project id for this capability — for a lever that only needs the SET (no mode/config
   *  read), e.g. session-status iterating which projects' sessions to report. */
  projectIds: Set<string>;
  /** This capability's resolved mode for ONE project, or undefined if that project isn't granted at all. */
  modeFor(projectId: string): "read" | "act" | undefined;
  /** True iff `projectId` is granted with mode 'act' (false for 'read', false for ungranted). */
  mayAct(projectId: string): boolean;
  /** This capability's resolved config for ONE project (that project's own row's config_json — never
   *  merged with another project's), or `{}` if that project isn't granted. */
  configFor(projectId: string): Record<string, unknown>;
}

/**
 * THE enforcement gate (Framework §2). Reads `companion_capability_grants` PER-SESSION (never the global
 * table — mirrors the bindings read pattern) filtered to one capability slug, and resolves the rows into a
 * PER-PROJECT {@link ResolvedGrantScope} (see its doc for why per-project, not collapsed). A grant row's
 * `projectId: null` resolves to the companion's OWN bound project (`db.getSession(sessionId).projectId`) —
 * the narrow default (Framework §1). If a NULL-project row and an explicit row for that SAME actual project
 * id both somehow exist (a human REST edge case — the two are distinct natural keys even when they resolve
 * to the same project), the one with the later `created_at`/rowid wins (rows are read in that order) — a
 * deterministic, documented tie-break rather than an undefined one. Returns `null` when there is no grant
 * for this capability (⇒ the caller must not register the lever's tools), or when every resolvable row's
 * project turns out to be unknown (e.g. a NULL-project row on a session with no bound project) — never
 * returns an empty-but-truthy scope.
 *
 * Tolerates a `db` that doesn't implement `listCompanionCapabilityGrantsForSession` (a minimal test double
 * built before this table existed, e.g. a bare `{ getSession }` stub used to unit-test `resolveRole`/MCP
 * tool-surface shape elsewhere in the daemon test suite) by treating it the SAME as "no grant row" — never
 * throwing. That's the semantically correct answer, not just a defensive shim: a store that can't even
 * list grants genuinely has none, so every capability stays OFF, which is exactly the byte-identical
 * default this framework promises for every session it doesn't know about.
 */
export function resolveCompanionGrant(db: Db, sessionId: string, capability: string): ResolvedGrantScope | null {
  if (typeof db.listCompanionCapabilityGrantsForSession !== "function") return null;
  const rows = db.listCompanionCapabilityGrantsForSession(sessionId).filter((g) => g.capability === capability);
  if (rows.length === 0) return null;
  const ownProjectId = db.getSession(sessionId)?.projectId ?? null;
  const perProject = new Map<string, ProjectGrant>();
  for (const row of rows) {
    const pid = row.projectId ?? ownProjectId;
    if (!pid) continue;
    perProject.set(pid, { mode: row.mode, config: row.config });
  }
  if (perProject.size === 0) return null;
  return {
    projectIds: new Set(perProject.keys()),
    modeFor: (projectId) => perProject.get(projectId)?.mode,
    mayAct: (projectId) => perProject.get(projectId)?.mode === "act",
    configFor: (projectId) => perProject.get(projectId)?.config ?? {},
  };
}

/** The slice of `PtyHost` a sensitive ACT lever needs to (a) scope Primitive C's propose/confirm round-trip
 *  to the CURRENT turn's reply-to route and (b) push a best-effort nudge once a privileged action commits —
 *  mirrors the minimal `HeartbeatPty` seam (companion/heartbeat.ts) rather than importing the full
 *  `PtyHost` class, so a lever's tests can pass a plain stub. */
export interface GrantPty {
  getActiveTurnOrigin(sessionId: string): CompanionRoute | null;
  enqueueStdin(
    sessionId: string,
    text: string,
    source?: "human" | "system",
    onDeliver?: () => void,
    route?: CompanionRoute,
    kind?: "warning" | "agent",
    questionId?: string,
  ): { delivered: boolean; position?: number; reason?: string };
}

/**
 * The OUTBOUND seam a Primitive-C lever uses to surface its confirm prompt to the OWNER directly — never
 * through the companion (CR hardening, card a8ddd6d2's review). Wraps the SAME rail `chat_reply` uses
 * (`CompanionHooks.deliverReply` → `ChatGateway.deliverReply`, companion/chat-gateway.ts), which resolves
 * the delivery route from the ACTIVE TURN's own origin — a lever never supplies or guesses a route, so it
 * cannot be tricked into "confirming" toward an attacker-chosen destination. This is DELIBERATELY separate
 * from `GrantPty` (which is INBOUND — it feeds text back into the companion's OWN pty — the wrong direction
 * for a message that must reach the human, not the untrusted LLM that originated the request).
 */
export interface GrantOutbound {
  /** Deliver `text` OUT to the owner's chat for `sessionId`. Returns true iff the daemon believes the send
   *  succeeded (false on no-target/no-adapter/send-failure) — a caller MUST fail closed on false, since a
   *  false return means there is no verified trusted channel the owner actually saw the prompt on. */
  deliverToOwner(sessionId: string, text: string): Promise<boolean>;
  /**
   * Deliver the LOCAL file at `filePath` OUT to the owner's chat for `sessionId`, as a native image/
   * document — the `media-out` lever's (card 3a81b0f2) own outbound seam, resolved from the ACTIVE TURN's
   * origin exactly like `deliverToOwner` (never a lever-guessed destination). Unlike `deliverToOwner`'s
   * collapsed boolean, this returns a reason so the lever can tell a channel that simply doesn't support
   * media (`reason:"unsupported-channel"`, e.g. the in-app companion — Telegram-first v1) apart from a
   * genuine send failure — the former degrades gracefully (the lever tells the owner where the file is),
   * the latter fails closed exactly like `deliverToOwner`.
   */
  deliverMediaToOwner(sessionId: string, filePath: string): Promise<{ delivered: boolean; reason?: string }>;
}

/** The slice of `SessionService` the `session-steer` ACT lever needs (card 305a54fb) — cross-session
 *  message/steer/stop/resume, exposed as a SCOPED subset. Mirrors the Platform Lead's own cross-session
 *  controls (mcp/platform.ts `session_message`/`session_stop` + SessionService's `redirectWorker`/
 *  `resume`), narrowed to exactly what this lever calls — a lever never gets the full `SessionService`.
 *  `senderSessionId` is threaded through by the caller (never agent-suppliable) so an undelivered dispatch
 *  can be traced back to the originating companion session. */
export interface GrantSessions {
  messageSession(sessionId: string, text: string, senderSessionId: string): { deliveryStatus: string; position?: number; taskId?: string; routedTo?: string };
  redirectSession(sessionId: string, text: string, senderSessionId: string): { delivered: boolean; position?: number };
  stopSession(sessionId: string, mode: "graceful" | "hard"): { stopped: true; sessionId: string };
  resumeSession(sessionId: string): { id: string };
}

/** Per-lever registration context — `sessionId`/`scope`/`attest`/`pty`/`outbound`/`sessions` are
 *  SERVER-DERIVED (never agent-passed); a lever's `register()` closes over these to pre-scope every tool
 *  it adds. `attest` (Companion injection-guard primitives, card 8e511951) is the ONLY surface an ACT
 *  lever may use to verify a privileged action traces back to the owner's own literal words. `pty` (card
 *  a8ddd6d2) lets a lever scope Primitive C to the active turn's route and push a post-commit nudge into
 *  an ASKING MANAGER's session (never the owner). `outbound` (same card, CR hardening) is the ONLY way a
 *  lever may put text in front of the OWNER directly. `sessions` (card 305a54fb) is the ONLY way a lever
 *  may drive another session's lifecycle (message/steer/stop/resume) — every lever that doesn't need one
 *  of these (every read-only lever, and `decision_resolve`/`board_create`/`board_update`/`send_media` for
 *  `sessions`) simply never touches it. */
export interface GrantContext {
  sessionId: string;
  scope: ResolvedGrantScope;
  attest: OwnerAttestation;
  pty: GrantPty;
  outbound: GrantOutbound;
  sessions: GrantSessions;
}

/** One pluggable lever descriptor (Framework §2). `register` adds THIS lever's tools to `server`, already
 *  pre-scoped via `ctx` — the registry loop below is the only place that decides WHETHER a lever mounts. */
export interface CompanionCapability {
  slug: CapabilitySlug;
  supportsMode: readonly ("read" | "act")[];
  register(server: McpServer, ctx: GrantContext, db: Db): void;
}

/**
 * `session-status` (Framework §4, `d12fda07` read half) — the proof-of-pattern READ lever: a read-only
 * `sessions_status` tool reporting which sessions are live (+ status + current task) across the granted
 * projects. Lowest-risk lever in the catalog (no writes, no injection-guard primitives needed) — this is
 * the template every later lever copies.
 */
const SESSION_STATUS: CompanionCapability = {
  slug: "session-status",
  supportsMode: ["read"],
  register(server, ctx, db) {
    server.registerTool(
      "sessions_status",
      {
        description:
          "Read-only view of live sessions in your granted project(s): which are live, their busy/process " +
          "state, and their current task (if any). Optionally pass `project` (a project id) to narrow to " +
          "ONE of your granted projects — passing a project you were NOT granted is rejected with an " +
          "{error}; omitting it returns every granted project's live sessions.",
        inputSchema: { project: z.string().optional() },
      },
      async ({ project }) => {
        // Belt-and-suspenders re-check (Framework §2): a `project` selector must be one of THIS grant's
        // scoped projects — it can only ever NAME a project already granted, never widen scope.
        if (project !== undefined && !ctx.scope.projectIds.has(project)) {
          return ok({ error: `project "${project}" is not in your granted scope` });
        }
        const targetProjects = project !== undefined ? new Set([project]) : ctx.scope.projectIds;
        const sessions = db.listAllSessions()
          .filter((s) => s.processState === "live" && !!s.projectId && targetProjects.has(s.projectId))
          .map((s) => ({
            sessionId: s.id, projectId: s.projectId, projectName: s.projectName,
            role: s.role ?? null, busy: s.busy, processState: s.processState,
            taskId: s.taskId ?? null, title: s.title ?? null,
          }));
        return ok({ sessions });
      },
    );
  },
};

/** `decision_resolve`'s decision-class vocabulary (Framework §4 config schema: `{decisionClasses:[...]}`).
 *  Exported so the grants config validator (gateway/server.ts) can reject an unknown/typo'd class at
 *  write time, mirroring `ATTENTION_ALERT_CLASSES` (attention-push.ts). A `Question` carries no explicit
 *  class column (the decision-inbox schema predates this lever), so `classifyDecisionClass` below is the
 *  ONE place a class is DERIVED from a question's own title/body — a coarse, conservative keyword
 *  heuristic, not a stored fact. `general` is the fallback for everything that doesn't match a narrower,
 *  higher-risk class. */
export const DECISION_CLASSES = ["general", "deploy", "irreversible"] as const;
export type DecisionClass = (typeof DECISION_CLASSES)[number];

/** Keyword heuristics for the two higher-risk classes — deliberately narrow (a false negative just falls
 *  back to "general", which is itself only eligible once the owner explicitly allowlists it; a false
 *  positive over-classifies as riskier, never under). Checked against `title + body`, case-insensitive. */
const IRREVERSIBLE_DECISION_KEYWORDS = /\b(delete|destroy|drop|wipe|purge|revoke|force[- ]?push|irreversible)\b/i;
const DEPLOY_DECISION_KEYWORDS = /\b(deploy|release|rollout|ship\s+to\s+prod(?:uction)?)\b/i;

/** classify() (Framework §4, this lever's single source of truth — mirrors attention-push.ts's classify()
 *  doc). Order matters: "irreversible" is checked first since a question can plausibly match both (e.g.
 *  "deploy the DB migration that drops the old column"), and the higher-risk class must win. Exported so
 *  its keyword logic is directly unit-testable (rather than only indirectly, through a full decision_resolve
 *  round-trip) — a broken regex here should fail a test that reads it, not stay silently green. */
export function classifyDecisionClass(question: Pick<Question, "title" | "body">): DecisionClass {
  const text = `${question.title} ${question.body}`;
  if (IRREVERSIBLE_DECISION_KEYWORDS.test(text)) return "irreversible";
  if (DEPLOY_DECISION_KEYWORDS.test(text)) return "deploy";
  return "general";
}

/** This lever's own capability slug, reused as Primitive C's namespace (see `ProposeConfirmationInput.
 *  capability`) so a second sensitive lever (e.g. a future `board-write`) proposing on the SAME
 *  (session, route) can never clobber THIS lever's pending token. */
const DECISIONS_RELAY_SLUG = "decisions-relay";

/** A validated, NOT-YET-CONFIRMED `decision_resolve` proposal, keyed by (sessionId, route) — see
 *  `pendingResolveKey`. IN-MEMORY (mirrors `OwnerConfirmStore`'s own in-memory pending-proposal store;
 *  lost on a daemon restart, which is fine — a lost proposal just needs a fresh `decision_resolve` call to
 *  re-propose). Module-scoped: `DECISIONS_RELAY` is built once and shared by every companion session, so
 *  this map is the lever's own durable-for-the-process-lifetime state, the same lifetime as the router's
 *  `OwnerConfirmStore` instance it is paired with. */
const pendingDecisionResolves = new Map<string, { questionId: string; chosenOption: string; note: string | null }>();

/** Mirrors `OwnerConfirmStore`'s own `proposalKey` (attestation.ts) — a proposal (and therefore this
 *  lever's own remembered payload) is keyed to session + owner ROUTE, never session alone, so a confirm
 *  from a different chat/channel can never commit a DIFFERENT route's pending resolve. Also namespaced by
 *  `DECISIONS_RELAY_SLUG` — this map is lever-specific anyway (only decision_resolve writes to it), but
 *  keeping the SAME key shape as `OwnerConfirmStore`'s own (session, route, capability) key avoids a
 *  silent drift between the two if a future refactor merges them. */
function pendingResolveKey(sessionId: string, route: CompanionRoute | null): string {
  return `${sessionId}::${route ? `${route.channel}:${route.chatId}` : ""}::${DECISIONS_RELAY_SLUG}`;
}

/**
 * `decisions-relay` (Framework §4) — `decisions_list` is the READ half: a read-only tool reporting PENDING
 * decision-inbox questions (Framework's manager→human `Question`/`QuestionInboxItem`, db.ts) across the
 * granted projects. Mirrors `SESSION_STATUS` exactly.
 *
 * `decision_resolve` is the ACT half (card a8ddd6d2) — THE highest-risk lever in the whole catalog:
 * resolving a decision can approve owner-gated / irreversible work. It is registered ONLY when at least
 * one of this grant's projects is act-mode (`hasActGrant` below) — a read-only grant's tool surface stays
 * byte-identical to before this card. Guards, in order: (1) the question's project ∈ scope.projectIds AND
 * `mayAct` for it (belt-and-suspenders, per-project — never a collapsed scope check); (2) the question is
 * `pending` and OFFERS options (a pure-blocker ask has none — that stays human-only, free-text-note
 * answers are out of scope for this lever); (3) `chosenOption` is one of those offered options; (4) a
 * `decisionClasses` allowlist in this project's grant config — CONSERVATIVE DEFAULT (owner sign-off
 * 1039e892): an absent/empty allowlist admits NOTHING, mirroring `attention-push`'s own "absent config ⇒
 * nothing subscribed" default, so deploy/irreversible (and even `general`) decisions all require the
 * owner to explicitly opt in; (5) Primitive A — the call must be on an owner-authored turn at all
 * (`attest.getActiveTurnOwnerText` non-null); (6) a reply-to ROUTE must exist for the current turn — with
 * no route there is no verified channel back to the owner, so the propose is refused outright (CR
 * hardening — see below); (7) Primitive C — the call never resolves on its own: it PROPOSES (mints a
 * confirm token via `attest.proposeConfirmation`, remembers the validated payload in
 * `pendingDecisionResolves`) and only a LATER `decision_resolve` call, on the owner's own next turn whose
 * text contains that token (`attest.confirmPending`), actually calls `db.answerQuestion` — reusing the
 * exact write the human decision-inbox UI and `question_pull` rely on, never a reimplementation. A
 * free-text `note` is only checked against Primitive B (verbatim owner substring) at PROPOSE time — the
 * CONFIRMING turn's owner text is just "CONFIRM <token>", not the original note, so re-checking B there
 * would always fail; the validated note is instead carried in the pending-proposal payload and used
 * verbatim on commit.
 *
 * CR HARDENING (post-review fix): the confirm prompt is delivered DIRECTLY to the owner's chat via
 * `ctx.outbound.deliverToOwner` — the SAME outbound rail `chat_reply` uses, resolved from the ACTIVE
 * TURN's own origin, never a lever-guessed destination — and the tool NEVER returns `promptText`/the
 * token to the companion (a bare `{status:'proposed'}`). The companion is the exact untrusted component
 * Primitive C exists to defend against: if the token were handed back for the companion to "relay", a
 * hijacked companion could propose a DIFFERENT action than the one it tells the owner about, receive the
 * REAL token, and render its OWN false-labeled message — the owner would still be typing a token that
 * really matches, but for an action they never actually chose. Delivering server-side and withholding the
 * token from the tool's return value makes that structurally impossible: the companion cannot construct a
 * valid confirm message it never received. Primitive B alone is a substring check (insufficient against
 * negation/context-stripping, e.g. "approve" is a substring of "do NOT approve") — Primitive C, delivered
 * this way, is the actual defense: the owner sees the EXACT daemon-authored action description and only
 * their own reply (which the daemon re-derives server-side via Primitive A) can commit it.
 */
const DECISIONS_RELAY: CompanionCapability = {
  slug: "decisions-relay",
  supportsMode: ["read", "act"],
  register(server, ctx, db) {
    server.registerTool(
      "decisions_list",
      {
        description:
          "Read-only view of PENDING decision-inbox questions (manager asks awaiting a human answer) in " +
          "your granted project(s). Optionally pass `project` (a project id) to narrow to ONE of your " +
          "granted projects — passing a project you were NOT granted is rejected with an {error}; " +
          "omitting it returns every granted project's pending decisions.",
        inputSchema: { project: z.string().optional() },
      },
      async ({ project }) => {
        // Belt-and-suspenders re-check (Framework §2): a `project` selector must be one of THIS grant's
        // scoped projects — it can only ever NAME a project already granted, never widen scope.
        if (project !== undefined && !ctx.scope.projectIds.has(project)) {
          return ok({ error: `project "${project}" is not in your granted scope` });
        }
        const targetProjects = project !== undefined ? new Set([project]) : ctx.scope.projectIds;
        const decisions = db.listOpenQuestions()
          .filter((q) => targetProjects.has(q.projectId))
          .map((q) => ({
            questionId: q.id, projectId: q.projectId, projectName: q.projectName,
            sessionId: q.sessionId, title: q.title, body: q.body, options: q.options,
            recommendation: q.recommendation, state: q.state, createdAt: q.createdAt,
          }));
        return ok({ decisions });
      },
    );

    // ACT half — read-only grants (every project in scope is mode:'read') never see this tool at all,
    // keeping their surface byte-identical to before this card.
    const hasActGrant = [...ctx.scope.projectIds].some((pid) => ctx.scope.mayAct(pid));
    if (!hasActGrant) return;

    server.registerTool(
      "decision_resolve",
      {
        description:
          "Resolve a PENDING decision-inbox question that OFFERS options, on behalf of the owner — the " +
          "single highest-risk tool you have. `chosenOption` MUST be one of the question's offered " +
          "options (a question with no options is human-only; ask the owner directly instead). An " +
          "optional `note` MUST be a verbatim quote of words the owner ACTUALLY said this turn — you may " +
          "never author it yourself. This NEVER resolves on the first call: Loom sends a confirmation " +
          "request DIRECTLY to the owner's chat itself (you do NOT see or relay any prompt/token — just " +
          "tell the owner you've requested their confirmation) and returns {status:'proposed'}. Only once " +
          "the owner replies to THAT message do you call decision_resolve AGAIN with the SAME arguments to " +
          "actually commit it ({status:'resolved'}) — Loom detects the owner's confirming reply itself. A " +
          "mismatched confirm reply returns {status:'confirm-mismatch'} — tell the owner to reply again, " +
          "don't re-propose. Requires an act-mode grant on the question's project, a project-configured " +
          "decisionClasses allowlist covering this decision, and an owner-authored turn on a channel Loom " +
          "can reply to — a proactive/heartbeat turn is always rejected.",
        inputSchema: { questionId: z.string(), chosenOption: z.string(), note: z.string().optional() },
      },
      async ({ questionId, chosenOption, note }) => {
        const question = db.getQuestion(questionId);
        if (!question) return ok({ error: `no question "${questionId}"` });
        // Belt-and-suspenders (Framework §2, mandatory per-project — never a collapsed scope check).
        if (!ctx.scope.projectIds.has(question.projectId)) {
          return ok({ error: "this question's project is not in your granted scope" });
        }
        if (!ctx.scope.mayAct(question.projectId)) {
          return ok({ error: "you only have a read-mode grant on this question's project — decision_resolve needs act-mode" });
        }
        const decisionClass = classifyDecisionClass(question);
        const cfg = ctx.scope.configFor(question.projectId) as { decisionClasses?: unknown };
        const allowedClasses = new Set(Array.isArray(cfg.decisionClasses) ? cfg.decisionClasses as string[] : []);
        if (!allowedClasses.has(decisionClass)) {
          return ok({
            error: `this decision is classified "${decisionClass}", which is not in this project's decisionClasses ` +
              `allowlist — an owner must add it to the grant config before you may resolve it`,
          });
        }
        if (question.state !== "pending") {
          return ok({ error: `question is already ${question.state}, not pending` });
        }
        if (!question.options || question.options.length === 0) {
          return ok({ error: "this question has no offered options — decision_resolve can only pick an offered option; ask the owner directly for a free-text answer" });
        }
        if (!question.options.includes(chosenOption)) {
          return ok({ error: `chosenOption must be one of: ${question.options.join(", ")}` });
        }
        // Primitive A — every call (propose OR confirm) must be on an owner-authored turn; a proactive/
        // heartbeat/reminder turn has nothing to attest and is refused outright.
        const ownerText = ctx.attest.getActiveTurnOwnerText(ctx.sessionId);
        if (ownerText === null) {
          return ok({ error: "no owner text this turn — decision_resolve can only act on an owner-authored turn" });
        }
        // CR hardening: a reply-to route is REQUIRED — with none, there is no verified channel to deliver
        // the confirm prompt to the owner on, so FAIL CLOSED rather than silently proceed (which would
        // leave no trusted surface for the owner to ever see or decline the proposed action).
        const route = ctx.pty.getActiveTurnOrigin(ctx.sessionId);
        if (route === null) {
          return ok({ error: "no reply-to route for this turn — Loom has no verified channel to confirm this with the owner" });
        }
        const key = pendingResolveKey(ctx.sessionId, route);
        // Fold #2 (whitespace-note bypass): a whitespace-only note is NOT a meaningful note — treat it as
        // absent (store null) so Primitive B owns the empty/whitespace decision uniformly, rather than
        // slipping past the `hasNote` gate below unchecked.
        const hasNote = note !== undefined && note.trim() !== "";
        const normalizedNote = hasNote ? (note as string) : null;

        // Primitive C — try to COMMIT a pending proposal for this exact (route, capability) first.
        const confirmOutcome = ctx.attest.confirmPending(ctx.sessionId, route, DECISIONS_RELAY_SLUG);
        if (confirmOutcome.committed) {
          const pending = pendingDecisionResolves.get(key);
          pendingDecisionResolves.delete(key); // single-use, whether or not it still matches below.
          if (!pending || pending.questionId !== questionId || pending.chosenOption !== chosenOption || pending.note !== normalizedNote) {
            return ok({ error: "the confirmed action no longer matches what was proposed — call decision_resolve again to re-propose" });
          }
          const updated = db.answerQuestion(questionId, { chosenOption, note: normalizedNote, answeredAt: new Date().toISOString() });
          if (!updated) return ok({ error: "question was answered or changed concurrently — nothing to resolve" });
          try {
            const nudge = `Your question "${updated.title}" was answered — pull it (question_pull) when you reach that decision point.`;
            ctx.pty.enqueueStdin(updated.sessionId, nudge, "human", undefined, undefined, "agent", updated.id);
          } catch { /* best-effort — the answer already persisted; question_pull is the durable fallback */ }
          return ok({ status: "resolved", questionId, chosenOption, note: normalizedNote });
        }
        if (confirmOutcome.reason === "token-mismatch") {
          // Leave the pending proposal standing (OwnerConfirmStore itself preserves it) — a typo'd confirm
          // reply should be retry-able within the TTL, not force a fresh proposal (and a fresh token).
          // Deliberately NOT evicting `pendingDecisionResolves` here (unlike the `expired` fallthrough
          // below): the payload is still exactly what a CORRECT retry within the TTL needs to resolve
          // against — evicting it would silently discard a legitimate confirm the instant it lands.
          return ok({ status: "confirm-mismatch", error: "that doesn't contain the exact confirm token — ask the owner to reply again with it verbatim" });
        }
        // Fold #4: an EXPIRED (or never-existed, "no-pending") proposal's payload is dead weight — the
        // fresh propose below unconditionally overwrites this key anyway, but evict explicitly first so a
        // reader never sees a stale entry between the two statements (and so the intent is obvious rather
        // than relying on the overwrite as an implicit side effect).
        pendingDecisionResolves.delete(key);

        // No (or expired) pending confirmation for this route — this is a fresh PROPOSE. Primitive B only
        // applies here: the confirming turn's own text is just "CONFIRM <token>", never the original note.
        if (hasNote && !ctx.attest.isVerbatimOwnerText(ctx.sessionId, normalizedNote as string)) {
          return ok({ error: "note must be a verbatim quote of what the owner said this turn — you may not author it" });
        }
        const proposal = ctx.attest.proposeConfirmation({
          sessionId: ctx.sessionId,
          route,
          capability: DECISIONS_RELAY_SLUG,
          summary: `Resolve decision "${question.title}" as "${chosenOption}"${normalizedNote ? ` — note: "${normalizedNote}"` : ""}?`,
        });
        // CR hardening — THE fix: deliver the confirm prompt DIRECTLY to the owner (never hand promptText
        // or the token back to the companion to "relay"). Fail closed on a delivery failure — an
        // undelivered prompt means the owner never saw what they'd be confirming, so nothing may be left
        // pending for them to stumble into confirming blind (the stray OwnerConfirmStore token is harmless
        // — it just expires unused, and `pendingDecisionResolves` was never set for it below).
        const delivered = await ctx.outbound.deliverToOwner(ctx.sessionId, proposal.promptText);
        if (!delivered) {
          return ok({ error: "couldn't deliver the confirmation to the owner's chat — nothing was proposed; try again" });
        }
        pendingDecisionResolves.set(key, { questionId, chosenOption, note: normalizedNote });
        return ok({ status: "proposed" });
      },
    );
  },
};

/** This lever's own capability slug, reused as Primitive C's namespace (see `ProposeConfirmationInput.
 *  capability`) — namespaced apart from `DECISIONS_RELAY_SLUG` so the two sensitive levers can each
 *  hold their own pending token on the SAME (session, route) without clobbering each other. */
const BOARD_REACH_SLUG = "board-reach";

/** A validated, NOT-YET-CONFIRMED board write, keyed by (sessionId, route) — mirrors
 *  `pendingDecisionResolves`/`pendingResolveKey` exactly (see their doc). `board_create` and
 *  `board_update` share this ONE map (and the ONE `BOARD_REACH_SLUG` proposal namespace) since a route
 *  only ever has a single outstanding board-write confirmation at a time — a fresh propose of either
 *  kind always overwrites any prior pending entry for that route, matching `OwnerConfirmStore`'s own
 *  one-pending-per-(session,route,capability) semantics. */
type PendingBoardWrite =
  | { action: "create"; projectId: string; title: string; body: string; columnKey?: string; priority?: TaskPriority }
  | { action: "update"; taskId: string; columnKey?: string; priority?: TaskPriority; held?: boolean };
const pendingBoardWrites = new Map<string, PendingBoardWrite>();

/** Mirrors `pendingResolveKey` (decisions-relay) exactly, namespaced by `BOARD_REACH_SLUG` instead. */
function pendingBoardKey(sessionId: string, route: CompanionRoute | null): string {
  return `${sessionId}::${route ? `${route.channel}:${route.chatId}` : ""}::${BOARD_REACH_SLUG}`;
}

const BOARD_PRIORITY_SCHEMA = z.enum(["p0", "p1", "p2", "p3"]);

/**
 * `board-reach` (Framework §4) — `board_list` is the READ half: a read-only tool reporting board cards
 * across the granted projects. Mirrors SESSION_STATUS/DECISIONS_RELAY exactly.
 *
 * `board_create`/`board_update` are the ACT half (card 7975c034) — registered ONLY when at least one of
 * this grant's projects is act-mode (`hasActGrant`, exactly like `decision_resolve`'s own gate), so a
 * read-only grant's tool surface stays byte-identical. Both relay into the EXISTING loom-tasks write
 * path (`createProjectTask`/`updateProjectTask`, mcp/tasks.ts) rather than reimplementing board
 * mutation — same posture as `decision_resolve` reusing `db.answerQuestion`. There is deliberately NO
 * delete tool at all (card + owner sign-off 1039e892: no cross-project delete from chat).
 *
 * Both tools copy `decision_resolve`'s exact proven shape (its CR-hardened Primitive-C round-trip in
 * particular — see that lever's doc for the full rationale): every call (propose OR confirm) re-runs
 * the belt-and-suspenders scope/mayAct guard FIRST, then Primitive A (owner-authored turn), then
 * requires a reply-to route, then tries `attest.confirmPending` before ever proposing. A first call
 * PROPOSES (mints a token via `attest.proposeConfirmation`, delivers the prompt DIRECTLY to the owner
 * via `ctx.outbound.deliverToOwner` — never returned to the companion) and returns a bare
 * `{status:'proposed'}`; only a SECOND identical call, on the owner's own next turn containing that
 * token, actually calls into `createProjectTask`/`updateProjectTask`. A failed delivery fails closed
 * (nothing left pending). Owner sign-off 1039e892 made Primitive C MANDATORY for every board write
 * (not merely recommended, as the design note's own open fork initially had it) — both tools always
 * propose-then-confirm, with no lighter-weight path.
 *
 * `board_create`'s NEW card content is the one place this lever's guards diverge from `decision_resolve`:
 * Primitive B applies to `title` and (if given) `body` — each must be a verbatim quote of the owner's own
 * words this turn, so an injected message can never fabricate card content. `board_update` carries no
 * free-text content (only columnKey/priority/held — closed-vocabulary fields, not authored text), so
 * Primitive B does not apply there, mirroring how `decision_resolve`'s own `chosenOption` (also a
 * closed-vocabulary pick) is validated against the offered set rather than checked verbatim.
 *
 * `board_update` resolves its target card GLOBALLY (`db.getTask`, unscoped by project — the only way to
 * find out which project a bare card id belongs to) before checking that project against scope, exactly
 * mirroring how `decision_resolve` resolves `db.getQuestion` before its own scope check.
 */
const BOARD_REACH: CompanionCapability = {
  slug: "board-reach",
  supportsMode: ["read", "act"],
  register(server, ctx, db) {
    server.registerTool(
      "board_list",
      {
        description:
          "Read-only view of board cards (done/terminal cards excluded, mirroring tasks_list's default) " +
          "in your granted project(s): id, title, column, priority, position, last-updated, and which " +
          "project each card belongs to. Optionally pass `project` (a project id) to narrow to ONE of " +
          "your granted projects — passing a project you were NOT granted is rejected with an {error}; " +
          "omitting it returns every granted project's cards.",
        inputSchema: { project: z.string().optional() },
      },
      async ({ project }) => {
        // Belt-and-suspenders re-check (Framework §2): a `project` selector must be one of THIS grant's
        // scoped projects — it can only ever NAME a project already granted, never widen scope.
        if (project !== undefined && !ctx.scope.projectIds.has(project)) {
          return ok({ error: `project "${project}" is not in your granted scope` });
        }
        const targetProjects = project !== undefined ? new Set([project]) : ctx.scope.projectIds;
        const cards = [...targetProjects].flatMap((pid) => {
          const projectName = db.getProject(pid)?.name ?? null;
          return (listProjectTasks(db, pid, { excludeDone: true }) as TaskSummary[]).map((t) => ({
            id: t.id, title: t.title, columnKey: t.columnKey, priority: t.priority,
            position: t.position, updatedAt: t.updatedAt, projectId: pid, projectName,
          }));
        });
        return ok({ cards });
      },
    );

    // ACT half — read-only grants (every project in scope is mode:'read') never see these tools at all,
    // keeping their surface byte-identical to before this card.
    const hasActGrant = [...ctx.scope.projectIds].some((pid) => ctx.scope.mayAct(pid));
    if (!hasActGrant) return;

    server.registerTool(
      "board_create",
      {
        description:
          "Create a NEW board card on behalf of the owner, in one of your act-granted project(s) — " +
          "`title` and (if given) `body` MUST each be a verbatim quote of words the owner ACTUALLY said " +
          "this turn; you may never author card content yourself. This NEVER creates the card on the " +
          "first call: Loom sends a confirmation request DIRECTLY to the owner's chat itself (you do NOT " +
          "see or relay any prompt/token — just tell the owner you've requested their confirmation) and " +
          "returns {status:'proposed'}. Only once the owner replies to THAT message do you call " +
          "board_create AGAIN with the SAME arguments to actually create it ({status:'created'}) — Loom " +
          "detects the owner's confirming reply itself. A mismatched confirm reply returns " +
          "{status:'confirm-mismatch'}; tell the owner to reply again, don't re-propose. Requires an " +
          "act-mode grant on `project` and an owner-authored turn on a channel Loom can reply to — a " +
          "proactive/heartbeat turn is always rejected. There is no delete tool — card removal stays " +
          "human-only.",
        inputSchema: {
          project: z.string(), title: z.string(), body: z.string().optional(),
          columnKey: z.string().optional(), priority: BOARD_PRIORITY_SCHEMA.optional(),
        },
      },
      async ({ project, title, body, columnKey, priority }) => {
        // Belt-and-suspenders (Framework §2, mandatory per-project — never a collapsed scope check).
        if (!ctx.scope.projectIds.has(project)) {
          return ok({ error: `project "${project}" is not in your granted scope` });
        }
        if (!ctx.scope.mayAct(project)) {
          return ok({ error: "you only have a read-mode grant on this project — board_create needs act-mode" });
        }
        if (columnKey !== undefined) {
          const cols = resolveConfig(db.getProject(project)?.config).kanbanColumns;
          if (!cols.some((c) => c.key === columnKey)) {
            return ok({ error: `unknown column "${columnKey}" on this project's board (valid: ${cols.map((c) => c.key).join(", ")})` });
          }
        }
        // Primitive A — every call (propose OR confirm) must be on an owner-authored turn.
        const ownerText = ctx.attest.getActiveTurnOwnerText(ctx.sessionId);
        if (ownerText === null) {
          return ok({ error: "no owner text this turn — board_create can only act on an owner-authored turn" });
        }
        // Fail closed with no verified reply-to channel (mirrors decision_resolve's CR hardening).
        const route = ctx.pty.getActiveTurnOrigin(ctx.sessionId);
        if (route === null) {
          return ok({ error: "no reply-to route for this turn — Loom has no verified channel to confirm this with the owner" });
        }
        const key = pendingBoardKey(ctx.sessionId, route);
        // A whitespace-only body is not a meaningful body — treat it as absent (mirrors decision_resolve's
        // whitespace-note fold), so Primitive B owns the empty/whitespace decision uniformly.
        const hasBody = body !== undefined && body.trim() !== "";
        const normalizedBody = hasBody ? (body as string) : "";

        // Primitive C — try to COMMIT a pending proposal for this exact (route, capability) first.
        const confirmOutcome = ctx.attest.confirmPending(ctx.sessionId, route, BOARD_REACH_SLUG);
        if (confirmOutcome.committed) {
          const pending = pendingBoardWrites.get(key);
          pendingBoardWrites.delete(key); // single-use, whether or not it still matches below.
          if (
            !pending || pending.action !== "create" || pending.projectId !== project || pending.title !== title
            || pending.body !== normalizedBody || pending.columnKey !== columnKey || pending.priority !== priority
          ) {
            return ok({ error: "the confirmed action no longer matches what was proposed — call board_create again to re-propose" });
          }
          const created = createProjectTask(db, project, { title, body: normalizedBody, columnKey, priority });
          if ("error" in created) return ok({ error: created.error });
          return ok({
            status: "created",
            task: { id: created.id, title: created.title, columnKey: created.columnKey, priority: created.priority, projectId: project },
          });
        }
        if (confirmOutcome.reason === "token-mismatch") {
          // Left standing (not evicted) — a typo'd confirm reply is retry-able within the TTL.
          return ok({ status: "confirm-mismatch", error: "that doesn't contain the exact confirm token — ask the owner to reply again with it verbatim" });
        }
        // An EXPIRED (or never-existed) proposal's payload is dead weight — evict before the fresh propose
        // below unconditionally overwrites this key, so a reader never sees a stale entry in between.
        pendingBoardWrites.delete(key);

        // No (or expired) pending confirmation for this route — this is a fresh PROPOSE. Primitive B.
        if (!ctx.attest.isVerbatimOwnerText(ctx.sessionId, title)) {
          return ok({ error: "title must be a verbatim quote of what the owner said this turn — you may not author it" });
        }
        if (hasBody && !ctx.attest.isVerbatimOwnerText(ctx.sessionId, normalizedBody)) {
          return ok({ error: "body must be a verbatim quote of what the owner said this turn — you may not author it" });
        }
        const proposal = ctx.attest.proposeConfirmation({
          sessionId: ctx.sessionId,
          route,
          capability: BOARD_REACH_SLUG,
          summary: `Create board card "${title}"${normalizedBody ? ` — body: "${normalizedBody}"` : ""} in project ${project}?`,
        });
        // CR hardening (inherited from decision_resolve) — deliver DIRECTLY to the owner; never hand
        // promptText/the token back to the companion. Fail closed on a delivery failure.
        const delivered = await ctx.outbound.deliverToOwner(ctx.sessionId, proposal.promptText);
        if (!delivered) {
          return ok({ error: "couldn't deliver the confirmation to the owner's chat — nothing was proposed; try again" });
        }
        pendingBoardWrites.set(key, { action: "create", projectId: project, title, body: normalizedBody, columnKey, priority });
        return ok({ status: "proposed" });
      },
    );

    server.registerTool(
      "board_update",
      {
        description:
          "Update an EXISTING board card (by the exact `id` from board_list) on behalf of the owner — " +
          "move its column (`columnKey`), change its `priority`, and/or set `held` (the owner-gated " +
          "'don't nag' flag). At least one of columnKey/priority/held must be given. This NEVER applies " +
          "the update on the first call: Loom sends a confirmation request DIRECTLY to the owner's chat " +
          "itself (you do NOT see or relay any prompt/token — just tell the owner you've requested their " +
          "confirmation) and returns {status:'proposed'}. Only once the owner replies to THAT message do " +
          "you call board_update AGAIN with the SAME arguments to actually apply it ({status:'updated'}) " +
          "— Loom detects the owner's confirming reply itself. A mismatched confirm reply returns " +
          "{status:'confirm-mismatch'}; tell the owner to reply again, don't re-propose. Requires an " +
          "act-mode grant on the card's project and an owner-authored turn on a channel Loom can reply " +
          "to — a proactive/heartbeat turn is always rejected. There is no delete tool — card removal " +
          "stays human-only.",
        inputSchema: {
          id: z.string(), columnKey: z.string().optional(), priority: BOARD_PRIORITY_SCHEMA.optional(),
          held: z.boolean().optional(),
        },
      },
      async ({ id, columnKey, priority, held }) => {
        if (columnKey === undefined && priority === undefined && held === undefined) {
          return ok({ error: "at least one of columnKey, priority, or held must be given" });
        }
        // Resolve the card GLOBALLY first (mirrors decision_resolve's db.getQuestion(questionId) — the
        // only way to learn which project a bare card id belongs to), THEN apply the belt-and-suspenders
        // per-project scope check.
        const task = db.getTask(id);
        if (!task) return ok({ error: `no task "${id}"` });
        if (!ctx.scope.projectIds.has(task.projectId)) {
          return ok({ error: "this task's project is not in your granted scope" });
        }
        if (!ctx.scope.mayAct(task.projectId)) {
          return ok({ error: "you only have a read-mode grant on this task's project — board_update needs act-mode" });
        }
        if (columnKey !== undefined) {
          const cols = resolveConfig(db.getProject(task.projectId)?.config).kanbanColumns;
          if (!cols.some((c) => c.key === columnKey)) {
            return ok({ error: `unknown column "${columnKey}" on this project's board (valid: ${cols.map((c) => c.key).join(", ")})` });
          }
        }
        // Primitive A — every call (propose OR confirm) must be on an owner-authored turn.
        const ownerText = ctx.attest.getActiveTurnOwnerText(ctx.sessionId);
        if (ownerText === null) {
          return ok({ error: "no owner text this turn — board_update can only act on an owner-authored turn" });
        }
        const route = ctx.pty.getActiveTurnOrigin(ctx.sessionId);
        if (route === null) {
          return ok({ error: "no reply-to route for this turn — Loom has no verified channel to confirm this with the owner" });
        }
        const key = pendingBoardKey(ctx.sessionId, route);

        // Primitive C — try to COMMIT a pending proposal for this exact (route, capability) first.
        const confirmOutcome = ctx.attest.confirmPending(ctx.sessionId, route, BOARD_REACH_SLUG);
        if (confirmOutcome.committed) {
          const pending = pendingBoardWrites.get(key);
          pendingBoardWrites.delete(key); // single-use, whether or not it still matches below.
          if (
            !pending || pending.action !== "update" || pending.taskId !== id
            || pending.columnKey !== columnKey || pending.priority !== priority || pending.held !== held
          ) {
            return ok({ error: "the confirmed action no longer matches what was proposed — call board_update again to re-propose" });
          }
          const patch: Partial<Pick<Task, "columnKey" | "priority" | "held">> = {};
          if (columnKey !== undefined) patch.columnKey = columnKey;
          if (priority !== undefined) patch.priority = priority;
          if (held !== undefined) patch.held = held;
          const updated = updateProjectTask(db, task.projectId, id, patch);
          if ("error" in updated) return ok({ error: updated.error });
          return ok({
            status: "updated",
            task: { id: updated.id, title: updated.title, columnKey: updated.columnKey, priority: updated.priority, held: updated.held, projectId: task.projectId },
          });
        }
        if (confirmOutcome.reason === "token-mismatch") {
          return ok({ status: "confirm-mismatch", error: "that doesn't contain the exact confirm token — ask the owner to reply again with it verbatim" });
        }
        pendingBoardWrites.delete(key);

        // No (or expired) pending confirmation for this route — this is a fresh PROPOSE. No free-text
        // content here (columnKey/priority/held are closed-vocabulary, validated above), so Primitive B
        // does not apply — mirrors decision_resolve's own chosenOption (validated, not verbatim-checked).
        const changes: string[] = [];
        if (columnKey !== undefined) changes.push(`move to column "${columnKey}"`);
        if (priority !== undefined) changes.push(`set priority to ${priority}`);
        if (held !== undefined) changes.push(`set held to ${held}`);
        const proposal = ctx.attest.proposeConfirmation({
          sessionId: ctx.sessionId,
          route,
          capability: BOARD_REACH_SLUG,
          summary: `Update board card "${task.title}" (${changes.join(", ")})?`,
        });
        const delivered = await ctx.outbound.deliverToOwner(ctx.sessionId, proposal.promptText);
        if (!delivered) {
          return ok({ error: "couldn't deliver the confirmation to the owner's chat — nothing was proposed; try again" });
        }
        pendingBoardWrites.set(key, { action: "update", taskId: id, columnKey, priority, held });
        return ok({ status: "proposed" });
      },
    );
  },
};

// --- `vault-read` (Framework §4) — bounds + the security exclusion ------------------------------------

/** Note extensions `vault_lookup` will ever read. Never a binary (image/pdf/etc.) — the vault browser's
 *  content-type map exists for the raw-serving route, not for a text-search tool. */
const VAULT_SEARCH_EXTENSIONS = new Set([".md", ".markdown", ".txt"]);

/** Path SEGMENTS that are NEVER searched/read, regardless of extension — a security FLOOR (err toward
 *  excluding). Checked against every segment of the vault-relative path (case-insensitive), so a note
 *  living at ANY depth under one of these folder names is excluded, not just at the top level. */
const VAULT_DENIED_SEGMENTS = new Set([
  "secrets", ".secrets", "private", "credentials", ".ssh", ".aws", ".gnupg", ".gpg", "keys", "passwords", "password",
]);

/** Basename patterns that are NEVER searched/read, regardless of the extension allow-list above —
 *  belt-and-suspenders (a `.env`/`.pem`/`.key` is excluded BOTH by extension and by this deny-list). */
const VAULT_DENIED_BASENAMES: readonly RegExp[] = [
  /^\.env(\..+)?$/i, // .env, .env.local, .env.production, ...
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /\.keystore$/i,
  /^id_rsa/i,
  /^id_ed25519/i,
];

/**
 * The mandatory security exclusion (Framework §4 `vault-read` DoD): denies any candidate note whose
 * basename or ANY path segment looks like a secret/credential, BEFORE `readVaultFile` is ever called on
 * it. This is a FLOOR, not a substitute for the extension allow-list above — both must agree a note is
 * safe. Checked on the vault-relative path (forward-slash, per `VaultEntry`), never a resolved absolute
 * path (`readVaultFile`'s own traversal/symlink-escape guard is untouched and still runs on top of this).
 */
function isDeniedVaultPath(relPath: string): boolean {
  const segments = relPath.split("/");
  if (segments.some((seg) => VAULT_DENIED_SEGMENTS.has(seg.toLowerCase()))) return true;
  const basename = segments[segments.length - 1] ?? "";
  return VAULT_DENIED_BASENAMES.some((rx) => rx.test(basename));
}

/**
 * Per-note opt-out: a leading `---\n…\n---` frontmatter block setting `companion-read: false` (or
 * `no`/`off`, quoted or bare, case-insensitive) excludes that note from `vault_lookup` even though it
 * isn't otherwise secret-shaped. NOTE: no existing vault sensitivity/exclusion marker was found in
 * `vault-lint.mjs` or `vault/browser.ts` (checked before building this) — `companion-read: false` is the
 * convention THIS lever introduces; a future vault sensitivity feature should adopt/rename this rather
 * than add a second, competing marker. Deliberately narrow (a falsy-literal match, not a full YAML
 * parse) — this tool has no other use for frontmatter.
 *
 * CR fix: `readVaultFile` reads utf8 WITHOUT stripping a leading BOM (`﻿`), which is realistic on
 * this Windows-primary host (VSCode/PowerShell commonly write one) — an un-stripped BOM sits before the
 * `---` and silently defeats the `^---` anchor, so a BOM-prefixed opt-out note would get searched anyway.
 * Strip a single leading BOM before matching, here (the only place this content is inspected for
 * frontmatter) rather than at the shared `readVaultFile` reader, which has other callers.
 */
function hasCompanionReadOptOut(content: string): boolean {
  const unbommed = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(unbommed);
  if (!fm) return false;
  return /^\s*companion-read\s*:\s*["']?(false|no|off)["']?\s*$/im.test(fm[1] ?? "");
}

const VAULT_LOOKUP_MAX_RESULTS = 15; // bounded result list — this is an injection-exposed surface
const VAULT_LOOKUP_MAX_SCANNED = 500; // total notes read across ALL target projects, one `vault_lookup` call
const VAULT_LOOKUP_EXCERPT_RADIUS = 130; // chars either side of the match (~260 char excerpt window)
// CR fix: a per-file byte cap, checked via `statVaultFile` BEFORE the full synchronous `readFileSync` +
// `.toLowerCase()` that `readVaultFile`/the match below perform — without this, one pathological huge
// note (a pasted multi-hundred-MB log) read + lowercased synchronously on the event loop can spike
// memory and freeze the daemon (the sync-hot-path hazard this repo's CLAUDE.md flags elsewhere, e.g.
// worktree provisioning). An oversize note is skipped, never read.
const VAULT_LOOKUP_MAX_FILE_BYTES = 512 * 1024;

/**
 * `vault-read` READ lever (Framework §4) — a read-only `vault_lookup` tool letting the companion search a
 * granted project's Obsidian vault notes and answer from real docs, citing a path + excerpt. Read-only —
 * there is no act half for this lever. Mirrors SESSION_STATUS/DECISIONS_RELAY/BOARD_REACH's grant-scoping
 * shape exactly; the part unique to this lever is the mandatory security exclusion above, applied to every
 * candidate note BEFORE it is ever read, on top of `readVaultFile`'s own traversal/symlink guard.
 *
 * RESIDUAL RISK (documented, not fixed here — owner-escalated separately): the deny-list + extension
 * floor above guard secret-SHAPED files (`.env`, keys/certs, a `secrets/`-named folder, …), NOT secret
 * CONTENT — a credential pasted into an ordinary `.md` note is still searchable and returnable in an
 * excerpt. That is an inherent tradeoff of "let the companion read your notes," bounded by three things:
 * this lever is granted per-project (opt-in, default OFF), the whole tool is read-only, and any individual
 * note can opt out via `companion-read: false` frontmatter. This is NOT a content-redaction/secret-
 * scanning heuristic — building one is a deliberate, separate decision, not assumed here.
 */
const VAULT_READ: CompanionCapability = {
  slug: "vault-read",
  supportsMode: ["read"],
  register(server, ctx, db) {
    server.registerTool(
      "vault_lookup",
      {
        description:
          "Search your granted project(s)' Obsidian vault notes for `query` (case-insensitive, matched " +
          "against note text and its path/title) and return matching notes as {projectId, projectName, " +
          "path, excerpt} — `path` is a citable vault-relative note path, `excerpt` a short window around " +
          "the match. Optionally pass `project` (a project id) to narrow to ONE of your granted projects — " +
          "passing a project you were NOT granted is rejected with an {error}; omitting it searches every " +
          `granted project's vault. Read-only, bounded to at most ${VAULT_LOOKUP_MAX_RESULTS} results ` +
          `(oversize notes over ${VAULT_LOOKUP_MAX_FILE_BYTES / 1024} KiB are skipped). Secret/credential-` +
          "shaped notes (.env files, key/cert files, anything under a secrets/private/credentials/keys/" +
          "passwords/.ssh/.aws/.gnupg folder) and any note opting out via a `companion-read: false` " +
          "frontmatter flag are never searched or returned.",
        inputSchema: { query: z.string(), project: z.string().optional() },
      },
      async ({ query, project }) => {
        // Belt-and-suspenders re-check (Framework §2): a `project` selector must be one of THIS grant's
        // scoped projects — it can only ever NAME a project already granted, never widen scope.
        if (project !== undefined && !ctx.scope.projectIds.has(project)) {
          return ok({ error: `project "${project}" is not in your granted scope` });
        }
        const q = query.trim().toLowerCase();
        if (!q) return ok({ error: "query must not be empty" });
        const targetProjects = project !== undefined ? new Set([project]) : ctx.scope.projectIds;

        const results: Array<{ projectId: string; projectName: string | null; path: string; excerpt: string }> = [];
        let scanned = 0;
        search: for (const pid of targetProjects) {
          const proj = db.getProject(pid);
          if (!proj?.vaultPath) continue; // no vault bound to this project — skip gracefully, no throw
          const projectName = proj.name ?? null;
          for (const entry of listVaultTree(proj.vaultPath)) {
            if (entry.type !== "file") continue;
            const ext = path.extname(entry.path).toLowerCase();
            if (!VAULT_SEARCH_EXTENSIONS.has(ext)) continue; // never read a binary/non-note file
            if (isDeniedVaultPath(entry.path)) continue; // security floor — checked BEFORE any read
            if (scanned >= VAULT_LOOKUP_MAX_SCANNED) break search;
            const stat = statVaultFile(proj.vaultPath, entry.path); // same guard, size WITHOUT a full read
            if (stat === null) continue;
            if (stat.size > VAULT_LOOKUP_MAX_FILE_BYTES) continue; // oversize note — skip, never read
            scanned++;
            const content = readVaultFile(proj.vaultPath, entry.path); // guarded traversal/symlink read
            if (content === null) continue;
            if (hasCompanionReadOptOut(content)) continue; // per-note companion-read:false opt-out
            const matchIdx = content.toLowerCase().indexOf(q);
            const titleMatch = entry.path.toLowerCase().includes(q);
            if (matchIdx === -1 && !titleMatch) continue;
            const start = matchIdx === -1 ? 0 : Math.max(0, matchIdx - VAULT_LOOKUP_EXCERPT_RADIUS);
            const end = matchIdx === -1
              ? Math.min(content.length, VAULT_LOOKUP_EXCERPT_RADIUS * 2)
              : Math.min(content.length, matchIdx + q.length + VAULT_LOOKUP_EXCERPT_RADIUS);
            const excerpt = content.slice(start, end).trim();
            results.push({ projectId: pid, projectName, path: entry.path, excerpt });
            if (results.length >= VAULT_LOOKUP_MAX_RESULTS) break search;
          }
        }
        return ok({ results });
      },
    );
  },
};

/**
 * `media-out` (Framework §4, card 3a81b0f2) — lets the owner review UI/design work from their phone ("show
 * me the latest mockup", "send a screenshot of the running app") by delivering an ALLOWLISTED file to
 * their chat. Registered ONLY when at least one of this grant's projects is act-mode (`hasActGrant`,
 * mirrors decision_resolve/board_create/update's own gate) — a read-only grant never sees this tool.
 *
 * THE ENTIRE SECURITY MODEL IS THE PATH ALLOWLIST — deliberately NO Primitive A/B/C (design note,
 * confirmed): there's no owner-composed content for this lever to attest, and the roots aren't a
 * project-decision like `decisionClasses` — the sole risk is EXFILTRATION, fully handled by a
 * realpath-guarded allowlist. `pathOrName` is resolved through the EXACT two-layer guard the vault reader
 * uses (`resolveVaultFilePath`, vault/browser.ts: lexical containment THEN a `realpathSync`
 * symlink-escape check), tried against EVERY root in this grant's allowlist — a `../` traversal, an
 * absolute path outside every root, or a symlink that resolves outside its root are all rejected; only a
 * path that resolves INSIDE some allowlisted root is ever readable/deliverable. The allowlist itself is
 * `config_json.roots: string[]`, union-merged across every granted project's own grant row (mirrors
 * attention-push's `alertClasses` union — see its `resolveConfig`) — an absent/empty roots list on EVERY
 * granted project admits NOTHING (conservative default, matching decisions-relay's own absent-allowlist
 * posture): the owner must explicitly configure at least one root before anything is deliverable. (Owner
 * sign-off 1039e892 named the recommended defaults for that config — vault `Assets/`, the session scratch
 * dir, the deja store — but this lever's own code applies no implicit fallback: an empty configured
 * allowlist delivers nothing, exactly like an empty `decisionClasses`.)
 *
 * DELIVERY is TELEGRAM-FIRST v1 (owner decision 2026-07-09): `ctx.outbound.deliverMediaToOwner` resolves
 * the active turn's own route + adapter SERVER-SIDE (never a lever-guessed destination — mirrors
 * `deliverToOwner`). A channel with no media support (in-app, today — a fast-follow card, not built here)
 * degrades GRACEFULLY (`status:"unsupported-channel"`, naming the resolved path) rather than erroring, so
 * the companion can still tell the owner where the file lives instead of the call just failing.
 */
const MEDIA_OUT: CompanionCapability = {
  slug: "media-out",
  supportsMode: ["act"],
  register(server, ctx) {
    // ACT-only lever — mirrors decision_resolve/board_create/update's own hasActGrant gate. No read half:
    // "deliver a file" IS the capability, there's no lower-risk informational query to split it from.
    const hasActGrant = [...ctx.scope.projectIds].some((pid) => ctx.scope.mayAct(pid));
    if (!hasActGrant) return;

    server.registerTool(
      "send_media",
      {
        description:
          "Deliver a file (a mockup, a vault Assets screenshot, a Playwright shot, …) from your " +
          "ALLOWLISTED source roots to the owner's chat, by path or filename. Only a path that resolves " +
          "INSIDE one of your configured roots is ever readable — a `../` traversal, an absolute path " +
          "outside every root, or a symlink escaping a root are all rejected with an {error}. Delivery is " +
          "TELEGRAM-FIRST: on a channel that doesn't support media yet (e.g. the in-app companion), this " +
          "returns {status:'unsupported-channel', note} naming the resolved path instead of failing — tell " +
          "the owner where the file is rather than treating it as an error.",
        inputSchema: { pathOrName: z.string() },
      },
      async ({ pathOrName }) => {
        // Union-merge every granted project's configured roots (mirrors attention-push's alertClasses
        // union) — deduped via a Set since the SAME absolute root configured on two granted projects must
        // not be tried twice.
        const roots = new Set<string>();
        for (const pid of ctx.scope.projectIds) {
          const cfg = ctx.scope.configFor(pid) as { roots?: unknown };
          if (Array.isArray(cfg.roots)) {
            for (const r of cfg.roots) if (typeof r === "string" && r.trim() !== "") roots.add(r);
          }
        }
        if (roots.size === 0) {
          return ok({ error: "no allowlisted source roots are configured — an owner must add at least one root to the media-out grant config before anything is deliverable" });
        }
        // THE guard: try every allowlisted root through the SAME lexical+realpath check the vault reader
        // uses. `pathOrName` may be absolute or relative to a root — resolveVaultFilePath handles both
        // (an absolute path is only accepted when it lands inside THIS root; see its own doc).
        let resolved: string | null = null;
        for (const root of roots) {
          resolved = resolveVaultFilePath(root, pathOrName);
          if (resolved !== null) break;
        }
        if (resolved === null) {
          return ok({ error: "that path doesn't resolve inside any of your allowlisted source roots" });
        }
        // CR fix (isFile alignment): resolveVaultFilePath only proves containment/existence, not that the
        // target is a REGULAR FILE — mirrors statVaultFile's own isFile() check (vault/browser.ts), which
        // this call site otherwise skips. Without it a directory inside an allowlisted root resolves
        // successfully and reaches the adapter, which can't stream it — a confusing "send-failed" instead
        // of a clean rejection. No security regression either way (containment already holds); this is
        // purely a clean-error alignment. A throwing statSync (e.g. a TOCTOU unlink) degrades to "not a
        // file" too, never a crash.
        let isRegularFile = false;
        try { isRegularFile = fs.statSync(resolved).isFile(); } catch { isRegularFile = false; }
        if (!isRegularFile) {
          return ok({ error: "that path is not a regular file" });
        }
        const delivery = await ctx.outbound.deliverMediaToOwner(ctx.sessionId, resolved);
        if (delivery.delivered) return ok({ status: "sent" });
        if (delivery.reason === "unsupported-channel") {
          return ok({
            status: "unsupported-channel",
            note: `media delivery isn't available on this channel yet — the file is at ${resolved}`,
          });
        }
        return ok({ error: `couldn't deliver the file (${delivery.reason ?? "unknown reason"})` });
      },
    );
  },
};

/**
 * `session-steer` (Framework §4, card 305a54fb) — the session-control ACT lever, REFRAMED by owner
 * redirect (decisions `47532bd0` + `71509fd5`) from a verbatim-relay "steer" into a full OPERATOR
 * surface: on the owner's intent, the companion messages/steers/stops/resumes sessions in granted scope
 * — composed from owner intent, NOT a verbatim quote (Primitive B does NOT apply here, unlike
 * `board_create`'s title/body). Decision `71509fd5` = FULLY FRICTION-FREE: all four actions commit
 * IMMEDIATELY, on the first call — NO Primitive C propose/confirm round-trip (unlike `decision_resolve`/
 * `board_create`/`board_update`). This is deliberate, owner-accepted residual risk on Loom's most
 * injection-exposed surface — the safety model is NOT structural prevention of a bad action, it's:
 *
 *   - **Primitive A, MANDATORY, on every call**: `ctx.attest.getActiveTurnOwnerText` must be non-null —
 *     a proactive/heartbeat/reminder-originated turn can never reach `sessions`. This is the ONE
 *     structural backstop kept; every one of the four tools checks it before touching `ctx.sessions`.
 *   - **Scope, re-checked on EVERY call, including stop/resume**: the target session is resolved
 *     GLOBALLY first (`db.getSession`, exactly like `board_update` resolves a bare card id) — a bare
 *     sessionId names no project until resolved — THEN its project must be ∈ `ctx.scope.projectIds` AND
 *     `ctx.scope.mayAct` for it. There is no path from a granted project to an out-of-scope session: a
 *     target whose project was never granted, or was granted read-only, is rejected before `ctx.sessions`
 *     is ever called.
 *   - **Optional per-project `config_json.roleFilter`** (e.g. `["manager"]`) narrowing which session
 *     ROLES are controllable within a granted project. DEFAULT = no restriction (an absent or empty
 *     roleFilter admits every role) — the OPPOSITE default of `decisionClasses`' conservative
 *     admit-nothing, because the owner explicitly wants "whatever I want" here (card, decision
 *     `71509fd5`) once scope + Primitive A already hold.
 *
 * `resolveControlTarget` is the ONE place all four tools run this shared validation — a lever-internal
 * mirror of `registerCompanionCapabilities`' own "one enforcement point" discipline, so a future 5th
 * session-control tool can't reintroduce a bespoke (and possibly weaker) check.
 *
 * ACT-only (mirrors `media-out`'s own `supportsMode`) — registered ONLY when at least one granted project
 * is act-mode (`hasActGrant`); there is no lower-risk read half to split "control a session" from (session
 * visibility is `session-status`'s own, separately-granted lever). `ctx.sessions` (card 305a54fb) is a
 * narrow, SCOPED slice of `SessionService` — message/steer reuse the SAME durable cross-session delivery
 * channel the Platform Lead's own `session_message`/`redirectWorker` use (framed
 * `[loom:from-owner-via-companion]`/`[loom:from-owner-via-companion:redirect]` so a live receiver knows
 * the source), and stop/resume reuse `SessionService.stopSession`/`resume` UNCHANGED — see their own docs.
 */
const SESSION_STEER: CompanionCapability = {
  slug: "session-steer",
  supportsMode: ["act"],
  register(server, ctx, db) {
    const hasActGrant = [...ctx.scope.projectIds].some((pid) => ctx.scope.mayAct(pid));
    if (!hasActGrant) return;

    // THE shared enforcement point (see this lever's own doc above) — every tool below resolves its
    // target through this BEFORE touching `ctx.sessions`, exactly once, so a future tool can't accidentally
    // skip a check by hand-rolling its own.
    function resolveControlTarget(sessionId: string): { session: Session } | { error: string } {
      const target = db.getSession(sessionId);
      if (!target) return { error: `no session "${sessionId}"` };
      const projectId = target.projectId;
      if (!projectId || !ctx.scope.projectIds.has(projectId)) {
        return { error: "this session's project is not in your granted scope" };
      }
      if (!ctx.scope.mayAct(projectId)) {
        return { error: "you only have a read-mode grant on this session's project — session control needs act-mode" };
      }
      const cfg = ctx.scope.configFor(projectId) as { roleFilter?: unknown };
      const roleFilter = Array.isArray(cfg.roleFilter)
        ? cfg.roleFilter.filter((r): r is string => typeof r === "string")
        : [];
      if (roleFilter.length > 0 && (!target.role || !roleFilter.includes(target.role))) {
        return { error: `this session's role (${target.role ?? "none"}) is not in this project's roleFilter allowlist (${roleFilter.join(", ")})` };
      }
      // Primitive A — every action, on every call, must be on an owner-authored turn. Checked LAST
      // (after scope/roleFilter) so a scope/roleFilter rejection never leaks "this would've needed owner
      // text too" — the caller learns exactly one reason per call, mirroring decision_resolve's ordering.
      if (ctx.attest.getActiveTurnOwnerText(ctx.sessionId) === null) {
        return { error: "no owner text this turn — session control can only act on an owner-authored turn" };
      }
      return { session: target };
    }

    server.registerTool(
      "session_message",
      {
        description:
          "Message a session in your granted scope, on the owner's behalf — composed from the owner's " +
          "intent (you are the OPERATOR here, not a verbatim relay). Delivered immediately, framed " +
          "[loom:from-owner-via-companion] so the receiver knows the source. Returns a deliveryStatus: " +
          "delivered-live (submitted as a turn now), queued (the target is busy — held FIFO, delivered on " +
          "its next turn boundary), or boarded (the target isn't live and has no live successor — filed as " +
          "a durable board card instead of lost). Requires an act-mode grant on the target session's " +
          "project and an owner-authored turn — a proactive/heartbeat turn is always rejected.",
        inputSchema: { target: z.string(), message: z.string() },
      },
      async ({ target, message }) => {
        const resolved = resolveControlTarget(target);
        if ("error" in resolved) return ok({ error: resolved.error });
        try {
          return ok(ctx.sessions.messageSession(target, message, ctx.sessionId));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "session_steer",
      {
        description:
          "Interrupt + redirect a session in your granted scope, on the owner's behalf — the " +
          "worker_redirect equivalent: flushes any queued-but-undelivered direction, delivers your " +
          "instruction as the new authoritative direction (framed [loom:from-owner-via-companion:redirect]), " +
          "and interrupts the target's in-flight turn if it was busy (an idle target simply receives it as " +
          "its next turn — nothing to interrupt). Requires an act-mode grant on the target session's " +
          "project and an owner-authored turn — a proactive/heartbeat turn is always rejected.",
        inputSchema: { target: z.string(), message: z.string() },
      },
      async ({ target, message }) => {
        const resolved = resolveControlTarget(target);
        if ("error" in resolved) return ok({ error: resolved.error });
        try {
          return ok(ctx.sessions.redirectSession(target, message, ctx.sessionId));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "session_stop",
      {
        description:
          "Stop a session in your granted scope, on the owner's behalf. mode \"graceful\" (default — clean " +
          "Ctrl-C x2, resumable) or \"hard\" (kill escalation); both orphan-free and resumable via " +
          "session_resume. Requires an act-mode grant on the target session's project and an " +
          "owner-authored turn — a proactive/heartbeat turn is always rejected.",
        inputSchema: { target: z.string(), mode: z.enum(["graceful", "hard"]).optional() },
      },
      async ({ target, mode }) => {
        const resolved = resolveControlTarget(target);
        if ("error" in resolved) return ok({ error: resolved.error });
        try {
          return ok(ctx.sessions.stopSession(target, mode ?? "graceful"));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );

    server.registerTool(
      "session_resume",
      {
        description:
          "Resume a STOPPED session in your granted scope, on the owner's behalf — no prompt is injected, " +
          "it simply comes back live. Requires an act-mode grant on the target session's project and an " +
          "owner-authored turn — a proactive/heartbeat turn is always rejected. A session that was " +
          "recycled (a successor exists) or is otherwise unresumable is rejected with an {error}.",
        inputSchema: { target: z.string() },
      },
      async ({ target }) => {
        const resolved = resolveControlTarget(target);
        if ("error" in resolved) return ok({ error: resolved.error });
        try {
          return ok(ctx.sessions.resumeSession(target));
        } catch (e) {
          return ok({ error: (e as Error).message });
        }
      },
    );
  },
};

/** The full lever registry (Framework §2). `session-status`, `decisions-relay`'s READ half,
 *  `board-reach`'s READ half, `vault-read` (read-only, no act half), `media-out` (act-only, no read
 *  half), and `session-steer` (act-only, no read half — session VISIBILITY is `session-status`'s own
 *  separately-granted lever) are built — any remaining sensitive ACT levers append here behind their own
 *  injection-guard primitives. */
export const COMPANION_CAPABILITIES: readonly CompanionCapability[] =
  [SESSION_STATUS, DECISIONS_RELAY, BOARD_REACH, VAULT_READ, MEDIA_OUT, SESSION_STEER];

/**
 * The single chokepoint (Framework §2): called ONCE per `buildServer`, right after the existing companion
 * gated-tool registrations. For each catalog lever, resolves its grant (`resolveCompanionGrant`) and — iff
 * granted — calls its `register()`, pre-scoped. A lever whose grant is absent is never registered: adding a
 * 7th lever adds a registry entry + a `register()`, not a 7th place to check permission.
 *
 * Defense-in-depth ROLE gate (CR hardening): a grant is only ever meaningful on a companion (`assistant`-
 * role) session — the REST writer already enforces that at write time (`resolveCompanionAgent` requires
 * role==="assistant") and role is immutable once spawned, so this is inert today. It's here anyway to match
 * the sibling `companionSessionIds.has(sessionId)` gate on chat_reply, skill_*, memory_*, and reminder_*:
 * the most injection-exposed surface in Loom should never depend on a SINGLE layer (grant presence alone)
 * staying correct forever — a future bug that leaves a stale grant row on a non-assistant session id must
 * not be enough, by itself, to light up a capability tool there.
 *
 * `attest` (Companion injection-guard primitives, card 8e511951), `pty`, `outbound` (both card a8ddd6d2),
 * and `sessions` (card 305a54fb) are injected from the router exactly like a lever's other server-derived
 * reads — additive: every lever that doesn't read them (every lever except `decision_resolve`/
 * `board_create`/`board_update`/`send_media`/`session-steer` today) sees nothing different.
 */
export function registerCompanionCapabilities(server: McpServer, sessionId: string, role: SessionRole, db: Db, attest: OwnerAttestation, pty: GrantPty, outbound: GrantOutbound, sessions: GrantSessions): void {
  if (role !== "assistant") return;
  for (const cap of COMPANION_CAPABILITIES) {
    const scope = resolveCompanionGrant(db, sessionId, cap.slug);
    if (!scope) continue;
    cap.register(server, { sessionId, scope, attest, pty, outbound, sessions }, db);
  }
}
