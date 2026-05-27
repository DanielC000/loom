/**
 * Orchestration safety rails (phase-2 §17a): an in-memory pause-scope registry.
 *
 * A "scope" is either the string "global" or a manager session id. A manager's worker_spawn is
 * refused if the global scope is paused OR that manager's own scope is paused, so the human (or a
 * supervising process) can halt new work either fleet-wide ("global") or for one runaway manager.
 *
 * In-memory is intentional: this is a kill/pause switch, and a switch that resets to "not paused"
 * on daemon restart is the SAFE failure — a restart means nothing is spawning yet, so there is no
 * in-flight loop to keep bounded. (Persisting pause across restarts is a possible later refinement;
 * it is not needed for the rail to bound an unattended loop within a daemon's lifetime.)
 *
 * This gates NEW work only (worker_spawn). It does not touch worker_message/report/merge or stop
 * in-flight workers — pause = "stop taking on more"; killing in-flight workers is killAllWorkers.
 */
export class OrchestrationControl {
  private paused = new Set<string>();

  /** Pause a scope (default the global scope). Idempotent. */
  pause(scope = "global"): void {
    this.paused.add(scope);
  }

  /** Resume (un-pause) a scope (default the global scope). Idempotent. */
  resume(scope = "global"): void {
    this.paused.delete(scope);
  }

  /** A manager is paused if the global scope is paused or its own scope is paused. */
  isPaused(managerId: string): boolean {
    return this.paused.has("global") || this.paused.has(managerId);
  }

  /** The currently-paused scopes (for the /api/orchestration/status surface). */
  pausedScopes(): string[] {
    return [...this.paused];
  }
}
