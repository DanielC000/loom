/**
 * The `ssh_exec` risky-command HOLD: a command that matches the connection's risky-pattern list does not run.
 * A daemon-side owner Request (`type:"permission"`, the same row `question_ask` files) is filed for the EXACT
 * connection + command text, and the identical command runs later only if the owner authorized it and the
 * grant has not lapsed. Workers have no `question_ask`, so the daemon files the Request on their behalf, owned
 * by the calling session (filedBySessionId = sessionId) and linked to its board task.
 *
 * @decision a3d5c7f4 — match an approval only by equality on the immutable ask-time `permission_action`
 * rebuilt from the CURRENT connection row; never by connection alone, a prefix, or the amendable title/body.
 */
import { createHash } from "node:crypto";
import { PERMISSION_ANSWERS, SSH_APPROVAL_ACTION_PREFIX, SSH_DENY_COOLDOWN_MS, type ConnectionMetadata, type Question } from "@loom/shared";
import type { Db } from "../db.js";
import { buildQuestionAsk, appendQuestionAskedEvent, isPermissionLapsed } from "../mcp/questionTool.js";

/** Pending ssh-approval Requests allowed per connection (a human-set number, not an agent knob). */
export const SSH_APPROVAL_PENDING_CAP = 5;

const ACTION_PREFIX = SSH_APPROVAL_ACTION_PREFIX;

/** The immutable exact-command binding. Includes the target and a short hash of the pinned host key so an
 *  approval cannot outlive an edit of the connection's address, user or pin. The pin itself is never shown. */
export function sshApprovalAction(meta: Pick<ConnectionMetadata, "id" | "host" | "port" | "user" | "hostKeyFingerprint">, command: string): string {
  const pin = createHash("sha256").update(meta.hostKeyFingerprint ?? "").digest("hex").slice(0, 12);
  return `${connectionPrefix(meta.id)}target=${meta.user ?? ""}@${meta.host}:${meta.port ?? ""} pin=${pin} command=${JSON.stringify(command.trim())}`;
}

function connectionPrefix(connectionId: string): string { return `${ACTION_PREFIX}${connectionId} `; }

/** True for a Request this module filed. */
export function isSshApprovalQuestion(q: Pick<Question, "type" | "permissionAction">): boolean {
  return q.type === "permission" && typeof q.permissionAction === "string" && q.permissionAction.startsWith(ACTION_PREFIX);
}

export type SshApprovalResolution =
  | { kind: "none" }
  | { kind: "pending"; questionId: string }
  | { kind: "approved"; question: Question; scope: "once" | "standing" }
  | { kind: "denied"; questionId: string; until: string }
  | { kind: "lapsed"; questionId: string };

type ApprovalDb = Pick<Db, "listPermissionQuestionsByAction" | "getSession" | "acknowledgeAnsweredQuestion">;

/** A deny governs identical calls for this long after the owner answered (or until the owner clears it). */
export { SSH_DENY_COOLDOWN_MS };

/** Is `filerId` the caller itself or a session the caller was recycled from? (Never a sibling session of the
 *  same agent: concurrent workers on one agent must not see each other's holds.) */
function inFilerChain(db: Pick<Db, "getSession">, callerId: string, filerId: string): boolean {
  let id: string | null | undefined = callerId;
  for (let i = 0; i < 25 && id; i++) {
    if (id === filerId) return true;
    id = db.getSession(id)?.recycledFrom;
  }
  return false;
}

/** Find the decision that governs this exact (connection, command) for THIS session: rows it filed itself or
 *  that a session in its recycle chain filed, on the SAME task. Newest 'pending'/'answered' row wins;
 *  'consumed'/'cancelled' rows are history. Only an answer the human REST route wrote (`answeredVia:"human"`)
 *  ever counts; any other answered row is ignored. A DENY keeps governing (refusing, filing nothing) for
 *  SSH_DENY_COOLDOWN_MS after it was answered, until the owner clears it. A lapsed grant is reported once and
 *  then acknowledged. */
export function resolveSshApproval(
  db: ApprovalDb, projectId: string, sessionId: string, meta: Parameters<typeof sshApprovalAction>[0], command: string,
  nowMs: number = Date.now(),
): SshApprovalResolution {
  const callerTask = db.getSession(sessionId)?.taskId ?? null;
  const rows = db.listPermissionQuestionsByAction(projectId, sshApprovalAction(meta, command)).filter((q) =>
    q.filedBySessionId !== null && q.filedBySessionId !== undefined && inFilerChain(db, sessionId, q.filedBySessionId)
    && (q.taskId === null || q.taskId === callerTask));
  // ONLY the newest row governs: a newer consumed/cleared/dismissed row must not let an older deny resurface.
  const q = rows[0];
  if (!q) return { kind: "none" };
  if (q.state === "pending") return { kind: "pending", questionId: q.id };
  if (q.state !== "answered" || q.answeredVia !== "human") return { kind: "none" };
  if (q.chosenOption !== PERMISSION_ANSWERS[0]) {
    const until = Date.parse(q.answeredAt ?? "") + SSH_DENY_COOLDOWN_MS;
    if (Number.isNaN(until) || nowMs >= until) return { kind: "none" }; // cooldown over: the deny no longer governs
    return { kind: "denied", questionId: q.id, until: new Date(until).toISOString() };
  }
  // A standing grant must carry an expiry (the answer route enforces it); one without is not honoured.
  if (q.decidedScope === "standing" && q.decidedExpiresAt === null) return { kind: "none" };
  if (isPermissionLapsed(q.decidedExpiresAt, nowMs)) {
    db.acknowledgeAnsweredQuestion(q.id, new Date(nowMs).toISOString());
    return { kind: "lapsed", questionId: q.id };
  }
  return { kind: "approved", question: q, scope: q.decidedScope === "standing" ? "standing" : "once" };
}

