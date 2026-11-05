/**
 * The `ssh_exec` MCP tool's core: resolve a granted ssh connection, apply Loom-side policy, run ONE command
 * through the exec core, and AUDIT every call. Like `request.ts`, the session-level grant (which connection
 * ids a session may use) is enforced by the CALLER (mcp/server.ts, off the SESSION row) before this runs, and
 * is re-checked here (defense in depth).
 *
 * Audit protocol (`ssh_command_run` events, two rows per call joined by a shared `callId`):
 *   1. an ATTEMPT row is written FIRST, before any step that can throw — if it cannot be written the call is
 *      refused and nothing runs;
 *   2. every path after that (refused / held / error / ran) writes an OUTCOME row. An attempt row with no
 *      outcome row means the daemon died mid-call. A risky-pattern match is `held` (an owner Request was
 *      filed or is already pending); a `ran` row of an approved command carries `approvalRequestId`.
 * Command text lives ONLY in these event rows — never in a log line.
 *
 * @decision a3d5c7f4 — the attempt row precedes every throwable step, every caught path writes an outcome
 * row, and the private key, ssh2's error text and output bodies never reach a row or a returned error.
 */
import { randomUUID } from "node:crypto";
import type { ConnectionsGuardConfig } from "@loom/shared";
import type { Db } from "../db.js";
import { getConnectionMetadata, getSshPrivateKeyForUse, isConnectionUsableByProject } from "./store.js";
import { claimSshApproval, fileSshApprovalRequest, resolveSshApproval, type SshApprovalResolution } from "./sshApproval.js";
import { runSshExecCommand, MAX_TIMEOUT_MS, type SshExecInput, type SshExecResult } from "./ssh.js";
import { evaluateSshCommandPolicy, sshTargetShapeError, SSH_MAX_COMMAND_LENGTH } from "./sshPolicy.js";

/** Per-stream byte cap for command output returned to the agent. */
const SSH_EXEC_MAX_OUTPUT_BYTES = 65_536;

export interface SshExecDeps {
  /** The real `Db`: the hold files and reads owner Requests through it. */
  db: Db;
  sessionId: string;
  projectId: string;
  guard: ConnectionsGuardConfig;
  /** Envelope key-file override — the test seam. */
  keyPath?: string;
  /** Exec-core override — the test seam (production always uses the real ssh2 core). */
  runner?: (input: SshExecInput) => Promise<SshExecResult>;
  now?: () => number;
}

export type SshExecToolResult =
  | { ok: true; exitCode: number | null; stdout: string; stderr: string; truncated: boolean }
  | { ok: false; error: string; reason?: string; kind?: string; status?: "awaiting-owner-approval"; approvalRequestId?: string };

// --- per-connection rate limiter (in-memory; counts only GENUINE dispatches) ----------------------------
const sshRateState = new Map<string, number[]>();
function checkSshRateLimit(connectionId: string, guard: ConnectionsGuardConfig, now: number): boolean {
  const cutoff = now - guard.rateLimitWindowMs;
  const recent = (sshRateState.get(connectionId) ?? []).filter((t) => t > cutoff);
  if (recent.length >= guard.rateLimitMax) { sshRateState.set(connectionId, recent); return false; }
  recent.push(now);
  sshRateState.set(connectionId, recent);
  return true;
}
/** TEST-ONLY: clear the ssh rate-limit state between cases. */
export function __resetSshRateLimitState(): void { sshRateState.clear(); }

const clip = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

