import { randomUUID } from "node:crypto";
import { z } from "zod";
import { QUESTION_TYPES, PERMISSION_SCOPES, PERMISSION_ANSWERS, type Question, type QuestionType, type PermissionScope } from "@loom/shared";
import { resolveIdPrefix } from "../id-prefix.js";
import type { Db } from "../db.js";

/**
 * `question_ask`'s Requests-object input shape (card 695ebab0), shared verbatim by the manager
 * (`mcp/orchestration.ts`) and Platform Lead (`mcp/platform.ts`) tool surfaces so their validation
 * behavior can never drift. `type` defaults to "decision" (today's exact shape) for backward compat — an
 * existing caller that never passes it is byte-identical to before this card. The per-type fields
 * (`options`/`recommendation` for "decision"; `action`/`scope`/`expiresAt` for "permission"; `envVar` for
 * "credential") are all optional here — `buildQuestionAsk` below is what enforces which are REQUIRED for
 * the resolved type, and silently drops any that don't apply to it.
 */
export const QUESTION_ASK_INPUT_SHAPE = {
  type: z.enum(QUESTION_TYPES).optional(),
  title: z.string(),
  body: z.string(),
  options: z.array(z.string()).optional(),
  recommendation: z.string().optional(),
  taskId: z.string().optional(),
  action: z.string().optional(),
  scope: z.enum(PERMISSION_SCOPES).optional(),
  expiresAt: z.string().optional(),
  envVar: z.string().optional(),
} as const;

export interface QuestionAskInput {
  type?: QuestionType;
  title: string;
  body: string;
  options?: string[];
  recommendation?: string;
  taskId?: string;
  action?: string;
  scope?: PermissionScope;
  expiresAt?: string;
  envVar?: string;
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
  ctx: { sessionId: string; projectId: string; db: Db },
): { question: Question } | { error: string } {
  const type: QuestionType = input.type ?? "decision";
  if (type === "permission" && !input.action?.trim()) {
    return { error: 'type:"permission" requires a non-empty `action` describing what you want authorized' };
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
      body: input.body,
      options: type === "decision" && input.options && input.options.length > 0 ? input.options : null,
      recommendation: type === "decision" ? (input.recommendation ?? null) : null,
      taskId,
      permissionAction: type === "permission" ? (input.action as string) : null,
      permissionScope: type === "permission" ? (input.scope ?? null) : null,
      permissionExpiresAt: type === "permission" ? (input.expiresAt ?? null) : null,
      credentialEnvVar: type === "credential" ? (input.envVar ?? null) : null,
      state: "pending",
      chosenOption: null,
      note: null,
      createdAt: now,
      answeredAt: null,
      consumedAt: null,
    },
  };
}

/**
 * The `type:"credential"` ack text — factored out of `questionPullItem` (card 988bb585) so
 * `taskRequestGetItem`'s full-detail read can share the EXACT same never-echo phrasing without
 * duplicating it and risking drift. Never touches `secret_blob` — it only ever reads `credentialEnvVar`,
 * the ask-time hint (not the answer).
 */
function credentialAck(q: Question): string {
  return q.credentialEnvVar
    ? `Provided and stored securely — not returned via this tool. Expect it under ${q.credentialEnvVar} ` +
      "once your environment/project config is provisioned with it."
    : "Provided and stored securely — not returned via this tool. Ask your operator how it's made available to you.";
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
 * answered one `question_pull` just drained): a still-`pending` row's answer fields all read `null`
 * instead of a misleading false-ish derivation (e.g. a pending permission would otherwise wrongly read
 * `approved:false`, indistinguishable from "denied"). Same credential never-echo guarantee as
 * `questionPullItem` — see `credentialAck`. Exported so both non-consuming read surfaces (task-scoped and
 * cross-project audit) share this ONE branching implementation instead of drifting apart.
 */
export function questionAnswerByType(q: Question): Record<string, unknown> {
  if (q.type === "credential") {
    return { ack: q.state === "pending" ? null : credentialAck(q) };
  }
  if (q.type === "permission") {
    return { approved: q.state === "pending" ? null : q.chosenOption === PERMISSION_ANSWERS[0], note: q.note };
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
 */
export function taskRequestGetItem(q: Question): Record<string, unknown> {
  return {
    id: q.id, type: q.type, title: q.title, body: q.body,
    options: q.options, recommendation: q.recommendation,
    state: q.state, taskId: q.taskId,
    createdAt: q.createdAt, answeredAt: q.answeredAt,
    ...questionAnswerByType(q),
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
  };
}