/** Spend an approval right before dispatch. `standing` is reusable until it lapses (no write); `once` is
 *  claimed atomically — false means another call already spent it. */
export function claimSshApproval(db: Pick<Db, "claimApprovedQuestion">, a: Extract<SshApprovalResolution, { kind: "approved" }>, nowMs: number = Date.now()): boolean {
  if (a.scope === "standing") return true;
  return db.claimApprovedQuestion(a.question.id, PERMISSION_ANSWERS[0], new Date(nowMs).toISOString());
}

export type SshHoldResult =
  | { ok: true; questionId: string }
  | { ok: false; reason: "ssh-approval-cap"; error: string }
  | { ok: false; reason: "ssh-approval-unavailable"; error: string };

/** File the owner Request for a held command. Refuses (files nothing) at the per-connection pending cap. */
export function fileSshApprovalRequest(
  db: Db, projectId: string, sessionId: string, meta: ConnectionMetadata, command: string,
): SshHoldResult {
  const pending = db.listPendingPermissionQuestionsByActionPrefix(projectId, connectionPrefix(meta.id));
  if (pending.length >= SSH_APPROVAL_PENDING_CAP) {
    return {
      ok: false, reason: "ssh-approval-cap",
      error: `too many ssh approval requests are already waiting for this connection (cap ${SSH_APPROVAL_PENDING_CAP}); ` +
        `nothing new was filed. The oldest waiting request is ${pending[0]!.id} — ask the owner to answer or dismiss it.`,
    };
  }
  const session = db.getSession(sessionId);
  const text = command.trim();
  const target = `${meta.host}:${meta.port ?? ""}`;
  const body =
    `A session is asking to run ONE command over an SSH connection that this connection's risky-command list holds for your approval.\n\n` +
    `- Connection: ${JSON.stringify(meta.name)}\n` +
    `- Host: \`${target}\`\n` +
    `- Remote user: \`${meta.user ?? ""}\`\n` +
    `- Command: \`${text}\`\n\n` +
    `Authorizing runs exactly that command text once (or, if you choose a standing grant, repeatedly until it expires). ` +
    `Any other command text, or a changed connection address, user or host key, needs its own approval. Deny to refuse it.`;
  const input = {
    type: "permission" as const,
    title: `Approve ssh command on ${JSON.stringify(meta.name)}: ${text.length > 80 ? `${text.slice(0, 80)}…` : text}`,
    body,
    action: sshApprovalAction(meta, text),
    scope: "once" as const,
    taskId: session?.taskId ?? undefined,
  };
  const ctx = { sessionId, projectId, db, role: session?.role ?? ("worker" as const), daemonFiled: true };
  let built = buildQuestionAsk(input, ctx);
  // A card the session still names but the board no longer resolves must not block the hold: retry unlinked.
  if ("error" in built && input.taskId) built = buildQuestionAsk({ ...input, taskId: undefined }, ctx);
  if ("error" in built) return { ok: false, reason: "ssh-approval-unavailable", error: "could not file the approval request" };
  try {
    db.insertQuestion(built.question);
    appendQuestionAskedEvent(db, sessionId, built.question);
  } catch {
    return { ok: false, reason: "ssh-approval-unavailable", error: "could not file the approval request" };
  }
  return { ok: true, questionId: built.question.id };
}

/** The nudge for the filing worker when the owner answers (the generic "pull it (question_pull)" text is
 *  wrong for a worker, which has no such tool). No secrets, no host key. `null` = not an ssh approval. */
export function sshApprovalAnswerNudge(q: Question, connectionName: string | null): string | null {
  if (!isSshApprovalQuestion(q)) return null;
  const name = connectionName ? JSON.stringify(connectionName) : "(connection no longer exists)";
  if (q.chosenOption === PERMISSION_ANSWERS[0]) {
    const grant = q.decidedScope === "standing"
      ? `standing${q.decidedExpiresAt ? `, expires ${q.decidedExpiresAt}` : ", no expiry set"}`
      : "once";
    return `[loom:ssh-approval-answered] your ssh_exec hold for connection ${name} was authorized (${grant}); to run it, call ssh_exec again with the IDENTICAL command.`;
  }
  return `[loom:ssh-approval-answered] your ssh_exec hold for connection ${name} was denied; that exact command will not run (identical calls are refused for 24 hours unless the owner clears the denial).`;
}

/** Where the answer nudge goes: the FILING session itself if it is live, else its newest live recycle
 *  successor; never "whoever is live on the same agent" (a sibling worker must not receive it). `null` = the
 *  filer and its chain are gone, so the nudge is dropped. */
export function sshApprovalNudgeTarget(db: Pick<Db, "getSession" | "getSuccessor">, q: Pick<Question, "filedBySessionId">): string | null {
  let id: string | null | undefined = q.filedBySessionId;
  for (let i = 0; i < 25 && id; i++) {
    const s = db.getSession(id);
    if (s?.processState === "live") return s.id;
    id = db.getSuccessor(id)?.id;
  }
  return null;
}

/** Connection id embedded in an ssh approval's action text, or null. */
export function sshApprovalConnectionId(q: Pick<Question, "permissionAction">): string | null {
  const a = q.permissionAction ?? "";
  if (!a.startsWith(ACTION_PREFIX)) return null;
  const rest = a.slice(ACTION_PREFIX.length);
  const sp = rest.indexOf(" ");
  return sp > 0 ? rest.slice(0, sp) : null;
}