export async function performSshExec(
  deps: SshExecDeps,
  sessionConnections: string[],
  args: { connectionId: unknown; command: unknown },
): Promise<SshExecToolResult> {
  const { db, sessionId, projectId } = deps;
  const callId = randomUUID();
  const startedAt = (deps.now ?? Date.now)();
  const command = typeof args?.command === "string" ? args.command : "";
  const stored = { command: clip(command, SSH_MAX_COMMAND_LENGTH), commandLength: command.length };
  const emit = (detail: Record<string, unknown>): void => {
    db.appendEvent({
      id: randomUUID(), ts: new Date().toISOString(), managerSessionId: "", workerSessionId: sessionId,
      kind: "ssh_command_run", detail: { callId, sessionId, projectId, ...detail },
    });
  };

  // 1. ATTEMPT row — before anything that can throw. Unwritable audit ⇒ nothing runs.
  try {
    emit({
      phase: "attempt", connectionRef: clip(String(args?.connectionId ?? ""), 200),
      agentId: db.getSession(sessionId)?.agentId ?? null, ...stored,
    });
  } catch {
    return { ok: false, error: "ssh_exec is unavailable: the audit record could not be written", reason: "audit-unavailable" };
  }

  let target: { connectionId: string | null; host: string | null; port: number | null; user: string | null; approvalRequestId?: string; approvalScope?: string } =
    { connectionId: null, host: null, port: null, user: null };
  // 2. Every path below funnels through finish(), which writes the OUTCOME row (best-effort, never throws).
  const finish = (result: SshExecToolResult, detail: Record<string, unknown>): SshExecToolResult => {
    try {
      emit({ phase: "outcome", ...target, ...stored, ...detail, durationMs: Math.max(0, (deps.now ?? Date.now)() - startedAt) });
    } catch {
      // An unwritable outcome row must not turn a completed call into a throw — but it leaves an attempt
      // row with no outcome, so leave ONE command-free breadcrumb (ids only; never command text).
      console.warn(`[ssh_exec] outcome audit row not written callId=${callId} connectionId=${target.connectionId ?? "unresolved"}`);
    }
    return result;
  };
  const refuse = (error: string, reason: string, extra: Record<string, unknown> = {}): SshExecToolResult =>
    finish({ ok: false, error, reason }, { outcome: "refused", reason, ...extra });

  try {
    const wanted = typeof args?.connectionId === "string" ? args.connectionId : "";
    if (!wanted || !sessionConnections.includes(wanted)) return refuse("connection not permitted for this session", "connection-not-permitted");
    const meta = getConnectionMetadata(db, wanted);
    if (!meta || meta.authScheme !== "ssh" || !isConnectionUsableByProject(meta.projectId, projectId)) {
      return refuse("ssh connection not found", "connection-not-found");
    }
    target = { connectionId: meta.id, host: meta.host, port: meta.port ?? null, user: meta.user ?? null };

    const verdict = await evaluateSshCommandPolicy(meta, args.command);
    if (!verdict.allowed) return refuse(`command refused (${verdict.reason})`, verdict.reason);

    const shapeError = sshTargetShapeError(meta.host, meta.user);
    if (shapeError) return refuse(shapeError, "invalid-connection-target");
    if (!meta.hostKeyFingerprint || !Number.isInteger(meta.port)) return refuse("ssh connection is incomplete", "connection-incomplete");

    // A risky match HOLDS the command: nothing is dispatched on the policy verdict alone. Resolve the owner's
    // decision for this EXACT (connection, command) first; only an authorized, unlapsed approval continues.
    let approval: Extract<SshApprovalResolution, { kind: "approved" }> | null = null;
    if (verdict.requiresApproval) {
      const now = (deps.now ?? Date.now)();
      const res = resolveSshApproval(db, projectId, sessionId, meta, command, now);
      const held = (questionId: string, text: string): SshExecToolResult =>
        finish(
          { ok: false, error: text, reason: "risky-pattern-requires-approval", status: "awaiting-owner-approval", approvalRequestId: questionId },
          { outcome: "held", reason: "risky-pattern-requires-approval", approvalRequestId: questionId },
        );
      if (res.kind === "pending") return held(res.questionId, `awaiting owner approval (request ${res.questionId}); call ssh_exec again with the IDENTICAL command once the owner has decided`);
      if (res.kind === "denied") return refuse(`the owner denied this exact command; it will not run and no new request is filed until ${res.until} or until the owner clears the denial`, "ssh-approval-denied", { approvalRequestId: res.questionId });
      if (res.kind === "lapsed") return refuse("the owner's approval for this exact command has expired; calling again files a new request", "ssh-approval-lapsed", { approvalRequestId: res.questionId });
      if (res.kind === "none") {
        const filed = fileSshApprovalRequest(db, projectId, sessionId, meta, command);
        if (!filed.ok) return refuse(filed.error, filed.reason);
        return held(filed.questionId, `awaiting owner approval (request ${filed.questionId}); this command matches a risky pattern and was NOT run. Call ssh_exec again with the IDENTICAL command once the owner has decided`);
      }
      approval = res;
    }

    if (!checkSshRateLimit(meta.id, deps.guard, (deps.now ?? Date.now)())) {
      return refuse("rate limit exceeded for this connection", "rate-limited");
    }

    let privateKey: string | undefined;
    try { privateKey = getSshPrivateKeyForUse(db, meta.id, deps.keyPath); } catch { privateKey = undefined; }
    if (!privateKey) return finish({ ok: false, error: "ssh key unavailable", reason: "key-unavailable" }, { outcome: "error", errorKind: "key-unavailable" });

    // Spend the approval LAST, immediately before dispatch, so a refusal above never burns a once-grant and
    // two racing calls can never both run it.
    if (approval) {
      if (!claimSshApproval(db, approval, (deps.now ?? Date.now)())) {
        return refuse("this approval was already used; calling again files a new request", "ssh-approval-used", { approvalRequestId: approval.question.id });
      }
      target = { ...target, approvalRequestId: approval.question.id, approvalScope: approval.scope };
    }

    const result = await (deps.runner ?? runSshExecCommand)({
      host: meta.host, port: meta.port!, user: meta.user!, privateKey,
      expectedFingerprint: meta.hostKeyFingerprint, command: command.trim(),
      timeoutMs: Math.min(Math.max(1, Math.floor(deps.guard.requestTimeoutMs)), MAX_TIMEOUT_MS),
      maxOutputBytes: Math.min(deps.guard.maxResponseBytes > 0 ? Math.floor(deps.guard.maxResponseBytes) : SSH_EXEC_MAX_OUTPUT_BYTES, SSH_EXEC_MAX_OUTPUT_BYTES),
    });
    if (!result.ok) {
      return finish({ ok: false, error: result.error, kind: result.kind }, { outcome: "error", errorKind: result.kind });
    }
    const scrub = (s: string): string => (privateKey && s.includes(privateKey) ? s.split(privateKey).join("[REDACTED]") : s);
    return finish(
      { ok: true, exitCode: result.exitCode, stdout: scrub(result.stdout), stderr: scrub(result.stderr), truncated: result.truncated },
      { outcome: "ran", exitCode: result.exitCode, truncated: result.truncated, stdoutBytes: result.stdout.length, stderrBytes: result.stderr.length },
    );
  } catch {
    // Any unexpected throw: fixed text only (never the thrown error's message), still audited.
    return finish({ ok: false, error: "ssh_exec failed unexpectedly", reason: "internal-error" }, { outcome: "error", errorKind: "internal-error" });
  }
}
