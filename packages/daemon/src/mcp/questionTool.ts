import { randomUUID } from "node:crypto";
import { z } from "zod";
import { QUESTION_TYPES, PERMISSION_SCOPES, PERMISSION_ANSWERS, type Question, type QuestionType, type PermissionScope, type ProvisionTarget, type SessionRole } from "@loom/shared";
import { resolveIdPrefix } from "../id-prefix.js";
import type { Db } from "../db.js";
import { resolveAlias } from "./arg-alias.js";

/** Roles allowed to set `provisionTo` on a `type:"credential"` ask (card 193de09e Q1) — manager and
 *  platform (the Lead) only. Enforced in `buildQuestionAsk` below so both `question_ask` registrations
 *  (`mcp/orchestration.ts`, `mcp/platform.ts`) share the ONE check and can never drift. Today `question_ask`
 *  itself is only ever registered for these two roles anyway (a worker's MCP surface has no `question_ask`
 *  at all — see `mcp/orchestration.ts`'s `role === "worker"` branch), so this is a structural belt-and-
 *  suspenders backstop against a future surface change, not a live workaround. */
const PROVISIONING_ROLES: readonly SessionRole[] = ["manager", "platform"];

/**
 * `question_ask`'s Requests-object input shape (card 695ebab0), shared verbatim by the manager
 * (`mcp/orchestration.ts`) and Platform Lead (`mcp/platform.ts`) tool surfaces so their validation
 * behavior can never drift. `type` defaults to "decision" (today's exact shape) for backward compat — an
 * existing caller that never passes it is byte-identical to before this card. The per-type fields
 * (`options`/`recommendation` for "decision"; `action`/`scope`/`expiresAt` for "permission"; `envVar`/
 * `provisionTo` for "credential") are all optional here — `buildQuestionAsk` below is what enforces which
 * are REQUIRED for the resolved type, and silently drops any that don't apply to it.
 */
export const QUESTION_ASK_INPUT_SHAPE = {
  type: z.enum(QUESTION_TYPES).optional(),
  title: z.string(),
  // `body` is the canonical param; `detail` (platform_escalate's name for the same concept) is
  // accepted as an ALIAS for it — resolved in buildQuestionAsk below (card fix(mcp): accept
  // arg-name aliases). Both optional here so a caller passing only `detail` still validates; buildQuestionAsk
  // rejects the case where NEITHER is given.
  body: z.string().optional(),
  detail: z.string().optional(),
  options: z.array(z.string()).optional(),
  recommendation: z.string().optional(),
  taskId: z.string().optional(),
  action: z.string().optional(),
  scope: z.enum(PERMISSION_SCOPES).optional(),
  expiresAt: z.string().optional(),
  envVar: z.string().optional(),
  // Card feat(orchestration): add an explicit supersedes:<id> param to question_ask — the questionId of a
  // still-PENDING ask (asked by the SAME caller) that this new ask replaces. Resolved in the tool handlers
  // (mcp/orchestration.ts, mcp/platform.ts) via `applySupersede` below, NOT here — this shape only carries
  // the raw param through validation.
  supersedes: z.string().optional(),
  // Credential auto-provisioning v1 (card 193de09e) — STATING INTENT only; see ProvisionTarget's own doc.
  // Restricted to manager/platform roles (buildQuestionAsk's role gate below).
  provisionTo: z
    .object({
      connection: z.object({ name: z.string(), host: z.string() }),
      binding: z.object({ profileId: z.string() }).optional(),
    })
    .optional(),
} as const;

export interface QuestionAskInput {
  type?: QuestionType;
  title: string;
  body?: string;
  detail?: string;
  options?: string[];
  recommendation?: string;
  taskId?: string;
  action?: string;
  scope?: PermissionScope;
  expiresAt?: string;
  envVar?: string;
  provisionTo?: ProvisionTarget;
  supersedes?: string;
}

/**
 * Validate + shape a `question_ask` call into an insertable `Question` row (card 695ebab0). Returns
 * `{error}` for a caller mistake the tool should reject outright (today: a "permission" ask with no
 * `action` — there is nothing for the human to authorize/deny without one). Per-type fields NOT relevant
 * to the resolved `type` are silently dropped rather than rejected, so an agent that always passes every
 * field it knows about (harmless extras) never gets a spurious error.
 *
 * `taskId` (card 9be9784a) is resolved to a FULL task id here — via the same `resolveIdPrefix` the
 * `loom-tasks` tools use, scoped to `ctx.projectId`'s own tasks — and the RESOLVED id is what's stored.
 * Every other `loom-tasks` tool accepts an unambiguous 8-char id-prefix (the form Loom displays), so a
 * manager naturally passes one here too; storing it verbatim used to orphan the Request from its card
 * (the connected-requests read matches on the full id). An ambiguous or unknown `taskId` is now rejected
 * outright rather than silently stored as a dead link.
 */
