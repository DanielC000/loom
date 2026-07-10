import { randomUUID } from "node:crypto";
import { z } from "zod";
import { QUESTION_TYPES, PERMISSION_SCOPES, PERMISSION_ANSWERS, type Question, type QuestionType, type PermissionScope } from "@loom/shared";

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
 */
export function buildQuestionAsk(
  input: QuestionAskInput,
  ctx: { sessionId: string; projectId: string },
): { question: Question } | { error: string } {
  const type: QuestionType = input.type ?? "decision";
  if (type === "permission" && !input.action?.trim()) {
    return { error: 'type:"permission" requires a non-empty `action` describing what you want authorized' };
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
      taskId: input.taskId ?? null,
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
    return {
      questionId: q.id,
      title: q.title,
      type: q.type,
      ack: q.credentialEnvVar
        ? `Provided and stored securely — not returned via this tool. Expect it under ${q.credentialEnvVar} ` +
          "once your environment/project config is provisioned with it."
        : "Provided and stored securely — not returned via this tool. Ask your operator how it's made available to you.",
    };
  }
  if (q.type === "permission") {
    return { questionId: q.id, title: q.title, type: q.type, approved: q.chosenOption === PERMISSION_ANSWERS[0], note: q.note };
  }
  return { questionId: q.id, title: q.title, type: q.type, chosenOption: q.chosenOption, note: q.note };
}
