/**
 * Daemon-global, in-memory concurrency limiter for HEAVY, daemon-EXECUTED gate runs — the
 * merge-confirm gate (`confirmWorkerMerge`) and the scoped-deploy gate (`deployOwnProject`), both of
 * which invoke `runGateSequential` with an arbitrary human-set build/test command. Bounds how many can
 * run AT ONCE across every project, so N concurrent `worker_merge_confirm`/`deploy` calls can't pile up
 * heavy build/test processes and starve a live sibling service on a self-hosting host (card 301d8c01) —
 * today that's enforced only by manager discipline (sequencing merges by hand), not code.
 *
 * A caller that can't acquire a slot QUEUES (awaits) rather than being rejected — merge correctness is
 * unaffected, it just may wait behind another in-flight gate. This composes cleanly with the existing
 * client-timeout resilience (card fb8df559): `PendingOpRegistry.attach` already wraps the WHOLE
 * `confirmWorkerMerge`/`deploy` call and degrades to a pending handle once it runs past its sync-wait
 * budget, so a gate that sits queued for a while is handled exactly like a gate that just runs long —
 * no separate handling needed here.
 *
 * Mirrors `CapQueueRegistry`'s simplicity: daemon-local, in-memory, no persistence. Resetting on a
 * daemon restart is fine — a queued waiter only ever exists inside a live, in-flight call; there is
 * nothing durable to lose.
 */
/** Queue priority for {@link GateSemaphore.runExclusive} (card 24642c3d): `"high"` for a merge/deploy
 *  gate, `"low"` for a worker's own `run_gate` DoD self-check. Governs QUEUE ORDER only — there is no
 *  preemption of an already-RUNNING gate (killing a healthy in-flight gate to make room would waste the
 *  work it's already done and risks leaking a process tree); a `"high"` caller only jumps ahead of
 *  ALREADY-QUEUED `"low"` waiters, same-tier order stays FIFO. This is what stops a low-priority worker's
 *  timing-out `run_gate` retries from head-of-line-blocking a higher-priority merge that arrives later —
 *  the exact starvation pattern this card was filed against. */
export type GatePriority = "high" | "low";

export class GateSemaphore {
  private active = 0;
  private readonly highWaiters: (() => void)[] = [];
  private readonly lowWaiters: (() => void)[] = [];

  /** Acquire a slot under `cap`, queueing (awaiting) if it's already saturated — onto the `"high"` or
   *  `"low"` tier per `priority`. */
  private acquire(cap: number, priority: GatePriority): Promise<void> {
    if (this.active < cap) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      const waiter = () => {
        this.active++;
        resolve();
      };
      (priority === "high" ? this.highWaiters : this.lowWaiters).push(waiter);
    });
  }

  /** Release a held slot, handing it directly to the next queued waiter (if any) rather than letting a
   *  fresh `acquire` race it — drains ALL of `highWaiters` before touching `lowWaiters`, FIFO within
   *  each tier. */
  private release(): void {
    this.active--;
    const next = this.highWaiters.shift() ?? this.lowWaiters.shift();
    if (next) next();
  }

  /** Run `fn` holding one of `cap` concurrent slots — awaits a slot first (queueing past `cap`, ordered
   *  by `priority`), then releases it once `fn` settles, whether it resolves or rejects. `cap` is read
   *  fresh on every call (mirrors the "RESOLVE-LIVE" config reads at each call site), so a human PATCH to
   *  `orchestration.maxConcurrentGates` takes effect on the very next gate run with no daemon restart.
   *  `priority` defaults to `"high"` so an untouched/future call site behaves exactly as before this
   *  card (every caller was implicitly equal-priority FIFO). */
  async runExclusive<T>(cap: number, fn: () => Promise<T>, priority: GatePriority = "high"): Promise<T> {
    await this.acquire(cap, priority);
    try {
      return await fn();
    } finally {
      this.release();
    }
  }
}