export function buildQuestionAsk(
  input: QuestionAskInput,
  ctx: { sessionId: string; projectId: string; db: Db; role: SessionRole },
): { question: Question } | { error: string } {
  const type: QuestionType = input.type ?? "decision";
  const body = resolveAlias(input.body, input.detail);
  if (body === undefined) return { error: "body (or detail) is required" };
  if (type === "permission" && !input.action?.trim()) {
    return { error: 'type:"permission" requires a non-empty `action` describing what you want authorized' };
  }
  if (input.provisionTo && !PROVISIONING_ROLES.includes(ctx.role)) {
    return { error: `provisionTo (auto-provisioning) is restricted to ${PROVISIONING_ROLES.join("/")} roles` };
  }
  if (type === "credential" && input.provisionTo) {
    if (!input.provisionTo.connection?.name?.trim() || !input.provisionTo.connection?.host?.trim()) {
      return { error: "provisionTo.connection requires non-empty `name` and `host`" };
    }
    if (input.provisionTo.binding && !input.provisionTo.binding.profileId?.trim()) {
      return { error: "provisionTo.binding requires a non-empty `profileId`" };
    }
  }
  let taskId: string | null = null;
  if (input.taskId) {
    const r = resolveIdPrefix(ctx.db.listTasks(ctx.projectId), input.taskId);
    if (r.kind === "ambiguous") {
      return { error: `ambiguous task id-prefix '${input.taskId}' — it matches ${r.ids.join(", ")}; pass more characters or the full id` };
    }
    if (r.kind === "none") {
      return { error: `taskId '${input.taskId}' does not match any task on this project's board — pass a full task id, an unambiguous 8-char prefix, or omit taskId` };
    }
    taskId = r.record.id;
  }
  const now = new Date().toISOString();
  return {
    question: {
      id: randomUUID(),
      sessionId: ctx.sessionId,
      projectId: ctx.projectId,
      type,
      title: input.title,
      body,
      options: type === "decision" && input.options && input.options.length > 0 ? input.options : null,
      recommendation: type === "decision" ? (input.recommendation ?? null) : null,
      taskId,
      permissionAction: type === "permission" ? (input.action as string) : null,
      permissionScope: type === "permission" ? (input.scope ?? null) : null,
      permissionExpiresAt: type === "permission" ? (input.expiresAt ?? null) : null,
      credentialEnvVar: type === "credential" ? (input.envVar ?? null) : null,
      provisionTarget: type === "credential" ? (input.provisionTo ?? null) : null,
      provisionConnectionId: null,
      provisionBindingState: "none",
      state: "pending",
      chosenOption: null,
      note: null,
      createdAt: now,
      answeredAt: null,
      consumedAt: null,
      cancelledReason: null,
      cancelledBy: null,
      cancelledAt: null,
    },
  };
}

/**
 * The `type:"credential"` ack text — factored out of `questionPullItem` (card 988bb585) so
 * `taskRequestGetItem`'s full-detail read can share the EXACT same never-echo phrasing without
 * duplicating it and risking drift. Never touches `secret_blob` — it only ever reads `credentialEnvVar`/
 * `provisionTarget`/`provisionConnectionId`/`provisionBindingState`, all ask-time-hint or non-secret
 * answer-time metadata (never the answer itself).
 *
 * Branches on whether auto-provisioning was requested (card 193de09e): with no `provisionTarget`, the
 * wording is UNCHANGED from before this card — a human still has to wire it in by hand, auto-wiring is a
 * separate, unbuilt path (card 3f8bd560's honest-ack lesson). With a `provisionTarget`, the answer boundary
 * has already created/updated a Connection by the time this reads `answered` — the ack names it, and is
 * explicit that a requested profile binding is only ever PENDING human confirmation here, never applied:
 * it must never read as "wired up and ready to use."
 */
