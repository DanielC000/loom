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
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { SessionRole } from "@loom/shared";
import type { Db } from "../db.js";
import { listProjectTasks, type TaskSummary } from "../mcp/tasks.js";

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

/** Per-lever registration context — `sessionId`/`scope` are SERVER-DERIVED (never agent-passed); a lever's
 *  `register()` closes over these to pre-scope every tool it adds. */
export interface GrantContext {
  sessionId: string;
  scope: ResolvedGrantScope;
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

/**
 * `decisions-relay` READ half (Framework §4) — a read-only `decisions_list` tool reporting PENDING
 * decision-inbox questions (Framework's manager→human `Question`/`QuestionInboxItem`, db.ts) across the
 * granted projects. Mirrors `SESSION_STATUS` exactly. This card builds ONLY the read tool — the ACT half
 * (`decision_resolve`, letting the companion answer a question) is a LATER card gated on injection-guard
 * primitives + owner sign-off: a companion surface is the most injection-exposed one in Loom, so a
 * write/resolve path must not ship ahead of its guard.
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
  },
};

/**
 * `board-reach` READ half (Framework §4) — a read-only `board_list` tool giving the companion
 * cross-project board visibility over its granted projects' cards. Mirrors SESSION_STATUS/
 * DECISIONS_RELAY exactly. This card builds ONLY the read tool — the ACT half (create card, move
 * column, set priority, set held) is a LATER card gated on injection-guard primitives + owner
 * sign-off: a write path on the most injection-exposed surface in Loom must not ship ahead of its
 * guard.
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
  },
};

/** The full lever registry (Framework §2). `session-status`, `decisions-relay`'s READ half, and
 *  `board-reach`'s READ half are built — the sensitive ACT levers (later cards) append here behind
 *  their own injection-guard primitives. */
export const COMPANION_CAPABILITIES: readonly CompanionCapability[] = [SESSION_STATUS, DECISIONS_RELAY, BOARD_REACH];

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
 */
export function registerCompanionCapabilities(server: McpServer, sessionId: string, role: SessionRole, db: Db): void {
  if (role !== "assistant") return;
  for (const cap of COMPANION_CAPABILITIES) {
    const scope = resolveCompanionGrant(db, sessionId, cap.slug);
    if (!scope) continue;
    cap.register(server, { sessionId, scope }, db);
  }
}
