/**
 * Loom Companion — auto-revive (bug 4cc7826d). An enabled+provisioned companion has NO human viewer to
 * notice a dead bound session and click "Resume" the way a manager/worker's owner would: `handleInbound`
 * (chat-gateway.ts) instead just acks "session isn't currently running" forever after. `recoverStaleSessions`
 * marks EVERY prior-run session — companion included — 'exited' on every boot, and a normal (non-
 * `daemon_restart`) restart carries no restart-intent to auto-resume the fleet either, so a companion whose
 * session died stays dead across every subsequent restart/crash until a human happens to open the Companion
 * page and hit its restart affordance (`restartCompanionSession`).
 *
 * Both helpers here reuse the SAME `sessions.resume()` that REST path already calls — `resume()` itself
 * short-circuits to a no-op if the session is somehow already live, so both are safe to invoke
 * unconditionally. Pure functions over an injected {isAlive, resume} seam (mirrors HeartbeatPty /
 * WakeService's pty seam) so they're testable with no real pty/db/claude.
 */
import type { CompanionConfig } from "./config.js";
import type { SubmitTurn } from "./types.js";

export interface ReviveDeps {
  isAlive(sessionId: string): boolean;
  /** Throws if the session cannot be resumed (deleted project, missing worktree, superseded row, ...). */
  resume(sessionId: string): void;
}

export interface ReviveLog {
  info(msg: string): void;
  warn(msg: string): void;
}

/**
 * BOOT entry point: revive `cfg`'s bound session if it isn't alive, BEFORE the controller wires the
 * gateway around it. Best-effort — a failed resume is logged and swallowed, never gates boot; the
 * companion just starts wired to a session that stays dead, exactly as before this fix (the submitTurn
 * self-heal below and the existing session-dead ack remain the backstops).
 */
export function reviveCompanionSessionAtBoot(cfg: CompanionConfig | null, deps: ReviveDeps, log: ReviveLog = console): void {
  if (!cfg || deps.isAlive(cfg.sessionId)) return;
  try {
    deps.resume(cfg.sessionId);
    log.info(`[boot] revived companion session ${cfg.sessionId.slice(0, 8)} (was dead)`);
  } catch (err) {
    log.warn(
      `[boot] could not revive companion session ${cfg.sessionId.slice(0, 8)} (${err instanceof Error ? err.message : String(err)}) — ` +
        'it will show "session isn\'t currently running" until manually restarted',
    );
  }
}

/**
 * INBOUND self-heal: wrap the raw `submit` (pty.enqueueStdin) so a session that died AFTER boot (crash,
 * manual stop, a usage-limit park that later cleared) gets ONE auto-resume-then-retry before the caller
 * sees a dead result — mirroring the identical "not live + ok -> auto-resume" idiom WakeService.tick /
 * PollService already use before a normal enqueue (orchestration/wake.ts, orchestration/poll.ts).
 * `submit` returns `{delivered:false}` with NO `position` in exactly one case: the session isn't alive
 * (host.ts's `enqueueStdin`) — the SAME dead-session signal chat-gateway.ts's handleInbound checks before
 * acking "session-dead". Fires strictly AFTER handleInbound's allowlist + sender-authz gates (this wrapper
 * only ever runs once both already passed), so it cannot loosen either gate. A failed resume is swallowed
 * and the ORIGINAL dead result is returned unchanged. The retry is NOT guaranteed to deliver synchronously:
 * a freshly-(re)spawned pty is alive-but-not-ready, so the retry can itself come back `{delivered:false,
 * position:N}` (held in the FIFO) — that queued result is surfaced to the caller UNCHANGED, exactly like
 * chat-gateway's own "queued" ack for a busy/not-ready session; only resume/retry itself is one-shot.
 */
export function withCompanionSelfHeal(submit: SubmitTurn, deps: Pick<ReviveDeps, "resume">): SubmitTurn {
  return (sessionId, text, route, ownerText) => {
    const result = submit(sessionId, text, route, ownerText);
    if (result.delivered || result.position !== undefined) return result;
    try {
      deps.resume(sessionId);
    } catch {
      return result; // unresumable — surface the ORIGINAL session-dead result
    }
    return submit(sessionId, text, route, ownerText);
  };
}