function credentialAck(q: Question): string {
  if (q.provisionTarget) {
    const bindingNote =
      q.provisionBindingState === "pending"
        ? ` A binding to profile "${q.provisionTarget.binding?.profileId}" is PENDING human confirmation — ` +
          "it is NOT yet wired to any session; an operator must apply it before an agent can use it."
        : " No profile binding was requested — an operator must still bind this Connection to a profile " +
          "before any agent session can use it.";
    return (
      `Provided and stored securely — not returned via this tool. It was provisioned into Connection ` +
      `"${q.provisionTarget.connection.name}" (id ${q.provisionConnectionId}).` + bindingNote
    );
  }
  return q.credentialEnvVar
    ? `Provided and stored securely — not returned via this tool. It is NOT auto-injected into any ` +
      `session env; a human must wire it into a Connection or this project's config (as ${q.credentialEnvVar}) ` +
      "before an agent session can use it."
    : "Provided and stored securely — not returned via this tool. It is NOT auto-injected into any " +
      "session env; ask your operator how (or whether) it's made available to you.";
}

/**
 * Shape ONE pulled-and-consumed `Question` into `question_pull`'s agent-facing payload (card 695ebab0),
 * branching by `type`. A "credential" answer NEVER surfaces a secret here — there is none to surface: the
 * `Question` object itself never carries it (db.ts's `toQuestion` deliberately never maps `secret_blob`)
 * — the agent only ever gets an ack. A "permission" answer surfaces `approved` (derived from
 * `chosenOption`) instead of a raw option string, since the REST answer route constrains a permission's
 * `chosenOption` to exactly one of `PERMISSION_ANSWERS` — the SAME shared const this derivation compares
 * against, so the write-side validation and this read-side derivation can never drift apart.
 */
export function questionPullItem(q: Question): Record<string, unknown> {
  if (q.type === "credential") {
    return { questionId: q.id, title: q.title, type: q.type, ack: credentialAck(q) };
  }
  if (q.type === "permission") {
    return { questionId: q.id, title: q.title, type: q.type, approved: q.chosenOption === PERMISSION_ANSWERS[0], note: q.note };
  }
  return { questionId: q.id, title: q.title, type: q.type, chosenOption: q.chosenOption, note: q.note };
}

/**
 * The per-type ANSWER shape shared by `taskRequestGetItem` and `auditRequestItem` (card 59489267) — same
 * branching/fields as `questionPullItem`, but safe to call on a row in ANY state (not just a freshly-
 * answered one `question_pull` just drained): a row that was never actually answered — still `pending`, OR
 * terminally `cancelled` (question_cancel/dismiss, card feat(orchestration): question_cancel + dismiss) —
 * has its answer fields all read `null` instead of a misleading false-ish derivation (e.g. an unanswered
 * permission would otherwise wrongly read `approved:false`, indistinguishable from "denied"; an unanswered
 * credential would otherwise call `credentialAck`, which assumes an answer boundary actually ran, and
 * fabricate a "provided and stored securely" ack for a secret that was never given). Same credential
 * never-echo guarantee as `questionPullItem` — see `credentialAck`. Exported so both non-consuming read
 * surfaces (task-scoped and cross-project audit) share this ONE branching implementation instead of
 * drifting apart.
 */
export function questionAnswerByType(q: Question): Record<string, unknown> {
  const hasAnswer = q.state === "answered" || q.state === "consumed";
  if (q.type === "credential") {
    return { ack: hasAnswer ? credentialAck(q) : null };
  }
  if (q.type === "permission") {
    return { approved: hasAnswer ? q.chosenOption === PERMISSION_ANSWERS[0] : null, note: q.note };
  }
  return { chosenOption: q.chosenOption, note: q.note };
}

/**
 * Shape ONE `Question` (any state) into `task_request_get`'s full-detail agent-facing payload (card
 * 988bb585) — the FULL ask (body/options/recommendation/type/state) plus its answer-by-type (see
 * `questionAnswerByType`). Distinct from `questionPullItem`: this is a NON-CONSUMING read reachable for
 * a request in ANY state, not just a freshly-pulled 'answered' one. NEVER returns `secret_blob` for a
 * "credential" request — mirrors `questionPullItem`'s credential branch exactly (shared `credentialAck`);
 * structurally guaranteed too, since the `Question` object this reads never carries it in the first place
 * (db.ts's `toQuestion` deliberately never maps `secret_blob`).
 *
 * `provisioning` (card 193de09e) surfaces the non-secret auto-provisioning audit trail — the REQUESTED
 * target (name/host/binding, ask-time) plus the RESULT (connectionId/bindingState, answer-time) — for the
 * Platform Auditor and the board's connected-requests read. Always present (even for a non-provisioning
 * credential ask, or a non-credential type) so callers don't have to branch on its absence; every field is
 * null/"none" when provisioning was never requested.
 */
export function taskRequestGetItem(q: Question): Record<string, unknown> {
  return {
    id: q.id, type: q.type, title: q.title, body: q.body,
    options: q.options, recommendation: q.recommendation,
    state: q.state, taskId: q.taskId,
    createdAt: q.createdAt, answeredAt: q.answeredAt,
    ...questionAnswerByType(q),
    provisioning: provisioningAudit(q),
    // question_cancel/dismiss — null unless state:"cancelled". Surfaced here (and in auditRequestItem
    // below) so a task/audit reader can tell WHY a request left the pending inbox without an answer.
    cancelledReason: q.cancelledReason, cancelledBy: q.cancelledBy,
  };
}

/**
 * The non-secret auto-provisioning audit shape (card 193de09e) shared by `taskRequestGetItem` and
 * `auditRequestItem` — NEVER the secret value, only the requested target + the created/updated
 * Connection's id + the binding's pending/applied/none state.
 */
function provisioningAudit(q: Question): Record<string, unknown> {
  return {
    requested: q.provisionTarget
      ? { connectionName: q.provisionTarget.connection.name, host: q.provisionTarget.connection.host, bindingProfileId: q.provisionTarget.binding?.profileId ?? null }
      : null,
    connectionId: q.provisionConnectionId,
    bindingState: q.provisionBindingState,
  };
}

/**
 * Shape ONE request (any state, any project) — enriched with its asking session's `agentId` (joined
 * server-side by `db.listQuestionsForAudit`; not a column on the `Question` row itself) — into the
 * Platform Auditor's cross-project `requests_list` payload (card 59489267). Title-altitude + answer-by-
 * type, NOT the full body/options/recommendation (that's `task_request_get`'s job): the audit LIST spans
 * every project's Requests at once, so it stays bounded the way `task_requests_list`'s rows do, plus the
 * identity fields (`projectId`/`sessionId`/`agentId`/`taskId`) a cross-project triage needs that a single-
 * project caller already knows from context. NON-CONSUMING; shares `questionAnswerByType` with
 * `taskRequestGetItem` so the credential never-echo guarantee (never `secret_blob`, only `ack`) can never
 * drift between the two read surfaces.
 */
export function auditRequestItem(q: Question & { agentId: string | null }): Record<string, unknown> {
  return {
    id: q.id, projectId: q.projectId, sessionId: q.sessionId, agentId: q.agentId, taskId: q.taskId,
    type: q.type, title: q.title, state: q.state,
    createdAt: q.createdAt, answeredAt: q.answeredAt, consumedAt: q.consumedAt,
    ...questionAnswerByType(q),
    provisioning: provisioningAudit(q),
    // question_cancel/dismiss — null unless state:"cancelled". See taskRequestGetItem's twin field.
    cancelledReason: q.cancelledReason, cancelledBy: q.cancelledBy,
  };
}

/**
 * Agent-lineage-scoped cancel — the shared implementation behind BOTH `question_cancel` MCP tool
 * registrations (mcp/orchestration.ts's manager surface, mcp/platform.ts's Lead surface) so the two
 * callers' ownership-check + error-shaping can never drift apart, mirroring how `buildQuestionAsk` is
 * shared for the ask side. Scoped the SAME way `question_pull`/`requests_list({mine:true})` are — by
 * `sessions.agent_id`, not the exact asking session id — so a fresh (non-recycle) successor session on the
 * same agent lineage may still cancel a still-pending ask a predecessor session filed.
 *
 * Rejects: a question asked by a DIFFERENT agent lineage (an asker may only cancel its own asks — never
 * another agent's, mirroring the `mine` ownership boundary); a genuinely unknown id; and — the load-bearing
 * case — a question that has already LEFT the 'pending' state. `Db.cancelQuestion` throws when the row
 * isn't pending, naming its actual current state; this catches that and, specifically for "already
 * answered", returns a message that tells the caller an answer is now available (via question_pull) rather
 * than a generic rejection — so an agent racing a human's answer can never read a failed cancel as having
 * silently discarded that answer.
 */
export function cancelQuestionForAgent(
  db: Db,
  askerSessionId: string,
  questionId: string,
  reason: string | undefined,
): { cancelled: true; questionId: string } | { error: string } {
  const asker = db.getSession(askerSessionId);
  if (!asker) return { error: "session not found" };
  const question = db.getQuestion(questionId);
  if (!question) return { error: "question not found" };
  const askingSession = db.getSession(question.sessionId);
  if (!askingSession || askingSession.agentId !== asker.agentId) {
    return { error: "you may only cancel a request asked by your own agent lineage — not another agent's" };
  }
  try {
    const cancelled = db.cancelQuestion(questionId, { reason: reason?.trim() || null, cancelledBy: "agent" });
    if (!cancelled) return { error: "question not found" };
    return { cancelled: true, questionId: cancelled.id };
  } catch (e) {
    const message = (e as Error).message;
    if (message.includes("already answered")) {
      return { error: "cannot cancel — this request was just answered; call question_pull to get the answer instead of discarding it" };
    }
    return { error: message };
  }
}

/**
 * `question_ask`'s optional `supersedes:<questionId>` handling (card feat(orchestration): add an explicit
 * supersedes:<id> param to question_ask that auto-cancels the named prior pending ask). The originating
 * card floated an AUTO-supersede heuristic ("this new ask obviously replaces that old one") — deliberately
 * REJECTED, because "obviously replaces" eventually guesses wrong and silently cancels a live owner ask.
 * This is the safe, non-heuristic version: the asker names the exact prior ask it's replacing, explicitly,
 * at the moment it knows.
 *
 * Reuses `cancelQuestionForAgent` VERBATIM — the identical agent-lineage ownership check, pending-only
 * constraint, and atomic answer-race refusal as the standalone `question_cancel` tool; this never forks a
 * parallel cancel implementation. The `reason` stamped on the cancelled row links back to the new ask
 * (id + title) so a human reading the retained history sees WHY it was withdrawn.
 *
 * Load-bearing: the new ask is filed **regardless** of whether the supersede succeeds. A failed supersede
 * (the named ask was already answered/cancelled in the meantime, is unknown, or belongs to another agent)
 * is reported back to the caller in the returned `supersede` field — never silently swallowed — but it
 * NEVER blocks or discards the caller's actual new ask, and it can never clobber an answer the human
 * already gave (the same guarantee `question_cancel` itself makes).
 *
 * **CALL-ORDER CONTRACT — not a transaction, an ordering guarantee:** both callers MUST `db.insertQuestion`
 * the new ask BEFORE calling this function, never after. There is no DB transaction spanning the two writes
 * (insert + cancel), so the ORDER is what makes every failure mode safe: if the insert itself throws
 * (constraint/IO error), nothing has been cancelled yet — the prior ask stays exactly as it was. If THIS
 * call fails/throws instead, the new ask is already filed and the prior ask simply stays `pending`
 * (visible, redundant, but never lost). Reversing the order would open a window where a failed insert
 * leaves the prior ask cancelled with NO replacement filed — the owner's pending decision would vanish with
 * nothing in its place, exactly the failure this whole feature exists to prevent. Always fail toward the
 * harmless outcome (a stale-but-present duplicate ask), never the unrecoverable one (a vanished ask).
 *
 * Called with the SAME `askerSessionId` as the new ask's own asker, from both `question_ask` registrations
 * (mcp/orchestration.ts's manager surface, mcp/platform.ts's Lead surface) so ownership is scoped to that
 * one caller's own agent lineage in both places, identically.
 */
export function applySupersede(
  db: Db,
  askerSessionId: string,
  supersedesId: string,
  newQuestion: Question,
): { cancelled: true; questionId: string } | { error: string } {
  const reason = `superseded by a newer ask: "${newQuestion.title}" (question ${newQuestion.id})`;
  return cancelQuestionForAgent(db, askerSessionId, supersedesId, reason);
}

/** The `{items,total,returned,offset,hasMore}` envelope shape both `requests_list` sites return. */
export interface PagedResult<T> {
  items: T[];
  total: number;
  returned: number;
  offset: number;
  hasMore: boolean;
}

/**
 * ONE shared pager for the two sibling `requests_list` tools (mcp/orchestration.ts's manager surface,
 * mcp/audit.ts's Auditor surface) — closes a two-path divergence where the manager side carried the
 * `{items,total,returned,offset,hasMore}` truncation-signal envelope (card a193398f) while the Auditor
 * side stayed a bare, silently-capped array (card requests-list-two-path-cap-asymmetry). Both call sites
 * now slice + shape through this ONE function so the envelope can't drift apart again; the caller still
 * does its own `db.listQuestionsForAudit` (scoping differs: project-scoped for the manager, cross-project
 * for the Auditor) and its own `.map(auditRequestItem)`, since `pageRequests` only knows about slicing —
 * generic over any row type, not the Requests shape specifically.
 */
export function pageRequests<T>(
  all: T[],
  opts: { limit?: number; offset?: number },
  defaultLimit: number,
): PagedResult<T> {
  const offset = opts.offset ?? 0;
  const limit = opts.limit ?? defaultLimit;
  const items = all.slice(offset, offset + limit);
  return { items, total: all.length, returned: items.length, offset, hasMore: offset + items.length < all.length };
}
